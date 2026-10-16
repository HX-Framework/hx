// Persistence modes and the offsets journal. The contract under test:
//   • default mode = flush-through for every bookkeeping mutator (what
//     `hx retry`, `hx backfill`, the UI server, `hx tick` and `watch --once`
//     rely on): the snapshot is current when each returns;
//   • coalesced mode (daemon-only opt-in) turns bookkeeping writes into dirty
//     marks, journaled by flushStateIfDirty;
//   • setOffsetFor and the three post-success transition clears JOURNAL
//     before returning, in both modes — durable at return without rewriting
//     the snapshot;
//   • every reader replays the journal over the snapshot; a checkpoint folds
//     the journal into the snapshot and empties it; a one-shot pass's flush
//     point is a checkpoint, a daemon's is one on the interval or size bound.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armCoalescedPersistence,
  checkpointState,
  replayJournalText,
  clearDestinationUploadError,
  clearFileFailure,
  clearHeal,
  disarmCoalescedPersistence,
  flushStateIfDirty,
  hasDirtyState,
  journalBytes,
  loadState,
  recordDeletedSession,
  recordDestinationUploadError,
  recordFileFailure,
  resetStateCache,
  setCheckpointPolicyForTests,
  setOffsetFor,
  setStateDirForTests,
  stateFlushDue,
  touchMtime,
  upsertFileState,
  clearAllFailures,
  type FileState,
  type HxState,
} from "./state.js";

let dir: string;

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "hx-state-"));
  setStateDirForTests(dir);
  resetStateCache("main");
  resetStateCache("local");
  return dir;
}

/** The snapshot alone, as a reader that ignored the journal would see it. */
function snapshot(): { files: Record<string, FileState> } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

/** The journal's lines (empty when absent). */
function journalLines(scope = "main"): string[] {
  const p = join(dir, scope === "main" ? "state.journal.jsonl" : "state.local.journal.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
}

/** What a FRESH process reads: the snapshot with the journal replayed over
 *  it — the loader's rule, applied here without touching this process's
 *  cache or dirty marks (another process has neither). */
async function freshView(scope: "main" | "local" = "main"): Promise<HxState> {
  const snap = join(dir, scope === "main" ? "state.json" : "state.local.json");
  const state: HxState = existsSync(snap) ? (JSON.parse(readFileSync(snap, "utf8")) as HxState) : { files: {} };
  replayJournalText(state, journalLines(scope).join("\n"));
  return state;
}

function entry(path: string): FileState {
  return {
    path,
    family: "claude-cli",
    sessionId: `sid-${path}`,
    offsets: {},
    lastMtimeMs: 1,
    lastUploadAtMs: 0,
  };
}

afterEach(() => {
  disarmCoalescedPersistence("main");
  disarmCoalescedPersistence("local");
  setCheckpointPolicyForTests(null);
  setStateDirForTests(null);
  resetStateCache("main");
  resetStateCache("local");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* tmpdir cleanup is best-effort */
  }
});

describe("default (flush-through) mode", () => {
  it("writes the snapshot for every bookkeeping mutator — the non-daemon writers' contract", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    assert.ok(existsSync(join(dir, "state.json")), "upsert reached the snapshot");
    assert.ok(snapshot().files["/a"], "entry in the snapshot");

    await touchMtime("/a", 42);
    assert.equal(snapshot().files["/a"]!.lastMtimeMs, 42, "touch reached the snapshot");

    await recordFileFailure("/a", 1000);
    assert.equal(snapshot().files["/a"]!.consecutiveFailures, 1, "failure stamp reached the snapshot");
    assert.equal(hasDirtyState("main"), false, "nothing marks dirty in flush-through mode");
    assert.deepEqual(journalLines(), [], "bookkeeping never touches the journal here");
  });

  it("clearAllFailures reaches the snapshot before returning (hx retry's contract)", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await recordFileFailure("/a", 1000);
    const cleared = await clearAllFailures();
    assert.equal(cleared.files, 1);
    assert.equal(snapshot().files["/a"]!.consecutiveFailures, undefined);
    assert.equal(snapshot().files["/a"]!.nextAttemptAtMs, undefined);
  });

  it("setOffsetFor journals the whole file entry instead of rewriting the snapshot", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    const before = readFileSync(join(dir, "state.json"), "utf8");
    await setOffsetFor("/a", null, 4096, 5);
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before, "the snapshot is untouched");
    const lines = journalLines();
    assert.equal(lines.length, 1, "one journal line per committed chunk");
    const line = JSON.parse(lines[0]!) as { t: string; path: string; state: FileState };
    assert.equal(line.t, "file");
    assert.equal(line.path, "/a");
    assert.equal(line.state.offsets["letai"], 4096, "the line carries the whole entry");
    assert.ok(journalBytes("main") > 0);
    // A fresh process — hx status, the UI server — sees the offset at once.
    assert.equal((await freshView()).files["/a"]!.offsets["letai"], 4096);
  });

  it("the pass-end flush of a one-shot run folds the journal into the snapshot and empties it", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await setOffsetFor("/a", null, 4096, 5);
    await setOffsetFor("/a", null, 8192, 6);
    assert.equal(journalLines().length, 2);
    assert.equal(stateFlushDue("main"), true, "a non-empty journal is due outside the daemon");
    await flushStateIfDirty("main");
    assert.equal(snapshot().files["/a"]!.offsets["letai"], 8192, "folded into the snapshot");
    assert.deepEqual(journalLines(), [], "journal emptied");
    assert.equal(journalBytes("main"), 0);
    assert.equal(stateFlushDue("main"), false);
  });
});

describe("coalesced mode", () => {
  it("marks bookkeeping dirty, journals it at the flush point, and leaves the snapshot alone until a checkpoint", async () => {
    freshDir();
    await upsertFileState(entry("/a")); // seed the snapshot before arming
    armCoalescedPersistence("main");

    await touchMtime("/a", 777);
    await recordFileFailure("/a", 1000);
    assert.equal(hasDirtyState("main"), true, "mutations marked dirty");
    assert.equal(snapshot().files["/a"]!.lastMtimeMs, 1, "snapshot untouched before the flush");
    assert.deepEqual(journalLines(), [], "nothing journaled before the flush");

    await flushStateIfDirty("main");
    assert.equal(hasDirtyState("main"), false);
    assert.equal(journalLines().length, 1, "one line for the one dirty record (both mutations hit /a)");
    assert.equal(snapshot().files["/a"]!.lastMtimeMs, 1, "the daemon does not rewrite the snapshot per flush");
    const view = await freshView();
    assert.equal(view.files["/a"]!.lastMtimeMs, 777, "a fresh reader sees the journaled mutations");
    assert.equal(view.files["/a"]!.consecutiveFailures, 1);
  });

  it("setOffsetFor is durable at return and does not fold other pending records", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");

    await upsertFileState(entry("/b")); // coalesced: dirty, nowhere on disk yet
    assert.equal(snapshot().files["/b"], undefined);

    await setOffsetFor("/a", null, 4096, 5);
    assert.equal(journalLines().length, 1, "the offset line, and only it");
    assert.equal((await freshView()).files["/a"]!.offsets["letai"], 4096, "offset durable at return");
    assert.equal(hasDirtyState("main"), true, "/b stays dirty for the next flush point");
    await flushStateIfDirty("main");
    assert.equal(hasDirtyState("main"), false);
    assert.ok((await freshView()).files["/b"], "the flush journaled the pending seed");
  });

  it("keeps the three post-success transition clears durable at return", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await recordFileFailure("/a", 1000, "main", "vault_offline");
    armCoalescedPersistence("main");

    await clearFileFailure("/a");
    assert.equal((await freshView()).files["/a"]!.skipReason, undefined, "clearFileFailure durable");

    await recordDestinationUploadError("letai", "403 SignatureDoesNotMatch");
    assert.equal(hasDirtyState("main"), true, "error record itself is coalesce-eligible");
    await clearDestinationUploadError("letai");
    const dests = (await freshView()).destinations as Record<string, { consecutiveErrors?: number }>;
    assert.equal(dests["letai"]!.consecutiveErrors, undefined, "clearDestinationUploadError durable");
    assert.equal(hasDirtyState("main"), false, "the journaled record is no longer dirty");

    const st = await loadState("main");
    st.files["/a"]!.healCount = 2;
    await clearHeal("/a");
    assert.equal((await freshView()).files["/a"]!.healCount, undefined, "clearHeal durable");
  });

  it("tombstone records are coalesce-eligible and journaled whole", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");
    await recordDeletedSession("claude-cli", "sid-x");
    assert.equal(hasDirtyState("main"), true);
    assert.equal(snapshot().deletedSessions, undefined, "not yet on disk");
    await flushStateIfDirty("main");
    assert.ok(((await freshView()).deletedSessions as Record<string, number>)["claude-cli:sid-x"]);
  });

  it("checkpoints on the size bound and on the interval, and checkpointState folds unconditionally", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");
    setCheckpointPolicyForTests({ journalBytes: 400 });
    await setOffsetFor("/a", null, 1, 1);
    assert.ok(journalLines().length === 1 && journalBytes("main") < 400);
    assert.equal(stateFlushDue("main"), false, "under both bounds: nothing due");
    await flushStateIfDirty("main");
    assert.equal(journalLines().length, 1, "no checkpoint under the bounds");
    await setOffsetFor("/a", null, 2, 2);
    await setOffsetFor("/a", null, 3, 3);
    assert.ok(journalBytes("main") >= 400, "past the size bound");
    assert.equal(stateFlushDue("main"), true);
    await flushStateIfDirty("main");
    assert.equal(snapshot().files["/a"]!.offsets["letai"], 3, "size bound folded the journal");
    assert.deepEqual(journalLines(), []);

    setCheckpointPolicyForTests({ intervalMs: 0 });
    await setOffsetFor("/a", null, 4, 4);
    assert.equal(stateFlushDue("main"), true, "interval elapsed (zero) with a journaled line");
    await flushStateIfDirty("main");
    assert.equal(snapshot().files["/a"]!.offsets["letai"], 4, "interval folded the journal");

    setCheckpointPolicyForTests(null);
    await upsertFileState(entry("/b"));
    await touchMtime("/b", 99);
    await setOffsetFor("/a", null, 5, 5);
    await checkpointState("main");
    assert.equal(hasDirtyState("main"), false);
    assert.equal(snapshot().files["/a"]!.offsets["letai"], 5, "forced fold wrote the snapshot");
    assert.equal(snapshot().files["/b"]!.lastMtimeMs, 99, "and the dirty touch of the other file with it");
    assert.deepEqual(journalLines(), []);
    await checkpointState("main");
    assert.deepEqual(journalLines(), [], "a second forced fold with nothing pending is a no-op");
  });

  it("a whole-state mutation (persistState: lane flips) makes the next flush a checkpoint", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");
    const { persistState } = await import("./state.js");
    const st = await loadState("main");
    st.childUploaders = { "sid:a1:": "/lane" };
    await persistState("main");
    assert.equal(hasDirtyState("main"), true);
    await flushStateIfDirty("main");
    assert.deepEqual(snapshot()["childUploaders"], { "sid:a1:": "/lane" }, "folded straight into the snapshot");
    assert.deepEqual(journalLines(), []);
  });

  it("scopes independently — the tee lane's mode never leaks to main", async () => {
    freshDir();
    await upsertFileState(entry("/a"), "local");
    armCoalescedPersistence("local");
    await touchMtime("/a", 99, "local");
    assert.equal(hasDirtyState("local"), true);
    assert.equal(hasDirtyState("main"), false);
    // main stays flush-through while local is armed
    await upsertFileState(entry("/m"), "main");
    assert.ok(snapshot().files["/m"], "main wrote its snapshot immediately");
    await setOffsetFor("/a", null, 7, 7, "local");
    assert.equal(journalLines("local").length, 1, "the tee lane has its own journal");
    assert.deepEqual(journalLines("main"), []);
  });
});

describe("flush failure resilience", () => {
  it("a failed journal write re-marks the records dirty and the next flush point retries", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");
    await touchMtime("/a", 500);
    assert.equal(hasDirtyState("main"), true);

    // Point the state dir somewhere unwritable (a path under a plain FILE —
    // mkdir recursive fails deterministically on every platform).
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir");
    setStateDirForTests(join(blocker, "sub"));
    await assert.rejects(flushStateIfDirty("main"), "double-failed write rejects to the caller");
    assert.equal(hasDirtyState("main"), true, "records re-marked — the timer will retry");

    // Heal the path: the retry journals everything that was pending.
    setStateDirForTests(dir);
    await flushStateIfDirty("main");
    assert.equal(hasDirtyState("main"), false);
    assert.equal((await freshView()).files["/a"]!.lastMtimeMs, 500, "pending mutation survived the outage");
  });

  it("a failed snapshot write leaves the journal in place", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await setOffsetFor("/a", null, 10, 1);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir");
    setStateDirForTests(join(blocker, "sub"));
    await assert.rejects(checkpointState("main"));
    setStateDirForTests(dir);
    assert.equal(journalLines().length, 1, "nothing was truncated");
    assert.equal((await freshView()).files["/a"]!.offsets["letai"], 10);
  });
});

describe("readers", () => {
  it("replay a torn trailing line as absent and keep everything before it", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await setOffsetFor("/a", null, 100, 1);
    const p = join(dir, "state.journal.jsonl");
    writeFileSync(p, `${readFileSync(p, "utf8")}{"t":"file","path":"/a","state":{"offs`);
    assert.equal((await freshView()).files["/a"]!.offsets["letai"], 100);
  });

  it("the snapshot stays compact JSON and round-trips unknown top-level keys", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    const raw = readFileSync(join(dir, "state.json"), "utf8");
    assert.ok(!raw.includes("\n  "), "no pretty-print indentation");
    // Additive-key round-trip (the chunkCaps contract): unknown top-level
    // keys survive load → mutate → persist — through a checkpoint too.
    const withExtra = { ...JSON.parse(raw), chunkCaps: { letai: 8388608 } };
    writeFileSync(join(dir, "state.json"), JSON.stringify(withExtra));
    resetStateCache("main");
    await touchMtime("/a", 123);
    assert.deepEqual(snapshot()["chunkCaps"], { letai: 8388608 });
    await setOffsetFor("/a", null, 1, 1);
    await checkpointState("main");
    assert.deepEqual(snapshot()["chunkCaps"], { letai: 8388608 }, "kept across a checkpoint");
  });
});
