import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest } from "../fixtures/gen-home.js";
import { compareRuns, coverageCheck, loadRun } from "../lib/compare.js";
import type { Scenario } from "../lib/types.js";
import { runScenario, serviceSteps } from "./run-scenario.js";
import { SCENARIOS } from "./scenarios.js";

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

  // Run 38982724968 generated synthetic-10k's reference home at 23:57 UTC and
  // its candidate home after midnight, each from its own start, so `hx status`
  // dated the 40-day-old session Sep 6 in one run and Sep 7 in the other.
  it("dates both runs' homes from one fixture clock, also when it is just before midnight UTC", async () => {
    const work = mkdtempSync(join(tmpdir(), "hx-harness-clock-"));
    try {
      const good = stubBinary(work, "good");
      const home = join(work, "home");
      const quiet = (): void => {};
      const day = 24 * 60 * 60 * 1000;
      // Ten seconds before the last midnight UTC: both runs start after it.
      const midnight = Math.floor(Date.now() / day) * day;
      const fixtureNowMs = midnight - 10_000;
      // Each run regenerates the same home, so its mtimes are read before
      // the next run starts: every file the fixture stamps, the sessions
      // discovery finds and the ones it must ignore.
      const stamped = (outDir: string): { manifest: Manifest; mtimes: number[] } => {
        const manifest = JSON.parse(readFileSync(join(outDir, "fixture.manifest.json"), "utf8")) as Manifest;
        const paths = [...manifest.sessions.map((s) => s.path), ...manifest.ignored.map((i) => i.path)];
        return { manifest, mtimes: paths.map((p) => statSync(p).mtimeMs) };
      };
      const a = await runScenario({ binary: good, name: "hx", scenario, outDir: join(work, "a"), home, workDir: work, fixtureNowMs, log: quiet });
      const homeA = stamped(join(work, "a"));
      const b = await runScenario({ binary: good, name: "hx", scenario, outDir: join(work, "b"), home, workDir: work, fixtureNowMs, log: quiet });
      const homeB = stamped(join(work, "b"));

      expect(b.startedAtMs).toBeGreaterThan(a.startedAtMs);
      expect(a.startedAtMs).toBeGreaterThan(midnight);
      expect([a.fixtureNowMs, b.fixtureNowMs, homeA.manifest.now, homeB.manifest.now]).toEqual([fixtureNowMs, fixtureNowMs, fixtureNowMs, fixtureNowMs]);
      expect(homeA.mtimes.length).toBeGreaterThan(10);
      expect(homeB.mtimes).toEqual(homeA.mtimes);

      // The 40-day-old file carries the date the fixture clock gives it, the
      // day before the one either run's own start would give it.
      const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
      const old = homeB.manifest.ignored.find((i) => i.reason.startsWith("file older than the 30-day window"));
      expect(old).toBeDefined();
      expect(utcDay(statSync(old!.path).mtimeMs)).toBe(utcDay(fixtureNowMs - 40 * day));
      expect(utcDay(b.startedAtMs - 40 * day)).not.toBe(utcDay(fixtureNowMs - 40 * day));

      const checks = compareRuns(loadRun(join(work, "a")), loadRun(join(work, "b")), { scenario, candidateName: "hx" });
      expect(checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.details}`)).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("serviceSteps", () => {
  it("names the steps that would drive this machine's own service manager", () => {
    const steps = (args: string[][]): Scenario => ({ ...scenario, steps: args.map((a, i) => ({ kind: "run" as const, name: `s${i}`, args: a })) });
    expect(serviceSteps(scenario)).toEqual([]);
    expect(serviceSteps(steps([["update"], ["start"], ["restart"], ["stop"], ["uninstall"]]))).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(serviceSteps(steps([["connect"], ["connect", "--no-start"], ["status"], ["disconnect"]]))).toEqual(["s0"]);
    // `baseline` updates the binary, which restarts a loaded service.
    expect(serviceSteps(SCENARIOS.find((s) => s.name === "baseline")!)).toEqual(["update-same", "update-download"]);
  });
});
