import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { codexDestinations } from "./title-sync.js";

// The daemon supplies these destinations to /sessions/retitle; the cloud enqueues
// one title job per destination. They MUST be where the content actually lives
// (LETAIR-481 F17) — re-resolving cloud-side from current attribution would
// misroute a reattributed session.
describe("codexDestinations — the authoritative content homes", () => {
  it("maps offset keys with bytes to vaultOrgIds; 'letai' → null (default fortress)", () => {
    assert.deepEqual(codexDestinations({ letai: 100, "org-1": 50 }), [null, "org-1"]);
  });

  it("drops a destination with a zero offset (nothing uploaded there)", () => {
    assert.deepEqual(codexDestinations({ letai: 0, "org-1": 42 }), ["org-1"]);
  });

  it("returns [] for undefined state, no offsets, or all-zero offsets", () => {
    assert.deepEqual(codexDestinations(undefined), []);
    assert.deepEqual(codexDestinations({}), []);
    assert.deepEqual(codexDestinations({ letai: 0 }), []);
  });
});
