//! The sidecar artifacts beside a Claude Code session (src/artifacts.ts):
//! tasks (`<root>/tasks/<sessionId>/<n>.json`), the plan a `plan_mode`
//! attachment names, the child lanes' `agent-<id>.meta.json`, and the agent
//! teams' `config.json`.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::fsutil::{join, stat_safe};
use crate::js::{js_locale_compare, lossy};
use crate::json::{obj, Json};
use crate::parse::find_plan_path_in_text;

/// Tasks dirs in probe order: the live transcript's own root first.
pub fn order_tasks_dirs(tasks_dirs: Vec<String>, preferred_root_tasks_dir: Option<String>) -> Vec<String> {
    match preferred_root_tasks_dir {
        None => tasks_dirs,
        Some(pref) => {
            let mut out = vec![pref.clone()];
            for d in tasks_dirs {
                if d != pref {
                    out.push(d);
                }
            }
            out
        }
    }
}

/// `String(x)` of a JSON value.
fn string_of(v: Option<&Json>) -> String {
    match v {
        Some(x) => lossy(&x.to_js_string()),
        None => "undefined".to_string(),
    }
}

/// `readTaskSet`: `<tasksDir>/<sessionId>/*.json` as a normalized task list,
/// from the first tasks dir that holds the session. None when none does;
/// an empty list when the dir exists but is empty.
pub fn read_task_set(session_id: &str, tasks_dirs: &[String]) -> Option<Vec<Json>> {
    let mut dir: Option<String> = None;
    let mut entries: Vec<String> = Vec::new();
    for tasks_dir in tasks_dirs {
        let candidate = join(tasks_dir, session_id);
        match stat_safe(Path::new(&candidate)) {
            Some(st) if st.is_dir => {
                entries = match fs::read_dir(&candidate) {
                    Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
                    Err(_) => continue,
                };
                dir = Some(candidate);
                break;
            }
            _ => continue,
        }
    }
    let dir = dir?;
    let mut json_files: Vec<String> = entries.into_iter().filter(|f| f.ends_with(".json")).collect();
    // `parseInt(a, 10)`: the leading integer of the name, NaN when it has none.
    let leading_int = |s: &str| -> Option<f64> {
        let t = s.trim_start();
        let mut end = 0;
        let bytes = t.as_bytes();
        let mut i = 0;
        if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
            i += 1;
        }
        let digits_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            end = i;
        }
        if end <= digits_start {
            return None;
        }
        t[..end].parse::<f64>().ok()
    };
    json_files.sort_by(|a, b| match (leading_int(a), leading_int(b)) {
        (Some(an), Some(bn)) => an.partial_cmp(&bn).unwrap_or(std::cmp::Ordering::Equal),
        _ => js_locale_compare(a, b),
    });
    let mut tasks: Vec<Json> = Vec::new();
    for f in json_files {
        let raw = match fs::read(join(&dir, &f)) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => continue,
        };
        let d = match Json::parse(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // `!d || typeof d !== "object"`: null, numbers, strings and booleans are skipped.
        if !matches!(d, Json::Obj(_) | Json::Arr(_)) {
            continue;
        }
        let id = match d.get("id") {
            Some(v) if !v.is_null() => lossy(&v.to_js_string()),
            _ => f.strip_suffix(".json").unwrap_or(&f).to_string(),
        };
        let str_or = |key: &str, fallback: Json| -> Json {
            match d.get(key) {
                Some(Json::Str(s)) => Json::Str(s.clone()),
                _ => fallback,
            }
        };
        let list_of = |key: &str| -> Json {
            match d.get(key).and_then(|v| v.as_arr()) {
                Some(a) => Json::Arr(a.iter().map(|x| Json::str(&string_of(Some(x)))).collect()),
                None => Json::Arr(Vec::new()),
            }
        };
        let metadata = match d.get("metadata") {
            Some(m) if m.truthy() && matches!(m, Json::Obj(_) | Json::Arr(_)) => m.clone(),
            _ => Json::Null,
        };
        tasks.push(obj(vec![
            ("id", Json::str(&id)),
            ("subject", str_or("subject", Json::str(""))),
            ("description", str_or("description", Json::str(""))),
            ("activeForm", str_or("activeForm", Json::Null)),
            ("status", str_or("status", Json::str("pending"))),
            ("blocks", list_of("blocks")),
            ("blockedBy", list_of("blockedBy")),
            ("metadata", metadata),
        ]));
    }
    Some(tasks)
}

/// `readPlanFile`: (planFilePath, content), or None when it is gone or a directory.
pub fn read_plan_file(plan_file_path: &str) -> Option<(String, String)> {
    let bytes = fs::read(plan_file_path).ok()?;
    Some((plan_file_path.to_string(), String::from_utf8_lossy(&bytes).into_owned()))
}

/// `readPlanForJsonl`: the last plan attachment of a whole transcript, read
/// line by line, then the plan file it names.
pub fn read_plan_for_jsonl(jsonl_path: &str) -> Option<(String, String)> {
    let f = fs::File::open(jsonl_path).ok()?;
    let mut reader = BufReader::with_capacity(256 * 1024, f);
    let mut plan: Option<String> = None;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
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
        let line = String::from_utf8_lossy(&buf);
        if let Some(found) = find_plan_path_in_text(&line) {
            plan = Some(found);
        }
    }
    read_plan_file(&plan?)
}

/// `listTaskSessionIds`: every `<tasksDir>/<id>/` directory under the roots, deduped.
pub fn list_task_session_ids(tasks_dirs: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for tasks_dir in tasks_dirs {
        let rd = match fs::read_dir(tasks_dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for e in rd.filter_map(|e| e.ok()) {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if !ids.contains(&name) {
                ids.push(name);
            }
        }
    }
    ids
}

#[derive(Clone, Debug, Default)]
pub struct AgentMeta {
    pub agent_type: Option<Json>,
    pub description: Option<Json>,
    pub tool_use_id: Option<Json>,
    pub worktree_path: Option<Json>,
}

/// `readAgentMeta`: the fields of `agent-<id>.meta.json`, each a string or absent.
pub fn read_agent_meta(meta_path: Option<&str>) -> Option<AgentMeta> {
    let p = meta_path?;
    let raw = fs::read(p).ok()?;
    let d = Json::parse(&String::from_utf8_lossy(&raw)).ok()?;
    let s = |key: &str| -> Option<Json> {
        match d.get(key) {
            Some(Json::Str(v)) => Some(Json::Str(v.clone())),
            _ => None,
        }
    };
    Some(AgentMeta { agent_type: s("agentType"), description: s("description"), tool_use_id: s("toolUseId"), worktree_path: s("worktreePath") })
}
