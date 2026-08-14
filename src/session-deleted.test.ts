import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { HxHttpError } from "./uploader.js";
import { deletedSessionKey, isDeletedSession, type HxState } from "./state.js";

describe("HxHttpError.sessionDeleted", () => {
  it("recognizes the 410 session_deleted tombstone body", () => {
    const err = new HxHttpError(410, 'commit failed: 410 {"error":"session_deleted"}');
    assert.equal(err.sessionDeleted, true);
    // Not a server-unavailable and not a vault-offline — no backoff paths apply.
    assert.equal(err.serverUnavailable, false);
    assert.equal(err.vaultOffline, false);
  });

  it("does not fire for other 410s or other statuses", () => {
    assert.equal(new HxHttpError(410, "commit failed: 410 gone").sessionDeleted, false);
    assert.equal(
      new HxHttpError(404, 'commit failed: 404 {"error":"session_deleted"}').sessionDeleted,
      false,
    );
  });
});

describe("deletedSessions state map", () => {
  const state = (map?: Record<string, number>): HxState => ({
    files: {},
    ...(map ? { deletedSessions: map } : {}),
  });

  it("matches the exact family:sessionId key", () => {
    const s = state({ [deletedSessionKey("claude-cli", "sid-1")]: 1 });
    assert.equal(isDeletedSession(s, "claude-cli", "sid-1"), true);
    assert.equal(isDeletedSession(s, "claude-cli", "sid-2"), false);
  });

  it("matches cross-family by bare sessionId (stale child/sidecar families)", () => {
    const s = state({ [deletedSessionKey("claude-desktop", "sid-1")]: 1 });
    assert.equal(isDeletedSession(s, "claude-cli", "sid-1"), true);
  });

  it("is inert with no map", () => {
    assert.equal(isDeletedSession(state(), "claude-cli", "sid-1"), false);
  });
});
