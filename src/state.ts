// ~/.let/hx/state.json holds per-file upload offsets.
//
// On every successful chunk-commit we bump the offset for that file. On
// startup we restore offsets and skip already-uploaded bytes. A JSON file
// (atomic write via rename) is the right primitive — no native deps, no
// concurrent writers (a single hx process owns it).
//
// State is scoped per upload lane: the regular gateway's offsets live in
// state.json, while the `--local` tee lane (the same files, mirrored to the
// local dev gateway in addition) keeps its own in state.local.json. Each
// gateway has its own "how many bytes of this file do you already hold"
// truth, so the lanes must never share offsets or artifact hashes.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { HX_DIR } from "./hx-home.js";
import type { ResolvedRoots } from "./roots.js";

/** Which upload lane's state to read/write: "main" = the configured gateway,
 *  "local" = the additive `--local` tee against the local dev gateway. */
export type StateScope = "main" | "local";

/** Why a file is being skipped this pass. Both mean "the destination store is
 *  temporarily unavailable, not this file's fault": `vault_offline` = the
 *  gateway reported the session's vault down (503 vault_offline); `store_unreachable`
 *  = a store this session routes to directly answered with a 5xx or couldn't be
 *  reached at all. Surfaced by `hx status` so a stuck session shows a reason. */
export type FileSkipReason = "vault_offline" | "vault_home_unreachable" | "store_unreachable";

/** Non-sensitive routing context returned by the gateway for a held upload. */
export interface SyncBlockerDestination {
  vaultOrgId: string;
  reason: "vault_offline" | "vault_home_unreachable";
  /** Optional for compatibility with gateways that predate rich blockers. */
  orgName?: string | null;
  orgSlug?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
  repoSlug?: string | null;
  /** Gateway-observed Fortress heartbeat, not transcript activity. */
  lastSeenAt?: string | null;
}

/** Structured explanation attached to an unavailable-session error. */
export interface SyncBlockerDetails {
  reason: FileSkipReason;
  destinations: SyncBlockerDestination[];
}

/** The blocker persisted beside an upload offset for offline diagnostics. */
export interface PersistedSyncBlocker extends SyncBlockerDetails {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export interface FileState {
  /** Absolute jsonl path on disk. */
  path: string;
  /** Family classification (claude-desktop/claude-cli/codex-desktop/codex-cli/unknown). */
  family: string;
  /** The session id we extracted from the jsonl (used as the GCS key prefix). */
  sessionId: string;
  /** Byte offset already uploaded, PER destination store. Key = vaultOrgId, or
   *  "letai" for the let.ai shared bucket (null orgId). A session whose repo is
   *  attached to several orgs fans out to several stores, each advancing
   *  independently. */
  offsets: Record<string, number>;
  /** ~-collapsed working directory of the session, from its head. Undefined on
   *  legacy entries until the watch loop re-seeds them; the settings filters
   *  (folder exclusions, personal gate) treat unknown as "keep uploading". */
  cwd?: string;
  /** Canonical owner/name repo slug from the session head; null = the folder
   *  has no (GitHub) repo; undefined = not yet recorded (legacy entry). */
  repoSlug?: string | null;
  /** Whether the repo auto-attributes to any org workspace, per the gateway's
   *  route discovery. undefined = unknown (no repo, never resolved, or an
   *  older gateway that doesn't echo it) — treated as work by the personal
   *  gate, never silently skipped. */
  attributed?: boolean;
  /** Last mtime we observed (ms). Skip the file if mtime hasn't moved. */
  lastMtimeMs: number;
  /** Last upload attempt timestamp (ms). For logging/inspection. */
  lastUploadAtMs: number;
  /** Size (bytes) the file had when we last saw it on disk. Lets `hx status`
   *  report sessions whose source vanished (or aged out of the scan window)
   *  before their upload finished — the server copy stays partial forever, and
   *  without this record the status would silently claim 100%. */
  lastKnownSize?: number;
  /** Consecutive canonical self-heals (from-zero re-uploads) without a clean
   *  commit in between. A mismatch that heals and immediately re-diverges is
   *  ping-ponging (e.g. two writers on one canonical) — after a few rounds the
   *  heal pauses instead of re-uploading the whole file forever. */
  healCount?: number;
  /** Self-heal is paused for this file until this timestamp (ms). */
  healPausedUntilMs?: number;
  /** Consecutive failed upload attempts (cleared by any clean pass). Drives a
   *  per-file retry backoff so one permanently-broken file can't burn a
   *  gateway round trip every poll while everything else is healthy. */
  consecutiveFailures?: number;
  /** Do not retry this file before this timestamp (ms since epoch). */
  nextAttemptAtMs?: number;
  /** Set while the file is being skipped because its destination store is
   *  temporarily unavailable (a transient outage, not a fault of this file).
   *  Drives the `hx status` "waiting" row; cleared by any clean pass. */
  skipReason?: FileSkipReason;
  /** Compact operational context only: no transcript content, paths, tokens,
   *  signed URLs, or credentials are ever stored here. */
  blocker?: PersistedSyncBlocker;
  /** DETECTION_VERSION stamp of the last attribution sweep that covered this
   *  file (reattribute.ts). Absent/lower ⇒ the next sweep re-reports it. The
   *  cwd/repoSlug fields above double as the sweep's FIRST-SIGHT cache: they
   *  were captured while the workdir still existed, so they always win over a
   *  later re-walk (a REUSED scratch path can resolve to the wrong repo). */
  attributionVersion?: number;
}

/** On-disk shape before per-destination fan-out carried a single `offset`. The
 *  optional recovery/skip fields may already be present on a non-legacy entry
 *  being re-normalised; they carry through {@link migrateFileState} untouched. */
export interface LegacyFileState {
  path: string;
  family: string;
  sessionId: string;
  offset?: number;
  offsets?: Record<string, number>;
  lastMtimeMs: number;
  lastUploadAtMs: number;
  repoSlug?: string | null;
  cwd?: string;
  attributionVersion?: number;
  lastKnownSize?: number;
  consecutiveFailures?: number;
  nextAttemptAtMs?: number;
  skipReason?: FileSkipReason;
  blocker?: PersistedSyncBlocker;
  healCount?: number;
  healPausedUntilMs?: number;
}

/** Stable per-destination state key. null (let.ai shared bucket) → "letai". */
export function destKey(vaultOrgId: string | null): string {
  return vaultOrgId ?? "letai";
}

/** Bytes already committed to one destination (0 if never written there). */
export function offsetFor(s: FileState, vaultOrgId: string | null): number {
  return s.offsets[destKey(vaultOrgId)] ?? 0;
}

/** Lowest committed offset across all known destinations (0 if none yet). The
 *  "has the file grown past everything we've sent?" skip check uses this so a
 *  destination still behind the others keeps getting bytes. */
export function minOffset(s: FileState): number {
  const vals = Object.values(s.offsets);
  return vals.length === 0 ? 0 : Math.min(...vals);
}

/** Upgrade a possibly-legacy persisted entry to the per-destination shape. A
 *  legacy single offset becomes the let.ai destination's offset; any other
 *  destination is implicitly 0 and re-uploads from zero (replace) on next pass. */
export function migrateFileState(s: LegacyFileState): FileState {
  const offsets = s.offsets ?? (typeof s.offset === "number" ? { letai: s.offset } : {});
  return {
    path: s.path,
    family: s.family,
    sessionId: s.sessionId,
    offsets,
    lastMtimeMs: s.lastMtimeMs,
    lastUploadAtMs: s.lastUploadAtMs,
    // Attribution capture fields ride through untouched — this migration runs
    // over EVERY entry at load, so dropping them would erase the first-sight
    // cache and re-trigger the sweep on every restart.
    ...(s.repoSlug !== undefined ? { repoSlug: s.repoSlug } : {}),
    ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    ...(s.attributionVersion !== undefined ? { attributionVersion: s.attributionVersion } : {}),
    lastKnownSize: s.lastKnownSize,
    consecutiveFailures: s.consecutiveFailures,
    nextAttemptAtMs: s.nextAttemptAtMs,
    skipReason: s.skipReason,
    blocker: s.blocker,
    healCount: s.healCount,
    healPausedUntilMs: s.healPausedUntilMs,
  };
}

/** The daemon's resolved watch roots + when it resolved them. */
export interface EffectiveRootsStamp extends ResolvedRoots {
  resolvedAtMs: number;
}

/**
 * What we durably know about ONE fan-out destination, keyed by {@link destKey}.
 *
 * A file's `skipReason` and `blocker` are latches — clearFileFailure drops both
 * on any clean pass — so a destination that flaps (refused, cleared, refused)
 * is invisible to anything sampling them at a single instant. Measured on a
 * real device: 29 sessions were refused by offline Fortresses over one day
 * while `hx status` could name 9, and one Fortress holding 165 MB across 16
 * sessions appeared in no output at all.
 *
 * This record is NOT cleared by a clean pass. It carries the gateway's latest
 * word on each destination so the per-destination offsets (which say a store
 * is behind) can be paired with who that store is and whether it is reachable.
 */
export interface DestinationRecord {
  /** null for the let.ai-hosted shared bucket (stored under key "letai"). */
  vaultOrgId: string | null;
  /** The gateway's most recent word on this destination. */
  status: "ready" | "held";
  /** Retained across status changes so a destination stays nameable after it
   *  recovers and goes away again. */
  orgName?: string | null;
  orgSlug?: string | null;
  /** Gateway-observed Fortress heartbeat, not transcript activity. */
  lastSeenAt?: string | null;
  /** When it first went held with no intervening ready — drives "offline 13d". */
  heldSinceMs?: number;
  /** When the gateway last told us anything about it. */
  observedAtMs: number;
  /** Consecutive hard upload failures against this destination (a signed PUT
   *  or commit rejected — 403/401/400, not an outage). Cleared by any
   *  successful commit to it. A destination that is REACHABLE but rejecting
   *  every write is otherwise indistinguishable from a slow backlog — that
   *  exact shape hid a 12-hour credential outage behind a silent "0%". */
  consecutiveErrors?: number;
  /** Short label of the most recent hard failure, e.g. "403 SignatureDoesNotMatch". */
  lastErrorCode?: string;
  /** When the most recent hard failure was observed (ms). */
  lastErrorAtMs?: number;
  /** When the CURRENT unbroken run of failures began (ms) — "failing for 2h". */
  failingSinceMs?: number;
}

/** Fold one hard upload failure into the registry. Pure for tests. */
export function applyDestinationUploadError(
  state: HxState,
  key: string,
  code: string,
  nowMs: number,
): void {
  const registry = (state.destinations ??= {});
  const prev = registry[key];
  const record: DestinationRecord = prev ?? {
    // First sighting can precede any gateway destination report (legacy
    // single-destination responses) — seed a minimal ready record.
    vaultOrgId: key === destKey(null) ? null : key,
    status: "ready",
    observedAtMs: nowMs,
  };
  record.consecutiveErrors = (record.consecutiveErrors ?? 0) + 1;
  record.lastErrorCode = code;
  record.lastErrorAtMs = nowMs;
  record.failingSinceMs = record.failingSinceMs ?? nowMs;
  registry[key] = record;
}

/** A successful commit to the destination ends the failure run. Pure. */
export function applyDestinationUploadSuccess(state: HxState, key: string): boolean {
  const record = state.destinations?.[key];
  if (!record || record.consecutiveErrors === undefined) return false;
  delete record.consecutiveErrors;
  delete record.lastErrorCode;
  delete record.lastErrorAtMs;
  delete record.failingSinceMs;
  return true;
}

/** Persisted wrappers around the pure fold/clear above. */
export async function recordDestinationUploadError(
  key: string,
  code: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  applyDestinationUploadError(state, key, code, Date.now());
  await schedulePersist(state, scope);
}

export async function clearDestinationUploadError(
  key: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (applyDestinationUploadSuccess(state, key)) await schedulePersist(state, scope);
}

/** One destination as the gateway just described it, narrowed to what we keep. */
export interface DestinationReport {
  vaultOrgId: string | null;
  status: "ready" | "held";
  orgName?: string | null;
  orgSlug?: string | null;
  lastSeenAt?: string | null;
}

/** Fold the gateway's current destination set into the durable registry.
 *  Pure so the ready→held→ready transitions are directly testable. */
export function applyDestinationReports(
  state: HxState,
  reports: DestinationReport[],
  nowMs: number,
): boolean {
  if (reports.length === 0) return false;
  const registry = (state.destinations ??= {});
  let changed = false;
  for (const r of reports) {
    const key = destKey(r.vaultOrgId);
    const prev = registry[key];
    const next: DestinationRecord = {
      vaultOrgId: r.vaultOrgId,
      status: r.status,
      // Never overwrite a known label with a blank one: ready destinations
      // arrive without names, and forgetting the name on recovery would leave
      // the next outage showing a bare org id.
      orgName: r.orgName ?? prev?.orgName ?? null,
      orgSlug: r.orgSlug ?? prev?.orgSlug ?? null,
      lastSeenAt: r.lastSeenAt ?? prev?.lastSeenAt ?? null,
      // A ready observation ends the outage; a held one keeps the ORIGINAL
      // start so "offline 22d" measures the whole outage, not the last retry.
      heldSinceMs:
        r.status === "held" ? (prev?.status === "held" ? prev.heldSinceMs : nowMs) : undefined,
      observedAtMs: nowMs,
    };
    if (
      prev?.status === next.status &&
      prev.orgName === next.orgName &&
      prev.orgSlug === next.orgSlug &&
      prev.lastSeenAt === next.lastSeenAt &&
      prev.heldSinceMs === next.heldSinceMs
    ) {
      // Same facts — refresh the observation stamp without a disk write.
      prev.observedAtMs = nowMs;
      continue;
    }
    registry[key] = next;
    changed = true;
  }
  return changed;
}

/** Persist the gateway's current word on this session's fan-out destinations. */
export async function recordDestinations(
  reports: DestinationReport[],
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (applyDestinationReports(state, reports, Date.now())) {
    await schedulePersist(state, scope);
  }
}

export interface HxState {
  files: Record<string, FileState>;
  /** Durable per-destination facts, keyed by {@link destKey}. See
   *  {@link DestinationRecord} — this is what survives the skipReason latch. */
  destinations?: Record<string, DestinationRecord>;
  /** Content-hash per uploaded sidecar artifact (key `<family>:<sessionId>:<kind>`)
   *  so tasks/plans only re-upload when their content actually changes. */
  artifacts?: Record<string, string>;
  /** Sessions the SERVER permanently deleted (410 session_deleted / verify
   *  status "deleted"), keyed `<family>:<sessionId>` → epoch-ms recorded.
   *  Session-keyed (not per-file) on purpose: one session can have twin files,
   *  and file entries are re-seeded on discovery — a per-file flag would miss
   *  both. A tombstoned session never uploads again from this device: chunks,
   *  child lanes, sidecars and the verify audit all consult this map. Entries
   *  are pruned after DELETED_SESSION_RETENTION_MS (past the 30-day discovery
   *  window, so a pruned entry can't resurrect anything — and the server-side
   *  tombstone still refuses with 410 regardless). The local jsonl file is the
   *  user's own and is never touched. */
  deletedSessions?: Record<string, number>;
  /** The data roots the LONG-RUNNING daemon actually watches, stamped by
   *  startWatch only (main scope). One-shot runs (`hx tick`, `watch --once`)
   *  carry the invoking shell's env — CLAUDE_CONFIG_DIR / CODEX_HOME the
   *  background service may never see — so they must not overwrite this.
   *  The UI server treats the stamp as device truth for ALL its discovery
   *  and falls back to its own resolution when the stamp is absent (daemon
   *  not yet upgraded / never ran). Additive; older binaries ignore it. */
  effectiveRoots?: EffectiveRootsStamp;
  /** Last elected uploader path per child lane (`parent:agent:runId`). Child
   *  election is stateless (newest mtime wins); when a lane's winner FLIPS
   *  (a copied tree raced the live file), the new winner must re-upload from
   *  zero or its stale offsets would append onto a canonical another file
   *  last wrote — and child lanes have no offsets audit to ever notice (see
   *  planChildLaneResets in watch.ts). Not pruned — entries are two short
   *  strings per lane and lanes are bounded by real agent activity, same
   *  growth class as `files`. Additive; older binaries ignore it. */
  childUploaders?: Record<string, string>;
}

const STATE_DIR = HX_DIR;
const STATE_FILE: Record<StateScope, string> = {
  main: "state.json",
  local: "state.local.json",
};

const inMemory = new Map<StateScope, HxState>();
const writeChains = new Map<StateScope, Promise<void>>();

/** Forget a cached snapshot so a maintenance command can re-read state after
 *  stopping the daemon that owned the file. */
export function resetStateCache(scope: StateScope = "main"): void {
  inMemory.delete(scope);
}

function statePath(scope: StateScope): string {
  return path.join(STATE_DIR, STATE_FILE[scope]);
}

export async function loadState(scope: StateScope = "main"): Promise<HxState> {
  const cached = inMemory.get(scope);
  if (cached) return cached;
  let state: HxState;
  if (!existsSync(statePath(scope))) {
    state = { files: {} };
  } else {
    try {
      const raw = await readFile(statePath(scope), "utf8");
      state = JSON.parse(raw) as HxState;
    } catch {
      state = { files: {} };
    }
  }
  if (!state.files) state.files = {};
  // Upgrade any legacy single-offset entries to the per-destination shape. The
  // declared type is already FileState, but on-disk data may predate `offsets`.
  for (const [k, v] of Object.entries(state.files)) {
    state.files[k] = migrateFileState(v);
  }
  seedDestinationsFromBlockers(state);
  inMemory.set(scope, state);
  return state;
}

/**
 * First run after upgrading: build the destination registry from whatever
 * persisted blockers happen to be latched right now.
 *
 * Without this the registry is empty until the daemon completes a pass, and
 * until then every waiting session reads as an ordinary backlog — the status
 * would briefly show a percentage below 100 for stores it already knows are
 * offline. A latched blocker IS a gateway report that a destination is held,
 * so it seeds the same fact the next pass would record.
 *
 * Seeding only, never maintenance: it runs once (when `destinations` is
 * absent) and the daemon owns the registry from then on. Relying on these
 * latches continuously is precisely the bug this registry exists to fix —
 * any clean pass clears them.
 */
export function seedDestinationsFromBlockers(state: HxState): void {
  if (state.destinations) return;
  const reports = new Map<string, DestinationReport>();
  let earliest = Date.now();
  for (const fs of Object.values(state.files)) {
    if (!fs.blocker) continue;
    earliest = Math.min(earliest, fs.blocker.firstSeenAtMs);
    for (const d of fs.blocker.destinations) {
      reports.set(destKey(d.vaultOrgId), {
        vaultOrgId: d.vaultOrgId,
        status: "held",
        orgName: d.orgName ?? null,
        orgSlug: d.orgSlug ?? null,
        lastSeenAt: d.lastSeenAt ?? null,
      });
    }
  }
  if (reports.size === 0) return;
  // Date the seeded outage from the oldest blocker we hold, so an upgrade
  // doesn't reset a three-week outage to "offline 0d".
  applyDestinationReports(state, [...reports.values()], earliest);
}

async function persist(state: HxState, scope: StateScope): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const target = statePath(scope);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

/** Chain writes per scope so we never have two writers racing on one file. */
function schedulePersist(state: HxState, scope: StateScope): Promise<void> {
  const chain = (writeChains.get(scope) ?? Promise.resolve())
    .then(() => persist(state, scope))
    .catch(() => persist(state, scope));
  writeChains.set(scope, chain);
  return chain;
}

export async function getFileState(
  filePath: string,
  scope: StateScope = "main",
): Promise<FileState | null> {
  const state = await loadState(scope);
  return state.files[filePath] ?? null;
}

export async function upsertFileState(
  s: FileState,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  state.files[s.path] = s;
  await schedulePersist(state, scope);
}

/** Persist the daemon's resolved watch roots (see HxState.effectiveRoots). */
export async function stampEffectiveRoots(
  roots: ResolvedRoots,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  state.effectiveRoots = {
    claude: roots.claude,
    codex: roots.codex,
    resolvedAtMs: Date.now(),
  };
  await schedulePersist(state, scope);
}

/** Persist the cached state after in-place mutations (childUploaders map,
 *  offset zeroing on a lane flip). Same single-writer discipline as every
 *  other writer here — only the process that owns the lane calls this. */
export async function persistState(scope: StateScope = "main"): Promise<void> {
  const state = await loadState(scope);
  await schedulePersist(state, scope);
}

/** Record the bytes committed to ONE destination for a file. Other destinations'
 *  offsets are untouched, so an offline vault never rolls back a healthy one. */
export async function setOffsetFor(
  filePath: string,
  vaultOrgId: string | null,
  offset: number,
  mtimeMs: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  existing.offsets[destKey(vaultOrgId)] = offset;
  existing.lastMtimeMs = mtimeMs;
  existing.lastUploadAtMs = Date.now();
  await schedulePersist(state, scope);
}

/**
 * Reconcile a file's per-destination offsets against the gateway's CURRENT
 * fan-out set for its session (both ready and held destinations — a held
 * vault is expected back and must keep its offset). A destination that left
 * the set (org detached, vault decommissioned) would otherwise pin
 * minOffset — and with it the sync percentage — below done forever, since
 * nothing ever wrote to it again and no other code path removes offset keys.
 */
export async function reconcileDestinations(
  filePath: string,
  activeKeys: string[],
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  const changed = reconcileDestinationOffsets(existing.offsets, activeKeys);
  if (changed) await schedulePersist(state, scope);
}

/** Apply a gateway's current destination set to an offset map. Exported as a
 * pure mutation helper so the add-at-zero/prune contract is directly tested. */
export function reconcileDestinationOffsets(
  offsets: Record<string, number>,
  activeKeys: string[],
): boolean {
  const keep = new Set(activeKeys);
  let changed = false;
  // A newly-attached destination starts at zero. Recording that zero is what
  // keeps the sync percentage honest while the destination is held/offline;
  // otherwise minOffset() would only see already-written stores and could
  // incorrectly report 100%.
  for (const k of keep) {
    if (k in offsets) continue;
    offsets[k] = 0;
    changed = true;
  }
  for (const k of Object.keys(offsets)) {
    if (keep.has(k)) continue;
    delete offsets[k];
    changed = true;
  }
  return changed;
}

/** Refresh a file's observed mtime without advancing any destination's offset
 *  (the file changed but produced no new committable bytes). */
export async function touchMtime(
  filePath: string,
  mtimeMs: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  existing.lastMtimeMs = mtimeMs;
  await schedulePersist(state, scope);
}

/** Per-file retry backoff cap — a broken file retries at most every 30 min. */
const FILE_BACKOFF_CAP_MS = 30 * 60_000;

/** Bench a file for a FIXED window without touching its failure streak. Used
 *  by the gateway-outage probe in `tickOnce`: the probed file is not at fault,
 *  so it must not accrue compounding backoff (nor a skipReason) — just a short
 *  fixed pause so consecutive passes rotate their probes instead of hammering
 *  one file, and so a recovered gateway is retried within one base window.
 *
 *  Deliberately does NOT clear an existing skipReason/blocker either: a file
 *  previously in a recognized hold keeps advertising that hold through the
 *  ≤30s probe window; the next success clears it and the next classified
 *  failure replaces it. */
export async function benchFileProbe(
  filePath: string,
  delayMs: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  existing.nextAttemptAtMs = Date.now() + delayMs;
  await schedulePersist(state, scope);
}

/** Record a failed upload attempt for one file and schedule its next try with
 *  exponential backoff from `baseMs`. Returns the chosen delay (ms).
 *
 *  `skipReason` distinguishes a transient store outage (the file is fine, its
 *  destination is temporarily unavailable) from an ordinary per-file fault: when
 *  set it is stamped for `hx status`; when omitted any stale reason is cleared,
 *  so a file that fails for a new reason never keeps advertising the old one. */
export async function recordFileFailure(
  filePath: string,
  baseMs: number,
  scope: StateScope = "main",
  skipReason?: FileSkipReason,
  blocker?: SyncBlockerDetails,
): Promise<number> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return 0;
  const n = (existing.consecutiveFailures ?? 0) + 1;
  existing.consecutiveFailures = n;
  const delay = Math.min(FILE_BACKOFF_CAP_MS, baseMs * 2 ** (n - 1));
  existing.nextAttemptAtMs = Date.now() + delay;
  if (skipReason) existing.skipReason = skipReason;
  else delete existing.skipReason;
  if (blocker) {
    const now = Date.now();
    const sameReason = existing.blocker?.reason === blocker.reason;
    existing.blocker = {
      ...blocker,
      firstSeenAtMs: sameReason ? existing.blocker!.firstSeenAtMs : now,
      lastSeenAtMs: now,
    };
  } else {
    delete existing.blocker;
  }
  await schedulePersist(state, scope);
  return delay;
}

/** How many consecutive self-heals one file may burn before the heal pauses. */
export const HEAL_MAX_CONSECUTIVE = 3;
/** How long a ping-ponging file's self-heal stays paused. */
export const HEAL_PAUSE_MS = 6 * 60 * 60_000;

/** Count a canonical self-heal for one file; pauses healing once the streak
 *  hits HEAL_MAX_CONSECUTIVE. Returns the streak length. */
export async function recordHeal(
  filePath: string,
  scope: StateScope = "main",
): Promise<number> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return 0;
  const n = (existing.healCount ?? 0) + 1;
  existing.healCount = n;
  if (n >= HEAL_MAX_CONSECUTIVE) {
    existing.healPausedUntilMs = Date.now() + HEAL_PAUSE_MS;
  }
  await schedulePersist(state, scope);
  return n;
}

/** A clean, size-matching commit ends any heal streak. */
export async function clearHeal(
  filePath: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing || (existing.healCount === undefined && existing.healPausedUntilMs === undefined)) {
    return;
  }
  delete existing.healCount;
  delete existing.healPausedUntilMs;
  await schedulePersist(state, scope);
}

/** Clear a file's failure backoff (and any skip reason) after a clean pass. */
export async function clearFileFailure(
  filePath: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (
    !existing ||
    (existing.consecutiveFailures === undefined &&
      existing.nextAttemptAtMs === undefined &&
      existing.skipReason === undefined &&
      existing.blocker === undefined)
  ) {
    return;
  }
  delete existing.consecutiveFailures;
  delete existing.nextAttemptAtMs;
  delete existing.skipReason;
  delete existing.blocker;
  await schedulePersist(state, scope);
}

/** Clear only transient destination holds so the next daemon pass retries them
 *  immediately. The caller stops the daemon first, preserving state.json's
 *  single-writer invariant. */
export async function clearBlockedFailures(
  scope: StateScope = "main",
): Promise<{ files: number; sessions: number }> {
  const state = await loadState(scope);
  const cleared = clearBlockedFailuresFromState(state);
  if (cleared.files > 0) await schedulePersist(state, scope);
  return cleared;
}

export function clearBlockedFailuresFromState(
  state: HxState,
): { files: number; sessions: number } {
  const sessions = new Set<string>();
  let files = 0;
  for (const entry of Object.values(state.files)) {
    if (!entry.skipReason && !entry.blocker) continue;
    files += 1;
    sessions.add(`${entry.family}:${entry.sessionId}`);
    delete entry.consecutiveFailures;
    delete entry.nextAttemptAtMs;
    delete entry.skipReason;
    delete entry.blocker;
  }
  return { files, sessions: sessions.size };
}

/**
 * Clear EVERY per-file retry backoff — vault holds AND generic failures.
 *
 * `--blocked` only matches entries carrying a `skipReason`, which is exactly
 * right for a Fortress outage and exactly wrong for a central fault: a 403
 * from the storage layer takes the generic failure path, so after the
 * 2026-08-01 credential outage 803 files sat pinned at the 30-minute backoff
 * cap with nothing for `--blocked` to clear, and an already-fixed fleet
 * recovered at 0.13 MB/s. This is the "the incident is over, retry everything
 * now" lever. Destination failure runs are reset too — the next pass either
 * succeeds (proving recovery) or re-latches them within one attempt.
 */
export function clearAllFailuresFromState(
  state: HxState,
): { files: number; sessions: number } {
  const sessions = new Set<string>();
  let files = 0;
  for (const entry of Object.values(state.files)) {
    if (
      entry.skipReason === undefined &&
      entry.blocker === undefined &&
      entry.consecutiveFailures === undefined &&
      entry.nextAttemptAtMs === undefined
    ) {
      continue;
    }
    files += 1;
    sessions.add(`${entry.family}:${entry.sessionId}`);
    delete entry.consecutiveFailures;
    delete entry.nextAttemptAtMs;
    delete entry.skipReason;
    delete entry.blocker;
  }
  for (const key of Object.keys(state.destinations ?? {})) {
    applyDestinationUploadSuccess(state, key);
  }
  return { files, sessions: sessions.size };
}

export async function clearAllFailures(
  scope: StateScope = "main",
): Promise<{ files: number; sessions: number }> {
  const state = await loadState(scope);
  const cleared = clearAllFailuresFromState(state);
  if (cleared.files > 0) await schedulePersist(state, scope);
  return cleared;
}

/**
 * Drop generic (non-hold) backoffs only — the daemon-restart variant. A
 * restart is a human signalling "conditions changed", so waiting out stale
 * exponential penalties serves nobody; vault holds are deliberately kept
 * (the store really is down until the gateway says otherwise).
 */
export function clearGenericBackoffsFromState(state: HxState): number {
  let files = 0;
  for (const entry of Object.values(state.files)) {
    if (entry.skipReason !== undefined) continue; // a real hold — keep it
    if (entry.consecutiveFailures === undefined && entry.nextAttemptAtMs === undefined) continue;
    files += 1;
    delete entry.consecutiveFailures;
    delete entry.nextAttemptAtMs;
    delete entry.blocker;
  }
  return files;
}

export async function clearGenericBackoffs(scope: StateScope = "main"): Promise<number> {
  const state = await loadState(scope);
  const files = clearGenericBackoffsFromState(state);
  if (files > 0) await schedulePersist(state, scope);
  return files;
}

/** Past the 30-day discovery window with margin — see HxState.deletedSessions. */
const DELETED_SESSION_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/** The `deletedSessions` key for one session. */
export function deletedSessionKey(family: string, sessionId: string): string {
  return `${family}:${sessionId}`;
}

/** Record a server-side permanent delete; idempotent. Prunes expired entries
 *  opportunistically so the map can't grow without bound. */
export async function recordDeletedSession(
  family: string,
  sessionId: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (!state.deletedSessions) state.deletedSessions = {};
  const key = deletedSessionKey(family, sessionId);
  if (!state.deletedSessions[key]) state.deletedSessions[key] = Date.now();
  const cutoff = Date.now() - DELETED_SESSION_RETENTION_MS;
  for (const [k, at] of Object.entries(state.deletedSessions)) {
    if (at < cutoff) delete state.deletedSessions[k];
  }
  await schedulePersist(state, scope);
}

/** True when the server permanently deleted this session (any family recorded —
 *  the id is matched exactly per family first, then by bare sessionId so a
 *  stale-family child/sidecar path can't slip past the local stop either). */
export function isDeletedSession(
  state: HxState,
  family: string,
  sessionId: string,
): boolean {
  const map = state.deletedSessions;
  if (!map) return false;
  if (map[deletedSessionKey(family, sessionId)]) return true;
  const suffix = `:${sessionId}`;
  for (const k of Object.keys(map)) if (k.endsWith(suffix)) return true;
  return false;
}

export async function getArtifactHash(
  key: string,
  scope: StateScope = "main",
): Promise<string | null> {
  const state = await loadState(scope);
  return state.artifacts?.[key] ?? null;
}

export async function setArtifactHash(
  key: string,
  hash: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (!state.artifacts) state.artifacts = {};
  state.artifacts[key] = hash;
  await schedulePersist(state, scope);
}
