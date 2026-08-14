import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  clearBlockedFailuresFromState,
  destKey,
  offsetFor,
  migrateFileState,
  reconcileDestinationOffsets,
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
