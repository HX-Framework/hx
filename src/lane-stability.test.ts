// Lane election must not oscillate across a sweep boundary.
//
// A child lane can have more than one on-disk candidate — a session whose cwd
// changed mid-run, a copied or rsync'd tree. electChildUploaders picks one
// winner per lane, and planChildLaneResets treats a CHANGE of winner as an
// uploader takeover and answers by clearing that lane's offsets.
//
// That is correct when the winner really changed. It is destructive when the
// winner only appears to change because one candidate is visible on some ticks
// and not others. The hourly child sweep created exactly that: a candidate in
// a dormant project dir was discovered on sweep ticks and invisible on all the
// others, so the elected winner flipped every tick, and every flip wiped
// offsets. A lane larger than one pass's drain would restart from zero every
// hour and never finish — the same "healed from zero fifteen times" pathology
// planChildLaneResets exists to prevent, reintroduced through visibility
// rather than through duplicate paths.
//
// The fix is that the sweep registers each rescued lane's session dir with the
// catalog, so the rescued candidate stays visible between sweeps. These tests
// pin the composition — catalog visibility, the merge, election and the reset
// plan across TWO passes with a persisted uploader map — which is the layer
// none of the unit suites reach.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryCatalog } from "./catalog.js";
import { discoverChildBackfill, mergeChildBackfill } from "./backfill.js";
import { sessionDirOfLane } from "./sources.js";
import { contestedChildLanes, electChildUploaders, planChildLaneResets } from "./watch.js";
import type { DataRoot, ResolvedRoots } from "./roots.js";

const DAY = 86_400_000;
const NOW = Date.now();
const FRESH = NOW - 5 * 60_000;
const NEWER = NOW - 60_000;      // newer than FRESH — wins election
const AGED = NOW - 400 * DAY;

let base: string;
const touch = (p: string, ms: number): void => utimesSync(p, new Date(ms), new Date(ms));

function mkRoots(): ResolvedRoots {
  base = mkdtempSync(join(tmpdir(), "hx-lane-"));
  mkdirSync(join(base, "claude", "projects"), { recursive: true });
  mkdirSync(join(base, "claude", "sessions"), { recursive: true });
  mkdirSync(join(base, "codex", "sessions"), { recursive: true });
  const root = (configDir: string): DataRoot => ({ configDir, origin: "default", exists: true });
  return { claude: [root(join(base, "claude"))], codex: [root(join(base, "codex"))] };
}

/** One copy of a session: parent transcript + one child lane, with the project
 *  dir's mtime pinned last (creations bump it; dormancy is the whole point). */
function mkCopy(project: string, sid: string, laneMtime: number, dirMtime: number): string {
  const projectDir = join(base, "claude", "projects", project);
  const subagents = join(projectDir, sid, "subagents");
  mkdirSync(subagents, { recursive: true });
  const parent = join(projectDir, `${sid}.jsonl`);
  writeFileSync(parent, "x".repeat(500));
  touch(parent, laneMtime);
  const lane = join(subagents, "agent-a1.jsonl");
  writeFileSync(lane, "z".repeat(1_000));
  touch(lane, laneMtime);
  touch(subagents, laneMtime);
  touch(join(projectDir, sid), dirMtime);
  touch(projectDir, dirMtime);
  return lane;
}

/** A workflow run (journal only) under a session dir, re-pinning the project
 *  and session dir mtimes afterwards — creating files bumps them, and dormancy
 *  is the condition under test. */
function mkRun(project: string, sid: string, runId: string, dirMtime: number): void {
  const projectDir = join(base, "claude", "projects", project);
  const runDir = join(projectDir, sid, "subagents", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const journal = join(runDir, "journal.jsonl");
  writeFileSync(journal, "{}");
  touch(journal, dirMtime);
  touch(runDir, dirMtime);
  touch(join(projectDir, sid, "subagents", "workflows"), dirMtime);
  touch(join(projectDir, sid, "subagents"), dirMtime);
  touch(join(projectDir, sid), dirMtime);
  touch(projectDir, dirMtime);
}

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("child lane election across a sweep boundary", () => {
  it("does not flip the elected uploader on the tick after a sweep", async () => {
    const roots = mkRoots();
    const sid = "11111111-1111-1111-1111-111111111111";
    // A: always visible — its project dir is fresh.
    const laneA = mkCopy("proj-live", sid, FRESH, FRESH);
    // B: the same lane, newer, inside a dormant worktree dir. The walk cannot
    // see it; only the sweep can.
    const laneB = mkCopy("proj-dormant", sid, NEWER, AGED);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    const walkOnly = cat.listChildren().children;
    assert.deepEqual(walkOnly.map((c) => c.path), [laneA], "only A is walkable");

    // ── Pass 1: a sweep tick. B is rescued and its session dir registered.
    const swept = await discoverChildBackfill(roots, { files: {} });
    const merged = mergeChildBackfill(walkOnly, [], swept.children, swept.runs);
    assert.equal(merged.added.some((c) => c.path === laneB), true, "the sweep must find B");
    for (const c of merged.added) cat.adoptSessionDir(c, NOW);

    const elected1 = electChildUploaders(merged.children);
    const plan1 = planChildLaneResets(elected1, {}, contestedChildLanes(merged.children));
    assert.deepEqual(elected1.map((c) => c.path), [laneB], "newer copy wins");

    // ── Pass 2: an ORDINARY tick. No sweep. This is where it used to flip.
    await cat.sweep(roots, NOW + 10_000);
    const pass2 = cat.listChildren().children.map((c) => c.path).sort();
    assert.deepEqual(pass2, [laneA, laneB].sort(), "B must stay visible between sweeps");

    const elected2 = electChildUploaders(cat.listChildren().children);
    const plan2 = planChildLaneResets(
      elected2,
      plan1.nextMap,
      contestedChildLanes(cat.listChildren().children),
    );
    assert.deepEqual(elected2.map((c) => c.path), [laneB], "the same copy must still win");
    assert.deepEqual(plan2.resetPaths, [], "no takeover, so no offsets cleared");
    assert.equal(plan2.changed, false, "the uploader map must be unchanged");
  });

  it("wipes offsets every pass if the rescued copy is NOT kept visible", async () => {
    // The defect itself. Test 1 protects the fix; this one pins why the fix is
    // NEEDED — identical setup, except the session dir is never registered.
    // If this ever goes red because planChildLaneResets learned to tolerate a
    // winner's absence, that is not a regression: it means adoptSessionDir has
    // become unnecessary and can be deleted along with this test.
    const roots = mkRoots();
    const sid = "22222222-2222-2222-2222-222222222222";
    const laneA = mkCopy("proj-live", sid, FRESH, FRESH);
    const laneB = mkCopy("proj-dormant", sid, NEWER, AGED);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    const swept = await discoverChildBackfill(roots, { files: {} });
    const sweepTick = mergeChildBackfill(cat.listChildren().children, [], swept.children, swept.runs);
    const plan1 = planChildLaneResets(
      electChildUploaders(sweepTick.children),
      {},
      contestedChildLanes(sweepTick.children),
    );
    assert.deepEqual(plan1.nextMap, { [`${sid}:a1:`]: laneB });

    // Next tick with no registration: B is gone again, A is elected, and the
    // change reads as a takeover.
    await cat.sweep(roots, NOW + 10_000);
    const plainTick = cat.listChildren().children;
    assert.deepEqual(plainTick.map((c) => c.path), [laneA], "B invisible without registration");
    const plan2 = planChildLaneResets(
      electChildUploaders(plainTick),
      plan1.nextMap,
      contestedChildLanes(plainTick),
    );
    assert.deepEqual(plan2.resetPaths, [laneA], "this is the hourly offset wipe");
  });

  it("leaves a single-candidate rescued lane alone on non-sweep ticks", async () => {
    // The benign case: with no twin, the lane is simply absent from `elected`
    // on a non-sweep tick, so the reset plan never touches it.
    const roots = mkRoots();
    const sid = "33333333-3333-3333-3333-333333333333";
    const lane = mkCopy("proj-dormant", sid, NEWER, AGED);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    assert.deepEqual(cat.listChildren().children, [], "nothing walkable");

    const swept = await discoverChildBackfill(roots, { files: {} });
    const plan1 = planChildLaneResets(
      electChildUploaders(swept.children),
      {},
      contestedChildLanes(swept.children),
    );
    assert.deepEqual(plan1.nextMap, { [`${sid}:a1:`]: lane });

    const plan2 = planChildLaneResets([], plan1.nextMap, new Set());
    assert.deepEqual(plan2.resetPaths, []);
    assert.equal(plan2.changed, false);
  });
});

describe("session-dir registration is gated to the lanes that need it", () => {
  it("does NOT register a dormant lane's dir", async () => {
    // The gate. A dormant lane cannot oscillate (it would have to be newer than
    // an in-window twin to displace it), and registering its dir is not free:
    // the walk's LANE scan is windowed, but its RUN scan is not — so a
    // registered dormant dir puts every workflow sidecar it holds back into the
    // per-tick syncWorkflowRun hashing, which reads each journal and script in
    // full. That run is the observable: it appears if and only if the dir got
    // registered, which makes this test fail the moment the gate is removed.
    const roots = mkRoots();
    const sid = "44444444-4444-4444-4444-444444444444";
    mkCopy("proj-dormant", sid, AGED, AGED);
    mkRun("proj-dormant", sid, "wf_dormant", AGED);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    const swept = await discoverChildBackfill(roots, { files: {} });
    assert.equal(swept.children.length, 1, "the sweep still rescues the lane itself");
    for (const c of swept.children) cat.adoptSessionDir(c, NOW);

    await cat.sweep(roots, NOW + 10_000);
    assert.deepEqual(cat.listChildren().runs, [], "no per-tick run hashing bought");
    assert.deepEqual(cat.listChildren().children, []);
  });

  it("registers an in-window lane's dir, runs and all — the accepted cost", async () => {
    // The other side of the same gate, so the trade-off is pinned rather than
    // implied: an in-window rescue IS registered, and its sidecars do rejoin
    // per-tick hashing. That is the price of keeping the lane visible, and the
    // window gate is what keeps the population paying it small.
    const roots = mkRoots();
    const sid = "66666666-6666-6666-6666-666666666666";
    mkCopy("proj-dormant", sid, NEWER, AGED);
    mkRun("proj-dormant", sid, "wf_live", NEWER);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    for (const c of (await discoverChildBackfill(roots, { files: {} })).children) {
      cat.adoptSessionDir(c, NOW);
    }
    await cat.sweep(roots, NOW + 10_000);
    assert.deepEqual(cat.listChildren().runs.map((r) => r.runId), ["wf_live"]);
  });

});

describe("sessionDirOfLane", () => {
  it("finds the session dir for both separators", () => {
    assert.equal(sessionDirOfLane("/a/b/sid/subagents/agent-x.jsonl"), "/a/b/sid");
    assert.equal(
      sessionDirOfLane("/a/b/sid/subagents/workflows/wf_1/agent-x.jsonl"),
      "/a/b/sid",
    );
    assert.equal(sessionDirOfLane("C:\\a\\sid\\subagents\\agent-x.jsonl"), "C:\\a\\sid");
  });

  it("returns null for a path that is not a lane", () => {
    assert.equal(sessionDirOfLane("/a/b/sid.jsonl"), null);
    assert.equal(sessionDirOfLane("/a/subagents-notreally/x.jsonl"), null);
  });
});
