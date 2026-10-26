import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareRuns, loadRun, readsScopedCcdStore, sendsSideSessions, withoutSideSessions } from "./compare.js";
import type { RunMeta, Scenario } from "./types.js";

// Both runs of a scenario generate their homes from one fixture clock
// (run-harness.ts), so a fixture mtime is the same instant in both runs while
// each run's own clock starts when the run does. Two hand-written run
// directories stand in for a reference that starts three minutes before
// midnight UTC and a candidate that starts 277 s later, after midnight:
// synthetic-10k's gap between the two starts in run 38982724968.

const DAY = 24 * 60 * 60 * 1000;
const FIXTURE_NOW = Date.UTC(2026, 9, 16, 23, 57, 0);
const REF_START = FIXTURE_NOW + 5;
const CAND_START = FIXTURE_NOW + 277_000;
const OLD_MTIME = FIXTURE_NOW - 40 * DAY;
const RANGE = "Session range: Sep 6 – Oct 16, 2026 · 40 days";

const scenario: Scenario = {
  name: "clock",
  description: "the comparators and the fixture clock",
  shape: "small",
  seed: "clock",
  steps: [{ kind: "run", name: "status1", args: ["status"], expectExit: 0 }],
  compare: { requests: "per-session", tsToleranceMs: 20_000 },
};

interface Run {
  startedAtMs: number;
  /** Left out: a run directory written before the fixture clock was recorded. */
  fixtureNowMs?: number;
  /** A fixture mtime the client recorded. */
  lastMtimeMs: number;
  /** A reading of the client's own clock. */
  lastUploadAtMs: number;
  status: string;
}

const reference = (over: Partial<Run> = {}): Run => ({ startedAtMs: REF_START, fixtureNowMs: FIXTURE_NOW, lastMtimeMs: OLD_MTIME, lastUploadAtMs: REF_START + 9_000, status: RANGE, ...over });
const candidate = (over: Partial<Run> = {}): Run => ({ startedAtMs: CAND_START, fixtureNowMs: FIXTURE_NOW, lastMtimeMs: OLD_MTIME, lastUploadAtMs: CAND_START + 12_000, status: RANGE, ...over });

function writeRun(dir: string, run: Run): void {
  mkdirSync(join(dir, "steps"), { recursive: true });
  const meta: RunMeta = {
    scenario: scenario.name,
    binary: "hx",
    name: "hx",
    version: "77.12.0",
    platform: process.platform,
    arch: process.arch,
    home: "/tmp/hx-harness/home",
    workDir: "/tmp/hx-harness",
    gatewayUrl: "http://127.0.0.1:48621",
    fortressUrl: null,
    startedAtMs: run.startedAtMs,
    ...(run.fixtureNowMs !== undefined ? { fixtureNowMs: run.fixtureNowMs } : {}),
    endedAtMs: run.startedAtMs + 30_000,
    steps: [{ index: 1, name: "status1", kind: "run", seqFrom: 1, seqTo: 1, fortressSeqFrom: 1, fortressSeqTo: 1, startedAtMs: run.startedAtMs + 1_000, endedAtMs: run.startedAtMs + 2_000, exitCode: 0, signal: null }],
    failures: [],
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  const file = { lastMtimeMs: run.lastMtimeMs, lastUploadAtMs: run.lastUploadAtMs };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ files: { "/tmp/hx-harness/home/.claude/projects/-x/old.jsonl": file } }));
  writeFileSync(join(dir, "steps", "01-status1.stdout"), `${run.status}\nChecked at ${new Date(run.startedAtMs + 1_500).toISOString()}\n`);
  writeFileSync(join(dir, "steps", "01-status1.stderr"), "");
}

function failing(ref: Run, cand: Run): string[] {
  const work = mkdtempSync(join(tmpdir(), "hx-harness-compare-"));
  try {
    writeRun(join(work, "reference"), ref);
    writeRun(join(work, "candidate"), cand);
    const checks = compareRuns(loadRun(join(work, "reference")), loadRun(join(work, "candidate")), { scenario, candidateName: "hx" });
    return checks.filter((c) => !c.ok).map((c) => c.name);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("compareRuns with one fixture clock for both runs", () => {
  it("finds the runs identical when the fixture's instants match and the client's clock readings agree within the tolerance", () => {
    expect(failing(reference(), candidate())).toEqual([]);
  });

  it("compares a timestamp from before the fixture clock exactly", () => {
    expect(failing(reference(), candidate({ lastMtimeMs: OLD_MTIME + 1 }))).toEqual(["state.json"]);
  });

  it("keeps the tolerance for the client's own clock, measured from each run's start", () => {
    expect(failing(reference(), candidate({ lastUploadAtMs: CAND_START + 40_000 }))).toEqual(["state.json"]);
  });

  it("still compares calendar dates", () => {
    expect(failing(reference(), candidate({ status: RANGE.replace("Sep 6", "Sep 7") }))).toEqual(["step status1"]);
  });

  it("would see one instant 277 s apart if each run measured it from its own start", () => {
    expect(failing(reference({ fixtureNowMs: undefined }), candidate({ fixtureNowMs: undefined }))).toEqual(["state.json"]);
  });
});

describe("readsScopedCcdStore", () => {
  it("holds hx from 77.15.1 and hx2 from 78.0.3 to the per-account Claude Desktop fixture", () => {
    expect(readsScopedCcdStore({ name: "hx", version: "77.11.0" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx", version: "77.13.9" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx", version: "77.14.0" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx", version: "77.15.0" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx", version: "77.15.1" })).toBe(true);
    expect(readsScopedCcdStore({ name: "hx", version: "78.0.0" })).toBe(true);
    expect(readsScopedCcdStore({ name: "hx2", version: "78.0.0" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx2", version: "78.0.2" })).toBe(false);
    expect(readsScopedCcdStore({ name: "hx2", version: "78.0.3" })).toBe(true);
    expect(readsScopedCcdStore({ name: "hx2", version: "79.0.0" })).toBe(true);
    expect(readsScopedCcdStore({ name: "hx", version: "dev" })).toBe(true);
  });
});

describe("side sessions in the fixture", () => {
  it("holds hx from 77.16.0 and hx2 from 78.0.5 to each group's side sessions", () => {
    expect(sendsSideSessions({ name: "hx", version: "77.15.1" })).toBe(false);
    expect(sendsSideSessions({ name: "hx", version: "77.16.0" })).toBe(true);
    expect(sendsSideSessions({ name: "hx2", version: "78.0.3" })).toBe(false);
    expect(sendsSideSessions({ name: "hx2", version: "78.0.4" })).toBe(false);
    expect(sendsSideSessions({ name: "hx2", version: "78.0.5" })).toBe(true);
    expect(sendsSideSessions({ name: "hx", version: "dev" })).toBe(true);
  });

  it("drops a group's side sessions, and the archived ones from archivedIds, for an older client", () => {
    const g = { id: "g", name: "G", subtitle: null, sectionName: null, collapsed: false, sessionIds: ["m", "x"], sideSessions: [{ id: "s", parent: "m" }] };
    const older = withoutSideSessions({ groupingEnabled: true, groups: [g], unreadIds: [], archivedIds: ["x", "s"] });
    expect(older.groups[0]).toEqual({ id: "g", name: "G", subtitle: null, sectionName: null, collapsed: false, sessionIds: ["m", "x"] });
    expect(older.archivedIds).toEqual(["x"]);
  });
});
