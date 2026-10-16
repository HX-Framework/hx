//! The two device mirrors the daemon pushes on start and every 20 s: Claude
//! Desktop's sidebar grouping (src/ccd-prefs.ts, syncGroupMirror in watch.ts)
//! and the active agent teams (readTeamConfigs in artifacts.ts, syncTeamMirror).
//!
//! The hot-path spike carries the Claude Desktop reader's result for a
//! machine without a Claude Desktop store — the disabled-empty mirror, which
//! is also what the client uploads on Linux — and the full team reader. The
//! leveldb scan and the session-metadata index are the next card's work.

use std::fs;
use std::path::Path;

use crate::fsutil::{join, now_ms, readdir_safe, stat_safe};
use crate::json::{obj, Json};
use crate::net::Gateway;
use crate::roots::{claude_teams_dir, resolve_data_roots};
use crate::settings::read_settings;
use crate::state::Store;

pub fn sha1_hex(text: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// `buildGroupMirror` for a machine with no Claude Desktop grouping to read.
fn build_group_mirror(now: f64) -> Json {
    obj(vec![
        ("groupingEnabled", Json::Bool(false)),
        ("groups", Json::Arr(Vec::new())),
        ("unreadIds", Json::Arr(Vec::new())),
        ("note", Json::str("no CCD custom grouping")),
        ("syncedAtMs", Json::num(now)),
    ])
}

/// `syncGroupMirror`: hash-gated on the meaningful content, best-effort.
pub fn sync_group_mirror(store: &Store, gw: &Gateway, log: &dyn Fn(&str)) {
    let mirror = build_group_mirror(now_ms());
    let gate = obj(vec![
        ("enabled", mirror.get("groupingEnabled").cloned().unwrap_or(Json::Bool(false))),
        ("groups", mirror.get("groups").cloned().unwrap_or(Json::Arr(Vec::new()))),
        ("unread", mirror.get("unreadIds").cloned().unwrap_or(Json::Arr(Vec::new()))),
    ]);
    let hash = sha1_hex(&gate.stringify());
    let key = "ccd:group-mirror";
    if store.get_artifact_hash(key).as_deref() == Some(hash.as_str()) {
        return;
    }
    match gw.upload_group_mirror(mirror) {
        Ok(groups) => {
            store.set_artifact_hash(key, &hash);
            log(&format!("  [groups] synced {} CCD group(s)", crate::js::num_to_string(groups)));
        }
        Err(e) => log(&format!("  [groups] sync failed: {}", e.message())),
    }
}

/// `readTextFile`: a regular file of at most `max_bytes`, as text.
pub fn read_text_file(p: &str, max_bytes: u64) -> Option<String> {
    let st = stat_safe(Path::new(p))?;
    if !st.is_file || st.size > max_bytes {
        return None;
    }
    fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `readTeamConfigs`: every `<teamsDir>/<name>/config.json`, newest per name, sorted by name.
pub fn read_team_configs(teams_dirs: &[String]) -> Vec<(String, Json)> {
    let mut best: Vec<(String, Json, f64)> = Vec::new();
    for dir in teams_dirs {
        let entries = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(),
            Err(_) => continue,
        };
        for name in entries {
            if name.starts_with('.') {
                continue;
            }
            let cfg_path = join(&join(dir, &name), "config.json");
            let raw = match read_text_file(&cfg_path, 500_000) {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            let config = match Json::parse(&raw) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mtime = stat_safe(Path::new(&cfg_path)).map(|s| s.mtime_ms).unwrap_or(0.0);
            match best.iter_mut().find(|(n, _, _)| *n == name) {
                Some(slot) => {
                    if mtime > slot.2 {
                        slot.1 = config;
                        slot.2 = mtime;
                    }
                }
                None => best.push((name, config, mtime)),
            }
        }
    }
    best.sort_by(|a, b| a.0.cmp(&b.0));
    best.into_iter().map(|(n, c, _)| (n, c)).collect()
}

/// `syncTeamMirror`: uploads when the set changed (an empty set uploads once).
pub fn sync_team_mirror(store: &Store, gw: &Gateway, log: &dyn Fn(&str)) {
    let settings = read_settings();
    let roots = resolve_data_roots(&settings);
    let dirs: Vec<String> = roots.claude.iter().map(|r| claude_teams_dir(&r.config_dir)).collect();
    let teams = read_team_configs(&dirs);
    let gate = Json::Arr(teams.iter().map(|(n, c)| Json::Arr(vec![Json::str(n), c.clone()])).collect());
    let hash = sha1_hex(&gate.stringify());
    let key = "teams:mirror";
    if store.get_artifact_hash(key).as_deref() == Some(hash.as_str()) {
        return;
    }
    let mirror = obj(vec![
        ("teams", Json::Arr(teams.iter().map(|(n, c)| obj(vec![("name", Json::str(n)), ("config", c.clone())])).collect())),
        ("syncedAtMs", Json::num(now_ms())),
    ]);
    match gw.upload_team_mirror(mirror) {
        Ok(_) => {
            store.set_artifact_hash(key, &hash);
            if !teams.is_empty() {
                log(&format!("  [teams] synced {} team(s)", teams.len()));
            }
        }
        Err(e) => log(&format!("  [teams] sync failed: {}", e.message())),
    }
}

/// Names under `<root>/teams` (unused by the gate, kept for parity with artifacts.ts).
#[allow(dead_code)]
pub fn team_names(teams_dir: &str) -> Vec<String> {
    readdir_safe(Path::new(teams_dir)).into_iter().filter(|n| !n.starts_with('.')).collect()
}
