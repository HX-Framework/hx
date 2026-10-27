// The CCD group mirror from current Claude Desktop stores: the live account's
// drawn sections, an account switch, the scoped group list without sections,
// and the leftovers of older builds beside the live key. The stores are real
// leveldb files (harness/lib/leveldb-writer.ts), so the mirror goes through
// the record reader, as it does on a Mac.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLdbEntries, buildLogBatches, localStorageKey, localStorageValue } from "../harness/lib/leveldb-writer.js";
import { buildGroupMirror, setCcdLeveldbDirForTests, watchCcdSidebarStore } from "./ccd-prefs.js";
import { setCcdSessionsDirForTests } from "./ccd.js";

const ORIGIN = "https://claude.ai";
const DFRAME = localStorageKey(ORIGIN, "dframe-store");
const UNREAD = localStorageKey(ORIGIN, "epitaxy-unread-v1");
const A = "acct-a/org-a";
const B = "acct-b/org-b";
const hash16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

let root = "";
let ldb = "";
let nowMs = 1_000_000;

afterEach(() => {
  setCcdLeveldbDirForTests(null);
  setCcdSessionsDirForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A fixture root with CCD session files for local_a..local_e (cli-a..cli-e;
 *  local_e has no cli id yet, local_b is archived) and an empty leveldb
 *  directory. */
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "hx-ccd-sidebar-"));
  ldb = join(root, "leveldb");
  const org = join(root, "claude-code-sessions", "acct-a", "org-a");
  mkdirSync(ldb, { recursive: true });
  mkdirSync(org, { recursive: true });
  for (const id of ["a", "b", "c", "d", "e"]) {
    writeFileSync(
      join(org, `local_${id}.json`),
      JSON.stringify({ sessionId: `local_${id}`, ...(id === "e" ? {} : { cliSessionId: `cli-${id}` }), title: id, titleSource: "user", isArchived: id === "b", lastActivityAt: 1 }),
    );
  }
  setCcdLeveldbDirForTests(ldb);
  setCcdSessionsDirForTests(join(root, "claude-code-sessions"));
}

const section = (id: string, name: string, order: number, members: string[], extra: Record<string, unknown> = {}) => ({
  id,
  kind: "manual",
  v: 2,
  name,
  order,
  sortBy: "created",
  ascending: false,
  show: { metadata: false, emptyGroups: false, sideChats: false },
  collapsed: false,
  shown: true,
  members: members.map((m) => `code:local_${m}`),
  ...extra,
});

/** The current layout: two accounts, A drawing Three, One, Two. */
function scopedState(live: string): unknown {
  return {
    state: {
      groupByByMode: { code: "custom" },
      recentsStatusFilter: "active",
      collapsedGroups: ["pinned", "custom-g1"],
      lastSidebarScopeKey: live,
      customGroupsByScope: {
        [A]: {
          groups: [
            { id: "g1", name: "One" },
            { id: "g2", name: "Two" },
            { id: "g3", name: "Three" },
          ],
          // local_c moved from One to Two: One's order list still has it.
          assignments: { "code:local_a": "g1", "code:local_b": "g1", "code:local_c": "g2" },
          order: { g1: ["code:local_a", "code:local_b", "code:local_c"], g2: ["code:local_c"], g3: [] },
        },
        [B]: {
          groups: [{ id: "gb", name: "Second account" }],
          assignments: { "code:local_d": "gb" },
          order: { gb: ["code:local_d"] },
        },
      },
      codeSidebarByScope: {
        [A]: {
          sections: [
            { id: "pinned", kind: "pinned", name: "", order: 0, collapsed: true, shown: true },
            section("g2", "Two", 4, ["c"], { shown: false }),
            section("g1", "One", 3, ["a", "b"], { collapsed: true, sortBy: "alpha", ascending: true }),
            section("g3", "Three", 2, []),
            { id: "sessions", kind: "sessions", name: "", order: 5, collapsed: false, shown: true },
          ],
          migratedFrom: 1,
          prefsSeeded: true,
        },
        [B]: { sections: [section("gb", "Second account", 2, ["d"])], migratedFrom: 1, prefsSeeded: true },
      },
    },
    version: 1,
    shared: {},
  };
}

const json = (v: unknown): Buffer => localStorageValue(JSON.stringify(v));
const unread = json({ state: { unreadIds: ["local_a", "local_e"], explicitUnreadIds: [] }, version: 1 });

describe("CCD mirror: current builds (drawn sections per account)", () => {
  it("is the live account's groups in draw order, with their collapse state, members and sort", async () => {
    setup();
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(scopedState(A)) }, { key: UNREAD, seq: 11, value: unread }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.groupingEnabled, true);
    assert.equal(blob.layout, "sections");
    assert.equal(blob.scope, hash16(A));
    assert.equal(blob.statusFilter, "active");
    // One is stored alpha + ascending, which CCD draws Z to A. Two's stored
    // `shown: false` is not read: CCD draws every group's section.
    assert.deepEqual(
      blob.groups.map((g) => [g.name, g.collapsed, g.shown, g.sortBy, g.ascending, g.sessionIds]),
      [
        ["Three", false, true, "created", false, []],
        ["One", true, true, "alpha", false, ["cli-a", "cli-b"]],
        ["Two", false, true, "created", false, ["cli-c"]],
      ],
    );
    assert.deepEqual(blob.unreadIds, ["cli-a", "local_e"]);
    assert.deepEqual(blob.archivedIds, ["cli-b"], "the archived member, which CCD's active filter hides");
    assert.ok(!blob.groups.some((g) => g.name === "Second account"), "another account's group never reaches the mirror");
    assert.deepEqual(Object.keys(blob.groups[0]!), ["id", "name", "subtitle", "sectionName", "collapsed", "sessionIds", "sortBy", "ascending", "shown", "showEmpty", "sideSessions"]);
    assert.deepEqual(Object.keys(blob), ["groupingEnabled", "groups", "unreadIds", "note", "syncedAtMs", "layout", "statusFilter", "archivedIds", "scope"]);
  });

  it("throws, so the cycle uploads nothing, when the newest sidebar write cannot be read", async () => {
    setup();
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(scopedState(A)) }]));
    writeFileSync(join(ldb, "000004.log"), buildLogBatches([{ seq: 12, entries: [{ key: DFRAME, value: localStorageValue("{not json") }] }]));
    await assert.rejects(buildGroupMirror((nowMs += 1000)), /could not be read/);
  });

  it("cuts the blob to the gateway's limits", async () => {
    setup();
    const st = scopedState(A) as { state: { codeSidebarByScope: Record<string, { sections: Array<Record<string, unknown>> }> } };
    const one = st.state.codeSidebarByScope[A]!.sections.find((s) => s.id === "g1")!;
    one.name = "N".repeat(450);
    one.members = Array.from({ length: 5_003 }, (_, i) => `code:local_m${i}`);
    (st.state as Record<string, unknown>).recentsStatusFilter = "f".repeat(41);
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    const g = blob.groups.find((x) => x.id === "g1")!;
    assert.equal(g.name.length, 400);
    assert.equal(g.sessionIds.length, 5_000);
    assert.equal(blob.statusFilter, null);
  });

  it("sends the sort CCD draws: alpha inverts the stored direction, a missing direction is false, an unknown sort is recency", async () => {
    setup();
    const st = scopedState(A) as { state: { codeSidebarByScope: Record<string, { sections: Array<Record<string, unknown>> }> } };
    const sections = st.state.codeSidebarByScope[A]!.sections;
    Object.assign(sections.find((s) => s.id === "g1")!, { sortBy: "alpha", ascending: false });
    const two = sections.find((s) => s.id === "g2")!;
    two.sortBy = "manual";
    delete two.ascending;
    const three = sections.find((s) => s.id === "g3")!;
    three.sortBy = "alpha";
    delete three.ascending;
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.deepEqual(
      blob.groups.map((g) => [g.name, g.sortBy, g.ascending]),
      [
        ["Three", "alpha", true],
        ["One", "alpha", true],
        ["Two", "recency", false],
      ],
    );
  });

  it("takes 'show empty groups' from the Sessions section, for every group", async () => {
    setup();
    const st = scopedState(A) as { state: { codeSidebarByScope: Record<string, { sections: Array<Record<string, unknown>> }> } };
    const sections = st.state.codeSidebarByScope[A]!.sections;
    sections.find((s) => s.id === "sessions")!.show = { metadata: false, emptyGroups: true, sideChats: false };
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    assert.deepEqual((await buildGroupMirror((nowMs += 1000))).groups.map((g) => g.showEmpty), [true, true, true]);

    sections.find((s) => s.id === "sessions")!.show = { metadata: false, emptyGroups: false, sideChats: false };
    for (const s of sections) if (s.kind === "manual") s.show = { metadata: false, emptyGroups: true, sideChats: false };
    writeFileSync(join(ldb, "000006.ldb"), buildLdbEntries([{ key: DFRAME, seq: 20, value: json(st) }]));
    assert.deepEqual((await buildGroupMirror((nowMs += 1000))).groups.map((g) => g.showEmpty), [false, false, false], "a group's own flag is never read");
  });

  it("follows an account switch written to the log", async () => {
    setup();
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(scopedState(A)) }]));
    writeFileSync(join(ldb, "000004.log"), buildLogBatches([{ seq: 12, entries: [{ key: DFRAME, value: json(scopedState(B)) }] }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.scope, hash16(B));
    assert.deepEqual(blob.groups.map((g) => [g.name, g.sessionIds]), [["Second account", ["cli-d"]]]);
  });

  it("names the layout and the account even when the live account has no groups", async () => {
    setup();
    const st = scopedState(A) as { state: { codeSidebarByScope: Record<string, { sections: unknown[] }> } };
    st.state.codeSidebarByScope[A]!.sections = [{ id: "pinned", kind: "pinned", name: "", order: 0 }];
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.groupingEnabled, false);
    assert.deepEqual(blob.groups, []);
    assert.equal(blob.layout, "sections");
    assert.equal(blob.scope, hash16(A));
  });

  it("is empty when the state names no live account", async () => {
    setup();
    const st = scopedState(A) as { state: Record<string, unknown> };
    delete st.state.lastSidebarScopeKey;
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.groupingEnabled, false);
    assert.equal(blob.scope, null);
  });
});

describe("CCD mirror: side sessions", () => {
  /** A CCD session file in an account's folder. */
  const session = (scope: string, id: string, extra: Record<string, unknown> = {}): void => {
    const dir = join(root, "claude-code-sessions", ...scope.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, title: id, titleSource: "user", isArchived: false, lastActivityAt: 1, ...extra }));
  };
  const side = (parent: string): Record<string, unknown> => ({ spawnedFrom: { sessionId: `local_${parent}`, taskId: "task_1", title: "t", sideSession: true, name: "n" } });

  it("lists each group's side sessions under their parents, from the live account's files only", async () => {
    setup();
    session(A, "s1", { cliSessionId: "cli-s1", ...side("a") });
    session(A, "s0", { cliSessionId: "cli-s0", ...side("a") });
    session(A, "s2", side("s1")); // no cli id yet: keeps its local id
    session(A, "s3", { cliSessionId: "cli-s3", ...side("a"), isArchived: true });
    session(A, "s4", { cliSessionId: "cli-s4", spawnedFrom: { sessionId: "local_a", taskId: "task_2", title: "a card" } }); // not a side session
    session(A, "s5", { cliSessionId: "cli-s5", ...side("a"), lineageDetached: true });
    session(A, "s6", { cliSessionId: "cli-s6", ...side("c") });
    session(A, "s7", { cliSessionId: "cli-s7", ...side("a") }); // filed in Three below
    session(B, "s8", { cliSessionId: "cli-s8", ...side("a") }); // another account's file
    const st = scopedState(A) as { state: { codeSidebarByScope: Record<string, { sections: Array<Record<string, unknown>> }> } };
    st.state.codeSidebarByScope[A]!.sections.find((s) => s.id === "g3")!.members = ["code:local_s7"];
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    const byName = new Map(blob.groups.map((g) => [g.name, g.sideSessions]));
    assert.deepEqual(byName.get("One"), [
      { id: "cli-s0", parent: "cli-a" },
      { id: "cli-s1", parent: "cli-a" },
      { id: "local_s2", parent: "cli-s1" },
      { id: "cli-s3", parent: "cli-a" },
    ]);
    assert.deepEqual(byName.get("Two"), [{ id: "cli-s6", parent: "cli-c" }]);
    assert.deepEqual(byName.get("Three"), [], "s7 is filed in Three itself and has no side sessions");
    assert.deepEqual(blob.archivedIds, ["cli-b", "cli-s3"], "archived members first, then archived side sessions");
  });

  it("takes the side sessions from the new account after a switch", async () => {
    setup();
    session(A, "s1", { cliSessionId: "cli-s1", ...side("a") });
    session(B, "s8", { cliSessionId: "cli-s8", ...side("d") });
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(scopedState(B)) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.deepEqual(blob.groups.map((g) => [g.name, g.sideSessions]), [["Second account", [{ id: "cli-s8", parent: "cli-d" }]]]);
  });
});

describe("CCD mirror: per-account groups without sections", () => {
  it("reads the group list, with collapse state from collapsedGroups and members from assignments", async () => {
    setup();
    const st = scopedState(A) as { state: Record<string, unknown> };
    delete st.state.codeSidebarByScope;
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.layout, "scoped-groups");
    assert.deepEqual(
      blob.groups.map((g) => [g.name, g.collapsed, g.sessionIds]),
      [
        ["One", true, ["cli-a", "cli-b"]],
        ["Two", false, ["cli-c"]],
        ["Three", false, []],
      ],
    );
  });

  it("needs CCD to group by custom groups", async () => {
    setup();
    const st = scopedState(A) as { state: Record<string, unknown> };
    delete st.state.codeSidebarByScope;
    st.state.groupByByMode = { code: "repo" };
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.equal(blob.groupingEnabled, false);
    assert.equal(blob.layout, "scoped-groups");
  });
});

describe("CCD mirror: older builds and leftovers", () => {
  const flat = {
    state: {
      groupByByMode: { code: "custom" },
      customGroups: [{ id: "f1", name: " Flat ", subtitle: "sub", sectionName: "Work" }],
      customGroupOrder: { f1: ["code:local_a"] },
      customGroupAssignments: { "code:local_b": "f1" },
      collapsedGroups: ["f1"],
    },
    version: 0,
  };

  it("reads the flat layout as before, in the blob shape it always had", async () => {
    setup();
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: localStorageKey("file://", "frame-store"), seq: 3, value: json(flat) }]));
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.deepEqual(blob.groups, [{ id: "f1", name: "Flat", subtitle: "sub", sectionName: "Work", collapsed: true, sessionIds: ["cli-a", "cli-b"] }]);
    assert.deepEqual(Object.keys(blob), ["groupingEnabled", "groups", "unreadIds", "note", "syncedAtMs"]);
  });

  it("takes the newest grouping state when an older build's key is left beside the live one", async () => {
    setup();
    writeFileSync(
      join(ldb, "000005.ldb"),
      buildLdbEntries([
        { key: localStorageKey("file://", "frame-store"), seq: 5, value: json(flat) },
        { key: DFRAME, seq: 9, value: json(scopedState(A)) },
      ]),
    );
    assert.equal((await buildGroupMirror((nowMs += 1000))).layout, "sections");
  });

  it("skips a newer value that is not the grouping state (the old {mru} dframe-store)", async () => {
    setup();
    writeFileSync(
      join(ldb, "000005.ldb"),
      buildLdbEntries([
        { key: localStorageKey("file://", "frame-store"), seq: 5, value: json(flat) },
        { key: localStorageKey("file://", "dframe-store"), seq: 12, value: json({ state: { mru: ["code:local_a"] }, version: 0 }) },
      ]),
    );
    const blob = await buildGroupMirror((nowMs += 1000));
    assert.deepEqual(blob.groups.map((g) => g.name), ["Flat"]);
  });
});

describe("watchCcdSidebarStore", () => {
  it("calls back once per burst of writes, within the debounce", async () => {
    setup();
    writeFileSync(join(ldb, "000004.log"), "");
    const calls: number[] = [];
    const t0 = Date.now();
    const w = watchCcdSidebarStore(
      () => calls.push(Date.now() - t0),
      (reason) => assert.fail(reason),
    );
    assert.ok(w, "armed");
    try {
      await Bun.sleep(150);
      const t1 = Date.now();
      for (let i = 0; i < 5; i++) {
        appendFileSync(join(ldb, "000004.log"), buildLogBatches([{ seq: 100 + i, entries: [{ key: DFRAME, value: json(scopedState(A)) }] }]));
        await Bun.sleep(20);
      }
      await Bun.sleep(1_200);
      assert.equal(calls.length, 1, `one call for the burst, got ${JSON.stringify(calls)}`);
      assert.ok(calls[0]! - (t1 - t0) < 1_000, `called ${calls[0]! - (t1 - t0)} ms after the first write`);
    } finally {
      w.close();
    }
  });
});
