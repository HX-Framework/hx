import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildLedger,
  classifyFile,
  destinationStanding,
  reportableOffset,
  LIVE_WINDOW_MS,
  needsAttention,
} from "./ledger.js";
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
    assert.equal(destinationStanding(state, "letai"), "reachable");
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
    assert.equal(destinationStanding(state, "orgA"), "reachable");
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

  it("does not bill a session whose only debt is to an unknown destination", () => {
    // The phantom: advertised once, never registered. letai holds all 1000
    // bytes, so the session IS delivered — nothing will ever be written to
    // orgX, and counting its debt pinned the percentage below 100 forever for
    // something no action could settle.
    const l = build({ letai: 1000, orgX: 0 }, false);
    assert.equal(l.delivered, 1);
    assert.equal(l.uploading, 0);
    assert.equal(l.uploadingBytes, 0);
    assert.equal(l.percent, 100);
    assert.equal(l.notDelivered.length, 0);
  });

  it("still NAMES the unknown destination it stopped billing", () => {
    // Excluding the debt must not make the key silent: it is carried forever
    // otherwise, and the device that carried 43 of them reported none.
    const l = build({ letai: 1000, orgX: 0 }, false);
    assert.equal(l.stranded.length, 1);
    assert.equal(l.stranded[0]!.key, "orgX");
    assert.equal(l.stranded[0]!.sessions, 1);
    assert.equal(l.stranded[0]!.bytes, 1000);
  });

  it("bills a file whose ONLY key is a phantom to the primary, ONCE", () => {
    // Nothing real has ever been told about this file, which is the same
    // situation as no offsets at all — so it is whole-file backlog, billed to
    // the primary. Reporting the phantom's notional debt on top of that counted
    // the same 1000 bytes twice: 1000 in uploadingBytes and 1000 again in
    // stranded, for a 1000-byte file.
    const l = build({ orgX: 0 }, false);
    assert.equal(l.uploading, 1);
    assert.equal(l.uploadingBytes, 1000);
    assert.equal(l.percent, 0);
    const strandedBytes = l.stranded.reduce((n, x) => n + x.bytes, 0);
    assert.equal(l.uploadingBytes + l.waitingBytes + strandedBytes, 1000);
    // The per-session line has to agree with the headline it sits under.
    assert.equal(l.notDelivered[0]!.owedBytes, 1000);
  });

  it("still names the dead key, and says where the bytes are actually going", () => {
    const l = build({ orgX: 0 }, false);
    const dests = l.notDelivered[0]!.destinations;
    // The primary is synthesised so the backlog has a visible home...
    assert.equal(dests.find((d) => d.key === "letai")!.owed, 1000);
    // ...and the dead key is still listed beside it, contributing nothing.
    assert.equal(dests.find((d) => d.key === "orgX")!.state, "unknown");
  });

  it("counts only the REAL debt when a phantom sits beside a live destination", () => {
    // letai is 600 short; orgX is a phantom owed nothing real. The headline and
    // the per-session line must agree on 600 — asserting only `uploading === 1`
    // here let 1000 phantom bytes leak into the per-session total while the
    // headline said 600, and the test name claimed to check exactly that.
    const l = build({ letai: 400, orgX: 0 }, false);
    assert.equal(l.uploading, 1);
    assert.equal(l.uploadingBytes, 600);
    assert.equal(l.notDelivered[0]!.owedBytes, 600);
    // Named, not counted.
    assert.equal(l.stranded.length, 1);
    const orgX = l.notDelivered[0]!.destinations.find((x) => x.key === "orgX")!;
    assert.equal(orgX.state, "unknown");
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

// The two numbers this client publishes must agree. `hx status` reads the
// ledger; the gateway reads the snapshot POSTed from snapshotFrom. Both derive
// from the same state, so a destination that exists in neither must not be
// allowed to pull one of them down.
describe("reportableOffset", () => {
  const fs = (offsets: Record<string, number>): FileState => ({
    path: "/p",
    family: "claude-cli",
    sessionId: "s",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
  });
  const registered = (): HxState => {
    const state: HxState = { files: {} };
    applyDestinationReports(
      state,
      [{ vaultOrgId: null, status: "ready" }, { vaultOrgId: "orgHeld", status: "held" }],
      NOW,
    );
    return state;
  };

  it("ignores a key with no registry entry", () => {
    // minOffset would answer 0 here and report a fully delivered session as
    // unsent for as long as the file exists.
    assert.equal(reportableOffset(fs({ letai: 1000, phantom: 0 }), registered()), 1000);
  });

  it("still counts a REGISTERED destination that is behind, however offline", () => {
    assert.equal(reportableOffset(fs({ letai: 1000, orgHeld: 0 }), registered()), 0);
  });

  it("answers 0 when every key is an unwritten phantom", () => {
    assert.equal(reportableOffset(fs({ phantom: 0 }), registered()), 0);
  });

  it("COUNTS an unregistered key that has actually accepted bytes", () => {
    // The registry is not reliably complete, so absence is not proof of death.
    // A non-zero offset is proof of life: setOffsetFor writes only after a
    // successful commit. Ignoring it reported a session as fully delivered
    // while a live Fortress was still owed half of it.
    assert.equal(reportableOffset(fs({ letai: 1000, orgReal: 400 }), registered()), 400);
  });

  it("answers 0 for a file with no offsets at all", () => {
    assert.equal(reportableOffset(fs({}), registered()), 0);
  });
});

// A destination the registry no longer names can still HOLD the transcript:
// an offset at or past the file size is a recorded successful commit. Treating
// those as "no copy anywhere" raised the data-loss alarm — "the only whole
// transcript is the local file, Claude Code deletes it at 30 days" — and drove
// the percentage to 0, for sessions that were fully delivered.
describe("a complete copy at an unregistered destination", () => {
  const build = (offsets: Record<string, number>) => {
    const state: HxState = { files: { a: entry("a", offsets) } };
    applyDestinationReports(
      state,
      [{ vaultOrgId: null, status: "ready" }, { vaultOrgId: "orgOffline", status: "held" }],
      NOW - DAY,
    );
    return buildLedger({
      files: [file("a", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
  };

  it("does not raise the at-risk alarm when an unregistered store holds it all", () => {
    const l = build({ orgFortress: 1000, orgOffline: 500 });
    assert.equal(l.waiting, 1);
    assert.equal(l.waitingUnprotected, 0);
    assert.equal(l.percent, 100);
  });

  it("still raises it when nothing anywhere holds the whole transcript", () => {
    // Same bucket, opposite stakes: only an offline store is owed, and no store
    // has ever taken the whole file, so the local jsonl really is the sole copy.
    const l = build({ orgOffline: 500 });
    assert.equal(l.waiting, 1);
    assert.equal(l.waitingUnprotected, 1);
  });

  it("counts a session partly written to an unregistered store as backlog", () => {
    // 900 of 1000 committed somewhere unregistered is not a complete copy, so
    // the session must not read as delivered — the next append-url replaces the
    // dead key with a real destination and sends the file.
    const l = build({ orgFortress: 900, orgOffline: 500 });
    assert.equal(l.delivered, 0);
    assert.equal(l.uploading, 1);
    assert.notEqual(l.percent, 100);
  });
});

// The ledger and the pruner must apply ONE rule. pruneStrandedOffsets refuses
// to delete a non-zero unknown offset because it is proof a real store accepted
// bytes; if the ledger writes that same key off, it reports as delivered
// exactly what the pruner is preserving as evidence of an outstanding debt.
describe("an unregistered destination that has accepted bytes", () => {
  const build = (offsets: Record<string, number>) => {
    // The realistic post-upgrade registry: seeded from blockers, so it names
    // one held org and nothing else. Every healthy store looks "unknown".
    const state: HxState = { files: { a: entry("a", offsets) } };
    applyDestinationReports(state, [{ vaultOrgId: "orgHeld", status: "held" }], NOW - DAY);
    return buildLedger({
      files: [file("a", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
  };

  it("is still owed its bytes, not written off as a dead key", () => {
    const l = build({ letai: 1000, orgReal: 500 });
    assert.equal(l.delivered, 0);
    assert.equal(l.uploading, 1);
    assert.equal(l.uploadingBytes, 500);
    assert.equal(l.percent, 0);
    assert.equal(l.stranded.length, 0);
  });

  it("while a never-written key on the same file IS written off", () => {
    const l = build({ letai: 1000, phantom: 0 });
    assert.equal(l.delivered, 1);
    assert.equal(l.percent, 100);
    assert.equal(l.stranded.length, 1);
    assert.equal(l.stranded[0]!.key, "phantom");
  });
});

// A destination proves it exists ONCE, for every session. The same key billed
// as owed on one file and listed as a dead key on another put both verdicts in
// one report.
describe("proof of a destination is per-destination, not per-file", () => {
  const twoFiles = (aOffsets: Record<string, number>, bOffsets: Record<string, number>) => {
    const state: HxState = { files: { a: entry("a", aOffsets), b: entry("b", bOffsets) } };
    applyDestinationReports(state, [{ vaultOrgId: null, status: "ready" }], NOW - DAY);
    return buildLedger({
      files: [file("a", 1000), file("b", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
  };

  it("bills the debt on EVERY session once the key is proven anywhere", () => {
    // orgX took 500 bytes of `a`, so orgX is real. `b` sitting at 0 for it is
    // therefore 1000 bytes unsent, not a dead key: 1500 owed in total. Asserting
    // only `a`'s 500 here pinned the exact bug — `b`'s debt vanished from
    // uploadingBytes, waitingBytes, notDelivered AND stranded at once.
    const l = twoFiles({ letai: 1000, orgX: 500 }, { letai: 1000, orgX: 0 });
    assert.equal(l.uploadingBytes, 1500);
    assert.equal(l.uploading, 2);
    assert.deepEqual(l.stranded, []);
  });

  it("accounts for every owed byte in some reported field", () => {
    // The invariant the erasure broke: nothing may be silently dropped.
    const l = twoFiles({ letai: 1000, orgX: 500 }, { letai: 1000, orgX: 0 });
    const reported = l.uploadingBytes + l.waitingBytes + l.stranded.reduce((n, x) => n + x.bytes, 0);
    assert.equal(reported, 1500);
  });

  it("still writes off a key no session anywhere has ever written to", () => {
    const l = twoFiles({ letai: 1000, orgX: 0 }, { letai: 1000, orgX: 0 });
    assert.equal(l.stranded.length, 1);
    assert.equal(l.stranded[0]!.key, "orgX");
    assert.equal(l.percent, 100);
  });

  it("labels a paid-but-unregistered destination as owed, not as unknown", () => {
    const l = twoFiles({ letai: 1000, orgX: 500 }, { letai: 1000, orgX: 0 });
    const d = l.notDelivered.find((x) => x.sessionId === "a")!;
    assert.equal(d.destinations.find((x) => x.key === "orgX")!.state, "unregistered");
  });
});

// The invariant the erasures kept breaking: every byte a session still owes
// must land in exactly one reported field, and the per-session detail must add
// up to the headline. Both were false in three different ways across review.
describe("ledger accounting invariant", () => {
  const check = (offsets: Record<string, number>, destinations: HxState["destinations"]) => {
    const state: HxState = { files: { a: entry("a", offsets) }, destinations };
    const l = buildLedger({
      files: [file("a", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
    const perSession = l.notDelivered.reduce((n, d) => n + d.owedBytes, 0);
    return { l, perSession };
  };
  const reg: HxState["destinations"] = {
    letai: { vaultOrgId: null, status: "ready", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
    orgHeld: { vaultOrgId: "orgHeld", status: "held", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
  };

  it("per-session detail sums to the headline backlog", () => {
    const { l, perSession } = check({ letai: 400, phantom: 0 }, reg);
    assert.equal(perSession, l.uploadingBytes);
  });

  it("a phantom is named exactly once and counted zero times", () => {
    const { l } = check({ letai: 1000, phantom: 0 }, reg);
    assert.equal(l.uploadingBytes, 0);
    assert.equal(l.waitingBytes, 0);
    assert.equal(l.stranded.length, 1);
  });

  it("an offline store's debt is waiting, never uploading", () => {
    const { l } = check({ letai: 1000, orgHeld: 200 }, reg);
    assert.equal(l.uploadingBytes, 0);
    assert.equal(l.waitingBytes, 800);
  });

  it("a complete copy at an OFFLINE store still reads delivered", () => {
    // Its bytes are committed; snapshotFrom agrees, and the two surfaces must
    // not disagree about the same session.
    const { l } = check({ orgHeld: 1000, phantom: 0 }, reg);
    assert.equal(l.delivered, 1);
    assert.equal(l.percent, 100);
  });
});

// The ledger and the pruner must agree on every state, including the degenerate
// one. pruneStrandedOffsets bails when no registry has ever been recorded;
// without the same guard here, the ledger called every real destination on a
// pre-registry state file a dead key while the pruner refused to touch it.
describe("a state file with no registry at all", () => {
  it("treats nothing as a phantom", () => {
    const state: HxState = { files: { a: entry("a", { letai: 1000, orgReal: 0 }) } };
    const l = buildLedger({
      files: [file("a", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.deepEqual(l.stranded, []);
    assert.equal(l.uploadingBytes, 1000);
    assert.equal(l.percent, 0);
  });
});

// The two accounting invariants, over every shape that has broken one of them
// in review. Note what is NOT asserted: stranded[].bytes is explicitly the
// NOMINAL debt of a destination that does not exist, so adding it to real
// backlog is meaningless — the defect was never "the sum is wrong", it was the
// same bytes being reported as real backlog AND as stranded for one file.
describe("accounting invariants", () => {
  const reg: HxState["destinations"] = {
    letai: { vaultOrgId: null, status: "ready", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
    orgHeld: { vaultOrgId: "orgHeld", status: "held", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
  };
  const ledgerFor = (offsets: Record<string, number>) => {
    const state: HxState = { files: { a: entry("a", offsets) }, destinations: reg };
    return buildLedger({
      files: [file("a", 1000)],
      state,
      incompleteSessions: 0,
      nowMs: NOW,
    });
  };
  const shapes: Array<[string, Record<string, number>]> = [
    ["only a phantom", { phantom: 0 }],
    ["two phantoms and nothing else", { p1: 0, p2: 0 }],
    ["phantom beside a partly-filled primary", { letai: 400, phantom: 0 }],
    ["phantom beside a complete primary", { letai: 1000, phantom: 0 }],
    ["phantom beside an offline debt", { letai: 1000, orgHeld: 200, phantom: 0 }],
    ["an unregistered store that has been paid", { letai: 1000, orgPaid: 500 }],
    ["no offsets at all", {}],
  ];

  for (const [name, offsets] of shapes) {
    it(`never reports a session as owing while its detail says 0 — ${name}`, () => {
      // notDelivered only admits sessions with a standing that owes something,
      // so owedBytes of 0 there is self-contradictory. That is exactly what a
      // file billed to the primary printed: "0 B owed" beneath a headline
      // reporting 1000. Deliberately NOT asserting that owedBytes sums to
      // uploadingBytes — owedBytes includes offline debt, which is counted in
      // waitingBytes instead, so the two agree only when no store is offline.
      const l = ledgerFor(offsets);
      for (const d of l.notDelivered) {
        assert.ok(d.owedBytes > 0, `${d.sessionId} listed as owing but detail says 0`);
      }
    });
  }

  it("detail matches the headline when nothing is offline", () => {
    for (const offsets of [{ phantom: 0 }, { letai: 400, phantom: 0 }, {}]) {
      const l = ledgerFor(offsets);
      const perSession = l.notDelivered.reduce((n, d) => n + d.owedBytes, 0);
      assert.equal(perSession, l.uploadingBytes);
    }
  });

  for (const [name, offsets] of shapes.slice(0, 2)) {
    it(`a file billed to the primary is not ALSO reported stranded — ${name}`, () => {
      // Every key is a phantom, so lagOf bills the whole file to the primary.
      // Reporting the phantom's notional debt on top counted a 1000-byte file
      // as 2000 — and 3000 with two phantom keys.
      const l = ledgerFor(offsets);
      assert.equal(l.uploadingBytes, 1000);
      assert.deepEqual(l.stranded, []);
    });
  }

  it("a phantom beside a REAL destination is still named", () => {
    // The opposite guard: suppressing it here is how a dead key gets carried
    // forever with nothing reporting it.
    const l = ledgerFor({ letai: 400, phantom: 0 });
    assert.equal(l.uploadingBytes, 600);
    assert.equal(l.stranded.length, 1);
    assert.equal(l.stranded[0]!.key, "phantom");
  });
});
