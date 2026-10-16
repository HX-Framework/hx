//! Source-path discovery and family classification (src/sources.ts): the
//! Claude Code transcripts, the Codex rollouts, and the child execution
//! lanes (subagent and workflow-agent transcripts, workflow runs) under a
//! session's artifact directory.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::fsutil::{basename, join, readdir_safe, resolve, stat_safe};
use crate::js::{js, lossy, JsStr};
use crate::json::Json;
use crate::roots::{claude_projects_dir, codex_archived_dir, codex_sessions_dir, DataRoot};

pub const RECENT_WINDOW_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

#[derive(Clone, Debug)]
pub struct DiscoveredFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    /// "claude" | "codex"
    pub source: &'static str,
    pub root_dir: String,
}

/// All recent Claude-projects jsonls across the roots. `max_age_ms` None
/// lifts the 30-day window (the unwindowed sweeps).
pub fn discover_claude_files(roots: &[DataRoot], max_age_ms: Option<f64>, now: f64) -> Vec<DiscoveredFile> {
    let max_age = max_age_ms.unwrap_or(f64::INFINITY);
    let mut candidates: Vec<(String, String)> = Vec::new();
    for root in roots {
        let projects = claude_projects_dir(&root.config_dir);
        let names = match fs::read_dir(&projects) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(),
            Err(_) => continue,
        };
        for dir in names {
            if dir.starts_with('.') || dir == "memory" {
                continue;
            }
            let full = join(&projects, &dir);
            let st = match stat_safe(Path::new(&full)) {
                Some(st) if st.is_dir => st,
                _ => continue,
            };
            if now - st.mtime_ms > max_age {
                continue;
            }
            for f in readdir_safe(Path::new(&full)) {
                if f.ends_with(".jsonl") {
                    candidates.push((join(&full, &f), root.config_dir.clone()));
                }
            }
        }
    }
    let mut out = Vec::new();
    for (path, root_dir) in candidates {
        let st = match stat_safe(Path::new(&path)) {
            Some(st) => st,
            None => continue,
        };
        if st.is_dir || st.size == 0 {
            continue;
        }
        if now - st.mtime_ms > max_age {
            continue;
        }
        out.push(DiscoveredFile { path, size: st.size, mtime_ms: st.mtime_ms, source: "claude", root_dir });
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct HeadMeta {
    pub session_id: Option<String>,
    /// claude-desktop | claude-cli | codex-desktop | codex-cli | unknown
    pub family: String,
    pub cwd: Option<JsStr>,
    pub git_branch: Option<JsStr>,
    pub repo_slug: Option<String>,
    pub entrypoint: Option<JsStr>,
    pub originator: Option<JsStr>,
    pub model_provider: Option<JsStr>,
    pub title: Option<JsStr>,
}

impl HeadMeta {
    pub fn cwd_string(&self) -> Option<String> {
        self.cwd.as_ref().map(|c| lossy(c))
    }
}

/// Read the head of a jsonl (the first 64 non-empty lines) for the session
/// id, the family and the light metadata the commit carries.
pub fn read_head(file_path: &str, source: &str, resolve_repo_from_disk: bool) -> HeadMeta {
    let mut out = HeadMeta { family: "unknown".to_string(), ..Default::default() };
    if let Ok(f) = fs::File::open(file_path) {
        let mut reader = BufReader::with_capacity(64 * 1024, f);
        let mut n = 0;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            let read = match reader.read_until(b'\n', &mut buf) {
                Ok(r) => r,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }
            if buf.last() == Some(&b'\n') {
                buf.pop();
            }
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            if buf.is_empty() {
                continue;
            }
            n += 1;
            let text = String::from_utf8_lossy(&buf);
            let d = match Json::parse(&text) {
                Ok(v) if v.as_obj().is_some() => v,
                _ => {
                    if n >= 64 {
                        break;
                    }
                    continue;
                }
            };
            if source == "claude" {
                if out.session_id.is_none() {
                    if let Some(s) = d.get_string("sessionId") {
                        out.session_id = Some(s);
                    }
                }
                if out.cwd.is_none() {
                    if let Some(Json::Str(s)) = d.get("cwd") {
                        out.cwd = Some(s.clone());
                    }
                }
                if let Some(Json::Str(s)) = d.get("gitBranch") {
                    out.git_branch = Some(s.clone());
                }
                if out.entrypoint.is_none() {
                    if let Some(Json::Str(s)) = d.get("entrypoint") {
                        out.entrypoint = Some(s.clone());
                    }
                }
            } else {
                let kind = d.get_string("type").unwrap_or_default();
                if kind == "session_meta" {
                    if let Some(p) = d.get("payload").filter(|p| p.as_obj().is_some()) {
                        if let Some(Json::Str(s)) = p.get("cwd") {
                            out.cwd = Some(s.clone());
                        }
                        if let Some(Json::Str(s)) = p.get("originator") {
                            out.originator = Some(s.clone());
                        }
                        if let Some(Json::Str(s)) = p.get("model_provider") {
                            out.model_provider = Some(s.clone());
                        }
                        if out.session_id.is_none() {
                            if let Some(s) = p.get_string("id") {
                                out.session_id = Some(s);
                            }
                        }
                    }
                }
                if kind == "thread_meta" {
                    if let Some(p) = d.get("payload").filter(|p| p.as_obj().is_some()) {
                        if let Some(Json::Str(s)) = p.get("title") {
                            out.title = Some(s.clone());
                        }
                    }
                }
            }
            if n >= 64 {
                break;
            }
        }
    }

    // Family classification.
    if source == "claude" {
        let ep = out.entrypoint.as_ref().map(|e| lossy(e));
        out.family = match ep.as_deref() {
            Some("claude-desktop") => "claude-desktop",
            Some("cli") | Some("claude-code-vscode") => "claude-cli",
            None => "claude-cli",
            Some(other) => {
                if other.contains("desktop") {
                    "claude-desktop"
                } else {
                    "claude-cli"
                }
            }
        }
        .to_string();
    } else {
        let origin = out.originator.as_ref().map(|o| lossy(o).to_lowercase()).unwrap_or_default();
        out.family = if origin.contains("desktop") {
            "codex-desktop"
        } else {
            "codex-cli"
        }
        .to_string();
    }

    if out.session_id.is_none() {
        let stem = basename(file_path, ".jsonl");
        if source == "codex" {
            let parts: Vec<&str> = stem.split('-').collect();
            if parts.len() >= 6 {
                out.session_id = Some(parts[parts.len() - 5..].join("-"));
            } else {
                out.session_id = Some(stem);
            }
        } else {
            out.session_id = Some(stem);
        }
    }

    if let Some(cwd) = out.cwd_string() {
        let from_disk = if resolve_repo_from_disk { detect_repo_slug(&cwd) } else { None };
        out.repo_slug = from_disk.or_else(|| repo_slug_from_encoded_cwd(&cwd));
    }
    out
}

/// Normalize a git remote URL to a lowercase `owner/name` GitHub slug.
pub fn normalize_github_slug(url: &str) -> Option<String> {
    let t = url.trim();
    let lower = t.to_lowercase();
    let at = lower.find("github.com")?;
    let rest = &t[at + "github.com".len()..];
    let b = rest.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b':' || b[i] == b'/') {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let rest = &rest[i..];
    let slash = rest.find('/')?;
    let owner = &rest[..slash];
    if owner.is_empty() {
        return None;
    }
    let mut name = &rest[slash + 1..];
    if name.is_empty() {
        return None;
    }
    if name.ends_with('/') {
        name = &name[..name.len() - 1];
    }
    // `(.+?)(?:\.git)?\/?$`: the name must keep at least one character.
    let lname = name.to_lowercase();
    let mut name_str = name.to_string();
    if lname.ends_with(".git") && name.len() > 4 {
        name_str = name[..name.len() - 4].to_string();
    }
    if name_str.is_empty() {
        return None;
    }
    let owner = owner.to_lowercase();
    let name = name_str.to_lowercase();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!("{}/{}", owner, name))
}

fn read_origin_slug(config_path: &str) -> Option<String> {
    let text = fs::read_to_string(config_path).ok()?;
    let mut current_remote: Option<String> = None;
    let mut origin_slug: Option<String> = None;
    let mut first_slug: Option<String> = None;
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim();
        if line.starts_with('[') && line.ends_with(']') && line.len() >= 2 {
            let inner = line[1..line.len() - 1].trim();
            let lower = inner.to_lowercase();
            if lower.starts_with("remote") {
                let after = inner["remote".len()..].trim_start();
                if after.len() >= 2 && after.starts_with('"') && after.ends_with('"') && inner.len() > "remote".len() && inner.as_bytes()["remote".len()].is_ascii_whitespace() {
                    current_remote = Some(after[1..after.len() - 1].to_string());
                    continue;
                }
            }
            current_remote = None;
            continue;
        }
        if let Some(remote) = &current_remote {
            let lower = line.to_lowercase();
            if lower.starts_with("url") {
                let after = line["url".len()..].trim_start();
                if let Some(value) = after.strip_prefix('=') {
                    let value = value.trim_start();
                    if let Some(slug) = normalize_github_slug(value) {
                        if remote.eq_ignore_ascii_case("origin") && origin_slug.is_none() {
                            origin_slug = Some(slug.clone());
                        }
                        if first_slug.is_none() {
                            first_slug = Some(slug);
                        }
                    }
                }
            }
        }
    }
    origin_slug.or(first_slug)
}

fn is_slug_part(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Repo slug from an encoded `<prefix>@<owner>@<name>@<6 alnum>` path segment.
pub fn repo_slug_from_encoded_cwd(cwd: &str) -> Option<String> {
    let segments: Vec<&str> = cwd.split(|c| c == '/' || c == '\\').collect();
    for seg in segments.iter().rev() {
        let parts: Vec<&str> = seg.split('@').collect();
        if parts.len() != 4 {
            continue;
        }
        if parts[0].is_empty() || !is_slug_part(parts[1]) || !is_slug_part(parts[2]) {
            continue;
        }
        if parts[3].len() != 6 || !parts[3].chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        return Some(format!("{}/{}", parts[1].to_lowercase(), parts[2].to_lowercase()));
    }
    None
}

/// From a session's cwd, walk up to the nearest `.git` and read its origin slug.
pub fn detect_repo_slug(start_dir: &str) -> Option<String> {
    let mut dir = start_dir.to_string();
    for _ in 0..40 {
        let git_path = join(&dir, ".git");
        let pointer: Option<String> = match fs::read_to_string(&git_path) {
            Ok(p) => Some(p),
            Err(e) => {
                if crate::platform::is_dir_read_error(&e, Path::new(&git_path)) {
                    return read_origin_slug(&join(&git_path, "config"));
                }
                None
            }
        };
        if let Some(pointer) = pointer {
            let target = pointer
                .lines()
                .find_map(|l| l.strip_prefix("gitdir:").map(|t| t.trim().to_string()));
            if let Some(target) = target {
                let gitdir = if crate::fsutil::is_absolute(&target) { target } else { resolve(&dir, &target) };
                let mut config_path = join(&gitdir, "config");
                if fs::metadata(&config_path).is_err() {
                    if let Ok(common) = fs::read_to_string(join(&gitdir, "commondir")) {
                        config_path = join(&resolve(&gitdir, common.trim()), "config");
                    }
                }
                return read_origin_slug(&config_path);
            }
        }
        let parent = match Path::new(&dir).parent() {
            Some(p) => p.to_string_lossy().into_owned(),
            None => break,
        };
        if parent == dir {
            break;
        }
        dir = parent;
    }
    None
}

/// `collapseHome(head.cwd)` or the file's directory, as `ensureFileState` seeds it.
pub fn seeded_cwd(head: &HeadMeta, file_path: &str) -> String {
    match head.cwd_string() {
        Some(c) => crate::pathnorm::collapse_home(&c),
        None => crate::fsutil::dirname(file_path),
    }
}

/// `firstLineLabel` + `deriveFallbackTitle` (watch.ts).
const FALLBACK_TITLE_MAX: usize = 80;

pub fn first_line_label(text: Option<&[u16]>) -> Option<JsStr> {
    let text = text?;
    let first = crate::js::split_unit(text, 0x0A).first().copied().unwrap_or(&[]);
    let one_line = crate::js::collapse_spaces(crate::js::trim(first));
    if one_line.is_empty() {
        return None;
    }
    if one_line.len() <= FALLBACK_TITLE_MAX {
        return Some(one_line);
    }
    let clipped = crate::js::slice(&one_line, 0, FALLBACK_TITLE_MAX);
    let base: &[u16] = match crate::js::last_index_of_unit(clipped, 0x20) {
        Some(last_space) if (last_space as f64) >= (FALLBACK_TITLE_MAX as f64) * 0.6 => &clipped[..last_space],
        _ => clipped,
    };
    // `.replace(/[\s.,;:!?—-]+$/, "")`
    let mut end = base.len();
    while end > 0 {
        let c = base[end - 1];
        if crate::js::is_space(c) || matches!(c, 0x2E | 0x2C | 0x3B | 0x3A | 0x21 | 0x3F | 0x2014 | 0x2D) {
            end -= 1;
        } else {
            break;
        }
    }
    let mut out: JsStr = base[..end].to_vec();
    out.extend(js("…"));
    Some(out)
}

pub fn derive_fallback_title(first_user_text: Option<&[u16]>, cwd: Option<&[u16]>, repo_slug: Option<&str>) -> Option<JsStr> {
    if let Some(t) = first_line_label(first_user_text) {
        return Some(t);
    }
    if let Some(slug) = repo_slug {
        let repo = slug.split('/').last().unwrap_or("").trim();
        if !repo.is_empty() {
            return Some(js(repo));
        }
    }
    let cwd = cwd?;
    let s = lossy(cwd);
    let base = s
        .split(|c| c == '/' || c == '\\')
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .last()
        .map(|b| b.trim().to_string())?;
    if base.is_empty() {
        None
    } else {
        Some(js(&base))
    }
}

// ── Codex rollouts ──────────────────────────────────────────────────────────

/// All recent Codex rollout jsonls (sessions + archived) across the roots,
/// with the same date-dir mtime prune as the walk of the TypeScript client.
/// `max_age_ms` None lifts the 30-day window.
pub fn discover_codex_files(roots: &[DataRoot], include_archived: bool, max_age_ms: Option<f64>, now: f64) -> Vec<DiscoveredFile> {
    let max_age = max_age_ms.unwrap_or(f64::INFINITY);
    let mut candidates: Vec<(String, String)> = Vec::new();
    fn walk(dir: &str, root_dir: &str, now: f64, max_age: f64, candidates: &mut Vec<(String, String)>) {
        let rd = match fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut subdirs: Vec<String> = Vec::new();
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let full = join(dir, &name);
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                subdirs.push(full);
            } else if ft.is_file() && name.starts_with("rollout-") && name.ends_with(".jsonl") {
                candidates.push((full, root_dir.to_string()));
            }
        }
        for d in subdirs {
            let st = match stat_safe(Path::new(&d)) {
                Some(s) if s.is_dir => s,
                _ => continue,
            };
            if now - st.mtime_ms > max_age {
                continue;
            }
            walk(&d, root_dir, now, max_age, candidates);
        }
    }
    for root in roots {
        walk(&codex_sessions_dir(&root.config_dir), &root.config_dir, now, max_age, &mut candidates);
        if include_archived {
            walk(&codex_archived_dir(&root.config_dir), &root.config_dir, now, max_age, &mut candidates);
        }
    }
    let mut out = Vec::new();
    for (path, root_dir) in candidates {
        let st = match stat_safe(Path::new(&path)) {
            Some(st) => st,
            None => continue,
        };
        if st.is_dir || st.size == 0 {
            continue;
        }
        if now - st.mtime_ms > max_age {
            continue;
        }
        out.push(DiscoveredFile { path, size: st.size, mtime_ms: st.mtime_ms, source: "codex", root_dir });
    }
    out
}

// ── Child execution lanes (subagents + workflow agents) ─────────────────────
//
//   <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl (+ .meta.json)
//   <projects>/<slug>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl
//   <projects>/<slug>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
//   <projects>/<slug>/<sessionId>/workflows/scripts/<name>-<runId>.js
//
// The artifact dir follows the session's CURRENT cwd while the main jsonl
// stays under the slug of the cwd at session start, so children are found by
// scanning every project dir for session-id subdirectories.

#[derive(Clone, Debug)]
pub struct DiscoveredChildFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    /// The parent Claude session id (the <sessionId>/ dir the child lives under).
    pub parent_session_id: String,
    pub agent_id: String,
    /// Workflow run id when the child lives under subagents/workflows/<runId>/.
    pub run_id: Option<String>,
    /// Sibling agent-<agentId>.meta.json path, if present.
    pub meta_path: Option<String>,
    pub root_dir: String,
}

#[derive(Clone, Debug)]
pub struct DiscoveredWorkflowRun {
    pub parent_session_id: String,
    pub run_id: String,
    pub journal_path: Option<String>,
    /// Newest mtime across journal + script.
    pub mtime_ms: f64,
    pub script_path: Option<String>,
    /// The workflow's meta.name, recovered from the script filename.
    pub script_name: Option<String>,
}

/// The session-artifact dir a child lane lives under: everything before the
/// first `/subagents/` component (either separator).
pub fn session_dir_of_lane(child_path: &str) -> Option<String> {
    let b = child_path.as_bytes();
    let needle = b"subagents";
    let mut i = 0;
    while i + needle.len() + 2 <= b.len() {
        if (b[i] == b'/' || b[i] == b'\\') && &b[i + 1..i + 1 + needle.len()] == needle {
            let after = b[i + 1 + needle.len()];
            if after == b'/' || after == b'\\' {
                return Some(child_path[..i].to_string());
            }
        }
        i += 1;
    }
    None
}

/// `/^agent-([a-zA-Z0-9_-]+)\.jsonl$/`.
fn agent_file_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix("agent-")?;
    let id = rest.strip_suffix(".jsonl")?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some(id.to_string())
}

/// `/^(.+)-(wf_[a-zA-Z0-9-]+)\.js$/` → (name, runId). The greedy `(.+)` means
/// the LAST `-wf_` whose tail is `[a-zA-Z0-9-]+` wins.
fn script_file_parts(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".js")?;
    let mut search_end = stem.len();
    loop {
        let at = stem[..search_end].rfind("-wf_")?;
        let id = &stem[at + 1..];
        let tail = &id[3..];
        if at > 0 && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Some((stem[..at].to_string(), id.to_string()));
        }
        if at == 0 {
            return None;
        }
        search_end = at;
    }
}

/// Collect agent-*.jsonl files in one directory into `out`, windowed by `max_age_ms`.
fn collect_agent_files(dir: &str, parent_session_id: &str, run_id: Option<&str>, now: f64, root_dir: &str, out: &mut Vec<DiscoveredChildFile>, max_age_ms: f64) {
    for f in readdir_safe(Path::new(dir)) {
        let id = match agent_file_id(&f) {
            Some(i) => i,
            None => continue,
        };
        let p = join(dir, &f);
        let st = match stat_safe(Path::new(&p)) {
            Some(s) if !s.is_dir && s.size > 0 => s,
            _ => continue,
        };
        if now - st.mtime_ms > max_age_ms {
            continue;
        }
        let meta_path = join(dir, &format!("agent-{}.meta.json", id));
        let meta = if stat_safe(Path::new(&meta_path)).is_some() { Some(meta_path) } else { None };
        out.push(DiscoveredChildFile {
            path: p,
            size: st.size,
            mtime_ms: st.mtime_ms,
            parent_session_id: parent_session_id.to_string(),
            agent_id: id,
            run_id: run_id.map(|r| r.to_string()),
            meta_path: meta,
            root_dir: root_dir.to_string(),
        });
    }
}

/// Scan ONE session-artifact directory for child transcripts and workflow
/// runs, appending into the caller's shared vectors (the runs merge below
/// folds a run split across project dirs or roots into one entry).
pub fn scan_session_artifacts(
    session_dir: &str,
    session_id: &str,
    root_dir: &str,
    now: f64,
    children: &mut Vec<DiscoveredChildFile>,
    runs: &mut Vec<DiscoveredWorkflowRun>,
    max_age_ms: f64,
) {
    let subagents_dir = join(session_dir, "subagents");
    collect_agent_files(&subagents_dir, session_id, None, now, root_dir, children, max_age_ms);

    let wf_root = join(&subagents_dir, "workflows");
    for run_id in readdir_safe(Path::new(&wf_root)) {
        let run_dir = join(&wf_root, &run_id);
        let rst = match stat_safe(Path::new(&run_dir)) {
            Some(s) if s.is_dir => s,
            _ => continue,
        };
        collect_agent_files(&run_dir, session_id, Some(&run_id), now, root_dir, children, max_age_ms);
        let journal_path = join(&run_dir, "journal.jsonl");
        let jst = stat_safe(Path::new(&journal_path));
        if let Some(existing) = runs.iter_mut().find(|r| r.parent_session_id == session_id && r.run_id == run_id) {
            if let Some(j) = &jst {
                if !j.is_dir {
                    if existing.journal_path.is_none() {
                        existing.journal_path = Some(journal_path.clone());
                    }
                    existing.mtime_ms = existing.mtime_ms.max(j.mtime_ms);
                }
            }
            continue;
        }
        runs.push(DiscoveredWorkflowRun {
            parent_session_id: session_id.to_string(),
            run_id: run_id.clone(),
            journal_path: match &jst {
                Some(j) if !j.is_dir => Some(journal_path.clone()),
                _ => None,
            },
            mtime_ms: jst.map(|j| j.mtime_ms).unwrap_or(rst.mtime_ms),
            script_path: None,
            script_name: None,
        });
    }

    let scripts_dir = join(&join(session_dir, "workflows"), "scripts");
    for f in readdir_safe(Path::new(&scripts_dir)) {
        let (name, rid) = match script_file_parts(&f) {
            Some(x) => x,
            None => continue,
        };
        let script_path = join(&scripts_dir, &f);
        let sstat = match stat_safe(Path::new(&script_path)) {
            Some(s) if !s.is_dir => s,
            _ => continue,
        };
        if let Some(existing) = runs.iter_mut().find(|r| r.parent_session_id == session_id && r.run_id == rid) {
            existing.script_path = Some(script_path);
            existing.script_name = Some(name);
            existing.mtime_ms = existing.mtime_ms.max(sstat.mtime_ms);
        } else {
            runs.push(DiscoveredWorkflowRun {
                parent_session_id: session_id.to_string(),
                run_id: rid,
                journal_path: None,
                mtime_ms: sstat.mtime_ms,
                script_path: Some(script_path),
                script_name: Some(name),
            });
        }
    }
}

/// All recent child-lane transcripts and workflow runs across every project
/// dir of the roots. `max_age_ms` None lifts the window.
pub fn discover_claude_children(roots: &[DataRoot], max_age_ms: Option<f64>, now: f64) -> (Vec<DiscoveredChildFile>, Vec<DiscoveredWorkflowRun>) {
    let max_age = max_age_ms.unwrap_or(f64::INFINITY);
    let mut children: Vec<DiscoveredChildFile> = Vec::new();
    let mut runs: Vec<DiscoveredWorkflowRun> = Vec::new();
    for root in roots {
        let projects = claude_projects_dir(&root.config_dir);
        for dir in readdir_safe(Path::new(&projects)) {
            if dir.starts_with('.') || dir == "memory" {
                continue;
            }
            let project_dir = join(&projects, &dir);
            let pst = match stat_safe(Path::new(&project_dir)) {
                Some(s) if s.is_dir => s,
                _ => continue,
            };
            if now - pst.mtime_ms > max_age {
                continue;
            }
            for entry in readdir_safe(Path::new(&project_dir)) {
                if entry.ends_with(".jsonl") || entry.starts_with('.') {
                    continue;
                }
                let session_dir = join(&project_dir, &entry);
                match stat_safe(Path::new(&session_dir)) {
                    Some(s) if s.is_dir => {}
                    _ => continue,
                }
                scan_session_artifacts(&session_dir, &entry, &root.config_dir, now, &mut children, &mut runs, max_age);
            }
        }
    }
    (children, runs)
}
