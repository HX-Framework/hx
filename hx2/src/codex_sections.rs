//! Codex Desktop's sidebar sections (src/codex-sections.ts).
//!
//! The sidebar draws its sections from `<codexHome>/.codex-global-state.json`
//! (`electron-persisted-atom-state` → `sidebar-custom-sections-v3`, one entry
//! per ChatGPT account: the sections, their order, the collapsed state, and
//! threads or whole projects placed in each). Codex's app-server keeps a copy
//! in `state_<N>.sqlite`, which is read for what only it holds: which threads
//! the sidebar lists at all, the built-in Pinned list, each thread's cwd and
//! recency, and the sections themselves when no saved sidebar names the
//! account. A thread id is the rollout's session_meta id, the sessionId the
//! session is uploaded under.
//!
//! The sections ride in the group mirror upload as its `codex` field
//! (mirror.rs sync_group_mirror). A file that exists but cannot be read fails
//! the whole read, and the upload then leaves `codex` out, so the server keeps
//! the last sections it had: an upload is the device's whole set.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::codex_titles::state_db_path;
use crate::fsutil::{join, now_ms, stat_safe};
use crate::js::{eq_str, js, lossy, starts_with, trim, JsStr};
use crate::json::{obj, Json, OMap};

pub const CODEX_GLOBAL_STATE: &str = ".codex-global-state.json";
/// The fixed id of the app-server's built-in Pinned list (codex-rs).
pub const CODEX_PINNED_SECTION_ID: &str = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const THREAD_ITEM: &str = "codex:thread:local:";
const PROJECT_ITEM: &str = "codex:project:";

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSection {
    pub id: JsStr,
    pub name: JsStr,
    pub collapsed: bool,
    pub session_ids: Vec<JsStr>,
}

impl CodexSection {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("id", Json::Str(self.id.clone())),
            ("name", Json::Str(self.name.clone())),
            ("collapsed", Json::Bool(self.collapsed)),
            ("sessionIds", Json::Arr(self.session_ids.iter().map(|s| Json::Str(s.clone())).collect())),
            // Codex draws a section with no thread in it.
            ("showEmpty", Json::Bool(true)),
        ])
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    Saved,
    Database,
    None,
}

fn strings(v: Option<&Json>) -> Vec<JsStr> {
    match v.and_then(|v| v.as_arr()) {
        Some(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_vec())).collect(),
        None => Vec::new(),
    }
}

// ── The app-server database ─────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct DbThread {
    /// Listed in Codex's sidebar: not archived, with a preview, started from
    /// the CLI or the desktop app, and not an ambient suggestion.
    pub visible: bool,
    pub cwd: Option<String>,
    pub recency_ms: f64,
}

#[derive(Clone, Debug, Default)]
pub struct CodexDbRead {
    pub threads: HashMap<JsStr, DbThread>,
    /// The app-server's sections, oldest first, without the built-in Pinned list.
    pub sections: Vec<(JsStr, JsStr)>,
    /// Thread ids per section id, in Codex's order, listed or not.
    pub members: HashMap<JsStr, Vec<JsStr>>,
}

/// A SQLite URI that opens `p` read-only and ignores any WAL.
pub fn immutable_db_uri(p: &str) -> String {
    let mut u = p.replace('\\', "/");
    let b = u.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/' {
        u = format!("/{}", u);
    }
    let u = u.replace('%', "%25").replace('?', "%3f").replace('#', "%23");
    format!("file:{}?immutable=1", u)
}

/// Codex's app-server closes the database when idle, and the last close
/// deletes the -wal and -shm files; a read-only connection cannot open a WAL
/// database in that state, so with no -wal file the database is opened
/// immutable (everything is in the main file then).
fn open_state_db(db_path: &str) -> rusqlite::Result<Connection> {
    if Path::new(&format!("{}-wal", db_path)).exists() {
        return Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX);
    }
    Connection::open_with_flags(
        immutable_db_uri(db_path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// `Number(value)` for a column value the way bun:sqlite hands it over.
fn js_number(v: ValueRef<'_>) -> f64 {
    match v {
        ValueRef::Null => 0.0,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => f,
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t);
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        ValueRef::Blob(_) => f64::NAN,
    }
}

fn text_is(v: ValueRef<'_>, lit: &str) -> bool {
    matches!(v, ValueRef::Text(t) if t == lit.as_bytes())
}

fn text_of(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

/// Everything the sections need from the database; Err when it cannot be read.
pub fn read_codex_state_db(db_path: &str) -> Result<CodexDbRead, String> {
    let mut out = CodexDbRead::default();
    let conn = open_state_db(db_path).map_err(|e| e.to_string())?;
    let names = |sql: &str, col: usize| -> Result<HashSet<String>, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut set = HashSet::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if let Some(n) = row.get_ref(col).ok().and_then(text_of) {
                set.insert(n);
            }
        }
        Ok(set)
    };
    let tables = names("SELECT name FROM sqlite_master WHERE type = 'table'", 0)?;
    if !tables.contains("threads") {
        return Ok(out);
    }
    // Older schemas lack the newer columns: ask for what this one has.
    let cols = names("PRAGMA table_info(threads)", 1)?;
    let col = |name: &str, fallback: &str| -> String {
        if cols.contains(name) {
            name.to_string()
        } else {
            fallback.to_string()
        }
    };
    let recency = if cols.contains("recency_at_ms") { "recency_at_ms".to_string() } else { col("updated_at_ms", "0") };
    let previewed = if cols.contains("preview") { "preview <> ''".to_string() } else { "1".to_string() };
    let sql = format!(
        "SELECT id, {} AS archived, {} AS source, {} AS previewed, {} AS threadSource, {} AS cwd, {} AS recency FROM threads",
        col("archived", "0"),
        col("source", "'cli'"),
        previewed,
        col("thread_source", "NULL"),
        col("cwd", "NULL"),
        recency
    );
    {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id = match row.get_ref(0).ok().and_then(text_of) {
                Some(id) => id,
                None => continue,
            };
            let get = |i: usize| row.get_ref(i).unwrap_or(ValueRef::Null);
            let visible = js_number(get(1)) == 0.0
                && js_number(get(3)) != 0.0
                && (text_is(get(2), "cli") || text_is(get(2), "vscode"))
                && !text_is(get(4), "ambient_suggestions");
            let recency_ms = match get(6) {
                ValueRef::Integer(i) => i as f64,
                ValueRef::Real(f) if f.is_finite() => f,
                _ => 0.0,
            };
            out.threads.insert(js(&id), DbThread { visible, cwd: text_of(get(5)), recency_ms });
        }
    }
    if cols.contains("thread_section_id") {
        // Codex lists a section's threads by section_position, then id.
        let sql = format!(
            "SELECT id, thread_section_id AS section FROM threads WHERE thread_section_id IS NOT NULL ORDER BY thread_section_id, {}, id",
            col("section_position", "NULL")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id = row.get_ref(0).ok().and_then(text_of);
            let section = row.get_ref(1).ok().and_then(text_of);
            if let (Some(id), Some(section)) = (id, section) {
                out.members.entry(js(&section)).or_default().push(js(&id));
            }
        }
    }
    if tables.contains("thread_sections") {
        let mut stmt = conn.prepare("SELECT id, name FROM thread_sections ORDER BY rowid").map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id = row.get_ref(0).ok().and_then(text_of);
            let name = row.get_ref(1).ok().and_then(text_of);
            if let (Some(id), Some(name)) = (id, name) {
                if id != CODEX_PINNED_SECTION_ID {
                    out.sections.push((js(&id), js(&name)));
                }
            }
        }
    }
    Ok(out)
}

// ── Which account's sections ────────────────────────────────────────────────

enum Account {
    Named(String),
    /// Named by Codex's own state, but with no entry: no sections.
    Missing,
    Unknown,
}

/// environment-catalog-cache-v1.accountId, then the one key of the
/// chatgpt-sidebar-state-v1 atom, then the only entry. A named account with
/// no entry never borrows another account's.
fn pick_account(gs: &Json, atoms: &Json, entries: &OMap) -> Account {
    let named = gs.get("environment-catalog-cache-v1").filter(|c| c.as_obj().is_some()).and_then(|c| c.get("accountId")).and_then(|a| a.as_str());
    if let Some(named) = named {
        if !named.is_empty() {
            let k = lossy(named);
            return if entries.contains(&k) { Account::Named(k) } else { Account::Missing };
        }
    }
    if let Some(sidebar) = atoms.get("chatgpt-sidebar-state-v1").and_then(|s| s.as_obj()) {
        let keys = sidebar.keys();
        if keys.len() == 1 {
            return if entries.contains(&keys[0]) { Account::Named(keys[0].clone()) } else { Account::Missing };
        }
    }
    let all = entries.keys();
    if all.len() == 1 {
        Account::Named(all[0].clone())
    } else {
        Account::Unknown
    }
}

// ── Projects placed in a section ────────────────────────────────────────────

fn norm_dir(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// A thread assigned to a project belongs to it; a projectless thread to
/// none; any other thread to the local project whose root holds its cwd, the
/// deepest root winning.
fn project_of(tid: &[u16], cwd: Option<&str>, assignments: Option<&OMap>, projectless: &HashSet<JsStr>, roots: &[(String, String)]) -> Option<String> {
    if let Some(a) = assignments.and_then(|m| m.get(&lossy(tid))) {
        if a.as_obj().is_some() {
            if let Some(p) = a.get("projectId").and_then(|p| p.as_str()) {
                return Some(lossy(p));
            }
        }
    }
    if projectless.contains(tid) {
        return None;
    }
    let cwd = match cwd {
        Some(c) if !c.is_empty() => c,
        _ => return None,
    };
    let dir = norm_dir(cwd);
    let mut best: Option<(&str, usize)> = None;
    for (id, root) in roots {
        let under = dir == *root || dir.starts_with(&format!("{}/", root));
        if under && best.map(|(_, len)| root.len() > len).unwrap_or(true) {
            best = Some((id.as_str(), root.len()));
        }
    }
    best.map(|(id, _)| id.to_string())
}

fn local_project_roots(gs: &Json) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(projects) = gs.get("local-projects").and_then(|p| p.as_obj()) {
        for (key, p) in projects.iter() {
            if p.as_obj().is_none() {
                continue;
            }
            let id = p.get("id").and_then(|v| v.as_string()).unwrap_or_else(|| key.clone());
            for root in strings(p.get("rootPaths")) {
                let r = norm_dir(&lossy(&root));
                if !r.is_empty() {
                    out.push((id.clone(), r));
                }
            }
        }
    }
    out
}

struct Ctx<'a> {
    gs: &'a Json,
    atoms: &'a Json,
    db: Option<&'a CodexDbRead>,
    projects: Option<HashMap<String, Vec<JsStr>>>,
}

/// Every project's threads, worked out once per read: with a database its
/// threads are the candidates; without one, the assigned threads.
fn index_projects(gs: &Json, db: Option<&CodexDbRead>) -> HashMap<String, Vec<JsStr>> {
    let roots = local_project_roots(gs);
    let assignments = gs.get("thread-project-assignments").and_then(|a| a.as_obj());
    let projectless: HashSet<JsStr> = strings(gs.get("projectless-thread-ids")).into_iter().collect();
    let candidates: Vec<JsStr> = match db {
        Some(db) => db.threads.keys().cloned().collect(),
        None => assignments.map(|a| a.keys().iter().map(|k| js(k)).collect()).unwrap_or_default(),
    };
    let mut by_project: HashMap<String, Vec<JsStr>> = HashMap::new();
    for tid in candidates {
        let cwd = db.and_then(|d| d.threads.get(&tid)).and_then(|t| t.cwd.as_deref());
        if let Some(pid) = project_of(&tid, cwd, assignments, &projectless, &roots) {
            by_project.entry(pid).or_default().push(tid);
        }
    }
    by_project
}

/// `value ?? fallback`: a missing key and a JSON null both fall through.
fn present(v: Option<&Json>) -> Option<&Json> {
    v.filter(|x| !x.is_null())
}

/// The project's threads in Codex's order: with the manual sort the threads
/// missing from the saved order first, newest first, then the saved order;
/// otherwise newest first.
fn project_threads(pid: &str, ctx: &mut Ctx) -> Vec<JsStr> {
    if ctx.projects.is_none() {
        ctx.projects = Some(index_projects(ctx.gs, ctx.db));
    }
    let members: Vec<JsStr> = ctx.projects.as_ref().and_then(|p| p.get(pid)).cloned().unwrap_or_default();
    let recency = |tid: &JsStr| ctx.db.and_then(|d| d.threads.get(tid)).map(|t| t.recency_ms).unwrap_or(0.0);
    let sort_mode = present(ctx.atoms.get("codex-sidebar-sort-mode-v1"))
        .or_else(|| present(ctx.atoms.get("flat-project-sidebar-preferences-v1").filter(|p| p.as_obj().is_some()).and_then(|p| p.get("projectSortMode"))));
    let manual = match sort_mode {
        Some(v) => v.as_str().map(|s| eq_str(s, "manual")).unwrap_or(false),
        None => true,
    };
    let saved = if manual {
        ctx.gs
            .get("sidebar-project-thread-orders")
            .filter(|o| o.as_obj().is_some())
            .and_then(|o| o.get(pid))
            .filter(|o| o.as_obj().is_some())
            .map(|o| strings(o.get("threadIds")))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let member_set: HashSet<&JsStr> = members.iter().collect();
    let mut saved_members: Vec<JsStr> = Vec::new();
    for tid in saved {
        if member_set.contains(&tid) && !saved_members.contains(&tid) {
            saved_members.push(tid);
        }
    }
    let saved_set: HashSet<JsStr> = saved_members.iter().cloned().collect();
    let mut unsaved: Vec<JsStr> = members.into_iter().filter(|t| !saved_set.contains(t)).collect();
    unsaved.sort_by(|a, b| {
        let (ra, rb) = (recency(a), recency(b));
        rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.cmp(a))
    });
    unsaved.extend(saved_members);
    unsaved
}

/// Codex's Pinned list: the app-server's pinned section, then threads an
/// older Codex pinned that the app-server has not taken over, then each
/// pinned project's threads.
fn pinned_threads(ctx: &mut Ctx) -> Vec<JsStr> {
    let mut out: Vec<JsStr> = ctx.db.and_then(|d| d.members.get(&js(CODEX_PINNED_SECTION_ID))).cloned().unwrap_or_default();
    let mut migrated: HashSet<JsStr> = HashSet::new();
    if let Some(by_host) = ctx.gs.get("app-server-migrated-pinned-thread-ids-by-host").and_then(|m| m.as_obj()) {
        for (_, ids) in by_host.iter() {
            migrated.extend(strings(Some(ids)));
        }
    }
    for tid in strings(ctx.gs.get("pinned-thread-ids")) {
        if !migrated.contains(&tid) && !out.contains(&tid) {
            out.push(tid);
        }
    }
    for pid in strings(ctx.gs.get("pinned-project-ids")) {
        let threads = project_threads(&lossy(&pid), ctx);
        out.extend(threads);
    }
    out
}

struct Assembly<'a> {
    ctx: Ctx<'a>,
    groups: Vec<CodexSection>,
    claimed: HashSet<JsStr>,
}

impl Assembly<'_> {
    /// A thread shows once: the first section in sidebar order keeps it. With
    /// a database, a thread it does not list (deleted) or does not show is
    /// left out; without one, every named thread is kept.
    fn take(&mut self, ids: Vec<JsStr>) -> Vec<JsStr> {
        let mut out = Vec::new();
        for tid in ids {
            let hidden = match self.ctx.db {
                Some(db) => db.threads.get(&tid).map(|t| t.visible) != Some(true),
                None => false,
            };
            if hidden || self.claimed.contains(&tid) {
                continue;
            }
            self.claimed.insert(tid.clone());
            out.push(tid);
        }
        out
    }

    fn pinned(&mut self) {
        let ids = pinned_threads(&mut self.ctx);
        let ids = self.take(ids);
        if !ids.is_empty() {
            self.groups.push(CodexSection { id: js("pinned"), name: js("Pinned"), collapsed: false, session_ids: ids });
        }
    }
}

/// Codex's sections from the parsed global state (None when the file is
/// absent) and the database read (None when there is no database).
pub fn assemble_codex_sections(gs: Option<&Json>, db: Option<&CodexDbRead>) -> (Vec<CodexSection>, Source) {
    let empty = Json::obj();
    let gs_ref = gs.unwrap_or(&empty);
    let atoms = gs_ref.get("electron-persisted-atom-state").filter(|a| a.as_obj().is_some()).unwrap_or(&empty);
    let entries = atoms.get("sidebar-custom-sections-v3").and_then(|e| e.as_obj());
    let account = match (gs, entries) {
        (Some(g), Some(e)) => pick_account(g, atoms, e),
        _ => Account::Unknown,
    };
    let entry = match (&account, entries) {
        (Account::Named(k), Some(e)) => e.get(k),
        _ => None,
    };
    let mut a = Assembly { ctx: Ctx { gs: gs_ref, atoms, db, projects: None }, groups: Vec::new(), claimed: HashSet::new() };

    if let Some(entry) = entry.filter(|e| e.as_obj().is_some()) {
        if let Some(all) = entry.get("sections").and_then(|s| s.as_arr()) {
            let sections: Vec<&Json> = all
                .iter()
                .filter(|s| {
                    s.as_obj().is_some()
                        && s.get("id").and_then(|i| i.as_str()).map(|i| !i.is_empty()).unwrap_or(false)
                        && s.get("name").and_then(|n| n.as_str()).map(|n| !trim(n).is_empty()).unwrap_or(false)
                })
                .collect();
            let mut by_id: HashMap<JsStr, &Json> = HashMap::new();
            for s in sections.iter().copied() {
                by_id.insert(s.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_vec(), s);
            }
            let collapsed: HashSet<JsStr> = strings(entry.get("collapsedSectionIds")).into_iter().collect();
            let order = strings(entry.get("sectionOrder"));
            let mut emitted: HashSet<JsStr> = HashSet::new();
            let mut section = |a: &mut Assembly, s: &Json| {
                let id = s.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_vec();
                if !emitted.insert(id.clone()) {
                    return;
                }
                let mut ids: Vec<JsStr> = Vec::new();
                for key in strings(s.get("itemKeys")) {
                    if starts_with(&key, THREAD_ITEM) {
                        ids.push(key[THREAD_ITEM.len()..].to_vec());
                    } else if starts_with(&key, PROJECT_ITEM) {
                        let pid = lossy(&key[PROJECT_ITEM.len()..]);
                        ids.extend(project_threads(&pid, &mut a.ctx));
                    }
                }
                let name = s.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_vec();
                let is_collapsed = collapsed.contains(&id);
                let session_ids = a.take(ids);
                a.groups.push(CodexSection { id, name, collapsed: is_collapsed, session_ids });
            };
            // Codex puts Pinned first when the saved order does not place it.
            let mut pinned_done = !order.iter().any(|k| eq_str(k, "pinned"));
            if pinned_done {
                a.pinned();
            }
            for key in &order {
                if eq_str(key, "pinned") && !pinned_done {
                    pinned_done = true;
                    a.pinned();
                } else if starts_with(key, "custom:") {
                    if let Some(s) = by_id.get(&key["custom:".len()..]).copied() {
                        section(&mut a, s);
                    }
                }
            }
            for s in sections.iter().copied() {
                section(&mut a, s);
            }
            return (a.groups, Source::Saved);
        }
    }

    if let (Account::Unknown, Some(db)) = (&account, db) {
        if !db.sections.is_empty() {
            // No saved sidebar to go by: the app-server's sections, oldest first.
            a.pinned();
            for (id, name) in &db.sections {
                let ids = db.members.get(id).cloned().unwrap_or_default();
                let session_ids = a.take(ids);
                a.groups.push(CodexSection { id: id.clone(), name: name.clone(), collapsed: false, session_ids });
            }
            return (a.groups, Source::Database);
        }
    }

    a.pinned();
    (a.groups, Source::None)
}

// ── Reading a Codex home, cached on the files' stats ─────────────────────────

fn stat_part(p: &str) -> String {
    match stat_safe(Path::new(p)) {
        Some(s) => format!("{}:{}", s.size, s.mtime_ms.trunc() as i64),
        None => "-".to_string(),
    }
}

/// The parts of the global state the sections read; prompt history, drafts
/// and window state are not kept between reads.
const KEPT_KEYS: [&str; 8] = [
    "environment-catalog-cache-v1",
    "thread-project-assignments",
    "projectless-thread-ids",
    "local-projects",
    "sidebar-project-thread-orders",
    "pinned-thread-ids",
    "pinned-project-ids",
    "app-server-migrated-pinned-thread-ids-by-host",
];
const KEPT_ATOMS: [&str; 4] = [
    "sidebar-custom-sections-v3",
    "chatgpt-sidebar-state-v1",
    "flat-project-sidebar-preferences-v1",
    "codex-sidebar-sort-mode-v1",
];

fn keep(from: &OMap, keys: &[&str]) -> OMap {
    let mut out = OMap::new();
    for k in keys {
        if let Some(v) = from.get(k) {
            out.set(k, v.clone());
        }
    }
    out
}

/// The global state's sidebar keys; Ok(None) when the file is absent.
fn read_global_state(p: &str) -> Result<Option<Json>, String> {
    if !Path::new(p).exists() {
        return Ok(None);
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let parsed = Json::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| "not JSON".to_string())?;
    let o = parsed.as_obj().ok_or_else(|| "not a JSON object".to_string())?;
    let mut out = keep(o, &KEPT_KEYS);
    if let Some(atoms) = o.get("electron-persisted-atom-state").and_then(|a| a.as_obj()) {
        out.set("electron-persisted-atom-state", Json::Obj(keep(atoms, &KEPT_ATOMS)));
    }
    Ok(Some(Json::Obj(out)))
}

struct HomeRead {
    gs_fp: String,
    gs: Option<Json>,
    db_fp: String,
    db: Option<CodexDbRead>,
    groups: Vec<CodexSection>,
}

fn cache() -> &'static Mutex<HashMap<String, HomeRead>> {
    static CACHE: OnceLock<Mutex<HashMap<String, HomeRead>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One Codex home's sections and whether the home holds either file, or None
/// when a file there could not be read. A file whose stats have not moved
/// since the last read is not read again.
pub fn read_codex_home_sections(codex_home: &str) -> Option<(Vec<CodexSection>, bool)> {
    let gs_path = join(codex_home, CODEX_GLOBAL_STATE);
    let gs_fp = stat_part(&gs_path);
    let db_path = state_db_path(codex_home);
    let db_fp = match &db_path {
        Some(p) => format!("{}|{}|{}", p, stat_part(p), stat_part(&format!("{}-wal", p))),
        None => "-".to_string(),
    };
    let present = gs_fp != "-" || db_path.is_some();
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    let hit = c.remove(codex_home);
    if let Some(h) = &hit {
        if h.gs_fp == gs_fp && h.db_fp == db_fp {
            let groups = h.groups.clone();
            c.insert(codex_home.to_string(), hit.expect("matched above"));
            return Some((groups, present));
        }
    }
    let (old_gs, old_db) = match hit {
        Some(h) => (if h.gs_fp == gs_fp { Some(h.gs) } else { None }, if h.db_fp == db_fp { Some(h.db) } else { None }),
        None => (None, None),
    };
    let gs = match old_gs {
        Some(gs) => gs,
        None => read_global_state(&gs_path).ok()?,
    };
    let db = match old_db {
        Some(db) => db,
        None => match &db_path {
            Some(p) => Some(read_codex_state_db(p).ok()?),
            None => None,
        },
    };
    let (groups, _) = assemble_codex_sections(gs.as_ref(), db.as_ref());
    c.insert(codex_home.to_string(), HomeRead { gs_fp, gs, db_fp, db, groups: groups.clone() });
    Some((groups, present))
}

/// What the group mirror's `codex` carries, across the Codex homes hx reads
/// in home order: Err when a home could not be read (the upload leaves
/// `codex` out and the server keeps the last sections it had), Ok(None) when
/// no home holds Codex's state (null), else the sections.
pub fn build_codex_sections(codex_homes: &[String]) -> Result<Option<Vec<CodexSection>>, ()> {
    let mut groups: Vec<CodexSection> = Vec::new();
    let mut seen: HashSet<JsStr> = HashSet::new();
    let mut present = false;
    for home in codex_homes {
        let (read, here) = read_codex_home_sections(home).ok_or(())?;
        present |= here;
        for g in read {
            if seen.insert(g.id.clone()) {
                groups.push(g);
            }
        }
    }
    Ok(if present { Some(groups) } else { None })
}

/// The `codex` value of the group mirror for a read: None leaves the key out.
pub fn codex_mirror_value(read: &Result<Option<Vec<CodexSection>>, ()>) -> Option<Json> {
    match read {
        Err(()) => None,
        Ok(None) => Some(Json::Null),
        Ok(Some(groups)) => Some(obj(vec![("groups", Json::Arr(groups.iter().map(|g| g.to_json()).collect()))])),
    }
}

// ── Watching for changes ────────────────────────────────────────────────────

/// The files a sidebar change lands in: the global state file (Codex writes
/// it to a temp file and renames it, so any name holding the file's name
/// counts) and the state database and its -wal.
pub fn is_codex_sidebar_file(name: &str) -> bool {
    if name.contains(CODEX_GLOBAL_STATE) {
        return true;
    }
    let rest = match name.strip_prefix("state_") {
        Some(r) => r,
        None => return false,
    };
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    digits > 0 && matches!(&rest[digits..], ".sqlite" | ".sqlite-wal")
}

const DEBOUNCE_MS: f64 = 150.0;
const MAX_WAIT_MS: f64 = 1_000.0;

/// A watch on each Codex home, not recursive. An event on a sidebar file marks
/// a burst and wakes the daemon's loop, which syncs once the burst is due:
/// `DEBOUNCE_MS` after the last event and never later than `MAX_WAIT_MS` after
/// the first (watchCodexSidebar in codex-sections.ts).
pub struct CodexSidebarWatch {
    _watcher: Option<RecommendedWatcher>,
    burst: Arc<Mutex<Option<(f64, f64)>>>,
}

impl CodexSidebarWatch {
    /// A home that does not exist is skipped. A home that cannot be watched,
    /// or a watch that fails later, is reported through `on_failure`, and the
    /// daemon's 20 s timer keeps the sections current.
    pub fn arm(homes: &[String], wake: Arc<dyn Fn() + Send + Sync>, on_failure: Arc<dyn Fn(String) + Send + Sync>) -> CodexSidebarWatch {
        let burst: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (mark, failed_cb, failure_cb) = (burst.clone(), failed.clone(), on_failure.clone());
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let ev = match res {
                Ok(ev) => ev,
                Err(e) => {
                    if !failed_cb.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        failure_cb(e.to_string());
                    }
                    return;
                }
            };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let relevant = ev.paths.is_empty()
                || ev.paths.iter().any(|p| p.file_name().map(|n| is_codex_sidebar_file(&n.to_string_lossy())).unwrap_or(true));
            if !relevant {
                return;
            }
            let now = now_ms();
            {
                let mut b = mark.lock().unwrap_or_else(|e| e.into_inner());
                *b = match *b {
                    None => Some((now, now)),
                    Some((first, _)) if now - first >= MAX_WAIT_MS => *b,
                    Some((first, _)) => Some((first, now)),
                };
            }
            wake();
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                on_failure(format!("watcher: {}", e));
                return CodexSidebarWatch { _watcher: None, burst };
            }
        };
        for home in homes {
            if !Path::new(home).exists() {
                continue;
            }
            if let Err(e) = watcher.watch(Path::new(home), RecursiveMode::NonRecursive) {
                on_failure(format!("{}: {}", home, e));
            }
        }
        CodexSidebarWatch { _watcher: Some(watcher), burst }
    }

    /// When the current burst is due, or None when there is none.
    pub fn due_at(&self) -> Option<f64> {
        let b = self.burst.lock().unwrap_or_else(|e| e.into_inner());
        b.map(|(first, last)| (last + DEBOUNCE_MS).min(first + MAX_WAIT_MS))
    }

    /// Take the burst when it is due: the caller syncs now, and a change during
    /// that sync starts the next burst.
    pub fn take_due(&self, now: f64) -> bool {
        let mut b = self.burst.lock().unwrap_or_else(|e| e.into_inner());
        let due = match *b {
            Some((first, last)) => now >= (last + DEBOUNCE_MS).min(first + MAX_WAIT_MS),
            None => false,
        };
        if due {
            *b = None;
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("hx2-codex-sections-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn t(n: u32) -> String {
        format!("0000000{}-0000-7000-8000-000000000000", n)
    }

    struct Row<'a> {
        id: String,
        archived: i64,
        source: &'a str,
        preview: &'a str,
        thread_source: &'a str,
        cwd: &'a str,
        recency: i64,
        section: Option<&'a str>,
        position: Option<i64>,
    }

    fn row<'a>(id: String) -> Row<'a> {
        Row { id, archived: 0, source: "vscode", preview: "a preview", thread_source: "user", cwd: "/work/elsewhere", recency: 0, section: None, position: None }
    }

    fn make_db(home: &str, rows: &[Row], sections: &[(&str, &str)]) -> String {
        let p = join(home, "state_5.sqlite");
        let conn = Connection::open(&p).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', thread_source TEXT, cwd TEXT NOT NULL DEFAULT '', recency_at_ms INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT, section_position INTEGER);
             CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance TEXT);",
        )
        .unwrap();
        for (id, name) in sections {
            conn.execute("INSERT INTO thread_sections (id, name) VALUES (?1, ?2)", rusqlite::params![id, name]).unwrap();
        }
        for r in rows {
            conn.execute(
                "INSERT INTO threads (id, archived, source, preview, thread_source, cwd, recency_at_ms, thread_section_id, section_position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![r.id, r.archived, r.source, r.preview, r.thread_source, r.cwd, r.recency, r.section, r.position],
            )
            .unwrap();
        }
        p
    }

    fn write_state(home: &str, json: &str) {
        fs::write(join(home, CODEX_GLOBAL_STATE), json).unwrap();
    }

    fn ids(v: &[&str]) -> Vec<JsStr> {
        v.iter().map(|s| js(s)).collect()
    }

    fn summary(groups: &[CodexSection]) -> Vec<(String, bool, Vec<String>)> {
        groups.iter().map(|g| (lossy(&g.name), g.collapsed, g.session_ids.iter().map(|s| lossy(s)).collect())).collect()
    }

    #[test]
    fn names_the_sidebar_files() {
        for n in [".codex-global-state.json", "..codex-global-state.json.tmp-1-abc", ".codex-global-state.json.bak", "state_5.sqlite", "state_12.sqlite-wal"] {
            assert!(is_codex_sidebar_file(n), "{}", n);
        }
        for n in ["logs_2.sqlite-wal", "state_5.sqlite-shm", "state_.sqlite", "sessions", "goals_1.sqlite"] {
            assert!(!is_codex_sidebar_file(n), "{}", n);
        }
    }

    #[test]
    fn builds_the_immutable_uri() {
        assert_eq!(immutable_db_uri("/a b/c%d?e#f.sqlite"), "file:/a b/c%25d%3fe%23f.sqlite?immutable=1");
        assert_eq!(immutable_db_uri("C:\\Users\\x\\.codex\\state_5.sqlite"), "file:/C:/Users/x/.codex/state_5.sqlite?immutable=1");
    }

    /// The harness fixture's shape: order, Pinned, visibility, a project
    /// placed in a collapsed section, an empty section, another account.
    #[test]
    fn reads_the_saved_sidebar_like_the_typescript_client() {
        let h = home("saved");
        let (c1, c2, c3, c4) = (t(1), t(2), t(3), t(4));
        let (listed, archived, subagent, under, pinned, old_pin) = (t(5), t(6), t(7), t(8), t(9), t(10));
        make_db(
            &h,
            &[
                Row { recency: 0, cwd: "/work/repo", section: Some("db-review"), position: Some(1000), ..row(c1.clone()) },
                Row { recency: 3_600_000, cwd: "/work/scratch", ..row(c2.clone()) },
                Row { archived: 1, recency: 3 * 3_600_000, cwd: "/work/repo", ..row(c4.clone()) },
                Row { recency: 9, cwd: "/work/scratch", section: Some("db-review"), position: Some(2000), ..row(listed.clone()) },
                Row { archived: 1, recency: 8, cwd: "/work/repo", section: Some("db-review"), position: Some(3000), ..row(archived.clone()) },
                Row { source: "{\"subagent\":{\"other\":\"guardian\"}}", thread_source: "guardian_review", recency: 10, cwd: "/work/repo", ..row(subagent.clone()) },
                Row { recency: 7 * 3_600_000, cwd: "/work/repo/packages/core", ..row(under.clone()) },
                Row { recency: 2, cwd: "/work/scratch", section: Some(CODEX_PINNED_SECTION_ID), position: Some(1000), ..row(pinned.clone()) },
                Row { recency: 1, cwd: "/work/scratch", ..row(old_pin.clone()) },
            ],
            &[(CODEX_PINNED_SECTION_ID, "Pinned"), ("db-review", "Review"), ("db-empty", "Empty")],
        );
        let item = |id: &str| format!("\"codex:thread:local:{}\"", id);
        let state = format!(
            r#"{{"environment-catalog-cache-v1":{{"accountId":"acct-fixture"}},"prompt-history":{{"entries":["x"]}},
            "local-projects":{{"local-repo":{{"id":"local-repo","name":"repo","rootPaths":["/work/repo/"]}},"local-scratch":{{"id":"local-scratch","name":"scratch","rootPaths":["/work/scratch"]}}}},
            "thread-project-assignments":{{"{c2}":{{"projectKind":"local","projectId":"local-repo"}}}},
            "projectless-thread-ids":[],
            "sidebar-project-thread-orders":{{"local-repo":{{"threadIds":["{c2}","{subagent}"]}}}},
            "pinned-thread-ids":["{old_pin}","{pinned}"],
            "app-server-migrated-pinned-thread-ids-by-host":{{"local:h":["{pinned}"]}},
            "pinned-project-ids":[],
            "electron-persisted-atom-state":{{"sidebar-custom-sections-v3":{{
              "acct-fixture":{{"sections":[
                {{"id":"sec-review","name":"Review","itemKeys":[{i1},{i5},{i6},{i7},{i3}]}},
                {{"id":"sec-old","name":"Old work","itemKeys":["codex:project:local-repo"]}},
                {{"id":"sec-empty","name":"Empty","itemKeys":[]}}],
                "collapsedSectionIds":["sec-old"],
                "sectionOrder":["custom:sec-review","agents","pinned","custom:sec-old","custom:sec-empty","threads","chats"]}},
              "acct-other":{{"sections":[{{"id":"sec-other","name":"Another account","itemKeys":[{i2}]}}],"collapsedSectionIds":[],"sectionOrder":[]}}}},
              "flat-project-sidebar-preferences-v1":{{"projectSortMode":"manual"}}}}}}"#,
            c2 = c2,
            subagent = subagent,
            old_pin = old_pin,
            pinned = pinned,
            i1 = item(&c1),
            i2 = item(&c2),
            i3 = item(&c3),
            i5 = item(&listed),
            i6 = item(&archived),
            i7 = item(&subagent),
        );
        write_state(&h, &state);
        let read = build_codex_sections(&[h.clone()]);
        let groups = read.clone().expect("the read succeeds").expect("a Codex home");
        assert_eq!(
            summary(&groups),
            vec![
                ("Review".to_string(), false, vec![c1.clone(), listed.clone()]),
                ("Pinned".to_string(), false, vec![pinned.clone(), old_pin.clone()]),
                ("Old work".to_string(), true, vec![under.clone(), c2.clone()]),
                ("Empty".to_string(), false, vec![]),
            ]
        );
        assert_eq!(groups.iter().map(|g| lossy(&g.id)).collect::<Vec<_>>(), vec!["sec-review", "pinned", "sec-old", "sec-empty"]);
        assert_eq!(
            codex_mirror_value(&read).expect("a value").stringify(),
            format!(
                "{{\"groups\":[{{\"id\":\"sec-review\",\"name\":\"Review\",\"collapsed\":false,\"sessionIds\":[\"{}\",\"{}\"],\"showEmpty\":true}},{{\"id\":\"pinned\",\"name\":\"Pinned\",\"collapsed\":false,\"sessionIds\":[\"{}\",\"{}\"],\"showEmpty\":true}},{{\"id\":\"sec-old\",\"name\":\"Old work\",\"collapsed\":true,\"sessionIds\":[\"{}\",\"{}\"],\"showEmpty\":true}},{{\"id\":\"sec-empty\",\"name\":\"Empty\",\"collapsed\":false,\"sessionIds\":[],\"showEmpty\":true}}]}}",
                c1, listed, pinned, old_pin, under, c2
            )
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn a_named_account_without_an_entry_has_no_sections() {
        let h = home("named");
        make_db(&h, &[], &[]);
        write_state(&h, r#"{"environment-catalog-cache-v1":{"accountId":"new"},"electron-persisted-atom-state":{"sidebar-custom-sections-v3":{"old":{"sections":[{"id":"a","name":"Old","itemKeys":[]}],"collapsedSectionIds":[],"sectionOrder":[]}}}}"#);
        assert!(build_codex_sections(&[h.clone()]).expect("read").expect("a Codex home").is_empty());
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn several_accounts_and_no_name_use_the_database_sections() {
        let h = home("db");
        make_db(
            &h,
            &[
                Row { section: Some("s2"), position: Some(2000), ..row(t(1)) },
                Row { section: Some("s2"), position: Some(1000), ..row(t(2)) },
                Row { archived: 1, section: Some("s1"), position: Some(1000), ..row(t(3)) },
            ],
            &[(CODEX_PINNED_SECTION_ID, "Pinned"), ("s1", "First"), ("s2", "Second")],
        );
        let entry = r#"{"sections":[{"id":"a","name":"Mine","itemKeys":[]}],"collapsedSectionIds":[],"sectionOrder":[]}"#;
        write_state(&h, &format!(r#"{{"electron-persisted-atom-state":{{"sidebar-custom-sections-v3":{{"one":{},"two":{}}}}}}}"#, entry, entry));
        let groups = build_codex_sections(&[h.clone()]).expect("read").expect("a Codex home");
        assert_eq!(summary(&groups), vec![("First".to_string(), false, vec![]), ("Second".to_string(), false, vec![t(2), t(1)])]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn reads_a_wal_database_whose_wal_is_gone() {
        let h = home("wal");
        let p = make_db(&h, &[Row { section: Some("s1"), position: Some(1), ..row(t(1)) }], &[("s1", "From the main file")]);
        {
            let conn = Connection::open(&p).unwrap();
            let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
            conn.execute("INSERT INTO thread_sections (id, name) VALUES ('s2', 'Checkpointed')", []).unwrap();
            let _: (i64, i64, i64) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        }
        for f in [format!("{}-wal", p), format!("{}-shm", p)] {
            let _ = fs::remove_file(f);
        }
        let read = read_codex_state_db(&p).expect("immutable open");
        assert_eq!(read.sections, vec![(js("s1"), js("From the main file")), (js("s2"), js("Checkpointed"))]);
        assert_eq!(read.members.get(&js("s1")), Some(&ids(&[t(1).as_str()])));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn a_torn_global_state_leaves_codex_out_and_no_codex_home_is_null() {
        let h = home("torn");
        write_state(&h, "{ torn");
        let read = build_codex_sections(&[h.clone()]);
        assert!(read.is_err());
        assert!(codex_mirror_value(&read).is_none());
        fs::remove_file(join(&h, CODEX_GLOBAL_STATE)).unwrap();
        let read = build_codex_sections(&[h.clone()]);
        assert!(matches!(read, Ok(None)));
        assert_eq!(codex_mirror_value(&read).expect("null").stringify(), "null");
        write_state(&h, r#"{"electron-persisted-atom-state":{}}"#);
        let read = build_codex_sections(&[h.clone()]);
        assert_eq!(codex_mirror_value(&read).expect("a value").stringify(), "{\"groups\":[]}");
        let _ = fs::remove_dir_all(&h);
    }
}
