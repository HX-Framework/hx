// Read Codex Desktop's sidebar sections and the threads in each.
//
// Codex Desktop (the Codex side of the ChatGPT desktop app) lets the user make
// sections in its sidebar and move threads, or a whole project, into them.
// The sidebar draws them from the app's persisted state,
// <codexHome>/.codex-global-state.json:
//
//   electron-persisted-atom-state
//     sidebar-custom-sections-v3: { <ChatGPT account id>: {
//       sections: [{ id, name, hostSectionIds: { local: <database section id> },
//                    itemKeys: ["codex:thread:local:<thread id>" | "codex:project:<project id>"] }],
//       sectionOrder: ["custom:<id>" | "pinned" | "agents" | "threads" | "chats"],
//       collapsedSectionIds: [<id>] } }
//
// Codex's app-server keeps a copy in state_<N>.sqlite (`thread_sections`, and
// `threads.thread_section_id` / `section_position`). The copy agrees on which
// threads sit in which section and in what order, but it has no section order,
// no collapsed state and no project items, so the JSON file is the source and
// the database is read for what only it holds:
//   • which threads the sidebar lists at all (see `visible` below);
//   • Codex's built-in Pinned list (the section with the fixed id below);
//   • each thread's cwd and recency, to file it under its project;
//   • the sections themselves when the JSON file has none to offer (a Codex
//     that keeps them only in the app-server).
//
// Below the custom sections Codex draws its built-in ones: Pinned, then (in
// its default "project" mode) Projects, a row per local project with its
// threads, and Recents, the threads with no project. They are mirrored too,
// as Codex's code (ChatGPT.app 26.924) builds them; see "Projects" below. A
// project row's group id is `project:<project id>`, and its `sectionName`
// names the built-in section it sits in ("Projects" or "Pinned").
//
// A thread id is the rollout's session_meta id, which is the sessionId hx
// uploads the session under, so a section's members need no mapping.
//
// The sections ride in the group mirror upload as its `codex` field
// (watch.ts syncGroupMirror). Read-only. A file that exists but cannot be read
// or parsed fails the whole read, and the upload then leaves `codex` out, so
// the server keeps the last sections it had: an upload is the device's whole
// set of sections, and a partial read would move every section it missed to
// "past" on the server.

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { codexStateDbPath, openCodexStateDb } from "./codex-titles.js";
import type { HxCodexSection, HxCodexSidebarBlob } from "./mirror-types.js";

export const CODEX_GLOBAL_STATE = ".codex-global-state.json";
/** The fixed id of the app-server's built-in Pinned list (codex-rs). */
export const CODEX_PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const THREAD_ITEM = "codex:thread:local:";
const PROJECT_ITEM = "codex:project:";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ── The app-server database ─────────────────────────────────────────────────

interface DbThread {
  /** Listed in Codex's sidebar: not archived, with a preview (a thread with
   *  no user message has none), started from the CLI or the desktop app
   *  (Codex's thread list leaves subagent, guardian and exec threads out),
   *  not spawned by another thread, and neither an ambient suggestion nor a
   *  thread ChatGPT hides. */
  visible: boolean;
  cwd: string | null;
  recencyMs: number;
}

export interface CodexDbRead {
  threads: Map<string, DbThread>;
  /** The app-server's sections, oldest first, without the built-in Pinned list. */
  sections: Array<{ id: string; name: string }>;
  /** Thread ids per section id, in Codex's order, listed or not. */
  members: Map<string, string[]>;
}

/** Everything the sections need from the database. Throws when it cannot be read. */
export function readCodexStateDb(dbPath: string): CodexDbRead {
  const out: CodexDbRead = { threads: new Map(), sections: [], members: new Map() };
  const db = openCodexStateDb(dbPath);
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: unknown }>).map((r) => r.name),
    );
    if (!tables.has("threads")) return out;
    // Older schemas lack the newer columns: ask for what this one has instead
    // of failing on what it does not.
    const cols = new Set((db.query("PRAGMA table_info(threads)").all() as Array<{ name: unknown }>).map((r) => r.name));
    const col = (name: string, fallback: string): string => (cols.has(name) ? name : fallback);
    const recency = cols.has("recency_at_ms") ? "recency_at_ms" : col("updated_at_ms", "0");
    const rows = db
      .query(
        `SELECT id, ${col("archived", "0")} AS archived, ${col("source", "'cli'")} AS source, ${cols.has("preview") ? "preview <> ''" : "1"} AS previewed, ${col("thread_source", "NULL")} AS threadSource, ${col("cwd", "NULL")} AS cwd, ${recency} AS recency FROM threads`,
      )
      .all() as Array<{ id: unknown; archived: unknown; source: unknown; previewed: unknown; threadSource: unknown; cwd: unknown; recency: unknown }>;
    // Codex lists top-level threads only.
    const spawned = new Set(
      tables.has("thread_spawn_edges")
        ? (db.query("SELECT child_thread_id AS id FROM thread_spawn_edges").all() as Array<{ id: unknown }>).map((r) => r.id)
        : [],
    );
    for (const r of rows) {
      if (typeof r.id !== "string") continue;
      out.threads.set(r.id, {
        visible:
          Number(r.archived) === 0 &&
          Number(r.previewed) !== 0 &&
          (r.source === "cli" || r.source === "vscode") &&
          r.threadSource !== "ambient_suggestions" &&
          r.threadSource !== "chatgpt_hidden" &&
          !spawned.has(r.id),
        cwd: typeof r.cwd === "string" ? r.cwd : null,
        recencyMs: typeof r.recency === "number" && Number.isFinite(r.recency) ? r.recency : 0,
      });
    }
    if (cols.has("thread_section_id")) {
      // Codex lists a section's threads by section_position, then id.
      const position = col("section_position", "NULL");
      const placed = db
        .query(
          `SELECT id, thread_section_id AS section FROM threads WHERE thread_section_id IS NOT NULL ORDER BY thread_section_id, ${position}, id`,
        )
        .all() as Array<{ id: unknown; section: unknown }>;
      for (const r of placed) {
        if (typeof r.id !== "string" || typeof r.section !== "string") continue;
        const list = out.members.get(r.section);
        if (list) list.push(r.id);
        else out.members.set(r.section, [r.id]);
      }
    }
    if (tables.has("thread_sections")) {
      const rows2 = db.query("SELECT id, name FROM thread_sections ORDER BY rowid").all() as Array<{ id: unknown; name: unknown }>;
      for (const r of rows2) {
        if (typeof r.id !== "string" || typeof r.name !== "string" || r.id === CODEX_PINNED_SECTION_ID) continue;
        out.sections.push({ id: r.id, name: r.name });
      }
    }
    return out;
  } finally {
    db.close();
  }
}

// ── Which account's sections ────────────────────────────────────────────────

// The file keeps one entry per ChatGPT account ever signed in and names the
// signed-in one only indirectly. In order:
//   1. environment-catalog-cache-v1.accountId, the cache Codex refreshes for
//      the signed-in account;
//   2. the one key of the chatgpt-sidebar-state-v1 atom, kept for the
//      signed-in account;
//   3. the only entry, when there is just one.
// An account named by 1 or 2 that has no entry has no sections: it never
// borrows another account's. "unknown" means nothing above decides.
function pickAccount(gs: Obj, atoms: Obj, entries: Obj): string | null | "unknown" {
  const cache = gs["environment-catalog-cache-v1"];
  const named = isObj(cache) && typeof cache.accountId === "string" && cache.accountId ? cache.accountId : null;
  if (named) return Object.hasOwn(entries, named) ? named : null;
  const sidebar = atoms["chatgpt-sidebar-state-v1"];
  const keys = isObj(sidebar) ? Object.keys(sidebar) : [];
  if (keys.length === 1) return Object.hasOwn(entries, keys[0]!) ? keys[0]! : null;
  const all = Object.keys(entries);
  return all.length === 1 ? all[0]! : "unknown";
}

// ── Projects ────────────────────────────────────────────────────────────────

// Codex's projects are the entries of `local-projects`, which its main process
// hands to the sidebar unchanged, minus the single-root ones kept under a
// `.chatgpt-projects` folder and the ones backed by a ChatGPT project (the
// sidebar shows those as ChatGPT projects). A project's label is its trimmed
// name, or its id.
interface LocalProject {
  id: string;
  label: string;
  roots: string[];
  createdAt: number;
}

function localProjects(gs: Obj): LocalProject[] {
  const out: LocalProject[] = [];
  const projects = gs["local-projects"];
  if (!isObj(projects)) return out;
  for (const [key, p] of Object.entries(projects)) {
    if (!isObj(p) || p.chatGptBacking) continue;
    const id = typeof p.id === "string" && p.id ? p.id : key;
    const roots = strings(p.rootPaths);
    if (roots.length === 1 && path.posix.basename(path.posix.dirname(roots[0]!.replace(/\\/g, "/"))) === ".chatgpt-projects") continue;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    out.push({ id, label: name || id, roots, createdAt: typeof p.createdAt === "number" ? p.createdAt : 0 });
  }
  return out;
}

// Codex compares paths with `\` turned into `/` and lowercased, and gives a
// thread the project whose root EQUALS its cwd: a thread in a subfolder of a
// root is not that project's.
function pathKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// When two projects share a root, Codex keeps the single-root one, then the
// one whose first root it is, then the older, then the larger id.
function beats(a: LocalProject, b: LocalProject, key: string): boolean {
  const single = (p: LocalProject): number => (p.roots.length === 1 ? 1 : 0);
  if (single(a) !== single(b)) return single(a) > single(b);
  const first = (p: LocalProject): number => (pathKey(p.roots[0] ?? "") === key ? 1 : 0);
  if (first(a) !== first(b)) return first(a) > first(b);
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id > b.id;
}

// A thread Codex started in a dated folder under ~/Documents/Codex has no project.
const PROJECTLESS_DIR =
  /^(.*(?:^|[\\/])Documents[\\/]+Codex)[\\/]+(?:\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*|\d{4}-\d{2}-\d{2}[\\/]+[a-z0-9][a-z0-9-]*)[\\/]*$/;
// A worktree Codex made for a thread. Codex resolves its project through git;
// it saves the root it found in thread-workspace-root-hints, which hx reads.
const CODEX_WORKTREES = /^(.*\/(?:\.codex|\.codex-workspaces(?:\/instances\/[^/]+)?|OpenAI\/Codex\/workspaces(?:\/instances\/[^/]+)?)\/worktrees)(?:\/|$)/;

function inCodexWorktree(cwd: string, codexHome: string): boolean {
  const dir = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const roots: string[] = [];
  if (codexHome) roots.push(`${codexHome.replace(/\\/g, "/").replace(/\/+$/, "")}/worktrees`);
  const m = CODEX_WORKTREES.exec(dir);
  if (m) roots.push(m[1]!);
  return roots.some((r) => dir === r || dir.startsWith(`${r}/`));
}

interface ProjectIndex {
  list: LocalProject[];
  byId: Map<string, LocalProject>;
  byRoot: Map<string, LocalProject>;
}

function indexProjects(gs: Obj): ProjectIndex {
  const list = localProjects(gs);
  const byRoot = new Map<string, LocalProject>();
  for (const p of list) {
    for (const root of p.roots) {
      const key = pathKey(root);
      const held = byRoot.get(key);
      if (!held || beats(p, held, key)) byRoot.set(key, p);
    }
  }
  return { list, byId: new Map(list.map((p) => [p.id, p])), byRoot };
}

// The project Codex files a thread under, the first rule that applies:
//   1. an assignment to a local project that exists;
//   2. no project for an assignment that came from a ChatGPT project, an empty
//      cwd, a thread marked projectless or one in a dated ~/Documents/Codex folder;
//   3. for a Codex worktree that is not itself a root, the root Codex saved;
//   4. the project whose root equals the cwd; else none.
// A thread assigned to a project that no longer exists, with no root to fall
// back on, is hidden everywhere (undefined).
interface ResolveCtx {
  projects: ProjectIndex;
  assignments: Obj;
  projectless: Set<string>;
  hints: Obj;
  codexHome: string;
}

function resolveProject(tid: string, cwd: string | null, ctx: ResolveCtx): string | null | undefined {
  const { projects } = ctx;
  const a = ctx.assignments[tid];
  const assigned = isObj(a) && a.projectKind === "local" && typeof a.projectId === "string" ? a : null;
  if (assigned) {
    if (projects.byId.has(assigned.projectId as string)) return assigned.projectId as string;
    if (assigned.projectOrigin === "chatgpt") return null;
  }
  let pid: string | null = null;
  if (cwd && cwd.split(/[\\/]+/).some(Boolean) && !ctx.projectless.has(tid) && !PROJECTLESS_DIR.test(cwd.trim())) {
    let dir = cwd;
    if (inCodexWorktree(cwd, ctx.codexHome) && !projects.byRoot.has(pathKey(cwd))) {
      const hint = ctx.hints[tid];
      if (typeof hint === "string" && projects.byRoot.has(pathKey(hint))) dir = hint;
    }
    pid = projects.byRoot.get(pathKey(dir))?.id ?? null;
  }
  return pid === null && assigned ? undefined : pid;
}

// ── Sidebar preferences ─────────────────────────────────────────────────────

interface SidebarPrefs {
  /** "project": the threads outside the sections are listed by project
   *  (Projects) and again in Recents; "list": Recents only. */
  mode: "project" | "list";
  projectSort: "updated_at" | "manual";
  chatSort: "updated_at" | "manual";
  showProjectsInRecents: boolean;
  chatsFirst: boolean;
}

// flat-project-sidebar-preferences-v1, read as Codex reads it: a `manual` (or
// `created_at`) sort counts only with manualSortVersion 1 and is otherwise
// `updated_at`; codex-sidebar-sort-mode-v1, when set, overrides both sorts
// (its `manual` reading as `updated_at` too); before the preferences were
// initialized, a legacy organize mode decides. `connection` and `team` modes
// show what `project` shows for a device without remote connections.
function sidebarPrefs(gs: Obj, atoms: Obj): SidebarPrefs {
  const prefs = atoms["flat-project-sidebar-preferences-v1"];
  const p: Obj = isObj(prefs) ? prefs : {};
  let mode = typeof p.mode === "string" ? p.mode : "project";
  if (p.initialized !== true) {
    const legacy = atoms["sidebar-organize-mode-v1"];
    if (legacy === "recent") mode = atoms["sidebar-keep-projects-in-recent-v1"] === false ? "list" : "project";
    else if (typeof legacy === "string") mode = legacy;
  }
  const v1 = p.manualSortVersion === 1;
  const sortOf = (m: unknown): "updated_at" | "manual" => (m === "manual" && v1 ? "manual" : "updated_at");
  const overridden = typeof atoms["codex-sidebar-sort-mode-v1"] === "string";
  const setting = (k: string): unknown => (Object.hasOwn(atoms, k) ? atoms[k] : gs[k]);
  return {
    mode: mode === "list" ? "list" : "project",
    projectSort: overridden ? "updated_at" : sortOf(p.projectSortMode),
    chatSort: overridden ? "updated_at" : sortOf(p.chatSortMode),
    showProjectsInRecents: setting("sidebar-show-projects-in-recents") !== false,
    chatsFirst: setting("projectless-sidebar-chats-first-v1") === true,
  };
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** `ids` without repeats, in their order. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

// `saved` applied to `ids` the way Codex applies a saved order: the ids it
// does not name first, in their order, then the ones it names, in its order.
function savedOrderLast(ids: string[], saved: string[]): string[] {
  const present = new Set(ids);
  const named = dedupe(saved).filter((id) => present.has(id));
  const namedSet = new Set(named);
  return [...ids.filter((id) => !namedSet.has(id)), ...named];
}

/**
 * Codex's sidebar from the parsed global state (null when the file is
 * absent) and the database read (null when there is no database), as groups
 * in the order Codex draws them. Pure: the tests and the harness expectations
 * call it directly. `codexHome` places Codex's own worktrees.
 *
 * Every group is one the sidebar draws: the custom sections; Pinned (pinned
 * threads, then each pinned project as a row of its own, `sectionName`
 * "Pinned"); in project mode one row per project (`sectionName` "Projects"),
 * empty ones too; and Recents. Codex lists a project's threads in Recents as
 * well, and the mirror shows a session once, so Recents carries the threads
 * no project row holds.
 */
export function assembleCodexSections(
  gs: Obj | null,
  db: CodexDbRead | null,
  codexHome = "",
): { groups: HxCodexSection[]; source: "saved" | "database" | "none" } {
  const atoms = gs && isObj(gs["electron-persisted-atom-state"]) ? gs["electron-persisted-atom-state"] : {};
  const entries = atoms["sidebar-custom-sections-v3"];
  const account = gs && isObj(entries) ? pickAccount(gs, atoms, entries) : "unknown";
  const entry = account !== null && account !== "unknown" && isObj(entries) ? entries[account] : undefined;
  const state = gs ?? {};
  const prefs = sidebarPrefs(state, atoms);
  const projects = indexProjects(state);
  const objectAt = (k: string): Obj => (isObj(state[k]) ? (state[k] as Obj) : {});
  const resolveCtx: ResolveCtx = {
    projects,
    assignments: objectAt("thread-project-assignments"),
    projectless: new Set(strings(state["projectless-thread-ids"])),
    hints: objectAt("thread-workspace-root-hints"),
    codexHome,
  };

  // Each listed thread's project, worked out once per read.
  const projectOf = new Map<string, string | null | undefined>();
  const byProject = new Map<string, string[]>();
  if (db) {
    for (const [tid, t] of db.threads) {
      const pid = resolveProject(tid, t.cwd, resolveCtx);
      projectOf.set(tid, pid);
      if (!t.visible || !pid) continue;
      const list = byProject.get(pid);
      if (list) list.push(tid);
      else byProject.set(pid, [tid]);
    }
  } else if (gs) {
    // No database: a project holds the threads assigned to it.
    const assignments = gs["thread-project-assignments"];
    for (const [tid, a] of Object.entries(isObj(assignments) ? assignments : {})) {
      if (!isObj(a) || a.projectKind !== "local" || typeof a.projectId !== "string" || !projects.byId.has(a.projectId)) continue;
      const list = byProject.get(a.projectId);
      if (list) list.push(tid);
      else byProject.set(a.projectId, [tid]);
    }
  }
  // With a database, a thread it does not list (deleted), does not show or
  // hides for good is left out; without one, every named thread is kept.
  const hidden = (tid: string): boolean => db !== null && (db.threads.get(tid)?.visible !== true || projectOf.get(tid) === undefined);
  const recency = (tid: string): number => db?.threads.get(tid)?.recencyMs ?? 0;
  const newestFirst = (a: string, b: string): number => recency(b) - recency(a) || (a < b ? 1 : a > b ? -1 : 0);

  // The custom sections: the signed-in account's saved ones; with no saved
  // sidebar to go by, the app-server's, oldest first.
  type Section = { id: string; name: string; collapsed: boolean; itemKeys: string[] };
  let sections: Section[] = [];
  let source: "saved" | "database" | "none" = "none";
  if (isObj(entry) && Array.isArray(entry.sections)) {
    const collapsed = new Set(strings(entry.collapsedSectionIds));
    sections = entry.sections
      .filter((s): s is Obj => isObj(s) && typeof s.id === "string" && s.id !== "" && typeof s.name === "string" && s.name.trim() !== "")
      .map((s) => ({ id: s.id as string, name: s.name as string, collapsed: collapsed.has(s.id as string), itemKeys: strings(s.itemKeys) }));
    source = "saved";
  } else if (account === "unknown" && db && db.sections.length > 0) {
    sections = db.sections.map((s) => ({
      id: s.id,
      name: s.name,
      collapsed: false,
      itemKeys: (db.members.get(s.id) ?? []).map((tid) => `${THREAD_ITEM}${tid}`),
    }));
    source = "database";
  }
  const sectionThreads = new Set<string>();
  const sectionProjects = new Set<string>();
  for (const s of sections) {
    for (const key of s.itemKeys) {
      if (key.startsWith(THREAD_ITEM)) sectionThreads.add(key.slice(THREAD_ITEM.length));
      else if (key.startsWith(PROJECT_ITEM)) sectionProjects.add(key.slice(PROJECT_ITEM.length));
    }
  }

  // Pinned: the app-server's pinned section, then any thread pinned by an
  // older Codex that the app-server has not taken over yet; and the pinned
  // projects that exist.
  const pinnedThreads: string[] = [...(db?.members.get(CODEX_PINNED_SECTION_ID) ?? [])];
  const migratedByHost = state["app-server-migrated-pinned-thread-ids-by-host"];
  const migrated = new Set<string>(isObj(migratedByHost) ? Object.values(migratedByHost).flatMap(strings) : []);
  for (const tid of strings(state["pinned-thread-ids"])) {
    if (!migrated.has(tid) && !pinnedThreads.includes(tid)) pinnedThreads.push(tid);
  }
  const pinnedSet = new Set(pinnedThreads.filter((tid) => !hidden(tid)));
  const pinnedProjects = dedupe(strings(state["pinned-project-ids"])).filter((pid) => projects.byId.has(pid));
  const pinnedProjectSet = new Set(pinnedProjects);

  // A project's threads in the order Codex lists them: newest first, or with
  // the manual sort the saved order first and the rest newest first after it.
  // A pinned thread or one a section names on its own shows there instead.
  const orders = state["sidebar-project-thread-orders"];
  const projectThreads = (pid: string): string[] => {
    const members = (byProject.get(pid) ?? []).filter((tid) => !pinnedSet.has(tid) && !sectionThreads.has(tid)).sort(newestFirst);
    if (prefs.projectSort !== "manual") return members;
    const saved = isObj(orders) && isObj(orders[pid]) ? strings(orders[pid].threadIds) : [];
    const present = new Set(members);
    const named = dedupe(saved).filter((tid) => present.has(tid));
    const namedSet = new Set(named);
    return [...named, ...members.filter((tid) => !namedSet.has(tid))];
  };

  const collapsedAtom = atoms["sidebar-collapsed-sections-v1"];
  const collapsedSections: Obj = isObj(collapsedAtom) ? collapsedAtom : {};
  const rowCollapsed = (pid: string): boolean => atoms[`sidebar-project-expanded-v1-codex:${pid}`] === false;

  // The rows of Projects: every project that is neither pinned nor placed in a
  // section, those missing from project-order first, then project-order, with
  // unified-sidebar-project-order-v1 applied the same way on top.
  const rows = (() => {
    const ids = projects.list.map((p) => p.id);
    let out = savedOrderLast(ids, strings(state["project-order"])).filter((pid) => !pinnedProjectSet.has(pid) && !sectionProjects.has(pid));
    const unified = strings(atoms["unified-sidebar-project-order-v1"]).map((k) => (k.startsWith(PROJECT_ITEM) ? k.slice(PROJECT_ITEM.length) : k));
    out = savedOrderLast(out, unified);
    return gs && db && prefs.mode === "project" ? out : [];
  })();
  const rowThreads = new Map(rows.map((pid) => [pid, projectThreads(pid)]));
  const inRows = new Set([...rowThreads.values()].flat());

  const groups: HxCodexSection[] = [];
  const claimed = new Set<string>();
  // A thread shows once: the first group in sidebar order keeps it.
  const take = (ids: string[]): string[] => {
    const out: string[] = [];
    for (const tid of ids) {
      if (hidden(tid) || claimed.has(tid)) continue;
      claimed.add(tid);
      out.push(tid);
    }
    return out;
  };
  const projectRow = (pid: string, sectionName: string, sectionCollapsed: boolean): HxCodexSection => ({
    id: `project:${pid}`,
    name: projects.byId.get(pid)!.label,
    sectionName,
    collapsed: sectionCollapsed || rowCollapsed(pid),
    sessionIds: take(rowThreads.get(pid) ?? projectThreads(pid)),
    showEmpty: true,
  });

  const emit = {
    pinned: (): void => {
      const ids = take(pinnedThreads);
      const closed = collapsedSections.pinned === true;
      if (ids.length > 0) groups.push({ id: "pinned", name: "Pinned", collapsed: closed, sessionIds: ids, showEmpty: true });
      if (gs) for (const pid of pinnedProjects) groups.push(projectRow(pid, "Pinned", closed));
    },
    section: (s: Section): void => {
      const ids: string[] = [];
      for (const key of s.itemKeys) {
        if (key.startsWith(THREAD_ITEM)) {
          const tid = key.slice(THREAD_ITEM.length);
          if (!pinnedSet.has(tid)) ids.push(tid);
        } else if (key.startsWith(PROJECT_ITEM)) ids.push(...projectThreads(key.slice(PROJECT_ITEM.length)));
      }
      groups.push({ id: s.id, name: s.name, collapsed: s.collapsed, sessionIds: take(ids), showEmpty: true });
    },
    projects: (): void => {
      for (const pid of rows) groups.push(projectRow(pid, "Projects", collapsedSections.threads === true));
    },
    recents: (): void => {
      if (!gs || !db) return;
      const ids = [...db.threads.keys()].filter((tid) => {
        if (hidden(tid) || pinnedSet.has(tid) || sectionThreads.has(tid) || inRows.has(tid)) return false;
        const pid = projectOf.get(tid);
        return !pid || (!pinnedProjectSet.has(pid) && !sectionProjects.has(pid) && (prefs.mode === "list" || prefs.showProjectsInRecents));
      });
      ids.sort(newestFirst);
      const ordered =
        prefs.chatSort === "manual"
          ? savedOrderLast(ids, strings(atoms["unified-sidebar-chat-order-v1"]).map((k) => (k.startsWith(THREAD_ITEM) ? k.slice(THREAD_ITEM.length) : k)))
          : ids;
      groups.push({ id: "recents", name: "Recents", collapsed: collapsedSections.chats === true, sessionIds: take(ordered), showEmpty: true });
    },
  };

  // Codex's section order: Pinned and Agents first when the saved order does
  // not place them, then the saved order, then the custom sections it misses,
  // then the built-in sections it misses.
  const byId = new Map(sections.map((s) => [s.id, s]));
  const saved = isObj(entry) ? strings(entry.sectionOrder) : [];
  const order: string[] = [];
  const place = (key: string): void => {
    if (!order.includes(key)) order.push(key);
  };
  if (!saved.includes("pinned")) place("pinned");
  if (!saved.includes("agents")) place("agents");
  for (const key of saved) {
    if (key === "pinned" || key === "agents" || key === "threads" || key === "chats" || (key.startsWith("custom:") && byId.has(key.slice("custom:".length)))) place(key);
  }
  for (const s of sections) place(`custom:${s.id}`);
  for (const key of prefs.chatsFirst ? ["chats", "threads"] : ["threads", "chats"]) place(key);

  for (const key of order) {
    if (key === "pinned") emit.pinned();
    else if (key === "threads") emit.projects();
    else if (key === "chats") emit.recents();
    else if (key.startsWith("custom:")) emit.section(byId.get(key.slice("custom:".length))!);
  }
  return { groups, source };
}

// ── Reading a Codex home, cached on the files' stats ─────────────────────────

function statPart(p: string): string {
  try {
    const s = statSync(p);
    return `${s.size}:${Math.trunc(s.mtimeMs)}`;
  } catch {
    return "-";
  }
}

// The parts of the global state the sections read. The file also holds
// prompt history, drafts and window state; only these keys are kept between
// reads.
const KEPT_KEYS = [
  "environment-catalog-cache-v1",
  "thread-project-assignments",
  "projectless-thread-ids",
  "thread-workspace-root-hints",
  "local-projects",
  "project-order",
  "sidebar-project-thread-orders",
  "pinned-thread-ids",
  "pinned-project-ids",
  "app-server-migrated-pinned-thread-ids-by-host",
  // Settings Codex may keep beside its atoms.
  "sidebar-show-projects-in-recents",
  "projectless-sidebar-chats-first-v1",
];
const KEPT_ATOMS = [
  "sidebar-custom-sections-v3",
  "chatgpt-sidebar-state-v1",
  "flat-project-sidebar-preferences-v1",
  "codex-sidebar-sort-mode-v1",
  "sidebar-organize-mode-v1",
  "sidebar-keep-projects-in-recent-v1",
  "sidebar-show-projects-in-recents",
  "projectless-sidebar-chats-first-v1",
  "sidebar-collapsed-sections-v1",
  "unified-sidebar-project-order-v1",
  "unified-sidebar-chat-order-v1",
];
// One atom per project row: `sidebar-project-expanded-v1-codex:<project id>`.
const KEPT_ATOM_PREFIX = "sidebar-project-expanded-v1-";

function keep(from: Obj, keys: string[], prefix?: string): Obj {
  const out: Obj = {};
  for (const k of keys) if (Object.hasOwn(from, k)) out[k] = from[k];
  if (prefix) for (const k of Object.keys(from)) if (k.startsWith(prefix)) out[k] = from[k];
  return out;
}

/** The global state's sidebar keys; null when the file is absent. Throws
 *  when it exists but cannot be read or parsed. */
function readGlobalState(p: string): Obj | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a Codex data root
  if (!existsSync(p)) return null;
  const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
  if (!isObj(parsed)) throw new Error("not a JSON object");
  const out = keep(parsed, KEPT_KEYS);
  const atoms = parsed["electron-persisted-atom-state"];
  if (isObj(atoms)) out["electron-persisted-atom-state"] = keep(atoms, KEPT_ATOMS, KEPT_ATOM_PREFIX);
  return out;
}

interface HomeRead {
  gsFp: string;
  gs: Obj | null;
  dbFp: string;
  db: CodexDbRead | null;
  groups: HxCodexSection[];
}

const cache = new Map<string, HomeRead>();

/** Test seam: forget the cached reads. */
export function resetCodexSectionsCacheForTests(): void {
  cache.clear();
}

/** One Codex home's sections, or null when a file there could not be read;
 *  `present` is false when the home holds neither file. A file whose stats
 *  have not moved since the last read is not read again. */
export function readCodexHomeSections(codexHome: string): { groups: HxCodexSection[]; present: boolean } | null {
  const gsPath = path.join(codexHome, CODEX_GLOBAL_STATE);
  const gsFp = statPart(gsPath);
  const dbPath = codexStateDbPath(codexHome);
  const dbFp = dbPath ? `${dbPath}|${statPart(dbPath)}|${statPart(`${dbPath}-wal`)}` : "-";
  const present = gsFp !== "-" || dbPath !== null;
  const hit = cache.get(codexHome);
  if (hit && hit.gsFp === gsFp && hit.dbFp === dbFp) return { groups: hit.groups, present };
  let gs: Obj | null;
  let db: CodexDbRead | null;
  try {
    gs = hit && hit.gsFp === gsFp ? hit.gs : readGlobalState(gsPath);
    db = hit && hit.dbFp === dbFp ? hit.db : dbPath ? readCodexStateDb(dbPath) : null;
  } catch {
    // Unreadable, caught mid-write by a writer that does not rename, locked,
    // or gone between the listing and the open: the next change or the 20 s
    // timer reads again.
    cache.delete(codexHome);
    return null;
  }
  const { groups } = assembleCodexSections(gs, db, codexHome);
  cache.set(codexHome, { gsFp, gs, dbFp, db, groups });
  return { groups, present };
}

/**
 * Codex's sections across the Codex homes hx reads, in home order, for the
 * group mirror's `codex`: undefined when a home could not be read (the
 * upload leaves `codex` out, and the server keeps the last sections it had),
 * null when no home holds Codex's state. A home whose files have not changed
 * since the last read is answered from the cache, so the 20 s timer costs a
 * few stats per home.
 */
export function buildCodexSections(codexHomes: string[]): HxCodexSidebarBlob | null | undefined {
  const groups: HxCodexSection[] = [];
  const seen = new Set<string>();
  let present = false;
  for (const home of codexHomes) {
    const read = readCodexHomeSections(home);
    if (!read) return undefined;
    present ||= read.present;
    for (const g of read.groups) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      groups.push(g);
    }
  }
  return present ? { groups } : null;
}

// ── Watching for changes ────────────────────────────────────────────────────

// A sidebar change lands in the global state file or in the state database
// and its -wal. Codex writes the global state file to a temp file and renames
// it over the old one, and on macOS the event names only the temp file
// (`..codex-global-state.json.tmp-<ms>-<uuid>`), so any name holding the
// file's name counts. The other files in a Codex home (logs_2.sqlite above
// all, written whenever Codex runs) are ignored by name.
export function isCodexSidebarFile(name: string): boolean {
  return name.includes(CODEX_GLOBAL_STATE) || /^state_\d+\.sqlite(-wal)?$/.test(name);
}

export interface CodexSidebarWatch {
  close(): void;
}

/**
 * Watch each Codex home, not recursively, and call `onChange` once per burst
 * of sidebar-file events: `debounceMs` after the last one, and never later
 * than `maxWaitMs` after the first, so a stream of writes cannot hold the
 * sync back. A home that does not exist is skipped; one that cannot be
 * watched is reported and left to the daemon's 20 s timer.
 */
export function watchCodexSidebar(
  homes: string[],
  onChange: () => void,
  onFailure: (reason: string) => void,
  debounceMs = 150,
  maxWaitMs = 1_000,
): CodexSidebarWatch {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  const hint = (): void => {
    const now = Date.now();
    if (timer === null) firstAt = now;
    else if (now - firstAt >= maxWaitMs) return; // the pending timer is due
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, Math.min(debounceMs, Math.max(0, firstAt + maxWaitMs - now)));
  };
  for (const home of homes) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a Codex data root
    if (!existsSync(home)) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a Codex data root
      const w = watch(home, { persistent: false }, (_event, name) => {
        if (name == null || isCodexSidebarFile(String(name))) hint();
      });
      w.on("error", (err) => {
        onFailure(`${home}: ${(err as Error).message}`);
        try {
          w.close();
        } catch {
          // closing is best-effort
        }
      });
      watchers.push(w);
    } catch (err) {
      onFailure(`${home}: ${(err as Error).message}`);
    }
  }
  return {
    close(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // closing is best-effort
        }
      }
    },
  };
}
