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
//! Below the custom sections Codex draws its built-in ones: Pinned, then (in
//! its default "project" mode) Projects, a row per local project with its
//! threads, and Recents, the threads with no project. They are mirrored too,
//! as Codex's code (ChatGPT.app 26.924) builds them. A project row's group id
//! is `project:<project id>`, and its `sectionName` names the built-in section
//! it sits in ("Projects" or "Pinned").
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

use crate::codex_titles::{open_codex_state_db, state_db_path};
use crate::fsutil::{join, now_ms, stat_safe};
use crate::js::{concat, eq_str, js, lossy, starts_with, trim, JsStr};
use crate::json::{obj, Json, OMap};

pub const CODEX_GLOBAL_STATE: &str = ".codex-global-state.json";
/// The fixed id of the app-server's built-in Pinned list (codex-rs).
pub const CODEX_PINNED_SECTION_ID: &str = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const THREAD_ITEM: &str = "codex:thread:local:";
const PROJECT_ITEM: &str = "codex:project:";

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSection {
    /// Codex's section id; "pinned", "recents", or `project:<project id>`.
    pub id: JsStr,
    pub name: JsStr,
    /// Only on a project row: the built-in section it sits in.
    pub section_name: Option<JsStr>,
    pub collapsed: bool,
    pub session_ids: Vec<JsStr>,
}

impl CodexSection {
    pub fn to_json(&self) -> Json {
        let mut pairs = vec![("id", Json::Str(self.id.clone())), ("name", Json::Str(self.name.clone()))];
        if let Some(s) = &self.section_name {
            pairs.push(("sectionName", Json::Str(s.clone())));
        }
        pairs.push(("collapsed", Json::Bool(self.collapsed)));
        pairs.push(("sessionIds", Json::Arr(self.session_ids.iter().map(|s| Json::Str(s.clone())).collect())));
        // Codex draws a section with no thread in it.
        pairs.push(("showEmpty", Json::Bool(true)));
        obj(pairs)
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
    /// the CLI or the desktop app, not spawned by another thread, and neither
    /// an ambient suggestion nor a thread ChatGPT hides.
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
    let conn = open_codex_state_db(db_path).map_err(|e| e.to_string())?;
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
    // Codex lists top-level threads only.
    let spawned = if tables.contains("thread_spawn_edges") { names("SELECT child_thread_id FROM thread_spawn_edges", 0)? } else { HashSet::new() };
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
                && !text_is(get(4), "ambient_suggestions")
                && !text_is(get(4), "chatgpt_hidden")
                && !spawned.contains(&id);
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

// ── Projects ────────────────────────────────────────────────────────────────

/// A Codex project: an entry of `local-projects`, minus the single-root ones
/// kept under a `.chatgpt-projects` folder and the ones backed by a ChatGPT
/// project (the sidebar shows those as ChatGPT projects). The label is the
/// trimmed name, or the id.
struct LocalProject {
    id: JsStr,
    label: JsStr,
    roots: Vec<JsStr>,
    created_at: f64,
}

/// `path.posix.basename(path.posix.dirname(p))`, `\` read as `/`.
fn parent_folder_name(p: &[u16]) -> String {
    let p = lossy(p).replace('\\', "/");
    let p = p.trim_end_matches('/');
    match p.rfind('/') {
        None => ".".to_string(),
        Some(i) => {
            let dir = p[..i].trim_end_matches('/');
            match dir.rfind('/') {
                Some(j) => dir[j + 1..].to_string(),
                None => dir.to_string(),
            }
        }
    }
}

fn local_projects(gs: &Json) -> Vec<LocalProject> {
    let mut out = Vec::new();
    let projects = match gs.get("local-projects").and_then(|p| p.as_obj()) {
        Some(p) => p,
        None => return out,
    };
    for (key, p) in projects.iter() {
        if p.as_obj().is_none() || p.get("chatGptBacking").map(|b| b.truthy()).unwrap_or(false) {
            continue;
        }
        let id = match p.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_vec(),
            _ => js(key),
        };
        let roots = strings(p.get("rootPaths"));
        if roots.len() == 1 && parent_folder_name(&roots[0]) == ".chatgpt-projects" {
            continue;
        }
        let name = p.get("name").and_then(|v| v.as_str()).map(|s| trim(s).to_vec()).unwrap_or_default();
        let label = if name.is_empty() { id.clone() } else { name };
        out.push(LocalProject { id, label, roots, created_at: p.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0) });
    }
    out
}

/// Codex compares paths with `\` read as `/`, lowercased, and gives a thread
/// the project whose root EQUALS its cwd: a thread in a subfolder of a root is
/// not that project's.
fn path_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// Of two projects sharing a root: the single-root one, then the one whose
/// first root it is, then the older, then the larger id.
fn beats(a: &LocalProject, b: &LocalProject, key: &str) -> bool {
    let single = |p: &LocalProject| p.roots.len() == 1;
    if single(a) != single(b) {
        return single(a);
    }
    let first = |p: &LocalProject| p.roots.first().map(|r| path_key(&lossy(r)) == key).unwrap_or(false);
    if first(a) != first(b) {
        return first(a);
    }
    if a.created_at != b.created_at {
        return a.created_at < b.created_at;
    }
    a.id > b.id
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A dated folder under `Documents/Codex`, where Codex starts a thread with
/// no project: `…Documents/Codex/YYYY-MM-DD-slug` or
/// `…Documents/Codex/YYYY-MM-DD/slug` (src/codex-sections.ts PROJECTLESS_DIR).
fn is_projectless_dir(cwd: &str) -> bool {
    let segs: Vec<&str> = cwd.split(|c| c == '/' || c == '\\').filter(|s| !s.is_empty()).collect();
    let n = segs.len();
    let dated_slug = |s: &str| s.len() > 11 && s.is_char_boundary(10) && is_date(&s[..10]) && s.as_bytes()[10] == b'-' && is_slug(&s[11..]);
    (n >= 3 && dated_slug(segs[n - 1]) && segs[n - 2] == "Codex" && segs[n - 3] == "Documents")
        || (n >= 4 && is_slug(segs[n - 1]) && is_date(segs[n - 2]) && segs[n - 3] == "Codex" && segs[n - 4] == "Documents")
}

/// A worktree Codex made for a thread: under `<codexHome>/worktrees`, or under
/// `…/(.codex|.codex-workspaces[/instances/<x>]|OpenAI/Codex/workspaces[/instances/<x>])/worktrees`
/// (src/codex-sections.ts CODEX_WORKTREES). Codex resolves its project through
/// git and saves the root it found in thread-workspace-root-hints.
fn in_codex_worktree(cwd: &str, codex_home: &str) -> bool {
    let dir = cwd.replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    if !codex_home.is_empty() {
        let root = format!("{}/worktrees", codex_home.replace('\\', "/").trim_end_matches('/'));
        if dir == root || dir.starts_with(&format!("{}/", root)) {
            return true;
        }
    }
    // `pat` ends `before`, with a segment ahead of it (the path's `/`).
    fn ends_with(before: &[&str], pat: &[&str]) -> bool {
        before.len() > pat.len() && before[before.len() - pat.len()..] == *pat
    }
    // `base/instances/<x>` ends `before`, with a segment ahead of it.
    fn instance(before: &[&str], base: &[&str]) -> bool {
        let n = before.len();
        n > base.len() + 2 && before[n - 2] == "instances" && !before[n - 1].is_empty() && before[n - 2 - base.len()..n - 2] == *base
    }
    let segs: Vec<&str> = dir.split('/').collect();
    (1..segs.len()).any(|i| {
        let before = &segs[..i];
        segs[i] == "worktrees"
            && (ends_with(before, &[".codex"])
                || ends_with(before, &[".codex-workspaces"])
                || ends_with(before, &["OpenAI", "Codex", "workspaces"])
                || instance(before, &[".codex-workspaces"])
                || instance(before, &["OpenAI", "Codex", "workspaces"]))
    })
}

struct ProjectIndex {
    list: Vec<LocalProject>,
    by_id: HashMap<JsStr, usize>,
    by_root: HashMap<String, usize>,
}

fn index_projects(gs: &Json) -> ProjectIndex {
    let list = local_projects(gs);
    let mut by_root: HashMap<String, usize> = HashMap::new();
    for (i, p) in list.iter().enumerate() {
        for root in &p.roots {
            let key = path_key(&lossy(root));
            let replace = match by_root.get(&key) {
                Some(&held) => beats(p, &list[held], &key),
                None => true,
            };
            if replace {
                by_root.insert(key, i);
            }
        }
    }
    let by_id = list.iter().enumerate().map(|(i, p)| (p.id.clone(), i)).collect();
    ProjectIndex { list, by_id, by_root }
}

enum Resolved {
    Project(JsStr),
    NoProject,
    /// Assigned to a project that is gone, with no root to fall back on.
    Hidden,
}

struct ResolveCtx<'a> {
    projects: &'a ProjectIndex,
    assignments: Option<&'a OMap>,
    projectless: HashSet<JsStr>,
    hints: Option<&'a OMap>,
    codex_home: &'a str,
}

/// The project Codex files a thread under, the first rule that applies: an
/// assignment to a local project that exists; no project for an assignment
/// that came from a ChatGPT project, an empty cwd, a thread marked
/// projectless or one in a dated Documents/Codex folder; for a Codex worktree
/// that is not itself a root, the root Codex saved; the project whose root
/// equals the cwd; else none. A thread assigned to a project that no longer
/// exists, with no root to fall back on, is hidden everywhere.
fn resolve_project(tid: &[u16], cwd: Option<&str>, ctx: &ResolveCtx) -> Resolved {
    let assigned = ctx.assignments.and_then(|m| m.get(&lossy(tid))).filter(|a| {
        a.as_obj().is_some()
            && a.get("projectKind").and_then(|k| k.as_str()).map(|k| eq_str(k, "local")).unwrap_or(false)
            && a.get("projectId").and_then(|p| p.as_str()).is_some()
    });
    if let Some(a) = assigned {
        let pid = a.get("projectId").and_then(|p| p.as_str()).unwrap_or_default();
        if ctx.projects.by_id.contains_key(pid) {
            return Resolved::Project(pid.to_vec());
        }
        if a.get("projectOrigin").and_then(|o| o.as_str()).map(|o| eq_str(o, "chatgpt")).unwrap_or(false) {
            return Resolved::NoProject;
        }
    }
    let mut pid: Option<JsStr> = None;
    if let Some(cwd) = cwd {
        let named = cwd.split(|c| c == '/' || c == '\\').any(|s| !s.is_empty());
        if named && !ctx.projectless.contains(tid) && !is_projectless_dir(&lossy(trim(&js(cwd)))) {
            let mut dir = cwd.to_string();
            if in_codex_worktree(cwd, ctx.codex_home) && !ctx.projects.by_root.contains_key(&path_key(cwd)) {
                if let Some(hint) = ctx.hints.and_then(|h| h.get(&lossy(tid))).and_then(|h| h.as_string()) {
                    if ctx.projects.by_root.contains_key(&path_key(&hint)) {
                        dir = hint;
                    }
                }
            }
            pid = ctx.projects.by_root.get(&path_key(&dir)).map(|&i| ctx.projects.list[i].id.clone());
        }
    }
    match pid {
        Some(p) => Resolved::Project(p),
        None if assigned.is_some() => Resolved::Hidden,
        None => Resolved::NoProject,
    }
}

// ── Sidebar preferences ─────────────────────────────────────────────────────

struct Prefs {
    /// "list" mode: Recents only; otherwise ("project", and "connection" or
    /// "team" without remote connections) the project rows and Recents.
    list_mode: bool,
    project_manual: bool,
    chat_manual: bool,
    show_projects_in_recents: bool,
    chats_first: bool,
}

/// flat-project-sidebar-preferences-v1 as Codex reads it: a `manual` sort
/// counts only with manualSortVersion 1; codex-sidebar-sort-mode-v1, when
/// set, overrides both sorts (its `manual` reading as `updated_at` too);
/// before the preferences were initialized, a legacy organize mode decides.
fn sidebar_prefs(gs: &Json, atoms: &Json) -> Prefs {
    let p = atoms.get("flat-project-sidebar-preferences-v1").and_then(|p| p.as_obj());
    let get = |k: &str| p.and_then(|o| o.get(k));
    let mut mode: JsStr = get("mode").and_then(|m| m.as_str()).map(|m| m.to_vec()).unwrap_or_else(|| js("project"));
    if get("initialized").and_then(|v| v.as_bool()) != Some(true) {
        match atoms.get("sidebar-organize-mode-v1").and_then(|l| l.as_str()) {
            Some(l) if eq_str(l, "recent") => {
                let keep = atoms.get("sidebar-keep-projects-in-recent-v1").and_then(|v| v.as_bool());
                mode = js(if keep == Some(false) { "list" } else { "project" });
            }
            Some(l) => mode = l.to_vec(),
            None => {}
        }
    }
    let v1 = get("manualSortVersion").and_then(|v| v.as_f64()) == Some(1.0);
    let overridden = atoms.get("codex-sidebar-sort-mode-v1").and_then(|v| v.as_str()).is_some();
    let manual = |k: &str| !overridden && v1 && get(k).and_then(|m| m.as_str()).map(|m| eq_str(m, "manual")).unwrap_or(false);
    let setting = |k: &str| if atoms.as_obj().map(|o| o.contains(k)).unwrap_or(false) { atoms.get(k) } else { gs.get(k) };
    Prefs {
        list_mode: eq_str(&mode, "list"),
        project_manual: manual("projectSortMode"),
        chat_manual: manual("chatSortMode"),
        show_projects_in_recents: setting("sidebar-show-projects-in-recents").and_then(|v| v.as_bool()) != Some(false),
        chats_first: setting("projectless-sidebar-chats-first-v1").and_then(|v| v.as_bool()) == Some(true),
    }
}

// ── Assembly ────────────────────────────────────────────────────────────────

fn dedupe(ids: Vec<JsStr>) -> Vec<JsStr> {
    let mut seen: HashSet<JsStr> = HashSet::new();
    ids.into_iter().filter(|i| seen.insert(i.clone())).collect()
}

/// `saved` applied to `ids` the way Codex applies a saved order: the ids it
/// does not name first, in their order, then the ones it names, in its order.
fn saved_order_last(ids: &[JsStr], saved: &[JsStr]) -> Vec<JsStr> {
    let present: HashSet<&JsStr> = ids.iter().collect();
    let named: Vec<JsStr> = dedupe(saved.to_vec()).into_iter().filter(|s| present.contains(s)).collect();
    let named_set: HashSet<&JsStr> = named.iter().collect();
    let mut out: Vec<JsStr> = ids.iter().filter(|i| !named_set.contains(i)).cloned().collect();
    out.extend(named.iter().cloned());
    out
}

/// A thread shows once: the first group in sidebar order keeps it; a hidden
/// one never shows.
fn take(ids: Vec<JsStr>, claimed: &mut HashSet<JsStr>, hidden: &dyn Fn(&[u16]) -> bool) -> Vec<JsStr> {
    let mut out = Vec::new();
    for tid in ids {
        if hidden(tid.as_slice()) || claimed.contains(&tid) {
            continue;
        }
        claimed.insert(tid.clone());
        out.push(tid);
    }
    out
}

fn place(order: &mut Vec<JsStr>, key: JsStr) {
    if !order.contains(&key) {
        order.push(key);
    }
}

struct Section {
    id: JsStr,
    name: JsStr,
    collapsed: bool,
    item_keys: Vec<JsStr>,
}

/// Codex's sidebar from the parsed global state (None when the file is
/// absent) and the database read (None when there is no database), as groups
/// in the order Codex draws them (src/codex-sections.ts
/// assembleCodexSections): the custom sections; Pinned (pinned threads, then
/// each pinned project as a row, `sectionName` "Pinned"); in project mode a
/// row per project (`sectionName` "Projects"), empty ones too; and Recents,
/// the threads no row holds. `codex_home` places Codex's own worktrees.
pub fn assemble_codex_sections(gs: Option<&Json>, db: Option<&CodexDbRead>, codex_home: &str) -> (Vec<CodexSection>, Source) {
    let empty = Json::obj();
    let state = gs.unwrap_or(&empty);
    let atoms = state.get("electron-persisted-atom-state").filter(|a| a.as_obj().is_some()).unwrap_or(&empty);
    let entries = atoms.get("sidebar-custom-sections-v3").and_then(|e| e.as_obj());
    let account = match (gs, entries) {
        (Some(g), Some(e)) => pick_account(g, atoms, e),
        _ => Account::Unknown,
    };
    let entry = match (&account, entries) {
        (Account::Named(k), Some(e)) => e.get(k).filter(|x| x.as_obj().is_some()),
        _ => None,
    };
    let prefs = sidebar_prefs(state, atoms);
    let projects = index_projects(state);
    let rctx = ResolveCtx {
        projects: &projects,
        assignments: state.get("thread-project-assignments").and_then(|a| a.as_obj()),
        projectless: strings(state.get("projectless-thread-ids")).into_iter().collect(),
        hints: state.get("thread-workspace-root-hints").and_then(|h| h.as_obj()),
        codex_home,
    };

    // Each listed thread's project, worked out once per read.
    let mut project_of: HashMap<JsStr, Resolved> = HashMap::new();
    let mut by_project: HashMap<JsStr, Vec<JsStr>> = HashMap::new();
    if let Some(db) = db {
        for (tid, t) in &db.threads {
            let r = resolve_project(tid, t.cwd.as_deref(), &rctx);
            if let (true, Resolved::Project(pid)) = (t.visible, &r) {
                if !pid.is_empty() {
                    by_project.entry(pid.clone()).or_default().push(tid.clone());
                }
            }
            project_of.insert(tid.clone(), r);
        }
    } else if gs.is_some() {
        // No database: a project holds the threads assigned to it.
        if let Some(assignments) = rctx.assignments {
            for (tid, a) in assignments.iter() {
                let local = a.as_obj().is_some() && a.get("projectKind").and_then(|k| k.as_str()).map(|k| eq_str(k, "local")).unwrap_or(false);
                if let (true, Some(pid)) = (local, a.get("projectId").and_then(|p| p.as_str())) {
                    if projects.by_id.contains_key(pid) {
                        by_project.entry(pid.to_vec()).or_default().push(js(tid));
                    }
                }
            }
        }
    }
    // With a database, a thread it does not list (deleted), does not show or
    // hides for good is left out; without one, every named thread is kept.
    let hidden = |tid: &[u16]| -> bool {
        match db {
            Some(db) => db.threads.get(tid).map(|t| t.visible) != Some(true) || matches!(project_of.get(tid), Some(Resolved::Hidden)),
            None => false,
        }
    };
    let recency = |tid: &JsStr| db.and_then(|d| d.threads.get(tid)).map(|t| t.recency_ms).unwrap_or(0.0);
    let newest_first = |a: &JsStr, b: &JsStr| recency(b).partial_cmp(&recency(a)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.cmp(a));

    // The custom sections: the signed-in account's saved ones; with no saved
    // sidebar to go by, the app-server's, oldest first.
    let mut sections: Vec<Section> = Vec::new();
    let mut source = Source::None;
    if let Some(all) = entry.and_then(|e| e.get("sections")).and_then(|s| s.as_arr()) {
        let collapsed: HashSet<JsStr> = strings(entry.and_then(|e| e.get("collapsedSectionIds"))).into_iter().collect();
        for s in all {
            let id = s.get("id").and_then(|i| i.as_str()).filter(|i| !i.is_empty());
            let name = s.get("name").and_then(|n| n.as_str()).filter(|n| !trim(n).is_empty());
            if let (Some(_), Some(id), Some(name)) = (s.as_obj(), id, name) {
                sections.push(Section { id: id.to_vec(), name: name.to_vec(), collapsed: collapsed.contains(id), item_keys: strings(s.get("itemKeys")) });
            }
        }
        source = Source::Saved;
    } else if let (Account::Unknown, Some(db)) = (&account, db) {
        if !db.sections.is_empty() {
            let prefix = js(THREAD_ITEM);
            for (id, name) in &db.sections {
                let keys = db.members.get(id).map(|m| m.iter().map(|t| concat(&[&prefix[..], &t[..]])).collect()).unwrap_or_default();
                sections.push(Section { id: id.clone(), name: name.clone(), collapsed: false, item_keys: keys });
            }
            source = Source::Database;
        }
    }
    let mut section_threads: HashSet<JsStr> = HashSet::new();
    let mut section_projects: HashSet<JsStr> = HashSet::new();
    for s in &sections {
        for key in &s.item_keys {
            if starts_with(key, THREAD_ITEM) {
                section_threads.insert(key[THREAD_ITEM.len()..].to_vec());
            } else if starts_with(key, PROJECT_ITEM) {
                section_projects.insert(key[PROJECT_ITEM.len()..].to_vec());
            }
        }
    }

    // Pinned: the app-server's pinned section, then any thread an older Codex
    // pinned that the app-server has not taken over; and the pinned projects
    // that exist.
    let mut pinned_threads: Vec<JsStr> = db.and_then(|d| d.members.get(&js(CODEX_PINNED_SECTION_ID))).cloned().unwrap_or_default();
    let mut migrated: HashSet<JsStr> = HashSet::new();
    if let Some(by_host) = state.get("app-server-migrated-pinned-thread-ids-by-host").and_then(|m| m.as_obj()) {
        for (_, ids) in by_host.iter() {
            migrated.extend(strings(Some(ids)));
        }
    }
    for tid in strings(state.get("pinned-thread-ids")) {
        if !migrated.contains(&tid) && !pinned_threads.contains(&tid) {
            pinned_threads.push(tid);
        }
    }
    let pinned_set: HashSet<JsStr> = pinned_threads.iter().filter(|t| !hidden(t.as_slice())).cloned().collect();
    let pinned_projects: Vec<JsStr> = dedupe(strings(state.get("pinned-project-ids"))).into_iter().filter(|p| projects.by_id.contains_key(p)).collect();
    let pinned_project_set: HashSet<JsStr> = pinned_projects.iter().cloned().collect();

    // A project's threads in the order Codex lists them: newest first, or with
    // the manual sort the saved order first and the rest newest first after it.
    // A pinned thread or one a section names on its own shows there instead.
    let orders = state.get("sidebar-project-thread-orders").and_then(|o| o.as_obj());
    let project_threads = |pid: &[u16]| -> Vec<JsStr> {
        let mut members: Vec<JsStr> = by_project
            .get(pid)
            .map(|v| v.iter().filter(|t| !pinned_set.contains(*t) && !section_threads.contains(*t)).cloned().collect())
            .unwrap_or_default();
        members.sort_by(|a, b| newest_first(a, b));
        if !prefs.project_manual {
            return members;
        }
        let saved = orders.and_then(|o| o.get(&lossy(pid))).filter(|x| x.as_obj().is_some()).map(|x| strings(x.get("threadIds"))).unwrap_or_default();
        let present: HashSet<&JsStr> = members.iter().collect();
        let named: Vec<JsStr> = dedupe(saved).into_iter().filter(|t| present.contains(t)).collect();
        let named_set: HashSet<&JsStr> = named.iter().collect();
        let mut out: Vec<JsStr> = named.clone();
        out.extend(members.iter().filter(|t| !named_set.contains(t)).cloned());
        out
    };

    let collapsed_sections = atoms.get("sidebar-collapsed-sections-v1").and_then(|c| c.as_obj());
    let section_closed = |k: &str| collapsed_sections.and_then(|c| c.get(k)).and_then(|v| v.as_bool()) == Some(true);
    let row_collapsed = |pid: &[u16]| atoms.get(&format!("sidebar-project-expanded-v1-codex:{}", lossy(pid))).and_then(|v| v.as_bool()) == Some(false);

    // The rows of Projects: every project that is neither pinned nor placed in
    // a section, those missing from project-order first, then project-order,
    // with unified-sidebar-project-order-v1 applied the same way on top.
    let rows: Vec<JsStr> = if gs.is_some() && db.is_some() && !prefs.list_mode {
        let ids: Vec<JsStr> = projects.list.iter().map(|p| p.id.clone()).collect();
        let mut out = saved_order_last(&ids, &strings(state.get("project-order")));
        out.retain(|p| !pinned_project_set.contains(p) && !section_projects.contains(p));
        let unified: Vec<JsStr> = strings(atoms.get("unified-sidebar-project-order-v1"))
            .into_iter()
            .map(|k| if starts_with(&k, PROJECT_ITEM) { k[PROJECT_ITEM.len()..].to_vec() } else { k })
            .collect();
        saved_order_last(&out, &unified)
    } else {
        Vec::new()
    };
    let row_threads: HashMap<JsStr, Vec<JsStr>> = rows.iter().map(|p| (p.clone(), project_threads(&p[..]))).collect();
    let in_rows: HashSet<JsStr> = row_threads.values().flatten().cloned().collect();

    let label = |pid: &[u16]| projects.by_id.get(pid).map(|&i| projects.list[i].label.clone()).unwrap_or_default();
    let project_row = |pid: &JsStr, section_name: &str, closed: bool, claimed: &mut HashSet<JsStr>| -> CodexSection {
        let ids = row_threads.get(pid).cloned().unwrap_or_else(|| project_threads(&pid[..]));
        CodexSection {
            id: concat(&[&js("project:")[..], &pid[..]]),
            name: label(&pid[..]),
            section_name: Some(js(section_name)),
            collapsed: closed || row_collapsed(&pid[..]),
            session_ids: take(ids, claimed, &hidden),
        }
    };

    // Codex's section order: Pinned and Agents first when the saved order does
    // not place them, then the saved order, then the custom sections it
    // misses, then the built-in sections it misses.
    let section_index: HashMap<JsStr, usize> = sections.iter().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();
    let saved: Vec<JsStr> = entry.map(|e| strings(e.get("sectionOrder"))).unwrap_or_default();
    let mut order: Vec<JsStr> = Vec::new();
    if !saved.iter().any(|k| eq_str(k, "pinned")) {
        place(&mut order, js("pinned"));
    }
    if !saved.iter().any(|k| eq_str(k, "agents")) {
        place(&mut order, js("agents"));
    }
    for key in &saved {
        let custom = starts_with(key, "custom:") && section_index.contains_key(&key["custom:".len()..]);
        if eq_str(key, "pinned") || eq_str(key, "agents") || eq_str(key, "threads") || eq_str(key, "chats") || custom {
            place(&mut order, key.clone());
        }
    }
    for s in &sections {
        place(&mut order, concat(&[&js("custom:")[..], &s.id[..]]));
    }
    let built_in = if prefs.chats_first { ["chats", "threads"] } else { ["threads", "chats"] };
    for key in built_in {
        place(&mut order, js(key));
    }

    let mut groups: Vec<CodexSection> = Vec::new();
    let mut claimed: HashSet<JsStr> = HashSet::new();
    for key in &order {
        if eq_str(key, "pinned") {
            let closed = section_closed("pinned");
            let ids = take(pinned_threads.clone(), &mut claimed, &hidden);
            if !ids.is_empty() {
                groups.push(CodexSection { id: js("pinned"), name: js("Pinned"), section_name: None, collapsed: closed, session_ids: ids });
            }
            if gs.is_some() {
                for pid in &pinned_projects {
                    groups.push(project_row(pid, "Pinned", closed, &mut claimed));
                }
            }
        } else if eq_str(key, "threads") {
            let closed = section_closed("threads");
            for pid in &rows {
                groups.push(project_row(pid, "Projects", closed, &mut claimed));
            }
        } else if eq_str(key, "chats") {
            if let (Some(_), Some(db)) = (gs, db) {
                let mut ids: Vec<JsStr> = db
                    .threads
                    .keys()
                    .filter(|tid| {
                        if hidden(tid.as_slice()) || pinned_set.contains(*tid) || section_threads.contains(*tid) || in_rows.contains(*tid) {
                            return false;
                        }
                        match project_of.get(*tid) {
                            Some(Resolved::Project(pid)) if !pid.is_empty() => {
                                !pinned_project_set.contains(pid) && !section_projects.contains(pid) && (prefs.list_mode || prefs.show_projects_in_recents)
                            }
                            _ => true,
                        }
                    })
                    .cloned()
                    .collect();
                ids.sort_by(|a, b| newest_first(a, b));
                if prefs.chat_manual {
                    let unified: Vec<JsStr> = strings(atoms.get("unified-sidebar-chat-order-v1"))
                        .into_iter()
                        .map(|k| if starts_with(&k, THREAD_ITEM) { k[THREAD_ITEM.len()..].to_vec() } else { k })
                        .collect();
                    ids = saved_order_last(&ids, &unified);
                }
                let session_ids = take(ids, &mut claimed, &hidden);
                groups.push(CodexSection { id: js("recents"), name: js("Recents"), section_name: None, collapsed: section_closed("chats"), session_ids });
            }
        } else if starts_with(key, "custom:") {
            if let Some(&i) = section_index.get(&key["custom:".len()..]) {
                let s = &sections[i];
                let mut ids: Vec<JsStr> = Vec::new();
                for k in &s.item_keys {
                    if starts_with(k, THREAD_ITEM) {
                        let tid = k[THREAD_ITEM.len()..].to_vec();
                        if !pinned_set.contains(&tid) {
                            ids.push(tid);
                        }
                    } else if starts_with(k, PROJECT_ITEM) {
                        ids.extend(project_threads(&k[PROJECT_ITEM.len()..]));
                    }
                }
                let session_ids = take(ids, &mut claimed, &hidden);
                groups.push(CodexSection { id: s.id.clone(), name: s.name.clone(), section_name: None, collapsed: s.collapsed, session_ids });
            }
        }
    }
    (groups, source)
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
const KEPT_KEYS: [&str; 12] = [
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
const KEPT_ATOMS: [&str; 11] = [
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
/// One atom per project row: `sidebar-project-expanded-v1-codex:<project id>`.
const KEPT_ATOM_PREFIX: &str = "sidebar-project-expanded-v1-";

fn keep(from: &OMap, keys: &[&str], prefix: Option<&str>) -> OMap {
    let mut out = OMap::new();
    for k in keys {
        if let Some(v) = from.get(k) {
            out.set(k, v.clone());
        }
    }
    if let Some(prefix) = prefix {
        for (k, v) in from.iter() {
            if k.starts_with(prefix) {
                out.set(k, v.clone());
            }
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
    let mut out = keep(o, &KEPT_KEYS, None);
    if let Some(atoms) = o.get("electron-persisted-atom-state").and_then(|a| a.as_obj()) {
        out.set("electron-persisted-atom-state", Json::Obj(keep(atoms, &KEPT_ATOMS, Some(KEPT_ATOM_PREFIX))));
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
    let (groups, _) = assemble_codex_sections(gs.as_ref(), db.as_ref(), codex_home);
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
    use rusqlite::Connection;

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

    /// The custom sections and Pinned, without the Projects rows and Recents.
    fn sections_only(groups: Vec<CodexSection>) -> Vec<CodexSection> {
        groups.into_iter().filter(|g| !eq_str(&g.id, "recents") && !starts_with(&g.id, "project:")).collect()
    }

    /// A group as (id, name, sectionName, collapsed, sessionIds).
    type Drawn = (String, String, Option<String>, bool, Vec<String>);

    fn ids_of(ns: &[u32]) -> Vec<String> {
        ns.iter().map(|&n| t(n)).collect()
    }

    fn g(id: &str, name: &str, section: Option<&str>, collapsed: bool, threads: &[u32]) -> Drawn {
        (id.to_string(), name.to_string(), section.map(|s| s.to_string()), collapsed, ids_of(threads))
    }

    /// The groups the home draws now, read past the cache.
    fn drawn_in(h: &str) -> Vec<Drawn> {
        let gs = read_global_state(&join(h, CODEX_GLOBAL_STATE)).expect("the global state");
        let db = state_db_path(h).map(|p| read_codex_state_db(&p).expect("the database"));
        let (groups, _) = assemble_codex_sections(gs.as_ref(), db.as_ref(), h);
        groups
            .iter()
            .map(|g| (lossy(&g.id), lossy(&g.name), g.section_name.as_ref().map(|s| lossy(s)), g.collapsed, g.session_ids.iter().map(|s| lossy(s)).collect()))
            .collect()
    }

    const NO_SECTIONS: &str = r#"{"sections":[],"collapsedSectionIds":[],"sectionOrder":[]}"#;
    const ACME: &str = r#""local-projects":{"lf":{"id":"lf","name":"acme","rootPaths":["/work/acme"]},"wt":{"id":"wt","name":"a worktree","rootPaths":["/work/acme/.claude/worktrees/wt"]}}"#;

    /// A global state whose current account (named by the catalog cache) has
    /// `entry`, with `extra` top-level keys and `atoms` further atoms ("" for
    /// none). `T<n>` stands for t(n).
    fn state_with(entry: &str, extra: &str, atoms: &str) -> String {
        let more = |s: &str| if s.is_empty() { String::new() } else { format!(",{}", s) };
        let mut s = format!(
            r#"{{"environment-catalog-cache-v1":{{"accountId":"acct-current"}},"electron-persisted-atom-state":{{"sidebar-custom-sections-v3":{{"acct-current":{},"acct-old":{{"sections":[{{"id":"old","name":"Old account","itemKeys":[]}}],"collapsedSectionIds":[],"sectionOrder":[]}}}}{}}}{}}}"#,
            entry,
            more(atoms),
            more(extra)
        );
        for n in (1..=9).rev() {
            s = s.replace(&format!("T{}", n), &t(n));
        }
        s
    }

    /// A `local-projects` entry named "  <ID>  ", which Codex trims.
    fn local(id: &str, root: &str) -> String {
        format!(r#""{id}":{{"id":"{id}","name":"  {up}  ","rootPaths":["{root}"]}}"#, id = id, up = id.to_uppercase(), root = root)
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

    /// The harness fixture's shape: order, Pinned, visibility, a project
    /// placed in a collapsed section, an empty section, another account, a
    /// project row, and Recents holding a thread in a project's subfolder.
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
            "local-projects":{{"local-repo":{{"id":"local-repo","name":"repo","rootPaths":["/work/repo"]}},"local-scratch":{{"id":"local-scratch","name":"scratch","rootPaths":["/work/scratch"]}}}},
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
              "flat-project-sidebar-preferences-v1":{{"projectSortMode":"manual","manualSortVersion":1}}}}}}"#,
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
                ("Old work".to_string(), true, vec![c2.clone()]),
                ("Empty".to_string(), false, vec![]),
                ("scratch".to_string(), false, vec![]),
                ("Recents".to_string(), false, vec![under.clone()]),
            ]
        );
        assert_eq!(
            groups.iter().map(|g| lossy(&g.id)).collect::<Vec<_>>(),
            vec!["sec-review", "pinned", "sec-old", "sec-empty", "project:local-scratch", "recents"]
        );
        assert_eq!(
            codex_mirror_value(&read).expect("a value").stringify(),
            format!(
                "{{\"groups\":[{{\"id\":\"sec-review\",\"name\":\"Review\",\"collapsed\":false,\"sessionIds\":[\"{}\",\"{}\"],\"showEmpty\":true}},{{\"id\":\"pinned\",\"name\":\"Pinned\",\"collapsed\":false,\"sessionIds\":[\"{}\",\"{}\"],\"showEmpty\":true}},{{\"id\":\"sec-old\",\"name\":\"Old work\",\"collapsed\":true,\"sessionIds\":[\"{}\"],\"showEmpty\":true}},{{\"id\":\"sec-empty\",\"name\":\"Empty\",\"collapsed\":false,\"sessionIds\":[],\"showEmpty\":true}},{{\"id\":\"project:local-scratch\",\"name\":\"scratch\",\"sectionName\":\"Projects\",\"collapsed\":false,\"sessionIds\":[],\"showEmpty\":true}},{{\"id\":\"recents\",\"name\":\"Recents\",\"collapsed\":false,\"sessionIds\":[\"{}\"],\"showEmpty\":true}}]}}",
                c1, listed, pinned, old_pin, c2, under
            )
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn a_named_account_without_an_entry_has_no_sections() {
        let h = home("named");
        make_db(&h, &[], &[]);
        write_state(&h, r#"{"environment-catalog-cache-v1":{"accountId":"new"},"electron-persisted-atom-state":{"sidebar-custom-sections-v3":{"old":{"sections":[{"id":"a","name":"Old","itemKeys":[]}],"collapsedSectionIds":[],"sectionOrder":[]}}}}"#);
        assert!(sections_only(build_codex_sections(&[h.clone()]).expect("read").expect("a Codex home")).is_empty());
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
        let groups = sections_only(build_codex_sections(&[h.clone()]).expect("read").expect("a Codex home"));
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
    fn a_project_in_a_section_takes_the_threads_whose_cwd_is_its_root() {
        let h = home("placed");
        make_db(
            &h,
            &[
                Row { cwd: "/elsewhere", recency: 10, ..row(t(1)) }, // assigned to lf
                Row { cwd: "/work/acme", recency: 30, ..row(t(2)) },
                Row { cwd: "/work/acme/apps/x", recency: 20, ..row(t(3)) }, // a subfolder: no project
                Row { cwd: "/work/acme/.claude/worktrees/wt", recency: 40, ..row(t(4)) }, // the worktree's own project
                Row { cwd: "/work/acme", recency: 50, ..row(t(5)) }, // projectless
                Row { cwd: "/work/acme", recency: 60, ..row(t(6)) }, // assigned to wt
                Row { cwd: "/work/acme-other", recency: 70, ..row(t(7)) },
            ],
            &[],
        );
        let extra = format!(
            r#"{},"thread-project-assignments":{{"T1":{{"projectKind":"local","projectId":"lf"}},"T6":{{"projectKind":"local","projectId":"wt"}}}},"projectless-thread-ids":["T5"]"#,
            ACME
        );
        let entry = r#"{"sections":[{"id":"old","name":"OLD","itemKeys":["codex:project:lf"]}],"collapsedSectionIds":[],"sectionOrder":["custom:old"]}"#;
        write_state(&h, &state_with(entry, &extra, ""));
        assert_eq!(
            drawn_in(&h),
            vec![
                g("old", "OLD", None, false, &[2, 1]),
                g("project:wt", "a worktree", Some("Projects"), false, &[6, 4]),
                g("recents", "Recents", None, false, &[7, 5, 3]),
            ]
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn a_manual_sort_counts_only_with_manual_sort_version_1() {
        let h = home("manual");
        make_db(&h, &[1, 2, 3, 4].map(|n| Row { cwd: "/work/acme", recency: n as i64 * 10, ..row(t(n)) }), &[]);
        let entry = r#"{"sections":[{"id":"old","name":"OLD","itemKeys":["codex:project:lf"]}],"collapsedSectionIds":[],"sectionOrder":[]}"#;
        let extra = format!(r#"{},"sidebar-project-thread-orders":{{"lf":{{"threadIds":["T1","gone","T3","T1"]}}}}"#, ACME);
        let old = |prefs: &str| -> Vec<String> {
            write_state(&h, &state_with(entry, &extra, &format!(r#""flat-project-sidebar-preferences-v1":{}"#, prefs)));
            drawn_in(&h).into_iter().find(|d| d.0 == "old").expect("OLD").4
        };
        assert_eq!(old(r#"{"projectSortMode":"manual"}"#), ids_of(&[4, 3, 2, 1]));
        assert_eq!(old(r#"{"projectSortMode":"manual","manualSortVersion":1}"#), ids_of(&[1, 3, 4, 2]));
        assert_eq!(old(r#"{"projectSortMode":"updated_at"}"#), ids_of(&[4, 3, 2, 1]));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn draws_a_row_per_project_and_recents_holds_the_rest() {
        let h = home("rows");
        make_db(
            &h,
            &[
                Row { cwd: "/w/one", recency: 10, ..row(t(1)) },
                Row { cwd: "/w/two", recency: 20, ..row(t(2)) },
                Row { cwd: "/w/one/sub", recency: 30, ..row(t(3)) },
                Row { cwd: "/Users/x/Documents/Codex/2026-10-01-a-chat", recency: 40, ..row(t(4)) },
                Row { recency: 50, ..row(t(5)) },
            ],
            &[],
        );
        let extra = format!(r#""local-projects":{{{},{},{}}},"project-order":["p3","p1","gone"]"#, local("p1", "/w/one"), local("p2", "/w/two"), local("p3", "/w/three"));
        let atoms = r#""sidebar-project-expanded-v1-codex:p1":false,"sidebar-project-expanded-v1-codex:p2":true"#;
        write_state(&h, &state_with(NO_SECTIONS, &extra, atoms));
        assert_eq!(
            drawn_in(&h),
            vec![
                g("project:p2", "P2", Some("Projects"), false, &[2]),
                g("project:p3", "P3", Some("Projects"), false, &[]),
                g("project:p1", "P1", Some("Projects"), true, &[1]),
                g("recents", "Recents", None, false, &[5, 4, 3]),
            ]
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn files_a_codex_worktree_by_its_hint_and_hides_a_thread_of_a_gone_project() {
        let h = home("resolve");
        let wt = join(&join(&join(&h, "worktrees"), "a1b2"), "acme");
        make_db(
            &h,
            &[
                Row { cwd: &wt, recency: 10, ..row(t(1)) },
                Row { cwd: "/w/nowhere", recency: 20, ..row(t(2)) },
                Row { cwd: "/w/nowhere", recency: 30, ..row(t(3)) },
                Row { cwd: "/W/One", recency: 40, ..row(t(4)) }, // case does not matter
            ],
            &[],
        );
        let extra = format!(
            r#""local-projects":{{{}}},"thread-workspace-root-hints":{{"T1":"/w/one"}},"thread-project-assignments":{{"T2":{{"projectKind":"local","projectId":"gone"}},"T3":{{"projectKind":"local","projectId":"gone","projectOrigin":"chatgpt"}}}}"#,
            local("p1", "/w/one")
        );
        write_state(&h, &state_with(NO_SECTIONS, &extra, ""));
        assert_eq!(drawn_in(&h), vec![g("project:p1", "P1", Some("Projects"), false, &[4, 1]), g("recents", "Recents", None, false, &[3])]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn leaves_pinned_and_section_placed_projects_out_of_projects_and_recents() {
        let h = home("pinned-projects");
        make_db(
            &h,
            &[
                Row { cwd: "/w/one", recency: 10, ..row(t(1)) },
                Row { cwd: "/w/two", recency: 20, ..row(t(2)) },
                Row { cwd: "/w/three", recency: 30, ..row(t(3)) },
                Row { cwd: "/w/three", recency: 40, ..row(t(4)) },
            ],
            &[],
        );
        let entry = r#"{"sections":[{"id":"s","name":"S","itemKeys":["codex:project:p2","codex:thread:local:T4"]}],"collapsedSectionIds":[],"sectionOrder":["custom:s"]}"#;
        let extra = format!(r#""local-projects":{{{},{},{}}},"pinned-project-ids":["p1","missing"]"#, local("p1", "/w/one"), local("p2", "/w/two"), local("p3", "/w/three"));
        let atoms = r#""sidebar-collapsed-sections-v1":{"pinned":false,"threads":true,"chats":true}"#;
        write_state(&h, &state_with(entry, &extra, atoms));
        assert_eq!(
            drawn_in(&h),
            vec![
                g("project:p1", "P1", Some("Pinned"), false, &[1]),
                g("s", "S", None, false, &[2, 4]),
                g("project:p3", "P3", Some("Projects"), true, &[3]),
                g("recents", "Recents", None, true, &[]),
            ]
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn list_mode_draws_no_projects_and_chats_first_puts_recents_first() {
        let h = home("modes");
        make_db(&h, &[Row { cwd: "/w/one", recency: 10, ..row(t(1)) }, Row { recency: 20, ..row(t(2)) }], &[]);
        let extra = format!(r#""local-projects":{{{}}}"#, local("p1", "/w/one"));
        write_state(&h, &state_with(NO_SECTIONS, &extra, r#""flat-project-sidebar-preferences-v1":{"mode":"list","initialized":true}"#));
        assert_eq!(drawn_in(&h), vec![g("recents", "Recents", None, false, &[2, 1])]);
        // A legacy organize mode decides only before the preferences were initialized.
        write_state(&h, &state_with(NO_SECTIONS, &extra, r#""sidebar-organize-mode-v1":"recent","sidebar-keep-projects-in-recent-v1":false"#));
        assert_eq!(drawn_in(&h), vec![g("recents", "Recents", None, false, &[2, 1])]);
        write_state(&h, &state_with(NO_SECTIONS, &extra, r#""projectless-sidebar-chats-first-v1":true"#));
        assert_eq!(drawn_in(&h), vec![g("recents", "Recents", None, false, &[2]), g("project:p1", "P1", Some("Projects"), false, &[1])]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn orders_recents_by_its_saved_order_when_sorted_by_hand() {
        let h = home("chat-order");
        make_db(&h, &[1, 2, 3].map(|n| Row { recency: n as i64 * 10, ..row(t(n)) }), &[]);
        let atoms = r#""flat-project-sidebar-preferences-v1":{"chatSortMode":"manual","manualSortVersion":1,"initialized":true},"unified-sidebar-chat-order-v1":["codex:thread:local:T1","codex:thread:local:T2"]"#;
        write_state(&h, &state_with(NO_SECTIONS, "", atoms));
        assert_eq!(drawn_in(&h), vec![g("recents", "Recents", None, false, &[3, 1, 2])]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn does_not_list_a_thread_chatgpt_hides_or_one_another_thread_spawned() {
        let h = home("spawned");
        let p = make_db(&h, &[Row { recency: 10, ..row(t(1)) }, Row { recency: 20, thread_source: "chatgpt_hidden", ..row(t(2)) }, Row { recency: 30, ..row(t(3)) }], &[]);
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute_batch("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)").unwrap();
            conn.execute("INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'done')", rusqlite::params![t(1), t(3)]).unwrap();
        }
        write_state(&h, &state_with(NO_SECTIONS, "", ""));
        assert_eq!(drawn_in(&h), vec![g("recents", "Recents", None, false, &[1])]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn matches_the_projectless_and_worktree_folders_codex_matches() {
        for dir in ["/Users/x/Documents/Codex/2026-10-12-sketch", "C:\\Users\\x\\Documents\\Codex\\2026-10-12\\sketch\\", "Documents/Codex/2026-10-12-a-b-1/"] {
            assert!(is_projectless_dir(dir), "{}", dir);
        }
        for dir in ["/Users/x/Documents/Codex/2026-10-12", "/Users/x/Documents/Codex/2026-10-12-Sketch", "/Users/x/MyDocuments/Codex/2026-10-12-a", "/Users/x/Documents/Codex/x/2026-10-12-a"] {
            assert!(!is_projectless_dir(dir), "{}", dir);
        }
        for dir in ["/u/.codex/worktrees/a1/repo", "/u/.codex-workspaces/instances/i1/worktrees", "C:\\u\\OpenAI\\Codex\\workspaces\\worktrees\\a\\", "/home/x/codex-home/worktrees/z"] {
            assert!(in_codex_worktree(dir, "/home/x/codex-home"), "{}", dir);
        }
        for dir in [".codex/worktrees/a", "/u/.codex/worktrees-old/a", "/u/codex/worktrees/a", "/u/.codex-workspaces/instances/worktrees/a"] {
            assert!(!in_codex_worktree(dir, ""), "{}", dir);
        }
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
