//! Source-path discovery and family classification (src/sources.ts), for the
//! Claude Code transcripts the hot path uploads.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::fsutil::{basename, join, readdir_safe, resolve, stat_safe};
use crate::js::{js, lossy, JsStr};
use crate::json::Json;
use crate::roots::{claude_projects_dir, DataRoot};

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
                if e.raw_os_error() == Some(libc::EISDIR) {
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
                let gitdir = if target.starts_with('/') { target } else { resolve(&dir, &target) };
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
