// ~/.let/hx/state.json holds per-file upload offsets.
//
// On every successful chunk-commit we bump the offset for that file. On
// startup we restore offsets and skip already-uploaded bytes. A JSON snapshot
// (atomic write via rename) plus an append-only journal beside it
// (state.journal.jsonl, folded into the snapshot at checkpoints — see the
// persistence section below) is the right primitive — no native deps, no
// concurrent writers (a single hx process owns it).
//
// State is scoped per upload lane: the regular gateway's offsets live in
// state.json, while the `--local` tee lane (the same files, mirrored to the
// local dev gateway in addition) keeps its own in state.local.json. Each
// gateway has its own "how many bytes of this file do you already hold"
// truth, so the lanes must never share offsets or artifact hashes.

import { appendFile, readFile, writeFile, rename, mkdir } from "node:fs/promises";
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
  /** TITLE_SYNC_VERSION stamp of the last codex title backfill that covered this
   *  file (title-sync.ts, LETAIR-481). Absent/lower ⇒ the next sweep re-reads the
   *  codex name and re-reports it; once stamped it is skipped on every start. */
  titleSyncVersion?: number;
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
  titleSyncVersion?: number;
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
    ...(s.titleSyncVersion !== undefined ? { titleSyncVersion: s.titleSyncVersion } : {}),
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
  await persistOrMark(state, scope, { dest: key });
}

export async function clearDestinationUploadError(
  key: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  // Flush-through in both modes: this clear ends a destination failure run
  // right after a successful commit — losing it to a hard kill would leave a
  // phantom "failing" row in `hx status --detailed` until the NEXT commit to
  // that destination. Transition-gated, so the extra line is rare.
  if (applyDestinationUploadSuccess(state, key)) {
    const record = state.destinations?.[key];
    if (record) await journalThrough(scope, [{ t: "dest", key, record }]);
  }
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
    await persistOrMark(state, scope, { dests: reports.map((r) => destKey(r.vaultOrgId)) });
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
  /** Learned per-destination chunk-size caps (bytes), keyed by {@link destKey}
   *  — written by the adaptive-chunk probe when a destination's PUT path
   *  rejects a grown size, so restarts never re-probe. Additive; older
   *  binaries round-trip it untouched (loadState keeps unknown top-level
   *  keys and persist rewrites the whole object). */
  chunkCaps?: Record<string, number>;
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
/** The offsets journal beside each snapshot: one JSON line per durable
 *  mutation, folded into the snapshot at a checkpoint (see below). */
const JOURNAL_FILE: Record<StateScope, string> = {
  main: "state.journal.jsonl",
  local: "state.local.journal.jsonl",
};

const inMemory = new Map<StateScope, HxState>();
const writeChains = new Map<StateScope, Promise<void>>();

// ── Persistence: a snapshot plus an append-only journal ─────────────────────
//
// state.json is a SNAPSHOT of the whole state. Until 77.11 every durable
// mutation rewrote it whole, so a committed chunk's new offset cost one write
// of the entire file — 5 MB on a busy laptop, 40–110 MB of disk writes per
// active minute. A durable mutation now APPENDS one JSON line to the journal
// beside the snapshot, and the snapshot is rewritten only at a CHECKPOINT:
// when the journal outgrows CHECKPOINT_JOURNAL_BYTES, every
// CHECKPOINT_INTERVAL_MS while anything is journaled, when the daemon stops
// (stop(), SIGTERM/SIGINT, the watchdog exit), and at the end of every
// one-shot pass, so `hx tick`, `watch --once` and the maintenance commands
// leave an empty journal behind them. A checkpoint writes the snapshot (tmp +
// rename, as before) and then truncates the journal, both on the per-scope
// write chain the appends use, so no line is ever folded and truncated out of
// order with the append that wrote it.
//
// Every reader (loadState) replays the journal over the snapshot, so `hx
// status`, `hx doctor` and the UI server see a committed offset as soon as
// the daemon has appended it — as they saw it when the daemon rewrote the
// whole file. A journal entry SETS one record (a whole file entry, a
// destination record, an artifact hash, a chunk cap, the tombstone map), so
// replaying a line a checkpoint already folded is harmless, and a torn
// trailing line (a reader racing an append) is skipped.
//
// What is journaled, and when:
//   • the flush-through mutators — setOffsetFor and the three transition
//     clears (clearFileFailure, clearDestinationUploadError, clearHeal) —
//     append their record before returning, in EVERY mode: a committed-byte
//     offset is durable before the next fan-out step, as it always was. A
//     vault-routed or fortress-direct canonical has no divergence heal, so a
//     lost offset there would mean silently duplicated bytes after a hard
//     kill — the one crash-loss class this file could create;
//   • in COALESCED mode (the long-running daemon loop opts in through
//     armCoalescedPersistence) the high-churn bookkeeping mutators — mtime
//     touches, the destination registry, backoff stamps, artifact hashes —
//     only mark their record dirty; flushStateIfDirty (end of every pass, a
//     5 s timer) appends one line per dirty record;
//   • in the default FLUSH-THROUGH mode (every one-shot and cross-process
//     writer: `hx retry`, `hx backfill`, the UI server's actions, `hx tick`,
//     `watch --once`) those mutators still write the whole snapshot at once,
//     as they always did — none of them has a later flush point, and the
//     snapshot must be current when they exit;
//   • whole-state mutations (a lane flip's offset zeroing, the roots stamp,
//     the start-of-daemon prune and backoff clears) checkpoint directly.
const coalescedScopes = new Set<StateScope>();

/** How often a daemon folds its journal into the snapshot while anything is
 *  journaled, and the journal size that forces a fold sooner. */
export const CHECKPOINT_INTERVAL_MS = 10 * 60_000;
export const CHECKPOINT_JOURNAL_BYTES = 4 * 1024 * 1024;
let checkpointPolicy = { intervalMs: CHECKPOINT_INTERVAL_MS, journalBytes: CHECKPOINT_JOURNAL_BYTES };

/** Test seam — shrink the checkpoint interval or size bound (null restores
 *  the defaults). Production code never calls this. */
export function setCheckpointPolicyForTests(policy: { intervalMs?: number; journalBytes?: number } | null): void {
  checkpointPolicy = {
    intervalMs: policy?.intervalMs ?? CHECKPOINT_INTERVAL_MS,
    journalBytes: policy?.journalBytes ?? CHECKPOINT_JOURNAL_BYTES,
  };
}

/** One line of the journal: a SET of one record. Idempotent on replay. */
export type JournalEntry =
  | { t: "file"; path: string; state: FileState }
  | { t: "dest"; key: string; record: DestinationRecord }
  | { t: "artifact"; key: string; hash: string }
  | { t: "chunkCap"; key: string; cap: number }
  | { t: "deletedSessions"; map: Record<string, number> };

/** Apply one journal line to a state object. Returns false for a line this
 *  binary does not understand (a newer kind), which the replay skips. */
export function applyJournalEntry(state: HxState, e: JournalEntry): boolean {
  switch (e.t) {
    case "file":
      if (!e.path || !e.state || typeof e.state !== "object") return false;
      state.files[e.path] = migrateFileState(e.state as LegacyFileState);
      return true;
    case "dest":
      if (!e.key || !e.record) return false;
      (state.destinations ??= {})[e.key] = e.record;
      return true;
    case "artifact":
      if (!e.key || typeof e.hash !== "string") return false;
      (state.artifacts ??= {})[e.key] = e.hash;
      return true;
    case "chunkCap":
      if (!e.key || typeof e.cap !== "number") return false;
      (state.chunkCaps ??= {})[e.key] = e.cap;
      return true;
    case "deletedSessions":
      if (!e.map || typeof e.map !== "object") return false;
      state.deletedSessions = e.map;
      return true;
    default:
      return false;
  }
}

/** Replay a journal text over a state object. Pure over the text, so the
 *  torn-line and unknown-kind rules are unit-tested without a filesystem. */
export function replayJournalText(
  state: HxState,
  text: string,
): { entries: number; skipped: number } {
  let entries = 0;
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: JournalEntry;
    try {
      e = JSON.parse(line) as JournalEntry;
    } catch {
      skipped += 1; // a torn trailing line, or garbage — never a reason to fail the load
      continue;
    }
    if (applyJournalEntry(state, e)) entries += 1;
    else skipped += 1;
  }
  return { entries, skipped };
}

// Per-scope journal bookkeeping: how many bytes the journal holds (0 = empty
// or absent) and when the snapshot was last written or loaded.
interface JournalMeta {
  bytes: number;
  lastCheckpointAtMs: number;
}
const journals = new Map<StateScope, JournalMeta>();
function journalMeta(scope: StateScope): JournalMeta {
  let m = journals.get(scope);
  if (!m) {
    m = { bytes: 0, lastCheckpointAtMs: Date.now() };
    journals.set(scope, m);
  }
  return m;
}

// Dirty records in coalesced mode, by kind: what the next flush point journals.
interface DirtySet {
  /** A whole-state mutation is pending (lane flip, start-of-daemon clears):
   *  the next flush is a checkpoint. */
  all: boolean;
  files: Set<string>;
  dests: Set<string>;
  artifacts: Set<string>;
  chunkCaps: Set<string>;
  deletedSessions: boolean;
}
const dirty = new Map<StateScope, DirtySet>();
function dirtyFor(scope: StateScope): DirtySet {
  let d = dirty.get(scope);
  if (!d) {
    d = { all: false, files: new Set(), dests: new Set(), artifacts: new Set(), chunkCaps: new Set(), deletedSessions: false };
    dirty.set(scope, d);
  }
  return d;
}
function isDirty(d: DirtySet): boolean {
  return d.all || d.files.size > 0 || d.dests.size > 0 || d.artifacts.size > 0 || d.chunkCaps.size > 0 || d.deletedSessions;
}
function clearDirty(d: DirtySet): void {
  d.all = false;
  d.files.clear();
  d.dests.clear();
  d.artifacts.clear();
  d.chunkCaps.clear();
  d.deletedSessions = false;
}

type DirtyMark =
  | "all"
  | { file?: string; dest?: string; dests?: string[]; artifact?: string; chunkCap?: string; deletedSessions?: true };

function markDirty(scope: StateScope, mark: DirtyMark): void {
  const d = dirtyFor(scope);
  if (mark === "all") {
    d.all = true;
    return;
  }
  if (mark.file !== undefined) d.files.add(mark.file);
  if (mark.dest !== undefined) d.dests.add(mark.dest);
  for (const k of mark.dests ?? []) d.dests.add(k);
  if (mark.artifact !== undefined) d.artifacts.add(mark.artifact);
  if (mark.chunkCap !== undefined) d.chunkCaps.add(mark.chunkCap);
  if (mark.deletedSessions) d.deletedSessions = true;
}

/** The journal lines for every dirty record, read from the live state. */
function collectDirtyEntries(state: HxState, d: DirtySet): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const p of d.files) {
    const fs = state.files[p];
    if (fs) out.push({ t: "file", path: p, state: fs });
  }
  for (const k of d.dests) {
    const record = state.destinations?.[k];
    if (record) out.push({ t: "dest", key: k, record });
  }
  for (const k of d.artifacts) {
    const hash = state.artifacts?.[k];
    if (hash !== undefined) out.push({ t: "artifact", key: k, hash });
  }
  for (const k of d.chunkCaps) {
    const cap = state.chunkCaps?.[k];
    if (cap !== undefined) out.push({ t: "chunkCap", key: k, cap });
  }
  if (d.deletedSessions) out.push({ t: "deletedSessions", map: state.deletedSessions ?? {} });
  return out;
}

/** Re-mark the records of entries whose write failed, so the next flush
 *  point retries them instead of stranding the in-memory mutations. */
function remarkEntries(scope: StateScope, entries: JournalEntry[]): void {
  for (const e of entries) {
    if (e.t === "file") markDirty(scope, { file: e.path });
    else if (e.t === "dest") markDirty(scope, { dest: e.key });
    else if (e.t === "artifact") markDirty(scope, { artifact: e.key });
    else if (e.t === "chunkCap") markDirty(scope, { chunkCap: e.key });
    else markDirty(scope, { deletedSessions: true });
  }
}

// Best-effort POSIX fold-on-signal (SIGTERM from systemd/launchd stop, SIGINT
// from a foreground Ctrl-C): every armed scope checkpoints, so the next start
// reads a current snapshot and an empty journal. Never load-bearing — Windows
// and `docker stop`'s SIGKILL get no signal at all, which is why committed
// offsets are journaled before the next step in the first place. After
// flushing, the signal is RE-RAISED (the `once` handler is gone by then) so
// the process's observable exit — default termination, or cmdWatch's own
// SIGINT handler — is exactly what it is today; this handler only borrows the
// beat before it. Other modules hook the same beat through
// registerPartingFlush (the Claude Desktop index save, see ccd.ts).
let signalFlushInstalled = false;
const partingFlushers: Array<() => Promise<unknown>> = [];
function installSignalFlush(): void {
  if (signalFlushInstalled || process.platform === "win32") return;
  signalFlushInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void Promise.allSettled([
        ...[...coalescedScopes].map((s) => checkpointState(s)),
        ...partingFlushers.map((f) => f()),
      ]).finally(() => {
        process.kill(process.pid, sig);
      });
    });
  }
}

/** Run `fn` in the daemon's parting flush (the signal handler above). Only
 *  the long-running loop arms that handler, so a registration from a
 *  one-shot process is inert. */
export function registerPartingFlush(fn: () => Promise<unknown>): void {
  partingFlushers.push(fn);
}

/** Arm coalesced persistence for one scope — the long-running daemon loop
 *  only. One-shot runs and every other process stay flush-through. */
export function armCoalescedPersistence(scope: StateScope): void {
  coalescedScopes.add(scope);
  installSignalFlush();
}

/** Disarm (stop() / tests). Pending dirty state is NOT flushed here — callers
 *  flush explicitly first; disarming only restores flush-through mode. */
export function disarmCoalescedPersistence(scope: StateScope): void {
  coalescedScopes.delete(scope);
}

/** Write the whole snapshot now (flush-through), or — in coalesced mode —
 *  mark the mutated record dirty and return immediately. */
function persistOrMark(state: HxState, scope: StateScope, mark: DirtyMark): Promise<void> {
  if (coalescedScopes.has(scope)) {
    markDirty(scope, mark);
    return Promise.resolve();
  }
  return schedulePersist(state, scope);
}

/** Append the given records to the journal before returning — the durable
 *  path of the flush-through mutators, in both modes. The line carries the
 *  whole record, so a dirty mark for the same record is dropped. */
async function journalThrough(scope: StateScope, entries: JournalEntry[]): Promise<void> {
  const d = dirtyFor(scope);
  for (const e of entries) {
    if (e.t === "file") d.files.delete(e.path);
    else if (e.t === "dest") d.dests.delete(e.key);
    else if (e.t === "artifact") d.artifacts.delete(e.key);
    else if (e.t === "chunkCap") d.chunkCaps.delete(e.key);
    else d.deletedSessions = false;
  }
  await appendJournal(scope, entries);
}

/** Whether a flush point should fold the journal into the snapshot: always
 *  outside the daemon (one-shot passes leave an empty journal), on the
 *  interval or the size bound inside it. */
function checkpointDue(scope: StateScope): boolean {
  const m = journalMeta(scope);
  if (m.bytes === 0) return false;
  if (!coalescedScopes.has(scope)) return true;
  return m.bytes >= checkpointPolicy.journalBytes || Date.now() - m.lastCheckpointAtMs >= checkpointPolicy.intervalMs;
}

/** Flush a scope's pending mutations: dirty records become journal lines (a
 *  pending whole-state mutation becomes a checkpoint), then the journal is
 *  folded into the snapshot when a checkpoint is due. The daemon calls this at
 *  the end of every pass and on a short timer; a one-shot pass calls it once
 *  at its end. Rejections carry through to the caller (which logs) — the
 *  records were re-marked, so the next flush point retries. */
export async function flushStateIfDirty(scope: StateScope = "main"): Promise<void> {
  const state = await loadState(scope);
  const d = dirtyFor(scope);
  if (d.all) {
    clearDirty(d);
    try {
      await checkpoint(state, scope);
    } catch (err) {
      d.all = true;
      throw err;
    }
    return;
  }
  const entries = collectDirtyEntries(state, d);
  clearDirty(d);
  if (entries.length > 0) {
    try {
      await appendJournal(scope, entries);
    } catch (err) {
      remarkEntries(scope, entries);
      throw err;
    }
  }
  if (checkpointDue(scope)) await checkpoint(state, scope);
}

/** Fold everything into the snapshot now: dirty records, the journal, all of
 *  it. The daemon's stop(), the signal handler and the watchdog exit use it;
 *  a no-op when nothing is pending and the journal is empty. */
export async function checkpointState(scope: StateScope = "main"): Promise<void> {
  const state = await loadState(scope);
  const d = dirtyFor(scope);
  const pending = isDirty(d) || journalMeta(scope).bytes > 0;
  clearDirty(d);
  if (!pending) return;
  await checkpoint(state, scope);
}

/** Test seam: whether a scope currently has unflushed coalesced mutations. */
export function hasDirtyState(scope: StateScope = "main"): boolean {
  return isDirty(dirtyFor(scope));
}

/** Whether the daemon's flush timer has work: dirty records, or a journal
 *  whose checkpoint is due. */
export function stateFlushDue(scope: StateScope = "main"): boolean {
  return hasDirtyState(scope) || checkpointDue(scope);
}

/** Test seam: bytes currently in the journal (0 = empty or absent). */
export function journalBytes(scope: StateScope = "main"): number {
  return journalMeta(scope).bytes;
}

/** Forget a cached snapshot so a maintenance command can re-read state after
 *  stopping the daemon that owned the file. */
export function resetStateCache(scope: StateScope = "main"): void {
  inMemory.delete(scope);
  journals.delete(scope);
  dirty.delete(scope);
  pendingLines.delete(scope);
}

// Test seam: persistence tests point the module at a tmpdir (the same
// injection style settings.ts/activity.ts use via path parameters — state's
// mutators derive the path internally, so the override lives here instead).
let stateDirOverride: string | null = null;

/** Test seam — redirect state files to `dir` (null restores ~/.let/hx).
 *  Callers reset the cache themselves; production code never calls this. */
export function setStateDirForTests(dir: string | null): void {
  stateDirOverride = dir;
}

function statePath(scope: StateScope): string {
  return path.join(stateDirOverride ?? STATE_DIR, STATE_FILE[scope]);
}

function journalPath(scope: StateScope): string {
  return path.join(stateDirOverride ?? STATE_DIR, JOURNAL_FILE[scope]);
}

/** The journal file beside a scope's snapshot (for doctor and tests). */
export function stateJournalPath(scope: StateScope = "main"): string {
  return journalPath(scope);
}

export async function loadState(scope: StateScope = "main"): Promise<HxState> {
  const cached = inMemory.get(scope);
  if (cached) return cached;
  let state: HxState;
  // The snapshot first, then the journal. A checkpoint by another process
  // between the two reads leaves this reader with the OLD snapshot and the
  // emptied journal — a stale view, never a regressed one (the other order
  // could replay an old line over a newer snapshot). The next read catches up.
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
  let journalText = "";
  try {
    journalText = await readFile(journalPath(scope), "utf8");
  } catch {
    // no journal: nothing to replay
  }
  replayJournalText(state, journalText);
  journals.set(scope, { bytes: Buffer.byteLength(journalText), lastCheckpointAtMs: Date.now() });
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
  await mkdir(stateDirOverride ?? STATE_DIR, { recursive: true });
  const target = statePath(scope);
  const tmp = `${target}.tmp`;
  // Compact JSON: state.json is written often and parsed only by JSON.parse
  // consumers (this module, the UI server, doctor) — pretty-printing doubled
  // every write for nothing.
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, target);
}

/** Every disk operation of a scope runs on one chain, in call order: full
 *  snapshot writes, journal appends and checkpoints never race one another on
 *  the two files. A step that fails rejects to its own caller only — the
 *  chain carries on with the next step. */
function enqueue(scope: StateScope, step: () => Promise<void>): Promise<void> {
  const chain = (writeChains.get(scope) ?? Promise.resolve()).then(step, step);
  writeChains.set(scope, chain);
  return chain;
}

// One write may be QUEUED (scheduled, not yet started) per scope. `persist`
// serializes the live state object at write time, so every mutation applied
// before the queued write starts is already included in it — additional
// callers piggyback on that queued write instead of enqueueing another full
// rewrite each. A mutation landing while a write is IN FLIGHT queues exactly
// one follow-up.
const queuedWrite = new Map<StateScope, Promise<void>>();

/** Chain full snapshot writes per scope so we never have two writers racing
 *  on one file. A failed write RETRIES ONCE immediately (the base contract —
 *  a transient EBUSY/EPERM from an AV or indexer holding the file, classic on
 *  Windows, must stay invisible); a double failure rejects to the awaiting
 *  caller. */
function schedulePersist(state: HxState, scope: StateScope): Promise<void> {
  const queued = queuedWrite.get(scope);
  if (queued) return queued;
  const start = (): Promise<void> => {
    queuedWrite.delete(scope); // the write begins: later mutations must re-queue
    return persist(state, scope).catch(() => persist(state, scope));
  };
  const chain = enqueue(scope, start);
  queuedWrite.set(scope, chain);
  return chain;
}

// Journal lines queued for the next append step. One chain step writes every
// line queued so far in a single appendFile, so N concurrent commit-flushes
// under the upload pool become one write, not N.
const pendingLines = new Map<StateScope, string[]>();

async function writeJournalLines(scope: StateScope, text: string): Promise<void> {
  await mkdir(stateDirOverride ?? STATE_DIR, { recursive: true });
  await appendFile(journalPath(scope), text, { mode: 0o600 });
}

function appendJournal(scope: StateScope, entries: JournalEntry[]): Promise<void> {
  const lines = pendingLines.get(scope) ?? [];
  for (const e of entries) lines.push(JSON.stringify(e));
  pendingLines.set(scope, lines);
  return enqueue(scope, async () => {
    const queued = pendingLines.get(scope);
    if (!queued || queued.length === 0) return;
    pendingLines.set(scope, []);
    const text = `${queued.join("\n")}\n`;
    try {
      await writeJournalLines(scope, text).catch(() => writeJournalLines(scope, text));
    } catch (err) {
      // Put the lines back so a later append or flush retries them; the
      // in-memory state already holds the mutation.
      pendingLines.set(scope, [...queued, ...(pendingLines.get(scope) ?? [])]);
      throw err;
    }
    journalMeta(scope).bytes += Buffer.byteLength(text);
  });
}

/** Write the snapshot and empty the journal, as one step on the chain. The
 *  snapshot is serialized inside the step, so every line a later step appends
 *  describes a mutation this snapshot does not yet hold (or repeats one it
 *  does, harmlessly). A failed snapshot write leaves the journal alone. */
function checkpoint(state: HxState, scope: StateScope): Promise<void> {
  return enqueue(scope, async () => {
    queuedWrite.delete(scope);
    await persist(state, scope).catch(() => persist(state, scope));
    const m = journalMeta(scope);
    if (m.bytes > 0 || existsSync(journalPath(scope))) {
      await writeFile(journalPath(scope), "", { mode: 0o600 });
    }
    m.bytes = 0;
    m.lastCheckpointAtMs = Date.now();
  });
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
  await persistOrMark(state, scope, { file: s.path });
}

/** Persist the daemon's resolved watch roots (see HxState.effectiveRoots).
 *  A checkpoint, deliberately: startWatch's publishRoots latch only advances
 *  after the write SUCCEEDS (its retry contract), so this write must fail
 *  loudly rather than vanish into a dirty flag. Rare (signature changes +
 *  a 10-min restamp), so the cost is nil. */
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
  await checkpoint(state, scope);
}

/** Persist the cached state after in-place mutations (childUploaders map,
 *  offset zeroing on a lane flip). Same single-writer discipline as every
 *  other writer here — only the process that owns the lane calls this. A
 *  whole-state mutation: the daemon's next flush point is a checkpoint. */
export async function persistState(scope: StateScope = "main"): Promise<void> {
  const state = await loadState(scope);
  await persistOrMark(state, scope, "all");
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
  // Journaled before returning, in BOTH modes: a committed-byte offset must be
  // durable before the next fan-out step starts (today's guarantee). Vault-
  // routed and fortress-direct canonicals have NO divergence heal, so a lost
  // offset there means silently duplicated bytes after a hard kill — the one
  // unrecoverable crash-loss class this file could create. Never coalesce it.
  await journalThrough(scope, [{ t: "file", path: filePath, state: existing }]);
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
  // Coalesce-eligible: add-at-zero/prune edits re-derive from the next
  // append-url's destination set; a lost key reads as offset 0, so no
  // committed-byte durability rides on this write.
  if (changed) await persistOrMark(state, scope, { file: filePath });
}

/**
 * Drop offset keys naming a destination this device has no evidence of, on
 * files that are no longer on disk.
 *
 * `reconcileDestinations` already prunes a departed destination, but only from
 * inside the append-url path — so it can only ever repair a file the daemon
 * still uploads. A file that has left the disk is never attempted again, so a
 * key it picked up while some org's Fortress enrollment was briefly live stays
 * in state forever.
 *
 * The conditions are the same ones isPhantomKey applies, plus absence from
 * disk: a key that has been written to is proof of a real store, a registry
 * that has never been recorded judges nothing, and a live file is left to
 * append-url's reconcile, which is the right repair for it.
 */
export async function pruneStrandedOffsets(
  scope: StateScope = "main",
  onDisk: (filePath: string) => boolean = existsSync,
): Promise<{ keys: number; files: number }> {
  const state = await loadState(scope);
  const pruned = pruneStrandedOffsetsFrom(state, onDisk);
  if (pruned.keys > 0) await checkpoint(state, scope);
  return pruned;
}

/** The prune itself, as a pure mutation — exported so the contract above is
 *  directly tested without a filesystem. */
export function pruneStrandedOffsetsFrom(
  state: HxState,
  onDisk: (filePath: string) => boolean,
): { keys: number; files: number } {
  if (state.destinations === undefined) return { keys: 0, files: 0 };
  const everWritten = new Set<string>();
  for (const fs of Object.values(state.files)) {
    for (const [k, offset] of Object.entries(fs.offsets ?? {})) {
      if (offset > 0) everWritten.add(k);
    }
  }
  let keys = 0;
  let files = 0;
  for (const [filePath, fs] of Object.entries(state.files)) {
    const offsets = fs.offsets ?? {};
    const dead = Object.entries(offsets).filter(
      ([k, offset]) =>
        k !== destKey(null) &&
        offset === 0 &&
        !everWritten.has(k) &&
        state.destinations?.[k] === undefined,
    );
    if (dead.length === 0 || onDisk(filePath)) continue;
    for (const [k] of dead) delete offsets[k];
    keys += dead.length;
    files += 1;
  }
  return { keys, files };
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
  // The chattiest mutator (fires per active file per tick) — the reason
  // coalesced mode exists. Loss on a hard kill costs one re-stat.
  await persistOrMark(state, scope, { file: filePath });
}

/** Per-file retry backoff cap — a broken file retries at most every 30 min.
 *  The workflow-sidecar backoff in watch.ts shares it. */
export const FILE_BACKOFF_CAP_MS = 30 * 60_000;

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
  await persistOrMark(state, scope, { file: filePath });
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
  // Coalesce-eligible: a failure stamp lost to a hard kill re-latches on the
  // very next failed attempt — and a daemon restart deliberately clears
  // generic backoffs anyway.
  await persistOrMark(state, scope, { file: filePath });
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
  await persistOrMark(state, scope, { file: filePath });
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
  // Journaled before returning (transition-gated): a lost heal-streak clear
  // would let a later genuine divergence trip the 6 h heal pause early.
  await journalThrough(scope, [{ t: "file", path: filePath, state: existing }]);
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
  // Journaled before returning (transition-gated): this clear runs right after
  // a recovery upload; losing it to a hard kill would keep a phantom "waiting"
  // row (the skipReason survives clearGenericBackoffs by design) for up to the
  // 30-min backoff cap while the offsets already say the file is delivered.
  await journalThrough(scope, [{ t: "file", path: filePath, state: existing }]);
}

/** Clear only transient destination holds so the next daemon pass retries them
 *  immediately. The caller stops the daemon first, preserving state.json's
 *  single-writer invariant. */
export async function clearBlockedFailures(
  scope: StateScope = "main",
): Promise<{ files: number; sessions: number }> {
  const state = await loadState(scope);
  const cleared = clearBlockedFailuresFromState(state);
  if (cleared.files > 0) await persistOrMark(state, scope, "all");
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
  if (cleared.files > 0) await persistOrMark(state, scope, "all");
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
  if (files > 0) await persistOrMark(state, scope, "all");
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
  // Coalesce-eligible: the server-side tombstone is authoritative — a record
  // lost to a hard kill re-latches on the next 410.
  await persistOrMark(state, scope, { deletedSessions: true });
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

/** Learned chunk cap for one destination, if any (see HxState.chunkCaps). */
export async function getChunkCap(
  key: string,
  scope: StateScope = "main",
): Promise<number | undefined> {
  const state = await loadState(scope);
  return state.chunkCaps?.[key];
}

/** Persist a learned chunk cap. Coalesce-eligible: a cap lost to a hard kill
 *  merely re-probes once, and the probe is side-effect-free by design. */
export async function setChunkCap(
  key: string,
  capBytes: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (!state.chunkCaps) state.chunkCaps = {};
  state.chunkCaps[key] = capBytes;
  await persistOrMark(state, scope, { chunkCap: key });
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
  await persistOrMark(state, scope, { artifact: key });
}
