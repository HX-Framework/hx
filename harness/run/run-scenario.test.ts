import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareRuns, coverageCheck, loadRun } from "../lib/compare.js";
import type { Scenario } from "../lib/types.js";
import { runScenario } from "./run-scenario.js";

// The driver, end to end, against a stub binary: a scenario runs, the
// recording and the store land in the output dir, two identical runs
// compare equal, and a run that stores one byte less does not.
const scenario: Scenario = {
  name: "stub",
  description: "driver smoke test",
  shape: "small",
  seed: "stub",
  steps: [
    { kind: "run", name: "watch1", args: ["watch", "--once"], sortLines: true, expectExit: 0 },
    { kind: "run", name: "status1", args: ["status"], expectExit: 0 },
    { kind: "run", name: "bogus", args: ["bogus"], expectExit: 64 },
  ],
  compare: { requests: "per-session", tsToleranceMs: 20_000 },
};

function stubBinary(dir: string, variant: string): string {
  const p = join(dir, `stub-${variant}.sh`);
  writeFileSync(p, `#!/bin/sh\nSTUB_VARIANT=${variant} exec "${process.execPath}" "${join(import.meta.dir, "stub", "stub-hx.ts")}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

// The stub is a shell script; the harness itself runs on Linux and macOS only.
describe.skipIf(process.platform === "win32")("runScenario + compareRuns with a stub binary", () => {
  it("records, stores, compares equal to itself and unequal to a broken twin", async () => {
    const work = mkdtempSync(join(tmpdir(), "hx-harness-driver-"));
    try {
      const good = stubBinary(work, "good");
      const broken = stubBinary(work, "broken");
      const home = join(work, "home");
      const quiet = (): void => {};
      const a = await runScenario({ binary: good, name: "hx", scenario, outDir: join(work, "a"), home, workDir: work, log: quiet });
      expect(a.failures).toEqual([]);
      expect(a.steps.map((s) => s.exitCode)).toEqual([0, 0, 64]);
      expect(a.steps[0]!.seqTo - a.steps[0]!.seqFrom).toBe(4); // append-url, PUT, commit, heartbeat
      const b = await runScenario({ binary: good, name: "hx", scenario, outDir: join(work, "b"), home, workDir: work, log: quiet });
      expect(b.failures).toEqual([]);
      const same = compareRuns(loadRun(join(work, "a")), loadRun(join(work, "b")), { scenario, candidateName: "hx" });
      const failing = same.filter((c) => !c.ok);
      expect(failing.map((c) => `${c.name}: ${c.details}`)).toEqual([]);

      const c = await runScenario({ binary: broken, name: "hx", scenario, outDir: join(work, "c"), home, workDir: work, log: quiet });
      expect(c.failures).toEqual([]);
      const diff = compareRuns(loadRun(join(work, "a")), loadRun(join(work, "c")), { scenario, candidateName: "hx" });
      const names = diff.filter((x) => !x.ok).map((x) => x.name);
      expect(names).toContain("stored bytes");
      expect(names).toContain("requests: watch1");
      expect(names).toContain("state.json");
      expect(names).toContain("step watch1");

      const cov = coverageCheck([join(work, "a")]);
      expect(cov.ok).toBe(false); // the stub speaks 5 of the 24 calls
      expect(cov.details).toContain("✓ signed PUT: 1");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
