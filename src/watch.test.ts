import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  SessionUpstreamUnavailable,
  WATCHDOG_DEFAULT_MINUTES,
  WATCHDOG_MIN_MINUTES,
  buildChildParentIndex,
  childNeedsPass,
  classifyUpstreamError,
  collectBehind,
  collectSkipped,
  contestedChildLanes,
  electChildUploaders,
  logStuck,
  planChildLaneResets,
  planWorkflowSync,
  reconcileChildParent,
  resetStuckLogForTests,
  resolveWatchdogMs,
  snapshotFrom,
  watchdogVerdict,
  workflowLaneAfterFailure,
} from "./watch.js";
import { FILE_BACKOFF_CAP_MS } from "./state.js";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import { HxHttpError } from "./uploader.js";
import type { FileState, HxState } from "./state.js";
import type { DiscoveredChildFile, DiscoveredFile } from "./sources.js";
import type { DataRoot } from "./roots.js";

const vaultOffline = () =>
  new HxHttpError(503, 'append-url failed: 503 {"error":"vault_offline"}', {
    reason: "vault_offline",
    destinations: [{
      vaultOrgId: "orgA",
      reason: "vault_offline",
      orgName: "Acme",
      orgSlug: "acme",
      projectId: "projA",
      projectName: "Rocket",
      projectSlug: "rocket",
      repoSlug: "acme/rocket",
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    }],
  });
const genericUnavailable = (status: number) =>
  new HxHttpError(status, `commit failed: ${status} Service Unavailable`);

describe("classifyUpstreamError", () => {
  it("treats vault_offline as per-session on either route", () => {
    for (const fortress of [false, true]) {
      const out = classifyUpstreamError(vaultOffline(), fortress);
      assert.ok(out instanceof SessionUpstreamUnavailable);
      assert.equal(out.reason, "vault_offline");
      assert.equal(out.status, 503);
      assert.equal(out.blocker?.destinations[0]?.orgName, "Acme");
    }
  });

  it("treats a direct-store 5xx/429 as store_unreachable", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      const out = classifyUpstreamError(genericUnavailable(status), true);
      assert.ok(out instanceof SessionUpstreamUnavailable);
      assert.equal(out.reason, "store_unreachable");
      assert.equal(out.status, status);
    }
  });

  it("lets a cloud-gateway 5xx/429 fall through (possible wholesale outage)", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      assert.equal(classifyUpstreamError(genericUnavailable(status), false), null);
    }
  });

  it("never treats a 4xx as unavailable, even on a direct route", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      const err = new HxHttpError(status, `commit failed: ${status} nope`);
      assert.equal(classifyUpstreamError(err, true), null);
      assert.equal(classifyUpstreamError(err, false), null);
    }
  });

  it("treats a direct-route network failure as store_unreachable (no status)", () => {
    const out = classifyUpstreamError(new Error("ECONNREFUSED"), true);
    assert.ok(out instanceof SessionUpstreamUnavailable);
    assert.equal(out.reason, "store_unreachable");
    assert.equal(out.status, null);
  });

  it("lets a cloud-route network failure fall through", () => {
    assert.equal(classifyUpstreamError(new Error("ECONNREFUSED"), false), null);
  });

  it("preserves the original error as the cause", () => {
    const original = vaultOffline();
    const out = classifyUpstreamError(original, false);
    assert.equal(out?.cause, original);
  });
});

describe("collectSkipped", () => {
  const file = (path: string): DiscoveredFile => ({
    path,
    size: 10,
    mtimeMs: 1,
    source: "claude",
    rootDir: "/home/u/.claude",
  });
  const fileState = (path: string, over: Partial<FileState>): FileState => ({
    path,
    family: "claude-cli",
    sessionId: `sess-${path}`,
    offsets: {},
    lastMtimeMs: 1,
    lastUploadAtMs: 0,
    ...over,
  });
  const state = (entries: FileState[]): HxState => ({
    files: Object.fromEntries(entries.map((e) => [e.path, e])),
  });

  it("includes a discovered file that is skipped, with its reason and retry time", () => {
    const files = [file("/a"), file("/b")];
    const st = state([
      fileState("/a", {
        skipReason: "vault_offline",
        nextAttemptAtMs: 123,
        blocker: {
          reason: "vault_offline",
          destinations: [],
          firstSeenAtMs: 100,
          lastSeenAtMs: 110,
        },
      }),
      fileState("/b", {}),
    ]);
    const out = collectSkipped(files, st);
    assert.deepEqual(out, [
      {
        path: "/a",
        family: "claude-cli",
        sessionId: "sess-/a",
        reason: "vault_offline",
        nextAttemptAtMs: 123,
        blocker: {
          reason: "vault_offline",
          destinations: [],
          firstSeenAtMs: 100,
          lastSeenAtMs: 110,
        },
      },
    ]);
  });

  it("excludes a skipped entry whose file is no longer discovered", () => {
    const st = state([fileState("/gone", { skipReason: "store_unreachable" })]);
    assert.deepEqual(collectSkipped([], st), []);
  });

  it("excludes files with no skipReason", () => {
    assert.deepEqual(collectSkipped([file("/a")], state([fileState("/a", {})])), []);
  });
});

describe("electChildUploaders", () => {
  const child = (over: Partial<DiscoveredChildFile>): DiscoveredChildFile => ({
    path: "/r/a/projects/-p/sid/subagents/agent-a1.jsonl",
    size: 10,
    mtimeMs: 100,
    parentSessionId: "sid",
    agentId: "a1",
    runId: null,
    metaPath: null,
    rootDir: "/r/a",
    ...over,
  });

  it("elects the newest-mtime twin per child identity and shadows the rest", () => {
    const stale = child({ path: "/r/old/projects/-p/sid/subagents/agent-a1.jsonl", mtimeMs: 50, rootDir: "/r/old" });
    const live = child({ mtimeMs: 200 });
    const elected = electChildUploaders([stale, live]);
    assert.deepEqual(elected.map((c) => c.path), [live.path]);
  });

  it("keys on parent + agent + run — distinct lanes never shadow each other", () => {
    const a = child({});
    const b = child({ path: "/r/a/x/agent-a2.jsonl", agentId: "a2" });
    const wf = child({ path: "/r/a/x/wf/agent-a1.jsonl", runId: "wf_1" });
    const otherParent = child({ path: "/r/a/y/agent-a1.jsonl", parentSessionId: "sid2" });
    assert.equal(electChildUploaders([a, b, wf, otherParent]).length, 4);
  });

  it("breaks mtime ties by size (largest wins)", () => {
    const small = child({ path: "/p/small.jsonl", size: 5 });
    const big = child({ path: "/p/big.jsonl", size: 50 });
    assert.deepEqual(electChildUploaders([small, big]).map((c) => c.path), [big.path]);
  });

  it("full ties (cp -a twins: equal mtime AND size) resolve deterministically by path", () => {
    const a = child({ path: "/r/a/agent-a1.jsonl" });
    const b = child({ path: "/r/b/agent-a1.jsonl" });
    // Same winner regardless of discovery order — a readdir-order flip must
    // not swap uploaders (each swap would cost a replace-from-zero).
    assert.deepEqual(electChildUploaders([a, b]).map((c) => c.path), ["/r/a/agent-a1.jsonl"]);
    assert.deepEqual(electChildUploaders([b, a]).map((c) => c.path), ["/r/a/agent-a1.jsonl"]);
  });
});

describe("planChildLaneResets", () => {
  const child = (p: string, over: Partial<DiscoveredChildFile> = {}): DiscoveredChildFile => ({
    path: p,
    size: 10,
    mtimeMs: 100,
    parentSessionId: "sid",
    agentId: "a1",
    runId: null,
    metaPath: null,
    rootDir: "/r/a",
    ...over,
  });

  it("first sighting of a lane records the winner without a reset", () => {
    const plan = planChildLaneResets([child("/r/a/agent-a1.jsonl")], {});
    assert.deepEqual(plan.resetPaths, []);
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.nextMap, { "sid:a1:": "/r/a/agent-a1.jsonl" });
  });

  it("a flipped winner is reset; a stable one is untouched", () => {
    const prev = { "sid:a1:": "/r/a/agent-a1.jsonl", "sid:a2:": "/r/a/agent-a2.jsonl" };
    const plan = planChildLaneResets(
      [child("/r/copy/agent-a1.jsonl"), child("/r/a/agent-a2.jsonl", { agentId: "a2" })],
      prev,
    );
    assert.deepEqual(plan.resetPaths, ["/r/copy/agent-a1.jsonl"]);
    assert.equal(plan.nextMap["sid:a1:"], "/r/copy/agent-a1.jsonl");
    assert.equal(plan.nextMap["sid:a2:"], "/r/a/agent-a2.jsonl");
  });

  it("no changes → changed:false, map preserved by reference semantics", () => {
    const prev = { "sid:a1:": "/r/a/agent-a1.jsonl" };
    const plan = planChildLaneResets([child("/r/a/agent-a1.jsonl")], prev);
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.resetPaths, []);
  });

  it("CONTESTED first sighting resets — the upgrade heal for pre-map twins", () => {
    // Two candidates, no memory: both may carry offsets from the old
    // both-upload world; the winner must replace-from-zero exactly once.
    const live = child("/r/copy/agent-a1.jsonl", { mtimeMs: 200 });
    const contested = contestedChildLanes([child("/r/a/agent-a1.jsonl"), live]);
    const plan = planChildLaneResets([live], {}, contested);
    assert.deepEqual(plan.resetPaths, [live.path]);
    // …and once latched, the same winner never resets again.
    const next = planChildLaneResets([live], plan.nextMap, contested);
    assert.deepEqual(next.resetPaths, []);
    assert.equal(next.changed, false);
  });
});

// Asserts POSIX path semantics with POSIX literals ("/a", "relative/path"),
// so it cannot hold on Windows, where those are not absolute and normalize
// with backslashes. Not a gap in Windows support — the behavior under test
// is the platform's, and the Windows-specific paths have their own tests.
describe.skipIf(process.platform === "win32")("collectBehind", () => {
  const roots: DataRoot[] = [{ configDir: "/r/a", origin: "settings", exists: true }];
  const entry = (p: string, sid: string): FileState => ({
    path: p,
    family: "claude-cli",
    sessionId: sid,
    offsets: { letai: 5 },
    lastMtimeMs: 1,
    lastUploadAtMs: 1,
    lastKnownSize: 10,
  });

  it("splits never-finished entries into behind (under a root) vs unwatched", () => {
    const st: HxState = {
      files: {
        "/r/a/projects/-p/s1.jsonl": entry("/r/a/projects/-p/s1.jsonl", "s1"),
        "/r/removed/projects/-p/s2.jsonl": entry("/r/removed/projects/-p/s2.jsonl", "s2"),
      },
    };
    const { behind, unwatched } = collectBehind(st, new Set(), new Set(), roots);
    assert.deepEqual(behind.map((b) => b.sessionId), ["s1"]);
    assert.equal(unwatched, 1);
  });

  it("counts unwatched as DISTINCT sessions, and never double-bills a behind session", () => {
    const st: HxState = {
      files: {
        // Two entries, one session, both under a removed root → 1, not 2.
        "/r/removed/projects/-p/s5.jsonl": entry("/r/removed/projects/-p/s5.jsonl", "s5"),
        "/r/removed/projects/-q/s5-twin.jsonl": entry("/r/removed/projects/-q/s5-twin.jsonl", "s5"),
        // Session with a behind entry under a watched root AND an unwatched
        // twin → behind row only.
        "/r/a/projects/-p/s6.jsonl": entry("/r/a/projects/-p/s6.jsonl", "s6"),
        "/r/removed/projects/-p/s6-twin.jsonl": entry("/r/removed/projects/-p/s6-twin.jsonl", "s6"),
      },
    };
    const { behind, unwatched } = collectBehind(st, new Set(), new Set(), roots);
    assert.deepEqual(behind.map((b) => b.sessionId), ["s6"]);
    assert.equal(unwatched, 1);
  });

  it("skips discovered files, shadowed twins, finished and legacy entries", () => {
    const st: HxState = {
      files: {
        "/r/a/discovered.jsonl": entry("/r/a/discovered.jsonl", "s1"),
        "/r/a/twin.jsonl": entry("/r/a/twin.jsonl", "s2"),
        "/r/a/done.jsonl": { ...entry("/r/a/done.jsonl", "s3"), offsets: { letai: 10 } },
        "/r/a/legacy.jsonl": { ...entry("/r/a/legacy.jsonl", "s4"), lastKnownSize: undefined },
      },
    };
    const { behind, unwatched } = collectBehind(
      st,
      new Set(["/r/a/discovered.jsonl"]),
      new Set(["claude-cli:s2"]),
      roots,
    );
    assert.deepEqual(behind, []);
    assert.equal(unwatched, 0);
  });
});

describe("snapshotFrom", () => {
  it("never counts a blocked session as done even when legacy offsets equal its size", () => {
    const file: DiscoveredFile = { path: "/a", size: 10, mtimeMs: 1, source: "claude", rootDir: "/home/u/.claude" };
    const st: HxState = {
      files: {
        "/a": {
          path: "/a",
          family: "claude-cli",
          sessionId: "s1",
          offsets: { letai: 10 },
          lastMtimeMs: 1,
          lastUploadAtMs: 1,
          skipReason: "vault_offline",
        },
      },
    };
    assert.deepEqual(snapshotFrom([file], st), { total: 1, done: 0, totalBytes: 10 });
  });
});

describe("child parent identity", () => {
  const fileState = (path: string, over: Partial<FileState> = {}): FileState => ({
    path,
    family: "claude-desktop",
    sessionId: "canonical-session",
    offsets: { letai: 42 },
    lastMtimeMs: 1,
    lastUploadAtMs: 2,
    ...over,
  });

  it("maps Claude's artifact-directory id to the parsed parent session id", () => {
    const parent = fileState("/projects/artifact-session.jsonl");
    const staleChild = fileState("/projects/artifact-session/subagents/agent-a123.jsonl", {
      family: "claude-cli",
      sessionId: "artifact-session",
    });
    const index = buildChildParentIndex({
      files: { [parent.path]: parent, [staleChild.path]: staleChild },
    });

    assert.deepEqual(index.get("artifact-session"), {
      family: "claude-desktop",
      sessionId: "canonical-session",
    });
  });

  it("drops conflicting parent mappings instead of guessing", () => {
    const first = fileState("/one/artifact-session.jsonl");
    const second = fileState("/two/artifact-session.jsonl", { sessionId: "other-session" });

    assert.equal(
      buildChildParentIndex({ files: { [first.path]: first, [second.path]: second } }).has(
        "artifact-session",
      ),
      false,
    );
  });

  it("repairs stale child state, resets wrong-prefix offsets, and clears backoff", () => {
    const child = fileState("/projects/artifact-session/subagents/agent-a123.jsonl", {
      family: "claude-cli",
      sessionId: "artifact-session",
      consecutiveFailures: 4,
      nextAttemptAtMs: 999,
    });
    const repaired = reconcileChildParent(child, {
      family: "claude-desktop",
      sessionId: "canonical-session",
    });

    assert.equal(repaired.family, "claude-desktop");
    assert.equal(repaired.sessionId, "canonical-session");
    assert.deepEqual(repaired.offsets, {});
    assert.equal(repaired.consecutiveFailures, undefined);
    assert.equal(repaired.nextAttemptAtMs, undefined);
  });

  it("keeps committed offsets when only the family classification changes", () => {
    const child = fileState("/projects/session/subagents/agent-a123.jsonl", {
      family: "claude-cli",
    });
    const repaired = reconcileChildParent(child, {
      family: "claude-desktop",
      sessionId: "canonical-session",
    });

    assert.deepEqual(repaired.offsets, { letai: 42 });
  });
});

describe("watchdog", () => {
  const MIN = 60_000;
  const settings = (tuning?: Record<string, unknown>): HxSettings => ({ ...DEFAULT_SETTINGS, tuning });

  it("resolves the limit: default, settings, env override, disable, floor", () => {
    assert.equal(resolveWatchdogMs(settings(), {}), WATCHDOG_DEFAULT_MINUTES * MIN);
    assert.equal(resolveWatchdogMs(settings({ watchdogMinutes: 15 }), {}), 15 * MIN);
    assert.equal(resolveWatchdogMs(settings({ watchdogMinutes: 15 }), { HX_WATCHDOG_MINUTES: "4" }), 4 * MIN);
    assert.equal(resolveWatchdogMs(settings({ watchdogMinutes: 0 }), {}), 0, "0 disables");
    assert.equal(resolveWatchdogMs(settings(), { HX_WATCHDOG_MINUTES: "0" }), 0, "env 0 disables");
    assert.equal(resolveWatchdogMs(settings({ watchdogMinutes: 1 }), {}), WATCHDOG_MIN_MINUTES * MIN, "floored");
    assert.equal(resolveWatchdogMs(settings({ watchdogMinutes: "soon" }), {}), WATCHDOG_DEFAULT_MINUTES * MIN, "garbage → default");
    assert.equal(resolveWatchdogMs(settings(), { HX_WATCHDOG_MINUTES: " " }), WATCHDOG_DEFAULT_MINUTES * MIN, "blank env ignored");
  });

  it("fires only for a pass that is both long-running and silent", () => {
    const limitMs = 10 * MIN;
    const base = { passBusy: true, passStartedAtMs: 0, lastLogAtMs: 0, limitMs };
    assert.equal(watchdogVerdict({ ...base, nowMs: 10 * MIN - 1 }).stuck, false, "not yet");
    assert.equal(watchdogVerdict({ ...base, nowMs: 10 * MIN }).stuck, true, "at the limit");
    // A long pass that keeps logging (a catch-up uploading chunk after chunk) is healthy.
    assert.equal(watchdogVerdict({ ...base, lastLogAtMs: 9 * MIN, nowMs: 18 * MIN }).stuck, false);
    // Silence with no pass running is idleness, not a stall (an offline vault
    // with every file in backoff logs nothing and completes every pass).
    assert.equal(watchdogVerdict({ ...base, passBusy: false, nowMs: 60 * MIN }).stuck, false);
    // Disabled.
    assert.equal(watchdogVerdict({ ...base, limitMs: 0, nowMs: 60 * MIN }).stuck, false);
    const v = watchdogVerdict({ ...base, nowMs: 12 * MIN });
    assert.equal(v.busyForMs, 12 * MIN);
    assert.equal(v.quietForMs, 12 * MIN);
  });
});

// The stuck line's dedupe key names the KIND of reason; the numbers in the
// message (a countdown, a failure count) are not part of it. With the
// countdown in the key the line repeated every minute per stuck file — about
// 90% of a 443 MB stdout.log over one vault outage.
describe("logStuck", () => {
  const MIN = 60_000;
  it("logs a kind of reason once per interval however its numbers change, and a new kind at once", () => {
    resetStuckLogForTests();
    const lines: string[] = [];
    const log = (m: string): void => {
      lines.push(m);
    };
    logStuck("/a", "backoff:vault_offline", "waiting out a retry backoff for another 1 min (1 consecutive failures, vault_offline)", log, 0);
    logStuck("/a", "backoff:vault_offline", "waiting out a retry backoff for another 0 min (1 consecutive failures, vault_offline)", log, 40_000);
    logStuck("/a", "backoff:vault_offline", "waiting out a retry backoff for another 1 min (2 consecutive failures, vault_offline)", log, 2 * MIN);
    assert.equal(lines.length, 1, "the countdown and the failure count do not re-log");
    logStuck("/a", "deleted", "session was permanently deleted on the server — it will never upload again", log, 2 * MIN + 1);
    assert.equal(lines.length, 2, "a change of kind is reported at once");
    logStuck("/b", "backoff:", "waiting out a retry backoff for another 3 min (1 consecutive failures)", log, 2 * MIN + 2);
    assert.equal(lines.length, 3, "another file has its own key");
    logStuck("/b", "backoff:", "waiting out a retry backoff for another 0 min (4 consecutive failures)", log, 2 * MIN + 2 + 30 * MIN);
    assert.equal(lines.length, 4, "the same kind repeats once the interval has passed");
    assert.ok(lines[0]!.startsWith("  [stuck] /a: waiting out a retry backoff"), "the message keeps its detail");
    resetStuckLogForTests();
  });
});

// The parent-file gate, applied to child lanes: with the catalog's walks as
// the change detector, a lane is pooled only when it has something to do.
describe("childNeedsPass", () => {
  const lane = (over: Partial<DiscoveredChildFile> = {}): DiscoveredChildFile => ({
    path: "/r/projects/-p/sid/subagents/agent-a1.jsonl",
    size: 1000,
    mtimeMs: 500,
    parentSessionId: "sid",
    agentId: "a1",
    runId: null,
    metaPath: null,
    rootDir: "/r",
    ...over,
  });
  const fs = (over: Partial<FileState> = {}): FileState => ({
    path: "/r/projects/-p/sid/subagents/agent-a1.jsonl",
    family: "claude-cli",
    sessionId: "sid",
    offsets: { letai: 1000 },
    lastMtimeMs: 500,
    lastUploadAtMs: 400,
    ...over,
  });
  it("skips a delivered, quiet lane and pools everything with work to do", () => {
    assert.equal(childNeedsPass(lane(), fs()), false, "delivered at the catalog's size and mtime");
    assert.equal(childNeedsPass(lane(), undefined), true, "never seeded");
    assert.equal(childNeedsPass(lane({ size: 1200 }), fs()), true, "owed bytes");
    assert.equal(childNeedsPass(lane({ size: 800 }), fs()), true, "shrank: a heal to run");
    assert.equal(childNeedsPass(lane({ mtimeMs: 600 }), fs()), true, "moved mtime: touch bookkeeping");
    assert.equal(childNeedsPass(lane(), fs({ skipReason: "vault_offline" })), true, "a hold re-resolves");
    assert.equal(childNeedsPass(lane(), fs({ consecutiveFailures: 1 })), true, "failure bookkeeping to clear");
    assert.equal(childNeedsPass(lane(), fs({ nextAttemptAtMs: 1 })), true, "an expired backoff still pools once");
    assert.equal(childNeedsPass(lane(), fs({ offsets: { letai: 600, orgA: 1000 } })), true, "a destination behind");
  });
});

// Workflow sidecars: re-hash only when the run moved; after a failed upload
// wait with the parents' schedule instead of retrying every tick.
describe("workflow lanes", () => {
  it("syncs a run it has never seen, then only when its mtime moves", () => {
    assert.equal(planWorkflowSync(undefined, 100, 0), "sync");
    const done = { hashedMtimeMs: 100, consecutiveFailures: 0, nextAttemptAtMs: 0 };
    assert.equal(planWorkflowSync(done, 100, 1_500), "skip-unchanged");
    assert.equal(planWorkflowSync(done, 101, 3_000), "sync", "the journal or script moved");
  });

  it("backs off after a failure, doubling from 30 s to the 30-minute cap, and retries at once after a restart", () => {
    const l1 = workflowLaneAfterFailure(undefined, 0);
    assert.equal(l1.consecutiveFailures, 1);
    assert.equal(l1.nextAttemptAtMs, 30_000);
    assert.equal(planWorkflowSync(l1, 100, 1_500), "skip-backoff");
    assert.equal(planWorkflowSync(l1, 100, 30_000), "sync", "due: retried even though the mtime did not move");
    const l2 = workflowLaneAfterFailure(l1, 30_000);
    assert.equal(l2.nextAttemptAtMs, 90_000, "60 s after the second failure");
    let lane = l2;
    for (let i = 0; i < 12; i++) lane = workflowLaneAfterFailure(lane, lane.nextAttemptAtMs);
    assert.equal(lane.nextAttemptAtMs - (lane.nextAttemptAtMs - FILE_BACKOFF_CAP_MS), FILE_BACKOFF_CAP_MS, "capped");
    assert.equal(workflowLaneAfterFailure(lane, 0).nextAttemptAtMs, FILE_BACKOFF_CAP_MS, "never past the cap");
    // Memory is per process: a restart has no lane and syncs at once.
    assert.equal(planWorkflowSync(undefined, 100, 0), "sync");
  });
});
