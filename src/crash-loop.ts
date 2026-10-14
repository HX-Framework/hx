// Crash-loop backoff for `hx watch`.
//
// On 2026-10-14 launchd restarted a daemon that kept freezing 12 times in five
// hours, and every start re-ran the unwindowed canonical audit and the
// attribution sweeps against the gateway. With the watchdog thread
// (watchdog.ts) a broken daemon dies within a minute instead of hours, so a
// persistent fault would turn into a restart every minute or two. This module
// spaces those restarts out.
//
// Abnormal exit: a run of the long-running `hx watch` that ended without a
// deliberate stop (SIGINT, or SIGTERM from `hx stop`, the service manager, a
// logout). Each run writes a marker, ~/.let/hx/watch-run.json, when it starts
// and removes it when it is told to stop. A marker that is still there at the
// next start, with its process gone, is an abnormal exit: a watchdog kill (the
// worker writes the reason into the marker before it kills), a non-zero exit
// (the `exit` handler writes the code, e.g. 70 from the progress watchdog in
// watch.ts), or a crash or a signal (no reason recorded: nothing runs then).
//
// Backoff: when CRASH_LOOP_EXITS or more abnormal exits happened in the last
// CRASH_LOOP_WINDOW_MS, the next start waits before its first pass: 1 min,
// doubling with each further abnormal exit, up to 30 min. Time spent waiting
// does not count toward the window. With a plain clock window, a daemon that
// keeps crashing at the 30-min cap drops its old exits out of the window and
// the delay collapses back to 1 min (simulated: about 5 restarts an hour
// instead of 2). Excluding the waits keeps it at the cap until the daemon
// runs for 30 min without an abnormal exit.
//
// A start that a person asked for (`hx start`, `hx restart`, `hx update`,
// `hx connect`, the UI's buttons) clears the history first: someone changed
// something, so the next daemon starts at once. See clearCrashHistory and
// getDaemonOps in daemon.ts.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HX_DIR } from "./hx-home.js";

/** This many abnormal exits inside the window start the backoff. */
export const CRASH_LOOP_EXITS = 3;
export const CRASH_LOOP_WINDOW_MS = 30 * 60_000;
export const CRASH_LOOP_FIRST_DELAY_MS = 60_000;
export const CRASH_LOOP_MAX_DELAY_MS = 30 * 60_000;
/** History older than this (waits excluded) is dropped; it can never count. */
const KEEP_EXITS_MS = 24 * 60 * 60_000;
const KEEP_EXITS_MAX = 50;

export const RUN_MARKER_FILE = "watch-run.json";
export const EXITS_FILE = "watch-exits.json";

export interface RunMarker {
  pid: number;
  startedAtMs: number;
  /** Why the run ended, when something got to say so before it did. */
  endedBy?: string;
  endedAtMs?: number;
}

export interface AbnormalExit {
  pid: number;
  atMs: number;
  /** atMs minus the backoff time waited before it: the clock the window uses. */
  effAtMs: number;
  reason: string;
}

interface ExitsFile {
  /** Total backoff time ever waited; effective time = now − waitedMs. */
  waitedMs: number;
  exits: AbnormalExit[];
}

/** Pure: the wait before the first pass, given the exits and the effective now. */
export function crashLoopDelayMs(exits: readonly AbnormalExit[], effNowMs: number): { delayMs: number; recent: number } {
  const recent = exits.filter((e) => e.effAtMs > effNowMs - CRASH_LOOP_WINDOW_MS).length;
  if (recent < CRASH_LOOP_EXITS) return { delayMs: 0, recent };
  const delayMs = Math.min(CRASH_LOOP_MAX_DELAY_MS, CRASH_LOOP_FIRST_DELAY_MS * 2 ** (recent - CRASH_LOOP_EXITS));
  return { delayMs, recent };
}

export interface WatchRun {
  /** Wait this long before the first pass (0 = start now). */
  delayMs: number;
  /** Abnormal exits inside the window, the previous run's included. */
  recentExits: number;
  /** The previous run, when it ended abnormally. */
  previous: AbnormalExit | null;
  /** This run's marker, for the watchdog thread to annotate before a kill. */
  marker: { path: string; content: RunMarker };
  /** A deliberate stop: removes this run's marker. Idempotent. */
  markCleanStop(): void;
  /** The `exit` handler's half: keep the marker and record why. */
  markExit(code: number): void;
}

export interface BeginWatchRunOptions {
  dir?: string;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/**
 * Start-of-run bookkeeping for the long-running `hx watch`: count the previous
 * run if it ended abnormally, decide the backoff, and write this run's marker.
 * Synchronous and best-effort: an unwritable ~/.let/hx costs the backoff, never
 * the daemon.
 */
export function beginWatchRun(opts: BeginWatchRunOptions = {}): WatchRun {
  const dir = opts.dir ?? HX_DIR;
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  const markerPath = join(dir, RUN_MARKER_FILE);
  const exitsPath = join(dir, EXITS_FILE);

  const history = readExits(exitsPath);
  let previous: AbnormalExit | null = null;
  const old = readMarker(markerPath);
  // A live pid that isn't ours is another `hx watch` (a foreground run beside
  // the service): not an exit. Our own pid means the old run is gone and the
  // OS reused its pid for us — common in a container, where pids restart low.
  if (old && (old.pid === pid || !isAlive(old.pid))) {
    const atMs = old.endedAtMs ?? nowMs;
    previous = {
      pid: old.pid,
      atMs,
      effAtMs: atMs - history.waitedMs,
      reason: old.endedBy ?? "ended without a clean shutdown (a crash or a signal)",
    };
    history.exits.push(previous);
  }
  const effNowMs = nowMs - history.waitedMs;
  history.exits = history.exits.filter((e) => e.effAtMs > effNowMs - KEEP_EXITS_MS).slice(-KEEP_EXITS_MAX);
  const { delayMs, recent } = crashLoopDelayMs(history.exits, effNowMs);
  history.waitedMs += delayMs;
  if (previous || delayMs > 0) writeJson(exitsPath, history);

  const content: RunMarker = { pid, startedAtMs: nowMs };
  writeJson(markerPath, content);

  let stopped = false;
  return {
    delayMs,
    recentExits: recent,
    previous,
    marker: { path: markerPath, content },
    markCleanStop() {
      if (stopped) return;
      stopped = true;
      const m = readMarker(markerPath);
      if (!m || m.pid !== pid) return;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readMarker
        unlinkSync(markerPath);
      } catch {
        // already gone
      }
    },
    markExit(code) {
      if (stopped) return;
      const m = readMarker(markerPath);
      // Gone, someone else's, or the watchdog already said why.
      if (!m || m.pid !== pid || m.endedBy) return;
      // Bun reports code 0 for an exit on an unhandled rejection (the process
      // really exits 1), so 0 without a stop request is abnormal too.
      writeJson(markerPath, {
        ...m,
        endedBy: code ? `exit code ${code}` : "exited without a stop request",
        endedAtMs: now(),
      });
    },
  };
}

/**
 * Hook a run to the process: SIGINT and SIGTERM mark it cleanly stopped, and
 * any other exit records its code. Call this BEFORE anything else listens for
 * those signals (cmdWatch calls it ahead of startWatch). Node and Bun call
 * listeners in registration order, so when a signal arrives, every other
 * listener is still registered while this one runs: state.ts flushes and
 * re-raises, cmdWatch's SIGINT handler exits 0, and this one only records the
 * stop. With no other listener (the backoff wait, before startWatch arms
 * them), it re-raises the signal itself so the default action ends the
 * process, exactly as it would have ended without this hook.
 */
export function hookWatchRunToProcess(run: WatchRun): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      run.markCleanStop();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }
  process.on("exit", (code) => run.markExit(code));
}

/** The one line a start logs about the previous run and the backoff, or null.
 *  Both shapes read as warnings in the UI's log view ("backing off",
 *  "warning"; classifyLogLine in ui/data.ts), which is where the reason for a
 *  watchdog kill surfaces: the kill line itself goes to stderr.log. */
export function describeWatchRun(run: Pick<WatchRun, "delayMs" | "recentExits" | "previous">): string | null {
  const window = `${CRASH_LOOP_WINDOW_MS / 60_000} min`;
  if (run.delayMs > 0) {
    const why = run.previous ? ` (previous run: ${run.previous.reason})` : "";
    return `[hx] crash loop: ${run.recentExits} abnormal exits in the last ${window}${why}; backing off ${Math.round(run.delayMs / 60_000)} min before the first pass`;
  }
  if (run.previous) {
    return `[hx] warning: the previous run (pid ${run.previous.pid}) ended abnormally: ${run.previous.reason}; ${run.recentExits} abnormal exit${run.recentExits === 1 ? "" : "s"} in the last ${window}`;
  }
  return null;
}

/** Forget every recorded abnormal exit: the next start does not back off. */
export function clearCrashHistory(dir: string = HX_DIR): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readMarker
    unlinkSync(join(dir, EXITS_FILE));
  } catch {
    // nothing recorded
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, and someone else's.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readMarker(path: string): RunMarker | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed name under ~/.let/hx (tests pass a tmp dir)
    const m = JSON.parse(readFileSync(path, "utf8")) as Partial<RunMarker>;
    if (!Number.isInteger(m.pid) || (m.pid as number) <= 0 || typeof m.startedAtMs !== "number") return null;
    return {
      pid: m.pid as number,
      startedAtMs: m.startedAtMs,
      endedBy: typeof m.endedBy === "string" ? m.endedBy : undefined,
      endedAtMs: typeof m.endedAtMs === "number" ? m.endedAtMs : undefined,
    };
  } catch {
    return null;
  }
}

function readExits(path: string): ExitsFile {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readMarker
    const f = JSON.parse(readFileSync(path, "utf8")) as Partial<ExitsFile>;
    const exits = Array.isArray(f.exits)
      ? f.exits.filter(
          (e): e is AbnormalExit =>
            typeof e?.atMs === "number" && typeof e.effAtMs === "number" && typeof e.reason === "string",
        )
      : [];
    return { waitedMs: typeof f.waitedMs === "number" && f.waitedMs >= 0 ? f.waitedMs : 0, exits };
  } catch {
    return { waitedMs: 0, exits: [] };
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readMarker
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readMarker
    renameSync(tmp, path);
  } catch {
    // Best-effort (see beginWatchRun).
  }
}
