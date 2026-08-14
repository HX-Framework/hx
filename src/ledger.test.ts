import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildLedger, classifyFile, isDestinationOffline, LIVE_WINDOW_MS, needsAttention } from "./ledger.js";
import {
  applyDestinationReports,
  applyDestinationUploadError,
  applyDestinationUploadSuccess,
  clearAllFailuresFromState,
  clearGenericBackoffsFromState,
  type FileState,
  type HxState,
} from "./state.js";

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const DAY = 86_400_000;

const file = (path: string, size: number, ageMs = LIVE_WINDOW_MS * 2) => ({
  path,
  size,
  mtimeMs: NOW - ageMs,
});

const entry = (path: string, offsets: Record<string, number>, extra: Partial<FileState> = {}): FileState => ({
  path,
  family: "claude-cli",
  sessionId: path,
  offsets,
  lastMtimeMs: NOW,
  lastUploadAtMs: NOW,
  ...extra,
});

/** A state with one offline Fortress ("orgA") and the primary bucket ready. */
function stateWithOfflineFortress(files: Record<string, FileState>, heldDays = 13): HxState {
  const state: HxState = { files };
  applyDestinationReports(
    state,
    [
      { vaultOrgId: null, status: "ready" },
      { vaultOrgId: "orgA", status: "held", orgName: "Den Co", lastSeenAt: null },
    ],
    NOW - heldDays * DAY,
  );
  return state;
}

describe("ledger classification", () => {
  it("counts a session delivered to every reachable store as delivered", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 100, orgA: 100 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "delivered");
  });

  it("is WAITING, not uploading, when only an offline store is owed bytes", () => {
    // The regression the whole redesign exists for: fully on the primary,
    // nothing on an offline Fortress. minOffset() scored this 0 and dragged
    // the device below 100% forever.
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 100, orgA: 0 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "waiting");
    assert.equal(c.offline.get("orgA"), 100);
    assert.equal(c.reachableBytes, 0);
  });

  it("is UPLOADING when a reachable store is behind", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 40, orgA: 0 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "uploading");
    assert.equal(c.reachableBytes, 60);
  });

  it("treats a live session as in progress even with an unsent tail", () => {
    // A live jsonl always has a few bytes in flight between the write and the
    // next tick; counting that as backlog is what kept the number off 100%.
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 90 }) });
    const c = classifyFile(file("a", 100, 60_000), state, NOW);
    assert.equal(c.state, "live");
  });

  it("reclassifies once the live window lapses", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 90 }) });
    const c = classifyFile(file("a", 100, LIVE_WINDOW_MS + 1_000), state, NOW);
    assert.equal(c.state, "uploading");
  });

  it("never excuses the primary bucket, even if reported held", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: null, status: "held" }], NOW);
    assert.equal(isDestinationOffline(state, "letai"), false);
  });

  it("bills a never-seeded file to the primary as real backlog", () => {
    const state: HxState = { files: {} };
    const c = classifyFile(file("new", 500), state, NOW);
    assert.equal(c.state, "uploading");
    assert.equal(c.reachableBytes, 500);
  });
});

describe("ledger percentage", () => {
  it("reads 100% when the only stragglers are live tails and offline stores", () => {
    const files = {
      done: entry("done", { letai: 10, orgA: 10 }),
      held: entry("held", { letai: 10, orgA: 0 }),
      live: entry("live", { letai: 5 }),
    };
    const ledger = buildLedger({
      files: [file("done", 10), file("held", 10), file("live", 10, 1_000)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.percent, 100);
    assert.equal(ledger.delivered, 1);
    assert.equal(ledger.waiting, 1);
    assert.equal(ledger.live, 1);
    // The parts must account for every session — the number is auditable.
    assert.equal(
      ledger.delivered + ledger.live + ledger.uploading + ledger.waiting + ledger.incomplete,
      ledger.total,
    );
  });

  it("drops below 100% for a real backlog", () => {
    const files = { a: entry("a", { letai: 0 }), b: entry("b", { letai: 10 }) };
    const ledger = buildLedger({
      files: [file("a", 10), file("b", 10)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.uploading, 1);
    assert.equal(ledger.percent, 50);
  });

  // DELIBERATE REVERSAL. This asserted that a session whose file is gone pulls
  // the percentage down (9/10 = 90%). It no longer does, and it no longer
  // counts toward the total.
  //
  // Claude Code prunes transcripts after 30 days, so EVERY session eventually
  // leaves the disk. Treating the unconfirmed ones as a fault built a pile that
  // only grew, and nothing in it can be acted on — there is no file left to
  // send. On two real devices that pile was wrong 8 times out of 10 and about
  // 100 times out of 103: the sessions were on the server the whole time.
  //
  // Genuine inability to upload is still loud WHILE it is actionable —
  // `failing` names a rejecting store and `uploading` climbs, both for the ~30
  // days before anything is pruned. See the `Not on disk` line in --detailed
  // for the post-hoc record.
  it("is unmoved by sessions that are no longer on disk", () => {
    const paths = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const files = Object.fromEntries(paths.map((p) => [p, entry(p, { letai: 10 })]));
    const ledger = buildLedger({
      files: paths.map((p) => file(p, 10)),
      state: stateWithOfflineFortress(files),
      incompleteSessions: 1,
      nowMs: NOW,
    });
    assert.equal(ledger.delivered, 9);
    // Still REPORTED — the diagnostic record survives...
    assert.equal(ledger.incomplete, 1);
    // ...but out of both the percentage and the total.
    assert.equal(ledger.percent, 100);
    assert.equal(ledger.total, 9);
  });

  it("is 100% on an empty device rather than NaN", () => {
    const ledger = buildLedger({ files: [], state: { files: {} }, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.percent, 100);
    assert.equal(ledger.total, 0);
  });
});

describe("lagging destinations", () => {
  it("names the offline Fortress and ages the outage", () => {
    const files = { a: entry("a", { letai: 10, orgA: 0 }) };
    const ledger = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 13),
      incompleteSessions: 0,
      nowMs: NOW,
      orgNames: { orgA: "Den Co" },
    });
    assert.equal(ledger.lagging.length, 1);
    assert.equal(ledger.lagging[0]?.label, "Den Co");
    assert.equal(ledger.lagging[0]?.sessions, 1);
    assert.equal(ledger.lagging[0]?.offlineDays, 13);
    assert.equal(ledger.waitingBytes, 10);
  });

  it("flags only outages old enough to need a decision", () => {
    const files = { a: entry("a", { letai: 10, orgA: 0 }) };
    const young = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 2),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(needsAttention(young).length, 0);
    const old = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 22),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(needsAttention(old).length, 1);
  });
});

describe("destination registry", () => {
  it("survives a cleared skipReason latch", () => {
    // The reporting bug in one assertion: the file's transient hold fields are
    // gone (a clean pass wiped them) but the destination is still known to be
    // held, so the session is still correctly reported as waiting.
    const files = { a: entry("a", { letai: 10, orgA: 0 }, { skipReason: undefined, blocker: undefined }) };
    const state = stateWithOfflineFortress(files);
    assert.equal(state.files.a?.skipReason, undefined);
    assert.equal(classifyFile(file("a", 10), state, NOW).state, "waiting");
  });

  it("keeps the original outage start across repeated held reports", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW - 5 * DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW);
    assert.equal(state.destinations?.orgA?.heldSinceMs, NOW - 5 * DAY);
  });

  it("clears the outage when the destination comes back", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW - 5 * DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "ready" }], NOW);
    assert.equal(state.destinations?.orgA?.status, "ready");
    assert.equal(state.destinations?.orgA?.heldSinceMs, undefined);
    assert.equal(isDestinationOffline(state, "orgA"), false);
  });

  it("remembers a name learned while held after the store recovers", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held", orgName: "Den Co" }], NOW - DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "ready" }], NOW);
    assert.equal(state.destinations?.orgA?.orgName, "Den Co");
  });
});

describe("failing destinations", () => {
  const failedState = (errors: number): HxState => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: null, status: "ready" }], NOW);
    for (let i = 0; i < errors; i++) {
      applyDestinationUploadError(state, "letai", "403 SignatureDoesNotMatch", NOW - (errors - i) * 60_000);
    }
    return state;
  };

  it("stays quiet below the threshold — one blip is not a condition", () => {
    const ledger = buildLedger({ files: [], state: failedState(2), incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.failing.length, 0);
  });

  it("latches after consecutive hard failures, with the storage layer's own code", () => {
    // The 2026-08-01 outage shape: reachable store, every PUT rejected. The
    // old status showed an innocent 0% with no error anywhere.
    const ledger = buildLedger({ files: [], state: failedState(5), incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.failing.length, 1);
    assert.equal(ledger.failing[0]?.errorCode, "403 SignatureDoesNotMatch");
    assert.equal(ledger.failing[0]?.label, "primary store");
  });

  it("a successful commit ends the run immediately", () => {
    const state = failedState(5);
    assert.equal(applyDestinationUploadSuccess(state, "letai"), true);
    const ledger = buildLedger({ files: [], state, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.failing.length, 0);
  });

  it("a held destination is WAITING, never failing — the stories must not mix", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW);
    for (let i = 0; i < 5; i++) applyDestinationUploadError(state, "orgA", "503", NOW);
    const ledger = buildLedger({ files: [], state, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.failing.length, 0);
  });

  it("ages the failure run in whole hours", () => {
    const state: HxState = { files: {} };
    for (let i = 0; i < 3; i++) applyDestinationUploadError(state, "letai", "403", NOW - 2 * 3_600_000 + i);
    const ledger = buildLedger({ files: [], state, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.failing[0]?.failingHours, 2);
  });
});

describe("backoff clearing", () => {
  const withBackoffs = (): HxState => ({
    files: {
      held: { ...entry("held", { letai: 0 }), skipReason: "vault_offline", consecutiveFailures: 4, nextAttemptAtMs: NOW + 60_000 },
      broken: { ...entry("broken", { letai: 0 }), consecutiveFailures: 12, nextAttemptAtMs: NOW + 30 * 60_000 },
      healthy: entry("healthy", { letai: 10 }),
    },
  });

  it("clearAll releases holds AND generic backoffs, and resets failure runs", () => {
    const state = withBackoffs();
    applyDestinationUploadError(state, "letai", "403", NOW);
    const r = clearAllFailuresFromState(state);
    assert.equal(r.files, 2);
    assert.equal(state.files.held?.skipReason, undefined);
    assert.equal(state.files.broken?.nextAttemptAtMs, undefined);
    assert.equal(state.destinations?.letai?.consecutiveErrors, undefined);
  });

  it("the restart clear drops generic backoffs but keeps vault holds", () => {
    // A hold means the gateway said the store is DOWN — a restart doesn't
    // change that; only recovery (or an explicit retry) should.
    const state = withBackoffs();
    const n = clearGenericBackoffsFromState(state);
    assert.equal(n, 1);
    assert.equal(state.files.broken?.consecutiveFailures, undefined);
    assert.equal(state.files.held?.skipReason, "vault_offline");
    assert.equal(state.files.held?.consecutiveFailures, 4);
  });
});

describe("live bucket naming", () => {
  it("classifies a locally-active session as live, never as a transfer state", () => {
    // The bucket is LOCAL: an agent is writing the file on this device. It
    // must never be confused with uploading, which is what the old
    // "in_progress" label read as when printed under "Uploading".
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 90 }) });
    assert.equal(classifyFile(file("a", 100, 60_000), state, NOW).state, "live");
  });

  it("keeps live sessions out of the percentage entirely", () => {
    const files = { a: entry("a", { letai: 0 }) };
    const ledger = buildLedger({
      files: [file("a", 100, 1_000)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.live, 1);
    assert.equal(ledger.uploading, 0, "a live tail is not a backlog");
    assert.equal(ledger.percent, 100, "someone typing must never dent the number");
  });
});

describe("session date range", () => {
  it("spans oldest to newest last-activity across on-disk sessions", () => {
    const ledger = buildLedger({
      files: [file("a", 10, 60 * DAY), file("b", 10, 1 * DAY), file("c", 10, 30 * DAY)],
      state: { files: {} },
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.oldestMs, NOW - 60 * DAY);
    assert.equal(ledger.newestMs, NOW - 1 * DAY);
  });

  it("is null on an empty device rather than ±Infinity", () => {
    // Math.min/max over an empty list would yield Infinity and render as an
    // absurd date; the row is omitted instead.
    const ledger = buildLedger({ files: [], state: { files: {} }, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.oldestMs, null);
    assert.equal(ledger.newestMs, null);
  });

  it("ignores incomplete sessions, which are no longer on disk", () => {
    const ledger = buildLedger({
      files: [file("a", 10, 5 * DAY)],
      state: { files: {} },
      incompleteSessions: 7,
      nowMs: NOW,
    });
    // CHANGED from 8: `total` is now the on-disk set, so "N on disk" in
    // `hx status` means what it says. The 7 stay visible via ledger.incomplete.
    assert.equal(ledger.total, 1, "total is what is actually on disk");
    assert.equal(ledger.oldestMs, NOW - 5 * DAY, "but cannot widen the range — it has no mtime");
    assert.equal(ledger.newestMs, NOW - 5 * DAY);
  });

  it("collapses to a single instant when only one session exists", () => {
    const ledger = buildLedger({
      files: [file("solo", 10, 3 * DAY)],
      state: { files: {} },
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.oldestMs, ledger.newestMs);
  });
});

// Residency: an org with its own Fortress keeps its sessions THERE and nowhere
// else — there is no let.ai copy. That makes two situations share the `waiting`
// bucket with opposite stakes, and the ledger used to treat them identically:
// both left the percentage, so a device could report "100% — all sessions sent"
// while the only complete copy of a transcript sat on its own disk with a
// 30-day fuse on it.
describe("waiting sessions with no copy anywhere else", () => {
  const held = (files: Record<string, FileState>): HxState => {
    const state: HxState = { files };
    applyDestinationReports(
      state,
      [
        { vaultOrgId: null, status: "ready" },
        { vaultOrgId: "orgF", status: "held", orgName: "my-fortress", lastSeenAt: null },
      ],
      NOW - 10 * DAY,
    );
    return state;
  };

  it("counts a Fortress-only session against the device", () => {
    // Half-delivered to a Fortress that is now offline, and no let.ai copy
    // exists by design. The whole transcript is on this laptop only.
    const files = { a: entry("a", { orgF: 400 }) };
    const ledger = buildLedger({
      files: [file("a", 1000)],
      state: held(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.waiting, 1);
    assert.equal(ledger.waitingUnprotected, 1);
    assert.equal(ledger.percent, 0, "not 100% — this session is one prune from gone");
  });

  it("still excuses a fan-out session that is already complete elsewhere", () => {
    // The case 6178afe fixed: complete on the reachable store, a secondary
    // Fortress merely behind. Safe, unactionable, stays out of the percentage.
    const files = { a: entry("a", { letai: 1000, orgF: 0 }) };
    const ledger = buildLedger({
      files: [file("a", 1000)],
      state: held(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.waiting, 1);
    assert.equal(ledger.waitingUnprotected, 0);
    assert.equal(ledger.percent, 100);
  });

  it("does not treat a partial copy on a reachable store as protection", () => {
    const files = { a: entry("a", { letai: 900, orgF: 0 }) };
    const ledger = buildLedger({
      files: [file("a", 1000)],
      state: held(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    // letai is owed 100 bytes, so this is `uploading`, not `waiting` — but the
    // point stands: 900 of 1000 is not a complete copy.
    assert.equal(ledger.uploading, 1);
    assert.equal(ledger.percent, 0);
  });
});

// Per-session diagnosis. The motivating incident: a device sat at
// "Uploading 17 sessions · 135.5 MB" byte-identical for days, with an empty
// log, because the shortfall was billed to a destination the client had no
// record of — so no upload was ever planned and nothing ever failed. Reading
// the ledger could not tell you that; this can.
describe("notDelivered diagnosis", () => {
  const stateWith = (offsets: Record<string, number>, register: boolean): HxState => {
    const state: HxState = { files: { a: entry("a", offsets) } };
    applyDestinationReports(
      state,
      register
        ? [
            { vaultOrgId: null, status: "ready" },
            { vaultOrgId: "orgX", status: "held", orgName: "Acme", lastSeenAt: null },
          ]
        : [{ vaultOrgId: null, status: "ready" }],
      NOW - DAY,
    );
    return state;
  };
  const build = (offsets: Record<string, number>, register: boolean) =>
    buildLedger({
      files: [file("a", 1000)],
      state: stateWith(offsets, register),
      incompleteSessions: 0,
      nowMs: NOW,
    });

  it("marks a destination with NO registry entry as unknown", () => {
    // The phantom: advertised once, never registered, billed as reachable.
    const l = build({ letai: 1000, orgX: 0 }, false);
    const d = l.notDelivered[0]!;
    const orgX = d.destinations.find((x) => x.key === "orgX")!;
    assert.equal(orgX.state, "unknown");
    assert.equal(orgX.owed, 1000);
    // and the complete one is reported as complete, so the contrast is visible
    assert.equal(d.destinations.find((x) => x.key === "letai")!.owed, 0);
  });

  it("marks a registered held destination as offline, not unknown", () => {
    const l = build({ letai: 1000, orgX: 0 }, true);
    assert.equal(l.notDelivered[0]!.destinations.find((x) => x.key === "orgX")!.state, "offline");
  });

  it("marks the shared bucket as reachable even before it is registered", () => {
    // destKey(null) is always known — a total outage is the probe's job.
    const l = build({ letai: 400 }, false);
    assert.equal(l.notDelivered[0]!.destinations[0]!.state, "reachable");
  });

  it("bills a session with no offsets at all to the primary", () => {
    const l = build({}, false);
    const d = l.notDelivered[0]!;
    assert.equal(d.destinations.length, 1);
    assert.equal(d.destinations[0]!.key, "letai");
    assert.equal(d.owedBytes, 1000);
  });

  it("says nothing about a delivered session", () => {
    const l = build({ letai: 1000 }, false);
    assert.equal(l.notDelivered.length, 0);
  });

  it("orders by bytes owed so the worst reads first", () => {
    const files = { a: entry("a", { letai: 0 }), b: entry("b", { letai: 0 }) };
    const l = buildLedger({
      files: [file("a", 10), file("b", 5000)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(l.notDelivered[0]!.owedBytes, 5000);
  });
});
