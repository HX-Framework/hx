// The slow, unwindowed sweep.
//
// Live discovery prunes to RECENT_WINDOW_MS (30 days) — twice, at the project
// directory AND at the file (sources.ts). That bound exists for CADENCE: the
// watch loop sweeps every FAST_POLL_MS (1.5s), and statting ~100k files each
// pass took ~7s, so the daemon never idled and burned a core. It is the right
// bound for a hot loop.
//
// It is the wrong bound for durability, and until now it was doing both jobs.
// One constant answered two unrelated questions — "what do I stat every 1.5
// seconds?" and "what will I EVER upload?" — so a file that went 30 days
// without being ingested was silently abandoned. Measured on one real device:
// 106 files, 112.5 MB, spanning May–June, with no upload state at all. Install
// hx on a laptop with two years of history and only the last 30 days would
// ever reach the server, with nothing anywhere saying otherwise.
//
// reattribute.ts already runs discovery UNWINDOWED and its comment names the
// split exactly ("live ingest prunes to 30 days for cadence, but the sweep
// must reach every file still on disk"). But it then skips files with no
// upload state, reasoning that "live ingest owns them" — which is false for
// anything past the window, since live ingest cannot see them. Those files
// fell between the two mechanisms: the hot loop would not look, and the sweep
// would not touch. This module closes that gap.
//
// Cheap because it is rare: once on daemon start, then hourly. Everything it
// finds is handed to the ordinary upload path, so election, settings filters,
// tombstones, routing and backoff all behave identically to a live file.
//
// The sweep is unwindowed on BOTH sides. It used to mirror the live window and
// consider only files OLDER than 30 days, on the theory that the hot loop owned
// everything newer. That theory has a hole: the hot loop prunes at the project
// DIRECTORY as well as the file, and appending to a transcript does not bump
// its parent directory's mtime. A file written five minutes ago inside a
// directory untouched for a year is therefore invisible to the hot loop (dir
// pruned) AND was invisible here (file too new) — owed forever, and reported as
// owed, because computeSyncReport scans unwindowed. Selection now turns on
// owed-ness alone: still on disk, not yet fully delivered. The call-site merge
// is what keeps the two paths from queueing the same file twice.

import {
  discoverClaudeChildren,
  discoverClaudeFiles,
  discoverCodexFiles,
  type DiscoveredChildFile,
  type DiscoveredFile,
  type DiscoveredWorkflowRun,
} from "./sources.js";
import { minOffset, type HxState } from "./state.js";
import type { ResolvedRoots } from "./roots.js";

/** How often the unwindowed sweep runs. Rare on purpose — it is the expensive
 *  scan the 30-day window exists to avoid doing every 1.5s. */
export const BACKFILL_INTERVAL_MS = 60 * 60_000;

/**
 * From an UNWINDOWED discovery, every file that is still owed bytes.
 *
 * The rule is owed-ness, nothing else: on disk, and not yet fully delivered.
 * There is deliberately no age test. Age was a proxy for "the hot loop owns
 * this", and it is a false proxy — the hot loop prunes whole project
 * directories by their own mtime, which appending to a transcript never bumps,
 * so recent files inside dormant directories belong to no sweep at all. What
 * age bought was avoiding duplicate work, and mergeBackfill buys that directly
 * by path, which is exact where age was only a guess.
 *
 * Includes both "no upload state at all" (never seen — the stranded case) and
 * "seen but never finished" (a partial abandoned mid-upload). Both are still on
 * disk, so both are recoverable; resuming from a recorded offset is what the
 * normal append path already does, and a file with no state is seeded exactly
 * as a fresh one would be. Pure so the selection rule is unit-tested without
 * touching a filesystem.
 */
export function selectBackfill(
  all: DiscoveredFile[],
  state: HxState,
  _nowMs?: number,
): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const f of all) {
    const fs = state.files[f.path];
    // Already delivered everywhere — nothing to do. minOffset (not a single
    // destination) so a file still owed to one store stays eligible.
    if (fs && minOffset(fs) >= f.size) continue;
    out.push(f);
  }
  return out;
}

/**
 * Merge a sweep result into the pass's file list, dropping anything the pass
 * already holds. This is the ONLY thing standing between the two sweeps and
 * duplicate work, now that selection no longer partitions by age.
 *
 * Deduping matters more than it looks: downstream, a path appearing twice in
 * one pass reads as two devices contending for one session, and the contention
 * path resets offsets. Collapsing against `files` AND within `older` keeps that
 * from being reachable. Pure and total — no state, no clock.
 */
export function mergeBackfill(
  files: DiscoveredFile[],
  older: DiscoveredFile[],
): { files: DiscoveredFile[]; added: DiscoveredFile[] } {
  const seen = new Set(files.map((f) => f.path));
  const added: DiscoveredFile[] = [];
  for (const f of older) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    added.push(f);
  }
  return { files: added.length > 0 ? [...files, ...added] : files, added };
}

/** Unwindowed discovery + selection. Callers pass the result through
 *  mergeBackfill into the pass's file list BEFORE election and filtering, so a
 *  backfilled file is subject to exactly the same gates as a live one. */
export async function discoverBackfill(
  roots: ResolvedRoots,
  state: HxState,
  nowMs: number,
): Promise<DiscoveredFile[]> {
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(roots.claude, { maxAgeMs: Infinity }),
    discoverCodexFiles(roots.codex, { maxAgeMs: Infinity }),
  ]);
  return selectBackfill([...claude, ...codex], state, nowMs);
}

/** Per-lane schedule for the sweep. Module state rather than a field on the
 *  watch loop so one-shot callers (`hx tick`) also get a first sweep. */
const lastRunAtMs = new Map<string, number>();

/** True when this lane is due a sweep. The FIRST call for a lane is always
 *  due: a daemon that restarts more often than the interval would otherwise
 *  never sweep at all. */
export function backfillDue(
  lane: string,
  nowMs: number,
  intervalMs = BACKFILL_INTERVAL_MS,
): boolean {
  const last = lastRunAtMs.get(lane);
  return last === undefined || nowMs - last >= intervalMs;
}

export function markBackfillRun(lane: string, nowMs: number): void {
  lastRunAtMs.set(lane, nowMs);
}

/** Test seam — forget every lane's schedule. */
export function resetBackfillSchedule(): void {
  lastRunAtMs.clear();
}

// ── Child lanes ─────────────────────────────────────────────────────────────
//
// The child half of discovery had the same hole as the parent half, plus one
// of its own. Child discovery prunes by project-DIRECTORY mtime exactly like
// the parent walk, and it windowed each agent transcript by mtime on top of
// that. But child lanes are routinely held back for reasons that have nothing
// to do with the file: the parent-lane latch freezes ALL child uploads while
// parent uploads continue, and an offline vault benches individual children.
// A lane parked by either mechanism goes quiet, and 30 days of quiet used to
// remove it from discovery permanently — while the ledger kept billing it as
// owed. Owed-but-unreachable is precisely the failure this module exists to
// eliminate, so the child sweep mirrors the parent one: unwindowed discovery,
// selection on owed-ness, and a path-level merge at the call site.

/**
 * The child analog of selectBackfill: every discovered lane still owed bytes.
 *
 * Same rule, same reasons — on disk, not fully delivered, no age test. Lanes
 * with no state entry at all are included; a child with no state is seeded
 * lazily by the ingest path exactly as a fresh one is.
 */
export function selectChildBackfill(
  all: DiscoveredChildFile[],
  state: HxState,
): DiscoveredChildFile[] {
  const out: DiscoveredChildFile[] = [];
  for (const c of all) {
    const fs = state.files[c.path];
    if (fs && minOffset(fs) >= c.size) continue;
    out.push(c);
  }
  return out;
}

/**
 * Merge a child sweep into the pass's lanes.
 *
 * The dedupe is load-bearing in a way the parent one is not. Downstream,
 * contestedChildLanes counts RAW entries per lane, so one path appearing twice
 * in a pass is indistinguishable from two devices racing for the same lane —
 * which routes it into the lane-reset arm and clears its offsets. A duplicate
 * introduced here would therefore re-upload a perfectly healthy lane from byte
 * zero, once an hour, forever. Runs get the same fill-missing merge the walk
 * applies across project dirs and roots, for the same reason: two entries
 * sharing an upload key re-send the sidecar every pass.
 */
export function mergeChildBackfill(
  children: DiscoveredChildFile[],
  runs: DiscoveredWorkflowRun[],
  sweptChildren: DiscoveredChildFile[],
  sweptRuns: DiscoveredWorkflowRun[],
): {
  children: DiscoveredChildFile[];
  runs: DiscoveredWorkflowRun[];
  added: DiscoveredChildFile[];
} {
  const seen = new Set(children.map((c) => c.path));
  const added: DiscoveredChildFile[] = [];
  for (const c of sweptChildren) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    added.push(c);
  }

  const mergedRuns = runs.map((r) => ({ ...r }));
  const runKey = (r: DiscoveredWorkflowRun): string => `${r.parentSessionId}\u0000${r.runId}`;
  const byKey = new Map(mergedRuns.map((r) => [runKey(r), r]));
  for (const r of sweptRuns) {
    const existing = byKey.get(runKey(r));
    if (!existing) {
      const copy = { ...r };
      mergedRuns.push(copy);
      byKey.set(runKey(copy), copy);
      continue;
    }
    if (r.journalPath && !existing.journalPath) existing.journalPath = r.journalPath;
    if (r.scriptPath && !existing.scriptPath) {
      existing.scriptPath = r.scriptPath;
      existing.scriptName = r.scriptName;
    }
    existing.mtimeMs = Math.max(existing.mtimeMs, r.mtimeMs);
  }

  return {
    children: added.length > 0 ? [...children, ...added] : children,
    runs: mergedRuns,
    added,
  };
}

/** Unwindowed child discovery + owed-ness selection. Lane key is separate
 *  from the parent sweep's so each keeps its own hourly schedule (and its own
 *  always-due first call after a restart). */
export async function discoverChildBackfill(
  roots: ResolvedRoots,
  state: HxState,
): Promise<{ children: DiscoveredChildFile[]; runs: DiscoveredWorkflowRun[] }> {
  const { children, runs } = await discoverClaudeChildren(roots.claude, { maxAgeMs: Infinity });
  return { children: selectChildBackfill(children, state), runs };
}
