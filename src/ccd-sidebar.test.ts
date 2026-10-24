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
    assert.deepEqual(
      blob.groups.map((g) => [g.name, g.collapsed, g.shown, g.sortBy, g.ascending, g.sessionIds]),
      [
        ["Three", false, true, "created", false, []],
        ["One", true, true, "alpha", true, ["cli-a", "cli-b"]],
        ["Two", false, false, "created", false, ["cli-c"]],
      ],
    );
    assert.deepEqual(blob.unreadIds, ["cli-a", "local_e"]);
    assert.deepEqual(blob.archivedIds, ["cli-b"], "the archived member, which CCD's active filter hides");
    assert.ok(!blob.groups.some((g) => g.name === "Second account"), "another account's group never reaches the mirror");
    assert.deepEqual(Object.keys(blob.groups[0]!), ["id", "name", "subtitle", "sectionName", "collapsed", "sessionIds", "sortBy", "ascending", "shown", "showEmpty"]);
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
    one.sortBy = "s".repeat(41);
    writeFileSync(join(ldb, "000005.ldb"), buildLdbEntries([{ key: DFRAME, seq: 10, value: json(st) }]));
    const g = (await buildGroupMirror((nowMs += 1000))).groups.find((x) => x.id === "g1")!;
    assert.equal(g.name.length, 400);
    assert.equal(g.sessionIds.length, 5_000);
    assert.equal(g.sortBy, null);
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
