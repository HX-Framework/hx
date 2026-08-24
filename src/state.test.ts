import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  clearBlockedFailuresFromState,
  destKey,
  offsetFor,
  migrateFileState,
  reconcileDestinationOffsets,
  pruneStrandedOffsetsFrom,
  type FileState,
  type HxState,
} from "./state.js";

describe("destKey", () => {
  it("maps null to letai and an org id to itself", () => {
    assert.equal(destKey(null), "letai");
    assert.equal(destKey("orgA"), "orgA");
  });
});

describe("offsetFor", () => {
  const fs = (offsets: Record<string, number>): FileState => ({
    path: "/p",
    family: "claude-cli",
    sessionId: "s",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
  });
  it("returns 0 for an unknown destination", () => {
    assert.equal(offsetFor(fs({}), null), 0);
  });
  it("returns the stored per-destination offset", () => {
    assert.equal(offsetFor(fs({ letai: 42, orgA: 7 }), null), 42);
    assert.equal(offsetFor(fs({ letai: 42, orgA: 7 }), "orgA"), 7);
  });
});

describe("reconcileDestinationOffsets", () => {
  it("adds new destinations at zero and prunes detached destinations", () => {
    const offsets = { letai: 100, oldOrg: 20 };
    assert.equal(reconcileDestinationOffsets(offsets, ["letai", "newOrg"]), true);
    assert.deepEqual(offsets, { letai: 100, newOrg: 0 });
    assert.equal(reconcileDestinationOffsets(offsets, ["letai", "newOrg"]), false);
  });
});

describe("clearBlockedFailuresFromState", () => {
  it("clears transient holds without changing offsets", () => {
    const entry: FileState = {
      path: "/a",
      family: "claude-cli",
      sessionId: "s1",
      offsets: { orgA: 12 },
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
      consecutiveFailures: 3,
      nextAttemptAtMs: 99,
      skipReason: "vault_offline",
      blocker: {
        reason: "vault_offline",
        destinations: [],
        firstSeenAtMs: 1,
        lastSeenAtMs: 2,
      },
    };
    const state: HxState = { files: { [entry.path]: entry } };
    assert.deepEqual(clearBlockedFailuresFromState(state), { files: 1, sessions: 1 });
    assert.deepEqual(entry.offsets, { orgA: 12 });
    assert.equal(entry.skipReason, undefined);
    assert.equal(entry.nextAttemptAtMs, undefined);
    assert.equal(entry.blocker, undefined);
  });
});

describe("migrateFileState", () => {
  it("moves a legacy single offset into offsets keyed by letai", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offset: 99,
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, { letai: 99 });
    assert.equal("offset" in out, false);
  });

  it("leaves an already-migrated state untouched", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offsets: { orgA: 5 },
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, { orgA: 5 });
  });

  it("defaults to empty offsets when neither field is present", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, {});
  });

  it("carries a persisted skipReason through the migration", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offsets: { letai: 5 },
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
      skipReason: "vault_offline",
    });
    assert.equal(out.skipReason, "vault_offline");
  });

  it("carries structured blocker metadata through the migration", () => {
    const blocker = {
      reason: "vault_offline" as const,
      destinations: [],
      firstSeenAtMs: 100,
      lastSeenAtMs: 200,
    };
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offsets: { letai: 5 },
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
      blocker,
    });
    assert.deepEqual(out.blocker, blocker);
  });
});

// The dead key has to leave state, or it is carried for the life of the entry.
// reconcileDestinations only runs inside append-url, so it can repair a file
// the daemon still uploads and never one that has left the disk.
describe("pruneStrandedOffsetsFrom", () => {
  const entry = (path: string, offsets: Record<string, number>): FileState =>
    ({ path, family: "claude-cli", sessionId: path, offsets, lastMtimeMs: 0, lastUploadAtMs: 0 }) as FileState;
  const registry: HxState["destinations"] = {
    letai: { vaultOrgId: null, status: "ready", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
  };
  const stateWith = (offsets: Record<string, number>, destinations = registry, extra?: Record<string, number>): HxState => {
    const files: HxState["files"] = { "/gone": entry("/gone", offsets) };
    if (extra) files["/here"] = entry("/here", extra);
    return { files, destinations };
  };

  it("drops a phantom on a file that has left the disk", () => {
    const state = stateWith({ letai: 1000, phantom: 0 });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 1, files: 1 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000 });
  });

  it("leaves a file that is STILL ON DISK to append-url's reconcile", () => {
    const state = stateWith({ letai: 1000, phantom: 0 });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => true), { keys: 0, files: 0 });
  });

  it("never drops a key with bytes of its own", () => {
    const state = stateWith({ letai: 1000, orgReal: 400 });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
  });

  it("never drops a key another file has written to", () => {
    const state = stateWith({ letai: 1000, orgReal: 0 }, registry, { letai: 1000, orgReal: 500 });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, (p) => p === "/here"), { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgReal: 0 });
  });

  it("never drops the primary key", () => {
    const state = stateWith({ letai: 0 });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
  });

  it("never drops a REGISTERED destination", () => {
    const state = stateWith({ letai: 1000, orgHeld: 0 }, {
      ...registry,
      orgHeld: { vaultOrgId: "orgHeld", status: "held", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
    });
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
  });

  it("does nothing when no registry has ever been recorded", () => {
    // Built without going through stateWith: passing `undefined` for a
    // defaulted parameter selects the DEFAULT, so the helper would have handed
    // this test a registry and it would have proved nothing.
    const state: HxState = { files: { "/gone": entry("/gone", { letai: 1000, orgA: 0 }) } };
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgA: 0 });
  });
});
