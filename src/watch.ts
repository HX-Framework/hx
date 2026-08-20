// mtime-poll watcher.
//
// Strategy: poll the candidate directories at ~1.5s intervals, walk the cache
// of per-file mtimes, and trigger an upload when (mtime, size) move. fs.watch +
// chokidar were considered and rejected — too many directories, FD pressure
// under `~/.claude/projects/<encoded-path>/...`.
//
// Per-file upload pipeline:
//   1. read bytes from `state.offset → EOF`
//   2. request signed PUT URL
//   3. PUT bytes
//   4. POST commit (gateway composes into canonical)
//   5. bump state.offset

import { existsSync } from "node:fs";
import { stat, open } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  type DiscoveredChildFile,
  type DiscoveredFile,
  type DiscoveredWorkflowRun,
  STAT_CONCURRENCY,
  discoverClaudeChildren,
  discoverClaudeFiles,
  discoverCodexFiles,
  mapPool,
  readHead,
} from "./sources.js";
import {
  type DataRoot,
  type ResolvedRoots,
  claudeTasksDir,
  claudeTeamsDir,
  invalidateRootsMemo,
  isUnderRoots,
  resolveDataRoots,
  rootsSignature,
} from "./roots.js";
import {
  type FileSkipReason,
  type FileState,
  type HxState,
  type SyncBlockerDetails,
  type StateScope,
  benchFileProbe,
  pruneStrandedOffsets,
  clearFileFailure,
  clearHeal,
  destKey,
  getArtifactHash,
  getFileState,
  isDeletedSession,
  loadState,
  recordDeletedSession,
  recordFileFailure,
  minOffset,
  offsetFor,
  recordHeal,
  reconcileDestinations,
  recordDestinations,
  persistState,
  setArtifactHash,
  setOffsetFor,
  stampEffectiveRoots,
  touchMtime,
  upsertFileState,
  getChunkCap,
  setChunkCap,
  clearDestinationUploadError,
  recordDestinationUploadError,
  clearGenericBackoffs,
  armCoalescedPersistence,
  disarmCoalescedPersistence,
  flushStateIfDirty,
  hasDirtyState,
} from "./state.js";
import { catalogFor } from "./catalog.js";
import { ByteSemaphore, runPool } from "./upload-scheduler.js";
import { planFanout } from "./fanout.js";
import { appendActivity, trimActivity } from "./activity.js";
import { runReattributeSweep } from "./reattribute.js";
import { readOrgNames, rememberOrgNames } from "./org-names.js";
import { buildLedger, reportableOffset, type SyncLedger } from "./ledger.js";
import { rotateLogsIfLarge } from "./daemon.js";
import { backfillDue, discoverBackfill, markBackfillRun } from "./backfill.js";
import { collapseHome, isPaused, readSettings, shouldSkipFile, tuningValue, type HxSettings } from "./settings.js";
import { type HxConfig } from "./config.js";
import { resolveRoute, type Route } from "./route.js";
import {
  commitAgentChunk,
  commitChunk,
  HxHttpError,
  putChunk,
  requestAgentAppendUrl,
  requestAppendUrl,
  sendHeartbeat,
  sendSyncStatus,
  type SyncSnapshot,
  uploadGroupMirror,
  uploadPlan,
  uploadTasks,
  uploadTeamMirror,
  uploadWorkflowRun,
  vaultBlockerFromDestinations,
  verifySessions,
} from "./uploader.js";
import { summariseChunk } from "./parse.js";
import { getCcdRecentsByCliId } from "./ccd.js";
import { buildGroupMirror } from "./ccd-prefs.js";
import {
  findPlanPathInText,
  hashContent,
  listTaskSessionIds,
  readAgentMeta,
  readPlanFile,
  readPlanForJsonl,
  readTaskSet,
  readTeamConfigs,
  readTextFile,
} from "./artifacts.js";

const FAST_POLL_MS = 1_500;
// When the gateway stops accepting uploads (vault offline, 5xx, rate limit),
// retrying the whole backlog every FAST_POLL_MS is what floods the API and
// makes it unresponsive. Instead we pause uploads and back off exponentially
// from this base up to this cap, resetting to the normal cadence on the first
// pass that makes progress. Heartbeats keep their own timer, so liveness holds.
const UPLOAD_BACKOFF_BASE_MS = 5_000;
const UPLOAD_BACKOFF_MAX_MS = 5 * 60_000;
// Per-FILE retry pacing (state.ts recordFileFailure doubles these per failure,
// capped at 30 min): an ordinary per-request fault backs off from 30 s.
const FILE_RETRY_BASE_MS = 30_000;
// A session whose OWN store is temporarily unavailable (its vault is offline, or
// a store it routes to directly is down) is skipped — the rest keep uploading.
// Start short so a brief blip (a redeploy, a flaky link) is retried within
// seconds; consecutive failures then double the wait toward the 30-min cap, so a
// genuine outage stops burning round trips. This is the "a few quick retries,
// then back off" the skip path wants, using the existing exponential.
const SESSION_SKIP_RETRY_BASE_MS = 20_000;
// How many bytes ONE file may drain per DESTINATION within a single pass —
// numerically today's historical cap (16 rounds × 4 MB). A byte budget rather
// than a round count so adaptive chunk growth changes the round COUNT, never
// the pass pacing or the starvation guarantee; whatever is left continues
// next pass. There is deliberately no global per-pass total: a 200-file
// backlog still moves up to 200 × this per pass.
const PASS_BYTE_BUDGET = 64 * 1024 * 1024;
// Upload parallelism (LETAIR-144 WS3): files in flight concurrently, each
// file's rounds strictly sequential (offset dependency) and its destinations
// sequential within a round (partial-failure abort semantics preserved).
// Overridable via settings `tuning.uploadConcurrency` / `tuning.childConcurrency`
// (re-read per tick; 1 restores the historical strictly-sequential pass).
const FILE_CONCURRENCY_DEFAULT = 4;
const CHILD_CONCURRENCY_DEFAULT = 4;
// Adaptive chunk growth (DARK by default — enable via tuning.chunkGrowth after
// the live prod probe): cloud-lane (vaultOrgId === null, non-fortress) chunks
// double per clean round from DEFAULT_CHUNK_LIMIT up to this, clamped by the
// destination's learned cap (state.chunkCaps). Fortress-direct stays pinned at
// DEFAULT_CHUNK_LIMIT. RSS note for the enable decision: the M8 semaphore
// counts chunk BUFFERS, but the first committed chunk of a drain is also
// decoded once to a string for the sidecar sync (artifactText) — at this cap
// that's up to ~2× chunk size of additional transient RSS per draining file,
// outside the 64 MB budget.
const MAX_GROWN_CHUNK = 32 * 1024 * 1024;
// Process-global in-flight chunk-buffer budget, shared across tee lanes (M8).
const uploadBytesSemaphore = new ByteSemaphore(64 * 1024 * 1024);
// Backstop only: the drain loop's real bounds are the byte budget + the
// roundProgress/remaining breaks (≈16 rounds × destinations at the default
// chunk). A pathological store that trims every round to a byte could
// otherwise spin; this cap turns that into "finish next pass".
const DRAIN_ROUNDS_BACKSTOP = 1024;
// How often the daemon announces liveness when idle. Uploads already refresh
// lastSeenAt, so a beat only fires when nothing has contacted the gateway for
// this long — keeping idle traffic to ~1 tiny request/minute. The gateway's
// "live" window is a small multiple of this so a couple of missed beats (sleep,
// flaky link) don't immediately read as offline.
const HEARTBEAT_MS = 60_000;
// How often to re-read CCD's sidebar grouping off disk and upload it if it
// changed. Hash-gated, so an unchanged mirror costs only the local leveldb read.
const MIRROR_SYNC_MS = 20_000;
// Floor between catch-up progress reports. During a long first pass we report
// the bar climbing, but never faster than this — the snapshot is a tiny POST,
// yet there's no point flooding the gateway with sub-second updates. A terminal
// "caught up" snapshot bypasses the floor so the bar always resolves to done.
const SYNC_REPORT_MIN_MS = 1_500;
// Canonical divergence audit cadence: ask the gateway to compare each session's
// canonical size in the store against this device's uploaded offset, and
// re-upload-from-zero whatever drifted (a wiped store, a lost canonical). Runs
// at daemon start and on this timer so a store wipe behind a redeploy heals
// without restarting the daemon.
const VERIFY_INTERVAL_MS = 30 * 60_000;
const VERIFY_BATCH = 1_000;

/** How often the same file may repeat a "not progressing" explanation. The
 *  tick runs every ~1.5s; without this, one stuck file would emit ~57,000 lines
 *  a day. Keyed by path+reason so a CHANGE of reason is always reported at
 *  once — the transition is the interesting part. */
const STUCK_LOG_INTERVAL_MS = 30 * 60_000;
const stuckLogged = new Map<string, { reason: string; atMs: number }>();

/**
 * Say why a file that owes bytes is not being sent — once per reason per file
 * per interval.
 *
 * The tick has several `continue`s and one `return false` that decline to
 * upload without emitting anything. That is how a device sat at "17 sessions ·
 * 135.5 MB" byte-identical for days with an empty log: the sessions were never
 * attempted, so there was no error to print, and success prints nothing either.
 * Absence of output read as "nothing happening" when it meant "nothing will
 * ever happen".
 */
/** A wait a reader can act on. `Math.round(ms / 60_000)` rendered every delay
 *  under 30 seconds as "0 min" — which reads as a stopped clock rather than a
 *  short one. On one device 749 of 760 stuck lines said "another 0 min". */
function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)} min`;
}

function logStuck(
  path: string,
  /** STABLE identity of the condition — never the countdown, the byte counts or
   *  anything else that moves while the condition holds. Suppression compares
   *  this, so a key that changes each tick suppresses nothing: with the wait
   *  interpolated in, a file benched for 30s emitted a line on every 1.5s pass
   *  (~57,600/day — precisely the number STUCK_LOG_INTERVAL_MS exists to
   *  prevent) while appearing to be rate limited. A CHANGE of key is still
   *  reported at once, which is the point: the transition is the interesting
   *  part. */
  key: string,
  message: string,
  log: (m: string) => void,
): void {
  const prev = stuckLogged.get(path);
  const now = Date.now();
  if (prev && prev.reason === key && now - prev.atMs < STUCK_LOG_INTERVAL_MS) return;
  stuckLogged.set(path, { reason: key, atMs: now });
  log(`  [stuck] ${path}: ${message}`);
}

/**
 * A session's OWN destination store is temporarily unavailable — its vault is
 * offline, or a store it routes to directly is down. Distinct from the shared
 * cloud gateway being down: the watcher skips just this file (short retries,
 * then a longer backoff) and keeps uploading every other session, instead of
 * pausing the whole pass. Thrown by `ingestOne`, handled in `tickOnce`.
 */
export class SessionUpstreamUnavailable extends Error {
  constructor(
    readonly reason: FileSkipReason,
    /** HTTP status when the store answered; null for an outright network failure. */
    readonly status: number | null,
    cause: unknown,
    readonly blocker?: SyncBlockerDetails,
  ) {
    super(`session store unavailable (${reason})`, { cause });
    this.name = "SessionUpstreamUnavailable";
  }
}

/**
 * Decide whether `err` means THIS session's destination store is temporarily
 * unavailable — a transient outage to skip past, not a shared-gateway failure
 * and not this file's own fault. Returns a wrapped error to throw, or null to
 * let the caller handle `err` unchanged.
 *
 * `fortress` = the session uploads straight to its org's own store. A 5xx or an
 * outright network failure there is that one store being down. On the shared
 * cloud gateway the same 5xx could be a wholesale outage affecting every
 * session, so there only an explicit `vault_offline` (the gateway naming the
 * session's vault) is treated as per-session; a bare 5xx falls through to the
 * pass-level pause. A 4xx is never "unavailable" — it's a genuine per-file fault.
 */
export function classifyUpstreamError(
  err: unknown,
  fortress: boolean,
): SessionUpstreamUnavailable | null {
  if (err instanceof HxHttpError) {
    const blockReason = err.vaultBlockReason;
    if (blockReason !== null) {
      return new SessionUpstreamUnavailable(blockReason, err.status, err, err.blocker);
    }
    // Before the generic 4xx rule: a quarantine is a routing decision the
    // gateway has not made, identical in kind to an offline vault and equally
    // unrelated to this file. Treated as a fault it retries forever in silence.
    if (err.routingQuarantined) {
      return new SessionUpstreamUnavailable("quarantine", err.status, err);
    }
    if (fortress && err.serverUnavailable) {
      return new SessionUpstreamUnavailable("store_unreachable", err.status, err);
    }
    return null;
  }
  // A non-HTTP throw (DNS failure, connection refused/reset, timeout) against a
  // direct store route is that store being unreachable. On the cloud gateway the
  // same symptom could be local connectivity affecting every session, so it is
  // left to the generic per-file backoff rather than singled out here.
  if (fortress && err instanceof Error) {
    return new SessionUpstreamUnavailable("store_unreachable", null, err);
  }
  return null;
}

/**
 * What a failed CHILD-LANE upload means.
 *
 * Pure, and exported, so the order of these checks is directly testable. A 409
 * quarantine that reaches the generic backoff instead of a hold is invisible in
 * production — `recordFileFailure` without a skipReason means `collectSkipped`
 * cannot see it, `hx status` says nothing, `hx retry --blocked` cannot release
 * it, and `clearGenericBackoffs` wipes the streak on every restart. One device
 * paid 798,704 silent retries for exactly that ordering, on child lanes, which
 * are the ONLY population a quarantine can affect: a lane is quarantined
 * precisely when its parent row is missing.
 *
 * `latchChildLanePause` is deliberately NOT folded in — it mutates lane state.
 * The caller consults it between "hold" and "stop", exactly where it sat.
 */
export type ChildFailureAction =
  | { kind: "session-deleted" }
  | { kind: "hold"; reason: FileSkipReason; blocker?: SyncBlockerDetails }
  | { kind: "stop" }
  | { kind: "backoff" };

export function classifyChildFailure(err: unknown): ChildFailureAction {
  if (err instanceof HxHttpError) {
    if (err.sessionDeleted) return { kind: "session-deleted" };
    // Child lanes route through the cloud gateway, never fortress-direct.
    if (err.vaultOffline) {
      return {
        kind: "hold",
        reason: err.vaultBlockReason ?? "vault_offline",
        blocker: err.blocker,
      };
    }
    if (err.routingQuarantined) return { kind: "hold", reason: "quarantine" };
    if (err.serverUnavailable) return { kind: "stop" };
  }
  return { kind: "backoff" };
}

/** Human-readable form of a skip reason for the daemon log. */
function describeSkip(reason: FileSkipReason): string {
  if (reason === "vault_offline") return "session vault temporarily unavailable";
  if (reason === "vault_home_unreachable") return "session's home fortress not connected";
  if (reason === "quarantine") return "gateway has no routing decision for this session";
  return "session store unreachable";
}

export interface WatchOptions {
  /** Limit to a single file (debugging). */
  only?: string;
  /** Maximum bytes per chunk. Splits a huge backlog into multiple commits.
   *  An ABSOLUTE override: adaptive growth never exceeds it. */
  chunkLimitBytes?: number;
  /** Run once and exit (smoke test). */
  oneShot?: boolean;
  /** Adaptive chunk growth (tuning.chunkGrowth) — dark by default; resolved
   *  per tick in tickOnce and threaded here so ingestOne needs no settings
   *  read of its own. */
  chunkGrowth?: boolean;
}

const DEFAULT_CHUNK_LIMIT = 4 * 1024 * 1024;

// Which state file this config's offsets live in (see StateScope in state.ts).
// The `--local` tee runs the same pipeline against the local dev gateway with
// its own offsets, so the per-gateway latches below are also keyed by scope.
const scopeOf = (cfg: HxConfig): StateScope => cfg.stateScope ?? "main";

/** Integer tuning knob with a sane clamp (1..16); anything absent or
 *  mistyped reads as the default — settings must never brick the daemon. */
function tuningInt(settings: HxSettings, key: string, fallback: number): number {
  const v = tuningValue(settings, key);
  return typeof v === "number" && Number.isFinite(v) && v >= 1
    ? Math.min(16, Math.floor(v))
    : fallback;
}

// Per-repo route cache, keyed by config scope so the `--local` tee and the main
// lane never share a Fortress token. Lives for the daemon's lifetime; resolveRoute
// refreshes a route before its capability token nears expiry.
const ROUTE_CACHE = new Map<StateScope, Map<string, Route>>();

/** Resolve where this session's repo uploads to, then return the HxConfig the
 *  upload steps should use: the cloud config unchanged, or — for a fortress-direct
 *  route — one pointed at the Fortress gateway with its capability token as the
 *  bearer. Discovery failures fall back to cloud inside resolveRoute (off the hot
 *  path); see route.ts. */
function routeCacheFor(scope: StateScope): Map<string, Route> {
  let cache = ROUTE_CACHE.get(scope);
  if (!cache) {
    cache = new Map<string, Route>();
    ROUTE_CACHE.set(scope, cache);
  }
  return cache;
}

// Single-flight per (scope, repo): under the upload pool, N workers hitting
// the same cold repo must share ONE route-discovery fetch — identical result,
// no stampede. resolveRoute never rejects (it falls back internally), so a
// shared promise is safe to hand to every waiter.
const routeInFlight = new Map<string, Promise<Route>>();
function resolveRouteShared(
  scope: StateScope,
  params: Parameters<typeof resolveRoute>[0],
): Promise<Route> {
  const key = `${scope}:${params.repo}`;
  const inflight = routeInFlight.get(key);
  if (inflight) return inflight;
  const p = resolveRoute(params).finally(() => routeInFlight.delete(key));
  routeInFlight.set(key, p);
  return p;
}

async function uploadConfigFor(
  cfg: HxConfig,
  repoSlug: string | null | undefined,
): Promise<{ cfg: HxConfig; fortress: boolean; attributedOrgIds?: string[] }> {
  if (!repoSlug || !cfg.accessToken) return { cfg, fortress: false };
  const route = await resolveRouteShared(scopeOf(cfg), {
    repo: repoSlug,
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    accessToken: cfg.accessToken,
    cache: routeCacheFor(scopeOf(cfg)),
  });
  const attributedOrgIds = route.attributedOrgIds;
  if (route.mode !== "fortress-direct") return { cfg, fortress: false, attributedOrgIds };
  return {
    cfg: { ...cfg, gatewayBaseUrl: route.gatewayUrl, accessToken: route.token },
    fortress: true,
    attributedOrgIds,
  };
}

// When child-lane uploads are rejected wholesale, pause them for a while
// instead of re-POSTing one doomed request per 1.5s tick. Two known causes:
// 404 — the gateway predates the child-lane endpoints; 401/403 — an auth
// shield in front of the environment (packages/basic-auth-shield) answers
// before route auth, and its bypass list doesn't cover the child/agent
// endpoints, so every child POST bounces while parent uploads keep passing
// (which keeps the pass-level error backoff from ever engaging). Parent
// uploads are deliberately not latched here: a parent-lane 401 means a
// revoked device token and has its own semantics. Keyed per upload lane —
// one gateway rejecting child uploads says nothing about the other.
const CHILD_ENDPOINT_RETRY_MS = 10 * 60_000;
const childEndpointsMissingUntilMs = new Map<StateScope, number>();

/**
 * Latch the child-lane pause when `err` says the lane is rejected wholesale
 * (404 missing endpoints, 401/403 front-door auth shield — see above).
 * Returns true when latched so callers bail out of the rest of the pass.
 */
function latchChildLanePause(
  err: unknown,
  scope: StateScope,
  log: (msg: string) => void,
): boolean {
  if (!(err instanceof HxHttpError)) return false;
  if (err.status !== 404 && err.status !== 401 && err.status !== 403) return false;
  childEndpointsMissingUntilMs.set(scope, Date.now() + CHILD_ENDPOINT_RETRY_MS);
  log(
    err.status === 404
      ? "[hx] gateway has no child-lane endpoints yet; pausing child uploads"
      : `[hx] child-lane uploads rejected (${err.status}); pausing`,
  );
  return true;
}

// Self-heal support is feature-detected once per process PER LANE (absent =
// unknown): the first verify call against a gateway that predates
// sessions/verify 404s, which disables BOTH the audit and the per-commit
// divergence reset for that lane — an old gateway also ignores commit's
// replace flag, so a reset there would re-APPEND the full file onto the bad
// canonical and re-detect the mismatch forever.
const SELF_HEAL = new Map<StateScope, boolean>();

async function readSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Trim a buffer at the last newline so we never split a jsonl line across
 * two chunks. Returns the trimmed buffer + the actual end offset.
 */
function trimAtLastNewline(buf: Buffer, startOffset: number): { trimmed: Buffer; endOffset: number } {
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { trimmed: buf, endOffset: startOffset + buf.length };
  return { trimmed: buf.subarray(0, lastNl + 1), endOffset: startOffset + lastNl + 1 };
}

async function ensureFileState(file: DiscoveredFile, scope: StateScope): Promise<FileState> {
  const existing = await getFileState(file.path, scope);
  if (existing) {
    // Legacy entries predate the cwd/repoSlug columns the settings filters
    // match on — re-seed them once from the head so exclusions apply.
    if (existing.cwd === undefined) {
      const head = await readHead(file.path, file.source);
      existing.cwd = head.cwd ? collapseHome(head.cwd) : path.dirname(file.path);
      existing.repoSlug = head.repoSlug;
      await upsertFileState(existing, scope);
    }
    if (existing.lastMtimeMs !== file.mtimeMs || existing.lastKnownSize !== file.size) {
      existing.lastMtimeMs = file.mtimeMs;
      existing.lastKnownSize = file.size;
      await upsertFileState(existing, scope);
    }
    return existing;
  }
  const head = await readHead(file.path, file.source);
  const seeded: FileState = {
    path: file.path,
    family: head.family,
    sessionId: head.sessionId ?? path.basename(file.path, ".jsonl"),
    cwd: head.cwd ? collapseHome(head.cwd) : path.dirname(file.path),
    repoSlug: head.repoSlug,
    offsets: {},
    lastKnownSize: file.size,
    lastMtimeMs: file.mtimeMs,
    lastUploadAtMs: 0,
  };
  await upsertFileState(seeded, scope);
  return seeded;
}

/**
 * Drop files the device's settings keep local (excluded folders, path rules,
 * personal gate) and sessions the server has permanently deleted (tombstoned):
 * those never upload again by design, so they must not count against the sync
 * surface either — a deleted session otherwise reads "1 session pending" in
 * `hx status` forever. Matching happens on the persisted state identity; a
 * file with no state entry yet passes — its first ingest seeds the entry, the
 * pre-upload check in tickOnce keeps its bytes on the machine, and the tick's
 * own tombstone check stops a deleted session locally before any request;
 * only a device that LOST the tombstone pays one 410 round trip to re-learn
 * it, after which the file drops out of this surface on the next pass.
 */
export function filterWatched(
  files: DiscoveredFile[],
  state: HxState,
  settings: HxSettings,
): DiscoveredFile[] {
  return files.filter((f) => {
    const fs = state.files[f.path];
    if (!fs) return true;
    if (isDeletedSession(state, fs.family, fs.sessionId)) return false;
    return !shouldSkipFile(settings, fs);
  });
}

const FALLBACK_TITLE_MAX = 80;

/** First line of `text`, whitespace-collapsed and word-boundary truncated with
 *  an ellipsis. Null when there is nothing legible. */
function firstLineLabel(text: string | null): string | null {
  if (!text) return null;
  const oneLine = (text.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
  if (!oneLine) return null;
  if (oneLine.length <= FALLBACK_TITLE_MAX) return oneLine;
  const clipped = oneLine.slice(0, FALLBACK_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace >= FALLBACK_TITLE_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[\s.,;:!?—-]+$/, "")}…`;
}

/** A readable label for a session that carries no user/AI title of its own: the
 *  opening user message, else the repo or working-directory name. Returns null
 *  when even those are unavailable, so the caller leaves the title unset. */
function deriveFallbackTitle(
  firstUserText: string | null,
  cwd: string | null,
  repoSlug: string | null,
): string | null {
  const fromMessage = firstLineLabel(firstUserText);
  if (fromMessage) return fromMessage;
  const repo = repoSlug?.split("/").pop()?.trim();
  if (repo) return repo;
  const base = cwd
    ?.split(/[/\\]+/)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop()
    ?.trim();
  return base && base.length > 0 ? base : null;
}

/** Compact label for a hard upload failure: the status plus the storage
 *  provider's error code when the body carries one (GCS/S3 XML `<Code>`), e.g.
 *  "403 SignatureDoesNotMatch". The code is what distinguishes a stale signing
 *  key from a permission problem, so it is worth surfacing verbatim. */
export function uploadErrorCode(err: HxHttpError): string {
  const m = /<Code>([A-Za-z0-9_]+)<\/Code>/.exec(err.message);
  return m ? `${err.status} ${m[1]}` : String(err.status);
}

// Adaptive-chunk growth ladder, in-memory per (scope, destination): the next
// cloud-lane chunk size, doubled after each clean full-size commit up to
// MAX_GROWN_CHUNK and the destination's learned cap. DARK unless
// tuning.chunkGrowth is true; fortress-direct and vault destinations stay at
// the base size unconditionally.
const grownChunk = new Map<string, number>();
const chunkCapLogged = new Set<string>();

/** Test seam — forget the in-memory growth ladder and cap-log dedupe. */
export function resetChunkGrowthForTests(): void {
  grownChunk.clear();
  chunkCapLogged.clear();
}

async function chunkSizeFor(
  vaultOrgId: string | null,
  fortress: boolean,
  opts: WatchOptions,
  scope: StateScope,
): Promise<number> {
  const base = opts.chunkLimitBytes ?? DEFAULT_CHUNK_LIMIT;
  if (opts.chunkGrowth !== true || fortress || vaultOrgId !== null) return base;
  const dk = destKey(vaultOrgId);
  const learned = await getChunkCap(dk, scope);
  const grown = grownChunk.get(`${scope}:${dk}`) ?? DEFAULT_CHUNK_LIMIT;
  // An explicitly-passed chunkLimitBytes is an ABSOLUTE override — growth
  // never exceeds it, even when it equals the default.
  const hardCap = opts.chunkLimitBytes !== undefined ? opts.chunkLimitBytes : Infinity;
  return Math.min(grown, learned ?? Infinity, MAX_GROWN_CHUNK, hardCap);
}

/** Exported for the drain tests (budget pacing, growth ladder, probe
 *  cleanliness) — production callers stay inside this module. */
export async function ingestOne(
  cfg: HxConfig,
  file: DiscoveredFile,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<boolean> {
  let st;
  try {
    st = await stat(file.path);
  } catch {
    return false;
  }
  const scope = scopeOf(cfg);
  const fState = await ensureFileState({ ...file, mtimeMs: st.mtimeMs, size: st.size }, scope);
  // Skip only when the file hasn't grown past the LEAST-current destination —
  // a store still behind the others must keep getting bytes.
  const baseOffset = minOffset(fState);
  // A held session must re-resolve its destination even when every previously
  // known offset is caught up: the missing/held store may not have had an
  // offset key on an older gateway response, and remediation may have moved
  // the repo to a different destination.
  if (st.size <= baseOffset && !fState.skipReason) {
    if (fState.lastMtimeMs !== st.mtimeMs) {
      await touchMtime(file.path, st.mtimeMs, scope);
    }
    return false;
  }

  // Read the jsonl head up front: the gateway needs repoSlug at append-url time
  // to route this session to the right store (per-session vault attribution),
  // and the commit metadata below reuses the same head.
  const head = await readHead(file.path, file.source);

  // FIRST-SIGHT cache (ensureFileState) wins over the live walk; the walk only
  // fills a cache that has nothing. A session's repo never legitimately changes
  // after first sight (the transcript's cwd is fixed) — but a scratch path
  // REUSED by a later job can make a re-walk resolve to the WRONG repo, so an
  // established cache value must not be overwritten. Upgrades (null →
  // detected) persist so a later restart keeps the best-known value.
  const repoSlug = fState.repoSlug ?? head.repoSlug ?? null;
  if (fState.repoSlug == null && head.repoSlug != null) {
    fState.repoSlug = head.repoSlug;
    await upsertFileState(fState, scope);
  }

  // Discover where this repo's sessions upload. A fortress-direct route swaps the
  // base URL + bearer to the org's own Fortress gateway; everything else stays on
  // the cloud. Non-goal: NO cloud fallback — if the fortress upload below
  // throws, the chunk stays queued (offset unadvanced) and retries against the
  // Fortress next pass; it is never re-sent to the cloud.
  const route = await uploadConfigFor(cfg, repoSlug);
  const uploadCfg = route.cfg;
  // Persist gateway-confirmed workspace attribution — the personal gate's
  // exact signal (see settings.ts). Only when the gateway echoes it.
  if (Array.isArray(route.attributedOrgIds)) {
    const attributed = route.attributedOrgIds.length > 0;
    if (fState.attributed !== attributed) {
      fState.attributed = attributed;
      await upsertFileState(fState, scope);
    }
  }

  // CCD session metadata (title + group id) is byte-independent — resolve once.
  const ccdByCli = await getCcdRecentsByCliId(Date.now()).catch(() => null);
  const ccdMeta = ccdByCli?.get(fState.sessionId) ?? null;

  let anyProgress = false;
  let lastUnavailable: HxHttpError | null = null;
  let heldBlocker: SyncBlockerDetails | undefined;
  let artifactText: string | null = null;
  // A destination that answered "unavailable" this pass is skipped for the
  // rest of the pass — its offset stays put and the next pass retries it.
  const unavailableDests = new Set<string>();

  // Drain rounds: a backlogged file uploads chunk after chunk within ONE pass
  // (fresh signed URLs each round) instead of one chunk per 1.5 s poll — the
  // old pacing capped any session at ~2.7 MB/s regardless of bandwidth. The
  // per-(file, destination) BYTE budget keeps one huge file from starving the
  // rest of the backlog (historically 16 rounds × 4 MB — the same 64 MB);
  // whatever is left continues next pass.
  //
  // Wrap the whole drain: any error that means THIS session's store is
  // unavailable (a direct-route store's 5xx/network failure, or the gateway's
  // vault_offline) is re-thrown as SessionUpstreamUnavailable so tickOnce skips
  // just this file and keeps the pass going. Everything else propagates as-is.
  const sentByDest = new Map<string, number>();
  // Parse dedupe (fixes C5): fan-out steps at the SAME offset re-read the
  // same byte range — the JSON.parse of every line must run once, not once
  // per destination. Keyed (stepOffset, want): same range ⇒ same trim ⇒ same
  // bytes, even if the file grew meanwhile (endOffset was fixed by the trim).
  // SUMMARIES ONLY — caching the chunk text would retain up to the whole
  // 64 MB drain budget as strings per file, outside the byte semaphore's
  // accounting (× pool width in catch-up: several times the M8 RSS bound).
  const sliceSummaries = new Map<string, { endOffset: number; summary: ReturnType<typeof summariseChunk> }>();
  try {
  for (let round = 0; round < DRAIN_ROUNDS_BACKSTOP; round++) {
    // Get signed staging URLs for EVERY store this repo fans out to. repoSlug lets
    // the gateway attribute + resolve the destination set; each is echoed back as
    // its own vaultOrgId so commit replays it into the same store. A gateway that
    // predates fan-out returns a single destination (legacy fields) and planFanout
    // degrades to one step.
    const append = await requestAppendUrl(uploadCfg, {
      family: fState.family as never,
      sessionId: fState.sessionId,
      byteCount: st.size - minOffset(fState),
      repoSlug,
    });

    heldBlocker = vaultBlockerFromDestinations(append.destinations);

    // The destinations array is the gateway's current truth for this session's
    // fan-out set (ready AND held). Drop offsets for destinations that left the
    // set entirely — a stale key pins minOffset (and the sync bar) forever.
    // Legacy single-destination responses are left alone: an old gateway can't
    // enumerate the set, so pruning against it could drop a live vault's offset.
    if (append.destinations) {
      await reconcileDestinations(
        file.path,
        append.destinations.map((d) => destKey(d.vaultOrgId)),
        scope,
      );
      // Remember WHO each destination is and whether it is reachable, durably.
      // The per-file skipReason/blocker are cleared by any clean pass, so they
      // cannot answer "which Fortress is this session waiting on?" a moment
      // later; the registry can, and `hx status` reads it instead of the latch.
      await recordDestinations(
        append.destinations.map((d) => ({
          vaultOrgId: d.vaultOrgId ?? null,
          status: d.status === "held" ? ("held" as const) : ("ready" as const),
          orgName: "orgName" in d ? d.orgName : null,
          orgSlug: "orgSlug" in d ? d.orgSlug : null,
          lastSeenAt: "lastSeenAt" in d ? d.lastSeenAt : null,
        })),
        scope,
      );
    }

    const steps = planFanout(append, fState).filter(
      (step) =>
        !unavailableDests.has(destKey(step.vaultOrgId)) &&
        (sentByDest.get(destKey(step.vaultOrgId)) ?? 0) < PASS_BYTE_BUDGET,
    );

    let roundProgress = false;
    for (const step of steps) {
      // Each destination uploads from its OWN committed offset — a late-joining or
      // previously-offline vault back-fills from zero (replace) while the others
      // append, so one store's lag never blocks another.
      const stepOffset = offsetFor(fState, step.vaultOrgId);
      const chunkSize = await chunkSizeFor(step.vaultOrgId, route.fortress, opts, scope);
      // Clamp to the remaining per-destination budget so a pass never sends
      // MORE than the historical cap (16 rounds could never exceed 64 MB; an
      // unclamped `sent < budget` admission could overshoot by one chunk).
      const budgetLeft = PASS_BYTE_BUDGET - (sentByDest.get(destKey(step.vaultOrgId)) ?? 0);
      const want = Math.min(st.size - stepOffset, chunkSize, budgetLeft);
      if (want <= 0) continue;
      // Chunk buffers ride the process-global byte budget (M8): admission caps
      // concurrent RSS across pooled files and both tee lanes.
      const release = await uploadBytesSemaphore.acquire(want);
      let trimmed: Buffer;
      let endOffset: number;
      try {
        const slice = await readSlice(file.path, stepOffset, want);
        ({ trimmed, endOffset } = trimAtLastNewline(slice, stepOffset));
        if (trimmed.length === 0) continue;
        const cacheKey = `${stepOffset}:${want}`;
        let parsed = sliceSummaries.get(cacheKey);
        if (!parsed || parsed.endOffset !== endOffset) {
          parsed = { endOffset, summary: summariseChunk(trimmed.toString("utf8")) };
          sliceSummaries.set(cacheKey, parsed);
        }
        let summary = parsed.summary;
        // Title/meta derivation runs where `summary` is FINAL for this commit —
        // the growth probe below can shrink the chunk, replacing text+summary,
        // so the derivation lives in a helper called after the PUT settles.
        const deriveTitleMeta = (): { title: string | undefined; titleSource: "user" | "ai" | "fallback" | undefined } => {
          let title = ccdMeta?.title ?? summary.title ?? head.title ?? undefined;
          let titleSource: "user" | "ai" | "fallback" | undefined;
          if (ccdMeta?.title) titleSource = ccdMeta.titleSource ?? undefined;
          else if (summary.title) titleSource = summary.titleSource ?? undefined;
          else if (head.title) titleSource = "ai";
          // No user/AI title anywhere — synthesize a readable label so the session
          // shows something meaningful instead of a bare id downstream. Only on a
          // from-zero upload: a later appended chunk must not overwrite it with a
          // mid-conversation message. Stamped "fallback" so the provenance stays
          // honest.
          if (!title && stepOffset === 0) {
            const derived = deriveFallbackTitle(summary.firstUserText, head.cwd, head.repoSlug);
            if (derived) {
              title = derived;
              titleSource = "fallback";
            }
          }
          return { title, titleSource };
        };

        try {
          // Upload bytes directly to this destination's store, then compose.
          // Growth probe (dark unless tuning.chunkGrowth): a failure at a GROWN
          // size retries this same step in place at the LAST-GOOD rung (the
          // previous ladder step — proven by its own clean commit) — no throw,
          // no destination-error latch, no file backoff, no [error] line. A
          // size-shaped rejection (4xx: 413/EntityTooLarge and kin) persists
          // the rung as the destination's cap (state.chunkCaps — restarts never
          // re-probe); a 5xx/network blip learns nothing durable — the ladder
          // just steps back in memory and may regrow. Only a failure at the
          // base size takes the normal error path.
          const baseChunk = Math.min(opts.chunkLimitBytes ?? DEFAULT_CHUNK_LIMIT, DEFAULT_CHUNK_LIMIT);
          try {
            await putChunk(step.uploadUrl, trimmed);
          } catch (growErr) {
            if (!(opts.chunkGrowth === true) || chunkSize <= baseChunk) throw growErr;
            const dk = destKey(step.vaultOrgId);
            const lastGood = Math.max(baseChunk, Math.floor(chunkSize / 2));
            const shrunkWant = Math.min(st.size - stepOffset, lastGood);
            const shrunkSlice = await readSlice(file.path, stepOffset, shrunkWant);
            const shrunk = trimAtLastNewline(shrunkSlice, stepOffset);
            if (shrunk.trimmed.length === 0) throw growErr;
            await putChunk(step.uploadUrl, shrunk.trimmed);
            trimmed = shrunk.trimmed;
            endOffset = shrunk.endOffset;
            summary = summariseChunk(trimmed.toString("utf8"));
            sliceSummaries.set(`${stepOffset}:${shrunkWant}`, { endOffset, summary });
            grownChunk.set(`${scope}:${dk}`, lastGood);
            // Only a genuinely SIZE-shaped rejection earns a durable cap:
            // 413, or a 4xx whose body names a size limit. A presign that
            // expired while a 16-32 MB slice was being read (403
            // SignatureDoesNotMatch) must NOT permanently under-cap the
            // destination — it steps the in-memory ladder back like a 5xx
            // and may regrow.
            const sizeShaped =
              growErr instanceof HxHttpError &&
              (growErr.status === 413 ||
                (growErr.status >= 400 &&
                  growErr.status < 500 &&
                  /EntityTooLarge|MaxMessageLength|PayloadTooLarge|RequestEntityTooLarge|TooBig/i.test(
                    growErr.message,
                  )));
            if (sizeShaped) {
              await setChunkCap(dk, lastGood, scope);
              if (!chunkCapLogged.has(dk)) {
                chunkCapLogged.add(dk);
                log(`[hx] chunk size settled at ${Math.round(lastGood / (1024 * 1024))} MB for ${dk}`);
              }
            }
          }
          const { title, titleSource } = deriveTitleMeta();
          const commit = await commitChunk(uploadCfg, {
            family: fState.family as never,
            sessionId: fState.sessionId,
            chunkId: step.chunkId,
            // A from-zero upload REPLACES this store's canonical instead of appending:
            // at offset 0 anything it still holds can't be content this device hasn't
            // sent (stale/duplicated canonical, or a freshly-joined vault). Old
            // gateways ignore the flag and append, same result for a new session.
            replace: step.replace,
            vaultOrgId: step.vaultOrgId,
            meta: {
              sourcePath: file.path,
              title,
              titleSource,
              ccdSessionId: ccdMeta?.ccdSessionId ?? undefined,
              // cwd doubles as attribution EVIDENCE the gateway now persists
              // (org rules match on it); evidenceUpload:false withholds it for
              // devices whose org considers local paths sensitive.
              cwd: cfg.evidenceUpload === false ? undefined : head.cwd,
              gitBranch: head.gitBranch,
              repoSlug,
              entrypoint: head.entrypoint,
              originator: head.originator,
              modelProvider: head.modelProvider,
              lastUserText: summary.lastUserText,
              lastAssistantText: summary.lastAssistantText,
              eventCount: summary.eventCount,
              userTextCount: summary.userTextCount,
              assistantCount: summary.assistantCount,
              lastActivityAt: summary.lastActivityAt,
            },
          });
          // Per-commit divergence check (let.ai-hosted only — the audit + self-heal
          // protocol live there): a size mismatch means the store lost the canonical
          // mid-session; reset just this destination to zero so the next pass
          // re-uploads it with replace. Chunks never split a line, so a healthy
          // canonical matches endOffset byte-for-byte.
          const diverged =
            !route.fortress &&
            SELF_HEAL.get(scope) === true &&
            step.vaultOrgId === null &&
            commit.totalBytes !== endOffset;
          if (diverged && (fState.healPausedUntilMs ?? 0) > Date.now()) {
            // Heal is paused (a prior streak ping-ponged) — accept our own offset
            // so the file stops re-uploading; the periodic audit keeps reporting
            // the divergence and healing resumes when the pause lapses.
            await setOffsetFor(file.path, step.vaultOrgId, endOffset, st.mtimeMs, scope);
          } else if (diverged) {
            const streak = await recordHeal(file.path, scope);
            log(
              `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${commit.totalBytes}B ≠ uploaded ${endOffset}B — re-uploading from zero`,
            );
            if ((fState.healPausedUntilMs ?? 0) > Date.now()) {
              log(
                `  [heal] ${fState.sessionId.slice(0, 8)}… diverged ${streak}x in a row — pausing self-heal for this file`,
              );
            }
            await setOffsetFor(file.path, step.vaultOrgId, 0, st.mtimeMs, scope);
          } else {
            await setOffsetFor(file.path, step.vaultOrgId, endOffset, st.mtimeMs, scope);
            // Only a clean APPEND (stepOffset > 0) ends a heal streak. The
            // from-zero re-upload a heal triggers is ALSO clean by construction
            // (we resend the whole file, so totalBytes == endOffset) — clearing
            // on it would reset the counter every heal and the ping-pong latch
            // could never reach its threshold. A clean append means the store
            // accepted our tail without diverging: genuinely healthy.
            if (stepOffset > 0 && fState.healCount !== undefined) {
              await clearHeal(file.path, scope);
            }
          }
          // Sidecars (tasks/plan) are whole-file + hash-gated and route server-side
          // to the session's store, so one sync off any destination's new tail is
          // enough — capture the first (decoded from the local buffer; chunk text
          // is deliberately never cached).
          if (artifactText === null) artifactText = trimmed.toString("utf8");
          // A committed chunk ends this destination's failure run (no-op unless
          // one is latched — see recordDestinationUploadError in the catch).
          await clearDestinationUploadError(destKey(step.vaultOrgId), scope);
          anyProgress = true;
          roundProgress = true;
          {
            const dk = destKey(step.vaultOrgId);
            sentByDest.set(dk, (sentByDest.get(dk) ?? 0) + trimmed.length);
            // Growth ladder: a clean commit of a FULL-SIZE request (want ===
            // chunkSize, i.e. not the file tail) doubles the next cloud-lane
            // chunk, up to the max and any learned cap. The TRIMMED length is
            // deliberately not compared — real jsonl trims a partial line off
            // nearly every chunk, which must not stall the ladder. Dark unless
            // tuning.chunkGrowth.
            if (
              opts.chunkGrowth === true &&
              !route.fortress &&
              step.vaultOrgId === null &&
              want === chunkSize
            ) {
              const learned = await getChunkCap(dk, scope);
              const next = Math.min(chunkSize * 2, MAX_GROWN_CHUNK, learned ?? Infinity);
              if (next > (grownChunk.get(`${scope}:${dk}`) ?? DEFAULT_CHUNK_LIMIT)) {
                grownChunk.set(`${scope}:${dk}`, next);
              }
            }
          }
          log(
            `  ${path.relative(homedir(), file.path)} (+${trimmed.length}B → ${step.vaultOrgId ?? "let.ai"}, ${fState.family}, ${fState.sessionId.slice(0, 8)}…)`,
          );
          // Local journal for the UI's traffic chart — best-effort, never awaited
          // into the upload path's error handling.
          void appendActivity({
            at: Date.now(),
            sessionId: fState.sessionId,
            family: fState.family,
            bytes: trimmed.length,
            dest: destKey(step.vaultOrgId),
          });
        } catch (err) {
          // One destination's vault being unavailable must not stall the others — log
          // and move on; its offset stays put so the next pass retries just it.
          if (err instanceof HxHttpError && err.serverUnavailable) {
            lastUnavailable = err;
            unavailableDests.add(destKey(step.vaultOrgId));
            log(
              `  [hx] destination ${step.vaultOrgId ?? "let.ai"} unavailable (${err.status}); will retry`,
            );
            continue;
          }
          // A hard rejection (403/401/400) from a REACHABLE store. Latch it on
          // the destination registry before the error propagates into the
          // generic per-file backoff: without this, a store rejecting every
          // write is indistinguishable from a slow backlog — the shape that hid
          // a 12-hour credential outage behind a silent "0%".
          if (err instanceof HxHttpError) {
            await recordDestinationUploadError(
              destKey(step.vaultOrgId),
              uploadErrorCode(err),
              scope,
            ).catch(() => {});
          }
          throw err;
        }
      } finally {
        release();
      }
    }

    if (!roundProgress) break;
    // Caught up on every reachable destination — or out of this pass's byte
    // budget for all of them? Then this pass is done. A diverged/healing
    // destination (offset reset to 0) simply drains in the remaining rounds
    // like any other backlog; whatever the budget leaves continues next pass.
    const remaining = steps.some(
      (step) =>
        !unavailableDests.has(destKey(step.vaultOrgId)) &&
        offsetFor(fState, step.vaultOrgId) < st.size &&
        (sentByDest.get(destKey(step.vaultOrgId)) ?? 0) < PASS_BYTE_BUDGET,
    );
    if (!remaining) break;
  }
  } catch (err) {
    throw classifyUpstreamError(err, route.fortress) ?? err;
  }

  // Nothing landed: if every destination we tried was unavailable, surface it so
  // this file gets skipped (per-session) or the pass pauses (cloud-wide), per
  // classifyUpstreamError. Otherwise there were simply no new committable bytes.
  if (!anyProgress) {
    if (lastUnavailable) throw classifyUpstreamError(lastUnavailable, route.fortress) ?? lastUnavailable;
    return false;
  }

  // Best-effort sidecar sync — a failure must never fail the transcript.
  if (artifactText !== null) {
    await syncArtifacts(cfg, fState, artifactText, log, file.rootDir).catch((err) => {
      log(`  [artifacts] ${fState.sessionId.slice(0, 8)}…: ${(err as Error).message}`);
    });
  }
  // A mixed fan-out may have made progress to healthy stores while another
  // destination stayed held. Persist that hold after the healthy commits so
  // status remains below 100% and names the exact blocked destination.
  if (heldBlocker) {
    const err = new HxHttpError(
      503,
      `append-url reported a held ${heldBlocker.reason} destination`,
      heldBlocker,
    );
    throw new SessionUpstreamUnavailable(heldBlocker.reason, 503, err, heldBlocker);
  }
  return true;
}

/**
 * Upload fresh bytes for one child-lane transcript (a subagent's or a workflow
 * agent's jsonl). Same offset-tail + chunk pipeline as the parent, against the
 * dedicated agent endpoints; per-file state reuses the same FileState map
 * (keyed by path), with sessionId = the PARENT session id.
 */
export interface ChildParentIdentity {
  family: string;
  sessionId: string;
}

/**
 * Map Claude's on-disk artifact-directory id to the parent identity hx sends to
 * the gateway. Those ids are usually equal, but Claude Desktop can name the
 * flat file + artifact directory with one UUID while embedding a different
 * canonical sessionId inside the JSONL. Parent FileState already carries the
 * parsed canonical id, so basename -> FileState is the authoritative bridge.
 *
 * Conflicting basename mappings are omitted rather than guessed. Child state
 * entries are excluded so a stale child cannot become its own parent oracle.
 */
export function buildChildParentIndex(state: HxState): Map<string, ChildParentIdentity> {
  const index = new Map<string, ChildParentIdentity>();
  const ambiguous = new Set<string>();
  for (const file of Object.values(state.files)) {
    if (!file.path.endsWith(".jsonl")) continue;
    if (file.path.split(path.sep).includes("subagents")) continue;
    const artifactSessionId = path.basename(file.path, ".jsonl");
    if (artifactSessionId.startsWith("rollout-")) continue;
    if (ambiguous.has(artifactSessionId)) continue;
    const identity = { family: file.family, sessionId: file.sessionId };
    const existing = index.get(artifactSessionId);
    if (
      existing &&
      (existing.family !== identity.family || existing.sessionId !== identity.sessionId)
    ) {
      index.delete(artifactSessionId);
      ambiguous.add(artifactSessionId);
      continue;
    }
    index.set(artifactSessionId, identity);
  }
  return index;
}

/** Repair a persisted child identity after learning its canonical parent. A
 * session-id change means any old offsets refer to the wrong storage prefix, so
 * replay from zero. Either identity change clears failure backoff immediately —
 * a client update should not wait up to 30 minutes before applying the repair. */
export function reconcileChildParent(
  child: FileState,
  parent: ChildParentIdentity | undefined,
): FileState {
  if (!parent) return child;
  const sessionChanged = child.sessionId !== parent.sessionId;
  if (!sessionChanged && child.family === parent.family) return child;
  return {
    ...child,
    family: parent.family,
    sessionId: parent.sessionId,
    offsets: sessionChanged ? {} : child.offsets,
    lastUploadAtMs: sessionChanged ? 0 : child.lastUploadAtMs,
    consecutiveFailures: undefined,
    nextAttemptAtMs: undefined,
    skipReason: undefined,
    healCount: sessionChanged ? undefined : child.healCount,
    healPausedUntilMs: sessionChanged ? undefined : child.healPausedUntilMs,
  };
}

async function ingestChildOne(
  cfg: HxConfig,
  child: DiscoveredChildFile,
  parentByArtifactSession: Map<string, ChildParentIdentity>,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<boolean> {
  let st;
  try {
    st = await stat(child.path);
  } catch {
    return false;
  }
  const scope = scopeOf(cfg);
  const parent = parentByArtifactSession.get(child.parentSessionId);
  let fState = await getFileState(child.path, scope);
  if (!fState) {
    fState = {
      path: child.path,
      // The child belongs to the parent's session row, so it MUST upload under
      // the parent's canonical family + id or the gateway would mint a sibling.
      family: parent?.family ?? "claude-cli",
      sessionId: parent?.sessionId ?? child.parentSessionId,
      offsets: {},
      lastMtimeMs: st.mtimeMs,
      lastUploadAtMs: 0,
    };
    await upsertFileState(fState, scope);
  } else {
    const reconciled = reconcileChildParent(fState, parent);
    if (reconciled !== fState) {
      fState = reconciled;
      await upsertFileState(fState, scope);
    }
  }
  // A child lane is single-destination (its store is the parent session's,
  // resolved server-side and stable), so its one offset is the min over keys.
  const childOffset = minOffset(fState);
  if (st.size <= childOffset) {
    if (fState.lastMtimeMs !== st.mtimeMs) {
      await touchMtime(child.path, st.mtimeMs, scope);
    }
    return false;
  }

  const want = Math.min(st.size - childOffset, opts.chunkLimitBytes ?? DEFAULT_CHUNK_LIMIT);
  const slice = await readSlice(child.path, childOffset, want);
  const { trimmed, endOffset } = trimAtLastNewline(slice, childOffset);
  if (trimmed.length === 0) return false;
  // From-zero first chunk replaces the child canonical (divergence repair,
  // mirroring the parent path). The agent endpoints always understand it.
  const replace = childOffset === 0;

  const append = await requestAgentAppendUrl(cfg, {
    family: fState.family as never,
    sessionId: fState.sessionId,
    agentId: child.agentId,
    byteCount: trimmed.length,
  });
  await putChunk(append.uploadUrl, trimmed);

  const text = trimmed.toString("utf8");
  const summary = summariseChunk(text);
  const meta = await readAgentMeta(child.metaPath);
  // cwd/gitBranch ride on every child line; the head reader extracts them.
  const head = await readHead(child.path, "claude");
  const kind: "subagent" | "workflow_agent" =
    child.runId || meta?.agentType === "workflow-subagent" ? "workflow_agent" : "subagent";

  await commitAgentChunk(cfg, {
    family: fState.family as never,
    sessionId: fState.sessionId,
    agentId: child.agentId,
    chunkId: append.chunkId,
    replace,
    vaultOrgId: append.vaultOrgId,
    meta: {
      kind,
      runId: child.runId,
      toolUseId: meta?.toolUseId,
      agentType: meta?.agentType,
      label: meta?.description,
      worktreePath: meta?.worktreePath,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      eventCount: summary.eventCount,
      lastActivityAt: summary.lastActivityAt,
    },
  });

  await setOffsetFor(child.path, append.vaultOrgId ?? null, endOffset, st.mtimeMs, scope);
  log(
    `  [agent] ${fState.sessionId.slice(0, 8)}…/${child.agentId.slice(0, 8)}… (+${trimmed.length}B${child.runId ? `, ${child.runId}` : ""})`,
  );
  return true;
}

/**
 * Upload a workflow run's sidecar (script + journal) when either changed.
 * Whole small files, hash-gated like tasks/plan. The journal is what gives the
 * viewer authoritative per-agent status, so it syncs on every tick that moves.
 */
async function syncWorkflowRun(
  cfg: HxConfig,
  run: DiscoveredWorkflowRun,
  parentByArtifactSession: Map<string, ChildParentIdentity>,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  const parent = parentByArtifactSession.get(run.parentSessionId);
  const family = (parent?.family ?? "claude-cli") as never;
  const sessionId = parent?.sessionId ?? run.parentSessionId;
  const journal = await readTextFile(run.journalPath);
  const script = await readTextFile(run.scriptPath);
  if (!journal && !script) return;
  const key = `${String(family)}:${sessionId}:wf:${run.runId}`;
  const hash = hashContent(`${script ?? ""}\n--journal--\n${journal ?? ""}`);
  if ((await getArtifactHash(key, scope)) === hash) return;
  await uploadWorkflowRun(cfg, {
    family,
    sessionId,
    runId: run.runId,
    scriptName: run.scriptName,
    script,
    journal,
  });
  await setArtifactHash(key, hash, scope);
  log(`  [workflow] ${sessionId.slice(0, 8)}…/${run.runId}`);
}

// Mirror the device's active agent teams (<claudeRoot>/teams/* across every
// watched root). The dirs exist only while a team runs; an upload happens only
// when the set changes, and the transition back to "no teams" uploads once
// (clearing the server mirror).
async function syncTeamMirror(cfg: HxConfig, log: (msg: string) => void): Promise<void> {
  const scope = scopeOf(cfg);
  let teams;
  try {
    const settings = await readSettings();
    const teamsDirs = resolveDataRoots(settings).claude.map((r) => claudeTeamsDir(r.configDir));
    teams = await readTeamConfigs(teamsDirs);
  } catch {
    return;
  }
  const hash = hashContent(JSON.stringify(teams.map((t) => [t.name, t.config])));
  const key = "teams:mirror";
  if ((await getArtifactHash(key, scope)) === hash) return;
  try {
    await uploadTeamMirror(cfg, { teams, syncedAtMs: Date.now() });
    await setArtifactHash(key, hash, scope);
    if (teams.length > 0) log(`  [teams] synced ${teams.length} team(s)`);
  } catch (err) {
    log(`  [teams] sync failed: ${(err as Error).message}`);
  }
}

/** Tasks dirs in probe order: the live transcript's own root first. A copied
 *  tree can hold a FROZEN twin of a session's tasks under another root (and
 *  the default root always sorts first in resolution order) — so
 *  first-existing-wins must probe the root the elected transcript actually
 *  lives under before any twin, or the server mirrors a stale task list
 *  forever while the transcript stays live. */
function orderTasksDirs(roots: ResolvedRoots, preferredRootDir?: string): string[] {
  const dirs = roots.claude.map((r) => claudeTasksDir(r.configDir));
  if (!preferredRootDir) return dirs;
  const pref = claudeTasksDir(preferredRootDir);
  return [pref, ...dirs.filter((d) => d !== pref)];
}

/**
 * After a session's transcript chunk lands, sync its sidecar artifacts:
 *   • tasks — the whole ~/.claude/tasks/<sessionId>/ set, if any
 *   • plan  — only when this fresh chunk introduced a plan_mode attachment
 * Both are content-hash-gated so an unchanged file never re-uploads.
 */
async function syncArtifacts(
  cfg: HxConfig,
  fState: FileState,
  chunkText: string,
  log: (msg: string) => void,
  preferredRootDir?: string,
): Promise<void> {
  const scope = scopeOf(cfg);
  const settings = await readSettings();
  const tasksDirs = orderTasksDirs(resolveDataRoots(settings), preferredRootDir);
  const tasks = await readTaskSet(fState.sessionId, tasksDirs);
  if (tasks && tasks.length > 0) {
    const key = `${fState.family}:${fState.sessionId}:tasks`;
    const hash = hashContent(JSON.stringify(tasks));
    if ((await getArtifactHash(key, scope)) !== hash) {
      await uploadTasks(cfg, {
        family: fState.family as never,
        sessionId: fState.sessionId,
        tasks,
      });
      await setArtifactHash(key, hash, scope);
      log(`  [tasks] ${fState.sessionId.slice(0, 8)}… (${tasks.length})`);
    }
  }

  const planPath = findPlanPathInText(chunkText);
  if (planPath) {
    const plan = await readPlanFile(planPath);
    if (plan) {
      const key = `${fState.family}:${fState.sessionId}:plan`;
      const hash = hashContent(plan.content);
      if ((await getArtifactHash(key, scope)) !== hash) {
        await uploadPlan(cfg, {
          family: fState.family as never,
          sessionId: fState.sessionId,
          planFilePath: plan.planFilePath,
          content: plan.content,
        });
        await setArtifactHash(key, hash, scope);
        log(`  [plan] ${fState.sessionId.slice(0, 8)}…`);
      }
    }
  }
}

/**
 * One-time catch-up: upload tasks (+ plans) for every ~/.claude/tasks/<id>/
 * dir already on disk, regardless of whether the transcript grew recently.
 * `hx watch` only syncs artifacts off a fresh transcript chunk, so historical
 * sessions need this. Hash-gated, so re-running it is cheap.
 */
export async function backfillArtifacts(
  cfg: HxConfig,
  log: (msg: string) => void,
): Promise<{ tasks: number; plans: number; failed: number }> {
  const settings = await readSettings();
  const roots = resolveDataRoots(settings);
  const tasksDirs = roots.claude.map((r) => claudeTasksDir(r.configDir));
  const sessionIds = await listTaskSessionIds(tasksDirs);
  if (sessionIds.length === 0) {
    log("[hx] no tasks dirs to backfill under the watched roots");
    return { tasks: 0, plans: 0, failed: 0 };
  }
  // Map sessionId → { family, jsonl path, rootDir } from discovered Claude
  // logs so we stamp the right family, find each session's plan attachment,
  // and probe the session's OWN root's tasks dir before any copied twin.
  // Newest mtime wins per session — discovery emits in pool-completion order,
  // and first-wins would coin-flip between a frozen twin and the live file,
  // letting a backfill replace a newer server task set with the copy-time one.
  const claude = await discoverClaudeFiles(roots.claude);
  const byId = new Map<string, { family: string; path: string; rootDir: string; mtimeMs: number }>();
  for (const f of claude) {
    const head = await readHead(f.path, f.source);
    const sid = head.sessionId ?? path.basename(f.path, ".jsonl");
    const prev = byId.get(sid);
    if (!prev || f.mtimeMs > prev.mtimeMs) {
      byId.set(sid, { family: head.family, path: f.path, rootDir: f.rootDir, mtimeMs: f.mtimeMs });
    }
  }
  let tasksN = 0;
  let plansN = 0;
  let failed = 0;
  for (const sid of sessionIds) {
    const info = byId.get(sid);
    const family = (info?.family ?? "claude-cli") as never;
    try {
      const tasks = await readTaskSet(sid, orderTasksDirs(roots, info?.rootDir));
      if (tasks && tasks.length > 0) {
        await uploadTasks(cfg, { family, sessionId: sid, tasks });
        await setArtifactHash(`${info?.family ?? "claude-cli"}:${sid}:tasks`, hashContent(JSON.stringify(tasks)), scopeOf(cfg));
        tasksN += 1;
        log(`  [tasks] ${sid.slice(0, 8)}… (${tasks.length})`);
      }
    } catch (err) {
      failed += 1;
      log(`  [error] tasks ${sid.slice(0, 8)}: ${(err as Error).message}`);
    }
    if (info) {
      try {
        const plan = await readPlanForJsonl(info.path);
        if (plan) {
          await uploadPlan(cfg, { family, sessionId: sid, planFilePath: plan.planFilePath, content: plan.content });
          await setArtifactHash(`${info.family}:${sid}:plan`, hashContent(plan.content), scopeOf(cfg));
          plansN += 1;
          log(`  [plan] ${sid.slice(0, 8)}…`);
        }
      } catch (err) {
        failed += 1;
        log(`  [error] plan ${sid.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
  }
  log(`[hx] backfill done: ${tasksN} task sets, ${plansN} plans (${failed} failed)`);
  return { tasks: tasksN, plans: plansN, failed };
}

// Read CCD's sidebar grouping off the local leveldb and upload it if it
// changed since the last sync. Hash-gated on the meaningful content (groups +
// enabled + unread), so an unchanged mirror never re-uploads. Best-effort: a
// failure here never affects transcript uploads.
async function syncGroupMirror(cfg: HxConfig, log: (msg: string) => void): Promise<void> {
  const scope = scopeOf(cfg);
  let mirror;
  try {
    mirror = await buildGroupMirror(Date.now());
  } catch {
    return;
  }
  // Exclude the volatile syncedAtMs from the gate — only content changes count.
  const hash = hashContent(
    JSON.stringify({
      enabled: mirror.groupingEnabled,
      groups: mirror.groups,
      unread: [...mirror.unreadIds].sort(),
    }),
  );
  const key = "ccd:group-mirror";
  if ((await getArtifactHash(key, scope)) === hash) return;
  try {
    const res = await uploadGroupMirror(cfg, mirror);
    await setArtifactHash(key, hash, scope);
    log(`  [groups] synced ${res.groups} CCD group(s)`);
  } catch (err) {
    log(`  [groups] sync failed: ${(err as Error).message}`);
  }
}

/**
 * Canonical divergence audit. For every file this device has uploaded bytes
 * for, ask the gateway whether the canonical object in the store actually
 * holds that many bytes. Whatever drifted — a deploy wiped the store, a
 * canonical got mangled — has its offset reset to zero, so the next pass
 * re-uploads the whole file with replace:true and the server copy converges
 * back to the device's source of truth. Runs between upload passes, never
 * concurrently with one, so an in-flight chunk can't read as divergence.
 */
async function auditCanonicals(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  if (SELF_HEAL.get(scope) === false) return;
  const roots = resolveDataRoots(await readSettings());
  // UNWINDOWED, deliberately. The audit's whole job is "does the server still
  // hold what our offsets claim it holds?", and that question does not expire
  // after 30 days — the answer is wrong for exactly as long as the file sits
  // on disk.
  //
  // A windowed audit left a hole nothing else could cover. When a device's
  // gateway changes (beta → prod), state.json KEEPS its per-file offsets, so
  // every old session reads as already-delivered while the new bucket holds
  // none of it. Such a file is skipped by the backfill sweep (it looks
  // delivered) AND invisible to a 30-day audit — so it would never re-upload,
  // silently, forever. Measured on one device after the 2026-07-30 cutover:
  // 71 files / 46.7 MB in that blind spot.
  //
  // Cheap: discovery is a warm stat sweep, candidates are already filtered to
  // offset > 0, and verifySessions batches 1,000 per round trip — an extra
  // few hundred sessions is a fraction of one request, twice an hour.
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(roots.claude, { maxAgeMs: Infinity }),
    discoverCodexFiles(roots.codex, { maxAgeMs: Infinity }),
  ]);
  let files = [...claude, ...codex];
  if (opts.only) files = files.filter((f) => f.path === opts.only);
  const state = await loadState(scope);
  files = electUploaders(files, state);
  const candidates: Array<{ path: string; fState: FileState }> = [];
  for (const f of files) {
    const fs = state.files[f.path];
    // offset 0 needs no audit — it re-uploads (with replace) regardless. The
    // audit only repairs let.ai-hosted canonical wipes (ephemeral-FS redeploys);
    // customer vault stores are durable and aren't subject to them, so we audit
    // only the let.ai destination's offset — matching the server, which skips
    // vault-routed sessions. A late-joining/offline vault catches up via its own
    // per-destination offset (0 → replace), needing no audit.
    // Tombstoned (server-deleted) sessions are excluded outright — the server
    // answers "deleted" for them anyway; skipping saves the round trip.
    if (fs && offsetFor(fs, null) > 0 && !isDeletedSession(state, fs.family, fs.sessionId)) {
      candidates.push({ path: f.path, fState: fs });
    }
  }
  if (candidates.length === 0) return;

  let healed = 0;
  for (let i = 0; i < candidates.length; i += VERIFY_BATCH) {
    const batch = candidates.slice(i, i + VERIFY_BATCH);
    let results;
    try {
      results = await verifySessions(
        cfg,
        batch.map(({ fState }) => ({
          family: fState.family as never,
          sessionId: fState.sessionId,
          byteCount: offsetFor(fState, null),
        })),
      );
    } catch (err) {
      if (err instanceof HxHttpError && err.status === 404) {
        // Gateway predates sessions/verify (and commit's replace flag) —
        // disable self-heal for this lane rather than thrash.
        SELF_HEAL.set(scope, false);
        log(`[hx] gateway has no sessions/verify; canonical self-heal disabled`);
        return;
      }
      throw err;
    }
    SELF_HEAL.set(scope, true);
    const byKey = new Map(results.map((r) => [`${r.family}:${r.sessionId}`, r]));
    for (const { path: filePath, fState } of batch) {
      const r = byKey.get(`${fState.family}:${fState.sessionId}`);
      // MUST come before the divergent branch: a deleted session's canonical is
      // gone server-side, so it would otherwise read as "divergent" and drive
      // the full replace re-upload the tombstone exists to prevent. Terminal:
      // record the stop-flag; every subsequent pass skips the session entirely.
      if (r?.status === "deleted") {
        await recordDeletedSession(fState.family, fState.sessionId, scope);
        log(
          `[hx] ${fState.sessionId.slice(0, 8)}… was permanently deleted on the server — uploads stopped (local file kept)`,
        );
        continue;
      }
      if (r?.status !== "divergent") continue;
      if ((fState.healPausedUntilMs ?? 0) > Date.now()) continue; // ping-pong latch
      healed += 1;
      await recordHeal(filePath, scope);
      // Log before the reset — setOffsetFor mutates this same fState object.
      log(
        `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${r.storeBytes ?? 0}B ≠ uploaded ${offsetFor(fState, null)}B — re-uploading from zero`,
      );
      await setOffsetFor(filePath, null, 0, fState.lastMtimeMs, scope);
    }
  }
  if (healed > 0) log(`[hx] canonical audit: re-uploading ${healed} diverged session(s)`);
}

// Shadowed-twin log dedupe: each hidden path is announced once per process.
const loggedShadowed = new Set<string>();

/**
 * One uploader per canonical. Several local files can map to the same
 * (family, sessionId) — a transcript duplicated under a second project dir
 * when the session's cwd changed, or a codex archive move. Uploading BOTH into
 * one canonical makes every commit's totalBytes mismatch the other file's
 * offset, and the per-commit self-heal then ping-pongs full re-uploads forever
 * (observed live: one session healed from zero 15 times). Elect the
 * most-recently-written file per key (tie: largest) — mtime tracks the LIVE
 * writer (a stale twin's mtime is frozen, so it can't shadow the file new
 * content is actually landing in), which "largest wins" got wrong when a
 * complete-but-dead copy outsized a freshly-restarted live file. The twins
 * are shadowed — skipped by uploads, the audit, and the sync snapshot.
 */
function electUploaders(
  files: DiscoveredFile[],
  state: HxState,
  log?: (msg: string) => void,
): DiscoveredFile[] {
  const byKey = new Map<string, DiscoveredFile[]>();
  const active: DiscoveredFile[] = [];
  for (const f of files) {
    const fs = state.files[f.path];
    // Not seeded yet — passes through this tick (ingestOne seeds it) and joins
    // the election next tick, once its sessionId is known.
    if (!fs) {
      active.push(f);
      continue;
    }
    const key = `${fs.family}:${fs.sessionId}`;
    const list = byKey.get(key) ?? [];
    list.push(f);
    byKey.set(key, list);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
    active.push(list[0]!);
    for (const twin of list.slice(1)) {
      if (log && !loggedShadowed.has(twin.path)) {
        loggedShadowed.add(twin.path);
        log(`[hx] ${twin.path} shadows ${list[0]!.path} (same session); not uploading the twin`);
      }
    }
  }
  return active;
}

/**
 * Child-lane election — the same twin problem as electUploaders, keyed by the
 * child's UPLOAD identity instead. A copied data root (the no-migration
 * CLAUDE_CONFIG_DIR world makes copies routine) leaves the same
 * (parentSessionId, agentId, runId) child at two paths; both would upload
 * from-zero REPLACEs into one child canonical and ping-pong it forever —
 * child lanes have no offsets audit to even notice. Same rule as parents:
 * newest mtime wins (tie: largest), losers are shadowed. Needs no state —
 * the child's identity is fully encoded in its discovered shape.
 */
/**
 * Pure planner for child-lane uploader flips. Election is stateless; when a
 * lane's winner CHANGES (the copied-tree race: fresh copy out-mtimes the live
 * file once, then loses again), the incoming winner's existing offsets
 * describe a canonical some OTHER file last wrote — appending from them would
 * interleave two files' bytes, and child lanes have no offsets audit to heal
 * that. The plan: remember each lane's winner; on a flip, zero the new
 * winner's offsets so its next upload is a clean replace-from-zero (children
 * are small — one re-upload per flip is the whole cost). An UNCONTESTED first
 * sighting is not a flip: existing offsets belong to that same path. A
 * CONTESTED first sighting (≥2 candidates, no memory of a winner) resets too:
 * that's the upgrade path for machines whose twins predate the map — both
 * files hold offsets from the old both-upload world, the canonical is already
 * an interleaving, and this one replace-from-zero is the only heal child
 * lanes will ever get (they have no offsets audit).
 */
export function planChildLaneResets(
  elected: DiscoveredChildFile[],
  prev: Record<string, string>,
  contestedLanes: ReadonlySet<string> = new Set(),
): { nextMap: Record<string, string>; resetPaths: string[]; changed: boolean } {
  const nextMap = { ...prev };
  const resetPaths: string[] = [];
  let changed = false;
  for (const c of elected) {
    const lane = `${c.parentSessionId}:${c.agentId}:${c.runId ?? ""}`;
    const before = nextMap[lane];
    if (before === c.path) continue;
    if (before !== undefined || contestedLanes.has(lane)) resetPaths.push(c.path);
    nextMap[lane] = c.path;
    changed = true;
  }
  return { nextMap, resetPaths, changed };
}

/** Lanes with more than one discovered candidate this tick. */
export function contestedChildLanes(children: DiscoveredChildFile[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of children) {
    const lane = `${c.parentSessionId}:${c.agentId}:${c.runId ?? ""}`;
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([lane]) => lane));
}

export function electChildUploaders(
  children: DiscoveredChildFile[],
  log?: (msg: string) => void,
): DiscoveredChildFile[] {
  const byKey = new Map<string, DiscoveredChildFile[]>();
  for (const c of children) {
    const key = `${c.parentSessionId}:${c.agentId}:${c.runId ?? ""}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  const active: DiscoveredChildFile[] = [];
  for (const list of byKey.values()) {
    // Deterministic final tiebreak: `cp -a`/`rsync -a` twins share mtime AND
    // size, and a readdir-order flip would otherwise swap the winner — which,
    // for children, now costs a replace-from-zero via the lane-flip reset.
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size || a.path.localeCompare(b.path));
    active.push(list[0]!);
    for (const twin of list.slice(1)) {
      if (log && !loggedShadowed.has(twin.path)) {
        loggedShadowed.add(twin.path);
        log(`[hx] ${twin.path} shadows ${list[0]!.path} (same child lane); not uploading the twin`);
      }
    }
  }
  return active;
}

/**
 * Catch-up snapshot from the discovered files + the persisted upload offsets:
 * a file is "done" once we've uploaded up to its (discovery-time) size, and
 * every file short of that contributes its remaining bytes to the backlog.
 * Pure in-memory — `state` is the cached object the upload path mutates, so a
 * recompute mid-pass reflects offsets bumped by commits earlier in the pass.
 */
export function snapshotFrom(files: DiscoveredFile[], state: HxState): SyncSnapshot {
  let done = 0;
  let totalBytes = 0;
  for (const f of files) {
    const fs = state.files[f.path];
    // "Done" = the least-current REAL destination has caught up to the file
    // size. reportableOffset, not minOffset: a key with no registry entry can
    // hold no bytes, and letting it pin the minimum reported a session as
    // unsent forever — and would make this snapshot, which is POSTed to the
    // gateway, contradict the ledger `hx status` prints from the same state.
    const offset = fs ? reportableOffset(fs, state) : 0;
    // A persisted hold is unfinished even when legacy offsets happen to equal
    // the source size: a destination is still explicitly waiting for bytes.
    if (offset >= f.size && !fs?.skipReason) done += 1;
    totalBytes += f.size; // total size of ALL sessions, synced or not
  }
  return { total: files.length, done, totalBytes };
}

// Report progress at most once per second so a long first pass shows the bar
// climbing without a snapshot per file. Start + end are always reported, and
// reportSync throttles actual POSTs to ≥1.5 s apart regardless — a finer
// cadence only burned CPU: the old every-20th-FILE gate recomputed the full
// O(files) snapshot fold 500× per pass on a 10k tree (~64% of a core
// measured in the e2e profile), then discarded almost all of them.
const SYNC_PROGRESS_MIN_MS = 1_000;

/** One-shot catch-up snapshot (no upload) — backs `hx status` and the daemon
 *  restart decision. Main lane only: the `--local` tee tracks its own catch-up
 *  through its own tick's onProgress reports. */
export async function computeSyncSnapshot(
  only?: string,
  rootsOverride?: ResolvedRoots,
): Promise<SyncSnapshot> {
  const settings = await readSettings();
  // Callers that must describe the BACKGROUND service's surface (the CLI's
  // stamp-first paths) pass rootsOverride; without it we resolve for THIS
  // process (the daemon itself, and true one-shots like `hx tick`).
  const roots = rootsOverride ?? resolveDataRoots(settings);
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(roots.claude),
    discoverCodexFiles(roots.codex),
  ]);
  let files = [...claude, ...codex];
  if (only) files = files.filter((f) => f.path === only);
  const state = await loadState();
  return snapshotFrom(filterWatched(electUploaders(files, state), state, settings), state);
}

/** A state entry that is no longer discoverable on disk yet never finished
 *  uploading — the server copy is partial and will stay that way. */
export interface SyncBehindEntry {
  path: string;
  sessionId: string;
  uploaded: number;
  lastKnownSize: number;
  /** true = the local file is gone; false = it merely aged out of the
   *  30-day discovery window. */
  sourceGone: boolean;
}

/** A discoverable session whose upload is paused because its destination store
 *  is temporarily unavailable (skipReason set). Transient — it resumes on its
 *  own once the store returns; surfaced so `hx status` explains the lag. */
export interface SyncSkippedEntry {
  path: string;
  family: string;
  sessionId: string;
  reason: FileSkipReason;
  /** When the next upload attempt is due (ms since epoch), if scheduled. */
  nextAttemptAtMs?: number;
  blocker?: FileState["blocker"];
}

export interface SyncReport {
  snapshot: SyncSnapshot;
  behind: SyncBehindEntry[];
  skipped: SyncSkippedEntry[];
  /** Every session in exactly one bucket, plus the health percentage `hx
   *  status` prints. Derived from per-destination offsets + the durable
   *  destination registry, so it sees holds the transient skipReason misses. */
  ledger: SyncLedger;
  /** Sessions the settings filters DROP before any upload is attempted — the
   *  personal-sync gate or an exclude rule. They vanish from every count, so
   *  without this they are indistinguishable from sessions that do not exist. */
  excluded: Array<{
    path: string;
    family: string;
    sessionId: string;
    repoSlug: string | null;
    cwd: string | null;
    attributed: boolean | null;
    reason: string;
  }>;
  /** Tracked sessions that discovery did NOT return, split by whether the file
   *  is still on disk. `onDiskButUndiscovered` should always be empty — if it
   *  is not, discovery is skipping a file that exists, which is a bug. */
  undiscovered: { fileGone: number; onDiskButUndiscovered: number };
  /** Child agent lanes (`<sessionId>/subagents/*.jsonl` and workflow lanes).
   *
   *  They are tracked in state.files, uploaded by their OWN pass, and until now
   *  reported by nothing at all — on one real device 706 of 756 tracked entries
   *  were child lanes, so 93% of what the client tracks was invisible on every
   *  surface. Excluding them from the session checks (they are found by a
   *  different discovery) is correct; excluding them from the OUTPUT is how a
   *  whole category of stall would go unnoticed. Counted here instead. */
  childLanes: {
    tracked: number;
    onDisk: number;
    gone: number;
    owing: number;
    owedBytes: number;
    /** Child lanes carrying a per-file HOLD (skipReason). Counted separately
     *  because collectSkipped cannot see them: it reports only files present in
     *  discovery, and discovery walks `projects/<slug>/*.jsonl` — never the
     *  `<sessionId>/subagents/` tree. Without this a device whose every lane is
     *  quarantined stamps the reason into state.json and still prints nothing,
     *  which is the whole failure being fixed. */
    held: number;
    /** held, broken down by reason, so the report names the condition. */
    heldReasons: Record<string, number>;
  };
  /** DISTINCT partially-uploaded sessions sitting under NO current data root
   *  — a root was removed (or the daemon hasn't adopted one yet). They are
   *  not "behind" (nothing will ever pick them up under the current config),
   *  so they get their own count instead of nagging the behind list forever.
   *  Deduped per session, and a session with a live behind entry is never
   *  double-billed here (see collectBehind). */
  unwatched: number;
}

/** The still-on-disk sessions currently waiting on a temporarily-unavailable
 *  store. Pure over `files` (the elected uploaders) + `state`, so it's
 *  unit-testable. Vanished/aged files are reported via `behind`, not here, so
 *  the two sets never overlap. */
export function collectSkipped(files: DiscoveredFile[], state: HxState): SyncSkippedEntry[] {
  const discovered = new Set(files.map((f) => f.path));
  const out: SyncSkippedEntry[] = [];
  for (const [p, fs] of Object.entries(state.files)) {
    if (!fs.skipReason) continue;
    if (!discovered.has(p)) continue;
    out.push({
      path: p,
      family: fs.family,
      sessionId: fs.sessionId,
      reason: fs.skipReason,
      nextAttemptAtMs: fs.nextAttemptAtMs,
      blocker: fs.blocker,
    });
  }
  return out;
}

/** Injectable inputs for {@link computeSyncReport} — the UI server passes its
 *  cached UNWINDOWED discovery lists (and a settings snapshot) so its 5s poll
 *  stops re-walking the whole disk; the CLI path passes nothing and stays
 *  byte-identical (fresh unwindowed discovery + fresh settings). Injected
 *  lists MUST be unwindowed-equivalent — the report's behind/incomplete math
 *  is meaningless over a windowed subset. */
export interface SyncReportInputs {
  claude: DiscoveredFile[];
  codex: DiscoveredFile[];
  settings?: HxSettings;
}

/** Sync snapshot PLUS the sessions the snapshot can no longer see: entries
 *  whose source file vanished (or aged out of discovery) mid-upload — and the
 *  sessions currently skipped on a temporarily-unavailable store. Backs the
 *  honest `hx status` output — without these the bar reads 100% while the
 *  server holds partial transcripts or a store is down. */
export async function computeSyncReport(
  rootsOverride?: ResolvedRoots,
  injected?: SyncReportInputs,
): Promise<SyncReport> {
  const settings = injected?.settings ?? (await readSettings());
  const roots = rootsOverride ?? resolveDataRoots(settings);
  // UNWINDOWED — this is a REPORT, not the hot loop. The 30-day bound exists so
  // a 1.5s sweep stays cheap; describing the device is a once-per-invocation
  // read where it only distorts.
  //
  // Two things went wrong while this was windowed. The daemon now backfills
  // files older than the window, so `hx status` was omitting sessions it was
  // actively uploading. And an aged-out file still sitting on disk was counted
  // as `incomplete` — "source file gone, permanently partial" — when it is
  // neither gone nor unrecoverable; the backfill sweep will deliver it. Only
  // genuinely-vanished sources are incomplete, and that needs discovery to see
  // everything before it can tell the difference.
  const [claude, codex] = injected
    ? [injected.claude, injected.codex]
    : await Promise.all([
        discoverClaudeFiles(roots.claude, { maxAgeMs: Infinity }),
        discoverCodexFiles(roots.codex, { maxAgeMs: Infinity }),
      ]);
  const all = [...claude, ...codex];
  const state = await loadState();
  const discovered = new Set(all.map((f) => f.path));
  // Sessions still represented by a discovered file (its family:sessionId). A
  // state entry absent from discovery is only a real "gap" if NO current file
  // covers its session — otherwise it's a shadowed twin whose content actually
  // uploaded through the elected file, and whose offsets are frozen BY DESIGN.
  const liveSessions = new Set<string>();
  for (const f of all) {
    const fs = state.files[f.path];
    if (fs) liveSessions.add(`${fs.family}:${fs.sessionId}`);
  }
  const { behind, unwatched } = collectBehind(
    state,
    discovered,
    liveSessions,
    [...roots.claude, ...roots.codex],
  );
  // Settings filtering applies to the ELECTED set only: `discovered` and
  // `liveSessions` above stay unfiltered so an excluded-but-present file can
  // never masquerade as a vanished-source gap.
  const preFilter = electUploaders(all, state);
  const elected = filterWatched(preFilter, state, settings);
  // What the settings filters removed, and WHY. filterWatched is silent by
  // design (it runs on the hot path), so an excluded session simply stops
  // existing as far as every surface is concerned.
  const keptPaths = new Set(elected.map((f) => f.path));
  const excluded = preFilter
    .filter((f) => !keptPaths.has(f.path))
    .map((f) => {
      const fs = state.files[f.path];
      const folderHit = settings.excludedFolders.some(
        (e) => e.family === fs?.family && e.cwd === fs?.cwd,
      );
      const reason = !fs
        ? "no state entry"
        : isDeletedSession(state, fs.family, fs.sessionId)
          ? "deleted on the server (tombstoned)"
          : folderHit
            ? `excluded folder ${fs.cwd ?? "?"}`
            : settings.excludeRules.length > 0 && fs.cwd
              ? `matched an exclude rule (cwd ${fs.cwd})`
              : `personal-sync gate: personalSync=${settings.personalSync}, repoSlug=${fs.repoSlug ?? "null"}, attributed=${fs.attributed}`;
      return {
        path: f.path,
        family: fs?.family ?? "unknown",
        sessionId: fs?.sessionId ?? "unknown",
        repoSlug: fs?.repoSlug ?? null,
        cwd: fs?.cwd ?? null,
        attributed: fs?.attributed ?? null,
        reason,
      };
    });
  // A tracked SESSION file discovery did not return. Split so "the transcript
  // was pruned" (normal) is never confused with "discovery cannot see a file
  // that is right there" (a bug we would otherwise never notice).
  //
  // Child agent lanes are excluded deliberately. state.files tracks them too —
  // on one real device, 706 of 756 entries were `<sessionId>/subagents/*.jsonl`
  // — but they are found by their own discovery pass, not this one. Comparing
  // the whole map against session discovery reported 602 phantom "missing"
  // files on a completely healthy machine, which is exactly the kind of
  // false alarm that teaches people to ignore warnings.
  const isChildLane = (p: string): boolean =>
    p.includes("/subagents/") || p.includes("/workflows/");
  let fileGone = 0;
  let onDiskButUndiscovered = 0;
  const childLanes = {
    tracked: 0,
    onDisk: 0,
    gone: 0,
    owing: 0,
    owedBytes: 0,
    held: 0,
    heldReasons: {} as Record<string, number>,
  };
  for (const [p, fs] of Object.entries(state.files)) {
    if (isChildLane(p)) {
      childLanes.tracked += 1;
      const here = existsSync(p);
      if (here) childLanes.onDisk += 1;
      else childLanes.gone += 1;
      // Only an ON-DISK lane can be held in any useful sense: releasing a hold
      // on a pruned file changes nothing, and nothing ever removes entries from
      // state.files, so counting those reported "81 HELD — release with hx
      // retry --blocked" forever for lanes that no longer exist — and opened
      // the retry gate, which stops the daemon and rewrites state to clear
      // flags on files that are gone. Mirrors `owing` directly below, and
      // collectSkipped's discovered-only rule for parents.
      if (here && fs.skipReason) {
        childLanes.held += 1;
        childLanes.heldReasons[fs.skipReason] = (childLanes.heldReasons[fs.skipReason] ?? 0) + 1;
      }
      // Only an on-disk lane can still be sent; a pruned one is as final as a
      // pruned session and must not read as backlog.
      if (here && fs.lastKnownSize !== undefined && minOffset(fs) < fs.lastKnownSize) {
        childLanes.owing += 1;
        childLanes.owedBytes += fs.lastKnownSize - minOffset(fs);
      }
      continue;
    }
    if (discovered.has(p)) continue;
    if (existsSync(p)) onDiskButUndiscovered += 1;
    else fileGone += 1;
  }
  return {
    snapshot: snapshotFrom(elected, state),
    behind,
    skipped: collectSkipped(elected, state),
    excluded,
    undiscovered: { fileGone, onDiskButUndiscovered },
    childLanes,
    unwatched,
    ledger: buildLedger({
      files: elected,
      state,
      // DISTINCT sessions whose source vanished mid-upload — the server copy
      // stays partial forever. Deduped here because one session can leave two
      // file entries behind (a cwd-change twin), and double-billing would put
      // the ledger's parts above its own total.
      incompleteSessions: new Set(behind.map((b) => b.sessionId)).size,
      nowMs: Date.now(),
      orgNames: await readOrgNames().catch(() => ({})),
    }),
  };
}

/** Pure fold of state entries into behind/unwatched buckets — unit-tested.
 *  behind = never-finished uploads whose file left discovery but still sits
 *  under a watched root (deleted or aged out); unwatched = DISTINCT SESSIONS
 *  in the same shape under NO current root (a removed data root) — nothing
 *  will ever pick those up under the current config, so they must not nag
 *  the behind list. Sessions, not file entries: cwd-change twins are one
 *  session, and a session still reportable as behind under a watched root is
 *  accounted there, never double-billed as unwatched too (mirrors the
 *  per-session dedupe hx status applies to the behind display). */
export function collectBehind(
  state: HxState,
  discovered: Set<string>,
  liveSessions: Set<string>,
  roots: DataRoot[],
): { behind: SyncBehindEntry[]; unwatched: number } {
  const behind: SyncBehindEntry[] = [];
  const behindSessions = new Set<string>();
  const unwatchedSessions = new Set<string>();
  for (const [p, fs] of Object.entries(state.files)) {
    if (discovered.has(p)) continue;
    // Server-deleted (tombstoned) sessions never upload again by design — they
    // are neither behind nor unwatched, the same exclusion filterWatched
    // applies to the live surface. Without this the phantom that filter fixes
    // re-materializes here (and reddens `hx doctor sync`) once the file ages
    // past the discovery window.
    if (isDeletedSession(state, fs.family, fs.sessionId)) continue;
    if (liveSessions.has(`${fs.family}:${fs.sessionId}`)) continue; // shadowed twin
    if (fs.lastKnownSize === undefined) continue; // legacy entry — size unknown
    const uploaded = minOffset(fs);
    if (uploaded >= fs.lastKnownSize) continue;
    const sessionKey = `${fs.family}:${fs.sessionId}`;
    if (!isUnderRoots(p, roots)) {
      unwatchedSessions.add(sessionKey);
      continue;
    }
    behindSessions.add(sessionKey);
    behind.push({
      path: p,
      sessionId: fs.sessionId,
      uploaded,
      lastKnownSize: fs.lastKnownSize,
      sourceGone: !existsSync(p),
    });
  }
  // Post-loop (entry order is arbitrary): drop unwatched sessions that also
  // have a behind entry — one session, one row.
  for (const key of behindSessions) unwatchedSessions.delete(key);
  return { behind, unwatched: unwatchedSessions.size };
}

export async function tickOnce(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
  onProgress?: (snap: SyncSnapshot) => void,
): Promise<{ uploaded: number; failed: number; snapshot: SyncSnapshot }> {
  // Settings first: they carry the extra data roots, so discovery has to see
  // them. Each tick re-resolves — a root added through the UI is swept within
  // one poll interval, no restart.
  const settings = await readSettings();
  const roots = resolveDataRoots(settings);
  const scope = scopeOf(cfg);
  // Tiered catalog by default; `tuning.sweep: "legacy"` (settings, re-read per
  // tick so it reaches installed daemons) or HX_SWEEP=legacy (dev shells)
  // restores the historical full-sweep-per-tick verbatim. A fresh catalog's
  // first sweep IS a full discovery, so one-shot callers (`hx tick`,
  // `watch --once`) see identical results either way.
  const legacySweep =
    tuningValue(settings, "sweep") === "legacy" || process.env["HX_SWEEP"] === "legacy";
  const catalog = legacySweep ? null : catalogFor(scope);
  let files: DiscoveredFile[];
  if (catalog) {
    await catalog.sweep(roots, Date.now());
    files = catalog.listFiles();
  } else {
    const [claude, codex] = await Promise.all([
      discoverClaudeFiles(roots.claude),
      discoverCodexFiles(roots.codex),
    ]);
    files = [...claude, ...codex];
  }
  if (opts.only) files = files.filter((f) => f.path === opts.only);
  // Report before uploading anything so a freshly connected device shows its
  // full backlog ("0 / 1,203") immediately, not only after the first pass.
  const state = await loadState(scope);

  // The unwindowed sweep: once on start, then hourly. Live discovery above
  // prunes to 30 days for CADENCE (a 1.5s loop cannot stat 100k files), but
  // that bound was also silently deciding what would ever be uploaded at all —
  // so a file that went 30 days unignested was abandoned with no report. This
  // reaches everything still on disk that has not been fully delivered.
  // Merged BEFORE election/filtering so a backfilled file passes through the
  // identical gates (twin election, settings excludes, tombstones, routing).
  if (!opts.only && backfillDue(scope, Date.now())) {
    markBackfillRun(scope, Date.now());
    try {
      const older = await discoverBackfill(roots, state, Date.now());
      if (older.length > 0) {
        const known = new Set(files.map((f) => f.path));
        const added = older.filter((f) => !known.has(f.path));
        const unseen = added.filter((f) => !state.files[f.path]).length;
        if (added.length > 0) {
          log(
            `[hx] backfill: ${added.length} session${added.length === 1 ? "" : "s"} older than the 30-day window still undelivered (${unseen} never ingested) — queueing`,
          );
          files = [...files, ...added];
        } else {
          // Silence here was ambiguous: "the sweep is not running" and "the
          // sweep ran and found nothing" looked identical from the log.
          log(
            `[hx] backfill: ${older.length} session(s) older than the window, all already queued this pass — nothing to add`,
          );
        }
      } else {
        log("[hx] backfill: nothing older than the 30-day window still owes bytes");
      }
    } catch (err) {
      // Never let the slow sweep break a pass: the live backlog matters more,
      // and the next hourly attempt retries anyway.
      log(`[hx] backfill sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Seed-then-elect (R5): every file with no state entry is seeded BEFORE
  // election, so unseeded twins collapse to one winner before any pooled
  // worker starts — two stateless copies of one session uploading in
  // parallel would interleave replace/append writes into one canonical,
  // permanently on vault/fortress lanes (no divergence heal there). This is
  // the same lazy seeding ingestOne always did per file, done up front. An
  // unreadable head is left for ingestOne's own error taxonomy — its twin,
  // if readable, is seeded and wins the election regardless.
  {
    const unseeded = files.filter((f) => !state.files[f.path]);
    if (unseeded.length > 0) {
      await mapPool(unseeded, STAT_CONCURRENCY, async (f) => {
        await ensureFileState(f, scope).catch(() => {});
      });
    }
  }
  files = filterWatched(electUploaders(files, state, log), state, settings);
  onProgress?.(snapshotFrom(files, state));

  // Adaptive chunk growth is resolved once per pass and threaded via opts —
  // dark unless tuning.chunkGrowth is exactly true.
  const effOpts: WatchOptions =
    tuningValue(settings, "chunkGrowth") === true ? { ...opts, chunkGrowth: true } : opts;
  const fileConcurrency = tuningInt(settings, "uploadConcurrency", FILE_CONCURRENCY_DEFAULT);
  const childConcurrency = tuningInt(settings, "childConcurrency", CHILD_CONCURRENCY_DEFAULT);

  let uploaded = 0;
  let failed = 0;
  // Distinct files that hit a gateway-shaped 5xx this pass — see the
  // serverUnavailable branch below: one file's unrecognized 5xx must not be
  // read as a wholesale outage. Shared across pooled workers; latching stops
  // DEQUEUEING while in-flight workers settle (≤ concurrency−1 extra, M4).
  const gatewayUnavailableFiles = new Set<string>();
  let stopPass = false;
  const processParent = async (f: DiscoveredFile): Promise<void> => {
    // Per-file backoff: a file that keeps failing (bad request, offline vault)
    // sits out its window instead of burning a gateway round trip every poll.
    const pending = state.files[f.path];
    if (pending?.nextAttemptAtMs && pending.nextAttemptAtMs > Date.now()) {
      const waitMs = pending.nextAttemptAtMs - Date.now();
      const failures = pending.consecutiveFailures;
      const why = pending.skipReason ? `, ${pending.skipReason}` : "";
      logStuck(
        f.path,
        // Key on the CONDITION, not the countdown: bench-vs-backoff, the hold
        // reason, and the failure streak. All three change only when something
        // real changes, so a new line means new information.
        `${failures === undefined ? "bench" : `backoff:${failures}`}:${pending.skipReason ?? "-"}`,
        // A bench and a backoff are different conditions and were printed
        // identically. benchFileProbe deliberately leaves consecutiveFailures
        // alone (the outage is not this file's fault), so the old line reported
        // every benched file as "waiting out a retry backoff (0 consecutive
        // failures)" — a sentence that describes nothing that happened.
        failures === undefined
          ? `benched for another ${formatWait(waitMs)} behind a gateway outage; no failures of its own${why}`
          : `waiting out a retry backoff for another ${formatWait(waitMs)} (${failures} consecutive failure${failures === 1 ? "" : "s"}${why})`,
        log,
      );
      return;
    }
    // A file seen for the first time has no state entry for filterWatched to
    // match — seed it now and re-check before any byte leaves the machine.
    // With the personal gate armed, a repo file with UNKNOWN attribution asks
    // the gateway first (one bounded, cached route lookup) so the very first
    // chunk already respects the gate exactly.
    if (!pending || (!settings.personalSync && state.files[f.path]?.attributed === undefined)) {
      const seeded = pending ?? (await ensureFileState(f, scope));
      if (
        !settings.personalSync &&
        seeded.repoSlug &&
        seeded.attributed === undefined &&
        cfg.accessToken
      ) {
        const r = await resolveRouteShared(scope, {
          repo: seeded.repoSlug,
          gatewayBaseUrl: cfg.gatewayBaseUrl,
          accessToken: cfg.accessToken,
          cache: routeCacheFor(scope),
        });
        if (Array.isArray(r.attributedOrgIds)) {
          seeded.attributed = r.attributedOrgIds.length > 0;
          await upsertFileState(seeded, scope);
        }
      }
      if (shouldSkipFile(settings, seeded)) {
        // The personal-sync gate and the folder/rule excludes drop a file for
        // good. Silent, this is indistinguishable from "still uploading".
        logStuck(
          f.path,
          "excluded",
          `excluded by settings — personalSync=${settings.personalSync}, repoSlug=${seeded.repoSlug ?? "null"}, attributed=${seeded.attributed}`,
          log,
        );
        return;
      }
    }
    // Server-side permanent delete: terminal per-session stop — no request, no
    // backoff, covers every rediscovered twin of the session (the flag is
    // session-keyed, not per-file).
    {
      const entry = state.files[f.path];
      if (entry && isDeletedSession(state, entry.family, entry.sessionId)) {
        logStuck(
          f.path,
          "deleted",
          "session was permanently deleted on the server — it will never upload again",
          log,
        );
        return;
      }
    }
    try {
      const did = await ingestOne(cfg, f, effOpts, log);
      if (did) uploaded += 1;
      else if (pending && pending.lastKnownSize !== undefined && minOffset(pending) < f.size) {
        // Asked the gateway, got a plan, and it produced no committable bytes —
        // while the file still owes some. That happens when every destination
        // the gateway actually returns is already caught up, and the shortfall
        // is billed to a destination it no longer lists. Nothing will drain it.
        const owed = Object.entries(pending.offsets ?? {})
          .filter(([, v]) => f.size - v > 0)
          .map(([k, v]) => `${k} at ${v}/${f.size}`)
          .join(", ");
        logStuck(
          f.path,
          // Not the offsets: they move as other destinations advance, which
          // would re-emit this line without the condition having changed.
          "no-plan",
          `owes bytes but the gateway planned no upload for it — ${owed || "no destinations recorded"}. The destination may no longer exist.`,
          log,
        );
      }
      if (pending?.consecutiveFailures !== undefined || pending?.nextAttemptAtMs !== undefined) {
        await clearFileFailure(f.path, scope);
      }
    } catch (err) {
      failed += 1;
      log(`  [error] ${f.path}: ${(err as Error).message}`);
      if (err instanceof SessionUpstreamUnavailable) {
        // THIS session's store is temporarily unavailable; the shared gateway is
        // fine. Skip just this file — short retries first, then a longer backoff
        // (recordFileFailure doubles per failure) — and record the reason so
        // `hx status` can show it. Everything else keeps uploading.
        if (err.blocker) void rememberOrgNames(err.blocker.destinations);
        const delay = await recordFileFailure(
          f.path,
          SESSION_SKIP_RETRY_BASE_MS,
          scope,
          err.reason,
          err.blocker,
        );
        log(`  [hx] ${describeSkip(err.reason)}; retrying ${path.basename(f.path)} in ${Math.round(delay / 1000)}s`);
        return;
      }
      if (err instanceof HxHttpError && err.sessionDeleted) {
        // Permanent server-side delete (410 tombstone): record the terminal
        // stop-flag instead of any backoff — this session never uploads again
        // from this device. The local file is the user's own and stays.
        const entry = state.files[f.path];
        if (entry) {
          await recordDeletedSession(entry.family, entry.sessionId, scope);
          await clearFileFailure(f.path, scope);
          log(
            `  [hx] ${entry.sessionId.slice(0, 8)}… permanently deleted on the server — uploads stopped (local file kept)`,
          );
        }
        return;
      }
      if (err instanceof HxHttpError && err.serverUnavailable) {
        // A wholesale gateway outage and a per-session 5xx this client does not
        // yet recognize look identical from a single file. Only a SECOND
        // distinct file failing the same way proves the gateway; until then,
        // give this one file a short backoff and keep the pass alive — one
        // unrecognized poison file must never zero the device's throughput
        // (the vault_home_unreachable incident, 2026-07-30). On a real outage
        // the first file pays one short undeserved backoff; the pass-level
        // exponential backoff in run() still handles the outage itself.
        gatewayUnavailableFiles.add(f.path);
        if (gatewayUnavailableFiles.size >= 2) {
          // The check-log-latch runs with no await between, so exactly ONE
          // worker crosses the threshold un-latched — the pause line prints
          // once per pass, as the sequential loop's `break` did.
          if (!stopPass) {
            stopPass = true;
            log(
              `  [hx] gateway unavailable (${err.status}) on ${gatewayUnavailableFiles.size} files; pausing this pass`,
            );
          }
          return;
        }
        // Fixed bench, NOT recordFileFailure: the probe is not this file's
        // fault, so it must not accrue a compounding (and restart-surviving)
        // failure streak — on a real outage with one pending file that would
        // quietly replace the 5-min pass backoff with a 30-min bench.
        await benchFileProbe(f.path, FILE_RETRY_BASE_MS, scope);
        log(`  [hx] 5xx (${err.status}) on one file; probing another before pausing the pass`);
        return;
      }
      // A genuine per-file fault (4xx, parse error, a doomed sidecar): back it
      // off so it doesn't burn a gateway round trip every poll.
      await recordFileFailure(f.path, FILE_RETRY_BASE_MS, scope);
    }
  };
  // M1 in force for the caught-up multitude: a clean, fully-uploaded file's
  // change detection lives with the catalog's tiered stats (its size/mtime
  // here are tier-fresh by contract), so the pass pools only files with
  // something to do — owed bytes, a shrink (heal), a moved mtime (touch
  // bookkeeping), a hold/backoff, or the attribution-gate probe. Without
  // this gate the pass re-statted every watched file every tick (10k
  // stats/tick measured) — the exact per-tick sweep C1 removed, resurrected
  // inside the pass. The legacy sweep (tuning.sweep="legacy") passes
  // everything, preserving the base's stat-per-file behavior byte-for-byte.
  const pooled = !catalog
    ? files
    : files.filter((f) => {
        const fs = state.files[f.path];
        if (!fs) return true;
        if (fs.skipReason) return true;
        // PRESENCE of failure bookkeeping, not just an active window: an
        // EXPIRED backoff on a caught-up file must still pool once so the
        // post-ingest clearFileFailure fires — otherwise the stale streak
        // survives and escalates the NEXT unrelated failure's backoff
        // (active backoffs keep their per-tick stuck-log exactly as before).
        if (fs.consecutiveFailures !== undefined || fs.nextAttemptAtMs !== undefined) return true;
        // Legacy pre-cwd state entries get their one-time re-seed (the base
        // paid it on its first pass) so folder/rule exclusions can match.
        if (fs.cwd === undefined) return true;
        if (!settings.personalSync && fs.attributed === undefined) return true;
        if (f.size !== minOffset(fs)) return true;
        if (fs.lastMtimeMs !== f.mtimeMs) return true;
        return false;
      });
  let lastProgressAtMs = Date.now();
  await runPool(
    pooled,
    fileConcurrency,
    async (f) => {
      await processParent(f);
      if (onProgress && Date.now() - lastProgressAtMs >= SYNC_PROGRESS_MIN_MS) {
        lastProgressAtMs = Date.now();
        onProgress(snapshotFrom(files, state));
      }
    },
    () => stopPass,
  );

  // Child lanes + workflow sidecars (Claude only; Codex has no equivalent).
  // Runs after the parent pass so a brand-new session's parent commit lands
  // first — that row is what the gateway resolves child vault routing from.
  // Children are excluded from the sync snapshot on purpose: the Devices bar
  // counts sessions, and a child stream is part of its session, not a new one.
  if (!opts.only && Date.now() >= (childEndpointsMissingUntilMs.get(scope) ?? 0)) {
    const parentByArtifactSession = buildChildParentIndex(state);
    try {
      const { children, runs } = catalog
        ? catalog.listChildren()
        : await discoverClaudeChildren(roots.claude);
      const electedChildren = electChildUploaders(children, log);
      const lanePlan = planChildLaneResets(
        electedChildren,
        state.childUploaders ?? {},
        contestedChildLanes(children),
      );
      if (lanePlan.changed) {
        for (const p of lanePlan.resetPaths) {
          const fs = state.files[p];
          if (fs) {
            if (Object.keys(fs.offsets).length > 0) {
              fs.offsets = {};
              log(`[hx] child lane uploader switched — re-uploading ${path.basename(p)} from zero`);
            }
            // A takeover starts clean: inherited backoff belonged to the
            // lane's previous stint and would bench the live file for up to
            // 30 minutes (same rationale as reconcileChildParent's repair).
            delete fs.consecutiveFailures;
            delete fs.nextAttemptAtMs;
            delete fs.skipReason;
          }
        }
        state.childUploaders = lanePlan.nextMap;
        await persistState(scope);
      }
      let stopChildren = false;
      const processChild = async (c: DiscoveredChildFile): Promise<void> => {
        let pendingChild = state.files[c.path];
        if (pendingChild) {
          const reconciled = reconcileChildParent(
            pendingChild,
            parentByArtifactSession.get(c.parentSessionId),
          );
          if (reconciled !== pendingChild) {
            pendingChild = reconciled;
            await upsertFileState(reconciled, scope);
          }
        }
        if (pendingChild?.nextAttemptAtMs && pendingChild.nextAttemptAtMs > Date.now()) return;
        // A deleted parent blocks every child lane (the stop-flag matches the
        // bare sessionId, so a stale child family can't slip past it either).
        if (
          isDeletedSession(state, pendingChild?.family ?? "", pendingChild?.sessionId ?? c.parentSessionId)
        ) {
          return;
        }
        try {
          const did = await ingestChildOne(cfg, c, parentByArtifactSession, opts, log);
          if (did) uploaded += 1;
          if (
            pendingChild?.consecutiveFailures !== undefined ||
            pendingChild?.nextAttemptAtMs !== undefined
          ) {
            await clearFileFailure(c.path, scope);
          }
        } catch (err) {
          failed += 1;
          log(`  [error] ${c.path}: ${(err as Error).message}`);
          const action = classifyChildFailure(err);
          if (action.kind === "session-deleted") {
            // Parent session permanently deleted server-side — terminal for
            // every lane; record the session stop-flag and stop retrying.
            const family = pendingChild?.family ?? "claude-cli";
            await recordDeletedSession(family, pendingChild?.sessionId ?? c.parentSessionId, scope);
            await clearFileFailure(c.path, scope);
            return;
          }
          if (action.kind === "hold") {
            // An offline vault, or a routing decision the gateway has not made.
            // Either way it is not this file's fault: skip just this child with
            // the same short-retries-then-backoff pacing as its parent, and
            // stamp the reason so it is visible and releasable.
            await recordFileFailure(
              c.path,
              SESSION_SKIP_RETRY_BASE_MS,
              scope,
              action.reason,
              action.blocker,
            );
            return;
          }
          // A wholesale lane pause (404/401/403) or gateway-wide outage is not
          // this child's fault — don't give it a per-file backoff that would
          // make it lag once the gateway recovers. Stop DEQUEUEING; in-flight
          // children settle (M4's child half: ≤ concurrency−1 extra POSTs).
          if (latchChildLanePause(err, scope, log)) {
            stopChildren = true;
            return;
          }
          if (action.kind === "stop") {
            stopChildren = true;
            return;
          }
          await recordFileFailure(c.path, FILE_RETRY_BASE_MS, scope);
        }
      };
      await runPool(electedChildren, childConcurrency, processChild, () => stopChildren);
      for (const r of runs) {
        try {
          await syncWorkflowRun(cfg, r, parentByArtifactSession, log);
        } catch (err) {
          if (latchChildLanePause(err, scope, log)) break;
          log(`  [error] workflow ${r.runId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log(`[hx] child discovery error: ${(err as Error).message}`);
    }
  }

  // Flush point: end of every pass. Coalesced-mode bookkeeping (mtime
  // touches, registry updates, backoff stamps, artifact hashes) becomes
  // durable here; a no-op in flush-through mode (`hx tick`, `--once`, and
  // every non-daemon caller — nothing ever marks dirty there).
  await flushStateIfDirty(scope);
  const snapshot = snapshotFrom(files, state);
  onProgress?.(snapshot);
  return { uploaded, failed, snapshot };
}

/** Hourly perf-summary counters (see formatPerfLine / the perfTimer). */
export interface PerfCounters {
  passes: number;
  passMs: number[];
  uploads: number;
  flushes: number;
}

/** The hourly `[hx] perf:` info line. Pure so the classifier golden can pin
 *  it: the token format must never match the UI log classifier's warn/up
 *  patterns (no "failed=", no "error", no "(+…B" — classifyLogLine in
 *  ui/data.ts), or a healthy hourly summary would render as a warning. */
export function formatPerfLine(perf: PerfCounters): string {
  const sorted = [...perf.passMs].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : 0;
  return `[hx] perf: passes=${perf.passes} passMs p50=${at(0.5)} p95=${at(0.95)} max=${Math.round(sorted[sorted.length - 1] ?? 0)} uploads=${perf.uploads} stateFlushes=${perf.flushes}`;
}

export async function startWatch(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<{ stop: () => void }> {
  const describeRoots = (r: ResolvedRoots): string =>
    [...r.claude, ...r.codex]
      .map((d) => `${collapseHome(d.configDir)}${d.origin === "default" ? "" : ` [${d.origin}]`}`)
      .join(", ");
  log(`[hx] watching data roots: ${describeRoots(resolveDataRoots(await readSettings()))}`);
  log(`[hx] poll interval ${FAST_POLL_MS}ms; gateway ${cfg.gatewayBaseUrl}`);
  void trimActivity(); // cap the UI journal once per daemon lifetime
  // stdout.log/stderr.log are DEVICE-global, but startWatch runs once per lane
  // (cli.ts starts main and the `--local` tee concurrently under Promise.all).
  // Two lanes racing here both pass the size check, then one truncates while
  // the other is copying. Same gate the roots stamper uses twelve lines up.
  //
  // This does NOT distinguish a foreground `hx watch` from the installed
  // service — they run the same command, so nothing in `opts` can. That case is
  // handled where it actually can be: rotateLogsIfLarge stages the copy and
  // renames it into place, so `.1` is a complete copy whichever process wins.
  const ownsDeviceLogs = !opts.oneShot && scopeOf(cfg) === "main";
  // A daemon that has been down for a while may be starting behind an already
  // oversized log; do not wait an hour to bound it.
  if (ownsDeviceLogs) {
    for (const target of await rotateLogsIfLarge()) {
      log(`[hx] rotated ${path.basename(target)} on start; previous generation kept at ${target}.1`);
    }
  }

  // Coalesced state persistence is a LONG-RUNNING-LOOP privilege: this loop
  // owns flush points (end of pass, the timer below, flush-through commits).
  // One-shot runs have none, so they keep flush-through mode untouched.
  if (!opts.oneShot) armCoalescedPersistence(scopeOf(cfg));

  // A restart is a human signalling "conditions changed" — serving out stale
  // exponential penalties helps nobody. After the 2026-08-01 credential
  // outage, 803 files sat pinned at the 30-minute backoff cap for a fault
  // that was already fixed. Generic backoffs only: a skipReason hold means
  // the gateway said the store is DOWN, and that is still true until it says
  // otherwise (`hx retry --blocked` / `--all` release those deliberately).
  try {
    const stranded = await pruneStrandedOffsets(scopeOf(cfg));
    if (stranded.keys > 0) {
      log(
        `[hx] dropped ${stranded.keys} offset key${stranded.keys === 1 ? "" : "s"} for unknown destinations across ${stranded.files} session${stranded.files === 1 ? "" : "s"} no longer on disk`,
      );
    }
    const dropped = await clearGenericBackoffs(scopeOf(cfg));
    if (dropped > 0) {
      log(`[hx] cleared ${dropped} stale retry backoff${dropped === 1 ? "" : "s"} on start`);
    }
  } catch {
    // Best-effort: an unreadable state file surfaces through the normal pass.
  }

  // Publish the resolved roots as device truth (state.effectiveRoots) so the
  // UI server and doctor describe what THIS long-running loop watches. Gated
  // to the main lane's persistent daemon: `hx tick` / `watch --once` / the
  // --local tee run with an arbitrary shell env and must not overwrite it.
  // The latch advances only after the persist SUCCEEDS (an unwritable
  // ~/.let/hx must retry next tick, not go silent for the daemon's lifetime),
  // and the stamp refreshes on an interval even when unchanged, so a stomp by
  // a stray foreground `hx watch` from an env-carrying shell heals itself.
  const RESTAMP_INTERVAL_MS = 10 * 60_000;
  let lastRootsSig = "";
  let lastStampAtMs = 0;
  let stampFailureLogged = false;
  const publishRoots = async (settings: HxSettings): Promise<void> => {
    if (opts.oneShot || scopeOf(cfg) !== "main") return;
    const roots = resolveDataRoots(settings);
    const sig = rootsSignature(roots);
    if (sig === lastRootsSig && Date.now() - lastStampAtMs < RESTAMP_INTERVAL_MS) return;
    const changed = lastRootsSig !== "" && sig !== lastRootsSig;
    try {
      await stampEffectiveRoots(roots);
      lastRootsSig = sig;
      lastStampAtMs = Date.now();
      stampFailureLogged = false;
      if (changed) log(`[hx] watch roots updated: ${describeRoots(roots)}`);
    } catch (err) {
      // Retries every tick (the latch didn't advance) — log the streak once,
      // not 57k times a day into stdout.log.
      if (!stampFailureLogged) {
        stampFailureLogged = true;
        log(`[hx] couldn't persist watch roots (will keep retrying): ${(err as Error).message}`);
      }
    }
  };

  // Last time anything reached the gateway (upload or beat). Uploads count as
  // contact, so a busy daemon never sends a redundant heartbeat.
  let lastContactMs = 0;

  // Upload backoff: when a pass makes zero progress and hits errors (the gateway
  // is refusing uploads), skip upload passes until `pauseUploadsUntilMs`, growing
  // the window exponentially. Any pass that isn't a stalled-with-errors one
  // resets it back to the normal FAST_POLL_MS cadence.
  let uploadBackoffMs = 0;
  let pauseUploadsUntilMs = 0;

  // Catch-up progress reporting. We POST a snapshot only when the picture
  // changed since the last one we sent, throttled to SYNC_REPORT_MIN_MS — except
  // a terminal "caught up" snapshot, which always goes through so the bar
  // resolves to done. A successful report also counts as contact (it carries a
  // bearer token), so it refreshes liveness like an upload.
  let lastSyncSig = "";
  let lastSyncSentMs = 0;
  const reportSync = (snap: SyncSnapshot): void => {
    const sig = `${snap.done}/${snap.total}/${snap.totalBytes}`;
    if (sig === lastSyncSig) return;
    const caughtUp = snap.total > 0 && snap.done >= snap.total;
    const nowMs = Date.now();
    if (!caughtUp && nowMs - lastSyncSentMs < SYNC_REPORT_MIN_MS) return;
    lastSyncSig = sig;
    lastSyncSentMs = nowMs;
    void sendSyncStatus(cfg, snap)
      .then(() => {
        lastContactMs = Date.now();
      })
      .catch((err) => log(`[hx] sync-status error: ${(err as Error).message}`));
  };

  // One pass at a time: upload ticks and the canonical audit both walk the
  // offset state, and an audit overlapping a live pass would read a chunk in
  // flight as divergence. A skipped tick is re-covered 1.5s later; a skipped
  // audit by its next interval.
  let passBusy = false;

  // Perf self-observability: per-pass duration + activity counters, folded
  // into ONE hourly info line (formatPerfLine — classifier-safe by test).
  const PERF_LOG_MS = 60 * 60_000;
  const perf: PerfCounters = { passes: 0, passMs: [], uploads: 0, flushes: 0 };

  // User-driven pause (settings.json, written by the UI server or a future
  // CLI). Checked every tick so a pause/resume takes effect within one poll.
  // Heartbeats keep running while paused — the device reads "online, paused",
  // not vanished. Log only the transitions, not every skipped tick.
  let wasPaused = false;

  const run = async () => {
    if (passBusy) return;
    // Take the mutex around EVERYTHING that awaits, the stamp included: it
    // persists state.json, and an audit firing inside that await would see
    // passBusy false, start, and then overlap the pass we're about to run —
    // exactly the in-flight-chunk-reads-as-divergence race the flag prevents.
    passBusy = true;
    // Every tick observes the filesystem's root set FRESH, by construction —
    // an off-slot timer (mirror, audit) must not leave the sub-tick roots
    // memo warm across a tick boundary and delay a root-set change past the
    // one-poll visibility the base gave it.
    invalidateRootsMemo();
    const passStartMs = Date.now();
    try {
      const settings = await readSettings();
      // Stamping is observation, not an upload: it must track Watched
      // Locations edits even while sync is paused or uploads are backing
      // off, or the UI's roots list (and hx status) silently freezes in
      // exactly those states.
      await publishRoots(settings);
      if (Date.now() < pauseUploadsUntilMs) return;
      if (isPaused(settings)) {
        if (!wasPaused) {
          wasPaused = true;
          const until = settings.pause?.untilMs;
          log(`[hx] sync paused${until ? ` until ${new Date(until).toLocaleTimeString()}` : " until resumed"}`);
        }
        return;
      }
      if (wasPaused) {
        wasPaused = false;
        log(`[hx] sync resumed`);
      }
      const { uploaded, failed } = await tickOnce(cfg, opts, log, reportSync);
      perf.uploads += uploaded;
      if (uploaded || failed) {
        if (uploaded) lastContactMs = Date.now();
        log(`[hx] tick uploaded=${uploaded} failed=${failed}`);
      }
      if (uploaded === 0 && failed > 0) {
        uploadBackoffMs = uploadBackoffMs
          ? Math.min(UPLOAD_BACKOFF_MAX_MS, uploadBackoffMs * 2)
          : UPLOAD_BACKOFF_BASE_MS;
        pauseUploadsUntilMs = Date.now() + uploadBackoffMs;
        log(`[hx] uploads not progressing; backing off ${Math.round(uploadBackoffMs / 1000)}s`);
      } else if (uploadBackoffMs > 0) {
        uploadBackoffMs = 0;
        pauseUploadsUntilMs = 0;
        log(`[hx] uploads recovered; resuming normal cadence`);
      }
    } catch (err) {
      log(`[hx] tick error: ${(err as Error).message}`);
    } finally {
      perf.passes += 1;
      perf.passMs.push(Date.now() - passStartMs);
      passBusy = false;
    }
  };

  const beat = async () => {
    if (Date.now() - lastContactMs < HEARTBEAT_MS) return;
    try {
      await sendHeartbeat(cfg);
      lastContactMs = Date.now();
    } catch (err) {
      log(`[hx] heartbeat error: ${(err as Error).message}`);
    }
  };

  // Audit before the first pass so diverged sessions re-upload during the
  // initial catch-up instead of waiting half an hour. Best-effort: a gateway
  // that's down (or predates verify) must not stall the watcher.
  const audit = async (): Promise<void> => {
    if (passBusy) return; // a pass is mid-flight; the next interval retries
    passBusy = true;
    try {
      await auditCanonicals(cfg, opts, log);
    } catch (err) {
      log(`[hx] canonical audit error: ${(err as Error).message}`);
    } finally {
      passBusy = false;
    }
  };
  await audit();
  await run();
  await beat(); // announce liveness immediately so a fresh daemon reads "live"
  await syncGroupMirror(cfg, log); // push CCD's grouping on start
  await syncTeamMirror(cfg, log); // push active agent teams on start
  // One-shot attribution sweep — no-ops when every known file already carries
  // the current DETECTION_VERSION stamp, so a routine restart costs nothing.
  // Best-effort: a gateway that predates /sessions/reattribute (or is down)
  // just leaves the stamps unwritten and the next start retries.
  try {
    await runReattributeSweep(cfg, scopeOf(cfg), log);
  } catch (err) {
    log(`[hx] attribution sweep error: ${(err as Error).message}`);
  }
  if (opts.oneShot) return { stop: () => {} };
  const timer = setInterval(() => void run(), FAST_POLL_MS);
  const hbTimer = setInterval(() => void beat(), HEARTBEAT_MS);
  const mirrorTimer = setInterval(() => {
    void syncGroupMirror(cfg, log);
    void syncTeamMirror(cfg, log);
  }, MIRROR_SYNC_MS);
  const auditTimer = setInterval(() => void audit(), VERIFY_INTERVAL_MS);
  // Coalesced-persistence safety net: bounds how long dirty bookkeeping can
  // sit unflushed between passes (M2's ≤5 s), and the only flush that covers
  // a hard kill landing between pass-end flushes.
  const STATE_FLUSH_MS = 5_000;
  const scope = scopeOf(cfg);
  let flushFailureLogged = false;
  const flushTimer = setInterval(() => {
    if (!hasDirtyState(scope)) return;
    perf.flushes += 1;
    // A rejected flush must never become an unhandled rejection (Bun exits
    // the process on those). flushStateIfDirty re-marked the scope dirty, so
    // this same timer retries; log the streak once, not every 5 s.
    flushStateIfDirty(scope).then(
      () => {
        flushFailureLogged = false;
      },
      (err) => {
        if (!flushFailureLogged) {
          flushFailureLogged = true;
          // Same shape as the existing failure lines (heartbeat error:, tick
          // error:) — classifies warn in the UI, as a real failure should.
          log(`[hx] state flush error: ${(err as Error).message} (will keep retrying)`);
        }
      },
    );
  }, STATE_FLUSH_MS);
  const perfTimer = setInterval(() => {
    // Same cadence as the perf line: an hourly check bounds a log that took
    // months to reach 242 MB, without a stat on every 1.5s pass.
    if (ownsDeviceLogs) {
      void rotateLogsIfLarge().then((rotated) => {
        for (const target of rotated) {
          log(`[hx] rotated ${path.basename(target)}; previous generation kept at ${target}.1`);
        }
      });
    }
    if (perf.passes === 0) return;
    log(formatPerfLine(perf));
    perf.passes = 0;
    perf.passMs.length = 0;
    perf.uploads = 0;
    perf.flushes = 0;
  }, PERF_LOG_MS);
  return {
    stop: () => {
      clearInterval(timer);
      clearInterval(hbTimer);
      clearInterval(mirrorTimer);
      clearInterval(auditTimer);
      clearInterval(flushTimer);
      clearInterval(perfTimer);
      // Best-effort parting flush, then back to flush-through mode. Swallow —
      // a rejection here would be unhandled, and stop() has no retry loop.
      flushStateIfDirty(scope).catch(() => {});
      disarmCoalescedPersistence(scope);
    },
  };
}
