//! The CLI commands beyond `watch` (src/cli.ts): status, the detailed
//! report, doctor, tick, backfill, reattribute and retry.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use chrono::Datelike;

use crate::config::{read_config, read_config_raw, read_local_config, write_config_json, HxConfig};
use crate::daemon_state::get_daemon_ops;
use crate::diagnostics::{build_sync_doctor_report, format_status_blocker, format_sync_doctor_text};
use crate::fsutil::now_ms;
use crate::js::{en_month_day, local_datetime, math_round, num_to_string, to_fixed, to_fixed_div_pow2, to_locale_string_en_us};
use crate::json::Json;
use crate::ledger::{format_outage, needs_attention, SyncLedger};
use crate::logger::{say, Logger};
use crate::net::Gateway;
use crate::pathnorm::collapse_home;
use crate::probe::{format_rate, probe_connection};
use crate::reattribute::run_reattribute_sweep;
use crate::report::compute_sync_report;
use crate::roots::{resolve_data_roots, DataRoot, ResolvedRoots};
use crate::settings::{is_paused, read_settings, HxSettings};
use crate::sidecars::backfill_artifacts;
use crate::state::Store;
use crate::watch::{tick_once, Ctx, TickResult, WatchOptions};

type Row = (String, String);

fn row(k: &str, v: String) -> Row {
    (k.to_string(), v)
}

pub fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| *a == format!("--{}", name))
}

pub fn flag(args: &[String], name: &str) -> Option<String> {
    let long = format!("--{}", name);
    if let Some(i) = args.iter().position(|a| *a == long) {
        if let Some(v) = args.get(i + 1) {
            if !v.is_empty() {
                return Some(v.clone());
            }
        }
    }
    let prefix = format!("--{}=", name);
    args.iter().find_map(|a| a.strip_prefix(&prefix).map(|v| v.to_string()))
}

/// `ensureConfig`: the main lane's connection, or exit 2 with the next step.
pub fn ensure_config(name: &str) -> HxConfig {
    match read_config() {
        Some(c) if c.access_token.is_some() => c,
        _ => {
            say(&format!("Not connected. Run `{} connect` first.", name));
            std::process::exit(2);
        }
    }
}

/// `ensureLocalConfig`: the `--local` tee's connection, or exit 2.
pub fn ensure_local_config(name: &str) -> HxConfig {
    match read_local_config() {
        Some(c) if c.access_token.is_some() => c,
        _ => {
            say(&format!("Local tee is not connected. Run `{} connect --local` first.", name));
            std::process::exit(2);
        }
    }
}

/// The gateway of a config as the CLI's one-off calls address it: a missing
/// token is sent as the text the template literal would have produced.
fn gateway_of(cfg: &HxConfig) -> Gateway {
    Gateway { base_url: cfg.gateway_base_url.clone(), token: cfg.access_token.clone().unwrap_or_else(|| "undefined".to_string()) }
}

fn new_ctx(cfg: HxConfig, name: &str, log: Logger) -> Ctx {
    let store = Store::load(cfg.scope);
    Ctx::new(cfg, store, log, name, Arc::new(AtomicU64::new(0)))
}

// ── hx status ───────────────────────────────────────────────────────────────

/// `resolveLoggedInEmail`: the cached email, else one /whoami round trip
/// whose answer is written back into config.json.
fn resolve_logged_in_email(cfg: &HxConfig, gw: &Gateway) -> Result<Option<String>, String> {
    if let Some(e) = &cfg.email {
        return Ok(Some(e.clone()));
    }
    let who = gw.whoami().map_err(|e| e.message())?;
    if !who.ok {
        return Ok(None);
    }
    let email = match who.email {
        Some(e) => e,
        None => return Ok(None),
    };
    let mut raw = read_config_raw().unwrap_or_else(Json::obj);
    raw.set("email", Json::str(&email));
    write_config_json(&raw)?;
    Ok(Some(email))
}

fn data_root_from_json(v: &Json) -> DataRoot {
    let origin: &'static str = match v.get_string("origin").as_deref() {
        Some("default") | None => "default",
        Some("settings") => "settings",
        Some("env") => "env",
        Some(other) => Box::leak(other.to_string().into_boxed_str()),
    };
    DataRoot { config_dir: v.get_string("configDir").unwrap_or_default(), origin, exists: v.get("exists").and_then(|e| e.as_bool()).unwrap_or(false) }
}

/// `effectiveRootsForCli`: the daemon's stamp when present, else this
/// process's own resolution.
fn effective_roots_for_cli(store: &Store, settings: &HxSettings) -> (ResolvedRoots, &'static str) {
    let stamp = store.read(|s| s.get("effectiveRoots").filter(|v| v.truthy()).cloned());
    if let Some(er) = stamp {
        let list = |key: &str| -> Vec<DataRoot> { er.get(key).and_then(|a| a.as_arr()).map(|a| a.iter().map(data_root_from_json).collect()).unwrap_or_default() };
        return (ResolvedRoots { claude: list("claude"), codex: list("codex") }, "daemon");
    }
    (resolve_data_roots(settings), "local")
}

fn format_roots_row(roots: &ResolvedRoots) -> String {
    roots
        .claude
        .iter()
        .chain(roots.codex.iter())
        .map(|r| format!("{}{}{}", collapse_home(&r.config_dir), if r.origin == "default" { String::new() } else { format!(" [{}]", r.origin) }, if r.exists { "" } else { " (missing)" }))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// `formatSize`.
fn format_size(bytes: f64) -> String {
    let gib = 1024f64 * 1024.0 * 1024.0;
    let mib = 1024f64 * 1024.0;
    let whole = bytes >= 0.0 && bytes.fract() == 0.0 && bytes < 1.8e19;
    if bytes >= gib {
        return format!("{} GB", if whole { to_fixed_div_pow2(bytes as u64, 30, 1) } else { to_fixed(bytes / gib, 1) });
    }
    if bytes >= mib {
        return format!("{} MB", if whole { to_fixed_div_pow2(bytes as u64, 20, 1) } else { to_fixed(bytes / mib, 1) });
    }
    if bytes >= 1024.0 {
        return format!("{} KB", num_to_string(math_round(bytes / 1024.0)));
    }
    format!("{} B", num_to_string(bytes))
}

/// `formatSessionRange`: "May 1 – Aug 1, 2026 · 92 days".
fn format_session_range(oldest_ms: Option<f64>, newest_ms: Option<f64>) -> Option<String> {
    let (oldest, newest) = (oldest_ms?, newest_ms?);
    let a = local_datetime(oldest)?;
    let b = local_datetime(newest)?;
    let fmt = |d: &chrono::DateTime<chrono::Local>, with_year: bool| en_month_day(d.year(), d.month(), d.day(), with_year);
    if a.date_naive() == b.date_naive() {
        return Some(fmt(&b, true));
    }
    let days = math_round((newest - oldest) / 86_400_000.0).max(1.0);
    Some(format!("{} – {} · {} days", fmt(&a, a.year() != b.year()), fmt(&b, true), num_to_string(days)))
}

fn sessions(n: u64) -> String {
    format!("{} session{}", n, if n == 1 { "" } else { "s" })
}

/// `syncVerdict`: the headline, naming the dominant reason it is not 100%.
fn sync_verdict(l: &SyncLedger) -> String {
    let pct = num_to_string(l.percent);
    if let Some(f) = l.failing.first() {
        return format!("{}% — uploads failing · {}", pct, f.error_code);
    }
    if l.uploading > 0 {
        return format!("{}% — catching up · {} left", pct, format_size(l.uploading_bytes));
    }
    if l.waiting_unprotected > 0 {
        return format!("{}% — {} only on this device, Fortress offline", pct, sessions(l.waiting_unprotected));
    }
    if l.waiting > 0 {
        return format!("{}% — everything that can be sent, is sent", pct);
    }
    format!("{}% — all sessions sent", pct)
}

fn format_lagging(l: &SyncLedger) -> String {
    if l.lagging.len() == 1 {
        let d = &l.lagging[0];
        return format!("{} · {} · retrying automatically", d.label, format_outage(d.offline_days));
    }
    format!("{} offline · retrying automatically", l.lagging.len())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn pad_end(s: &str, w: usize) -> String {
    let l = utf16_len(s);
    if l >= w {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(w - l))
    }
}

#[derive(Clone, Copy)]
struct TableWidths {
    label: usize,
    value: usize,
}

fn shared_table_widths(groups: &[&Vec<Row>]) -> TableWidths {
    let mut w = TableWidths { label: 0, value: 0 };
    for g in groups {
        for (k, v) in g.iter() {
            w.label = w.label.max(utf16_len(k));
            w.value = w.value.max(utf16_len(v));
        }
    }
    w
}

fn stdout_is_tty() -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(1) == 1 }
}

/// `/utf-?8/i.test(LC_ALL ?? LC_CTYPE ?? LANG ?? "")`: the first DEFINED variable decides.
fn locale_is_utf8() -> bool {
    let v = std::env::var("LC_ALL").ok().or_else(|| std::env::var("LC_CTYPE").ok()).or_else(|| std::env::var("LANG").ok()).unwrap_or_default().to_lowercase();
    v.contains("utf8") || v.contains("utf-8")
}

/// `printStatusTable`: aligned `Label: value` lines when piped, a dimmed
/// two-column box on a TTY.
fn print_status_table(rows: &[Row], min: Option<TableWidths>) {
    if rows.is_empty() {
        return;
    }
    let label_w = rows.iter().map(|(k, _)| utf16_len(k)).max().unwrap_or(0).max(min.map(|m| m.label).unwrap_or(0));
    if !stdout_is_tty() {
        for (k, v) in rows {
            say(&format!("{} {}", pad_end(&format!("{}:", k), label_w + 1), v));
        }
        return;
    }
    let value_w = rows.iter().map(|(_, v)| utf16_len(v)).max().unwrap_or(0).max(min.map(|m| m.value).unwrap_or(0));
    let utf8 = locale_is_utf8();
    let (tl, tr, bl, br, h, v, dn, up, lt, rt, x) = if utf8 { ("┌", "┐", "└", "┘", "─", "│", "┬", "┴", "├", "┤", "┼") } else { ("+", "+", "+", "+", "-", "|", "+", "+", "+", "+", "+") };
    let dim = "\x1b[2m";
    let rst = "\x1b[0m";
    let rule = |l: &str, mid: &str, r: &str| format!("{}{}{}{}{}{}{}", dim, l, h.repeat(label_w + 2), mid, h.repeat(value_w + 2), r, rst);
    let bar = format!("{}{}{}", dim, v, rst);
    say(&rule(tl, dn, tr));
    for (i, (k, val)) in rows.iter().enumerate() {
        if i > 0 {
            say(&rule(lt, x, rt));
        }
        say(&format!("{} {} {} {} {}", bar, pad_end(k, label_w), bar, pad_end(val, value_w), bar));
    }
    say(&rule(bl, up, br));
}

/// `hx status`: the health table; `--detailed` is `hx doctor sync`. Returns the exit code.
pub fn cmd_status(name: &str, args: &[String]) -> Result<i32, String> {
    if has_flag(args, "detailed") {
        return cmd_sync_detail(name, has_flag(args, "json"));
    }
    let cfg = match read_config() {
        Some(c) => c,
        None => {
            say(&format!("Connection: down — not connected (run `{} connect`)", name));
            return Ok(0);
        }
    };
    let gw = gateway_of(&cfg);
    let mut rows: Vec<Row> = Vec::new();
    if let Some(email) = resolve_logged_in_email(&cfg, &gw)? {
        rows.push(row("Logged in as", email));
    }
    rows.push(row("Gateway", cfg.gateway_base_url.clone()));
    if let Some(local) = read_local_config() {
        if local.access_token.is_some() {
            rows.push(row("Local tee", local.gateway_base_url.clone()));
        }
    }
    let ops = get_daemon_ops();
    let daemon_state = if ops.manager_name != "none" { Some(ops.state()) } else { None };
    if let Some(ds) = &daemon_state {
        let value = match ds.pid {
            Some(pid) if pid != 0 => format!("running ({}, pid {})", ops.manager_name, pid),
            _ => {
                if ds.loaded {
                    format!("loaded, not running ({})", ops.manager_name)
                } else {
                    format!("stopped — run `{} start` to resume", name)
                }
            }
        };
        rows.push(row("Daemon", value));
    }
    let settings = read_settings();
    if is_paused(&settings, now_ms()) {
        let until = settings.pause.and_then(|p| p).filter(|ms| *ms != 0.0);
        rows.push(row(
            "Paused",
            match until {
                Some(ms) => format!("yes — resumes {}", to_locale_string_en_us(ms)),
                None => "yes — until resumed".to_string(),
            },
        ));
    }
    let store = Store::load("main");
    let (watch_roots, roots_from) = effective_roots_for_cli(&store, &settings);
    let daemon_down = ops.manager_name != "none" && !daemon_state.as_ref().map(|d| d.pid.map(|p| p != 0).unwrap_or(false)).unwrap_or(false);
    rows.push(row("Watching", format!("{}{}", format_roots_row(&watch_roots), if roots_from == "daemon" && daemon_down { " (last known — daemon stopped)" } else { "" })));

    let report = compute_sync_report(&store, Some(&watch_roots)).ok();
    let probe = probe_connection(&cfg);
    let archive = if probe.up { gw.fetch_device_inventory() } else { None };
    if !probe.up {
        rows.push(row("Connection", format!("down — {}", probe.reason.clone().unwrap_or_default())));
        if let Some(r) = &report {
            if !r.skipped.is_empty() {
                rows.push(row("Blocked", format_status_blocker(&r.skipped, now_ms())));
                rows.push(row("Details", format!("{} doctor sync", name)));
            }
        }
        print_status_table(&rows, None);
        return Ok(0);
    }
    rows.push(row("Connection", format!("up — {} ({} ms, {})", probe.quality, num_to_string(probe.latency_ms), format_rate(probe.bytes_per_sec))));
    if let Some(r) = &report {
        if !r.skipped.is_empty() {
            rows.push(row("Blocked", format_status_blocker(&r.skipped, now_ms())));
            rows.push(row("  Details", format!("{} status --detailed", name)));
        }
    }
    let ledger = report.as_ref().map(|r| &r.ledger);
    if let Some(l) = ledger {
        if l.total > 0 {
            rows.push(row("Sessions", format!("{} on disk · {}", l.total, format_size(l.total_bytes))));
            if let Some(a) = &archive {
                rows.push(row(" ", format!("{} in cloud · {}", num_to_string(a.sessions), format_size(a.bytes))));
            }
            if let Some(range) = format_session_range(l.oldest_ms, l.newest_ms) {
                rows.push(row("Session range", range));
            }
            rows.push(row("Sync", sync_verdict(l)));
            rows.push(row("  Delivered", format!("{} · {}", sessions(l.delivered), format_size(l.delivered_bytes))));
            if l.uploading > 0 {
                rows.push(row("  Uploading", format!("{} · {} left", sessions(l.uploading), format_size(l.uploading_bytes))));
            }
            if l.live > 0 {
                rows.push(row("  Live", format!("{} {} actively working on this device", sessions(l.live), if l.live == 1 { "is" } else { "are" })));
            }
        }
    }
    if let Some(r) = &report {
        if r.unwatched > 0 {
            rows.push(row("Unwatched", format!("{} partially-synced session{} under locations no longer watched", r.unwatched, if r.unwatched == 1 { "" } else { "s" })));
        }
    }
    let mut fail_rows: Vec<Row> = Vec::new();
    if let Some(l) = ledger {
        if !l.failing.is_empty() {
            for f in l.failing.iter().take(3) {
                let since = match f.failing_hours {
                    None => String::new(),
                    Some(h) if h < 1.0 => " · started under an hour ago".to_string(),
                    Some(h) => format!(" · for {}h", num_to_string(h)),
                };
                let label = if fail_rows.is_empty() { "Failing" } else { " " };
                fail_rows.push(row(label, format!("{} · {}{}", f.label, f.error_code, since)));
            }
            fail_rows.push(row("  What now", "uploads are being rejected — check server credentials/config".to_string()));
        }
    }
    let loss_rows: Vec<Row> = Vec::new();
    let mut wait_rows: Vec<Row> = Vec::new();
    if let Some(l) = ledger {
        if l.waiting_unprotected > 0 {
            wait_rows.push(row("At risk", format!("{} · only copy is on this device — Fortress offline", sessions(l.waiting_unprotected))));
            wait_rows.push(row("  Act", "bring the Fortress online; Claude Code deletes local copies at 30 days".to_string()));
        }
        if l.waiting > l.waiting_unprotected {
            wait_rows.push(row("Waiting", format!("{} · nothing lost, already complete elsewhere", sessions(l.waiting - l.waiting_unprotected))));
            wait_rows.push(row("  Fortresses", format_lagging(l)));
            let attention = needs_attention(l);
            if !attention.is_empty() {
                wait_rows.push(row("  Needs you", attention.iter().map(|d| format!("{} offline {}d", d.label, num_to_string(d.offline_days.unwrap_or(0.0)))).collect::<Vec<_>>().join(" · ")));
            }
            wait_rows.push(row("Details", format!("{} status --detailed", name)));
        }
    }
    let widths = shared_table_widths(&[&rows, &fail_rows, &loss_rows, &wait_rows]);
    print_status_table(&rows, Some(widths));
    for b in [&fail_rows, &loss_rows, &wait_rows] {
        if b.is_empty() {
            continue;
        }
        say("");
        print_status_table(b, Some(widths));
    }
    Ok(0)
}

/// `cmdSyncDetail`: the full ledger + remediation (`hx status --detailed`, `hx doctor sync`).
pub fn cmd_sync_detail(name: &str, json: bool) -> Result<i32, String> {
    let cfg = ensure_config(name);
    let settings = read_settings();
    let store = Store::load("main");
    let (roots, _) = effective_roots_for_cli(&store, &settings);
    let report = compute_sync_report(&store, Some(&roots))?;
    let doctor = build_sync_doctor_report(&report, &cfg.gateway_base_url, now_ms(), Some(&roots));
    if json {
        say(&doctor.json.stringify_pretty());
    } else {
        say(&format_sync_doctor_text(&doctor.json));
    }
    Ok(if doctor.ok { 0 } else { 1 })
}

/// `hx doctor sync [--json]`.
pub fn cmd_doctor(name: &str, args: &[String]) -> Result<i32, String> {
    if args.get(2).map(|s| s.as_str()) != Some("sync") {
        say(&format!("usage: {} doctor sync [--json]   (same as `{} status --detailed`)", name, name));
        return Ok(64);
    }
    cmd_sync_detail(name, has_flag(args, "json"))
}

fn run_tick(cfg: HxConfig, only: Option<String>, log: Logger, name: &str) -> Result<TickResult, String> {
    let ctx = new_ctx(cfg, name, log);
    let opts = WatchOptions { only, one_shot: true, chunk_limit_bytes: None, chunk_growth: false };
    let r = tick_once(&ctx, &opts, &|_| {});
    ctx.store.drain();
    r
}

/// `hx tick [--only <path>] [--local]`: one upload pass and exit.
pub fn cmd_tick(name: &str, args: &[String]) -> Result<(), String> {
    let cfg = ensure_config(name);
    let local = if has_flag(args, "local") { Some(ensure_local_config(name)) } else { None };
    let only = flag(args, "only");
    {
        let ops = get_daemon_ops();
        let running = ops.manager_name != "none" && ops.state().pid.map(|p| p != 0).unwrap_or(false);
        if running {
            say(&format!(
                "[hx] warning: the background service is running — a one-shot tick shares its upload state and can fight its elections. Prefer letting the service sync, or `{} stop` first.",
                name
            ));
        }
    }
    let r = run_tick(cfg, only.clone(), Logger::new(false, ""), name)?;
    say(&format!("done. uploaded={} failed={}", r.uploaded, r.failed));
    if let Some(lc) = local {
        let lr = run_tick(lc, only, Logger::new(false, "[local] "), name)?;
        say(&format!("[local] done. uploaded={} failed={}", lr.uploaded, lr.failed));
    }
    Ok(())
}

/// `hx backfill`: tasks + plans for sessions already on disk.
pub fn cmd_backfill(name: &str) {
    let cfg = ensure_config(name);
    say("[hx] backfilling tasks + plans for sessions already on disk…");
    let ctx = new_ctx(cfg, name, Logger::new(false, ""));
    let (tasks, plans, failed) = backfill_artifacts(&ctx);
    ctx.store.drain();
    say(&format!("done. tasks={} plans={} failed={}", tasks, plans, failed));
}

/// `hx reattribute [--force]`.
pub fn cmd_reattribute(name: &str, force: bool) -> Result<(), String> {
    let cfg = ensure_config(name);
    let st = get_daemon_ops().state();
    if st.pid.is_some() {
        say("[hx] the daemon is running — it sweeps attribution on every start.");
        say(&format!("     run `{} restart` to sweep now (or `{} stop` first to sweep from this terminal).", name, name));
        return Ok(());
    }
    let ctx = new_ctx(cfg, name, Logger::new(false, ""));
    let r = run_reattribute_sweep(&ctx.cfg, &ctx.store, &ctx.gw, &|m: &str| say(m), force).map_err(|e| e.message());
    ctx.store.drain();
    let r = r?;
    say(&format!("done. reported={} attributed={} unresolved={} current={}", r.sent, r.attributed, r.unresolved, r.skipped));
    Ok(())
}

/// `hx retry --blocked | --all`. Returns the exit code.
pub fn cmd_retry(name: &str, args: &[String]) -> Result<i32, String> {
    let all = has_flag(args, "all");
    if !all && !has_flag(args, "blocked") {
        say(&format!("usage: {} retry --blocked | --all", name));
        say("  --blocked  release sessions held by an offline Fortress");
        say("  --all      also clear every retry backoff (after a fixed incident)");
        return Ok(64);
    }
    let cfg = ensure_config(name);
    let settings = read_settings();
    let store = Store::load("main");
    let (roots, _) = effective_roots_for_cli(&store, &settings);
    let report = compute_sync_report(&store, Some(&roots))?;
    if !all && report.skipped.is_empty() {
        say(&format!("No blocked sessions to retry. (`{} retry --all` clears every backoff.)", name));
        return Ok(0);
    }
    let ops = get_daemon_ops();
    let before = ops.state();
    if before.loaded {
        // Stopping and restarting the background service is the service
        // card's work (M5); until then a loaded service keeps its state file.
        say(&format!("[hx] the background service is loaded ({}); `{} retry` cannot stop and restart it in this build. Run `{} stop` first.", ops.manager_name, name, name));
        return Ok(64);
    }
    drop(store);
    let fresh = Store::load("main");
    let (_files, sessions) = if all { fresh.clear_all_failures()? } else { fresh.clear_blocked_failures()? };
    let ctx = Ctx::new(cfg, fresh, Logger::new(false, ""), name, Arc::new(AtomicU64::new(0)));
    let pass = tick_once(&ctx, &WatchOptions { only: None, one_shot: true, chunk_limit_bytes: None, chunk_growth: false }, &|_| {});
    ctx.store.drain();
    let pass = pass?;
    let what = if all { "backed-off" } else { "blocked" };
    say(&format!("Released {} {} session{}; ran one retry pass now.", sessions, what, if sessions == 1 { "" } else { "s" }));
    say(&format!("Retry pass complete. uploaded={} failed={}", pass.uploaded, pass.failed));
    say(&format!("Check the result with `{} status`.", name));
    Ok(0)
}
