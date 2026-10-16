//! Data-root resolution: which config-dir roots the client watches (src/roots.ts).

use std::fs;
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock};

use crate::fsutil::{exists, join, now_ms};
use crate::home::homedir;
use crate::json::{obj, Json};
use crate::pathnorm::normalize_data_dir;
use crate::settings::HxSettings;

#[derive(Clone, Debug, PartialEq)]
pub struct DataRoot {
    pub config_dir: String,
    /// "default" | "settings" | "env"
    pub origin: &'static str,
    pub exists: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolvedRoots {
    pub claude: Vec<DataRoot>,
    pub codex: Vec<DataRoot>,
}

pub static DEFAULT_CLAUDE_ROOT: LazyLock<String> =
    LazyLock::new(|| homedir().join(".claude").to_string_lossy().into_owned());
pub static DEFAULT_CODEX_ROOT: LazyLock<String> =
    LazyLock::new(|| homedir().join(".codex").to_string_lossy().into_owned());

pub fn claude_projects_dir(root: &str) -> String {
    join(root, "projects")
}
pub fn claude_tasks_dir(root: &str) -> String {
    join(root, "tasks")
}
pub fn claude_teams_dir(root: &str) -> String {
    join(root, "teams")
}
pub fn codex_sessions_dir(root: &str) -> String {
    join(root, "sessions")
}
pub fn codex_archived_dir(root: &str) -> String {
    join(root, "archived_sessions")
}

fn realpath(p: &str) -> String {
    fs::canonicalize(p).map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

/// Same physical directory, resolving symlinks where possible.
pub fn same_physical_dir(a: &str, b: &str) -> bool {
    a == b || realpath(a) == realpath(b)
}

fn resolve_family(default_root: &str, from_settings: &[String], from_env: Option<&str>) -> Vec<DataRoot> {
    let mut out: Vec<DataRoot> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut push = |raw: &str, origin: &'static str| {
        let dir = if origin == "default" { Some(raw.to_string()) } else { normalize_data_dir(raw) };
        let dir = match dir {
            Some(d) => d,
            None => return,
        };
        let present = exists(Path::new(&dir));
        let key = if present { realpath(&dir) } else { dir.clone() };
        if seen.contains(&key) {
            return;
        }
        seen.push(key);
        out.push(DataRoot { config_dir: dir, origin, exists: present });
    };
    push(default_root, "default");
    for d in from_settings {
        push(d, "settings");
    }
    if let Some(e) = from_env {
        push(e, "env");
    }
    out
}

/// The sub-tick memo of roots.ts. The daemon resolves the roots several
/// times a tick (the tick and `publish_roots` each resolve, and the mirror
/// and audit timers add calls of their own), and every resolution stats and
/// realpaths each candidate. A resolution for the same settings and
/// environment within ROOTS_MEMO_TTL_MS of the last one reuses it, and the
/// daemon's pass drops the memo at its start, so a tick's first resolution
/// observes the filesystem fresh and later ones in the same tick collapse.
const ROOTS_MEMO_TTL_MS: f64 = 1_200.0;

type RootsKey = (Vec<String>, Vec<String>, Option<String>, Option<String>);

struct RootsMemo {
    key: RootsKey,
    at_ms: f64,
    value: ResolvedRoots,
}

fn roots_memo() -> MutexGuard<'static, Option<RootsMemo>> {
    static MEMO: OnceLock<Mutex<Option<RootsMemo>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner())
}

/// `invalidateRootsMemo`: the next resolution re-observes the filesystem.
pub fn invalidate_roots_memo() {
    *roots_memo() = None;
}

/// Resolve the full watch-root set for this process (settings + own env).
pub fn resolve_data_roots(s: &HxSettings) -> ResolvedRoots {
    let claude_env_raw = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let codex_env_raw = std::env::var("CODEX_HOME").ok();
    let key: RootsKey = (s.data_dirs.claude.clone(), s.data_dirs.codex.clone(), claude_env_raw.clone(), codex_env_raw.clone());
    let now = now_ms();
    if let Some(m) = roots_memo().as_ref() {
        if m.key == key && now - m.at_ms < ROOTS_MEMO_TTL_MS {
            return m.value.clone();
        }
    }
    let claude_env = claude_env_raw.filter(|v| !v.is_empty());
    let codex_env = codex_env_raw.filter(|v| !v.is_empty());
    let value = ResolvedRoots {
        claude: resolve_family(&DEFAULT_CLAUDE_ROOT, &s.data_dirs.claude, claude_env.as_deref()),
        codex: resolve_family(&DEFAULT_CODEX_ROOT, &s.data_dirs.codex, codex_env.as_deref()),
    };
    *roots_memo() = Some(RootsMemo { key, at_ms: now, value: value.clone() });
    value
}

/// Identity of a resolved set — drives the daemon's stamp-on-change.
pub fn roots_signature(r: &ResolvedRoots) -> String {
    let part = |list: &[DataRoot]| -> String {
        list.iter()
            .map(|d| format!("{}:{}:{}", d.origin, d.config_dir, if d.exists { 1 } else { 0 }))
            .collect::<Vec<_>>()
            .join("|")
    };
    format!("{}§{}", part(&r.claude), part(&r.codex))
}

/// True when `p` is (or sits under) one of the roots' config dirs.
pub fn is_under_roots(p: &str, roots: &[DataRoot]) -> bool {
    roots.iter().any(|r| {
        let base = if r.config_dir.ends_with('/') { r.config_dir.clone() } else { format!("{}/", r.config_dir) };
        p == r.config_dir || p.starts_with(&base)
    })
}

/// The JSON shape of a root as `state.effectiveRoots` stores it.
pub fn root_json(d: &DataRoot) -> Json {
    obj(vec![("configDir", Json::str(&d.config_dir)), ("origin", Json::str(d.origin)), ("exists", Json::Bool(d.exists))])
}
