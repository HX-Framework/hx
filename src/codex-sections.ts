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
//   • each thread's cwd and recency, to expand a project placed in a section;
//   • the sections themselves when the JSON file has none to offer (a Codex
//     that keeps them only in the app-server).
//
// Codex also groups the threads OUTSIDE the sections by project. It derives
// that in the renderer from workspace roots and git origins; hx does not
// reproduce it, and those sessions keep the server's by-repo grouping.
//
// A thread id is the rollout's session_meta id, which is the sessionId hx
// uploads the session under, so a section's members need no mapping.
//
// Read-only. A file that exists but cannot be read or parsed fails the whole
// read (null) and the caller uploads nothing: an upload is the device's whole
// set of sections, so a partial read would move every section it missed to
// "past" on the server.

import { constants, Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { codexStateDbPath } from "./codex-titles.js";
import type { HxCodexSection, HxCodexSectionsBlob } from "./mirror-types.js";

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
   *  and not an ambient suggestion. */
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

/** A SQLite URI that opens `p` read-only and ignores any WAL. */
export function immutableDbUri(p: string): string {
  let u = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(u)) u = `/${u}`;
  u = u.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
  return `file:${u}?immutable=1`;
}

// Codex's app-server closes the database when it has nothing to do, and the
// last close checkpoints the WAL and deletes the -wal and -shm files. A
// read-only connection cannot open a WAL database in that state (SQLite
// answers "unable to open database file"), so with no -wal file the database
// is opened immutable: everything is in the main file then. With a -wal file
// the ordinary read-only open also sees the writes not yet checkpointed.
function openStateDb(dbPath: string): Database {
  if (existsSync(`${dbPath}-wal`)) return new Database(dbPath, { readonly: true });
  return new Database(immutableDbUri(dbPath), constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

/** Everything the sections need from the database. Throws when it cannot be read. */
export function readCodexStateDb(dbPath: string): CodexDbRead {
  const out: CodexDbRead = { threads: new Map(), sections: [], members: new Map() };
  const db = openStateDb(dbPath);
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
    for (const r of rows) {
      if (typeof r.id !== "string") continue;
      out.threads.set(r.id, {
        visible:
          Number(r.archived) === 0 &&
          Number(r.previewed) !== 0 &&
          (r.source === "cli" || r.source === "vscode") &&
          r.threadSource !== "ambient_suggestions",
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

// ── Projects placed in a section ────────────────────────────────────────────

function normDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// A project item stands for the threads Codex files under that project: a
// thread assigned to a project (thread-project-assignments) belongs to it; a
// thread marked projectless belongs to none; any other thread belongs to the
// local project whose root holds its cwd, the deepest root winning. Codex
// also matches by git origin, which hx does not look at.
function projectOf(
  tid: string,
  cwd: string | null,
  assignments: unknown,
  projectless: Set<string>,
  roots: Array<{ id: string; root: string }>,
): string | null {
  const a = isObj(assignments) ? assignments[tid] : undefined;
  if (isObj(a) && typeof a.projectId === "string") return a.projectId;
  if (projectless.has(tid) || !cwd) return null;
  const dir = normDir(cwd);
  let best: { id: string; len: number } | null = null;
  for (const r of roots) {
    if ((dir === r.root || dir.startsWith(`${r.root}/`)) && (!best || r.root.length > best.len)) {
      best = { id: r.id, len: r.root.length };
    }
  }
  return best?.id ?? null;
}

function localProjectRoots(gs: Obj): Array<{ id: string; root: string }> {
  const out: Array<{ id: string; root: string }> = [];
  const projects = gs["local-projects"];
  if (!isObj(projects)) return out;
  for (const [key, p] of Object.entries(projects)) {
    if (!isObj(p)) continue;
    const id = typeof p.id === "string" ? p.id : key;
    for (const root of strings(p.rootPaths)) {
      const r = normDir(root);
      if (r) out.push({ id, root: r });
    }
  }
  return out;
}

// Every project's threads, worked out once per read. Codex builds a
// project's list from the threads its sidebar lists, so with a database the
// candidates are its threads; without one, the assigned threads.
function indexProjects(gs: Obj, db: CodexDbRead | null): Map<string, string[]> {
  const roots = localProjectRoots(gs);
  const assignments = gs["thread-project-assignments"];
  const projectless = new Set(strings(gs["projectless-thread-ids"]));
  const candidates = db ? [...db.threads.keys()] : isObj(assignments) ? Object.keys(assignments) : [];
  const byProject = new Map<string, string[]>();
  for (const tid of candidates) {
    const pid = projectOf(tid, db?.threads.get(tid)?.cwd ?? null, assignments, projectless, roots);
    if (pid === null) continue;
    const list = byProject.get(pid);
    if (list) list.push(tid);
    else byProject.set(pid, [tid]);
  }
  return byProject;
}

interface Ctx {
  gs: Obj;
  atoms: Obj;
  db: CodexDbRead | null;
  projects: Map<string, string[]> | null;
}

// The project's threads in the order Codex lists them: with the manual sort
// (Codex's default for projects) the threads missing from the saved order
// come first, newest first, then the saved order; otherwise newest first.
function projectThreads(pid: string, ctx: Ctx): string[] {
  ctx.projects ??= indexProjects(ctx.gs, ctx.db);
  const members = ctx.projects.get(pid) ?? [];
  const recency = (tid: string): number => ctx.db?.threads.get(tid)?.recencyMs ?? 0;
  const newestFirst = (a: string, b: string): number => recency(b) - recency(a) || (a < b ? 1 : a > b ? -1 : 0);
  const prefs = ctx.atoms["flat-project-sidebar-preferences-v1"];
  const sortMode = ctx.atoms["codex-sidebar-sort-mode-v1"] ?? (isObj(prefs) ? prefs.projectSortMode : undefined) ?? "manual";
  const orders = ctx.gs["sidebar-project-thread-orders"];
  const saved = sortMode === "manual" && isObj(orders) && isObj(orders[pid]) ? strings(orders[pid].threadIds) : [];
  const memberSet = new Set(members);
  const savedMembers: string[] = [];
  for (const tid of saved) if (memberSet.has(tid) && !savedMembers.includes(tid)) savedMembers.push(tid);
  const savedSet = new Set(savedMembers);
  return [...members.filter((tid) => !savedSet.has(tid)).sort(newestFirst), ...savedMembers];
}

// ── Assembly ────────────────────────────────────────────────────────────────

// Codex's Pinned list: the app-server's pinned section, then any thread pinned
// by an older Codex that the app-server has not taken over yet, then the
// threads of each pinned project.
function pinnedThreads(ctx: Ctx): string[] {
  const out = [...(ctx.db?.members.get(CODEX_PINNED_SECTION_ID) ?? [])];
  const migratedByHost = ctx.gs["app-server-migrated-pinned-thread-ids-by-host"];
  const migrated = new Set<string>(isObj(migratedByHost) ? Object.values(migratedByHost).flatMap(strings) : []);
  for (const tid of strings(ctx.gs["pinned-thread-ids"])) {
    if (!migrated.has(tid) && !out.includes(tid)) out.push(tid);
  }
  for (const pid of strings(ctx.gs["pinned-project-ids"])) out.push(...projectThreads(pid, ctx));
  return out;
}

/**
 * Codex's sections from the parsed global state (null when the file is
 * absent) and the database read (null when there is no database). Pure: the
 * tests and the harness expectations call it directly.
 */
export function assembleCodexSections(
  gs: Obj | null,
  db: CodexDbRead | null,
): { groups: HxCodexSection[]; source: "saved" | "database" | "none" } {
  const atoms = gs && isObj(gs["electron-persisted-atom-state"]) ? gs["electron-persisted-atom-state"] : {};
  const entries = atoms["sidebar-custom-sections-v3"];
  const account = gs && isObj(entries) ? pickAccount(gs, atoms, entries) : "unknown";
  const entry = account !== null && account !== "unknown" && isObj(entries) ? entries[account] : undefined;
  const ctx: Ctx = { gs: gs ?? {}, atoms, db, projects: null };

  const groups: HxCodexSection[] = [];
  const claimed = new Set<string>();
  // With a database, a thread it does not list (deleted) or does not show is
  // left out; without one, every named thread is kept.
  const hidden = (tid: string): boolean => db !== null && db.threads.get(tid)?.visible !== true;
  // A thread shows once: the first section in sidebar order keeps it.
  const take = (ids: string[]): string[] => {
    const out: string[] = [];
    for (const tid of ids) {
      if (hidden(tid) || claimed.has(tid)) continue;
      claimed.add(tid);
      out.push(tid);
    }
    return out;
  };
  const pinned = (): void => {
    const ids = take(pinnedThreads(ctx));
    if (ids.length > 0) groups.push({ id: "pinned", name: "Pinned", collapsed: false, sessionIds: ids });
  };

  if (isObj(entry) && Array.isArray(entry.sections)) {
    const sections = entry.sections.filter(
      (s): s is Obj => isObj(s) && typeof s.id === "string" && s.id !== "" && typeof s.name === "string" && s.name.trim() !== "",
    );
    const byId = new Map(sections.map((s) => [s.id as string, s]));
    const collapsed = new Set(strings(entry.collapsedSectionIds));
    const order = strings(entry.sectionOrder);
    const emitted = new Set<string>();
    const section = (s: Obj): void => {
      const id = s.id as string;
      if (emitted.has(id)) return;
      emitted.add(id);
      const ids: string[] = [];
      for (const key of strings(s.itemKeys)) {
        if (key.startsWith(THREAD_ITEM)) ids.push(key.slice(THREAD_ITEM.length));
        else if (key.startsWith(PROJECT_ITEM)) ids.push(...projectThreads(key.slice(PROJECT_ITEM.length), ctx));
      }
      groups.push({ id, name: s.name as string, collapsed: collapsed.has(id), sessionIds: take(ids) });
    };
    // Codex puts Pinned first when the saved order does not place it.
    let pinnedDone = !order.includes("pinned");
    if (pinnedDone) pinned();
    for (const key of order) {
      if (key === "pinned" && !pinnedDone) {
        pinnedDone = true;
        pinned();
      } else if (key.startsWith("custom:")) {
        const s = byId.get(key.slice("custom:".length));
        if (s) section(s);
      }
    }
    for (const s of sections) section(s);
    return { groups, source: "saved" };
  }

  if (account === "unknown" && db && db.sections.length > 0) {
    // No saved sidebar to go by: the app-server's sections, oldest first.
    pinned();
    for (const s of db.sections) {
      groups.push({ id: s.id, name: s.name, collapsed: false, sessionIds: take(db.members.get(s.id) ?? []) });
    }
    return { groups, source: "database" };
  }

  pinned();
  return { groups, source: "none" };
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
  "local-projects",
  "sidebar-project-thread-orders",
  "pinned-thread-ids",
  "pinned-project-ids",
  "app-server-migrated-pinned-thread-ids-by-host",
];
const KEPT_ATOMS = [
  "sidebar-custom-sections-v3",
  "chatgpt-sidebar-state-v1",
  "flat-project-sidebar-preferences-v1",
  "codex-sidebar-sort-mode-v1",
];

function keep(from: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (Object.hasOwn(from, k)) out[k] = from[k];
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
  if (isObj(atoms)) out["electron-persisted-atom-state"] = keep(atoms, KEPT_ATOMS);
  return out;
}

interface HomeRead {
  gsFp: string;
  gs: Obj | null;
  dbFp: string;
  db: CodexDbRead | null;
  read: ReturnType<typeof assembleCodexSections>;
}

const cache = new Map<string, HomeRead>();

/** Test seam: forget the cached reads. */
export function resetCodexSectionsCacheForTests(): void {
  cache.clear();
}

/** One Codex home's sections, or null when a file there could not be read.
 *  A file whose stats have not moved since the last read is not read again. */
export function readCodexHomeSections(codexHome: string): ReturnType<typeof assembleCodexSections> | null {
  const gsPath = path.join(codexHome, CODEX_GLOBAL_STATE);
  const gsFp = statPart(gsPath);
  const dbPath = codexStateDbPath(codexHome);
  const dbFp = dbPath ? `${dbPath}|${statPart(dbPath)}|${statPart(`${dbPath}-wal`)}` : "-";
  const hit = cache.get(codexHome);
  if (hit && hit.gsFp === gsFp && hit.dbFp === dbFp) return hit.read;
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
  const read = assembleCodexSections(gs, db);
  cache.set(codexHome, { gsFp, gs, dbFp, db, read });
  return read;
}

/**
 * Codex's sections across the Codex homes hx reads, in home order, or null
 * when any home could not be read. A home whose files have not changed since
 * the last read is answered from the cache, so the 20 s timer costs a few
 * stats per home.
 */
export function buildCodexSections(codexHomes: string[], nowMs: number): HxCodexSectionsBlob | null {
  const groups: HxCodexSection[] = [];
  const seen = new Set<string>();
  const sources = new Set<string>();
  for (const home of codexHomes) {
    const read = readCodexHomeSections(home);
    if (!read) return null;
    sources.add(read.source);
    for (const g of read.groups) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      groups.push(g);
    }
  }
  const from = sources.has("saved")
    ? "Codex's saved sidebar"
    : sources.has("database")
      ? "Codex's app-server database"
      : "no saved Codex sidebar";
  return { groups, note: `${groups.length} section(s) from ${from}`, syncedAtMs: nowMs };
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
