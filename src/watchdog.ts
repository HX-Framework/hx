// Freeze and memory watchdog for `hx watch`, on its own thread.
//
// Why a thread: on 2026-10-14 an endless promise chain in the CCD reader
// starved the event loop of `hx watch`. No timer ran after that, so the
// progress watchdog in watch.ts (a setInterval on that same loop) could not
// fire, and the SIGINT/SIGTERM handlers (JavaScript, in cli.ts and state.ts)
// never ran either, so the process ignored stop signals. Memory grew about
// 4.6 MB/s until Bun crashed at 18 to 63 GB, and launchd restarted it into the
// same state. A worker has its own thread and its own event loop, so it keeps
// running while the main thread is stuck.
//
// How it works: the main thread adds 1 to a counter in a SharedArrayBuffer
// once a second. The worker wakes every CHECK_MS, reads the counter and the
// process RSS, and trips when
//   • the counter has not moved for `freezeSeconds` (default 60), or
//   • RSS is above `memoryCeilingMb` (default 1536).
// process.memoryUsage.rss() is process-wide when read from a worker (measured
// on Bun 1.3.14: a worker reads 631 MB after the main thread allocates 600 MB;
// ps says 632 MB). On a trip the worker appends one line to stderr.log,
// records the reason in the run marker (crash-loop.ts reads it at the next
// start), and sends SIGKILL to the whole process. SIGKILL because nothing else
// ends a frozen loop: SIGTERM and SIGINT reach only JavaScript handlers. The
// service manager then starts a fresh daemon (launchd KeepAlive, systemd
// Restart=always, the Task Scheduler repeat trigger, the container hook's
// loop), and crash-loop.ts backs off when that keeps happening.
//
// The freeze limit counts checks that saw no new beat instead of comparing
// clock readings: while a laptop sleeps both threads stop, and a clock-based
// check would read the whole sleep as a freeze on wake.
//
// The worker's code ships as source text in a Blob URL, not as a file of its
// own: `bun build --compile` embeds only the entry point's import graph, and
// `new Worker(new URL("./file.ts", import.meta.url))` fails in the compiled
// binary unless every build command (package.json, release.yml,
// dev-build.yml, install-from-source.ps1) also names the worker as an extra
// entry point. The three functions that run in the worker are serialized with
// Function.prototype.toString, so they must be self-contained: only their
// parameters and globals, no imports and no module-level names (node:fs comes
// from process.getBuiltinModule). The fixture tests run them in a real worker,
// so a stray reference fails there.

import { tuningValue, type HxSettings } from "./settings.js";

export const FREEZE_SECONDS_DEFAULT = 60;
/** A legitimately busy loop never blocks this long; a typo cannot go lower. */
export const FREEZE_SECONDS_MIN = 10;
export const MEMORY_CEILING_MB_DEFAULT = 1536;
/** Below the RSS of a healthy daemon on a large store; a typo cannot go lower. */
export const MEMORY_CEILING_MB_MIN = 512;

/** How often the worker looks. 250 ms bounds how far a fast runaway gets past
 *  the ceiling: the 2026-10-14 loop grew about 1.5 GB a second at its worst. */
const CHECK_MS = 250;
const BEAT_MS = 1_000;
/** settings.json is re-read this often, so a limit change needs no restart. */
const RELOAD_MS = 30_000;

// Int32 slots in the shared control buffer.
const SLOT_BEAT = 0;
const SLOT_STOP = 1;
const SLOT_FREEZE_SECONDS = 2;
const SLOT_CEILING_MB = 3;
const SLOT_CHECKS = 4;
const SLOT_COUNT = 5;

export interface WatchdogLimits {
  /** 0 = the freeze check is off. */
  freezeSeconds: number;
  /** 0 = the memory check is off. */
  memoryCeilingMb: number;
}

/** `tuning.freezeSeconds` and `tuning.memoryCeilingMb` from settings.json:
 *  absent or not a number → the default, 0 or less → off, anything else is
 *  rounded and raised to the floor. */
export function resolveWatchdogLimits(settings: HxSettings): WatchdogLimits {
  return {
    freezeSeconds: resolveLimit(tuningValue(settings, "freezeSeconds"), FREEZE_SECONDS_DEFAULT, FREEZE_SECONDS_MIN),
    memoryCeilingMb: resolveLimit(
      tuningValue(settings, "memoryCeilingMb"),
      MEMORY_CEILING_MB_DEFAULT,
      MEMORY_CEILING_MB_MIN,
    ),
  };
}

function resolveLimit(raw: unknown, fallback: number, floor: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  if (raw <= 0) return 0;
  return Math.max(floor, Math.round(raw));
}

// ── Worker side (serialized; see the header) ────────────────────────────────

export interface WatchdogCheckState {
  lastBeat: number;
  /** Consecutive checks that saw the same beat. */
  staleChecks: number;
}

export interface WatchdogReading {
  beat: number;
  rssBytes: number;
  freezeSeconds: number;
  memoryCeilingMb: number;
  checkMs: number;
}

export interface WatchdogTrip {
  limit: "freeze" | "memory";
  rssMb: number;
  /** Seconds since the worker last saw the beat move. */
  quietSeconds: number;
  /** The limit that tripped: seconds for "freeze", MB for "memory". */
  limitValue: number;
}

/** One check. Updates `state`, returns the limit that tripped or null. */
export function checkWatchdog(state: WatchdogCheckState, reading: WatchdogReading): WatchdogTrip | null {
  if (reading.beat !== state.lastBeat) {
    state.lastBeat = reading.beat;
    state.staleChecks = 0;
  } else {
    state.staleChecks += 1;
  }
  const quietMs = state.staleChecks * reading.checkMs;
  const rssMb = Math.round(reading.rssBytes / 1048576);
  const quietSeconds = Math.floor(quietMs / 1000);
  if (reading.memoryCeilingMb > 0 && rssMb > reading.memoryCeilingMb) {
    return { limit: "memory", rssMb, quietSeconds, limitValue: reading.memoryCeilingMb };
  }
  if (reading.freezeSeconds > 0 && quietMs >= reading.freezeSeconds * 1000) {
    return { limit: "freeze", rssMb, quietSeconds, limitValue: reading.freezeSeconds };
  }
  return null;
}

/** The stderr.log line for a trip, and the shorter reason the run marker keeps. */
export function describeWatchdogTrip(trip: WatchdogTrip, pid: number, at: Date): { line: string; reason: string } {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const what =
    trip.limit === "freeze"
      ? `the event loop has not run for ${trip.quietSeconds} s (freeze limit ${trip.limitValue} s)`
      : `rss ${trip.rssMb} MB is over the memory limit of ${trip.limitValue} MB`;
  const also =
    trip.limit === "freeze" ? `rss ${trip.rssMb} MB` : `the event loop last ran ${trip.quietSeconds} s ago`;
  return {
    line: `${stamp} [hx] watchdog: killing pid ${pid} with SIGKILL: ${what}; ${also}`,
    reason: `killed by the watchdog: ${what}`,
  };
}

interface WatchdogThreadInit {
  control: SharedArrayBuffer;
  pid: number;
  checkMs: number;
  logPath: string;
  echoToTerminal: boolean;
  marker: { path: string; content: object } | null;
  slots: { beat: number; stop: number; freezeSeconds: number; ceilingMb: number; checks: number };
}

/** The worker's whole program. */
function watchdogThreadMain(check: typeof checkWatchdog, describe: typeof describeWatchdogTrip): void {
  self.onmessage = (event: MessageEvent<WatchdogThreadInit>) => {
    const init = event.data;
    const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    const ctl = new Int32Array(init.control);
    const { slots } = init;
    const state = { lastBeat: Atomics.load(ctl, slots.beat), staleChecks: 0 };
    // Blocking in Atomics.wait is the point: this thread needs nothing from
    // its own event loop after this message, and the wait is the sleep.
    for (;;) {
      Atomics.wait(ctl, slots.stop, 0, init.checkMs);
      if (Atomics.load(ctl, slots.stop) !== 0) return;
      const trip = check(state, {
        beat: Atomics.load(ctl, slots.beat),
        rssBytes: process.memoryUsage.rss(),
        freezeSeconds: Atomics.load(ctl, slots.freezeSeconds),
        memoryCeilingMb: Atomics.load(ctl, slots.ceilingMb),
        checkMs: init.checkMs,
      });
      Atomics.add(ctl, slots.checks, 1);
      if (!trip) continue;
      const { line, reason } = describe(trip, init.pid, new Date());
      // Every write is best-effort: the kill below must happen whatever the
      // disk says. Synchronous calls only — this thread's event loop never
      // runs again, and the main thread's is the one that is stuck.
      if (init.marker) {
        try {
          const tmp = `${init.marker.path}.${init.pid}.watchdog.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ ...init.marker.content, endedBy: reason, endedAtMs: Date.now() }), {
            mode: 0o600,
          });
          fs.renameSync(tmp, init.marker.path);
        } catch {
          // see above
        }
      }
      try {
        fs.appendFileSync(init.logPath, `${line}\n`);
      } catch {
        // see above
      }
      if (init.echoToTerminal) {
        try {
          fs.writeSync(2, `${line}\n`);
        } catch {
          // see above
        }
      }
      try {
        process.kill(init.pid, "SIGKILL");
      } catch {
        // fall through to the fallbacks
      }
      // Still running: the signal did not land.
      try {
        Bun.spawnSync(
          process.platform === "win32"
            ? ["taskkill", "/F", "/PID", String(init.pid)]
            : ["kill", "-9", String(init.pid)],
        );
      } catch {
        // fall through
      }
      process.abort();
    }
  };
}

const WORKER_SOURCE = `(${watchdogThreadMain.toString()})(${checkWatchdog.toString()}, ${describeWatchdogTrip.toString()});\n`;

// ── Main-thread side ────────────────────────────────────────────────────────

export interface WatchdogThread {
  /** New limits, applied at the worker's next check. */
  setLimits(limits: WatchdogLimits): void;
  /** Stop beating and end the worker. A daemon never needs this (it exits);
   *  the tests and a future in-process restart do. */
  stop(): void;
  /** Checks the worker has completed so far (a liveness signal for tests). */
  checks(): number;
}

export interface StartWatchdogOptions {
  limits: WatchdogLimits;
  /** Where the trip line goes: ~/.let/hx/stderr.log for the daemon. */
  logPath: string;
  /** This run's marker (crash-loop.ts); the worker writes the trip reason
   *  into it before the kill. */
  marker?: { path: string; content: object } | null;
  /** Re-read the limits every RELOAD_MS (settings.json). */
  reloadLimits?: () => Promise<WatchdogLimits>;
  /** Called once when the worker cannot start or dies; the daemon logs it and
   *  keeps running without the watchdog. */
  onError?: (message: string) => void;
  /** Test seams. */
  checkMs?: number;
  beatMs?: number;
}

export function startWatchdogThread(opts: StartWatchdogOptions): WatchdogThread {
  const control = new SharedArrayBuffer(SLOT_COUNT * Int32Array.BYTES_PER_ELEMENT);
  const ctl = new Int32Array(control);
  const setLimits = (limits: WatchdogLimits): void => {
    Atomics.store(ctl, SLOT_FREEZE_SECONDS, limits.freezeSeconds);
    Atomics.store(ctl, SLOT_CEILING_MB, limits.memoryCeilingMb);
  };
  setLimits(opts.limits);

  let failed = false;
  const fail = (message: string): void => {
    if (failed) return;
    failed = true;
    opts.onError?.(message);
  };

  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  let worker: Worker | null = null;
  try {
    worker = new Worker(url);
    // The worker must never be the reason a process stays alive. Bun's Worker
    // has unref(); the DOM type TypeScript picks for `Worker` does not.
    (worker as Worker & { unref(): void }).unref();
    worker.addEventListener("error", (event) => fail((event as ErrorEvent).message || "worker error"));
    const init: WatchdogThreadInit = {
      control,
      pid: process.pid,
      checkMs: opts.checkMs ?? CHECK_MS,
      logPath: opts.logPath,
      echoToTerminal: process.stderr.isTTY === true,
      marker: opts.marker ?? null,
      slots: {
        beat: SLOT_BEAT,
        stop: SLOT_STOP,
        freezeSeconds: SLOT_FREEZE_SECONDS,
        ceilingMb: SLOT_CEILING_MB,
        checks: SLOT_CHECKS,
      },
    };
    worker.postMessage(init);
  } catch (err) {
    fail((err as Error).message);
  }

  const beat = setInterval(() => {
    Atomics.add(ctl, SLOT_BEAT, 1);
  }, opts.beatMs ?? BEAT_MS);
  beat.unref();

  let reload: ReturnType<typeof setInterval> | null = null;
  if (opts.reloadLimits) {
    const reloadLimits = opts.reloadLimits;
    reload = setInterval(() => {
      reloadLimits().then(setLimits, () => {
        // Keep the current limits; the next reload retries.
      });
    }, RELOAD_MS);
    reload.unref();
  }

  return {
    setLimits,
    stop() {
      clearInterval(beat);
      if (reload) clearInterval(reload);
      Atomics.store(ctl, SLOT_STOP, 1);
      Atomics.notify(ctl, SLOT_STOP);
      worker?.terminate();
      URL.revokeObjectURL(url);
    },
    checks: () => Atomics.load(ctl, SLOT_CHECKS),
  };
}
