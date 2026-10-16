//! `~/.let/hx/settings.json`, read every tick (src/settings.ts).

use std::fs;
use std::path::Path;

use crate::home::hx_dir;
use crate::json::Json;
use crate::pathnorm::{collapse_home, is_path_prefix, normalize_data_dir, same_path};
use crate::roots::{same_physical_dir, DEFAULT_CLAUDE_ROOT, DEFAULT_CODEX_ROOT};

#[derive(Clone, Debug)]
pub struct ExcludedFolder {
    pub family: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Default)]
pub struct DataDirs {
    pub claude: Vec<String>,
    pub codex: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct HxSettings {
    /// None = not paused; Some(None) = paused until resumed; Some(Some(ms)) = until then.
    pub pause: Option<Option<f64>>,
    pub personal_sync: bool,
    pub excluded_folders: Vec<ExcludedFolder>,
    pub exclude_rules: Vec<String>,
    pub data_dirs: DataDirs,
    pub tuning: Option<Json>,
}

impl Default for HxSettings {
    fn default() -> Self {
        HxSettings {
            pause: None,
            personal_sync: true,
            excluded_folders: Vec::new(),
            exclude_rules: Vec::new(),
            data_dirs: DataDirs::default(),
            tuning: None,
        }
    }
}

pub const MAX_DATA_DIRS_PER_FAMILY: usize = 8;

fn parse_data_dir_list(v: Option<&Json>, default_root: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let list = match v.and_then(|x| x.as_arr()) {
        Some(l) => l,
        None => return out,
    };
    for item in list {
        let s = match item.as_string() {
            Some(s) => s,
            None => continue,
        };
        let dir = match normalize_data_dir(&s) {
            Some(d) => d,
            None => continue,
        };
        if out.contains(&dir) {
            continue;
        }
        if same_physical_dir(&dir, default_root) {
            continue;
        }
        if out.iter().any(|kept| same_physical_dir(kept, &dir)) {
            continue;
        }
        out.push(dir);
        if out.len() >= MAX_DATA_DIRS_PER_FAMILY {
            break;
        }
    }
    out
}

pub fn parse_data_dirs(v: Option<&Json>) -> DataDirs {
    let o = v.filter(|x| x.as_obj().is_some());
    DataDirs {
        claude: parse_data_dir_list(o.and_then(|x| x.get("claude")), &DEFAULT_CLAUDE_ROOT),
        codex: parse_data_dir_list(o.and_then(|x| x.get("codex")), &DEFAULT_CODEX_ROOT),
    }
}

pub fn settings_path() -> std::path::PathBuf {
    hx_dir().join("settings.json")
}

pub fn read_settings() -> HxSettings {
    read_settings_from(&settings_path())
}

pub fn read_settings_from(path: &Path) -> HxSettings {
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return HxSettings::default(),
    };
    let parsed = match Json::parse(&raw) {
        Ok(v) if v.as_obj().is_some() => v,
        _ => return HxSettings::default(),
    };
    let pause = match parsed.get("pause") {
        Some(p) if p.as_obj().is_some() => Some(p.get_f64("untilMs")),
        _ => None,
    };
    let personal_sync = !matches!(parsed.get("personalSync"), Some(Json::Bool(false)));
    let excluded_folders = parsed
        .get("excludedFolders")
        .and_then(|v| v.as_arr())
        .map(|list| {
            list.iter()
                .filter_map(|f| {
                    let family = f.get_string("family")?;
                    let cwd = f.get_string("cwd")?;
                    Some(ExcludedFolder { family, cwd })
                })
                .collect()
        })
        .unwrap_or_default();
    let exclude_rules = parsed
        .get("excludeRules")
        .and_then(|v| v.as_arr())
        .map(|list| list.iter().filter_map(|r| r.as_string()).collect())
        .unwrap_or_default();
    HxSettings {
        pause,
        personal_sync,
        excluded_folders,
        exclude_rules,
        data_dirs: parse_data_dirs(parsed.get("dataDirs")),
        tuning: parsed.get("tuning").cloned(),
    }
}

/// `tuningValue(s, key)`: a subkey of the opaque tuning object, if any.
pub fn tuning_value<'a>(s: &'a HxSettings, key: &str) -> Option<&'a Json> {
    let t = s.tuning.as_ref()?;
    if t.as_obj().is_none() {
        return None;
    }
    t.get(key)
}

/// Integer tuning knob clamped to 1..16, else the fallback (watch.ts tuningInt).
pub fn tuning_int(s: &HxSettings, key: &str, fallback: usize) -> usize {
    match tuning_value(s, key).and_then(|v| v.as_f64()) {
        Some(v) if v.is_finite() && v >= 1.0 => (v.floor() as usize).min(16),
        _ => fallback,
    }
}

pub fn is_paused(s: &HxSettings, now_ms: f64) -> bool {
    match s.pause {
        None => false,
        Some(None) => true,
        Some(Some(until)) => now_ms < until,
    }
}

fn rule_matches(rule: &str, cwd: &str) -> bool {
    is_path_prefix(&collapse_home(rule), &collapse_home(cwd))
}

pub struct FileSyncIdentity<'a> {
    pub family: &'a str,
    /// None = unknown (legacy entry).
    pub cwd: Option<&'a str>,
    /// Some(None) = known to have no repo; None = unknown.
    pub repo_slug: Option<Option<&'a str>>,
    pub attributed: Option<bool>,
}

/// Should this file stay on the machine under the current settings?
pub fn should_skip_file(s: &HxSettings, id: &FileSyncIdentity) -> bool {
    if let Some(cwd) = id.cwd {
        for ex in &s.excluded_folders {
            if ex.family == id.family && same_path(&ex.cwd, cwd) {
                return true;
            }
        }
        for rule in &s.exclude_rules {
            if rule_matches(rule, cwd) {
                return true;
            }
        }
    }
    if !s.personal_sync && (id.repo_slug == Some(None) || id.attributed == Some(false)) {
        return true;
    }
    false
}
