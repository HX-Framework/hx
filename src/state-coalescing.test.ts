// Coalesced persistence (LETAIR-144 WS2) — mode scoping, flush-through set,
// and flush points. The contract under test:
//   • default mode = flush-through for EVERY mutator (what `hx retry`,
//     `hx backfill`, the UI server, `hx tick` and `watch --once` rely on);
//   • coalesced mode (daemon-only opt-in) turns bookkeeping writes into
//     dirty marks, flushed by flushStateIfDirty;
//   • setOffsetFor and the three post-success transition clears stay
//     flush-through in BOTH modes, and their full-state write carries any
//     pending coalesced mutations with it.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armCoalescedPersistence,
  clearDestinationUploadError,
  clearFileFailure,
  clearHeal,
  disarmCoalescedPersistence,
  flushStateIfDirty,
  hasDirtyState,
  loadState,
  recordDeletedSession,
  recordDestinationUploadError,
  recordFileFailure,
  resetStateCache,
  setOffsetFor,
  setStateDirForTests,
  touchMtime,
  upsertFileState,
  clearAllFailures,
  type FileState,
} from "./state.js";

let dir: string;

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "hx-state-"));
  setStateDirForTests(dir);
  resetStateCache("main");
  resetStateCache("local");
  return dir;
}

function diskState(): { files: Record<string, FileState> } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
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
  it("persists every mutator immediately — the non-daemon writers' contract", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    assert.ok(existsSync(join(dir, "state.json")), "upsert reached disk");
    assert.ok(diskState().files["/a"], "entry on disk");

    await touchMtime("/a", 42);
    assert.equal(diskState().files["/a"]!.lastMtimeMs, 42, "touch reached disk");

    await recordFileFailure("/a", 1000);
    assert.equal(diskState().files["/a"]!.consecutiveFailures, 1, "failure stamp reached disk");
    assert.equal(hasDirtyState("main"), false, "nothing marks dirty in flush-through mode");
  });

  it("clearAllFailures reaches disk before returning (hx retry's contract)", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await recordFileFailure("/a", 1000);
    const cleared = await clearAllFailures();
    assert.equal(cleared.files, 1);
    assert.equal(diskState().files["/a"]!.consecutiveFailures, undefined);
    assert.equal(diskState().files["/a"]!.nextAttemptAtMs, undefined);
  });
});

describe("coalesced mode", () => {
  it("marks bookkeeping writes dirty instead of writing, until a flush point", async () => {
    freshDir();
    await upsertFileState(entry("/a")); // seed on disk before arming
    armCoalescedPersistence("main");

    await touchMtime("/a", 777);
    await recordFileFailure("/a", 1000);
    assert.equal(hasDirtyState("main"), true, "mutations marked dirty");
    assert.equal(diskState().files["/a"]!.lastMtimeMs, 1, "disk untouched before flush");

    await flushStateIfDirty("main");
    assert.equal(hasDirtyState("main"), false);
    assert.equal(diskState().files["/a"]!.lastMtimeMs, 777, "flush wrote the pending mutations");
    assert.equal(diskState().files["/a"]!.consecutiveFailures, 1);
  });

  it("keeps setOffsetFor flush-through and carries pending mutations with it", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");

    await upsertFileState(entry("/b")); // coalesced: dirty, not on disk yet
    assert.equal(diskState().files["/b"], undefined);

    await setOffsetFor("/a", null, 4096, 5);
    const disk = diskState();
    assert.equal(disk.files["/a"]!.offsets["letai"], 4096, "offset durable at return");
    assert.ok(disk.files["/b"], "full-state write carried the pending coalesced entry");
    assert.equal(hasDirtyState("main"), false, "flush-through clears the dirty flag");
  });

  it("keeps the three post-success transition clears flush-through", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    await recordFileFailure("/a", 1000, "main", "vault_offline");
    armCoalescedPersistence("main");

    await clearFileFailure("/a");
    assert.equal(diskState().files["/a"]!.skipReason, undefined, "clearFileFailure durable");

    await recordDestinationUploadError("letai", "403 SignatureDoesNotMatch");
    assert.equal(hasDirtyState("main"), true, "error record itself is coalesce-eligible");
    await clearDestinationUploadError("letai");
    const destsOnDisk = diskState().destinations as Record<string, { consecutiveErrors?: number }>;
    assert.equal(destsOnDisk["letai"]!.consecutiveErrors, undefined, "clearDestinationUploadError durable");
    assert.equal(hasDirtyState("main"), false, "its full-state write flushed the pending record too");

    const st = await loadState("main");
    st.files["/a"]!.healCount = 2;
    await clearHeal("/a");
    assert.equal(diskState().files["/a"]!.healCount, undefined, "clearHeal durable");
  });

  it("tombstone records are coalesce-eligible and flushable", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    armCoalescedPersistence("main");
    await recordDeletedSession("claude-cli", "sid-x");
    assert.equal(hasDirtyState("main"), true);
    assert.equal(diskState().deletedSessions, undefined, "not yet on disk");
    await flushStateIfDirty("main");
    assert.ok((diskState().deletedSessions as Record<string, number>)["claude-cli:sid-x"]);
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
    assert.ok(diskState().files["/m"], "main wrote immediately");
  });
});

describe("persist format", () => {
  it("writes compact JSON that round-trips unknown top-level keys", async () => {
    freshDir();
    await upsertFileState(entry("/a"));
    const raw = readFileSync(join(dir, "state.json"), "utf8");
    assert.ok(!raw.includes("\n  "), "no pretty-print indentation");
    // Additive-key round-trip (the chunkCaps contract): unknown top-level
    // keys survive load → mutate → persist.
    const withExtra = { ...JSON.parse(raw), chunkCaps: { letai: 8388608 } };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "state.json"), JSON.stringify(withExtra));
    resetStateCache("main");
    await touchMtime("/a", 123);
    assert.deepEqual(diskState()["chunkCaps"], { letai: 8388608 });
  });
});
