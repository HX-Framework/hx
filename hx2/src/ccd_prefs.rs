//! Claude Code Desktop's sidebar grouping, read straight off its Local
//! Storage leveldb (src/ccd-prefs.ts): the `frame-store` value's `state`
//! (which also matches the legacy `dframe-store` key, so a shape guard keeps
//! the vestigial `{mru}` value from winning) and the `unreadIds` of the
//! unread store, found by a raw byte scan over every `.log` and every
//! decompressed `.ldb` block, newest file first, first parseable hit per
//! reader. The scan is copied as it is, stale groups and all: nothing the
//! servers see may change.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::ccd::{ccd_leveldb_dir, read_ccd_recents_cached, refresh_ccd_index};
use crate::ccd_leveldb::LeveldbScan;
use crate::fsutil::stat_safe;
use crate::js::{is_space, js, lossy, num_to_string, trim, JsStr};
use crate::json::{obj, Json};
use crate::wtf8;

fn find_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() || hay.len() - from < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Is this parsed `state` the grouping slice?
fn is_grouping_state(state: &Json) -> bool {
    if state.as_obj().is_none() {
        return false;
    }
    let groups_is_array = state.get("customGroups").map(|g| g.as_arr().is_some()).unwrap_or(false);
    let mode_present = state.get("groupByByMode").map(|m| !m.is_null()).unwrap_or(false);
    groups_is_array || mode_present
}

/// The grouping `frame-store` value's `state` in one scannable buffer.
fn scan_buffer_for_dframe(buf: &[u8]) -> Option<Json> {
    const KEY: &[u8] = b"frame-store";
    let mut idx = 0usize;
    while let Some(at) = find_bytes(buf, KEY, idx) {
        let scan = &buf[at + KEY.len()..];
        if let Some(state_open) = find_bytes(scan, b"{\"state\":", 0) {
            let mut depth: i64 = 0;
            let mut end_at: Option<usize> = None;
            for (j, &c) in scan.iter().enumerate().skip(state_open) {
                if c == b'{' {
                    depth += 1;
                } else if c == b'}' {
                    depth -= 1;
                    if depth == 0 {
                        end_at = Some(j);
                        break;
                    }
                }
            }
            if let Some(end) = end_at {
                if end > state_open {
                    let text = String::from_utf8_lossy(&scan[state_open..=end]);
                    if let Ok(parsed) = Json::parse(&text) {
                        if let Some(state) = parsed.get("state") {
                            if is_grouping_state(state) {
                                return Some(state.clone());
                            }
                        }
                    }
                }
            }
        }
        idx = at + KEY.len();
    }
    None
}

/// `unreadIds` in one scannable buffer: the first place where
/// `"unreadIds":\s*\[([^\]]{0,8000})\]` matches, parsed as a JSON array.
fn scan_buffer_for_unread(buf: &[u8]) -> Option<Vec<String>> {
    let text: JsStr = js(&String::from_utf8_lossy(buf));
    let needle: JsStr = js("\"unreadIds\":");
    let mut from = 0usize;
    while let Some(at) = crate::js::index_of(&text[from..], &needle).map(|i| i + from) {
        let mut p = at + needle.len();
        while p < text.len() && is_space(text[p]) {
            p += 1;
        }
        if p < text.len() && text[p] == b'[' as u16 {
            let start = p + 1;
            let mut q = start;
            while q < text.len() && q - start < 8000 && text[q] != b']' as u16 {
                q += 1;
            }
            if q < text.len() && text[q] == b']' as u16 {
                let inner = lossy(&text[start..q]);
                return match Json::parse(&format!("[{}]", inner)) {
                    Ok(Json::Arr(items)) => Some(items.iter().filter_map(|x| x.as_string()).collect()),
                    _ => None,
                };
            }
        }
        from = at + 1;
    }
    None
}

/// One pass over the leveldb for both readers.
fn scan_leveldb_once(dir: &str) -> (Option<Json>, Vec<String>) {
    let mut dframe: Option<Json> = None;
    let mut unread: Option<Vec<String>> = None;
    for buf in LeveldbScan::new(dir) {
        if dframe.is_none() {
            dframe = scan_buffer_for_dframe(&buf);
        }
        if unread.is_none() {
            unread = scan_buffer_for_unread(&buf);
        }
        if dframe.is_some() && unread.is_some() {
            break;
        }
    }
    (dframe, unread.unwrap_or_default())
}

/// `(name, size, mtime)` of every `.log`/`.ldb`, sorted: any write changes it.
fn leveldb_fingerprint(dir: &str) -> Option<String> {
    let names: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => return None,
    };
    let mut parts: Vec<String> = names
        .into_iter()
        .filter(|f| f.ends_with(".log") || f.ends_with(".ldb"))
        .map(|f| match stat_safe(&Path::new(dir).join(&f)) {
            Some(st) => format!("{}:{}:{}", f, st.size, num_to_string(st.mtime_ms)),
            None => format!("{}:gone", f),
        })
        .collect();
    parts.sort_by(|a, b| {
        let ka: Vec<u16> = a.encode_utf16().collect();
        let kb: Vec<u16> = b.encode_utf16().collect();
        ka.cmp(&kb)
    });
    Some(parts.join("|"))
}

fn strip_code_prefix(s: &[u16]) -> JsStr {
    let prefix = js("code:");
    if s.len() >= prefix.len() && s[..prefix.len()] == prefix[..] {
        s[prefix.len()..].to_vec()
    } else {
        s.to_vec()
    }
}

struct MirrorCache {
    ldb_fp: Option<String>,
    index_version: u64,
    blob: Json,
}

fn cache() -> &'static Mutex<Option<MirrorCache>> {
    static CACHE: OnceLock<Mutex<Option<MirrorCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn with_synced_at(mut blob: Json, now_ms: f64) -> Json {
    blob.set("syncedAtMs", Json::num(now_ms));
    blob
}

fn empty_mirror(now_ms: f64) -> Json {
    obj(vec![
        ("groupingEnabled", Json::Bool(false)),
        ("groups", Json::Arr(Vec::new())),
        ("unreadIds", Json::Arr(Vec::new())),
        ("note", Json::str("no CCD custom grouping")),
        ("syncedAtMs", Json::num(now_ms)),
    ])
}

/// The Claude Desktop sidebar mirror the gateway stores: a disabled-empty
/// mirror when the app is not in "Group by: Custom" mode or nothing could be
/// read.
pub fn build_group_mirror(now_ms: f64) -> Json {
    let empty = empty_mirror(now_ms);
    let ls_dir = match ccd_leveldb_dir() {
        Some(d) => d,
        None => return empty,
    };
    let ldb_fp = leveldb_fingerprint(&ls_dir);
    let index_version = refresh_ccd_index(now_ms, false);
    {
        let c = cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = c.as_ref() {
            if hit.ldb_fp == ldb_fp && hit.index_version == index_version {
                return with_synced_at(hit.blob.clone(), now_ms);
            }
        }
    }
    let (dframe, unread_ids) = scan_leveldb_once(&ls_dir);
    let unread_js: Vec<JsStr> = unread_ids.iter().map(|s| js(s)).collect();
    let enabled = dframe.as_ref().and_then(|d| d.get("groupByByMode")).and_then(|m| m.get_string("code")).as_deref() == Some("custom");
    let custom_groups: Option<Vec<Json>> = dframe.as_ref().and_then(|d| d.get("customGroups")).and_then(|g| g.as_arr()).cloned();
    let groups_list = match (&enabled, &custom_groups) {
        (true, Some(list)) if !list.is_empty() => list.clone(),
        _ => {
            let mut blob = empty.clone();
            blob.set("unreadIds", Json::Arr(unread_js.iter().map(|u| Json::Str(strip_code_prefix(u))).collect()));
            *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(MirrorCache { ldb_fp, index_version, blob: blob.clone() });
            return blob;
        }
    };
    let dframe = dframe.expect("enabled implies a state");
    let collapsed: Vec<JsStr> = dframe.get("collapsedGroups").and_then(|c| c.as_arr()).map(|a| a.iter().map(|v| v.to_js_string()).collect()).unwrap_or_default();
    // Per-group ordered ccdSessionId list: CCD's order first, then any
    // assignment the order missed.
    let mut by_group: Vec<(JsStr, Vec<JsStr>)> = Vec::new();
    for g in &groups_list {
        if let Some(Json::Str(id)) = g.get("id") {
            if !id.is_empty() && !by_group.iter().any(|(k, _)| k == id) {
                by_group.push((id.clone(), Vec::new()));
            }
        }
    }
    if let Some(order) = dframe.get("customGroupOrder").and_then(|o| o.as_obj()) {
        for (gid, ids) in order.iter() {
            let gid_js = js(gid);
            let slot = match by_group.iter_mut().find(|(k, _)| *k == gid_js) {
                Some(s) => s,
                None => continue,
            };
            if let Some(list) = ids.as_arr() {
                for raw in list {
                    if let Json::Str(s) = raw {
                        slot.1.push(strip_code_prefix(s));
                    }
                }
            }
        }
    }
    if let Some(assignments) = dframe.get("customGroupAssignments").and_then(|a| a.as_obj()) {
        for (raw_sid, gid) in assignments.iter() {
            let sid = strip_code_prefix(&js(raw_sid));
            let gid_js = match gid {
                Json::Str(s) => s.clone(),
                _ => continue,
            };
            if let Some(slot) = by_group.iter_mut().find(|(k, _)| *k == gid_js) {
                if !slot.1.iter().any(|x| *x == sid) {
                    slot.1.push(sid);
                }
            }
        }
    }
    // Claude Desktop names its sessions by an internal id; the workbench keys
    // them by the cli/jsonl id, resolved from the per-session metadata. The
    // client's Map: the last record with an id wins, and an empty cli id
    // (falsy) maps nothing.
    let records = read_ccd_recents_cached(now_ms);
    let mut cli_by_ccd: HashMap<&[u8], &[u8]> = HashMap::with_capacity(records.len());
    for r in records.iter() {
        if let Some(cli) = r.cli_session_id().filter(|c| !c.is_empty()) {
            cli_by_ccd.insert(r.ccd_session_id(), cli);
        }
    }
    let to_cli = |local_id: &JsStr| -> JsStr {
        match cli_by_ccd.get(wtf8::from_units(local_id).as_slice()) {
            Some(cli) => wtf8::to_units(cli),
            None => local_id.clone(),
        }
    };
    let groups: Vec<Json> = groups_list
        .iter()
        .filter_map(|g| {
            let id = match g.get("id") {
                Some(Json::Str(id)) if !id.is_empty() => id.clone(),
                _ => return None,
            };
            let name: JsStr = match g.get("name") {
                Some(Json::Str(n)) => {
                    let t = trim(n).to_vec();
                    if t.is_empty() {
                        js("Group")
                    } else {
                        t
                    }
                }
                _ => js("Group"),
            };
            let nullish = |v: Option<&Json>| -> Json {
                match v {
                    Some(Json::Null) | None => Json::Null,
                    Some(x) => x.clone(),
                }
            };
            let session_ids: Vec<Json> = by_group.iter().find(|(k, _)| *k == id).map(|(_, ids)| ids.iter().map(|s| Json::Str(to_cli(s))).collect()).unwrap_or_default();
            Some(obj(vec![
                ("id", Json::Str(id.clone())),
                ("name", Json::Str(name)),
                ("subtitle", nullish(g.get("subtitle"))),
                ("sectionName", nullish(g.get("sectionName"))),
                ("collapsed", Json::Bool(collapsed.iter().any(|c| *c == id))),
                ("sessionIds", Json::Arr(session_ids)),
            ]))
        })
        .collect();
    let blob = obj(vec![
        ("groupingEnabled", Json::Bool(true)),
        ("groups", Json::Arr(groups.clone())),
        ("unreadIds", Json::Arr(unread_js.iter().map(|u| Json::Str(to_cli(&strip_code_prefix(u)))).collect())),
        ("note", Json::str(&format!("CCD custom grouping: {} groups", groups.len()))),
        ("syncedAtMs", Json::num(now_ms)),
    ]);
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(MirrorCache { ldb_fp, index_version, blob: blob.clone() });
    blob
}

/// The key of the group-mirror gate (watch.ts syncGroupMirror): the content
/// without the volatile stamp, unread ids sorted the way `Array.prototype.sort` sorts.
pub fn group_mirror_gate(mirror: &Json) -> Json {
    let mut unread: Vec<JsStr> = mirror.get("unreadIds").and_then(|u| u.as_arr()).map(|a| a.iter().map(|v| v.to_js_string()).collect()).unwrap_or_default();
    unread.sort();
    obj(vec![
        ("enabled", mirror.get("groupingEnabled").cloned().unwrap_or(Json::Bool(false))),
        ("groups", mirror.get("groups").cloned().unwrap_or(Json::Arr(Vec::new()))),
        ("unread", Json::Arr(unread.into_iter().map(Json::Str).collect())),
    ])
}

#[allow(dead_code)]
pub fn lossy_title(s: &JsStr) -> String {
    lossy(s)
}
