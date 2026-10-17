//! What the `hx ui` server reads (src/ui/data.ts, preview.ts, activity.ts
//! and the settings writes of settings.ts). Everything here reads, except
//! the settings write: state.json stays the daemon's.
//!
//! The discovery walks are cached as the TypeScript client caches them (4 s
//! for the windowed view, 60 s for the unwindowed sweep, keyed by the roots'
//! signature); every fold runs over a fresh read of the state.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex, OnceLock};

use crate::fsutil::{basename, dirname, now_ms};
use crate::home::homedir;
use crate::js::{collapse_spaces, lossy, slice, starts_with, trim, JsStr};
use crate::json::{obj, Json, OMap};
use crate::pathnorm::normalize_data_dir;
use crate::roots::{resolve_data_roots, roots_signature, same_physical_dir, DataRoot, ResolvedRoots, DEFAULT_CLAUDE_ROOT, DEFAULT_CODEX_ROOT};
use crate::settings::{parse_data_dirs, read_settings, settings_path, MAX_DATA_DIRS_PER_FAMILY};
use crate::sources::{discover_claude_files, discover_codex_files, read_head, DiscoveredFile, HeadMeta, RECENT_WINDOW_MS};
use crate::state::{fs_min_offset, read_state_json, Store};

// ── Discovery caches ────────────────────────────────────────────────────────

const WINDOWED_TTL_MS: f64 = 4_000.0;
const UNWINDOWED_TTL_MS: f64 = 60_000.0;

struct DiscoveryCache {
    at_ms: f64,
    sig: String,
    claude: Vec<DiscoveredFile>,
    codex: Vec<DiscoveredFile>,
}

fn cache_slot(unwindowed: bool) -> &'static Mutex<Option<Arc<DiscoveryCache>>> {
    static WINDOWED: OnceLock<Mutex<Option<Arc<DiscoveryCache>>>> = OnceLock::new();
    static UNWINDOWED: OnceLock<Mutex<Option<Arc<DiscoveryCache>>>> = OnceLock::new();
    if unwindowed {
        UNWINDOWED.get_or_init(|| Mutex::new(None))
    } else {
        WINDOWED.get_or_init(|| Mutex::new(None))
    }
}

/// `cachedDiscovery`: single-flight (the slot's lock is held while it walks).
fn cached_discovery(roots: &ResolvedRoots, unwindowed: bool) -> Arc<DiscoveryCache> {
    let sig = roots_signature(roots);
    let ttl = if unwindowed { UNWINDOWED_TTL_MS } else { WINDOWED_TTL_MS };
    let mut slot = cache_slot(unwindowed).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = slot.as_ref() {
        if c.sig == sig && now_ms() - c.at_ms < ttl {
            return c.clone();
        }
    }
    let now = now_ms();
    let max_age = if unwindowed { None } else { Some(RECENT_WINDOW_MS) };
    let fresh = Arc::new(DiscoveryCache {
        at_ms: now_ms(),
        sig,
        claude: discover_claude_files(&roots.claude, max_age, now),
        codex: discover_codex_files(&roots.codex, true, max_age, now),
    });
    *slot = Some(fresh.clone());
    fresh
}

/// `freshenSizes`: a cached size is only ever raised to the daemon's live
/// `lastKnownSize`, so a growing file can't read as done.
fn freshen_sizes(files: &[DiscoveredFile], state: &Json) -> Vec<DiscoveredFile> {
    files
        .iter()
        .map(|f| {
            let known = state.get("files").and_then(|m| m.get(&f.path)).and_then(|e| e.get_f64("lastKnownSize"));
            match known {
                Some(k) if k > f.size as f64 => DiscoveredFile { size: k as u64, ..f.clone() },
                _ => f.clone(),
            }
        })
        .collect()
}

// ── Heads ───────────────────────────────────────────────────────────────────

fn head_cache() -> &'static Mutex<HashMap<String, (f64, HeadMeta)>> {
    static C: OnceLock<Mutex<HashMap<String, (f64, HeadMeta)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `headsFor`: heads per (path, mtime), a title derived from the first user
/// message when the file names none. Never resolves a repo from disk.
fn heads_for(files: &[DiscoveredFile]) -> HashMap<String, HeadMeta> {
    let mut out = HashMap::new();
    for f in files {
        {
            let c = head_cache().lock().unwrap_or_else(|e| e.into_inner());
            if let Some((mtime, head)) = c.get(&f.path) {
                if *mtime == f.mtime_ms {
                    out.insert(f.path.clone(), head.clone());
                    continue;
                }
            }
        }
        let mut head = read_head(&f.path, f.source, false);
        if head.title.is_none() {
            head.title = extract_title_fallback(&read_head_lines(&f.path));
        }
        head_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(f.path.clone(), (f.mtime_ms, head.clone()));
        out.insert(f.path.clone(), head);
    }
    out
}

// ── Preview lines ───────────────────────────────────────────────────────────

const TAIL_BYTES: u64 = 64 * 1024;
const MAX_LINES: usize = 12;
const MAX_TEXT: usize = 220;
const TITLE_MAX: usize = 64;
const HEAD_BYTES: usize = 32 * 1024;

fn ellipsis() -> u16 {
    0x2026
}

/// `clip`: whitespace collapsed, trimmed, cut to 220 UTF-16 units.
fn clip(s: &[u16]) -> JsStr {
    let collapsed = collapse_spaces(s);
    let t = trim(&collapsed);
    if t.len() > MAX_TEXT {
        let mut out = slice(t, 0, MAX_TEXT - 1).to_vec();
        out.push(ellipsis());
        out
    } else {
        t.to_vec()
    }
}

/// `extractPreviewLines`: the Me / Agent / Tool lines of a jsonl tail, the last 12.
pub fn extract_preview_lines(raw_lines: &[String]) -> Vec<(&'static str, JsStr)> {
    let mut out: Vec<(&'static str, JsStr)> = Vec::new();
    for raw in raw_lines {
        if raw.trim().is_empty() {
            continue;
        }
        let o = match Json::parse(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = o.get_string("type");
        let message = o.get("message");
        let content = message.and_then(|m| m.get("content"));
        if matches!(kind.as_deref(), Some("user") | Some("assistant")) && content.is_some() {
            let role = if kind.as_deref() == Some("user") { "Me" } else { "Agent" };
            match content {
                Some(Json::Str(s)) => {
                    if !trim(s).is_empty() {
                        out.push((role, clip(s)));
                    }
                }
                Some(Json::Arr(parts)) => {
                    for part in parts {
                        let ptype = part.get_string("type");
                        if ptype.as_deref() == Some("text") {
                            if let Some(Json::Str(t)) = part.get("text") {
                                if !trim(t).is_empty() {
                                    out.push((role, clip(t)));
                                }
                                continue;
                            }
                        }
                        if ptype.as_deref() == Some("tool_use") {
                            if let Some(Json::Str(n)) = part.get("name") {
                                if !n.is_empty() {
                                    out.push(("Tool", clip(n)));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let payload = o.get("payload").filter(|p| p.truthy());
        if kind.as_deref() == Some("response_item") {
            if let Some(p) = payload {
                let ptype = p.get_string("type");
                if ptype.as_deref() == Some("message") {
                    if let Some(Json::Arr(parts)) = p.get("content") {
                        let role = if p.get_string("role").as_deref() == Some("user") { "Me" } else { "Agent" };
                        for part in parts {
                            if let Some(Json::Str(t)) = part.get("text") {
                                if !trim(t).is_empty() {
                                    out.push((role, clip(t)));
                                }
                            }
                        }
                        continue;
                    }
                }
                if ptype.as_deref() == Some("function_call") {
                    if let Some(Json::Str(n)) = p.get("name") {
                        if !n.is_empty() {
                            out.push(("Tool", clip(n)));
                        }
                    }
                }
            }
        }
    }
    let n = out.len();
    if n > MAX_LINES {
        out.drain(..n - MAX_LINES);
    }
    out
}

fn preview_json(lines: Vec<(&'static str, JsStr)>) -> Json {
    Json::Arr(lines.into_iter().map(|(role, text)| obj(vec![("role", Json::str(role)), ("text", Json::Str(text))])).collect())
}

/// `extractTitleFallback`: the first typed user line, clipped to 64 units.
pub fn extract_title_fallback(raw_lines: &[String]) -> Option<JsStr> {
    let lines = extract_preview_lines(raw_lines);
    let me = lines.into_iter().find(|(role, text)| *role == "Me" && !starts_with(text, "<") && !starts_with(text, "Caveat:"))?;
    let t = me.1;
    if t.len() > TITLE_MAX {
        let mut out = slice(&t, 0, TITLE_MAX - 1).to_vec();
        out.push(ellipsis());
        Some(out)
    } else {
        Some(t)
    }
}

/// `readHeadLines`: the first 32 KB, split, a torn last line dropped.
fn read_head_lines(path: &str) -> Vec<String> {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut buf = vec![0u8; HEAD_BYTES];
    let mut n = 0usize;
    while n < HEAD_BYTES {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => return Vec::new(),
        }
    }
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    if n == HEAD_BYTES {
        lines.pop();
    }
    lines
}

/// `previewSessionFile`: the last 64 KB of a session as preview lines.
pub fn preview_session_file(path: &str) -> Json {
    let read = || -> Option<Vec<String>> {
        let mut f = fs::File::open(path).ok()?;
        let size = f.metadata().ok()?.len();
        let start = size.saturating_sub(TAIL_BYTES);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::with_capacity((size - start) as usize);
        f.take(size - start).read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf).into_owned();
        let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        Some(lines)
    };
    preview_json(read().map(|l| extract_preview_lines(&l)).unwrap_or_default())
}

// ── Folders, destinations, roots ────────────────────────────────────────────

/// data.ts `collapseHome`: a plain prefix test against the home directory.
fn collapse_home(p: &str) -> String {
    let home = homedir().to_string_lossy().into_owned();
    match p.strip_prefix(home.as_str()) {
        Some(rest) => format!("~{}", rest),
        None => p.to_string(),
    }
}

pub fn family_label(family: &str) -> String {
    match family {
        "claude-cli" => "Claude Code CLI",
        "claude-desktop" => "Claude Code Desktop",
        "codex-cli" => "Codex CLI",
        "codex-desktop" => "Codex Desktop",
        "unknown" => "Unknown tool",
        other => other,
    }
    .to_string()
}

/// `destLabelFor`.
fn dest_label_for(key: &str, names: &OMap) -> String {
    if key == "letai" {
        return "let.ai".to_string();
    }
    if let Some(n) = names.get(key).and_then(|v| v.as_string()) {
        if !n.is_empty() {
            return n;
        }
    }
    let units: Vec<u16> = key.encode_utf16().collect();
    if units.len() > 14 {
        let mut out = String::from_utf16_lossy(&units[..12]);
        out.push('…');
        out
    } else {
        key.to_string()
    }
}

struct Fact {
    file: DiscoveredFile,
    head: HeadMeta,
    state: Option<Json>,
}

impl Fact {
    fn family(&self) -> String {
        if self.head.family == "unknown" {
            (if self.file.source == "claude" { "claude-cli" } else { "codex-cli" }).to_string()
        } else {
            self.head.family.clone()
        }
    }

    fn cwd(&self) -> String {
        collapse_home(&self.head.cwd_string().unwrap_or_else(|| dirname(&self.file.path)))
    }

    fn last_upload(&self) -> f64 {
        match self.state.as_ref().and_then(|s| s.get("lastUploadAtMs")) {
            Some(Json::Num(n)) if *n != 0.0 && !n.is_nan() => *n,
            _ => 0.0,
        }
    }

    /// `Object.keys(state.offsets).filter((k) => state.offsets[k] > 0)`.
    fn dests(&self) -> Vec<String> {
        offsets_of(self.state.as_ref()).into_iter().filter(|(_, v)| *v > 0.0).map(|(k, _)| k).collect()
    }
}

fn offsets_of(state: Option<&Json>) -> Vec<(String, f64)> {
    state
        .and_then(|s| s.get("offsets"))
        .and_then(|o| o.as_obj())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect())
        .unwrap_or_default()
}

fn folder_id_for(family: &str, cwd: &str) -> String {
    format!("{}:{}", family, cwd)
}

fn strings(v: &[String]) -> Json {
    Json::Arr(v.iter().map(|s| Json::str(s)).collect())
}

/// `groupFolders`.
fn group_folders(facts: &[Fact]) -> Vec<Json> {
    struct Row {
        id: String,
        family: String,
        path: String,
        sessions: u64,
        repo: Option<String>,
        branch: Option<JsStr>,
        dests: Vec<String>,
        last_upload: f64,
        attributed: Option<bool>,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for f in facts {
        let family = f.family();
        let cwd = f.cwd();
        let id = folder_id_for(&family, &cwd);
        let i = *index.entry(id.clone()).or_insert_with(|| {
            rows.push(Row { id: id.clone(), family: family.clone(), path: cwd.clone(), sessions: 0, repo: None, branch: None, dests: Vec::new(), last_upload: 0.0, attributed: None });
            rows.len() - 1
        });
        let row = &mut rows[i];
        row.sessions += 1;
        let state_slug = match f.state.as_ref().and_then(|s| s.get("repoSlug")) {
            Some(Json::Str(s)) => Some(lossy(s)),
            _ => None,
        };
        let repo_slug = state_slug.or_else(|| f.head.repo_slug.clone());
        if let Some(r) = repo_slug {
            if !r.is_empty() && row.repo.is_none() {
                row.repo = Some(r);
            }
        }
        if let Some(b) = &f.head.git_branch {
            if !b.is_empty() && row.branch.is_none() {
                row.branch = Some(b.clone());
            }
        }
        if let Some(st) = &f.state {
            row.last_upload = row.last_upload.max(f.last_upload());
            for (k, v) in offsets_of(Some(st)) {
                if v > 0.0 && !row.dests.contains(&k) {
                    row.dests.push(k);
                }
            }
            match st.get("attributed") {
                Some(Json::Bool(true)) => row.attributed = Some(true),
                Some(Json::Bool(false)) if row.attributed.is_none() => row.attributed = Some(false),
                _ => {}
            }
        }
    }
    for row in rows.iter_mut() {
        row.dests.sort();
        if row.dests.iter().any(|d| d != "letai") {
            row.attributed = Some(true);
        }
    }
    rows.sort_by(|a, b| b.sessions.cmp(&a.sessions));
    rows.into_iter()
        .map(|r| {
            let unlinked = r.repo.is_some() && r.attributed == Some(false);
            obj(vec![
                ("id", Json::str(&r.id)),
                ("family", Json::str(&r.family)),
                ("tool", Json::str(&family_label(&r.family))),
                ("path", Json::str(&r.path)),
                ("sessions", Json::num(r.sessions as f64)),
                ("repo", Json::opt_str(r.repo.as_deref())),
                ("branch", r.branch.map(Json::Str).unwrap_or(Json::Null)),
                ("dests", strings(&r.dests)),
                ("lastUploadAtMs", Json::num(r.last_upload)),
                ("attributed", r.attributed.map(Json::Bool).unwrap_or(Json::Null)),
                ("unlinkedRepo", Json::Bool(unlinked)),
            ])
        })
        .collect()
}

/// `groupDestinations`.
fn group_destinations(facts: &[Fact], names: &OMap) -> Vec<Json> {
    struct Row {
        key: String,
        label: String,
        personal: bool,
        sessions: u64,
        bytes: f64,
        last_upload: f64,
        blocked: Option<(u64, Json, Json)>,
        folder_ids: Vec<String>,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for f in facts {
        let st = match &f.state {
            Some(s) => s,
            None => continue,
        };
        let folder = folder_id_for(&f.family(), &f.cwd());
        for (key, uploaded) in offsets_of(Some(st)) {
            if uploaded <= 0.0 {
                continue;
            }
            let i = *index.entry(key.clone()).or_insert_with(|| {
                rows.push(Row { key: key.clone(), label: dest_label_for(&key, names), personal: key == "letai", sessions: 0, bytes: 0.0, last_upload: 0.0, blocked: None, folder_ids: Vec::new() });
                rows.len() - 1
            });
            let row = &mut rows[i];
            row.sessions += 1;
            row.bytes += uploaded;
            row.last_upload = row.last_upload.max(f.last_upload());
            if !row.folder_ids.contains(&folder) {
                row.folder_ids.push(folder.clone());
            }
        }
        if let Some(blocker) = st.get("blocker").filter(|b| b.truthy()) {
            let reason = blocker.get("reason").cloned().unwrap_or(Json::Null);
            if let Some(dests) = blocker.get("destinations").and_then(|d| d.as_arr()) {
                for dest in dests {
                    let key = match dest.get_string("vaultOrgId") {
                        Some(k) => k,
                        None => continue,
                    };
                    if let Some(&i) = index.get(&key) {
                        let row = &mut rows[i];
                        let org = dest.get("orgName").filter(|v| !v.is_null()).cloned();
                        let prev_sessions = row.blocked.as_ref().map(|b| b.0).unwrap_or(0);
                        let prev_org = row.blocked.as_ref().map(|b| b.2.clone()).filter(|v| !v.is_null());
                        row.blocked = Some((prev_sessions + 1, reason.clone(), org.clone().or(prev_org).unwrap_or(Json::Null)));
                        if let Some(o) = org.filter(|v| v.truthy()) {
                            row.label = lossy(&o.to_js_string());
                        }
                    }
                }
            }
        }
    }
    rows.sort_by(|a, b| (a.personal as u8).cmp(&(b.personal as u8)).then(b.bytes.partial_cmp(&a.bytes).unwrap_or(std::cmp::Ordering::Equal)));
    rows.into_iter()
        .map(|r| {
            obj(vec![
                ("key", Json::str(&r.key)),
                ("label", Json::str(&r.label)),
                ("personal", Json::Bool(r.personal)),
                ("sessions", Json::num(r.sessions as f64)),
                ("folders", Json::num(r.folder_ids.len() as f64)),
                ("bytes", Json::num(r.bytes)),
                ("lastUploadAtMs", Json::num(r.last_upload)),
                ("blocked", r.blocked.map(|(s, reason, org)| obj(vec![("sessions", Json::num(s as f64)), ("reason", reason), ("orgName", org)])).unwrap_or(Json::Null)),
            ])
        })
        .collect()
}

/// The roots this server describes: the daemon's stamp (device truth), else
/// this process's own resolution.
fn ui_effective_roots(state: &Json) -> (ResolvedRoots, &'static str) {
    if let Some(er) = state.get("effectiveRoots").filter(|v| v.truthy()) {
        let list = |key: &str| -> Vec<DataRoot> {
            er.get(key)
                .and_then(|a| a.as_arr())
                .map(|a| {
                    a.iter()
                        .map(|v| DataRoot {
                            config_dir: v.get_string("configDir").unwrap_or_default(),
                            origin: match v.get_string("origin").as_deref() {
                                Some("settings") => "settings",
                                Some("env") => "env",
                                _ => "default",
                            },
                            exists: v.get("exists").and_then(|e| e.as_bool()).unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        return (ResolvedRoots { claude: list("claude"), codex: list("codex") }, "daemon");
    }
    (resolve_data_roots(&read_settings()), "local")
}

fn collect_facts(state: &Json) -> (Vec<Fact>, ResolvedRoots, &'static str) {
    let (roots, from) = ui_effective_roots(state);
    let cached = cached_discovery(&roots, false);
    let mut files = freshen_sizes(&cached.claude, state);
    files.extend(freshen_sizes(&cached.codex, state));
    let heads = heads_for(&files);
    let facts = files
        .into_iter()
        .map(|file| {
            let head = heads.get(&file.path).cloned().unwrap_or_default();
            let st = state.get("files").and_then(|m| m.get(&file.path)).cloned();
            Fact { file, head, state: st }
        })
        .collect();
    (facts, roots, from)
}

fn build_data_root_vms(roots: &ResolvedRoots, files: &[&DiscoveredFile]) -> Vec<Json> {
    let mut count: HashMap<&str, u64> = HashMap::new();
    for f in files {
        *count.entry(f.root_dir.as_str()).or_insert(0) += 1;
    }
    let rows = |family: &str, list: &[DataRoot]| -> Vec<Json> {
        list.iter()
            .map(|r| {
                obj(vec![
                    ("family", Json::str(family)),
                    ("configDir", Json::str(&r.config_dir)),
                    ("display", Json::str(&collapse_home(&r.config_dir))),
                    ("origin", Json::str(r.origin)),
                    ("exists", Json::Bool(r.exists)),
                    ("files", Json::num(*count.get(r.config_dir.as_str()).unwrap_or(&0) as f64)),
                ])
            })
            .collect()
    };
    let mut out = rows("claude", &roots.claude);
    out.extend(rows("codex", &roots.codex));
    out
}

/// `detectShellRoots`: env roots this process sees that the effective set misses.
fn detect_shell_roots(self_resolved: &ResolvedRoots, effective: &ResolvedRoots) -> Json {
    let mut out = Json::obj();
    for (family, mine, eff, def) in [
        ("claude", &self_resolved.claude, &effective.claude, DEFAULT_CLAUDE_ROOT.as_str()),
        ("codex", &self_resolved.codex, &effective.codex, DEFAULT_CODEX_ROOT.as_str()),
    ] {
        let env = match mine.iter().find(|r| r.origin == "env") {
            Some(e) => e,
            None => continue,
        };
        if eff.iter().any(|r| same_physical_dir(&r.config_dir, &env.config_dir)) {
            continue;
        }
        if def == env.config_dir || def.starts_with(&format!("{}/", env.config_dir)) {
            continue;
        }
        out.set(family, Json::str(&env.config_dir));
    }
    out
}

/// `new URL(url).host`, None when the text is not a URL.
fn url_host(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once("://")?;
    let mut chars = scheme.chars();
    if !chars.next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) || !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
        return None;
    }
    let host = crate::connect::host_of(url);
    if host.is_empty() || host == url {
        None
    } else {
        Some(host)
    }
}

/// `buildSnapshot`.
pub fn build_snapshot() -> Json {
    let state = read_state_json("main");
    let cfg = crate::config::read_config_raw();
    let (facts, roots, roots_from) = collect_facts(&state);
    let settings = read_settings();
    let unwindowed = cached_discovery(&roots, true);
    let mut all = freshen_sizes(&unwindowed.claude, &state);
    all.extend(freshen_sizes(&unwindowed.codex, &state));
    let report = crate::report::compute_sync_report_from(&state, &roots, all, &settings);
    let gateway = cfg.as_ref().and_then(|c| c.get_string("gatewayBaseUrl")).unwrap_or_default();
    let doctor = crate::diagnostics::build_sync_doctor_report(&report, &gateway, now_ms(), Some(&roots));
    let file_refs: Vec<&DiscoveredFile> = facts.iter().map(|f| &f.file).collect();
    let data_roots = build_data_root_vms(&roots, &file_refs);
    let shell_detected = detect_shell_roots(&resolve_data_roots(&settings), &roots);
    let ops = crate::daemon_state::get_daemon_ops();
    let ds = ops.state();
    let daemon = obj(vec![("managerName", Json::str(ops.manager_name)), ("loaded", Json::Bool(ds.loaded)), ("pid", ds.pid.map(|p| Json::num(p as f64)).unwrap_or(Json::Null))]);
    let folders = group_folders(&facts);
    let destinations = group_destinations(&facts, &crate::orgnames::read_org_names());
    let last_upload = facts.iter().fold(0.0f64, |m, f| m.max(f.last_upload()));
    let gateway_host = cfg.as_ref().and_then(|c| c.get_string("gatewayBaseUrl")).filter(|g| !g.is_empty()).and_then(|g| url_host(&g));
    let device_name = match cfg.as_ref().and_then(|c| c.get("deviceName")) {
        Some(v) => v.clone(),
        None => Json::Null,
    };
    let connected = cfg.as_ref().and_then(|c| c.get("accessToken")).map(|v| v.truthy()).unwrap_or(false);
    let mut recent: Vec<&Fact> = facts.iter().filter(|f| f.last_upload() > 0.0).collect();
    recent.sort_by(|a, b| b.last_upload().partial_cmp(&a.last_upload()).unwrap_or(std::cmp::Ordering::Equal));
    let recent: Vec<Json> = recent
        .into_iter()
        .take(20)
        .map(|f| {
            obj(vec![
                ("atMs", Json::num(f.last_upload())),
                ("title", f.head.title.clone().map(Json::Str).unwrap_or_else(|| Json::str(&basename(&f.file.path, "")))),
                ("folder", Json::str(&f.cwd())),
                ("family", Json::str(&f.head.family)),
                ("dests", strings(&f.dests())),
                ("sizeBytes", Json::num(f.file.size as f64)),
            ])
        })
        .collect();
    obj(vec![
        ("generatedAt", Json::num(now_ms())),
        (
            "device",
            obj(vec![
                ("name", device_name),
                ("platform", Json::str(crate::daemon_state::node_platform())),
                ("arch", Json::str(crate::connect::node_arch())),
                ("hxVersion", Json::str(crate::HX_VERSION)),
                ("connected", Json::Bool(connected)),
                ("gatewayHost", Json::opt_str(gateway_host.as_deref())),
                ("daemon", daemon),
            ]),
        ),
        (
            "sync",
            obj(vec![
                ("total", Json::num(report.snapshot_total as f64)),
                ("done", Json::num(report.snapshot_done as f64)),
                ("totalBytes", Json::num(report.snapshot_total_bytes as f64)),
                ("behind", Json::num(report.behind.len() as f64)),
                ("waiting", Json::num(report.skipped.len() as f64)),
                ("unwatched", Json::num(report.unwatched as f64)),
                ("lastUploadAtMs", Json::num(last_upload)),
            ]),
        ),
        ("folders", Json::Arr(folders)),
        ("destinations", Json::Arr(destinations)),
        ("recent", Json::Arr(recent)),
        ("doctor", doctor.json),
        ("dataRoots", Json::Arr(data_roots)),
        ("dataRootsFrom", Json::str(roots_from)),
        ("shellDetected", shell_detected),
    ])
}

/// `buildSessions(folderId)`.
pub fn build_sessions(folder_id: &str) -> Json {
    let state = read_state_json("main");
    let (facts, _, _) = collect_facts(&state);
    let mut out: Vec<(f64, Json)> = Vec::new();
    for f in &facts {
        let family = f.family();
        if folder_id_for(&family, &f.cwd()) != folder_id {
            continue;
        }
        let uploaded = f.state.as_ref().map(fs_min_offset).unwrap_or(0.0);
        let session_id = f.head.session_id.clone().unwrap_or_else(|| basename(&f.file.path, ".jsonl"));
        let state_family = f.state.as_ref().and_then(|s| s.get_string("family")).unwrap_or_else(|| family.clone());
        let deleted = Store::is_deleted_session(&state, &state_family, &session_id);
        let last = match f.state.as_ref().and_then(|s| s.get("lastUploadAtMs")) {
            Some(Json::Num(n)) => *n,
            _ => 0.0,
        };
        let size = f.file.size as f64;
        out.push((
            last,
            obj(vec![
                ("id", Json::str(&f.head.session_id.clone().unwrap_or_else(|| basename(&f.file.path, "")))),
                ("path", Json::str(&f.file.path)),
                ("title", f.head.title.clone().map(Json::Str).unwrap_or_else(|| Json::str(&basename(&f.file.path, ".jsonl")))),
                ("sizeBytes", Json::num(size)),
                ("uploadedBytes", Json::num(uploaded)),
                ("pendingBytes", Json::num(if deleted { 0.0 } else { (size - uploaded).max(0.0) })),
                ("lastUploadAtMs", Json::num(last)),
                ("dests", strings(&f.dests())),
                ("deleted", Json::Bool(deleted)),
            ]),
        ));
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Json::Arr(out.into_iter().map(|(_, j)| j).collect())
}

/// `isDiscoveredPath`: only paths the windowed view lists may be previewed.
pub fn is_discovered_path(p: &str) -> bool {
    let state = read_state_json("main");
    let (roots, _) = ui_effective_roots(&state);
    let cached = cached_discovery(&roots, false);
    cached.claude.iter().any(|f| f.path == p) || cached.codex.iter().any(|f| f.path == p)
}

// ── Logs, activity, whoami, probe ───────────────────────────────────────────

/// `classifyLogLine`.
pub fn classify_log_line(body: &str) -> &'static str {
    // /\(\+[\d,]+B/
    let mut rest = body;
    while let Some(i) = rest.find("(+") {
        let after = &rest[i + 2..];
        let run: usize = after.chars().take_while(|c| c.is_ascii_digit() || *c == ',').count();
        if run > 0 && after[run..].starts_with('B') {
            return "up";
        }
        rest = after;
    }
    // /failed=[1-9]/
    let mut rest = body;
    while let Some(i) = rest.find("failed=") {
        let after = &rest[i + "failed=".len()..];
        if after.chars().next().map(|c| ('1'..='9').contains(&c)).unwrap_or(false) {
            return "warn";
        }
        rest = after;
    }
    let lower = body.to_lowercase();
    if lower.contains("[error]") || lower.contains("warn") || lower.contains("not progressing") || lower.contains("backing off") || lower.contains("unavailable") {
        return "warn";
    }
    // error[:\s]
    let units: Vec<u16> = lower.encode_utf16().collect();
    let pat: Vec<u16> = "error".encode_utf16().collect();
    let mut i = 0;
    while i + pat.len() < units.len() {
        if units[i..i + pat.len()] == pat[..] {
            let c = units[i + pat.len()];
            if c == b':' as u16 || crate::js::is_space(c) {
                return "warn";
            }
        }
        i += 1;
    }
    "info"
}

const LOG_TAIL_MAX: u64 = 256 * 1024;

/// `tailDaemonLog`: stdout.log's last lines, continuing into stdout.log.1.
pub fn tail_daemon_log(max_lines: f64) -> Json {
    let (lines, _) = crate::logs::recent_log_lines(&crate::service::stdout_log(), max_lines, Some(LOG_TAIL_MAX));
    Json::Arr(
        lines
            .into_iter()
            .filter(|l| !l.trim().is_empty())
            .map(|body| {
                let level = classify_log_line(&body);
                obj(vec![("body", Json::str(&body)), ("level", Json::str(level))])
            })
            .collect(),
    )
}

const ACTIVITY_MAX_HOURS: f64 = 7.0 * 24.0;
const ACTIVITY_READ_CAP: u64 = 4 * 1024 * 1024;

/// `readActivity(sinceMs)`: the journal's entries since then (last 4 MB).
fn read_activity(since_ms: f64) -> Vec<Json> {
    let path = crate::home::hx_dir().join("activity.jsonl");
    let mut f = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return Vec::new(),
    };
    let start = size.saturating_sub(ACTIVITY_READ_CAP);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.take(size - start).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let text = if start > 0 { text[text.find('\n').map(|i| i + 1).unwrap_or(0)..].to_string() } else { text };
    let mut out = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let e = match Json::parse(line) {
            Ok(v) if v.as_obj().is_some() => v,
            _ => continue,
        };
        let at = match e.get("at") {
            Some(Json::Num(n)) => *n,
            _ => continue,
        };
        let bytes = match e.get("bytes") {
            Some(Json::Num(n)) => *n,
            _ => continue,
        };
        let dest = match e.get("dest") {
            Some(Json::Str(_)) => e.get("dest").cloned().unwrap_or(Json::Null),
            _ => continue,
        };
        let session = match e.get("sessionId") {
            Some(Json::Str(_)) => e.get("sessionId").cloned().unwrap_or(Json::Null),
            _ => continue,
        };
        if at < since_ms {
            continue;
        }
        let family = match e.get("family") {
            Some(Json::Str(_)) => e.get("family").cloned().unwrap_or(Json::Null),
            _ => Json::str("unknown"),
        };
        out.push(obj(vec![("at", Json::num(at)), ("sessionId", session), ("family", family), ("bytes", Json::num(bytes)), ("dest", dest)]));
    }
    out
}

/// `activitySince(hours)`, hours clamped to 1..168.
pub fn activity_since(hours: f64) -> Json {
    let h = hours.max(1.0).min(ACTIVITY_MAX_HOURS);
    Json::Arr(read_activity(now_ms() - h * 3_600_000.0))
}

const WHOAMI_TTL_MS: f64 = 5.0 * 60_000.0;

/// `cachedWhoami`: the email for the identity chip, cached 5 minutes.
pub fn cached_whoami() -> Json {
    static CACHE: OnceLock<Mutex<Option<(f64, Json)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, email)) = cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if now_ms() - at < WHOAMI_TTL_MS {
            return obj(vec![("email", email.clone())]);
        }
    }
    let cfg = crate::config::read_config_raw();
    let token = cfg.as_ref().and_then(|c| c.get("accessToken")).filter(|v| v.truthy()).cloned();
    let base = cfg.as_ref().and_then(|c| c.get("gatewayBaseUrl")).filter(|v| v.truthy()).cloned();
    let (token, base) = match (token, base) {
        (Some(t), Some(b)) => (lossy(&t.to_js_string()), lossy(&b.to_js_string())),
        _ => return obj(vec![("email", Json::Null)]),
    };
    let url = format!("{}/whoami", base);
    let email = (|| -> Option<Json> {
        crate::net::assert_secure_fetch_url(&url, "gateway").ok()?;
        let res = crate::net::request("whoami", "GET", &url, &[("authorization", format!("Bearer {}", token))], None, 6_000).ok()?;
        if !res.ok() {
            return Some(Json::Null);
        }
        let body = Json::parse(&res.text()).ok()?;
        Some(match body.get("email") {
            None | Some(Json::Null) => Json::Null,
            Some(v) => v.clone(),
        })
    })()
    .unwrap_or(Json::Null);
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms(), email.clone()));
    obj(vec![("email", email)])
}

/// The UI's probe: `{ up: false, reason: "not connected" }` with no config.
pub fn probe_json() -> Json {
    let cfg = match crate::config::read_config() {
        Some(c) => c,
        None => return obj(vec![("up", Json::Bool(false)), ("reason", Json::str("not connected"))]),
    };
    let p = crate::probe::probe_connection(&cfg);
    if !p.up {
        return obj(vec![("up", Json::Bool(false)), ("reason", Json::str(&p.reason.unwrap_or_default()))]);
    }
    let mut o = obj(vec![("up", Json::Bool(true)), ("latencyMs", Json::num(p.latency_ms))]);
    if let Some(b) = p.bytes_per_sec {
        o.set("bytesPerSec", Json::num(b));
    }
    o.set("quality", Json::str(p.quality));
    o
}

// ── Settings ────────────────────────────────────────────────────────────────

const KNOWN_SETTINGS: [&str; 5] = ["pause", "personalSync", "excludedFolders", "excludeRules", "dataDirs"];

fn data_dirs_json(claude: &[String], codex: &[String]) -> Json {
    obj(vec![("claude", strings(claude)), ("codex", strings(codex))])
}

fn default_settings_json() -> Json {
    obj(vec![
        ("pause", Json::Null),
        ("personalSync", Json::Bool(true)),
        ("excludedFolders", Json::Arr(Vec::new())),
        ("excludeRules", Json::Arr(Vec::new())),
        ("dataDirs", data_dirs_json(&[], &[])),
    ])
}

/// settings.ts `readSettings` as the object it returns: the unknown keys as
/// they are, then the five known ones normalized.
pub fn read_settings_json() -> Json {
    let raw = match fs::read_to_string(settings_path()) {
        Ok(r) => r,
        Err(_) => return default_settings_json(),
    };
    let parsed = match Json::parse(&raw) {
        Ok(v) if !v.is_null() => v,
        _ => return default_settings_json(),
    };
    let mut out = OMap::new();
    if let Some(o) = parsed.as_obj() {
        for (k, v) in o.iter() {
            if !KNOWN_SETTINGS.contains(&k.as_str()) {
                out.set(k, v.clone());
            }
        }
    }
    let pause = match parsed.get("pause") {
        Some(Json::Obj(p)) => obj(vec![("untilMs", match p.get("untilMs") {
            Some(Json::Num(n)) => Json::num(*n),
            _ => Json::Null,
        })]),
        Some(Json::Arr(_)) => obj(vec![("untilMs", Json::Null)]),
        _ => Json::Null,
    };
    out.set("pause", pause);
    out.set("personalSync", Json::Bool(!matches!(parsed.get("personalSync"), Some(Json::Bool(false)))));
    let folders = match parsed.get("excludedFolders") {
        Some(Json::Arr(list)) => list.iter().filter(|f| matches!(f.get("family"), Some(Json::Str(_))) && matches!(f.get("cwd"), Some(Json::Str(_)))).cloned().collect(),
        _ => Vec::new(),
    };
    out.set("excludedFolders", Json::Arr(folders));
    let rules = match parsed.get("excludeRules") {
        Some(Json::Arr(list)) => list.iter().filter(|r| matches!(r, Json::Str(_))).cloned().collect(),
        _ => Vec::new(),
    };
    out.set("excludeRules", Json::Arr(rules));
    let dirs = parse_data_dirs(parsed.get("dataDirs"));
    out.set("dataDirs", data_dirs_json(&dirs.claude, &dirs.codex));
    Json::Obj(out)
}

/// Writes are read-merge-write, one at a time, each through its own tmp name.
fn settings_write_seq() -> &'static Mutex<u64> {
    static SEQ: OnceLock<Mutex<u64>> = OnceLock::new();
    SEQ.get_or_init(|| Mutex::new(0))
}

/// `writeSettings(patch)`: `{ ...current, ...patch }`, dataDirs merged per
/// family and normalized, written pretty with mode 0600.
pub fn write_settings_json(patch: &Json) -> Result<Json, String> {
    let mut seq = settings_write_seq().lock().unwrap_or_else(|e| e.into_inner());
    let current = read_settings_json();
    let mut next = current.clone();
    if let Some(p) = patch.as_obj() {
        for (k, v) in p.iter() {
            next.set(k, v.clone());
        }
    }
    let cur_dirs = |family: &str| -> Json { current.get("dataDirs").and_then(|d| d.get(family)).cloned().unwrap_or(Json::Arr(Vec::new())) };
    let merged = match patch.get("dataDirs") {
        Some(Json::Obj(pd)) => {
            let pick = |family: &str| match pd.get(family) {
                Some(Json::Arr(a)) => Json::Arr(a.clone()),
                _ => cur_dirs(family),
            };
            obj(vec![("claude", pick("claude")), ("codex", pick("codex"))])
        }
        _ => current.get("dataDirs").cloned().unwrap_or_else(|| data_dirs_json(&[], &[])),
    };
    let dirs = parse_data_dirs(Some(&merged));
    next.set("dataDirs", data_dirs_json(&dirs.claude, &dirs.codex));
    *seq += 1;
    let path = settings_path();
    let tmp = std::path::PathBuf::from(format!("{}.{}.{}.tmp", path.to_string_lossy(), std::process::id(), *seq));
    crate::fsutil::write_file_0600_node(&tmp, next.stringify_pretty().as_bytes())?;
    fs::rename(&tmp, &path).map_err(|e| crate::fsutil::node_rename_error(&e, &tmp, &path))?;
    Ok(next)
}

/// `dataDirsPatchError`: strict validation of an API write.
pub fn data_dirs_patch_error(v: Option<&Json>) -> Option<String> {
    let o = match v {
        Some(Json::Obj(o)) => o,
        _ => return Some("dataDirs must be an object".to_string()),
    };
    for (k, _) in o.iter() {
        if k != "claude" && k != "codex" {
            return Some(format!("unknown dataDirs family: {}", k));
        }
    }
    for family in ["claude", "codex"] {
        let list = match o.get(family) {
            None => continue,
            Some(Json::Arr(l)) => l,
            Some(_) => return Some(format!("dataDirs.{} must be an array", family)),
        };
        if list.len() > MAX_DATA_DIRS_PER_FAMILY {
            return Some(format!("dataDirs.{}: at most {} locations", family, MAX_DATA_DIRS_PER_FAMILY));
        }
        for item in list {
            let s = match item.as_string() {
                Some(s) => s,
                None => return Some(format!("dataDirs.{}: entries must be strings", family)),
            };
            if normalize_data_dir(&s).is_none() {
                return Some(format!("dataDirs.{}: not an absolute (or ~-prefixed) path", family));
            }
        }
    }
    None
}

/// `duplicateRootError`: a NEW entry that is an already-watched location in disguise.
pub fn duplicate_root_error(v: &Json, existing: Option<&Json>) -> Option<String> {
    let prior_of = |family: &str| -> Vec<String> {
        existing.and_then(|e| e.get(family)).and_then(|l| l.as_arr()).map(|l| l.iter().filter_map(|x| x.as_string()).collect()).unwrap_or_default()
    };
    let check = |list: Option<&Json>, prior: Vec<String>, def: &str, label: &str| -> Option<String> {
        let items = match list {
            Some(Json::Arr(a)) => a,
            _ => return None,
        };
        let mut accepted: Vec<String> = Vec::new();
        for item in items {
            let s = match item.as_string() {
                Some(s) => s,
                None => continue,
            };
            let dir = match normalize_data_dir(&s) {
                Some(d) => d,
                None => continue,
            };
            if prior.contains(&dir) {
                accepted.push(dir);
                continue;
            }
            if same_physical_dir(&dir, def) {
                return Some(format!("{}: that location is already watched by default", label));
            }
            if prior.iter().any(|p| same_physical_dir(p, &dir)) || accepted.iter().any(|a| same_physical_dir(a, &dir)) {
                return Some(format!("{}: that location is already watched", label));
            }
            accepted.push(dir);
        }
        None
    };
    check(v.get("claude"), prior_of("claude"), DEFAULT_CLAUDE_ROOT.as_str(), "dataDirs.claude").or_else(|| check(v.get("codex"), prior_of("codex"), DEFAULT_CODEX_ROOT.as_str(), "dataDirs.codex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_levels() {
        assert_eq!(classify_log_line("[hx] a.jsonl (+12,345B)"), "up");
        assert_eq!(classify_log_line("done. uploaded=1 failed=2"), "warn");
        assert_eq!(classify_log_line("heartbeat error: boom"), "warn");
        assert_eq!(classify_log_line("all good"), "info");
    }

    #[test]
    fn preview_lines_clip_and_keep_the_last_twelve() {
        let mut raw: Vec<String> = Vec::new();
        for i in 0..14 {
            raw.push(format!("{{\"type\":\"user\",\"message\":{{\"content\":\"hello   {}\"}}}}", i));
        }
        let lines = extract_preview_lines(&raw);
        assert_eq!(lines.len(), 12);
        assert_eq!(lossy(&lines[0].1), "hello 2");
    }
}
