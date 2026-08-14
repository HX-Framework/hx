import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { planFanout } from "./fanout.js";
import type { FileState } from "./state.js";

const fState: FileState = {
  path: "/p",
  family: "claude-cli",
  sessionId: "s",
  offsets: { letai: 10 },
  lastMtimeMs: 0,
  lastUploadAtMs: 0,
};

describe("planFanout", () => {
  it("falls back to a single legacy step when destinations is absent", () => {
    const steps = planFanout(
      { chunkId: "c1", uploadUrl: "u1", objectName: "o", expiresAt: "z", vaultOrgId: null },
      fState,
    );
    assert.deepEqual(steps, [{ vaultOrgId: null, chunkId: "c1", uploadUrl: "u1", replace: false }]);
  });

  it("emits one step per ready destination with per-destination replace flags", () => {
    const steps = planFanout(
      {
        chunkId: "c1",
        uploadUrl: "u1",
        objectName: "o",
        expiresAt: "z",
        vaultOrgId: null,
        destinations: [
          { vaultOrgId: null, chunkId: "c1", uploadUrl: "u1", objectName: "o", expiresAt: "z", status: "ready" },
          { vaultOrgId: "orgA", chunkId: "c2", uploadUrl: "u2", objectName: "o", expiresAt: "z", status: "ready" },
        ],
      },
      fState,
    );
    assert.deepEqual(steps, [
      { vaultOrgId: null, chunkId: "c1", uploadUrl: "u1", replace: false }, // offset 10 → append
      { vaultOrgId: "orgA", chunkId: "c2", uploadUrl: "u2", replace: true }, // offset 0 → replace
    ]);
  });

  it("skips held destinations", () => {
    const steps = planFanout(
      {
        chunkId: "c1",
        uploadUrl: "u1",
        objectName: "o",
        expiresAt: "z",
        vaultOrgId: null,
        destinations: [
          { vaultOrgId: null, chunkId: "c1", uploadUrl: "u1", objectName: "o", expiresAt: "z", status: "ready" },
          { vaultOrgId: "orgA", status: "held", reason: "vault_offline", orgName: "Acme" },
        ],
      },
      fState,
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.vaultOrgId, null);
  });
});
