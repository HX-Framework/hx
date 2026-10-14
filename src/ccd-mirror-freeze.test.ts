// Regression: the group-mirror call sequence that froze `hx watch` on
// 2026-10-14 (a stuck single-flight slot in the CCD records cache turned into
// an endless microtask loop; see __fixtures__/group-mirror-freeze.scenario.ts
// for the sequence and the mechanism). The scenario runs in a child process:
// a regression starves that child's event loop, and only a process boundary
// lets the test kill it and fail in seconds instead of hanging the suite.
//
// The kill is driven by the child's heartbeat, not by one long deadline. A
// starved loop grows memory by about 1.5 GB a second (measured on an M-series
// Mac against v77.8.0), so the child is killed after SILENCE_MS without a
// line, which caps a regression at a couple of GB for a moment.

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCENARIO = join(import.meta.dir, "__fixtures__", "group-mirror-freeze.scenario.ts");
/** The child ticks every 100 ms; this much silence means its loop is starved. */
const SILENCE_MS = 1_000;
/** Bound on the whole run, startup included. A healthy run takes well under a
 *  second; the margin is for a cold start on a slow CI runner. */
const TOTAL_MS = 20_000;

interface ScenarioRun {
  code: number | null;
  killedFor: string | null;
  lines: string[];
  stderr: string;
}

async function runScenario(): Promise<ScenarioRun> {
  const root = mkdtempSync(join(tmpdir(), "hx-mirror-freeze-"));
  try {
    const proc = Bun.spawn({ cmd: [process.execPath, SCENARIO, root], stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    let killedFor: string | null = null;
    const kill = (why: string): void => {
      if (killedFor !== null) return;
      killedFor = why;
      proc.kill(9);
    };
    const total = setTimeout(() => kill(`still running after ${TOTAL_MS} ms`), TOTAL_MS);
    let silence: ReturnType<typeof setTimeout> | undefined;
    const lines: string[] = [];
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line !== "tick") lines.push(line);
      }
      clearTimeout(silence);
      silence = setTimeout(() => kill(`no output for ${SILENCE_MS} ms`), SILENCE_MS);
    }
    const code = await proc.exited;
    clearTimeout(total);
    clearTimeout(silence);
    return { code, killedFor, lines, stderr: await stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("group mirror after a stuck-slot sequence", () => {
  it(
    "the third build returns with fresh records and the event loop stays alive",
    async () => {
      const { code, killedFor, lines, stderr } = await runScenario();
      assert.equal(
        killedFor,
        null,
        `the scenario was killed (${killedFor}) after: ${JSON.stringify(lines)}. ` +
          `"build 3 started" without "timer fired" means the event loop starved: a single-flight ` +
          `slot was cleared inside its own async function before the caller stored the promise.`,
      );
      assert.equal(code, 0, `scenario exited ${code}\n${stderr}`);
      // The timer may fire during the build or just after it; either proves
      // the loop kept turning. It must come after it was scheduled.
      const timerAt = lines.indexOf("timer fired");
      assert.ok(timerAt > lines.indexOf("build 3 started"), `timer never fired: ${JSON.stringify(lines)}`);
      assert.deepEqual(
        lines.filter((l) => l !== "timer fired"),
        ['build 1 returned [["cli-1"]]', "build 2 returned", "build 3 started", 'build 3 returned [["cli-22"]]', "done"],
      );
    },
    TOTAL_MS + 5_000,
  );
});
