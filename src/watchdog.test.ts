// The freeze and memory watchdog (watchdog.ts). The pure parts run here; the
// thread itself runs in a child process (__fixtures__/watchdog.scenario.ts)
// because the point is that it kills its own process. Running it from source
// in a real worker also proves the serialized worker code is self-contained.

/* eslint-disable security/detect-non-literal-fs-filename -- every path is in a fresh tmp dir this file creates */
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import {
  FREEZE_SECONDS_DEFAULT,
  FREEZE_SECONDS_MIN,
  MEMORY_CEILING_MB_DEFAULT,
  MEMORY_CEILING_MB_MIN,
  checkWatchdog,
  describeWatchdogTrip,
  resolveWatchdogLimits,
  type WatchdogCheckState,
} from "./watchdog.js";

const MB = 1048576;

function settings(tuning?: Record<string, unknown>): HxSettings {
  return { ...DEFAULT_SETTINGS, tuning };
}

describe("resolveWatchdogLimits", () => {
  it("reads tuning.freezeSeconds and tuning.memoryCeilingMb, with defaults, floors, and 0 for off", () => {
    assert.deepEqual(resolveWatchdogLimits(settings()), {
      freezeSeconds: FREEZE_SECONDS_DEFAULT,
      memoryCeilingMb: MEMORY_CEILING_MB_DEFAULT,
    });
    assert.deepEqual(resolveWatchdogLimits(settings({ freezeSeconds: 30, memoryCeilingMb: 2048 })), {
      freezeSeconds: 30,
      memoryCeilingMb: 2048,
    });
    assert.deepEqual(
      resolveWatchdogLimits(settings({ freezeSeconds: 3, memoryCeilingMb: 100 })),
      { freezeSeconds: FREEZE_SECONDS_MIN, memoryCeilingMb: MEMORY_CEILING_MB_MIN },
      "raised to the floors",
    );
    assert.deepEqual(resolveWatchdogLimits(settings({ freezeSeconds: 0, memoryCeilingMb: -1 })), {
      freezeSeconds: 0,
      memoryCeilingMb: 0,
    });
    assert.deepEqual(
      resolveWatchdogLimits(settings({ freezeSeconds: "soon", memoryCeilingMb: null })),
      { freezeSeconds: FREEZE_SECONDS_DEFAULT, memoryCeilingMb: MEMORY_CEILING_MB_DEFAULT },
      "garbage reads as the default",
    );
    assert.equal(resolveWatchdogLimits(settings({ freezeSeconds: 45.6 })).freezeSeconds, 46, "rounded");
  });
});

describe("checkWatchdog", () => {
  const reading = { rssBytes: 300 * MB, freezeSeconds: 2, memoryCeilingMb: 400, checkMs: 250 };

  it("trips on the freeze limit after enough checks that saw no new beat", () => {
    const state: WatchdogCheckState = { lastBeat: 0, staleChecks: 0 };
    for (let beat = 1; beat <= 20; beat++) {
      assert.equal(checkWatchdog(state, { ...reading, beat }), null, "a moving beat never trips");
    }
    for (let i = 1; i <= 7; i++) assert.equal(checkWatchdog(state, { ...reading, beat: 20 }), null, `stale check ${i}`);
    assert.deepEqual(checkWatchdog(state, { ...reading, beat: 20 }), {
      limit: "freeze",
      rssMb: 300,
      quietSeconds: 2,
      limitValue: 2,
    });
    assert.equal(checkWatchdog(state, { ...reading, beat: 21 }), null, "a new beat resets the count");
  });

  it("counts a long gap between two checks as one check, so waking from sleep never reads as a freeze", () => {
    // Nothing in a reading carries time: a laptop that slept for an hour
    // between two checks produces exactly one stale check on wake.
    const state: WatchdogCheckState = { lastBeat: 5, staleChecks: 0 };
    assert.equal(checkWatchdog(state, { ...reading, beat: 5 }), null);
    assert.equal(state.staleChecks, 1);
  });

  it("trips on the memory limit while the event loop is running, and reports how long ago it ran", () => {
    const state: WatchdogCheckState = { lastBeat: 0, staleChecks: 0 };
    assert.equal(checkWatchdog(state, { ...reading, beat: 1, rssBytes: 400 * MB }), null, "at the limit is fine");
    assert.equal(checkWatchdog(state, { ...reading, beat: 1, rssBytes: 401 * MB })?.limit, "memory");
    assert.deepEqual(checkWatchdog(state, { ...reading, beat: 1, rssBytes: 900 * MB }), {
      limit: "memory",
      rssMb: 900,
      quietSeconds: 0,
      limitValue: 400,
    });
  });

  it("reports memory when both limits are over, and never trips with both off", () => {
    const state: WatchdogCheckState = { lastBeat: 3, staleChecks: 100 };
    assert.equal(checkWatchdog(state, { ...reading, beat: 3, rssBytes: 900 * MB })?.limit, "memory");
    const off = { ...reading, freezeSeconds: 0, memoryCeilingMb: 0, rssBytes: 99_000 * MB };
    for (let i = 0; i < 1_000; i++) assert.equal(checkWatchdog(state, { ...off, beat: 3 }), null);
  });
});

describe("describeWatchdogTrip", () => {
  const at = new Date(2026, 9, 14, 5, 6, 7);

  it("says which limit tripped, with RSS and seconds since the event loop last ran", () => {
    assert.deepEqual(describeWatchdogTrip({ limit: "freeze", rssMb: 412, quietSeconds: 61, limitValue: 60 }, 4242, at), {
      line:
        "2026-10-14 05:06:07 [hx] watchdog: killing pid 4242 with SIGKILL: the event loop has not run for 61 s " +
        "(freeze limit 60 s); rss 412 MB",
      reason: "killed by the watchdog: the event loop has not run for 61 s (freeze limit 60 s)",
    });
    assert.deepEqual(
      describeWatchdogTrip({ limit: "memory", rssMb: 1612, quietSeconds: 0, limitValue: 1536 }, 4242, at),
      {
        line:
          "2026-10-14 05:06:07 [hx] watchdog: killing pid 4242 with SIGKILL: rss 1612 MB is over the memory limit " +
          "of 1536 MB; the event loop last ran 0 s ago",
        reason: "killed by the watchdog: rss 1612 MB is over the memory limit of 1536 MB",
      },
    );
  });
});

// ── The thread, in a child process ──────────────────────────────────────────

const SCENARIO = join(import.meta.dir, "__fixtures__", "watchdog.scenario.ts");
const FREEZE_SECONDS = 2;
const CEILING_MB = 400;
/** If the watchdog does not act, the test kills the child after this long. */
const DEADLINE_MS = 20_000;
/** …or once the memory child holds this much, so a regression stays cheap. */
const RUNAWAY_MB = CEILING_MB + 600;

interface ScenarioRun {
  code: number | null;
  signal: string | null;
  killedByTest: string | null;
  lines: string[];
  /** ms from the child's "frozen" line to its exit, when it froze. */
  frozenForMs: number | null;
  log: string;
  marker: { pid: number; endedBy?: string };
}

async function runScenario(
  mode: "freeze" | "memory" | "healthy",
  opts: { ceilingMb: number; onStarted?: (pid: number) => void },
): Promise<ScenarioRun> {
  const dir = mkdtempSync(join(tmpdir(), "hx-watchdog-"));
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, SCENARIO, mode, dir, String(FREEZE_SECONDS), String(opts.ceilingMb)],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();
    let killedByTest: string | null = null;
    const kill = (why: string): void => {
      if (killedByTest !== null) return;
      killedByTest = why;
      proc.kill(9);
    };
    const deadline = setTimeout(() => kill(`still running after ${DEADLINE_MS} ms`), DEADLINE_MS);
    const lines: string[] = [];
    let frozenAt: number | null = null;
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lines.push(line);
        if (line === "started") opts.onStarted?.(proc.pid);
        if (line.startsWith("frozen ")) frozenAt = performance.now();
        const held = /^holding (\d+) MB$/.exec(line);
        if (held && Number(held[1]) > RUNAWAY_MB) kill(`still allocating at ${held[1]} MB`);
      }
    }
    const code = await proc.exited;
    const exitedAt = performance.now();
    clearTimeout(deadline);
    const errText = await stderr;
    assert.equal(killedByTest, null, `the test had to kill the child (${killedByTest}): ${lines.slice(-5).join(" | ")}\n${errText}`);
    const logPath = join(dir, "watchdog.log");
    return {
      code,
      signal: proc.signalCode,
      killedByTest,
      lines,
      frozenForMs: frozenAt === null ? null : exitedAt - frozenAt,
      log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
      marker: JSON.parse(readFileSync(join(dir, "marker.json"), "utf8")) as ScenarioRun["marker"],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POSIX reports the signal; on Windows TerminateProcess leaves exit code 1. */
function assertKilled(run: ScenarioRun): void {
  if (process.platform === "win32") assert.notEqual(run.code, 0, "killed");
  else assert.equal(run.signal, "SIGKILL", `exit code ${run.code}, signal ${run.signal}`);
}

describe("watchdog thread", () => {
  it(
    "kills a process whose main thread is spinning, within the freeze window",
    async () => {
      const run = await runScenario("freeze", { ceilingMb: 2048 });
      assertKilled(run);
      assert.ok(run.frozenForMs !== null, `never froze: ${JSON.stringify(run.lines)}`);
      // The last beat lands up to a second before the freeze starts; the kill
      // comes FREEZE_SECONDS after it, plus a check interval and exit latency.
      assert.ok(run.frozenForMs >= (FREEZE_SECONDS - 1) * 1000, `killed too early: ${run.frozenForMs} ms`);
      assert.ok(run.frozenForMs <= (FREEZE_SECONDS + 3) * 1000, `killed too late: ${run.frozenForMs} ms`);
      assert.match(
        run.log,
        /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[hx\] watchdog: killing pid \d+ with SIGKILL: the event loop has not run for \d+ s \(freeze limit 2 s\); rss \d+ MB\n$/,
      );
      assert.match(run.marker.endedBy ?? "", /^killed by the watchdog: the event loop has not run for/);
    },
    DEADLINE_MS + 5_000,
  );

  it(
    "kills a process whose RSS passes the ceiling while its event loop keeps running",
    async () => {
      const run = await runScenario("memory", { ceilingMb: CEILING_MB });
      assertKilled(run);
      const m = /rss (\d+) MB is over the memory limit of 400 MB; the event loop last ran (\d+) s ago\n$/.exec(run.log);
      assert.ok(m, `log: ${run.log}`);
      assert.ok(Number(m[1]) > CEILING_MB);
      assert.ok(Number(m[2]) <= 1, "the event loop was running");
      assert.match(run.marker.endedBy ?? "", /^killed by the watchdog: rss \d+ MB is over the memory limit of 400 MB$/);
    },
    DEADLINE_MS + 5_000,
  );

  it(
    "never kills a healthy process, even one that stalls its loop and churns garbage",
    async () => {
      const run = await runScenario("healthy", { ceilingMb: 2048 });
      assert.equal(run.code, 0, `lines: ${JSON.stringify(run.lines)}`);
      assert.equal(run.lines.at(-1), "done");
      const checks = Number(/^checks (\d+)$/.exec(run.lines.find((l) => l.startsWith("checks ")) ?? "")?.[1]);
      assert.ok(checks >= 10, `the worker was checking (${checks} checks)`);
      assert.equal(run.log, "", "no trip line");
      assert.equal(run.marker.endedBy, undefined);
    },
    DEADLINE_MS + 5_000,
  );

  it.skipIf(process.platform === "win32")(
    "survives being suspended for longer than the freeze limit, as a sleeping laptop is",
    async () => {
      // SIGSTOP stops both threads, like system sleep; the worker must not
      // read the pause as a freeze when both resume.
      const run = await runScenario("healthy", {
        ceilingMb: 2048,
        onStarted: (pid) => {
          setTimeout(() => {
            process.kill(pid, "SIGSTOP");
            setTimeout(() => process.kill(pid, "SIGCONT"), (FREEZE_SECONDS + 2) * 1000);
          }, 1_500);
        },
      });
      assert.equal(run.code, 0, `lines: ${JSON.stringify(run.lines)}`);
      assert.equal(run.log, "", "no trip line");
    },
    DEADLINE_MS + 5_000,
  );
});
