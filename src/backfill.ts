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

import { discoverClaudeFiles, discoverCodexFiles, type DiscoveredFile } from "./sources.js";
import { minOffset, type HxState } from "./state.js";
import type { ResolvedRoots } from "./roots.js";

/** How often the unwindowed sweep runs. Rare on purpose — it is the expensive
 *  scan the 30-day window exists to avoid doing every 1.5s. */
export const BACKFILL_INTERVAL_MS = 60 * 60_000;

/** Mirrors sources.ts RECENT_WINDOW_MS. Files newer than this are the live
 *  sweep's job; the backfill deliberately ignores them so the two paths never
 *  fight over the same file. */
export const LIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * From an UNWINDOWED discovery, the files live ingest can never reach: older
 * than the live window, and not yet fully delivered.
 *
 * Includes both "no upload state at all" (never seen — the stranded case) and
 * "seen but never finished" (a partial that aged out mid-upload). Both are
 * still on disk, so both are recoverable; resuming from a recorded offset is
 * what the normal append path already does, and a file with no state is seeded
 * exactly as a fresh one would be. Pure so the selection rule is unit-tested
 * without touching a filesystem.
 */
export function selectBackfill(
  all: DiscoveredFile[],
  state: HxState,
  nowMs: number,
  windowMs = LIVE_WINDOW_MS,
): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const f of all) {
    // Inside the window: the live sweep owns it. Leaving it alone keeps the
    // two paths from queueing the same file twice in one pass.
    if (nowMs - f.mtimeMs <= windowMs) continue;
    const fs = state.files[f.path];
    // Already delivered everywhere — nothing to do. minOffset (not a single
    // destination) so a file still owed to one store stays eligible.
    if (fs && minOffset(fs) >= f.size) continue;
    out.push(f);
  }
  return out;
}

/** Unwindowed discovery + selection. Callers merge the result into the pass's
 *  file list BEFORE election and filtering, so a backfilled file is subject to
 *  exactly the same gates as a live one. */
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
