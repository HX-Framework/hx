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

// The phantom: one device carried 43 offset keys for an org that advertised
// itself once during a routing experiment and was never seen again. Every one
// of those sessions read as owing its whole size, forever, with an empty log
// beside it — reconcileDestinations only ever runs inside the append-url path,
// so a file no longer on disk is never attempted and never repaired.
describe("pruneStrandedOffsetsFrom", () => {
  const entry = (offsets: Record<string, number>): FileState => ({
    path: "/p",
    family: "claude-cli",
    sessionId: "s",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
  });
  const stateWith = (
    offsets: Record<string, number>,
    destinations: HxState["destinations"],
  ): HxState => ({ files: { "/gone": { ...entry(offsets), path: "/gone" } }, destinations });
  const registry: HxState["destinations"] = {
    letai: { vaultOrgId: null, status: "ready", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
  };

  it("drops an unregistered key on a file that is gone", () => {
    const state = stateWith({ letai: 1000, phantom: 0 }, registry);
    const r = pruneStrandedOffsetsFrom(state, () => false);
    assert.deepEqual(r, { keys: 1, files: 1 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000 });
  });

  it("leaves a file that is STILL ON DISK alone", () => {
    // It will be attempted again, and append-url's reconcile is the right
    // repair — a newly attached vault also sits at 0 before any pass sees it.
    const state = stateWith({ letai: 1000, phantom: 0 }, registry);
    const r = pruneStrandedOffsetsFrom(state, () => true);
    assert.deepEqual(r, { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, phantom: 0 });
  });

  it("never touches a REGISTERED destination, however offline", () => {
    const state = stateWith({ letai: 1000, orgHeld: 0 }, {
      ...registry,
      orgHeld: { vaultOrgId: "orgHeld", status: "held", orgName: "Acme", orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
    });
    const r = pruneStrandedOffsetsFrom(state, () => false);
    assert.deepEqual(r, { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgHeld: 0 });
  });

  it("never touches the primary key", () => {
    const state = stateWith({ letai: 500 }, registry);
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
  });

  it("NEVER drops a key that has been written to, however unknown", () => {
    // A non-zero offset is proof the destination accepted bytes: setOffsetFor
    // records only after a successful commit. The registry is not reliably
    // complete — seedDestinationsFromBlockers seeds HELD destinations only, so
    // a first run after upgrade can name one offline Fortress and nothing else,
    // making every healthy destination look unknown. Without this guard, a
    // session fully delivered to a real Fortress and since pruned from disk
    // would have its proof of delivery erased and come back as a fabricated
    // gap in `hx doctor sync`.
    const state = stateWith({ letai: 1000, orgReal: 1000 }, registry);
    const r = pruneStrandedOffsetsFrom(state, () => false);
    assert.deepEqual(r, { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgReal: 1000 });
  });

  it("drops a zero-offset key while keeping a written one on the same file", () => {
    const state = stateWith({ letai: 1000, orgReal: 400, phantom: 0 }, registry);
    const r = pruneStrandedOffsetsFrom(state, () => false);
    assert.deepEqual(r, { keys: 1, files: 1 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgReal: 400 });
  });

  it("survives a registry seeded from blockers alone (held-only)", () => {
    // The realistic post-upgrade shape: the registry names the offline org and
    // nothing else, so a delivered Fortress reads as unknown.
    const heldOnly: HxState["destinations"] = {
      orgHeld: {
        vaultOrgId: "orgHeld",
        status: "held",
        orgName: null,
        orgSlug: null,
        lastSeenAt: null,
        observedAtMs: 0,
      },
    };
    const state = stateWith({ letai: 1000, orgDelivered: 1000 }, heldOnly);
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgDelivered: 1000 });
  });

  it("NEVER drops a key another file proves is real", () => {
    // The cross-file case: /gone sits at 0 for orgX, but /here has committed
    // 500 bytes to it, so orgX is a live store and /gone's 0 is a real gap.
    // Deleting it rewrote minOffset to "complete" and erased that gap from
    // collectBehind and `hx doctor sync` permanently — the source file is gone
    // and orgX never received a byte of it.
    const state: HxState = {
      files: {
        "/gone": { ...entry({ letai: 1000, orgX: 0 }), path: "/gone" },
        "/here": { ...entry({ letai: 1000, orgX: 500 }), path: "/here" },
      },
      destinations: registry,
    };
    const r = pruneStrandedOffsetsFrom(state, (p) => p === "/here");
    assert.deepEqual(r, { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgX: 0 });
  });

  it("does nothing at all when no registry has ever been recorded", () => {
    // "we have never seen a destination" must not read as "every destination
    // is dead" — that would wipe real offsets on an old state file.
    const state = stateWith({ letai: 1000, orgA: 0 }, undefined);
    assert.deepEqual(pruneStrandedOffsetsFrom(state, () => false), { keys: 0, files: 0 });
    assert.deepEqual(state.files["/gone"]!.offsets, { letai: 1000, orgA: 0 });
  });
});
