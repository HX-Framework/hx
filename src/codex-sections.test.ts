import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCodexSections,
  CODEX_GLOBAL_STATE,
  CODEX_PINNED_SECTION_ID,
  isCodexSidebarFile,
  readCodexStateDb,
  resetCodexSectionsCacheForTests,
  watchCodexSidebar,
} from "./codex-sections.js";

let home: string;

const ACCOUNT = "acct-current";
const T = (n: number): string => `0000000${n}-0000-7000-8000-000000000000`;

interface Row {
  id: string;
  archived?: number;
  source?: string;
  preview?: string;
  threadSource?: string | null;
  cwd?: string | null;
  recency?: number;
  section?: string | null;
  position?: number | null;
}

/** A state_5.sqlite with the columns the reader asks for. */
function makeDb(rows: Row[], sections: Array<{ id: string; name: string }> = [], file = "state_5.sqlite"): string {
  const p = join(home, file);
  const db = new Database(p);
  db.run(
    `CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', thread_source TEXT, cwd TEXT NOT NULL DEFAULT '', recency_at_ms INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT, section_position INTEGER)`,
  );
  db.run(`CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance TEXT)`);
  for (const s of sections) db.run(`INSERT INTO thread_sections (id, name) VALUES (?, ?)`, [s.id, s.name]);
  for (const r of rows) {
    db.run(
      `INSERT INTO threads (id, archived, source, preview, thread_source, cwd, recency_at_ms, thread_section_id, section_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.archived ?? 0,
        r.source ?? "vscode",
        r.preview ?? "a preview",
        r.threadSource ?? "user",
        r.cwd ?? "/work/elsewhere",
        r.recency ?? 0,
        r.section ?? null,
        r.position ?? null,
      ],
    );
  }
  db.close();
  return p;
}

function writeState(state: unknown): void {
  writeFileSync(join(home, CODEX_GLOBAL_STATE), JSON.stringify(state));
}

/** A global state whose current account (named by the catalog cache) has `entry`. */
function stateWith(entry: unknown, extra: Record<string, unknown> = {}, atoms: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "environment-catalog-cache-v1": { accountId: ACCOUNT },
    "electron-persisted-atom-state": {
      "sidebar-custom-sections-v3": { [ACCOUNT]: entry, "acct-old": { sections: [{ id: "old", name: "Old account", itemKeys: [] }], collapsedSectionIds: [], sectionOrder: [] } },
      ...atoms,
    },
    ...extra,
  };
}

const item = (n: number): string => `codex:thread:local:${T(n)}`;

type Group = { id: string; name: string; collapsed: boolean; sessionIds: string[] };

/** The sections, without the `showEmpty` every one of them carries. */
function plain(groups: Array<Group & { showEmpty: boolean }> | undefined): Group[] | undefined {
  for (const g of groups ?? []) assert.equal(g.showEmpty, true);
  return groups?.map(({ showEmpty: _showEmpty, ...g }) => g);
}

function read(): { groups: Group[] } {
  const blob = buildCodexSections([home]);
  assert.ok(blob, "the read succeeded");
  return { groups: plain(blob.groups)! };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hx-codex-sections-"));
  resetCodexSectionsCacheForTests();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetCodexSectionsCacheForTests();
});

describe("Codex sections from the saved sidebar", () => {
  it("lists the account's sections in the saved order, with their threads in order and the collapsed state", () => {
    makeDb([1, 2, 3, 4].map((n) => ({ id: T(n) })));
    writeState(
      stateWith({
        sections: [
          { id: "a", name: "Alpha", itemKeys: [item(2), item(1)] },
          { id: "b", name: "Beta", itemKeys: [item(3)] },
          { id: "c", name: "Not in the order", itemKeys: [item(4)] },
        ],
        collapsedSectionIds: ["b"],
        sectionOrder: ["custom:b", "agents", "pinned", "custom:a", "threads", "chats"],
      }),
    );
    assert.deepEqual(read().groups, [
      { id: "b", name: "Beta", collapsed: true, sessionIds: [T(3)] },
      { id: "a", name: "Alpha", collapsed: false, sessionIds: [T(2), T(1)] },
      { id: "c", name: "Not in the order", collapsed: false, sessionIds: [T(4)] },
    ]);
  });

  it("keeps an empty section, skips items that are not Codex threads, and gives a thread to the first section only", () => {
    makeDb([{ id: T(1) }]);
    writeState(
      stateWith({
        sections: [
          { id: "a", name: "A", itemKeys: ["chatgpt:conversation:x", "codex:thread:remote:task-1", item(1)] },
          { id: "b", name: "B", itemKeys: [item(1)] },
          { id: "e", name: "Empty", itemKeys: [] },
          { id: "", name: "No id", itemKeys: [item(1)] },
          { id: "n", name: "   ", itemKeys: [] },
        ],
        collapsedSectionIds: [],
        sectionOrder: ["custom:a", "custom:b", "custom:e"],
      }),
    );
    assert.deepEqual(read().groups, [
      { id: "a", name: "A", collapsed: false, sessionIds: [T(1)] },
      { id: "b", name: "B", collapsed: false, sessionIds: [] },
      { id: "e", name: "Empty", collapsed: false, sessionIds: [] },
    ]);
  });

  it("leaves out threads the sidebar does not list: archived, no preview, subagent, ambient, deleted", () => {
    makeDb([
      { id: T(1) },
      { id: T(2), archived: 1 },
      { id: T(3), preview: "" },
      { id: T(4), source: '{"subagent":{"other":"guardian"}}', threadSource: "guardian_review" },
      { id: T(5), threadSource: "ambient_suggestions" },
      { id: T(6), source: "cli" },
      { id: T(7), source: "exec" },
    ]);
    writeState(
      stateWith({
        sections: [{ id: "a", name: "A", itemKeys: [1, 2, 3, 4, 5, 6, 7, 8].map(item) }],
        collapsedSectionIds: [],
        sectionOrder: ["custom:a"],
      }),
    );
    assert.deepEqual(read().groups[0]!.sessionIds, [T(1), T(6)]);
  });

  it("keeps every named thread when there is no database", () => {
    writeState(stateWith({ sections: [{ id: "a", name: "A", itemKeys: [item(1), item(2)] }], collapsedSectionIds: [], sectionOrder: [] }));
    assert.deepEqual(read().groups, [{ id: "a", name: "A", collapsed: false, sessionIds: [T(1), T(2)] }]);
  });
});

describe("which account", () => {
  const entry = { sections: [{ id: "a", name: "Mine", itemKeys: [] }], collapsedSectionIds: [], sectionOrder: [] };

  it("an account named by the catalog cache with no entry has no sections, never another account's", () => {
    makeDb([]);
    writeState({
      "environment-catalog-cache-v1": { accountId: "acct-new" },
      "electron-persisted-atom-state": { "sidebar-custom-sections-v3": { "acct-old": entry } },
    });
    assert.deepEqual(read().groups, []);
  });

  it("falls back to the one key of chatgpt-sidebar-state-v1, then to the only entry", () => {
    makeDb([]);
    writeState({
      "electron-persisted-atom-state": {
        "sidebar-custom-sections-v3": { mine: entry, other: { ...entry, sections: [{ id: "o", name: "Other", itemKeys: [] }] } },
        "chatgpt-sidebar-state-v1": { mine: {} },
      },
    });
    assert.deepEqual(read().groups.map((g) => g.name), ["Mine"]);
    resetCodexSectionsCacheForTests();
    writeState({ "electron-persisted-atom-state": { "sidebar-custom-sections-v3": { solo: entry } } });
    assert.deepEqual(read().groups.map((g) => g.name), ["Mine"]);
  });

  it("with several accounts and nothing naming one, uses the app-server's sections, oldest first", () => {
    makeDb(
      [
        { id: T(1), section: "s2", position: 2000 },
        { id: T(2), section: "s2", position: 1000 },
        { id: T(3), section: "s1", position: 1000, archived: 1 },
      ],
      [
        { id: CODEX_PINNED_SECTION_ID, name: "Pinned" },
        { id: "s1", name: "First" },
        { id: "s2", name: "Second" },
      ],
    );
    writeState({ "electron-persisted-atom-state": { "sidebar-custom-sections-v3": { one: entry, two: entry } } });
    assert.deepEqual(plain(buildCodexSections([home])?.groups), [
      { id: "s1", name: "First", collapsed: false, sessionIds: [] },
      { id: "s2", name: "Second", collapsed: false, sessionIds: [T(2), T(1)] },
    ]);
  });

  it("with no global state file at all, uses the app-server's sections", () => {
    makeDb([{ id: T(1), section: "s1", position: 1 }], [{ id: "s1", name: "Only" }]);
    assert.deepEqual(plain(buildCodexSections([home])?.groups), [{ id: "s1", name: "Only", collapsed: false, sessionIds: [T(1)] }]);
  });
});

describe("Pinned", () => {
  it("is the app-server's pinned list by position, then unmigrated legacy pins, then pinned projects; placed where the order puts it", () => {
    makeDb([
      { id: T(1), section: CODEX_PINNED_SECTION_ID, position: 2 },
      { id: T(2), section: CODEX_PINNED_SECTION_ID, position: 1 },
      { id: T(3), section: CODEX_PINNED_SECTION_ID, position: 3, archived: 1 },
      { id: T(4) },
      { id: T(5) },
      { id: T(6), cwd: "/work/pinned-project/src", recency: 5 },
    ]);
    writeState(
      stateWith(
        { sections: [{ id: "a", name: "A", itemKeys: [item(5)] }], collapsedSectionIds: [], sectionOrder: ["custom:a", "pinned"] },
        {
          "pinned-thread-ids": [T(4), T(5), T(1)],
          "app-server-migrated-pinned-thread-ids-by-host": { "local:/h": [T(5)] },
          "pinned-project-ids": ["p1"],
          "local-projects": { p1: { id: "p1", name: "pinned-project", rootPaths: ["/work/pinned-project"] } },
        },
      ),
    );
    assert.deepEqual(read().groups, [
      { id: "a", name: "A", collapsed: false, sessionIds: [T(5)] },
      { id: "pinned", name: "Pinned", collapsed: false, sessionIds: [T(2), T(1), T(4), T(6)] },
    ]);
  });

  it("comes first when the saved order does not place it, and is left out when empty", () => {
    makeDb([{ id: T(1), section: CODEX_PINNED_SECTION_ID, position: 1 }, { id: T(2) }]);
    writeState(stateWith({ sections: [{ id: "a", name: "A", itemKeys: [item(2)] }], collapsedSectionIds: [], sectionOrder: ["custom:a"] }));
    assert.deepEqual(read().groups.map((g) => g.id), ["pinned", "a"]);
    resetCodexSectionsCacheForTests();
    makeDb([{ id: T(2) }], [], "state_6.sqlite");
    assert.deepEqual(read().groups.map((g) => g.id), ["a"]);
  });
});

describe("a project placed in a section", () => {
  const projects = {
    "local-projects": {
      lf: { id: "lf", name: "acme", rootPaths: ["/work/acme/"] },
      wt: { id: "wt", name: "a worktree", rootPaths: ["/work/acme/.claude/worktrees/wt"] },
    },
  };

  it("brings assigned threads and threads under the project's root (deepest root wins), not projectless ones", () => {
    makeDb([
      { id: T(1), cwd: "/elsewhere", recency: 10 }, // assigned to lf
      { id: T(2), cwd: "/work/acme", recency: 30 },
      { id: T(3), cwd: "/work/acme/apps/x", recency: 20 },
      { id: T(4), cwd: "/work/acme/.claude/worktrees/wt", recency: 40 }, // the worktree's own project
      { id: T(5), cwd: "/work/acme", recency: 50 }, // projectless
      { id: T(6), cwd: "/work/acme", recency: 60 }, // assigned to wt
      { id: T(7), cwd: "/work/acme-other", recency: 70 },
    ]);
    writeState(
      stateWith(
        { sections: [{ id: "old", name: "OLD", itemKeys: ["codex:project:lf"] }], collapsedSectionIds: [], sectionOrder: ["custom:old"] },
        {
          ...projects,
          "thread-project-assignments": { [T(1)]: { projectKind: "local", projectId: "lf" }, [T(6)]: { projectKind: "local", projectId: "wt" } },
          "projectless-thread-ids": [T(5)],
        },
      ),
    );
    assert.deepEqual(read().groups[0]!.sessionIds, [T(2), T(3), T(1)]);
  });

  it("orders threads missing from the saved order first, newest first, then the saved order; newest first when not sorted by hand", () => {
    const rows = [
      { id: T(1), cwd: "/work/acme", recency: 10 },
      { id: T(2), cwd: "/work/acme", recency: 20 },
      { id: T(3), cwd: "/work/acme", recency: 30 },
      { id: T(4), cwd: "/work/acme", recency: 40 },
    ];
    makeDb(rows);
    const entry = { sections: [{ id: "old", name: "OLD", itemKeys: ["codex:project:lf"] }], collapsedSectionIds: [], sectionOrder: [] };
    const extra = { ...projects, "sidebar-project-thread-orders": { lf: { threadIds: [T(1), "gone", T(3), T(1)] } } };
    writeState(stateWith(entry, extra, { "flat-project-sidebar-preferences-v1": { projectSortMode: "manual" } }));
    assert.deepEqual(read().groups[0]!.sessionIds, [T(4), T(2), T(1), T(3)]);
    resetCodexSectionsCacheForTests();
    writeState(stateWith(entry, extra, { "flat-project-sidebar-preferences-v1": { projectSortMode: "updated_at" } }));
    assert.deepEqual(read().groups[0]!.sessionIds, [T(4), T(3), T(2), T(1)]);
  });
});

describe("reading", () => {
  it("has no answer when the global state cannot be parsed, null when no home holds Codex's state, and no sections when Codex has none", () => {
    writeFileSync(join(home, CODEX_GLOBAL_STATE), "{ torn");
    assert.equal(buildCodexSections([home]), undefined);
    rmSync(join(home, CODEX_GLOBAL_STATE));
    assert.equal(buildCodexSections([home]), null);
    assert.equal(buildCodexSections([join(home, "missing")]), null);
    writeState({ "electron-persisted-atom-state": {} });
    assert.deepEqual(buildCodexSections([home]), { groups: [] });
  });

  it("has no answer when the database cannot be read", () => {
    writeFileSync(join(home, "state_5.sqlite"), "not a database, but long enough to be read as one ".repeat(20));
    assert.equal(buildCodexSections([home]), undefined);
  });

  it("reads a WAL database whose -wal and -shm files are gone, as Codex leaves it when idle", () => {
    const p = makeDb([{ id: T(1), section: "s1", position: 1 }], [{ id: "s1", name: "From the main file" }]);
    const db = new Database(p);
    db.run("PRAGMA journal_mode = WAL");
    db.run("INSERT INTO thread_sections (id, name) VALUES ('s2', 'Checkpointed')");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    for (const f of [`${p}-wal`, `${p}-shm`]) if (existsSync(f)) unlinkSync(f);
    assert.deepEqual(readCodexStateDb(p).sections, [
      { id: "s1", name: "From the main file" },
      { id: "s2", name: "Checkpointed" },
    ]);
  });

  it("answers from the cache while the files' stats stand still, and reads again when one moves", () => {
    makeDb([{ id: T(1) }]);
    writeState(stateWith({ sections: [{ id: "a", name: "A", itemKeys: [item(1)] }], collapsedSectionIds: [], sectionOrder: [] }));
    const first = buildCodexSections([home]);
    assert.equal(buildCodexSections([home])?.groups[0], first?.groups[0]);
    writeState(stateWith({ sections: [{ id: "a", name: "Renamed in Codex", itemKeys: [item(1)] }], collapsedSectionIds: [], sectionOrder: [] }));
    assert.equal(buildCodexSections([home])?.groups[0]?.name, "Renamed in Codex");
  });

  it("older schemas without the newer columns still read", () => {
    const db = new Database(join(home, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    db.run("INSERT INTO threads (id, title) VALUES (?, 'x')", [T(1)]);
    db.close();
    const read = readCodexStateDb(join(home, "state_5.sqlite"));
    assert.deepEqual([...read.threads.entries()], [[T(1), { visible: true, cwd: null, recencyMs: 0 }]]);
    assert.deepEqual(read.sections, []);
  });
});

describe("watching", () => {
  it("names the files a sidebar change lands in, and no others", () => {
    for (const n of [".codex-global-state.json", "..codex-global-state.json.tmp-1-abc", ".codex-global-state.json.bak", "state_5.sqlite", "state_12.sqlite-wal"]) {
      assert.ok(isCodexSidebarFile(n), n);
    }
    for (const n of ["logs_2.sqlite-wal", "state_5.sqlite-shm", "sessions", "goals_1.sqlite"]) assert.ok(!isCodexSidebarFile(n), n);
  });

  it("calls back once per burst of sidebar writes, and ignores other files", async () => {
    let calls = 0;
    const w = watchCodexSidebar([home], () => calls++, (r) => assert.fail(r), 80, 1_000);
    try {
      await Bun.sleep(50);
      writeFileSync(join(home, "logs_2.sqlite-wal"), "noise");
      await Bun.sleep(250);
      assert.equal(calls, 0);
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(home, `..${CODEX_GLOBAL_STATE}.tmp-${i}`), "{}");
        renameSync(join(home, `..${CODEX_GLOBAL_STATE}.tmp-${i}`), join(home, CODEX_GLOBAL_STATE));
        await Bun.sleep(20);
      }
      await Bun.sleep(400);
      assert.equal(calls, 1);
    } finally {
      w.close();
    }
  });

  it("does not let a steady stream of writes hold the call back past the cap", async () => {
    let calls = 0;
    const w = watchCodexSidebar([home], () => calls++, (r) => assert.fail(r), 200, 400);
    try {
      await Bun.sleep(50);
      const started = Date.now();
      while (Date.now() - started < 900) {
        writeFileSync(join(home, "state_5.sqlite-wal"), String(Date.now()));
        await Bun.sleep(50);
      }
      assert.ok(calls >= 1, `called ${calls} time(s) during 900 ms of writes`);
    } finally {
      w.close();
    }
  });
});
