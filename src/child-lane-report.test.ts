// The producer side of the child-lane report, driven through computeSyncReport
// with REAL files on disk. Every rule below survived mutation before this file
// existed: deleting the on-disk guard, or reverting the size source to
// lastKnownSize, left the whole suite green.
import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSyncReport, formatWait, isChildLane, logStuck, snapshotFrom } from "./watch.js";
import {
  loadState,
  pruneStrandedOffsets,
  recordDestinations,
  resetStateCache,
  setStateDirForTests,
  upsertFileState,
  type FileState,
} from "./state.js";

let dir = "";
let projects = "";

const lanePath = (name: string): string =>
  join(projects, "-p", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "subagents", name);

const laneStateFor = (p: string, offsets: Record<string, number>): FileState =>
  ({
    path: p,
    family: "claude-desktop",
    sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
  }) as FileState;

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
import { buildSyncDoctorReport, formatStatusBlocker } from "./diagnostics.js";
import { buildLedger } from "./ledger.js";
import type { HxState } from "./state.js";
import type { SyncSkippedEntry } from "./watch.js";
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

// User-facing text that mutation testing showed nothing pinned. Each of these
// reverts to its pre-fix wording with the whole suite green.
describe("the words a user actually reads", () => {
  const quarantined = (): SyncSkippedEntry[] => [
    { path: "/a.jsonl", family: "claude-cli", sessionId: "s", reason: "quarantine" },
  ];

  it("does not call a quarantine a store outage", () => {
    // "destination store unavailable" is wrong: nothing is unavailable, the
    // gateway has not made a routing decision.
    const line = formatStatusBlocker(quarantined());
    assert.doesNotMatch(line, /store unavailable/);
    assert.match(line, /routing/i);
  });

  it("still calls a real store outage a store outage", () => {
    const line = formatStatusBlocker([
      { path: "/a.jsonl", family: "claude-cli", sessionId: "s", reason: "store_unreachable" },
    ]);
    assert.match(line, /store unavailable/);
  });

  it("does not tell a quarantined user to bring a Fortress online", () => {
    // There is no Fortress to bring online and no repository to move.
    const r = buildSyncDoctorReport(
      { ...cleanReport(), skipped: quarantined() },
      "https://let.ai/_api/hx-gateway",
      0,
    );
    const guidance = r.blockers[0]!.remediation.guidance;
    assert.doesNotMatch(guidance, /Fortress online/);
    assert.doesNotMatch(guidance, /detach/);
    assert.match(guidance, /routing decision/);
  });

  it("still tells an offline-vault user to bring the Fortress online", () => {
    const r = buildSyncDoctorReport(
      {
        ...cleanReport(),
        skipped: [{ path: "/a.jsonl", family: "claude-cli", sessionId: "s", reason: "vault_offline" }],
      },
      "https://let.ai/_api/hx-gateway",
      0,
    );
    assert.match(r.blockers[0]!.remediation.guidance, /Fortress online/);
  });

  it("renders a sub-minute wait in seconds, not as '0 min'", () => {
    // 749 of 760 stuck lines on the motivating device said "another 0 min",
    // which reads as a stopped clock rather than a short one.
    assert.match(formatWait(12_000), /^\d+s$/);
    assert.doesNotMatch(formatWait(12_000), /min/);
    assert.match(formatWait(5 * 60_000), /min/);
  });
});

// The pure fold is well covered; the wrapper that loads state, applies it and
// PERSISTS was not — and it is what startWatch calls on every daemon start.
describe("pruneStrandedOffsets persists what it removes", () => {
  const laneless = (path: string, offsets: Record<string, number>): FileState =>
    ({
      path,
      family: "claude-desktop",
      sessionId: path,
      offsets,
      lastMtimeMs: 0,
      lastUploadAtMs: 0,
    }) as FileState;

  it("drops a phantom on a departed file and the change survives a reload", async () => {
    // A registry must exist: "we have never recorded a destination" must not
    // read as "every destination is dead", so the prune bails without one.
    await recordDestinations([{ vaultOrgId: null, status: "ready" }]);
    await upsertFileState(laneless("/gone.jsonl", { letai: 1000, phantom: 0 }));
    const r = await pruneStrandedOffsets("main", () => false);
    assert.deepEqual(r, { keys: 1, files: 1 });
    // Reload from disk: an in-memory-only edit would be lost on the next start
    // and the key would come back every time.
    resetStateCache();
    const reloaded = await loadState();
    assert.deepEqual(reloaded.files["/gone.jsonl"]!.offsets, { letai: 1000 });
  });

  it("writes nothing when there is nothing to drop", async () => {
    await recordDestinations([{ vaultOrgId: null, status: "ready" }]);
    await upsertFileState(laneless("/here.jsonl", { letai: 1000 }));
    assert.deepEqual(await pruneStrandedOffsets("main", () => true), { keys: 0, files: 0 });
  });
});

// Two guards that mutation testing showed nothing pinned, both load-bearing.
describe("guards that were deletable with the suite green", () => {
  // chmod 000 does not deny traversal on Windows, so the unreadable case cannot
  // be staged there. The guard it covers is platform-independent; the SETUP is
  // not. (Same pattern as the fold-freeze golden.)
  it.skipIf(process.platform === "win32")("survives a lane whose file cannot even be stat-ed", async () => {
    // throwIfNoEntry:false suppresses ENOENT ONLY; the existsSync it replaced
    // returned false for EACCES/ELOOP/ENOTDIR/EIO alike. Unguarded in a bare
    // loop over state.files, one unreadable directory made `hx doctor sync`,
    // `hx status --detailed` and `hx retry` exit 1 with no report, and silently
    // blanked `hx status`'s Sessions and Sync rows. This exact shape has been
    // shipped twice, so it gets a test.
    const locked = join(projects, "-p", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "subagents", "locked");
    mkdirSync(locked, { recursive: true });
    const p = join(locked, "agent-x.jsonl");
    writeFileSync(p, "y".repeat(100));
    await upsertFileState(laneStateFor(p, { letai: 0 }));
    chmodSync(locked, 0o000);
    try {
      const c = await report();
      // Unreadable means "cannot be sent from here", which is what gone means.
      assert.equal(c.tracked, 1);
      assert.equal(c.gone, 1);
      assert.equal(c.owing, 0);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("never prunes the primary key, whatever the registry names", async () => {
    // Not redundant with the everWritten guard. A registry built by
    // seedDestinationsFromBlockers names HELD destinations only, so it can omit
    // letai entirely — and a departed file at {letai: 0, orgB: 500} would then
    // lose letai, minOffset would jump 0 -> 500, and a real unrecoverable gap
    // would vanish from collectBehind and `hx doctor sync` permanently.
    await recordDestinations([{ vaultOrgId: "orgHeld", status: "held" }]);
    await upsertFileState(laneStateFor("/departed.jsonl", { letai: 0, orgB: 500 }));
    await pruneStrandedOffsets("main", () => false);
    resetStateCache();
    const after = await loadState();
    assert.equal(after.files["/departed.jsonl"]!.offsets["letai"], 0, "letai must survive");
  });
});

// Windows stores discovery paths with backslashes, so a literal
// includes("/subagents/") never matched there: every lane was misclassified as
// a session transcript, childLanes read all zeros, and the lanes were counted
// as tracked-but-undiscovered files — the exact false alarm this accounting
// exists to stop. Present on the base branch too; the producer tests above only
// surfaced it because they run on the Windows CI job.
describe("isChildLane across platforms", () => {
  const posix = "/home/u/.claude/projects/-p/sess/subagents/agent-a.jsonl";
  const win = "C:\\Users\\u\\.claude\\projects\\-p\\sess\\subagents\\agent-a.jsonl";
  const winFlow = "C:\\Users\\u\\.claude\\projects\\-p\\sess\\subagents\\workflows\\wf_1\\journal.jsonl";

  it("recognises a POSIX lane", () => {
    assert.equal(isChildLane(posix, "linux"), true);
  });

  it("recognises a WINDOWS lane, backslashes and all", () => {
    assert.equal(isChildLane(win, "win32"), true);
    assert.equal(isChildLane(winFlow, "win32"), true);
  });

  it("is case-insensitive on Windows, as the filesystem is", () => {
    assert.equal(isChildLane(win.replace("subagents", "SubAgents"), "win32"), true);
  });

  it("does not mistake a session transcript for a lane", () => {
    assert.equal(isChildLane("/home/u/.claude/projects/-p/sess.jsonl", "linux"), false);
    assert.equal(isChildLane("C:\\Users\\u\\.claude\\projects\\-p\\sess.jsonl", "win32"), false);
  });
});

// stuckLogKey is unit-tested; logStuck's USE of it was not. Reverting the cache
// to key on the rendered message left the whole suite green while restoring the
// flood: the message carries a countdown, so it changes every 1.5s tick and the
// 30-minute suppression matches nothing.
describe("logStuck suppresses on the key, not the message", () => {
  const lines: string[] = [];
  const log = (m: string): void => void lines.push(m);
  beforeEach(() => {
    lines.length = 0;
  });

  it("stays quiet while the condition holds, however the message moves", () => {
    logStuck("/a.jsonl", "backoff:3:quarantine", "waiting 40s", log);
    logStuck("/a.jsonl", "backoff:3:quarantine", "waiting 38s", log);
    logStuck("/a.jsonl", "backoff:3:quarantine", "waiting 36s", log);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /waiting 40s/);
  });

  it("speaks up the moment the CONDITION changes", () => {
    // The transition is the interesting part, so a new key reports at once.
    logStuck("/a.jsonl", "bench:-", "benched for 20s", log);
    logStuck("/a.jsonl", "backoff:1:quarantine", "backoff 20s", log);
    assert.equal(lines.length, 2);
  });

  it("tracks files independently", () => {
    logStuck("/a.jsonl", "bench:-", "a", log);
    logStuck("/b.jsonl", "bench:-", "b", log);
    assert.equal(lines.length, 2);
  });
});

// heldReasons is a breakdown printed beside a total, so it has to accumulate:
// with `= 1` the total said 3 while the itemisation summed to 2.
describe("heldReasons itemises the held total", () => {
  it("counts every lane of the same reason", async () => {
    for (const n of ["a", "b", "c"]) {
      const p = lanePath(`agent-${n}.jsonl`);
      writeFileSync(p, "y".repeat(100));
      await upsertFileState(laneState(p, { letai: 0 }, n === "c" ? "vault_offline" : "quarantine"));
    }
    const c = await report();
    assert.equal(c.held, 3);
    assert.deepEqual(c.heldReasons, { quarantine: 2, vault_offline: 1 });
    // The breakdown must sum to the total it sits beside.
    assert.equal(
      Object.values(c.heldReasons).reduce((n, v) => n + v, 0),
      c.held,
    );
  });
});
