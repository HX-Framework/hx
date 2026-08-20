// The sync ledger: every tracked session sorted into exactly one bucket, and
// the one percentage `hx status` prints.
//
// Why this exists — the old `Sync 97%` was `min(offsets) >= size` folded over
// every file (see snapshotFrom). Two things made that number unreadable:
//
//   1. minOffset() collapses destinations. A session fully delivered to the
//      primary store but 0% delivered to a second, OFFLINE Fortress scored 0
//      and counted as "not done". One unreachable destination therefore held
//      the whole device below 100% forever — the number could only reach 100%
//      if every Fortress the device had ever fanned out to was simultaneously
//      online.
//   2. A live session always has a few unsent bytes between the write and the
//      next ~1.5s tick, so an in-use machine never sat at 100% either.
//
// The percentage here answers "is anything wrong?", not "is every byte
// everywhere?". Sessions the user cannot act on — a tail still being written,
// a store that is offline — leave the denominator entirely, so a healthy
// machine rests at 100%. Leaving 100% now means exactly one of two things: a
// real backlog that is draining, or real data loss. Both are worth reading.

import { destKey, minOffset, type FileState, type HxState } from "./state.js";

/**
 * How long after its last write a session still counts as "in progress".
 *
 * This is the knob that keeps the number steady. A live jsonl is appended
 * continuously while the daemon ticks every ~1.5s, so at almost any instant it
 * has an unsent tail; counting that tail as backlog makes the percentage
 * twitch off 100% permanently on any machine in use. Generous on purpose — a
 * session you are merely thinking in must not read as a stalled upload. When
 * the window lapses the session is reclassified normally, so this delays
 * classification, it never suppresses it.
 */
export const LIVE_WINDOW_MS = 15 * 60_000;

/** Which bucket a session is in. Exactly one per session; they sum to `total`. */
export type SessionState =
  /** Reached every destination that is currently reachable. */
  | "delivered"
  /** LOCAL state, not a delivery state: an agent or a human is still writing
   *  this session on this device (inside {@link LIVE_WINDOW_MS}). Excluded
   *  from the % — a session still being produced is not a sync failure. */
  | "live"
  /** A REACHABLE destination is still owed bytes — a real backlog, counted. */
  | "uploading"
  /** Only OFFLINE destinations are owed bytes — excluded from the %. */
  | "waiting"
  /** Source file no longer on disk and delivery was never confirmed. There is
   *  nothing left to send and nothing to act on, so this is REPORTED but never
   *  counted — see SyncLedger.notOnDisk. */
  | "incomplete";

/** A destination owing bytes to at least one waiting session. */
export interface DestinationLag {
  /** Stable state key ({@link destKey}) — "letai" for the shared bucket. */
  key: string;
  vaultOrgId: string | null;
  /** Display name: remembered org name, else the raw id. */
  label: string;
  /** Distinct sessions in the `waiting` bucket this destination owes bytes to. */
  sessions: number;
  /** Sum of those sessions' undelivered bytes to THIS destination. */
  bytes: number;
  /** Gateway-observed Fortress heartbeat (ISO), when known. */
  lastSeenAt: string | null;
  /** How long it has been offline, in whole days, when known. */
  offlineDays: number | null;
}

export interface SyncLedger {
  total: number;
  totalBytes: number;
  /** Oldest and newest last-activity time across the sessions still ON DISK,
   *  in epoch ms; null when none are. Drives the status "Session range" row.
   *  Deliberately excludes `incomplete` sessions — their source file is gone,
   *  so there is no mtime to read and they are no longer on this device. */
  oldestMs: number | null;
  newestMs: number | null;
  delivered: number;
  live: number;
  uploading: number;
  waiting: number;
  /** The subset of `waiting` with NO complete copy at any reachable store — a
   *  customer-Fortress session whose only whole transcript is the local file.
   *  Counted in the percentage, unlike the rest of `waiting`: it is actionable
   *  (bring the Fortress back) and it has a deadline (Claude Code prunes at 30
   *  days), after which the session is genuinely gone. */
  waitingUnprotected: number;
  /** Sessions whose local file is gone and whose delivery was never confirmed.
   *
   *  Deliberately OUTSIDE `total` and outside the percentage. Claude Code prunes
   *  transcripts after 30 days, so every session eventually leaves the disk;
   *  counting the unconfirmed ones as a fault built a pile that only ever grew,
   *  and nothing in it can be acted on — there is no file left to send. Measured
   *  on two real devices, that pile was wrong 8 times out of 10 and roughly 100
   *  times out of 103: the sessions were on the server all along.
   *
   *  A device that genuinely cannot upload is still loud while it matters —
   *  `failing` names a rejecting store and `uploading` climbs, both for the ~30
   *  days before anything is pruned. This number is the post-hoc record, kept
   *  for diagnostics only. */
  incomplete: number;
  /** delivered / (delivered + uploading), floored. 100 when idle. */
  percent: number;
  /** On-disk bytes of the sessions that have actually landed everywhere. */
  deliveredBytes: number;
  /** Undelivered bytes to reachable destinations — the real backlog. */
  uploadingBytes: number;
  /** Bytes still owed to offline stores, counted ONCE per session (its largest
   *  single-destination debt). The per-destination totals in `lagging` do
   *  double-count a fanned-out session, deliberately — each store really is
   *  owed those bytes — but a headline "held" figure must not. */
  waitingBytes: number;
  /** Dead offset keys carried by on-disk sessions whose bytes are already safe
   *  at a reachable store. Excluded from `uploadingBytes` and the percentage,
   *  reported so they can be recognised and cleared. */
  stranded: StrandedDestination[];
  /** Per-session detail for every on-disk session that still owes bytes —
   *  what `hx status --detailed` prints so a stuck session explains itself. */
  notDelivered: SessionDiagnosis[];
  /** Offline destinations holding waiting sessions, worst (oldest) first. */
  lagging: DestinationLag[];
  /** Reachable destinations rejecting writes, longest-failing first. Uploading
   *  sessions aimed at these are counted in the % as usual (the store IS
   *  reachable — bytes should be moving), but the headline names the failure
   *  instead of reading as an innocent backlog. */
  failing: FailingDestination[];
}

/** An offset key that owes bytes, has no registry entry, and is already moot —
 *  a reachable store holds the whole session. Nothing will ever be written to
 *  it, so it is kept out of the backlog and the percentage; it is reported
 *  because a key that appeared from nowhere and drains nowhere is a fault, and
 *  a device that stays silent about one carries it forever. */
export interface StrandedDestination {
  key: string;
  /** Friendly name where we have one, else the raw key. */
  label: string;
  /** Distinct on-disk sessions carrying this dead key. */
  sessions: number;
  /** Bytes those sessions nominally still "owe" it. */
  bytes: number;
}

/** One destination's standing for a session that still owes bytes. */
export interface DestinationStanding {
  /** Registry key ({@link destKey}) — "letai" for the shared bucket. */
  key: string;
  /** Friendly name where we have one, else the raw key. */
  label: string;
  offset: number;
  owed: number;
  /** `unknown` is the one that matters: an offset key with NO registry entry.
   *  The client has no evidence such a store exists, yet lagOf bills it as
   *  reachable — so a destination that was advertised once and never seen
   *  again pins a session in `uploading` forever, undrainable, with nothing
   *  in the log. That is exactly how one device sat at "17 sessions · 135.5 MB"
   *  unchanged for days. Naming it here is the whole point of this struct. */
  state: "reachable" | "offline" | "unknown";
}

/** Why one on-disk session is not delivered — enough to act on without a
 *  debugger. Built only for sessions that owe bytes, so it stays small. */
export interface SessionDiagnosis {
  sessionId: string;
  family: string;
  path: string;
  bucket: SessionState;
  sizeBytes: number;
  owedBytes: number;
  ageDays: number;
  /** Last time ANY byte of this session was committed, ISO; null if never. A
   *  session that owes bytes and has never uploaded is a different problem
   *  from one that stalled part-way, and the two were indistinguishable. */
  lastUploadAt: string | null;
  /** Per-file failure latches — why the tick would decline to try it. */
  skipReason: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  /** Gateway-confirmed workspace attribution, when the gateway has echoed it. */
  repoSlug: string | null;
  attributed: boolean | null;
  destinations: DestinationStanding[];
}

/** A discovered file, narrowed to what classification needs. */
export interface LedgerFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface LedgerInput {
  /** The ELECTED, watched files — one per session (twins already shadowed). */
  files: LedgerFile[];
  state: HxState;
  /** Distinct session ids whose source vanished mid-upload (permanently partial). */
  incompleteSessions: number;
  nowMs: number;
  /** vaultOrgId → friendly name, from the org-names cache. */
  orgNames?: Record<string, string>;
}

/**
 * Is this destination known to be unreachable right now?
 *
 * Read from the DURABLE registry, never from a file's `skipReason`/`blocker`:
 * both of those are latches that any clean pass clears, so a destination that
 * flaps is invisible to whichever instant the status happens to sample. That
 * is what hid an offline Fortress holding 165 MB across 16 sessions while
 * `hx status` named only the few files whose latch was set at the time.
 *
 * The primary shared bucket is never treated as offline: a total gateway
 * outage is reported by the connection probe, and excusing the primary would
 * let the device claim 100% while nothing at all was being delivered.
 */
export function isDestinationOffline(state: HxState, key: string): boolean {
  return destinationStanding(state, key) === "offline";
}

/**
 * Three-way standing for one offset key.
 *
 * `unknown` — an offset key with NO registry entry — is why this exists. A
 * two-way offline/not-offline test bills it as reachable, so a destination the
 * device has never heard of is owed every byte of the file forever: nothing
 * writes to it, so the debt never drains, and no error is ever logged because
 * no attempt is ever made. One device carried 43 such keys for an org that
 * advertised itself once during a routing-flag experiment and was never seen
 * again; they read as permanent backlog with an empty log beside them.
 */
export function destinationStanding(
  state: HxState,
  key: string,
): "reachable" | "offline" | "unknown" {
  // The primary shared bucket is always reachable and always known: a total
  // gateway outage is reported by the connection probe, and excusing the
  // primary would let the device claim 100% while nothing was being delivered.
  if (key === destKey(null)) return "reachable";
  const record = state.destinations?.[key];
  if (record === undefined) return "unknown";
  return record.status === "held" ? "offline" : "reachable";
}

/**
 * Is there a COMPLETE copy at a destination we can currently reach?
 *
 * This is what decides whether an offline Fortress owing bytes is merely slow
 * or is actually dangerous. When a session fans out and the shared store already
 * holds all of it, a lagging Fortress is a nuisance — the transcript is safe.
 * When a session lives ONLY in a customer Fortress (the residency rule: an org
 * with its own Fortress keeps its sessions there and nowhere else), an offline
 * Fortress means the sole complete copy is the local jsonl — and Claude Code
 * deletes that after 30 days. Same bucket, opposite stakes.
 */
function hasReachableCompleteCopy(
  fs: FileState | undefined,
  size: number,
  state: HxState,
): boolean {
  for (const [key, offset] of Object.entries(fs?.offsets ?? {})) {
    // Only a destination we know AND can reach is proof of safety. An unknown
    // key is not evidence of a stored copy — it is evidence of nothing.
    if (destinationStanding(state, key) !== "reachable") continue;
    if (offset >= size) return true;
  }
  return false;
}

/** Per-destination undelivered bytes for one file, split by reachability. */
function lagOf(
  fs: FileState | undefined,
  size: number,
  state: HxState,
): { reachable: number; offline: Map<string, number>; unknown: Map<string, number> } {
  const offline = new Map<string, number>();
  const unknown = new Map<string, number>();
  let reachable = 0;
  // A file with no recorded offsets has never been sent anywhere; bill it to
  // the primary destination so it reads as backlog rather than vanishing.
  const offsets = fs?.offsets ?? {};
  const keys = Object.keys(offsets);
  if (keys.length === 0) return { reachable: size, offline, unknown };
  for (const key of keys) {
    const pending = size - (offsets[key] ?? 0);
    if (pending <= 0) continue;
    switch (destinationStanding(state, key)) {
      case "offline":
        offline.set(key, pending);
        break;
      case "unknown":
        unknown.set(key, pending);
        break;
      default:
        reachable += pending;
    }
  }
  return { reachable, offline, unknown };
}

/** Classify one discovered file. `incomplete` is decided elsewhere (the source
 *  is gone, so there is no file here to classify). */
export function classifyFile(
  file: LedgerFile,
  state: HxState,
  nowMs: number,
): {
  state: Exclude<SessionState, "incomplete">;
  reachableBytes: number;
  offline: Map<string, number>;
  /** Debt owed to offset keys with no registry entry. Reported, never billed
   *  as backlog unless it is the ONLY record of the bytes (see below). */
  unknown: Map<string, number>;
  /** Waiting AND no complete copy anywhere reachable — the only whole
   *  transcript is the local file, which Claude Code prunes at 30 days. */
  unprotected: boolean;
  /** Unknown-key debt that a reachable store has already made moot. Inert: it
   *  is excluded from the backlog, so it must be REPORTED somewhere or the
   *  device goes quiet about a key it will carry forever. */
  strandedUnknown: boolean;
} {
  const fs = state.files[file.path];
  const { reachable, offline, unknown } = lagOf(fs, file.size, state);
  const complete = hasReachableCompleteCopy(fs, file.size, state);
  const unprotected = offline.size > 0 && !complete;
  const strandedUnknown = unknown.size > 0 && complete;
  // Live tail first, and unconditionally: see LIVE_WINDOW_MS. A session still
  // being written on this device is never a backlog and never a fault,
  // whatever it still owes.
  if (nowMs - file.mtimeMs < LIVE_WINDOW_MS) {
    return {
      state: "live",
      reachableBytes: reachable,
      offline,
      unknown,
      unprotected: false,
      strandedUnknown,
    };
  }
  if (reachable > 0) {
    return { state: "uploading", reachableBytes: reachable, offline, unknown, unprotected, strandedUnknown };
  }
  // Bytes owed ONLY to an unknown destination are not backlog: nothing will
  // ever write there, so counting them pins the percentage below 100 forever
  // for a debt no action can settle. They ARE a real fault when no destination
  // we can reach holds the whole file — that session is genuinely undelivered,
  // and the next append-url both sends it and prunes the dead key.
  if (unknown.size > 0 && !complete) {
    return {
      state: "uploading",
      reachableBytes: Math.max(...unknown.values()),
      offline,
      unknown,
      unprotected,
      strandedUnknown,
    };
  }
  if (offline.size > 0) {
    return { state: "waiting", reachableBytes: 0, offline, unknown, unprotected, strandedUnknown };
  }
  return {
    state: "delivered",
    reachableBytes: 0,
    offline,
    unknown,
    unprotected: false,
    strandedUnknown,
  };
}

function offlineDaysOf(state: HxState, key: string, nowMs: number): number | null {
  const since = state.destinations?.[key]?.heldSinceMs;
  if (since === undefined) return null;
  return Math.floor((nowMs - since) / 86_400_000);
}

/** Fold discovered files + persisted offsets into the ledger `hx status` prints. */
export function buildLedger(input: LedgerInput): SyncLedger {
  const { files, state, incompleteSessions, nowMs } = input;
  const orgNames = input.orgNames ?? {};

  let delivered = 0;
  let live = 0;
  let uploading = 0;
  let waiting = 0;
  let waitingUnprotected = 0;
  let totalBytes = 0;
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  let deliveredBytes = 0;
  let uploadingBytes = 0;
  let waitingBytes = 0;
  const lag = new Map<string, { sessions: number; bytes: number }>();
  const strandedLag = new Map<string, { sessions: number; bytes: number }>();
  const notDelivered: SessionDiagnosis[] = [];

  for (const file of files) {
    totalBytes += file.size;
    // mtime, not a parsed session start: it is what discovery already carries
    // for every family, and "last activity" is the honest thing to bound a
    // range by — a session resumed today belongs at today's end of it.
    if (oldestMs === null || file.mtimeMs < oldestMs) oldestMs = file.mtimeMs;
    if (newestMs === null || file.mtimeMs > newestMs) newestMs = file.mtimeMs;
    const c = classifyFile(file, state, nowMs);
    // Folded for EVERY bucket, delivered included: the whole point of the
    // stranded list is that these sessions are otherwise fully in the clear and
    // would appear nowhere at all.
    if (c.strandedUnknown) {
      for (const [key, pending] of c.unknown) {
        const entry = strandedLag.get(key) ?? { sessions: 0, bytes: 0 };
        entry.sessions += 1;
        entry.bytes += pending;
        strandedLag.set(key, entry);
      }
    }
    if (c.state !== "delivered") {
      const fs = state.files[file.path];
      const offsets = fs?.offsets ?? {};
      const keys = Object.keys(offsets);
      const standings: DestinationStanding[] = (keys.length === 0
        ? [{ key: destKey(null), offset: 0 }]
        : keys.map((k) => ({ key: k, offset: offsets[k] ?? 0 }))
      ).map(({ key, offset }) => {
        const record = state.destinations?.[key];
        const label =
          (record?.vaultOrgId && orgNames[record.vaultOrgId]) || record?.orgName || key;
        return {
          key,
          label,
          offset,
          owed: Math.max(0, file.size - offset),
          state: destinationStanding(state, key),
        };
      });
      if (standings.some((d) => d.owed > 0)) {
        notDelivered.push({
          sessionId: fs?.sessionId ?? file.path,
          family: fs?.family ?? "unknown",
          path: file.path,
          bucket: c.state,
          sizeBytes: file.size,
          owedBytes: standings.reduce((n, d) => n + d.owed, 0),
          ageDays: Math.floor((nowMs - file.mtimeMs) / 86_400_000),
          lastUploadAt: fs?.lastUploadAtMs ? new Date(fs.lastUploadAtMs).toISOString() : null,
          skipReason: fs?.skipReason ?? null,
          consecutiveFailures: fs?.consecutiveFailures ?? 0,
          nextAttemptAt: fs?.nextAttemptAtMs ? new Date(fs.nextAttemptAtMs).toISOString() : null,
          repoSlug: fs?.repoSlug ?? null,
          attributed: fs?.attributed ?? null,
          destinations: standings,
        });
      }
    }
    switch (c.state) {
      case "delivered":
        delivered += 1;
        deliveredBytes += file.size;
        break;
      case "live":
        live += 1;
        break;
      case "uploading":
        uploading += 1;
        uploadingBytes += c.reachableBytes;
        break;
      case "waiting": {
        waiting += 1;
        if (c.unprotected) waitingUnprotected += 1;
        // Only `waiting` sessions are billed to a destination, so the per-
        // destination counts and the Waiting total describe the same set. They
        // still sum to MORE than `waiting` when a session fans out to several
        // offline Fortresses — that overlap is real and is spelled out in the
        // detailed view rather than hidden by picking one owner.
        let largestDebt = 0;
        for (const [key, pending] of c.offline) {
          const entry = lag.get(key) ?? { sessions: 0, bytes: 0 };
          entry.sessions += 1;
          entry.bytes += pending;
          lag.set(key, entry);
          largestDebt = Math.max(largestDebt, pending);
        }
        // Once per session, not once per destination: a session owed to three
        // offline Fortresses is still one session's worth of held bytes.
        waitingBytes += largestDebt;
        break;
      }
    }
  }

  // `incompleteSessions` is deliberately absent: nothing in it is on disk, so
  // nothing in it can be sent, and a number nobody can act on does not belong
  // in a health percentage.
  // `waiting` normally stays out: a session already complete on a reachable
  // store is safe however long a secondary Fortress lags. But a session whose
  // ONLY complete copy is the local file is neither safe nor unactionable, and
  // excluding it let a device report "100% — all sessions sent" while a
  // transcript counted down to deletion. Those count.
  const sendable = delivered + uploading + waitingUnprotected;
  const percent = sendable === 0 ? 100 : Math.floor((delivered / sendable) * 100);

  const lagging: DestinationLag[] = [...lag.entries()]
    .map(([key, v]) => {
      const record = state.destinations?.[key];
      const vaultOrgId = record?.vaultOrgId ?? (key === destKey(null) ? null : key);
      const label = (vaultOrgId && orgNames[vaultOrgId]) || record?.orgName || vaultOrgId || key;
      return {
        key,
        vaultOrgId,
        label,
        sessions: v.sessions,
        bytes: v.bytes,
        lastSeenAt: record?.lastSeenAt ?? null,
        offlineDays: offlineDaysOf(state, key, nowMs),
      };
    })
    // Longest outage first: the one most likely to need a decision leads.
    .sort((a, b) => (b.offlineDays ?? -1) - (a.offlineDays ?? -1) || b.sessions - a.sessions);

  const stranded: StrandedDestination[] = [...strandedLag.entries()]
    .map(([key, v]) => {
      const record = state.destinations?.[key];
      const vaultOrgId = record?.vaultOrgId ?? (key === destKey(null) ? null : key);
      const label = (vaultOrgId && orgNames[vaultOrgId]) || record?.orgName || key;
      return { key, label, sessions: v.sessions, bytes: v.bytes };
    })
    .sort((a, b) => b.sessions - a.sessions || b.bytes - a.bytes);

  return {
    total: files.length,
    totalBytes,
    oldestMs,
    newestMs,
    delivered,
    live,
    uploading,
    waiting,
    waitingUnprotected,
    incomplete: incompleteSessions,
    percent,
    deliveredBytes,
    uploadingBytes,
    waitingBytes,
    notDelivered: notDelivered.sort((a, b) => b.owedBytes - a.owedBytes),
    stranded,
    lagging,
    failing: failingDestinations(state, nowMs, orgNames),
  };
}

/** "offline 13d" reads well; "offline 0d" reads like a bug. Below a day say so
 *  in words, and say nothing definite when the outage start is unknown. */
export function formatOutage(days: number | null): string {
  if (days === null) return "offline";
  if (days < 1) return "offline since today";
  return `offline ${days}d`;
}

/** Consecutive hard rejections before a destination reads as FAILING. One is a
 *  blip; three in a row with no successful commit between them is a condition. */
export const FAILING_AFTER = 3;

/** A reachable destination that is rejecting writes. Distinct from `lagging`
 *  (offline stores): those hold sessions safely, while a failing store means
 *  bytes SHOULD be moving and are not — the highest-urgency state, and the one
 *  the 2026-08-01 credential outage proved invisible without this. */
export interface FailingDestination {
  key: string;
  label: string;
  /** e.g. "403 SignatureDoesNotMatch" — the storage layer's own words. */
  errorCode: string;
  /** Whole hours since the current failure run began (0 for under an hour). */
  failingHours: number | null;
}

/** Reachable destinations currently latched on a hard-failure run. */
export function failingDestinations(
  state: HxState,
  nowMs: number,
  orgNames: Record<string, string> = {},
): FailingDestination[] {
  const out: FailingDestination[] = [];
  for (const [key, record] of Object.entries(state.destinations ?? {})) {
    if (record.status === "held") continue; // offline is the WAITING story
    if ((record.consecutiveErrors ?? 0) < FAILING_AFTER) continue;
    const label =
      (record.vaultOrgId && orgNames[record.vaultOrgId]) ||
      record.orgName ||
      (record.vaultOrgId === null || key === destKey(null) ? "primary store" : key);
    out.push({
      key,
      label,
      errorCode: record.lastErrorCode ?? "unknown error",
      failingHours:
        record.failingSinceMs === undefined
          ? null
          : Math.floor((nowMs - record.failingSinceMs) / 3_600_000),
    });
  }
  // Longest-running failure first — same rule as lagging.
  return out.sort((a, b) => (b.failingHours ?? -1) - (a.failingHours ?? -1));
}

/** How long a destination must be offline before waiting stops being a plan
 *  and the user is asked to make a call. */
export const NEEDS_YOU_DAYS = 7;

/** Destinations offline long enough that they will not fix themselves. */
export function needsAttention(ledger: SyncLedger): DestinationLag[] {
  return ledger.lagging.filter((d) => (d.offlineDays ?? 0) >= NEEDS_YOU_DAYS);
}

/** Legacy single-number view, kept for the gateway's sync-status wire format.
 *  Uses minOffset deliberately: the server-side bar predates the ledger. */
export function legacyDone(fs: FileState | undefined, size: number): boolean {
  if (!fs) return false;
  return minOffset(fs) >= size && !fs.skipReason;
}
