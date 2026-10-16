//! The sync ledger (src/ledger.ts): every tracked session in exactly one
//! bucket, and the one percentage `hx status` prints.

use std::collections::HashSet;

use crate::js::{iso_string, num_to_string};
use crate::json::{obj, Json, OMap};
use crate::state::dest_key;

/// How long after its last write a session still counts as "in progress".
pub const LIVE_WINDOW_MS: f64 = 15.0 * 60_000.0;
/// Consecutive hard rejections before a destination reads as FAILING.
pub const FAILING_AFTER: f64 = 3.0;
/// How long a destination must be offline before the user is asked to decide.
pub const NEEDS_YOU_DAYS: f64 = 7.0;

#[derive(Clone, Debug)]
pub struct LedgerFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug)]
pub struct DestinationLag {
    pub key: String,
    pub vault_org_id: Option<String>,
    pub label: String,
    pub sessions: u64,
    pub bytes: f64,
    pub last_seen_at: Option<Json>,
    pub offline_days: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct FailingDestination {
    pub key: String,
    pub label: String,
    pub error_code: String,
    pub failing_hours: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct SyncLedger {
    pub total: u64,
    pub total_bytes: f64,
    pub oldest_ms: Option<f64>,
    pub newest_ms: Option<f64>,
    pub delivered: u64,
    pub live: u64,
    pub uploading: u64,
    pub waiting: u64,
    pub waiting_unprotected: u64,
    pub incomplete: u64,
    pub percent: f64,
    pub delivered_bytes: f64,
    pub uploading_bytes: f64,
    pub waiting_bytes: f64,
    /// Per-session diagnoses as the JSON objects the report prints, sorted by owed bytes.
    pub not_delivered: Vec<Json>,
    pub lagging: Vec<DestinationLag>,
    pub failing: Vec<FailingDestination>,
}

fn record_of<'a>(state: &'a Json, key: &str) -> Option<&'a Json> {
    state.get("destinations").and_then(|d| d.get(key))
}

/// Is this destination known to be unreachable right now? Read from the
/// durable registry, never from a file's latch; the primary bucket never is.
pub fn is_destination_offline(state: &Json, key: &str) -> bool {
    if key == dest_key(None) {
        return false;
    }
    record_of(state, key).and_then(|r| r.get_string("status")).as_deref() == Some("held")
}

fn has_reachable_complete_copy(fs: Option<&Json>, size: f64, state: &Json) -> bool {
    if let Some(o) = fs.and_then(|f| f.get("offsets")).and_then(|o| o.as_obj()) {
        for (key, v) in o.iter() {
            if is_destination_offline(state, key) {
                continue;
            }
            if v.as_f64().unwrap_or(0.0) >= size {
                return true;
            }
        }
    }
    false
}

/// Every destination key some file has committed bytes to.
pub fn ever_written_keys(state: &Json) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Some(files) = state.get("files").and_then(|f| f.as_obj()) {
        for (_, fs) in files.iter() {
            if let Some(o) = fs.get("offsets").and_then(|o| o.as_obj()) {
                for (k, v) in o.iter() {
                    if v.as_f64().map(|n| n > 0.0).unwrap_or(false) {
                        out.insert(k.clone());
                    }
                }
            }
        }
    }
    out
}

/// A key naming a destination this device has no evidence of.
pub fn is_phantom_key(state: &Json, key: &str, offset: f64, ever_written: &HashSet<String>) -> bool {
    if offset > 0.0 || key == dest_key(None) {
        return false;
    }
    if state.get("destinations").is_none() {
        return false;
    }
    if ever_written.contains(key) {
        return false;
    }
    record_of(state, key).is_none()
}

/// Per-destination undelivered bytes for one file, split by reachability.
/// `offline` keeps the offsets' key order, as the client's Map does.
fn lag_of(fs: Option<&Json>, size: f64, state: &Json, ever_written: &HashSet<String>) -> (f64, Vec<(String, f64)>) {
    let mut offline: Vec<(String, f64)> = Vec::new();
    let mut reachable = 0.0;
    let offsets: Vec<(String, f64)> = match fs.and_then(|f| f.get("offsets")).and_then(|o| o.as_obj()) {
        Some(o) => o.iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect(),
        None => Vec::new(),
    };
    if offsets.is_empty() {
        return (size, offline);
    }
    let mut saw_real = false;
    for (key, off) in &offsets {
        if is_phantom_key(state, key, *off, ever_written) {
            continue;
        }
        saw_real = true;
        let pending = size - off;
        if pending <= 0.0 {
            continue;
        }
        if is_destination_offline(state, key) {
            match offline.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = pending,
                None => offline.push((key.clone(), pending)),
            }
        } else {
            reachable += pending;
        }
    }
    if !saw_real {
        return (size, Vec::new());
    }
    (reachable, offline)
}

/// Least-advanced offset across destinations that actually exist; for reporting only.
pub fn reportable_offset(fs: &Json, state: &Json, ever_written: &HashSet<String>) -> f64 {
    let mut min = f64::INFINITY;
    let mut any = false;
    if let Some(o) = fs.get("offsets").and_then(|o| o.as_obj()) {
        for (k, v) in o.iter() {
            let off = v.as_f64().unwrap_or(0.0);
            if !is_phantom_key(state, k, off, ever_written) {
                any = true;
                if off < min {
                    min = off;
                }
            }
        }
    }
    if any {
        min
    } else {
        0.0
    }
}

pub struct Classified {
    /// "delivered" | "live" | "uploading" | "waiting"
    pub state: &'static str,
    pub reachable_bytes: f64,
    pub offline: Vec<(String, f64)>,
    pub unprotected: bool,
}

pub fn classify_file(file: &LedgerFile, state: &Json, now_ms: f64, ever_written: &HashSet<String>) -> Classified {
    let fs = state.get("files").and_then(|m| m.get(&file.path));
    let size = file.size as f64;
    let (reachable, offline) = lag_of(fs, size, state, ever_written);
    let unprotected = !offline.is_empty() && !has_reachable_complete_copy(fs, size, state);
    if now_ms - file.mtime_ms < LIVE_WINDOW_MS {
        return Classified { state: "live", reachable_bytes: reachable, offline, unprotected: false };
    }
    if reachable > 0.0 {
        return Classified { state: "uploading", reachable_bytes: reachable, offline, unprotected };
    }
    if !offline.is_empty() {
        return Classified { state: "waiting", reachable_bytes: 0.0, offline, unprotected };
    }
    Classified { state: "delivered", reachable_bytes: 0.0, offline, unprotected: false }
}

fn offline_days_of(state: &Json, key: &str, now_ms: f64) -> Option<f64> {
    let since = record_of(state, key)?.get_f64("heldSinceMs")?;
    Some(((now_ms - since) / 86_400_000.0).floor())
}

fn org_name_of(org_names: &OMap, vault_org_id: Option<&str>) -> Option<String> {
    let id = vault_org_id?;
    if id.is_empty() {
        return None;
    }
    org_names.get(id).and_then(|v| v.as_string()).filter(|s| !s.is_empty())
}

fn truthy_string(v: Option<&Json>) -> Option<String> {
    v.and_then(|x| x.as_string()).filter(|s| !s.is_empty())
}

/// Fold the discovered files and the persisted offsets into the ledger.
pub fn build_ledger(files: &[LedgerFile], state: &Json, incomplete_sessions: u64, now_ms: f64, org_names: &OMap) -> SyncLedger {
    let mut delivered = 0u64;
    let mut live = 0u64;
    let mut uploading = 0u64;
    let mut waiting = 0u64;
    let mut waiting_unprotected = 0u64;
    let mut total_bytes = 0.0f64;
    let mut oldest_ms: Option<f64> = None;
    let mut newest_ms: Option<f64> = None;
    let mut delivered_bytes = 0.0f64;
    let mut uploading_bytes = 0.0f64;
    let mut waiting_bytes = 0.0f64;
    let ever_written = ever_written_keys(state);
    // key → (sessions, bytes), in first-seen order.
    let mut lag: Vec<(String, u64, f64)> = Vec::new();
    let mut not_delivered: Vec<(f64, Json)> = Vec::new();

    for file in files {
        let size = file.size as f64;
        total_bytes += size;
        if oldest_ms.map(|o| file.mtime_ms < o).unwrap_or(true) {
            oldest_ms = Some(file.mtime_ms);
        }
        if newest_ms.map(|n| file.mtime_ms > n).unwrap_or(true) {
            newest_ms = Some(file.mtime_ms);
        }
        let c = classify_file(file, state, now_ms, &ever_written);
        if c.state != "delivered" {
            let fs = state.get("files").and_then(|m| m.get(&file.path));
            let offsets: Vec<(String, f64)> = match fs.and_then(|f| f.get("offsets")).and_then(|o| o.as_obj()) {
                Some(o) => o.iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect(),
                None => Vec::new(),
            };
            let pairs: Vec<(String, f64)> = if offsets.is_empty() { vec![(dest_key(None), 0.0)] } else { offsets };
            let mut standings: Vec<Json> = Vec::new();
            let mut owed_total = 0.0f64;
            let mut any_owed = false;
            for (key, offset) in &pairs {
                let record = record_of(state, key);
                let vault_id = record.and_then(|r| r.get_string("vaultOrgId"));
                let label = org_name_of(org_names, vault_id.as_deref())
                    .or_else(|| truthy_string(record.and_then(|r| r.get("orgName"))))
                    .unwrap_or_else(|| key.clone());
                let known = *key == dest_key(None) || record.is_some();
                let owed = (size - offset).max(0.0);
                if owed > 0.0 {
                    any_owed = true;
                }
                owed_total += owed;
                let st = if is_destination_offline(state, key) {
                    "offline"
                } else if known {
                    "reachable"
                } else {
                    "unknown"
                };
                standings.push(obj(vec![
                    ("key", Json::str(key)),
                    ("label", Json::str(&label)),
                    ("offset", Json::num(*offset)),
                    ("owed", Json::num(owed)),
                    ("state", Json::str(st)),
                ]));
            }
            if any_owed {
                let last_upload = fs.and_then(|f| f.get_f64("lastUploadAtMs")).filter(|v| *v != 0.0);
                let next_attempt = fs.and_then(|f| f.get_f64("nextAttemptAtMs")).filter(|v| *v != 0.0);
                let diagnosis = obj(vec![
                    ("sessionId", Json::str(&fs.and_then(|f| f.get_string("sessionId")).unwrap_or_else(|| file.path.clone()))),
                    ("family", Json::str(&fs.and_then(|f| f.get_string("family")).unwrap_or_else(|| "unknown".to_string()))),
                    ("path", Json::str(&file.path)),
                    ("bucket", Json::str(c.state)),
                    ("sizeBytes", Json::num(size)),
                    ("owedBytes", Json::num(owed_total)),
                    ("ageDays", Json::num(((now_ms - file.mtime_ms) / 86_400_000.0).floor())),
                    ("lastUploadAt", match last_upload {
                        Some(ms) => Json::str(&iso_string(ms)),
                        None => Json::Null,
                    }),
                    ("skipReason", fs.and_then(|f| f.get("skipReason")).cloned().unwrap_or(Json::Null)),
                    ("consecutiveFailures", Json::num(fs.and_then(|f| f.get_f64("consecutiveFailures")).unwrap_or(0.0))),
                    ("nextAttemptAt", match next_attempt {
                        Some(ms) => Json::str(&iso_string(ms)),
                        None => Json::Null,
                    }),
                    ("repoSlug", fs.and_then(|f| f.get("repoSlug")).cloned().unwrap_or(Json::Null)),
                    ("attributed", fs.and_then(|f| f.get("attributed")).cloned().unwrap_or(Json::Null)),
                    ("destinations", Json::Arr(standings)),
                ]);
                not_delivered.push((owed_total, diagnosis));
            }
        }
        match c.state {
            "delivered" => {
                delivered += 1;
                delivered_bytes += size;
            }
            "live" => live += 1,
            "uploading" => {
                uploading += 1;
                uploading_bytes += c.reachable_bytes;
            }
            "waiting" => {
                waiting += 1;
                if c.unprotected {
                    waiting_unprotected += 1;
                }
                let mut largest = 0.0f64;
                for (key, pending) in &c.offline {
                    match lag.iter_mut().find(|(k, _, _)| k == key) {
                        Some(slot) => {
                            slot.1 += 1;
                            slot.2 += pending;
                        }
                        None => lag.push((key.clone(), 1, *pending)),
                    }
                    if *pending > largest {
                        largest = *pending;
                    }
                }
                waiting_bytes += largest;
            }
            _ => {}
        }
    }

    let sendable = delivered + uploading + waiting_unprotected;
    let percent = if sendable == 0 { 100.0 } else { ((delivered as f64 / sendable as f64) * 100.0).floor() };

    let mut lagging: Vec<DestinationLag> = lag
        .iter()
        .map(|(key, sessions, bytes)| {
            let record = record_of(state, key);
            let vault_org_id: Option<String> = match record.and_then(|r| r.get("vaultOrgId")) {
                Some(Json::Str(s)) => Some(crate::js::lossy(s)),
                _ => {
                    if *key == dest_key(None) {
                        None
                    } else {
                        Some(key.clone())
                    }
                }
            };
            let label = org_name_of(org_names, vault_org_id.as_deref())
                .or_else(|| truthy_string(record.and_then(|r| r.get("orgName"))))
                .or_else(|| vault_org_id.clone().filter(|v| !v.is_empty()))
                .unwrap_or_else(|| key.clone());
            DestinationLag {
                key: key.clone(),
                vault_org_id,
                label,
                sessions: *sessions,
                bytes: *bytes,
                last_seen_at: record.and_then(|r| r.get("lastSeenAt")).filter(|v| !v.is_null()).cloned(),
                offline_days: offline_days_of(state, key, now_ms),
            }
        })
        .collect();
    lagging.sort_by(|a, b| {
        let da = a.offline_days.unwrap_or(-1.0);
        let db = b.offline_days.unwrap_or(-1.0);
        match db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal) {
            std::cmp::Ordering::Equal => b.sessions.cmp(&a.sessions),
            o => o,
        }
    });

    not_delivered.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    SyncLedger {
        total: files.len() as u64,
        total_bytes,
        oldest_ms,
        newest_ms,
        delivered,
        live,
        uploading,
        waiting,
        waiting_unprotected,
        incomplete: incomplete_sessions,
        percent,
        delivered_bytes,
        uploading_bytes,
        waiting_bytes,
        not_delivered: not_delivered.into_iter().map(|(_, d)| d).collect(),
        lagging,
        failing: failing_destinations(state, now_ms, org_names),
    }
}

/// "offline 13d", "offline since today", or "offline" when the start is unknown.
pub fn format_outage(days: Option<f64>) -> String {
    match days {
        None => "offline".to_string(),
        Some(d) if d < 1.0 => "offline since today".to_string(),
        Some(d) => format!("offline {}d", num_to_string(d)),
    }
}

/// Reachable destinations currently latched on a hard-failure run, longest first.
pub fn failing_destinations(state: &Json, now_ms: f64, org_names: &OMap) -> Vec<FailingDestination> {
    let mut out: Vec<FailingDestination> = Vec::new();
    if let Some(registry) = state.get("destinations").and_then(|d| d.as_obj()) {
        for (key, record) in registry.iter() {
            if record.get_string("status").as_deref() == Some("held") {
                continue;
            }
            if record.get_f64("consecutiveErrors").unwrap_or(0.0) < FAILING_AFTER {
                continue;
            }
            let vault_id = record.get_string("vaultOrgId");
            let vault_is_null = matches!(record.get("vaultOrgId"), Some(Json::Null));
            let label = org_name_of(org_names, vault_id.as_deref())
                .or_else(|| truthy_string(record.get("orgName")))
                .unwrap_or_else(|| if vault_is_null || *key == dest_key(None) { "primary store".to_string() } else { key.clone() });
            out.push(FailingDestination {
                key: key.clone(),
                label,
                error_code: record.get_string("lastErrorCode").unwrap_or_else(|| "unknown error".to_string()),
                failing_hours: record.get_f64("failingSinceMs").map(|since| ((now_ms - since) / 3_600_000.0).floor()),
            });
        }
    }
    out.sort_by(|a, b| {
        let fa = a.failing_hours.unwrap_or(-1.0);
        let fb = b.failing_hours.unwrap_or(-1.0);
        fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Destinations offline long enough that they will not fix themselves.
pub fn needs_attention(ledger: &SyncLedger) -> Vec<&DestinationLag> {
    ledger.lagging.iter().filter(|d| d.offline_days.unwrap_or(0.0) >= NEEDS_YOU_DAYS).collect()
}

fn opt_num(v: Option<f64>) -> Json {
    match v {
        Some(n) => Json::num(n),
        None => Json::Null,
    }
}

impl SyncLedger {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("total", Json::num(self.total as f64)),
            ("totalBytes", Json::num(self.total_bytes)),
            ("oldestMs", opt_num(self.oldest_ms)),
            ("newestMs", opt_num(self.newest_ms)),
            ("delivered", Json::num(self.delivered as f64)),
            ("live", Json::num(self.live as f64)),
            ("uploading", Json::num(self.uploading as f64)),
            ("waiting", Json::num(self.waiting as f64)),
            ("waitingUnprotected", Json::num(self.waiting_unprotected as f64)),
            ("incomplete", Json::num(self.incomplete as f64)),
            ("percent", Json::num(self.percent)),
            ("deliveredBytes", Json::num(self.delivered_bytes)),
            ("uploadingBytes", Json::num(self.uploading_bytes)),
            ("waitingBytes", Json::num(self.waiting_bytes)),
            ("notDelivered", Json::Arr(self.not_delivered.clone())),
            (
                "lagging",
                Json::Arr(
                    self.lagging
                        .iter()
                        .map(|d| {
                            obj(vec![
                                ("key", Json::str(&d.key)),
                                ("vaultOrgId", Json::opt_str(d.vault_org_id.as_deref())),
                                ("label", Json::str(&d.label)),
                                ("sessions", Json::num(d.sessions as f64)),
                                ("bytes", Json::num(d.bytes)),
                                ("lastSeenAt", d.last_seen_at.clone().unwrap_or(Json::Null)),
                                ("offlineDays", opt_num(d.offline_days)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "failing",
                Json::Arr(
                    self.failing
                        .iter()
                        .map(|f| {
                            obj(vec![
                                ("key", Json::str(&f.key)),
                                ("label", Json::str(&f.label)),
                                ("errorCode", Json::str(&f.error_code)),
                                ("failingHours", opt_num(f.failing_hours)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}
