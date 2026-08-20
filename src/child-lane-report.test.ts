// The producer side of the child-lane report, driven through computeSyncReport
// with REAL files on disk. Every rule below survived mutation before this file
// existed: deleting the on-disk guard, or reverting the size source to
// lastKnownSize, left the whole suite green.
import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSyncReport, snapshotFrom } from "./watch.js";
import { resetStateCache, setStateDirForTests, upsertFileState, type FileState } from "./state.js";

let dir = "";
let projects = "";

const lanePath = (name: string): string =>
  join(projects, "-p", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "subagents", name);

const laneState = (p: string, offsets: Record<string, number>, skipReason?: string): FileState =>
  ({
    path: p,
    family: "claude-desktop",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
    // Deliberately NO lastKnownSize: ensureFileState is its only writer and
    // only the parent path calls it, so a real child lane never has one.
    ...(skipReason ? { skipReason } : {}),
  }) as FileState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hx-lanes-"));
  projects = join(dir, "projects");
  mkdirSync(join(projects, "-p", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "subagents"), {
    recursive: true,
  });
  setStateDirForTests(dir);
  resetStateCache();
});
afterEach(() => {
  setStateDirForTests(null);
  resetStateCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const report = async () =>
  (await computeSyncReport(undefined, { claude: [], codex: [] })).childLanes;

describe("childLanes accounting", () => {
  it("measures owed bytes from the FILE, since a lane has no lastKnownSize", () => {
    // Gated on lastKnownSize this counter could never fire, and the report said
    // "all delivered" for every device that had ever run an agent.
    const p = lanePath("agent-a.jsonl");
    writeFileSync(p, "y".repeat(3000));
    return upsertFileState(laneState(p, { letai: 500 })).then(async () => {
      const c = await report();
      assert.equal(c.owing, 1);
      assert.equal(c.owedBytes, 2500);
    });
  });

  it("counts a fully-uploaded lane as owing nothing", async () => {
    const p = lanePath("agent-b.jsonl");
    writeFileSync(p, "y".repeat(1000));
    await upsertFileState(laneState(p, { letai: 1000 }));
    const c = await report();
    assert.equal(c.owing, 0);
    assert.equal(c.owedBytes, 0);
  });

  it("reports a hold on a lane that is still on disk", async () => {
    const p = lanePath("agent-c.jsonl");
    writeFileSync(p, "y".repeat(1000));
    await upsertFileState(laneState(p, { letai: 0 }, "quarantine"));
    const c = await report();
    assert.equal(c.held, 1);
    assert.deepEqual(c.heldReasons, { quarantine: 1 });
  });

  it("does NOT report a hold on a lane whose file is gone", async () => {
    // Nothing removes state.files entries and clearGenericBackoffs preserves
    // skipReason, so counting these reported "N HELD — release with hx retry
    // --blocked" forever, and opened the retry gate, which stops the daemon and
    // rewrites state to clear flags on files that do not exist.
    await upsertFileState(laneState(lanePath("agent-gone.jsonl"), { letai: 0 }, "quarantine"));
    const c = await report();
    assert.equal(c.tracked, 1);
    assert.equal(c.gone, 1);
    assert.equal(c.held, 0);
    assert.deepEqual(c.heldReasons, {});
  });

  it("separates on-disk from pruned lanes", async () => {
    const here = lanePath("agent-here.jsonl");
    writeFileSync(here, "y".repeat(100));
    await upsertFileState(laneState(here, { letai: 100 }));
    await upsertFileState(laneState(lanePath("agent-away.jsonl"), { letai: 0 }));
    const c = await report();
    assert.equal(c.tracked, 2);
    assert.equal(c.onDisk, 1);
    assert.equal(c.gone, 1);
  });
});

// The three rules below were each deletable with the entire suite still green.
import { hasReleasableHolds, stuckLogKey } from "./watch.js";
import { buildSyncDoctorReport } from "./diagnostics.js";
import { buildLedger } from "./ledger.js";
import type { HxState } from "./state.js";
import type { SyncReport } from "./watch.js";

const cleanReport = (): SyncReport => ({
  snapshot: { total: 1, done: 1, totalBytes: 10 },
  behind: [],
  unwatched: 0,
  excluded: [],
  undiscovered: { fileGone: 0, onDiskButUndiscovered: 0 },
  childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0, held: 0, heldReasons: {} },
  skipped: [],
  ledger: {
    total: 1, totalBytes: 10, oldestMs: 0, newestMs: 0, delivered: 1, live: 0, uploading: 0,
    waiting: 0, waitingUnprotected: 0, incomplete: 0, percent: 100, deliveredBytes: 10,
    uploadingBytes: 0, waitingBytes: 0, stranded: [], notDelivered: [], lagging: [], failing: [],
  },
});

describe("held lanes are part of the verdict", () => {
  it("a device with everything delivered but a held lane is NOT ok", () => {
    // Every other input to `ok` counts parent sessions only, so without this
    // the report answered "healthy — 100% uploaded" directly beneath
    // "N of them are HELD", and the UI's "caught up" said Yes.
    const r = cleanReport();
    r.childLanes = { ...r.childLanes, tracked: 1, onDisk: 1, held: 1, heldReasons: { quarantine: 1 } };
    assert.equal(buildSyncDoctorReport(r, "https://let.ai/_api/hx-gateway", 0).ok, false);
  });

  it("and IS ok once nothing is held", () => {
    assert.equal(buildSyncDoctorReport(cleanReport(), "https://let.ai/_api/hx-gateway", 0).ok, true);
  });
});

describe("hasReleasableHolds", () => {
  it("sees a held child lane that collectSkipped cannot", () => {
    const r = cleanReport();
    r.childLanes = { ...r.childLanes, held: 3, heldReasons: { quarantine: 3 } };
    assert.equal(hasReleasableHolds(r), true);
  });

  it("still sees an ordinary blocked session", () => {
    const r = cleanReport();
    r.skipped = [{ path: "/a", family: "claude-cli", sessionId: "s", reason: "vault_offline" }];
    assert.equal(hasReleasableHolds(r), true);
  });

  it("is false when there is genuinely nothing to release", () => {
    assert.equal(hasReleasableHolds(cleanReport()), false);
  });
});

describe("stuckLogKey", () => {
  it("does not vary while the same condition holds, ACROSS TIME", async () => {
    // The key is the suppression identity. Built from the rendered message it
    // carried the countdown, so it changed every tick and suppressed nothing.
    // The delay is the whole point: two calls in the same millisecond cannot
    // tell a stable key from one with a clock in it.
    const a = stuckLogKey({ consecutiveFailures: 3, skipReason: "quarantine" });
    await new Promise((r) => setTimeout(r, 8));
    const b = stuckLogKey({ consecutiveFailures: 3, skipReason: "quarantine" });
    assert.equal(a, b);
  });

  it("separates a bench from a backoff", () => {
    assert.notEqual(stuckLogKey({}), stuckLogKey({ consecutiveFailures: 0 }));
  });

  it("changes when the streak or the reason changes", () => {
    assert.notEqual(
      stuckLogKey({ consecutiveFailures: 1, skipReason: "quarantine" }),
      stuckLogKey({ consecutiveFailures: 2, skipReason: "quarantine" }),
    );
    assert.notEqual(
      stuckLogKey({ consecutiveFailures: 1, skipReason: "quarantine" }),
      stuckLogKey({ consecutiveFailures: 1, skipReason: "vault_offline" }),
    );
  });
});

// The snapshot POSTed to the gateway is derived by snapshotFrom. It must agree
// with the ledger `hx status` prints from the same state — a device telling the
// server one number while showing the user another is the failure this whole
// change set began from. Reverting snapshotFrom to minOffset left the entire
// suite green, so nothing pinned it.
describe("snapshotFrom agrees with the ledger about a phantom key", () => {
  const withPhantom = (): HxState => ({
    files: {
      "/s.jsonl": {
        path: "/s.jsonl",
        family: "claude-cli",
        sessionId: "s",
        offsets: { letai: 1000, phantom: 0 },
        lastMtimeMs: 0,
        lastUploadAtMs: 0,
      },
    },
    destinations: {
      letai: {
        vaultOrgId: null,
        status: "ready",
        orgName: null,
        orgSlug: null,
        lastSeenAt: null,
        observedAtMs: 0,
      },
    },
  });
  const files = [{ path: "/s.jsonl", size: 1000, mtimeMs: 0 }] as never;

  it("counts the session done — the phantom cannot pin it below", () => {
    // minOffset would answer 0 here and report a delivered session as unsent
    // for as long as the file exists.
    assert.equal(snapshotFrom(files, withPhantom()).done, 1);
  });

  it("and the ledger calls the same session delivered", () => {
    const l = buildLedger({
      files: [{ path: "/s.jsonl", size: 1000, mtimeMs: 0 }],
      state: withPhantom(),
      incompleteSessions: 0,
      nowMs: 30 * 24 * 60 * 60 * 1000,
    });
    assert.equal(l.delivered, 1);
  });

  it("still counts a session a REAL destination is short on as not done", () => {
    const s = withPhantom();
    s.files["/s.jsonl"]!.offsets = { letai: 400, phantom: 0 };
    assert.equal(snapshotFrom(files, s).done, 0);
  });
});
