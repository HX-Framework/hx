//! `hx status --detailed` / `hx doctor sync` (src/diagnostics.ts): the report
//! over the sync ledger, as JSON and as text.

use crate::js::{en_month_day, iso_date, iso_string, js_locale_compare, lossy, num_to_string, to_fixed_div_pow2, to_locale_string_int};
use crate::json::{obj, Json};
use crate::ledger::{format_outage, SyncLedger};
use crate::net::encode_uri_component;
use crate::pathnorm::collapse_home;
use crate::roots::ResolvedRoots;

/// A state entry that is no longer discoverable on disk yet never finished uploading.
#[derive(Clone, Debug)]
pub struct SyncBehindEntry {
    pub path: String,
    pub session_id: String,
    pub uploaded: f64,
    pub last_known_size: f64,
    pub source_gone: bool,
}

/// A discoverable session whose upload is paused because its destination is unavailable.
#[derive(Clone, Debug)]
pub struct SyncSkippedEntry {
    pub path: String,
    pub family: String,
    pub session_id: String,
    pub reason: String,
    pub next_attempt_at_ms: Option<f64>,
    pub blocker: Option<Json>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChildLanes {
    pub tracked: u64,
    pub on_disk: u64,
    pub gone: u64,
    pub owing: u64,
    pub owed_bytes: f64,
}

/// `computeSyncReport`'s result.
pub struct SyncReport {
    pub snapshot_total: u64,
    pub snapshot_done: u64,
    pub snapshot_total_bytes: u64,
    pub behind: Vec<SyncBehindEntry>,
    pub skipped: Vec<SyncSkippedEntry>,
    pub ledger: SyncLedger,
    /// `{path, family, sessionId, repoSlug, cwd, attributed, reason}` per excluded session.
    pub excluded: Vec<Json>,
    pub undiscovered_file_gone: u64,
    pub undiscovered_on_disk: u64,
    pub child_lanes: ChildLanes,
    pub unwatched: u64,
}

struct Blocker {
    reason: String,
    destination: Option<Json>,
    /// (key, {family, sessionId}) in first-seen order, one per session.
    sessions: Vec<(String, Json)>,
    first_observed_ms: Option<f64>,
    last_observed_ms: Option<f64>,
    next_retry_ms: Option<f64>,
}

fn destination_key(reason: &str, destination: Option<&Json>) -> String {
    match destination {
        None => format!("{}:legacy", reason),
        Some(d) => format!(
            "{}:{}:{}:{}",
            reason,
            d.get_string("vaultOrgId").unwrap_or_else(|| "undefined".to_string()),
            d.get_string("projectId").unwrap_or_default(),
            d.get_string("repoSlug").unwrap_or_default()
        ),
    }
}

/// Group skipped files by the destination actually holding them.
fn group_sync_blockers(skipped: &[SyncSkippedEntry]) -> Vec<Blocker> {
    let mut groups: Vec<(String, Blocker)> = Vec::new();
    for entry in skipped {
        let destinations: Vec<Option<Json>> = match entry.blocker.as_ref().and_then(|b| b.get("destinations")).and_then(|d| d.as_arr()) {
            Some(list) if !list.is_empty() => list.iter().map(|d| Some(d.clone())).collect(),
            _ => vec![None],
        };
        for destination in destinations {
            let key = destination_key(&entry.reason, destination.as_ref());
            let idx = match groups.iter().position(|(k, _)| *k == key) {
                Some(i) => i,
                None => {
                    groups.push((
                        key.clone(),
                        Blocker { reason: entry.reason.clone(), destination: destination.clone(), sessions: Vec::new(), first_observed_ms: None, last_observed_ms: None, next_retry_ms: None },
                    ));
                    groups.len() - 1
                }
            };
            let group = &mut groups[idx].1;
            let skey = format!("{}:{}", entry.family, entry.session_id);
            let session = obj(vec![("family", Json::str(&entry.family)), ("sessionId", Json::str(&entry.session_id))]);
            match group.sessions.iter_mut().find(|(k, _)| *k == skey) {
                Some(slot) => slot.1 = session,
                None => group.sessions.push((skey, session)),
            }
            if let Some(first) = entry.blocker.as_ref().and_then(|b| b.get_f64("firstSeenAtMs")) {
                group.first_observed_ms = Some(match group.first_observed_ms {
                    Some(v) => v.min(first),
                    None => first,
                });
            }
            if let Some(last) = entry.blocker.as_ref().and_then(|b| b.get_f64("lastSeenAtMs")) {
                group.last_observed_ms = Some(match group.last_observed_ms {
                    Some(v) => v.max(last),
                    None => last,
                });
            }
            if let Some(next) = entry.next_attempt_at_ms {
                group.next_retry_ms = Some(match group.next_retry_ms {
                    Some(v) => v.min(next),
                    None => next,
                });
            }
        }
    }
    groups.into_iter().map(|(_, g)| g).collect()
}

/// `new URL(url).origin`, or None when the URL does not parse.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_lowercase();
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
        return None;
    }
    let authority = rest.split(|c| c == '/' || c == '?' || c == '#').next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if authority.is_empty() {
        return None;
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        (authority[..=end].to_string(), authority[end + 1..].strip_prefix(':').map(|p| p.to_string()))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h.to_string(), if p.is_empty() { None } else { Some(p.to_string()) }),
            _ => (authority.to_string(), None),
        }
    };
    let host = host.to_lowercase();
    let default_port = match scheme.as_str() {
        "http" | "ws" => Some("80"),
        "https" | "wss" => Some("443"),
        _ => None,
    };
    let port = match port {
        Some(p) if Some(p.as_str()) != default_port => Some(p),
        _ => None,
    };
    Some(match port {
        Some(p) => format!("{}://{}:{}", scheme, host, p),
        None => format!("{}://{}", scheme, host),
    })
}

fn settings_urls(gateway_base_url: &str, destination: Option<&Json>) -> Json {
    let origin = origin_of(gateway_base_url);
    let org = destination.and_then(|d| d.get_string("orgSlug")).filter(|s| !s.is_empty());
    let project = destination.and_then(|d| d.get_string("projectSlug")).filter(|s| !s.is_empty());
    let fortress = match (&origin, &org) {
        (Some(o), Some(g)) => Json::str(&format!("{}/{}/settings#fortress", o, encode_uri_component(g))),
        _ => Json::Null,
    };
    let repository = match (&origin, &org, &project) {
        (Some(o), Some(g), Some(p)) => Json::str(&format!("{}/{}/{}/settings#repositories", o, encode_uri_component(g), encode_uri_component(p))),
        _ => Json::Null,
    };
    obj(vec![
        ("fortressSettingsUrl", fortress),
        ("repositorySettingsUrl", repository),
        ("guidance", Json::str("Bring the Fortress online, or detach/move the repository to a project backed by a live Fortress.")),
        ("retryCommand", Json::str(&format!("{} retry --blocked", crate::bin_name()))),
    ])
}

fn iso_opt(ms: Option<f64>) -> Json {
    match ms {
        Some(v) => Json::str(&iso_string(v)),
        None => Json::Null,
    }
}

pub struct Doctor {
    pub ok: bool,
    pub json: Json,
}

/// `buildSyncDoctorReport`.
pub fn build_sync_doctor_report(report: &SyncReport, gateway_base_url: &str, now_ms: f64, roots: Option<&ResolvedRoots>) -> Doctor {
    let groups = group_sync_blockers(&report.skipped);
    let mut blocked_keys: Vec<String> = Vec::new();
    for e in &report.skipped {
        let k = format!("{}:{}", e.family, e.session_id);
        if !blocked_keys.contains(&k) {
            blocked_keys.push(k);
        }
    }
    let mut gone: Vec<String> = Vec::new();
    for b in report.behind.iter().filter(|b| b.source_gone) {
        if !gone.contains(&b.session_id) {
            gone.push(b.session_id.clone());
        }
    }
    let mut aged: Vec<String> = Vec::new();
    for b in report.behind.iter().filter(|b| !b.source_gone && !gone.contains(&b.session_id)) {
        if !aged.contains(&b.session_id) {
            aged.push(b.session_id.clone());
        }
    }
    let percent = if report.snapshot_total == 0 { 100.0 } else { ((report.snapshot_done as f64 / report.snapshot_total as f64) * 100.0).floor() };
    let blockers: Vec<Json> = groups
        .iter()
        .map(|g| {
            let mut sessions: Vec<&(String, Json)> = g.sessions.iter().collect();
            sessions.sort_by(|a, b| js_locale_compare(&a.0, &b.0));
            obj(vec![
                ("reason", Json::str(&g.reason)),
                ("sessionCount", Json::num(g.sessions.len() as f64)),
                ("sessions", Json::Arr(sessions.iter().map(|(_, s)| s.clone()).collect())),
                ("destination", g.destination.clone().unwrap_or(Json::Null)),
                ("firstObservedAt", iso_opt(g.first_observed_ms)),
                ("lastObservedAt", iso_opt(g.last_observed_ms)),
                ("nextRetryAt", iso_opt(g.next_retry_ms)),
                ("remediation", settings_urls(gateway_base_url, g.destination.as_ref())),
            ])
        })
        .collect();
    let mut gap: Vec<String> = gone.clone();
    for a in &aged {
        if !gap.contains(a) {
            gap.push(a.clone());
        }
    }
    let ok = blocked_keys.is_empty() && gap.is_empty() && report.snapshot_done >= report.snapshot_total;
    let roots_json: Vec<Json> = match roots {
        Some(r) => r
            .claude
            .iter()
            .map(|d| ("claude", d))
            .chain(r.codex.iter().map(|d| ("codex", d)))
            .map(|(family, d)| obj(vec![("family", Json::str(family)), ("configDir", Json::str(&d.config_dir)), ("origin", Json::str(d.origin)), ("exists", Json::Bool(d.exists))]))
            .collect(),
        None => Vec::new(),
    };
    let json = obj(vec![
        ("ok", Json::Bool(ok)),
        ("generatedAt", Json::str(&iso_string(now_ms))),
        (
            "sync",
            obj(vec![
                ("total", Json::num(report.snapshot_total as f64)),
                ("done", Json::num(report.snapshot_done as f64)),
                ("percent", Json::num(percent)),
                ("totalBytes", Json::num(report.snapshot_total_bytes as f64)),
            ]),
        ),
        ("blockedSessions", Json::num(blocked_keys.len() as f64)),
        (
            "gaps",
            obj(vec![
                ("sessions", Json::num(gap.len() as f64)),
                ("localFileDeleted", Json::num(gone.len() as f64)),
                ("outsideScanWindow", Json::num(aged.len() as f64)),
            ]),
        ),
        ("blockers", Json::Arr(blockers)),
        ("ledger", report.ledger.to_json()),
        ("roots", Json::Arr(roots_json)),
        ("unwatchedSessions", Json::num(report.unwatched as f64)),
        ("excluded", Json::Arr(report.excluded.clone())),
        (
            "undiscovered",
            obj(vec![
                ("fileGone", Json::num(report.undiscovered_file_gone as f64)),
                ("onDiskButUndiscovered", Json::num(report.undiscovered_on_disk as f64)),
            ]),
        ),
        (
            "childLanes",
            obj(vec![
                ("tracked", Json::num(report.child_lanes.tracked as f64)),
                ("onDisk", Json::num(report.child_lanes.on_disk as f64)),
                ("gone", Json::num(report.child_lanes.gone as f64)),
                ("owing", Json::num(report.child_lanes.owing as f64)),
                ("owedBytes", Json::num(report.child_lanes.owed_bytes)),
            ]),
        ),
    ]);
    Doctor { ok, json }
}

/// "Jan 20" or "Jan 20, 2026" (UTC), or the value itself when it is not a date.
fn short_date(value: &str, now_ms: f64) -> String {
    use chrono::Datelike;
    let date = match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(d) => d.with_timezone(&chrono::Utc),
        Err(_) => return value.to_string(),
    };
    let now_year = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms.trunc() as i64).map(|d| d.year()).unwrap_or(date.year());
    en_month_day(date.year(), date.month(), date.day(), date.year() != now_year)
}

/// Compact root cause for the default `hx status` table.
pub fn format_status_blocker(skipped: &[SyncSkippedEntry], now_ms: f64) -> String {
    let groups = group_sync_blockers(skipped);
    let mut keys: Vec<String> = Vec::new();
    for e in skipped {
        let k = format!("{}:{}", e.family, e.session_id);
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let sessions = keys.len();
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    if groups.len() != 1 || groups[0].destination.is_none() {
        if groups.len() == 1 {
            return format!("{} session{} — destination store unavailable", sessions, plural(sessions));
        }
        return format!("{} session{} across {} blocked destination{}", sessions, plural(sessions), groups.len(), plural(groups.len()));
    }
    let d = groups[0].destination.as_ref().expect("checked");
    let org = d
        .get("orgName")
        .filter(|v| !v.is_null())
        .or_else(|| d.get("orgSlug").filter(|v| !v.is_null()))
        .or_else(|| d.get("vaultOrgId"))
        .map(|v| lossy(&v.to_js_string()))
        .unwrap_or_else(|| "undefined".to_string());
    let heartbeat = match d.get_string("lastSeenAt").filter(|s| !s.is_empty()) {
        Some(seen) => format!(" since {}", short_date(&seen, now_ms)),
        None => String::new(),
    };
    let repo = match d.get_string("repoSlug").filter(|s| !s.is_empty()) {
        Some(r) => format!(" · {}", r),
        None => String::new(),
    };
    format!("{} session{} — {} Fortress offline{}{}", sessions, plural(sessions), org, heartbeat, repo)
}

/// `fmtBytes`.
pub fn fmt_bytes(n: f64) -> String {
    if n < 1024.0 {
        return format!("{} B", num_to_string(n));
    }
    let whole = n.trunc() as u64;
    if n < 1024.0 * 1024.0 {
        return format!("{} KB", to_fixed_div_pow2(whole, 10, 1));
    }
    if n < 1024.0 * 1024.0 * 1024.0 {
        return format!("{} MB", to_fixed_div_pow2(whole, 20, 1));
    }
    format!("{} GB", to_fixed_div_pow2(whole, 30, 2))
}

/// `String(n).padStart(6)`.
fn num(n: f64) -> String {
    format!("{:>6}", num_to_string(n))
}

const MAX_LISTED_SESSIONS: usize = 8;

/// The session ledger, shown with its arithmetic.
pub fn format_ledger_section(ledger: &Json) -> Vec<String> {
    let g = |k: &str| ledger.get_f64(k).unwrap_or(0.0);
    let mut lines: Vec<String> = vec![
        String::new(),
        "SESSIONS".to_string(),
        format!("  Delivered   {}   reached every reachable destination", num(g("delivered"))),
    ];
    if g("uploading") > 0.0 {
        lines.push(format!("  Uploading   {}   bytes still going to a reachable store", num(g("uploading"))));
    }
    if g("live") > 0.0 {
        lines.push(format!("  Live        {}   actively working on this device (local)", num(g("live"))));
    }
    if g("waiting") - g("waitingUnprotected") > 0.0 {
        lines.push(format!("  Waiting     {}   an offline Fortress owes bytes (a complete copy is already safe)", num(g("waiting") - g("waitingUnprotected"))));
    }
    if g("waitingUnprotected") > 0.0 {
        lines.push(format!("  At risk     {}   only complete copy is on THIS DEVICE — Fortress offline", num(g("waitingUnprotected"))));
    }
    lines.push(format!("              {}", "─".repeat(6)));
    lines.push(format!("              {}", num(g("total"))));
    if g("incomplete") > 0.0 {
        let pad = " ".repeat(23);
        lines.push(format!("  Not on disk {}   removed locally before delivery could be confirmed.", num(g("incomplete"))));
        lines.push(format!("{}Grows over time — Claude Code prunes at 30 days. Not a", pad));
        lines.push(format!("{}fault and not counted; kept for diagnostics.", pad));
    }
    if let (Some(oldest), Some(newest)) = (ledger.get_f64("oldestMs"), ledger.get_f64("newestMs")) {
        let days = (((newest - oldest) / 86_400_000.0) + 0.5).floor().max(1.0);
        lines.push(format!("  Range       {} → {}  ({} days on disk)", iso_date(oldest), iso_date(newest), num_to_string(days)));
    }
    let sendable = g("delivered") + g("uploading") + g("waitingUnprotected");
    lines.push(format!(
        "  Sync {}% = {} delivered / {} sendable (live sessions, sessions already safe elsewhere, and sessions no longer on disk are excluded — nothing you can act on)",
        num_to_string(g("percent")),
        num_to_string(g("delivered")),
        num_to_string(sendable)
    ));
    let failing = ledger.get("failing").and_then(|f| f.as_arr()).cloned().unwrap_or_default();
    if !failing.is_empty() {
        lines.push(String::new());
        lines.push("FAILING DESTINATIONS — reachable, but rejecting writes".to_string());
        for f in &failing {
            let since = match f.get_f64("failingHours") {
                Some(h) => format!(" · for {}h", num_to_string(h)),
                None => String::new(),
            };
            lines.push(format!("  {}  —  {}{}", f.get_string("label").unwrap_or_default(), f.get_string("errorCode").unwrap_or_default(), since));
        }
        lines.push("  Every retry is being refused; this does not self-heal. Check the".to_string());
        lines.push(format!("  storage credentials/config on the server side, then: {} retry --all", crate::bin_name()));
    }
    let not_delivered = ledger.get("notDelivered").and_then(|f| f.as_arr()).cloned().unwrap_or_default();
    if !not_delivered.is_empty() {
        lines.push(String::new());
        lines.push("SESSIONS STILL OWING BYTES — what each one is waiting on".to_string());
        for d in not_delivered.iter().take(MAX_LISTED_SESSIONS) {
            lines.push(format!(
                "  {}:{}  {} owed · {}d old · {}",
                d.get_string("family").unwrap_or_default(),
                d.get_string("sessionId").unwrap_or_default(),
                fmt_bytes(d.get_f64("owedBytes").unwrap_or(0.0)),
                num_to_string(d.get_f64("ageDays").unwrap_or(0.0)),
                d.get_string("bucket").unwrap_or_default()
            ));
            let last = match d.get_string("lastUploadAt") {
                Some(s) => format!("last upload {}", s),
                None => "NEVER uploaded".to_string(),
            };
            let repo = match d.get("repoSlug") {
                Some(Json::Str(s)) => lossy(s),
                _ => "(none)".to_string(),
            };
            let attributed = match d.get("attributed") {
                Some(Json::Bool(true)) => "true".to_string(),
                Some(Json::Bool(false)) => "false".to_string(),
                _ => "unknown".to_string(),
            };
            lines.push(format!("      {} · repo {} · attributed {}", last, repo, attributed));
            let skip = d.get_string("skipReason");
            let failures = d.get_f64("consecutiveFailures").unwrap_or(0.0);
            let next = d.get_string("nextAttemptAt");
            if skip.is_some() || failures > 0.0 || next.is_some() {
                lines.push(format!(
                    "      held: {} · {} consecutive failures · next attempt {}",
                    skip.unwrap_or_else(|| "none".to_string()),
                    num_to_string(failures),
                    next.unwrap_or_else(|| "immediately".to_string())
                ));
            }
            for dest in d.get("destinations").and_then(|x| x.as_arr()).cloned().unwrap_or_default() {
                let owed = dest.get_f64("owed").unwrap_or(0.0);
                let label = dest.get_string("label").unwrap_or_default();
                let offset = dest.get_f64("offset").unwrap_or(0.0);
                if owed == 0.0 {
                    lines.push(format!("      {}: complete ({} B)", label, to_locale_string_int(offset)));
                    continue;
                }
                let note = match dest.get_string("state").as_deref() {
                    Some("unknown") => "  <-- NOT KNOWN to this device; nothing will ever send here",
                    Some("offline") => "  (offline)",
                    _ => "",
                };
                lines.push(format!("      {}: {} / {} B{}", label, to_locale_string_int(offset), to_locale_string_int(d.get_f64("sizeBytes").unwrap_or(0.0)), note));
            }
        }
        if not_delivered.len() > MAX_LISTED_SESSIONS {
            lines.push(format!("  …and {} more (see --json)", not_delivered.len() - MAX_LISTED_SESSIONS));
        }
        let unknown_owed = not_delivered.iter().any(|d| {
            d.get("destinations")
                .and_then(|x| x.as_arr())
                .map(|list| list.iter().any(|x| x.get_string("state").as_deref() == Some("unknown") && x.get_f64("owed").unwrap_or(0.0) > 0.0))
                .unwrap_or(false)
        });
        if unknown_owed {
            lines.push(String::new());
            lines.push("  A destination marked NOT KNOWN was advertised to this device once and".to_string());
            lines.push("  never registered. Its bytes can never be delivered and the session will".to_string());
            lines.push("  sit here forever. This is a client bug — please report it.".to_string());
        }
    }
    let lagging = ledger.get("lagging").and_then(|f| f.as_arr()).cloned().unwrap_or_default();
    if !lagging.is_empty() {
        lines.push(String::new());
        lines.push("OFFLINE DESTINATIONS".to_string());
        for d in &lagging {
            let seen = match d.get("lastSeenAt") {
                Some(v) if !v.is_null() => format!(" · last seen {}", lossy(&v.to_js_string())),
                _ => " · never seen".to_string(),
            };
            lines.push(format!(
                "  {}  —  {} waiting · {}{}",
                d.get_string("label").unwrap_or_default(),
                num_to_string(d.get_f64("sessions").unwrap_or(0.0)),
                format_outage(d.get_f64("offlineDays")),
                seen
            ));
        }
        lines.push("  Counts overlap where one session fans out to more than one Fortress.".to_string());
    }
    lines
}

fn format_session_list(sessions: &[Json]) -> String {
    let shown: Vec<String> = sessions.iter().take(MAX_LISTED_SESSIONS).map(|s| format!("{}:{}", s.get_string("family").unwrap_or_default(), s.get_string("sessionId").unwrap_or_default())).collect();
    let rest = sessions.len().saturating_sub(shown.len());
    let list = shown.join(", ");
    if rest > 0 {
        format!("{} …and {} more (see --json)", list, rest)
    } else {
        list
    }
}

fn plural(n: f64) -> &'static str {
    if n == 1.0 {
        ""
    } else {
        "s"
    }
}

/// `formatSyncDoctorText`.
pub fn format_sync_doctor_text(doc: &Json) -> String {
    let ledger = doc.get("ledger").cloned().unwrap_or_else(Json::obj);
    let mut lines: Vec<String> = vec!["HX sync — detailed".to_string()];
    lines.extend(format_ledger_section(&ledger).into_iter().skip(1));
    let roots = doc.get("roots").and_then(|r| r.as_arr()).cloned().unwrap_or_default();
    if !roots.is_empty() {
        let parts: Vec<String> = roots
            .iter()
            .map(|r| {
                let origin = r.get_string("origin").unwrap_or_default();
                format!(
                    "{}{}{}",
                    collapse_home(&r.get_string("configDir").unwrap_or_default()),
                    if origin == "default" { String::new() } else { format!(" [{}]", origin) },
                    if r.get("exists").and_then(|e| e.as_bool()).unwrap_or(false) { "" } else { " (missing)" }
                )
            })
            .collect();
        lines.push(format!("Watching: {}", parts.join(" · ")));
    }
    let blocked = doc.get_f64("blockedSessions").unwrap_or(0.0);
    if blocked == 0.0 {
        lines.push("Blocked: none".to_string());
    } else {
        lines.push(format!("Blocked: {} session{}", num_to_string(blocked), plural(blocked)));
        let blockers = doc.get("blockers").and_then(|b| b.as_arr()).cloned().unwrap_or_default();
        for (index, blocker) in blockers.iter().enumerate() {
            let d = blocker.get("destination").filter(|v| !v.is_null());
            let name = d
                .and_then(|x| x.get("orgName").filter(|v| !v.is_null()))
                .or_else(|| d.and_then(|x| x.get("orgSlug").filter(|v| !v.is_null())))
                .or_else(|| d.and_then(|x| x.get("vaultOrgId").filter(|v| !v.is_null())))
                .map(|v| lossy(&v.to_js_string()))
                .unwrap_or_else(|| "unknown store".to_string());
            lines.push(String::new());
            lines.push(format!("Destination {}: {}", index + 1, name));
            let project = d.and_then(|x| x.get("projectName").filter(|v| v.truthy())).or_else(|| d.and_then(|x| x.get("projectSlug").filter(|v| v.truthy())));
            if let Some(p) = project {
                lines.push(format!("  Project: {}", lossy(&p.to_js_string())));
            }
            if let Some(repo) = d.and_then(|x| x.get("repoSlug").filter(|v| v.truthy())) {
                lines.push(format!("  Repo: {}", lossy(&repo.to_js_string())));
            }
            lines.push(format!("  Reason: {}", blocker.get_string("reason").unwrap_or_default()));
            let remediation = blocker.get("remediation").cloned().unwrap_or_else(Json::obj);
            lines.push(format!("  Fix: {}", remediation.get_string("guidance").unwrap_or_default()));
            if let Some(seen) = d.and_then(|x| x.get("lastSeenAt").filter(|v| v.truthy())) {
                lines.push(format!("  Fortress last heartbeat: {}", lossy(&seen.to_js_string())));
            }
            if let Some(next) = blocker.get_string("nextRetryAt") {
                lines.push(format!("  Next automatic retry: {}", next));
            }
            lines.push(format!("  Sessions: {}", format_session_list(&blocker.get("sessions").and_then(|s| s.as_arr()).cloned().unwrap_or_default())));
            if let Some(u) = remediation.get_string("fortressSettingsUrl") {
                lines.push(format!("  Fortress settings: {}", u));
            }
            if let Some(u) = remediation.get_string("repositorySettingsUrl") {
                lines.push(format!("  Repository attachment: {}", u));
            }
        }
        lines.push(String::new());
        lines.push("After fixing the destination or repository attachment:".to_string());
        lines.push(format!("  {} retry --blocked", crate::bin_name()));
        lines.push(format!("  {} status", crate::bin_name()));
    }
    let excluded = doc.get("excluded").and_then(|e| e.as_arr()).cloned().unwrap_or_default();
    if !excluded.is_empty() {
        lines.push(String::new());
        lines.push(format!("EXCLUDED BY SETTINGS — {} session{} dropped before any upload is attempted", excluded.len(), if excluded.len() == 1 { "" } else { "s" }));
        for e in excluded.iter().take(MAX_LISTED_SESSIONS) {
            lines.push(format!("  {}:{}  {}", e.get_string("family").unwrap_or_default(), e.get_string("sessionId").unwrap_or_default(), e.get_string("reason").unwrap_or_default()));
        }
        if excluded.len() > MAX_LISTED_SESSIONS {
            lines.push(format!("  …and {} more (see --json)", excluded.len() - MAX_LISTED_SESSIONS));
        }
    }
    let undiscovered = doc.get("undiscovered").cloned().unwrap_or_else(Json::obj);
    let on_disk = undiscovered.get_f64("onDiskButUndiscovered").unwrap_or(0.0);
    if on_disk > 0.0 {
        lines.push(String::new());
        lines.push(format!("WARNING: {} tracked file(s) exist on disk but discovery did not return them.", num_to_string(on_disk)));
        lines.push("This should never happen — discovery is unwindowed here. Please report it.".to_string());
    }
    let child = doc.get("childLanes").cloned().unwrap_or_else(Json::obj);
    let tracked = child.get_f64("tracked").unwrap_or(0.0);
    if tracked > 0.0 {
        lines.push(String::new());
        let owing = child.get_f64("owing").unwrap_or(0.0);
        let tail = if owing > 0.0 {
            format!(" · {} still owing {}", num_to_string(owing), fmt_bytes(child.get_f64("owedBytes").unwrap_or(0.0)))
        } else {
            " · all delivered".to_string()
        };
        lines.push(format!(
            "Child agent lanes: {} tracked · {} on disk · {} pruned{}",
            num_to_string(tracked),
            num_to_string(child.get_f64("onDisk").unwrap_or(0.0)),
            num_to_string(child.get_f64("gone").unwrap_or(0.0)),
            tail
        ));
        if owing > 0.0 {
            lines.push("These upload on their own pass; a stall here is invisible in the session counts above.".to_string());
        }
    }
    let file_gone = undiscovered.get_f64("fileGone").unwrap_or(0.0);
    if file_gone > 0.0 {
        lines.push(String::new());
        lines.push(format!("Tracked but no longer on disk: {} file entr{} (normal — Claude Code prunes at 30 days).", num_to_string(file_gone), if file_gone == 1.0 { "y" } else { "ies" }));
    }
    let unwatched = doc.get_f64("unwatchedSessions").unwrap_or(0.0);
    if unwatched > 0.0 {
        lines.push(String::new());
        lines.push(format!("Unwatched: {} partially-synced session{} under locations no longer watched (removed data root)", num_to_string(unwatched), plural(unwatched)));
    }
    let waiting = ledger.get_f64("waiting").unwrap_or(0.0);
    let unprotected = ledger.get_f64("waitingUnprotected").unwrap_or(0.0);
    let safe_waiting = waiting - unprotected;
    if safe_waiting > 0.0 {
        lines.push(String::new());
        lines.push(format!(
            "Nothing is lost — {} waiting session{} already complete on a reachable store and still retrying.",
            num_to_string(safe_waiting),
            if safe_waiting == 1.0 { " is" } else { "s are" }
        ));
    }
    if unprotected > 0.0 {
        lines.push(String::new());
        lines.push(format!("AT RISK — {} session{} exist ONLY on this device: their Fortress is", num_to_string(unprotected), plural(unprotected)));
        lines.push("offline and there is no copy anywhere else. Claude Code deletes transcripts".to_string());
        lines.push("after 30 days; bring the Fortress online before then or they are gone.".to_string());
    }
    if doc.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
        lines.push("Result: healthy — 100% uploaded".to_string());
    }
    lines.join("\n")
}
