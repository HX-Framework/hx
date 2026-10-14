// Crash-loop backoff (crash-loop.ts): the schedule, the run marker's
// bookkeeping across simulated starts, and — in a child process — what the
// signal and exit hooks leave behind.

/* eslint-disable security/detect-non-literal-fs-filename -- every path is in a fresh tmp dir this file creates */
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLogLine } from "./ui/data.js";
import {
  EXITS_FILE,
  RUN_MARKER_FILE,
  beginWatchRun,
  clearCrashHistory,
  crashLoopDelayMs,
  describeWatchRun,
  type AbnormalExit,
} from "./crash-loop.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const dead = (): boolean => false;
const at = (ms: number) => (): number => ms;

function withDir(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-crash-loop-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function exitsAt(...minutesAgo: number[]): AbnormalExit[] {
  return minutesAgo.map((m, i) => ({ pid: 100 + i, atMs: T0 - m * MIN, effAtMs: T0 - m * MIN, reason: "x" }));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("crashLoopDelayMs", () => {
  it("waits from the third abnormal exit in the window: 1 min, doubling, capped at 30 min", () => {
    const delays: number[] = [];
    for (let n = 0; n <= 10; n++) {
      const exits = exitsAt(...Array.from({ length: n }, (_, i) => i));
      delays.push(crashLoopDelayMs(exits, T0).delayMs / MIN);
    }
    assert.deepEqual(delays, [0, 0, 0, 1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it("counts only exits inside the 30-minute window", () => {
    assert.deepEqual(crashLoopDelayMs(exitsAt(31, 29, 2, 1), T0), { delayMs: MIN, recent: 3 });
    assert.deepEqual(crashLoopDelayMs(exitsAt(45, 31, 2, 1), T0), { delayMs: 0, recent: 2 });
  });
});

describe("beginWatchRun", () => {
  it(
    "writes a marker on the first start and counts nothing",
    withDir((dir) => {
      const run = beginWatchRun({ dir, now: at(T0), pid: 101, isAlive: dead });
      assert.equal(run.previous, null);
      assert.equal(run.delayMs, 0);
      assert.deepEqual(readJson(join(dir, RUN_MARKER_FILE)), { pid: 101, startedAtMs: T0 });
      assert.equal(existsSync(join(dir, EXITS_FILE)), false, "nothing to record yet");
    }),
  );

  it(
    "counts a run that ended without a clean stop at the next start",
    withDir((dir) => {
      beginWatchRun({ dir, now: at(T0), pid: 101, isAlive: dead });
      const run = beginWatchRun({ dir, now: at(T0 + MIN), pid: 102, isAlive: dead });
      assert.deepEqual(run.previous, {
        pid: 101,
        atMs: T0 + MIN,
        effAtMs: T0 + MIN,
        reason: "ended without a clean shutdown (a crash or a signal)",
      });
      assert.equal(run.recentExits, 1);
      assert.equal(run.delayMs, 0);
    }),
  );

  it(
    "keeps the reason the watchdog or the exit handler wrote into the marker",
    withDir((dir) => {
      const first = beginWatchRun({ dir, now: at(T0), pid: 101, isAlive: dead });
      // What the watchdog thread writes before its SIGKILL.
      writeFileSync(
        first.marker.path,
        JSON.stringify({ ...first.marker.content, endedBy: "killed by the watchdog: x", endedAtMs: T0 + 30_000 }),
      );
      const second = beginWatchRun({ dir, now: at(T0 + MIN), pid: 102, isAlive: dead });
      assert.equal(second.previous?.reason, "killed by the watchdog: x");
      assert.equal(second.previous?.atMs, T0 + 30_000);

      second.markExit(70);
      assert.equal(readJson(second.marker.path).endedBy, "exit code 70");
      second.markExit(1);
      assert.equal(readJson(second.marker.path).endedBy, "exit code 70", "the first reason stays");
      const third = beginWatchRun({ dir, now: at(T0 + 2 * MIN), pid: 103, isAlive: dead });
      assert.equal(third.previous?.reason, "exit code 70");

      // Bun reports 0 for an exit on an unhandled rejection; without a stop
      // request that is abnormal too.
      third.markExit(0);
      const fourth = beginWatchRun({ dir, now: at(T0 + 3 * MIN), pid: 104, isAlive: dead });
      assert.equal(fourth.previous?.reason, "exited without a stop request");
      assert.equal(fourth.recentExits, 3);
    }),
  );

  it(
    "does not count a clean stop, and an exit after one records nothing",
    withDir((dir) => {
      const first = beginWatchRun({ dir, now: at(T0), pid: 101, isAlive: dead });
      first.markCleanStop();
      first.markExit(0);
      assert.equal(existsSync(first.marker.path), false);
      assert.equal(beginWatchRun({ dir, now: at(T0 + MIN), pid: 102, isAlive: dead }).previous, null);
    }),
  );

  it(
    "leaves a live run's marker alone, but counts a marker carrying its own pid",
    withDir((dir) => {
      const other = beginWatchRun({ dir, now: at(T0), pid: 101, isAlive: dead });
      const alive = (pid: number): boolean => pid === 101;
      const second = beginWatchRun({ dir, now: at(T0 + MIN), pid: 102, isAlive: alive });
      assert.equal(second.previous, null, "a foreground `hx watch` beside the service is not an exit");
      other.markCleanStop();
      assert.equal(readJson(second.marker.path).pid, 102, "the other run removes only its own marker");

      // The old run is gone and the OS gave its pid to this one (containers).
      const reused = beginWatchRun({ dir, now: at(T0 + 2 * MIN), pid: 102, isAlive: () => true });
      assert.equal(reused.previous?.pid, 102);
    }),
  );

  it(
    "backs a crash loop off to the 30-minute cap and holds it there, because the waits do not age exits out",
    withDir((dir) => {
      // Each run crashes 2 min after its first pass; the service manager
      // restarts it at once. A plain clock window would drop the old exits
      // during the long waits and fall back to 1 min (see crash-loop.ts).
      let now = T0;
      const delays: number[] = [];
      for (let i = 0; i < 12; i++) {
        const run = beginWatchRun({ dir, now: at(now), pid: 200 + i, isAlive: dead });
        delays.push(run.delayMs / MIN);
        now += run.delayMs + 2 * MIN;
      }
      assert.deepEqual(delays, [0, 0, 0, 1, 2, 4, 8, 16, 30, 30, 30, 30]);

      // A run that stays up for longer than the window ends the loop.
      const recovered = beginWatchRun({ dir, now: at(now + 31 * MIN), pid: 300, isAlive: dead });
      assert.equal(recovered.recentExits, 1, "only the run that just ended");
      assert.equal(recovered.delayMs, 0);
    }),
  );

  it(
    "starts at once after clearCrashHistory (a start someone asked for)",
    withDir((dir) => {
      let now = T0;
      for (let i = 0; i < 6; i++) now += beginWatchRun({ dir, now: at(now), pid: 400 + i, isAlive: dead }).delayMs + MIN;
      clearCrashHistory(dir);
      const run = beginWatchRun({ dir, now: at(now), pid: 500, isAlive: dead });
      assert.equal(run.recentExits, 1, "the run that was just replaced still counts");
      assert.equal(run.delayMs, 0);
    }),
  );

  it(
    "keeps the history file bounded",
    withDir((dir) => {
      let now = T0;
      for (let i = 0; i < 80; i++) now += beginWatchRun({ dir, now: at(now), pid: 600 + i, isAlive: dead }).delayMs + MIN;
      const file = readJson(join(dir, EXITS_FILE)) as { exits: unknown[] };
      assert.ok(file.exits.length <= 50, `${file.exits.length} exits kept`);
    }),
  );
});

describe("describeWatchRun", () => {
  const previous = { pid: 101, atMs: T0, effAtMs: T0, reason: "exit code 70" };

  it("logs one line: the backoff, or an abnormal previous run, or nothing", () => {
    assert.equal(
      describeWatchRun({ delayMs: 2 * MIN, recentExits: 4, previous }),
      "[hx] crash loop: 4 abnormal exits in the last 30 min (previous run: exit code 70); backing off 2 min before the first pass",
    );
    assert.equal(
      describeWatchRun({ delayMs: MIN, recentExits: 3, previous: null }),
      "[hx] crash loop: 3 abnormal exits in the last 30 min; backing off 1 min before the first pass",
    );
    assert.equal(
      describeWatchRun({ delayMs: 0, recentExits: 1, previous }),
      "[hx] warning: the previous run (pid 101) ended abnormally: exit code 70; 1 abnormal exit in the last 30 min",
    );
    assert.equal(describeWatchRun({ delayMs: 0, recentExits: 0, previous: null }), null);
  });

  it("reads as a warning in the UI's log view, where a watchdog kill's reason shows up", () => {
    const killed = { ...previous, reason: "killed by the watchdog: rss 1612 MB is over the memory limit of 1536 MB" };
    for (const line of [
      describeWatchRun({ delayMs: 2 * MIN, recentExits: 4, previous: killed }),
      describeWatchRun({ delayMs: 0, recentExits: 1, previous: killed }),
    ]) {
      assert.equal(classifyLogLine(line ?? ""), "warn", line ?? "");
    }
  });
});

// ── The hooks, in a child process ───────────────────────────────────────────

const SCENARIO = join(import.meta.dir, "__fixtures__", "watch-run.scenario.ts");

async function runScenario(
  mode: "wait" | "flush" | "exit70",
  signal?: "SIGTERM" | "SIGINT",
): Promise<{ code: number | null; signal: string | null; lines: string[]; marker: Record<string, unknown> | null }> {
  const dir = mkdtempSync(join(tmpdir(), "hx-watch-run-"));
  try {
    const proc = Bun.spawn({ cmd: [process.execPath, SCENARIO, mode, dir], stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => proc.kill(9), 15_000);
    const lines: string[] = [];
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lines.push(line);
        if (line === "ready" && signal) proc.kill(signal);
      }
    }
    const code = await proc.exited;
    clearTimeout(deadline);
    const markerPath = join(dir, RUN_MARKER_FILE);
    return { code, signal: proc.signalCode, lines, marker: existsSync(markerPath) ? readJson(markerPath) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hookWatchRunToProcess", () => {
  it.skipIf(process.platform === "win32")(
    "a SIGTERM with no other listener (the backoff wait) still ends the process, as a clean stop",
    async () => {
      const run = await runScenario("wait", "SIGTERM");
      assert.equal(run.signal, "SIGTERM", JSON.stringify(run));
      assert.equal(run.marker, null, "marker removed");
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "with state.ts's listener registered too, that listener still flushes and ends the process",
    async () => {
      const run = await runScenario("flush", "SIGTERM");
      assert.equal(run.signal, "SIGTERM", JSON.stringify(run));
      assert.ok(run.lines.includes("flushed"), JSON.stringify(run.lines));
      assert.equal(run.marker, null, "marker removed");
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "SIGINT is a clean stop too",
    async () => {
      const run = await runScenario("wait", "SIGINT");
      assert.equal(run.signal, "SIGINT", JSON.stringify(run));
      assert.equal(run.marker, null, "marker removed");
    },
    20_000,
  );

  it(
    "a non-zero exit keeps the marker and records the code",
    async () => {
      const run = await runScenario("exit70");
      assert.equal(run.code, 70);
      assert.equal(run.marker?.endedBy, "exit code 70");
    },
    20_000,
  );
});
