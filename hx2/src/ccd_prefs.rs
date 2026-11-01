//! Claude Desktop's sidebar grouping, read straight off its Local Storage
//! leveldb (src/ccd-prefs.ts). The sidebar state lives under `dframe-store`
//! or, in older builds, `frame-store`; a shape guard skips a value that is not
//! the sidebar state. Three layouts:
//!
//! - sections (current builds): everything is kept per account scope
//!   (`<accountId>/<orgId>`), `lastSidebarScopeKey` names the live one, and
//!   `codeSidebarByScope[scope].sections` is what the sidebar draws: one
//!   `kind: "manual"` section per custom group, with its place, its collapse
//!   state, its sort and its members. `customGroupsByScope[scope]` keeps the
//!   groups too, in creation order and with `order` lists that keep a moved
//!   session in its old group, so it is read only for what a section lacks;
//! - scoped-groups: `customGroupsByScope` with no sections;
//! - flat-groups (older builds): `customGroups`, `customGroupOrder` and
//!   `customGroupAssignments`, read exactly as before.
//!
//! The mirror is the live scope's groups only. The value is read by leveldb
//! sequence number (ccd_leveldb.rs: `LeveldbKeyReader`), so the newest write
//! wins wherever it sits; a store with no such key at all falls back to the
//! byte scan over every `.log` and decompressed `.ldb` block, newest file
//! first, first parseable hit per reader.

use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use notify::{EventKind, RecursiveMode, Watcher};

use crate::ccd::{ccd_id_key, ccd_leveldb_dir, ccd_records_in_scope, read_ccd_recents_cached, refresh_ccd_index_fresh, CcdSessionMeta, IdKey};
use crate::ccd_leveldb::{decode_local_storage_value, is_newer_record, local_storage_key_name, read_leveldb_value, LeveldbKeyReader, LeveldbRecord, LeveldbScan};
use crate::crypto::sha256_hex;
use crate::fsutil::{now_ms, stat_safe};
use crate::js::{eq_str, is_space, js, lossy, num_to_string, trim, JsStr};
use crate::json::{obj, Json};
use crate::wtf8;

/// The Local Storage keys of the sidebar state, newest builds first.
const SIDEBAR_KEYS: [&str; 2] = ["dframe-store", "frame-store"];
/// The Local Storage key of Claude Desktop's blue-dot (unread) sessions.
const UNREAD_KEY: &str = "epitaxy-unread-v1";
const DISABLED_NOTE: &str = "no CCD custom grouping";

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
    let by_scope = state.get("customGroupsByScope").map(|v| v.as_obj().is_some()).unwrap_or(false);
    let sidebar_by_scope = state.get("codeSidebarByScope").map(|v| v.as_obj().is_some()).unwrap_or(false);
    groups_is_array || mode_present || by_scope || sidebar_by_scope
}

/// The grouping `frame-store` value's `state` in one scannable buffer (the
/// byte scan, for a store with no sidebar key).
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
/// `"unreadIds":\s*\[([^\]]{0,8000})\]` matches, parsed as a JSON array (the
/// byte scan, for a store with no `epitaxy-unread-v1` key).
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

/// The byte scan: one pass over the leveldb for the readers asked for.
fn scan_leveldb_once(dir: &str, want_dframe: bool, want_unread: bool) -> (Option<Json>, Option<Vec<String>>) {
    let mut dframe: Option<Json> = None;
    let mut unread: Option<Vec<String>> = None;
    for buf in LeveldbScan::new(dir) {
        if want_dframe && dframe.is_none() {
            dframe = scan_buffer_for_dframe(&buf);
        }
        if want_unread && unread.is_none() {
            unread = scan_buffer_for_unread(&buf);
        }
        if (!want_dframe || dframe.is_some()) && (!want_unread || unread.is_some()) {
            break;
        }
    }
    (dframe, unread)
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

// ── The sidebar view: what the mirror needs from the state ──────────────────

/// The scoped layouts' fields of a group: the sort and the direction the rows
/// are drawn in, whether the section is drawn, and whether Claude Desktop
/// draws it with nothing left to show.
#[derive(Clone)]
struct GroupExtra {
    sort_by: Option<JsStr>,
    ascending: Option<bool>,
    shown: bool,
    show_empty: bool,
}

/// The sorts Claude Desktop's section normalizer keeps; any other value reads
/// as "recency".
const CCD_SORTS: [&str; 3] = ["recency", "alpha", "created"];

/// A manual section's sort as Claude Desktop draws it. Its normalizer reads a
/// sort it does not know as "recency" and a missing direction as false, and
/// for "alpha" it draws the opposite of the stored direction: false is A to Z.
/// The blob carries the direction the rows are drawn in.
fn drawn_sort(s: &Json) -> (JsStr, bool) {
    let sort_by: JsStr = match s.get("sortBy").and_then(|v| v.as_str()) {
        Some(v) if CCD_SORTS.iter().any(|k| eq_str(v, k)) => v.to_vec(),
        _ => js("recency"),
    };
    let stored = s.get("ascending").and_then(|v| v.as_bool()) == Some(true);
    let ascending = if eq_str(&sort_by, "alpha") { !stored } else { stored };
    (sort_by, ascending)
}

/// A group as Claude Desktop's state describes it, members still its ids.
#[derive(Clone)]
struct ViewGroup {
    id: JsStr,
    name: JsStr,
    subtitle: Json,
    section_name: Json,
    collapsed: bool,
    members: Vec<JsStr>,
    extra: Option<GroupExtra>,
}

#[derive(Clone)]
struct SidebarView {
    enabled: bool,
    /// "sections" | "scoped-groups"; None for the flat layout, whose blob
    /// keeps its old shape exactly.
    layout: Option<&'static str>,
    groups: Vec<ViewGroup>,
    status_filter: Option<JsStr>,
    /// The live scope key, hashed (sha256, first 16 hex).
    scope: Option<String>,
    /// The live scope key itself (`<accountId>/<orgId>`): whose session files
    /// the side sessions come from. Never uploaded.
    scope_key: Option<String>,
    note: String,
}

fn disabled_view(layout: Option<&'static str>, status_filter: Option<JsStr>, scope: Option<String>, note: &str) -> SidebarView {
    SidebarView { enabled: false, layout, groups: Vec::new(), status_filter, scope, scope_key: None, note: note.to_string() }
}

fn str_eq(v: Option<&Json>, lit: &str) -> bool {
    v.and_then(|v| v.as_str()).map(|s| eq_str(s, lit)).unwrap_or(false)
}

/// The trimmed name, or None when it is not a string or is blank.
fn trimmed_name(v: Option<&Json>) -> Option<JsStr> {
    v.and_then(|v| v.as_str()).map(|s| trim(s).to_vec()).filter(|t| !t.is_empty())
}

/// Strip `code:` and drop repeats, first place kept.
fn member_ids(raw: &[Json]) -> Vec<JsStr> {
    let mut out: Vec<JsStr> = Vec::new();
    let mut seen: HashSet<JsStr> = HashSet::new();
    for r in raw {
        if let Some(s) = r.as_str() {
            let id = strip_code_prefix(s);
            if seen.insert(id.clone()) {
                out.push(id);
            }
        }
    }
    out
}

/// `container[key]` when it is an object.
fn own_obj<'a>(container: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    container.and_then(|c| c.as_obj()).and_then(|o| o.get(key)).filter(|v| v.as_obj().is_some())
}

/// A scoped group's members from `customGroupsByScope[scope]`: `assignments`
/// says which group a session is in; `order` gives the order, read only for
/// sessions still assigned to the group.
fn scoped_members(g1: Option<&Json>, gid: &[u16]) -> Vec<JsStr> {
    let assignments = g1.and_then(|g| g.get("assignments")).and_then(|a| a.as_obj());
    let order = g1.and_then(|g| g.get("order")).and_then(|o| o.as_obj());
    let listed: &[Json] = order.and_then(|o| o.get(&lossy(gid))).and_then(|l| l.as_arr()).map(|v| v.as_slice()).unwrap_or(&[]);
    let mut raw: Vec<Json> = Vec::new();
    for r in listed {
        if let Some(s) = r.as_str() {
            if assignments.and_then(|a| a.get(&lossy(s))).and_then(|g| g.as_str()) == Some(gid) {
                raw.push(r.clone());
            }
        }
    }
    if let Some(a) = assignments {
        for (k, g) in a.iter() {
            if g.as_str() == Some(gid) {
                raw.push(Json::Str(js(k)));
            }
        }
    }
    member_ids(&raw)
}

fn resolve_scoped(state: &Json) -> SidebarView {
    let status_filter: Option<JsStr> = state.get("recentsStatusFilter").and_then(|v| v.as_str()).map(|v| v.to_vec());
    let scope_key: JsStr = match state.get("lastSidebarScopeKey").and_then(|v| v.as_str()) {
        Some(k) if !k.is_empty() => k.to_vec(),
        _ => return disabled_view(Some("sections"), status_filter, None, "no live CCD sidebar scope"),
    };
    let key = lossy(&scope_key);
    let scope = sha256_hex(key.as_bytes())[..16].to_string();
    let g1 = own_obj(state.get("customGroupsByScope"), &key);
    let v1_groups: &[Json] = g1.and_then(|g| g.get("groups")).and_then(|g| g.as_arr()).map(|v| v.as_slice()).unwrap_or(&[]);
    let sb = own_obj(state.get("codeSidebarByScope"), &key);
    let sections: Option<&Vec<Json>> = sb.and_then(|s| s.get("sections")).and_then(|s| s.as_arr());

    if let Some(sections) = sections {
        // What the sidebar draws: the manual sections in their `order` (array
        // position breaks ties and places a section with no number last).
        let mut manual: Vec<(usize, f64, &Json, &[u16])> = Vec::new();
        for (i, s) in sections.iter().enumerate() {
            if s.as_obj().is_none() || !str_eq(s.get("kind"), "manual") {
                continue;
            }
            let id: &[u16] = match s.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => id,
                _ => continue,
            };
            let order = s.get("order").and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(f64::INFINITY);
            manual.push((i, order, s, id));
        }
        manual.sort_by(|a, b| {
            if a.1 != b.1 {
                if a.1 < b.1 {
                    CmpOrdering::Less
                } else {
                    CmpOrdering::Greater
                }
            } else {
                a.0.cmp(&b.0)
            }
        });
        // "Show empty groups" is one setting, kept on the Sessions section; a
        // manual section's own `show.emptyGroups` is never read. Only the
        // Routines section can be switched off, so every manual section is drawn.
        let show_empty = sections
            .iter()
            .find(|s| s.as_obj().is_some() && str_eq(s.get("kind"), "sessions"))
            .and_then(|s| s.get("show"))
            .and_then(|v| v.as_obj())
            .and_then(|o| o.get("emptyGroups"))
            .and_then(|v| v.as_bool())
            == Some(true);
        let mut groups: Vec<ViewGroup> = Vec::new();
        let mut seen: HashSet<JsStr> = HashSet::new();
        for (_, _, s, id) in manual {
            if !seen.insert(id.to_vec()) {
                continue;
            }
            let v1 = v1_groups.iter().find(|g| g.as_obj().is_some() && g.get("id").and_then(|x| x.as_str()) == Some(id));
            let members = match s.get("members").and_then(|m| m.as_arr()) {
                Some(list) => member_ids(list),
                None => scoped_members(g1, id),
            };
            let (sort_by, ascending) = drawn_sort(s);
            groups.push(ViewGroup {
                id: id.to_vec(),
                name: trimmed_name(s.get("name")).or_else(|| v1.and_then(|g| trimmed_name(g.get("name")))).unwrap_or_else(|| js("Group")),
                subtitle: v1.and_then(|g| g.get("subtitle")).filter(|x| x.as_str().is_some()).cloned().unwrap_or(Json::Null),
                section_name: Json::Null,
                collapsed: s.get("collapsed").and_then(|v| v.as_bool()) == Some(true),
                members,
                extra: Some(GroupExtra { sort_by: Some(sort_by), ascending: Some(ascending), shown: true, show_empty }),
            });
        }
        if groups.is_empty() {
            return disabled_view(Some("sections"), status_filter, Some(scope), "no CCD custom groups in the live account");
        }
        let note = format!("CCD sidebar: {} groups", groups.len());
        return SidebarView { enabled: true, layout: Some("sections"), groups, status_filter, scope: Some(scope), scope_key: Some(key.clone()), note };
    }

    // No sections for this scope: the scoped group list, while the app groups by it.
    let custom = state.get("groupByByMode").filter(|m| m.as_obj().is_some()).map(|m| str_eq(m.get("code"), "custom")).unwrap_or(false);
    let collapsed: Vec<JsStr> = state.get("collapsedGroups").and_then(|c| c.as_arr()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_vec())).collect()).unwrap_or_default();
    let mut groups: Vec<ViewGroup> = Vec::new();
    if custom {
        let mut seen: HashSet<JsStr> = HashSet::new();
        for g in v1_groups {
            if g.as_obj().is_none() {
                continue;
            }
            let id: &[u16] = match g.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => id,
                _ => continue,
            };
            if !seen.insert(id.to_vec()) {
                continue;
            }
            let mut custom_id = js("custom-");
            custom_id.extend_from_slice(id);
            groups.push(ViewGroup {
                id: id.to_vec(),
                name: trimmed_name(g.get("name")).unwrap_or_else(|| js("Group")),
                subtitle: g.get("subtitle").filter(|x| x.as_str().is_some()).cloned().unwrap_or(Json::Null),
                section_name: g.get("sectionName").filter(|x| x.as_str().is_some()).cloned().unwrap_or(Json::Null),
                collapsed: collapsed.iter().any(|c| c.as_slice() == id || *c == custom_id),
                members: scoped_members(g1, id),
                extra: Some(GroupExtra { sort_by: None, ascending: None, shown: true, show_empty: false }),
            });
        }
    }
    if groups.is_empty() {
        return disabled_view(Some("scoped-groups"), status_filter, Some(scope), "no CCD custom groups in the live account");
    }
    let note = format!("CCD custom grouping: {} groups", groups.len());
    SidebarView { enabled: true, layout: Some("scoped-groups"), groups, status_filter, scope: Some(scope), scope_key: Some(key.clone()), note }
}

/// The flat layout of older builds, read exactly as the client always has.
fn resolve_flat(dframe: &Json) -> SidebarView {
    let enabled = dframe.get("groupByByMode").and_then(|m| m.get_string("code")).as_deref() == Some("custom");
    let groups_list: &[Json] = match (enabled, dframe.get("customGroups").and_then(|g| g.as_arr())) {
        (true, Some(list)) if !list.is_empty() => list.as_slice(),
        _ => return disabled_view(None, None, None, DISABLED_NOTE),
    };
    let collapsed: Vec<JsStr> = dframe.get("collapsedGroups").and_then(|c| c.as_arr()).map(|a| a.iter().map(|v| v.to_js_string()).collect()).unwrap_or_default();
    // Per-group ordered id list: the app's order first, then any assignment
    // the order missed.
    let mut by_group: Vec<(JsStr, Vec<JsStr>)> = Vec::new();
    for g in groups_list {
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
    let nullish = |v: Option<&Json>| -> Json {
        match v {
            Some(Json::Null) | None => Json::Null,
            Some(x) => x.clone(),
        }
    };
    let groups: Vec<ViewGroup> = groups_list
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
            let members = by_group.iter().find(|(k, _)| *k == id).map(|(_, ids)| ids.clone()).unwrap_or_default();
            Some(ViewGroup { collapsed: collapsed.iter().any(|c| *c == id), id, name, subtitle: nullish(g.get("subtitle")), section_name: nullish(g.get("sectionName")), members, extra: None })
        })
        .collect();
    let note = format!("CCD custom grouping: {} groups", groups.len());
    SidebarView { enabled: true, layout: None, groups, status_filter: None, scope: None, scope_key: None, note }
}

fn resolve_view(state: &Json) -> SidebarView {
    let scoped = state.get("customGroupsByScope").map(|v| v.as_obj().is_some()).unwrap_or(false) || state.get("codeSidebarByScope").map(|v| v.as_obj().is_some()).unwrap_or(false);
    if scoped {
        resolve_scoped(state)
    } else {
        resolve_flat(state)
    }
}

// ── Reading the store ───────────────────────────────────────────────────────

fn key_reader() -> &'static Mutex<Option<LeveldbKeyReader>> {
    static READER: OnceLock<Mutex<Option<LeveldbKeyReader>>> = OnceLock::new();
    READER.get_or_init(|| Mutex::new(None))
}

/// The view of the newest record that holds the sidebar state, by record:
/// the 1.6 MB value is parsed once per write, not once per read.
fn view_cache() -> &'static Mutex<Option<(String, SidebarView)>> {
    static VIEW: OnceLock<Mutex<Option<(String, SidebarView)>>> = OnceLock::new();
    VIEW.get_or_init(|| Mutex::new(None))
}

fn record_id(r: &LeveldbRecord) -> String {
    format!("{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}", r.file, r.block, r.at, r.seq, crate::crypto::hex(&r.key))
}

enum RecordJson {
    /// The file moved under the read: read the store again.
    Moved,
    /// Not a JSON object.
    Not,
    Obj(Json),
}

fn read_record_json(dir: &str, r: &LeveldbRecord) -> RecordJson {
    let raw = match read_leveldb_value(dir, r) {
        Some(v) => v,
        None => return RecordJson::Moved,
    };
    let text = match decode_local_storage_value(&raw) {
        Some(t) => t,
        None => return RecordJson::Not,
    };
    match Json::parse(&text) {
        Ok(v) if v.as_obj().is_some() => RecordJson::Obj(v),
        _ => RecordJson::Not,
    }
}

fn newest_first(a: &&LeveldbRecord, b: &&LeveldbRecord) -> CmpOrdering {
    if is_newer_record(a, b) {
        CmpOrdering::Less
    } else if is_newer_record(b, a) {
        CmpOrdering::Greater
    } else {
        CmpOrdering::Equal
    }
}

/// The sidebar view and the unread ids. The view is None when the store holds
/// no sidebar state at all. The flag says the read cannot be trusted: files
/// kept moving under it, or the newest sidebar write could not be read.
fn read_store(dir: &str) -> (Option<SidebarView>, Vec<JsStr>, bool) {
    let mut attempt = 0;
    loop {
        let (recs, complete): (Vec<LeveldbRecord>, bool) = {
            let mut g = key_reader().lock().unwrap_or_else(|e| e.into_inner());
            if g.as_ref().map(|r| r.dir != dir).unwrap_or(true) {
                *g = Some(LeveldbKeyReader::new(dir, &[SIDEBAR_KEYS[0], SIDEBAR_KEYS[1], UNREAD_KEY]));
            }
            match g.as_mut() {
                Some(r) => {
                    let recs = r.newest();
                    (recs, r.complete)
                }
                None => (Vec::new(), true),
            }
        };
        let mut sidebar: Vec<&LeveldbRecord> = Vec::new();
        let mut unread: Vec<&LeveldbRecord> = Vec::new();
        for r in &recs {
            let name = local_storage_key_name(&r.key);
            if SIDEBAR_KEYS.iter().any(|k| k.as_bytes() == name) {
                sidebar.push(r);
            } else if name == UNREAD_KEY.as_bytes() {
                unread.push(r);
            }
        }
        let scan = if sidebar.is_empty() || unread.is_empty() { Some(scan_leveldb_once(dir, sidebar.is_empty(), unread.is_empty())) } else { None };

        let mut moved = !complete;
        let mut unreadable = false;
        let mut view: Option<SidebarView> = None;
        if sidebar.is_empty() {
            view = scan.as_ref().and_then(|s| s.0.as_ref()).map(resolve_view);
        } else {
            let mut live: Vec<&LeveldbRecord> = sidebar.iter().copied().filter(|r| r.live).collect();
            live.sort_by(newest_first);
            for r in live {
                let id = record_id(r);
                let cached: Option<SidebarView> = view_cache().lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(cid, _)| *cid == id).map(|(_, v)| v.clone());
                if cached.is_some() {
                    view = cached;
                    break;
                }
                match read_record_json(dir, r) {
                    RecordJson::Moved => {
                        moved = true;
                        break;
                    }
                    RecordJson::Not => {
                        // A sidebar write that cannot be read: what the sidebar shows is unknown.
                        unreadable = true;
                        break;
                    }
                    RecordJson::Obj(o) => {
                        let state = match o.get("state") {
                            Some(s) if s.as_obj().is_some() => s,
                            _ => continue,
                        };
                        if !is_grouping_state(state) {
                            continue;
                        }
                        let v = resolve_view(state);
                        *view_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((id, v.clone()));
                        view = Some(v);
                        break;
                    }
                }
            }
        }

        let mut unread_ids: Vec<JsStr> = Vec::new();
        if unread.is_empty() {
            unread_ids = scan.and_then(|s| s.1).unwrap_or_default().iter().map(|s| js(s)).collect();
        } else {
            let mut live: Vec<&LeveldbRecord> = unread.iter().copied().filter(|r| r.live).collect();
            live.sort_by(newest_first);
            if let Some(newest) = live.first() {
                match read_record_json(dir, newest) {
                    RecordJson::Moved => moved = true,
                    RecordJson::Not => {}
                    RecordJson::Obj(o) => {
                        if let Some(list) = o.get("state").filter(|s| s.as_obj().is_some()).and_then(|s| s.get("unreadIds")).and_then(|u| u.as_arr()) {
                            unread_ids = list.iter().filter_map(|x| x.as_str().map(|s| s.to_vec())).collect();
                        }
                    }
                }
            }
        }
        if unreadable || !moved || attempt >= 2 {
            return (view, unread_ids, moved || unreadable);
        }
        attempt += 1;
    }
}

// ── The server's limits ─────────────────────────────────────────────────────

// The gateway refuses a whole upload with one value over its limits (the
// group-mirror schema), so the blob is cut to them here: groups past the
// 500th and ids past the 5,000th of a list are left out, as is an id longer
// than 200 characters; a name, subtitle, section name or note is cut to its
// length; a sort or session filter longer than 40 characters is not one, and
// is null (ccd-prefs.ts capBlob).
const MAX_GROUPS: usize = 500;
const MAX_IDS: usize = 5_000;
const MAX_ID: usize = 200;

fn cap_ids(v: &Json) -> Json {
    match v.as_arr() {
        Some(a) => Json::Arr(a.iter().filter(|x| x.as_str().map(|s| s.len() <= MAX_ID).unwrap_or(false)).take(MAX_IDS).cloned().collect()),
        None => v.clone(),
    }
}

fn cap_text(v: &Json, max: usize) -> Json {
    match v {
        Json::Str(s) if s.len() > max => Json::Str(s[..max].to_vec()),
        other => other.clone(),
    }
}

fn cap_word(v: &Json) -> Json {
    match v {
        Json::Str(s) if s.len() > 40 => Json::Null,
        other => other.clone(),
    }
}

fn cap_blob(blob: &mut Json) {
    if let Some(groups) = blob.get("groups").and_then(|g| g.as_arr()).cloned() {
        let capped: Vec<Json> = groups
            .into_iter()
            .filter(|g| g.get("id").and_then(|i| i.as_str()).map(|s| !s.is_empty() && s.len() <= MAX_ID).unwrap_or(false))
            .take(MAX_GROUPS)
            .map(|mut g| {
                for (k, max) in [("name", 400usize), ("subtitle", 400), ("sectionName", 200)] {
                    if let Some(v) = g.get(k).map(|v| cap_text(v, max)) {
                        g.set(k, v);
                    }
                }
                if let Some(v) = g.get("sessionIds").map(cap_ids) {
                    g.set("sessionIds", v);
                }
                if let Some(v) = g.get("sortBy").map(cap_word) {
                    g.set("sortBy", v);
                }
                // A side session whose id or parent's id is too long is left out.
                let fits = |x: &Json, k: &str| x.get(k).and_then(|i| i.as_str()).map(|s| s.len() <= MAX_ID).unwrap_or(false);
                if let Some(v) = g.get("sideSessions").and_then(|v| v.as_arr()).map(|a| a.iter().filter(|x| fits(x, "id") && fits(x, "parent")).take(MAX_IDS).cloned().collect::<Vec<Json>>()) {
                    g.set("sideSessions", Json::Arr(v));
                }
                g
            })
            .collect();
        blob.set("groups", Json::Arr(capped));
    }
    if let Some(v) = blob.get("unreadIds").map(cap_ids) {
        blob.set("unreadIds", v);
    }
    if let Some(v) = blob.get("note").map(|v| cap_text(v, 2_000)) {
        blob.set("note", v);
    }
    if let Some(v) = blob.get("statusFilter").map(cap_word) {
        blob.set("statusFilter", v);
    }
    if let Some(v) = blob.get("archivedIds").map(cap_ids) {
        blob.set("archivedIds", v);
    }
}

// ── The mirror ──────────────────────────────────────────────────────────────

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
        ("note", Json::str(DISABLED_NOTE)),
        ("syncedAtMs", Json::num(now_ms)),
    ])
}

/// The scoped layouts name the layout, the view filter, the archived members
/// and the live account (hashed) even when the account has no groups, so a
/// reader can tell an empty account from a client that predates them.
fn set_scoped_fields(blob: &mut Json, v: &SidebarView, archived_ids: Vec<Json>) {
    if let Some(layout) = v.layout {
        blob.set("layout", Json::str(layout));
        blob.set("statusFilter", v.status_filter.clone().map(Json::Str).unwrap_or(Json::Null));
        blob.set("archivedIds", Json::Arr(archived_ids));
        blob.set("scope", v.scope.as_deref().map(Json::str).unwrap_or(Json::Null));
    }
}

/// The Claude Desktop sidebar mirror the gateway stores: a disabled-empty
/// mirror when the app shows no custom groups. None when the store could not
/// be read whole: every upload is the device's whole sidebar, so the caller
/// skips the cycle rather than send one that would empty it.
/// One group's side sessions as (id, parent) pairs, local ids: walked from
/// `members` in member order, depth first, a session's side sessions in the
/// order `children_of` holds them (sorted by id). A session filed in a group
/// (`filed`) is drawn there and not walked; a session already reached is not
/// walked again.
fn side_sessions_of(members: &[JsStr], children_of: &HashMap<JsStr, Vec<JsStr>>, filed: &HashSet<JsStr>) -> Vec<(JsStr, JsStr)> {
    let mut out: Vec<(JsStr, JsStr)> = Vec::new();
    let mut reached: HashSet<JsStr> = members.iter().cloned().collect();
    // (parent, side session) pairs, pushed in reverse so the walk takes them in order.
    let push = |stack: &mut Vec<(JsStr, JsStr)>, parent: &JsStr| {
        if let Some(kids) = children_of.get(parent) {
            for k in kids.iter().rev() {
                stack.push((parent.clone(), k.clone()));
            }
        }
    };
    for m in members {
        let mut stack: Vec<(JsStr, JsStr)> = Vec::new();
        push(&mut stack, m);
        while let Some((parent, id)) = stack.pop() {
            if reached.contains(&id) || filed.contains(&id) {
                continue;
            }
            reached.insert(id.clone());
            push(&mut stack, &id);
            out.push((id, parent));
        }
    }
    out
}

pub fn build_group_mirror(now_ms: f64) -> Option<Json> {
    let empty = empty_mirror(now_ms);
    let ls_dir = match ccd_leveldb_dir() {
        Some(d) => d,
        None => return Some(empty),
    };
    let ldb_fp = leveldb_fingerprint(&ls_dir);
    // `fresh`: a side session the app just started is a new session file,
    // and the store write that wakes this build (its group's drawn row count
    // changes) would otherwise find the index held by its TTL for up to 20 s.
    let index_version = refresh_ccd_index_fresh(now_ms);
    {
        let c = cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = c.as_ref() {
            if hit.ldb_fp == ldb_fp && hit.index_version == index_version {
                return Some(with_synced_at(hit.blob.clone(), now_ms));
            }
        }
    }
    let (view, unread_js, failed) = read_store(&ls_dir);
    if failed {
        return None;
    }
    let view = match view {
        Some(v) if v.enabled => v,
        other => {
            let mut blob = empty.clone();
            blob.set("unreadIds", Json::Arr(unread_js.iter().map(|u| Json::Str(strip_code_prefix(u))).collect()));
            if let Some(v) = other {
                blob.set("note", Json::str(&v.note));
                set_scoped_fields(&mut blob, &v, Vec::new());
            }
            cap_blob(&mut blob);
            *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(MirrorCache { ldb_fp, index_version, blob: blob.clone() });
            return Some(blob);
        }
    };
    // Claude Desktop names its sessions by an internal id; the workbench keys
    // them by the cli/jsonl id, resolved from the per-session metadata. The
    // client's Map: the last record with an id wins, and an empty cli id
    // (falsy) maps nothing.
    let records = read_ccd_recents_cached(now_ms);
    let mut cli_by_ccd: HashMap<IdKey<'_>, &Arc<CcdSessionMeta>> = HashMap::with_capacity(records.len());
    let mut archived: HashSet<IdKey<'_>> = HashSet::new();
    for r in records.iter() {
        if r.has_cli_id() {
            cli_by_ccd.insert(r.ccd_key(), r);
        }
        if r.is_archived() {
            archived.insert(r.ccd_key());
        }
    }
    let to_cli = |local_id: &JsStr| -> JsStr {
        let id = wtf8::from_units(local_id);
        match cli_by_ccd.get(&ccd_id_key(&id)).and_then(|r| r.cli_session_id_units()) {
            Some(cli) => cli,
            None => local_id.clone(),
        }
    };
    // Side sessions (ccd-prefs.ts): the app draws a session spawned as a side
    // session of another under it, in that session's group, and theirs in
    // turn. Only the live account's session files count, and one filed in a
    // group of its own is drawn there. Each group's side sessions are walked
    // from its members in member order, depth first, a session's side
    // sessions in id order (UTF-16 code units, as `Array.prototype.sort`
    // orders them); a session already reached is not walked again.
    let mut children_of: HashMap<JsStr, Vec<JsStr>> = HashMap::new();
    if let (Some(_), Some(key)) = (view.layout, view.scope_key.as_ref()) {
        for r in ccd_records_in_scope(key) {
            if let Some(p) = r.parent_id_units() {
                children_of.entry(p).or_default().push(r.ccd_session_id_units());
            }
        }
        for kids in children_of.values_mut() {
            kids.sort();
        }
    }
    let filed: HashSet<JsStr> = view.groups.iter().flat_map(|g| g.members.iter().cloned()).collect();
    let side_by_group: Vec<Vec<(JsStr, JsStr)>> = if children_of.is_empty() {
        vec![Vec::new(); view.groups.len()]
    } else {
        view.groups.iter().map(|g| side_sessions_of(&g.members, &children_of, &filed)).collect()
    };
    let groups: Vec<Json> = view
        .groups
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let mut pairs: Vec<(&str, Json)> = vec![
                ("id", Json::Str(g.id.clone())),
                ("name", Json::Str(g.name.clone())),
                ("subtitle", g.subtitle.clone()),
                ("sectionName", g.section_name.clone()),
                ("collapsed", Json::Bool(g.collapsed)),
                ("sessionIds", Json::Arr(g.members.iter().map(|m| Json::Str(to_cli(m))).collect())),
            ];
            if let Some(x) = &g.extra {
                pairs.push(("sortBy", x.sort_by.clone().map(Json::Str).unwrap_or(Json::Null)));
                pairs.push(("ascending", x.ascending.map(Json::Bool).unwrap_or(Json::Null)));
                pairs.push(("shown", Json::Bool(x.shown)));
                pairs.push(("showEmpty", Json::Bool(x.show_empty)));
                let side = side_by_group[i].iter().map(|(id, parent)| obj(vec![("id", Json::Str(to_cli(id))), ("parent", Json::Str(to_cli(parent)))])).collect();
                pairs.push(("sideSessions", Json::Arr(side)));
            }
            obj(pairs)
        })
        .collect();
    // The members the app has archived, which its "active" session filter
    // hides (the server has no archived flag of its own), in group order, in
    // the id space of sessionIds; then the archived side sessions, in group order.
    let mut archived_ids: Vec<Json> = Vec::new();
    let mut seen_archived: HashSet<JsStr> = HashSet::new();
    let side_ids = side_by_group.iter().flat_map(|side| side.iter().map(|(id, _)| id));
    for local in view.groups.iter().flat_map(|g| g.members.iter()).chain(side_ids) {
        let units = wtf8::from_units(local);
        if !archived.contains(&ccd_id_key(&units)) {
            continue;
        }
        let id = to_cli(local);
        if seen_archived.insert(id.clone()) {
            archived_ids.push(Json::Str(id));
        }
    }
    let mut blob = obj(vec![
        ("groupingEnabled", Json::Bool(true)),
        ("groups", Json::Arr(groups)),
        ("unreadIds", Json::Arr(unread_js.iter().map(|u| Json::Str(to_cli(&strip_code_prefix(u)))).collect())),
        ("note", Json::str(&view.note)),
        ("syncedAtMs", Json::num(now_ms)),
    ]);
    set_scoped_fields(&mut blob, &view, archived_ids);
    cap_blob(&mut blob);
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(MirrorCache { ldb_fp, index_version, blob: blob.clone() });
    Some(blob)
}

/// The key of the group-mirror gate (watch.ts syncGroupMirror): the content
/// without the volatile stamp, unread ids sorted the way `Array.prototype.sort`
/// sorts, and the scoped layouts' blob fields.
pub fn group_mirror_gate(mirror: &Json) -> Json {
    let mut unread: Vec<JsStr> = mirror.get("unreadIds").and_then(|u| u.as_arr()).map(|a| a.iter().map(|v| v.to_js_string()).collect()).unwrap_or_default();
    unread.sort();
    let mut pairs: Vec<(&str, Json)> = vec![
        ("enabled", mirror.get("groupingEnabled").cloned().unwrap_or(Json::Bool(false))),
        ("groups", mirror.get("groups").cloned().unwrap_or(Json::Arr(Vec::new()))),
        ("unread", Json::Arr(unread.into_iter().map(Json::Str).collect())),
    ];
    if let Some(layout) = mirror.get("layout") {
        pairs.push(("layout", layout.clone()));
        pairs.push(("statusFilter", mirror.get("statusFilter").cloned().unwrap_or(Json::Null)));
        pairs.push(("archivedIds", mirror.get("archivedIds").cloned().unwrap_or(Json::Arr(Vec::new()))));
        pairs.push(("scope", mirror.get("scope").cloned().unwrap_or(Json::Null)));
    }
    // Codex's sections when the mirror carries them (absent after a failed read).
    if let Some(codex) = mirror.get("codex") {
        pairs.push(("codex", codex.clone()));
    }
    obj(pairs)
}

#[allow(dead_code)]
pub fn lossy_title(s: &JsStr) -> String {
    lossy(s)
}

// ── Watching the store (watchCcdSidebarStore) ───────────────────────────────

/// A burst of writes settles this long before the mirror is read.
pub const CCD_STORE_DEBOUNCE_MS: f64 = 200.0;
/// A store written without pause is still read this often.
pub const CCD_STORE_MAX_WAIT_MS: f64 = 1_000.0;

/// The Local Storage leveldb under watch: every write the app commits lands
/// in a `.log` (and a compaction rewrites `.ldb` files), so a write reaches
/// the mirror within about a second instead of at the next 20 s tick. The
/// writes not read yet are kept as their first and last event times.
pub struct SidebarWatch {
    _watcher: notify::RecommendedWatcher,
    pending: Arc<Mutex<Option<(f64, f64)>>>,
}

impl SidebarWatch {
    /// None when there is no store to watch. A watch that cannot be armed,
    /// or fails later, reports through `on_failure` (once), and the caller's
    /// timer keeps the mirror current at its own pace. `wake` runs on every
    /// write, from the watcher's thread.
    pub fn arm(wake: Arc<dyn Fn() + Send + Sync>, on_failure: Arc<dyn Fn(String) + Send + Sync>) -> Option<SidebarWatch> {
        let dir = ccd_leveldb_dir()?;
        if !Path::new(&dir).is_dir() {
            return None;
        }
        let pending: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
        let failed = Arc::new(AtomicBool::new(false));
        let (pending_cb, failed_cb, failure_cb, dir_cb) = (pending.clone(), failed.clone(), on_failure.clone(), dir.clone());
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| match res {
            Ok(ev) => {
                if failed_cb.load(Ordering::SeqCst) || matches!(ev.kind, EventKind::Access(_)) {
                    return;
                }
                let relevant = ev.paths.is_empty()
                    || ev.paths.iter().any(|p| {
                        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        name.ends_with(".log") || name.ends_with(".ldb")
                    });
                if !relevant {
                    return;
                }
                let now = now_ms();
                {
                    let mut g = pending_cb.lock().unwrap_or_else(|e| e.into_inner());
                    let first = match *g {
                        Some((first, _)) => first,
                        None => now,
                    };
                    *g = Some((first, now));
                }
                wake();
            }
            Err(e) => {
                if !failed_cb.swap(true, Ordering::SeqCst) {
                    failure_cb(format!("{}: {}", dir_cb, e));
                }
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                on_failure(format!("{}: {}", dir, e));
                return None;
            }
        };
        if let Err(e) = watcher.watch(Path::new(&dir), RecursiveMode::Recursive) {
            on_failure(format!("{}: {}", dir, e));
            return None;
        }
        Some(SidebarWatch { _watcher: watcher, pending })
    }

    /// When the writes not read yet are due to be read, if there are any:
    /// CCD_STORE_DEBOUNCE_MS after the last, at most CCD_STORE_MAX_WAIT_MS
    /// after the first.
    pub fn due_at(&self) -> Option<f64> {
        let g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending: Option<(f64, f64)> = *g;
        pending.map(|(first, last)| (last + CCD_STORE_DEBOUNCE_MS).min(first + CCD_STORE_MAX_WAIT_MS))
    }

    /// Take the writes not read yet when they are due: the caller reads the
    /// store now, and a write during that read starts the next burst.
    pub fn take_due(&self, now: f64) -> bool {
        let mut g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let due = match *g {
            Some((first, last)) => now >= (last + CCD_STORE_DEBOUNCE_MS).min(first + CCD_STORE_MAX_WAIT_MS),
            None => false,
        };
        if due {
            *g = None;
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(text: &str) -> SidebarView {
        resolve_view(&Json::parse(text).unwrap())
    }

    fn names(v: &SidebarView) -> Vec<String> {
        v.groups.iter().map(|g| lossy(&g.name)).collect()
    }

    fn members(g: &ViewGroup) -> Vec<String> {
        g.members.iter().map(|m| lossy(m)).collect()
    }

    const SCOPED: &str = r#"{
        "groupByByMode": {"code": "custom"},
        "recentsStatusFilter": "active",
        "collapsedGroups": ["pinned", "custom-g1"],
        "lastSidebarScopeKey": "acct-a/org-a",
        "customGroupsByScope": {
            "acct-a/org-a": {
                "groups": [{"id": "g1", "name": "One"}, {"id": "g2", "name": "Two"}, {"id": "g3", "name": "Three"}],
                "assignments": {"code:local_a": "g1", "code:local_b": "g1", "code:local_c": "g2"},
                "order": {"g1": ["code:local_a", "code:local_b", "code:local_c"], "g2": ["code:local_c"], "g3": []}
            },
            "acct-b/org-b": {"groups": [{"id": "gb", "name": "Second account"}], "assignments": {"code:local_d": "gb"}, "order": {"gb": ["code:local_d"]}}
        },
        "codeSidebarByScope": {
            "acct-a/org-a": {"sections": [
                {"id": "pinned", "kind": "pinned", "name": "", "order": 0},
                {"id": "g2", "kind": "manual", "name": "Two", "order": 4, "members": ["code:local_c"], "shown": false, "sortBy": "created", "ascending": false},
                {"id": "g1", "kind": "manual", "name": "One", "order": 3, "members": ["code:local_a", "code:local_b"], "collapsed": true, "sortBy": "alpha", "ascending": true, "show": {"emptyGroups": true}},
                {"id": "g3", "kind": "manual", "name": " ", "order": 2, "members": []},
                {"id": "sessions", "kind": "sessions", "name": "", "order": 5}
            ]},
            "acct-b/org-b": {"sections": [{"id": "gb", "kind": "manual", "name": "Second account", "order": 2, "members": ["code:local_d"]}]}
        }
    }"#;

    #[test]
    fn sections_are_the_live_accounts_drawn_groups() {
        let v = view(SCOPED);
        assert!(v.enabled);
        assert_eq!(v.layout, Some("sections"));
        assert_eq!(names(&v), vec!["Three", "One", "Two"]);
        assert_eq!(v.scope.as_deref(), Some(&sha256_hex(b"acct-a/org-a")[..16]));
        assert_eq!(v.status_filter.as_ref().map(|s| lossy(s)).as_deref(), Some("active"));
        let one = &v.groups[1];
        assert!(one.collapsed);
        assert_eq!(members(one), vec!["local_a", "local_b"]);
        // Stored alpha + ascending, which the sidebar draws Z to A; One's own
        // `show.emptyGroups` and Two's stored `shown: false` are not read.
        let x = one.extra.as_ref().unwrap();
        assert_eq!(x.sort_by.as_ref().map(|s| lossy(s)).as_deref(), Some("alpha"));
        assert_eq!(x.ascending, Some(false));
        assert!(x.shown && !x.show_empty);
        assert!(v.groups[2].extra.as_ref().unwrap().shown);
        assert_eq!(members(&v.groups[2]), vec!["local_c"]);
    }

    #[test]
    fn the_sort_is_the_one_the_sidebar_draws() {
        // alpha inverts the stored direction, a missing direction is false, and
        // a sort the normalizer does not know is "recency".
        let text = SCOPED
            .replace(r#""sortBy": "alpha", "ascending": true"#, r#""sortBy": "alpha", "ascending": false"#)
            .replace(r#""shown": false, "sortBy": "created", "ascending": false"#, r#""sortBy": "manual""#)
            .replace(r#""name": " ", "order": 2, "members": []"#, r#""name": " ", "order": 2, "members": [], "sortBy": "alpha""#);
        let sorts: Vec<(String, Option<bool>)> = view(&text)
            .groups
            .iter()
            .map(|g| {
                let x = g.extra.as_ref().unwrap();
                (x.sort_by.as_ref().map(|s| lossy(s)).unwrap_or_default(), x.ascending)
            })
            .collect();
        assert_eq!(sorts, vec![("alpha".to_string(), Some(true)), ("alpha".to_string(), Some(true)), ("recency".to_string(), Some(false))]);
    }

    #[test]
    fn show_empty_groups_is_the_sessions_sections_setting() {
        let on = SCOPED.replace(
            r#"{"id": "sessions", "kind": "sessions", "name": "", "order": 5}"#,
            r#"{"id": "sessions", "kind": "sessions", "name": "", "order": 5, "show": {"emptyGroups": true}}"#,
        );
        assert!(view(&on).groups.iter().all(|g| g.extra.as_ref().unwrap().show_empty));
        // One's own `show.emptyGroups: true` is never read.
        assert!(view(SCOPED).groups.iter().all(|g| !g.extra.as_ref().unwrap().show_empty));
    }

    #[test]
    fn an_account_switch_switches_the_groups() {
        let v = view(&SCOPED.replace("\"lastSidebarScopeKey\": \"acct-a/org-a\"", "\"lastSidebarScopeKey\": \"acct-b/org-b\""));
        assert_eq!(names(&v), vec!["Second account"]);
        assert_eq!(v.scope.as_deref(), Some(&sha256_hex(b"acct-b/org-b")[..16]));
    }

    #[test]
    fn without_sections_the_scoped_group_list_and_assignments() {
        let mut j = Json::parse(SCOPED).unwrap();
        j.remove("codeSidebarByScope");
        let v = resolve_view(&j);
        assert_eq!(v.layout, Some("scoped-groups"));
        assert_eq!(names(&v), vec!["One", "Two", "Three"]);
        assert!(v.groups[0].collapsed, "custom-g1 in collapsedGroups");
        assert_eq!(members(&v.groups[0]), vec!["local_a", "local_b"], "local_c moved to Two");
        assert_eq!(members(&v.groups[1]), vec!["local_c"]);
        j.set("groupByByMode", Json::parse(r#"{"code": "repo"}"#).unwrap());
        assert!(!resolve_view(&j).enabled);
    }

    #[test]
    fn no_live_scope_or_no_manual_section_is_disabled() {
        let mut j = Json::parse(SCOPED).unwrap();
        j.remove("lastSidebarScopeKey");
        let v = resolve_view(&j);
        assert!(!v.enabled);
        assert_eq!(v.scope, None);
        let none = view(&SCOPED.replace("\"kind\": \"manual\"", "\"kind\": \"other\""));
        assert!(!none.enabled);
        assert_eq!(none.layout, Some("sections"));
    }

    #[test]
    fn the_flat_layout_reads_as_before() {
        let v = view(r#"{"groupByByMode": {"code": "custom"}, "customGroups": [{"id": "f1", "name": " Flat ", "subtitle": "sub", "sectionName": "Work"}], "customGroupOrder": {"f1": ["code:local_a"]}, "customGroupAssignments": {"code:local_b": "f1"}, "collapsedGroups": ["f1"]}"#);
        assert!(v.enabled);
        assert_eq!(v.layout, None);
        assert_eq!(names(&v), vec!["Flat"]);
        assert_eq!(members(&v.groups[0]), vec!["local_a", "local_b"]);
        assert!(v.groups[0].collapsed && v.groups[0].extra.is_none());
    }

    #[test]
    fn the_gate_counts_the_scoped_blob_fields_only_when_present() {
        let flat = Json::parse(r#"{"groupingEnabled": true, "groups": [], "unreadIds": ["b", "a"], "note": "x", "syncedAtMs": 1}"#).unwrap();
        assert_eq!(group_mirror_gate(&flat).stringify(), r#"{"enabled":true,"groups":[],"unread":["a","b"]}"#);
        let scoped = Json::parse(r#"{"groupingEnabled": true, "groups": [], "unreadIds": [], "note": "x", "syncedAtMs": 1, "layout": "sections", "statusFilter": "active", "archivedIds": ["c"], "scope": "0123456789abcdef"}"#).unwrap();
        assert_eq!(group_mirror_gate(&scoped).stringify(), r#"{"enabled":true,"groups":[],"unread":[],"layout":"sections","statusFilter":"active","archivedIds":["c"],"scope":"0123456789abcdef"}"#);
    }

    #[test]
    fn the_blob_is_cut_to_the_gateways_limits() {
        let long_id = "i".repeat(201);
        let members: Vec<String> = (0..5_003).map(|i| format!("\"m{}\"", i)).collect();
        let text = format!(
            r#"{{"groupingEnabled": true, "groups": [{{"id": "{}", "name": "x", "subtitle": null, "sectionName": null, "collapsed": false, "sessionIds": []}}, {{"id": "g", "name": "{}", "subtitle": null, "sectionName": null, "collapsed": false, "sessionIds": [{}], "sortBy": "{}", "ascending": null, "shown": true, "showEmpty": false}}], "unreadIds": [], "note": "n", "syncedAtMs": 1, "layout": "sections", "statusFilter": "active", "archivedIds": [], "scope": null}}"#,
            long_id,
            "N".repeat(450),
            members.join(","),
            "s".repeat(41)
        );
        let mut blob = Json::parse(&text).unwrap();
        cap_blob(&mut blob);
        let groups = blob.get("groups").and_then(|g| g.as_arr()).unwrap();
        assert_eq!(groups.len(), 1, "an id over 200 characters leaves its group out");
        let g = &groups[0];
        assert_eq!(g.get("name").and_then(|n| n.as_str()).map(|n| n.len()), Some(400));
        assert_eq!(g.get("sessionIds").and_then(|s| s.as_arr()).map(|s| s.len()), Some(5_000));
        assert!(g.get("sortBy").map(|s| s.is_null()).unwrap_or(false));
    }

    #[test]
    fn side_sessions_are_walked_depth_first_in_id_order() {
        let j = |x: &str| js(x);
        let mut children: HashMap<JsStr, Vec<JsStr>> = HashMap::new();
        // a: s0, s1, s3, s7 (sorted); s1: s2; c: s6; s9 <-> s8 a cycle nobody reaches.
        children.insert(j("a"), vec![j("s0"), j("s1"), j("s3"), j("s7")]);
        children.insert(j("s1"), vec![j("s2")]);
        children.insert(j("c"), vec![j("s6")]);
        children.insert(j("s8"), vec![j("s9")]);
        children.insert(j("s9"), vec![j("s8")]);
        let filed: HashSet<JsStr> = [j("a"), j("b"), j("c"), j("s7")].into_iter().collect();
        let pairs = |members: &[&str]| -> Vec<(String, String)> {
            let m: Vec<JsStr> = members.iter().map(|x| js(x)).collect();
            side_sessions_of(&m, &children, &filed).into_iter().map(|(id, p)| (lossy(&id), lossy(&p))).collect()
        };
        let want = |v: &[(&str, &str)]| -> Vec<(String, String)> { v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        // s7 is filed in a group of its own; s2 comes right after its parent s1.
        assert_eq!(pairs(&["a", "b"]), want(&[("s0", "a"), ("s1", "a"), ("s2", "s1"), ("s3", "a")]));
        assert_eq!(pairs(&["c"]), want(&[("s6", "c")]));
        assert_eq!(pairs(&["s7"]), want(&[]));
        // A member that is also another member's side session is not repeated.
        assert_eq!(pairs(&["a", "s1"]), want(&[("s0", "a"), ("s3", "a"), ("s2", "s1")]));
    }
}
