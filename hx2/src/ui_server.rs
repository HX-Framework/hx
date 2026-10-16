//! `hx ui` (cli.ts cmdUi and src/ui/server.ts): the local HX Client UI on
//! 127.0.0.1:8000 (then 8001–8020), the embedded React app as built, and its
//! JSON API. The responses are the TypeScript server's: the same routes,
//! statuses, bodies, CSP and cache headers, the session gate, the Host and
//! Origin checks, and the server-sent events.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::commands::{flag, has_flag};
use crate::json::{obj, Json};
use crate::logger::say;
use crate::ui_assets::{content_type_for, load_ui_assets, AssetMode, UiAssets};
use crate::ui_auth::{instance_identity, is_allowed_host, is_allowed_origin, probe_existing_instance, read_server_info, remove_server_info, write_server_info, ServerInfo, UiAuth, LAUNCH_TTL_MS};

const UI_DEFAULT_PORT: u16 = 8000;
const UI_PORT_SCAN_SPAN: u16 = 20;
const IDLE_TIMEOUT_SECS: u64 = 120;
const SSE_PING_MS: u64 = 15_000;
const CHANGE_NUDGE_MIN_MS: f64 = 1_500.0;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

// ── The event hub ───────────────────────────────────────────────────────────

/// Fan-out for server-sent events (update progress, state-changed nudges).
pub struct EventHub {
    subs: Mutex<Vec<Sender<String>>>,
}

impl EventHub {
    fn new() -> EventHub {
        EventHub { subs: Mutex::new(Vec::new()) }
    }

    fn subscribe(&self) -> Receiver<String> {
        let (tx, rx) = channel();
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).push(tx);
        rx
    }

    /// Send one event to every subscriber; a closed one is dropped.
    pub fn emit(&self, evt: &Json) {
        let text = evt.stringify();
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).retain(|tx| tx.send(text.clone()).is_ok());
    }
}

struct UiCtx {
    auth: UiAuth,
    assets: UiAssets,
    port: u16,
    events: Arc<EventHub>,
    update_running: Arc<AtomicBool>,
}

// ── HTTP ────────────────────────────────────────────────────────────────────

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// `url.searchParams.get(name)`.
    fn param(&self, name: &str) -> Option<String> {
        for pair in self.query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if form_decode(k) == name {
                return Some(form_decode(v));
            }
        }
        None
    }

    /// `await req.json()`.
    fn json(&self) -> Option<Json> {
        Json::parse(std::str::from_utf8(&self.body).ok()?).ok()
    }
}

/// application/x-www-form-urlencoded decoding: `+` is a space, `%XX` a byte.
fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() && hex_val(b.get(i + 1)).is_some() && hex_val(b.get(i + 2)).is_some() => {
                out.push(hex_val(b.get(i + 1)).unwrap() * 16 + hex_val(b.get(i + 2)).unwrap());
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(c: Option<&u8>) -> Option<u8> {
    match c? {
        c @ b'0'..=b'9' => Some(c - b'0'),
        c @ b'a'..=b'f' => Some(c - b'a' + 10),
        c @ b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `new URL(req.url).pathname`: dot segments removed, as the URL parser does.
fn normalize_pathname(raw: &str) -> String {
    let p = raw.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    let segs: Vec<&str> = p.split('/').collect();
    let last = segs.len().saturating_sub(1);
    let mut trailing = false;
    for (i, seg) in segs.iter().enumerate().skip(1) {
        let lower = seg.to_ascii_lowercase();
        if lower == "." || lower == "%2e" {
            trailing = i == last;
            continue;
        }
        if lower == ".." || lower == ".%2e" || lower == "%2e." || lower == "%2e%2e" {
            out.pop();
            trailing = i == last;
            continue;
        }
        trailing = false;
        out.push(seg);
    }
    let mut s = format!("/{}", out.join("/"));
    if trailing && !s.ends_with('/') {
        s.push('/');
    }
    s
}

enum Body {
    Bytes(Vec<u8>),
    None,
    Sse,
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Body,
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "",
    }
}

/// `cspFor`: exact hashes of index.html's inline scripts instead of 'unsafe-inline'.
fn csp_for(hashes: &[String]) -> String {
    let mut script_src = vec!["'self'".to_string()];
    script_src.extend(hashes.iter().cloned());
    format!(
        "default-src 'self'; script-src {}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        script_src.join(" ")
    )
}

/// `finish`: the security and cache headers every response carries.
fn finish(mut r: Resp, cache: &str, csp: &str) -> Resp {
    r.headers.push(("content-security-policy".to_string(), csp.to_string()));
    r.headers.push(("x-content-type-options".to_string(), "nosniff".to_string()));
    r.headers.push(("referrer-policy".to_string(), "no-referrer".to_string()));
    r.headers.push(("cache-control".to_string(), cache.to_string()));
    r
}

fn json_resp(body: &Json, status: u16) -> Resp {
    finish(Resp { status, headers: vec![("content-type".to_string(), "application/json".to_string())], body: Body::Bytes(body.stringify().into_bytes()) }, "no-store", &csp_for(&[]))
}

fn api_error(status: u16, error: &str) -> Resp {
    json_resp(&obj(vec![("error", Json::str(error))]), status)
}

fn internal_error() -> Resp {
    Resp { status: 500, headers: vec![("content-type".to_string(), "text/plain;charset=utf-8".to_string())], body: Body::Bytes(b"Internal Server Error".to_vec()) }
}

/// `Number(text)` for a query parameter (null reads as 0).
fn js_number(s: Option<&str>) -> f64 {
    let t = match s {
        Some(t) => t.trim(),
        None => return 0.0,
    };
    if t.is_empty() {
        return 0.0;
    }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).map(|v| v as f64).unwrap_or(f64::NAN);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `n || fallback` for a number.
fn or_default(n: f64, fallback: f64) -> f64 {
    if n == 0.0 || n.is_nan() {
        fallback
    } else {
        n
    }
}

fn handle(req: &Request, ctx: &UiCtx) -> Resp {
    if !is_allowed_host(req.header("host"), ctx.port) {
        return api_error(403, "forbidden host");
    }
    if req.method != "GET" && req.method != "HEAD" && !is_allowed_origin(req.header("origin"), ctx.port) {
        return api_error(403, "forbidden origin");
    }
    if req.path.starts_with("/api/") {
        return handle_api(req, ctx);
    }
    if req.method != "GET" && req.method != "HEAD" {
        return api_error(405, "method not allowed");
    }
    let asset_path = if req.path == "/" { "/index.html" } else { req.path.as_str() };
    let csp = csp_for(&ctx.assets.inline_script_hashes);
    let bytes = match ctx.assets.files.get(asset_path).and_then(|f| f.bytes()) {
        Some(b) => b,
        None => {
            return finish(Resp { status: 404, headers: vec![("content-type".to_string(), "text/plain;charset=utf-8".to_string())], body: Body::Bytes(b"Not found".to_vec()) }, "no-store", &csp);
        }
    };
    let cache = if asset_path == "/index.html" {
        "no-cache"
    } else if asset_path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    finish(Resp { status: 200, headers: vec![("content-type".to_string(), content_type_for(asset_path).to_string())], body: Body::Bytes(bytes) }, cache, &csp)
}

fn handle_api(req: &Request, ctx: &UiCtx) -> Resp {
    let path = req.path.as_str();
    if path == "/api/instance" {
        if req.method != "GET" && req.method != "HEAD" {
            return api_error(405, "method not allowed");
        }
        return json_resp(&instance_identity(), 200);
    }
    if path == "/api/auth" {
        if req.method != "POST" {
            return api_error(405, "method not allowed");
        }
        let body = match req.json() {
            Some(b) => b,
            None => return api_error(400, "invalid body"),
        };
        let token = match body.get("token") {
            Some(Json::Str(_)) => body.get_string("token").unwrap_or_default(),
            _ => return api_error(400, "invalid body"),
        };
        return match ctx.auth.exchange(&token) {
            Some(session) => json_resp(&obj(vec![("sessionToken", Json::str(&session))]), 200),
            None => api_error(401, "invalid token"),
        };
    }
    if path == "/api/instance/reissue" {
        if req.method != "POST" {
            return api_error(405, "method not allowed");
        }
        let body = match req.json() {
            Some(b) => b,
            None => return api_error(400, "invalid body"),
        };
        let (nonce, proof) = match (body.get("nonce"), body.get("proof")) {
            (Some(Json::Str(_)), Some(Json::Str(_))) => (body.get_string("nonce").unwrap_or_default(), body.get_string("proof").unwrap_or_default()),
            _ => return api_error(400, "invalid body"),
        };
        if !ctx.auth.verify_owner_proof(&nonce, &proof) {
            return api_error(401, "invalid proof");
        }
        return json_resp(&obj(vec![("launchToken", Json::str(&ctx.auth.mint_launch_token())), ("serverProof", Json::str(&ctx.auth.server_proof(&nonce)))]), 200);
    }
    if !ctx.auth.is_valid_session(req.header("x-hx-ui-token")) {
        return api_error(401, "unauthorized");
    }
    if path == "/api/ping" {
        return finish(Resp { status: 204, headers: Vec::new(), body: Body::None }, "no-store", &csp_for(&[]));
    }
    if req.method == "POST" {
        return match path {
            "/api/settings" => post_settings(req),
            "/api/daemon" => {
                let body = match req.json() {
                    Some(b) if !b.is_null() => b,
                    _ => return api_error(400, "invalid body"),
                };
                let action = body.get_string("action").unwrap_or_default();
                if !matches!(body.get("action"), Some(Json::Str(_))) || !matches!(action.as_str(), "start" | "stop" | "restart") {
                    return api_error(400, "invalid action");
                }
                match crate::maintenance::daemon_action(&action, crate::service::Consent::Denied) {
                    Ok(j) => json_resp(&j, 200),
                    Err(_) => internal_error(),
                }
            }
            "/api/retry-blocked" => {
                let cfg = match crate::config::read_config() {
                    Some(c) if c.access_token.is_some() => c,
                    _ => return json_resp(&obj(vec![("sessions", Json::num(0.0)), ("files", Json::num(0.0)), ("restarted", Json::Bool(false))]), 200),
                };
                match crate::maintenance::retry_blocked(cfg, crate::service::Consent::Denied, false, crate::logger::Logger::new(false, ""), crate::bin_name()) {
                    Ok(r) => json_resp(&r.to_json(), 200),
                    Err(_) => internal_error(),
                }
            }
            "/api/update" => {
                if start_update(ctx) {
                    json_resp(&obj(vec![("started", Json::Bool(true))]), 200)
                } else {
                    api_error(409, "update already running")
                }
            }
            "/api/disconnect" => match crate::connect::disconnect_device() {
                Ok(d) => json_resp(&obj(vec![("disconnected", Json::Bool(d))]), 200),
                Err(_) => internal_error(),
            },
            _ => api_error(404, "not found"),
        };
    }
    if req.method != "GET" {
        return api_error(405, "method not allowed");
    }
    if path == "/api/events" {
        return finish(
            Resp { status: 200, headers: vec![("content-type".to_string(), "text/event-stream".to_string()), ("connection".to_string(), "keep-alive".to_string())], body: Body::Sse },
            "no-store",
            &csp_for(&[]),
        );
    }
    match path {
        "/api/settings" => json_resp(&crate::ui_data::read_settings_json(), 200),
        "/api/update-check" => {
            let base = crate::config::read_config().map(|c| c.gateway_base_url).filter(|g| !g.is_empty());
            match base {
                None => json_resp(&obj(vec![("current", Json::str(crate::HX_VERSION)), ("latest", Json::Null), ("updateAvailable", Json::Bool(false))]), 200),
                Some(b) => match crate::update::check_for_update(&b) {
                    Ok(j) => json_resp(&j, 200),
                    Err(_) => internal_error(),
                },
            }
        }
        "/api/snapshot" => json_resp(&crate::ui_data::build_snapshot(), 200),
        "/api/sessions" => match req.param("folder").filter(|f| !f.is_empty()) {
            None => api_error(400, "missing folder"),
            Some(folder) => json_resp(&crate::ui_data::build_sessions(&folder), 200),
        },
        "/api/session-preview" => match req.param("path").filter(|p| !p.is_empty()) {
            None => api_error(400, "missing path"),
            Some(file) => {
                if crate::ui_data::is_discovered_path(&file) {
                    json_resp(&obj(vec![("lines", crate::ui_data::preview_session_file(&file))]), 200)
                } else {
                    api_error(404, "not found")
                }
            }
        },
        "/api/logs" => {
            let n = or_default(js_number(req.param("lines").as_deref()), 500.0).max(50.0).min(2000.0);
            json_resp(&obj(vec![("lines", crate::ui_data::tail_daemon_log(n))]), 200)
        }
        "/api/probe" => json_resp(&crate::ui_data::probe_json(), 200),
        "/api/whoami" => json_resp(&crate::ui_data::cached_whoami(), 200),
        "/api/activity" => {
            let hours = or_default(js_number(req.param("hours").as_deref()), 24.0);
            json_resp(&obj(vec![("entries", crate::ui_data::activity_since(hours))]), 200)
        }
        _ => api_error(404, "not found"),
    }
}

/// POST /api/settings: known keys only; dataDirs validated strictly.
fn post_settings(req: &Request) -> Resp {
    let patch = match req.json() {
        Some(p) => p,
        None => return api_error(400, "invalid body"),
    };
    let allowed = ["pause", "personalSync", "excludedFolders", "excludeRules", "dataDirs"];
    match &patch {
        Json::Obj(o) => {
            for (k, _) in o.iter() {
                if !allowed.contains(&k.as_str()) {
                    return api_error(400, &format!("unknown setting: {}", k));
                }
            }
        }
        // Object.keys of an array or a string lists its indices.
        Json::Arr(a) if !a.is_empty() => return api_error(400, "unknown setting: 0"),
        Json::Str(t) if !t.is_empty() => return api_error(400, "unknown setting: 0"),
        Json::Arr(_) => {}
        // `"dataDirs" in patch` throws on a primitive.
        _ => return internal_error(),
    }
    if patch.as_obj().map(|o| o.contains("dataDirs")).unwrap_or(false) {
        let mut err = crate::ui_data::data_dirs_patch_error(patch.get("dataDirs"));
        if err.is_none() {
            let current = crate::ui_data::read_settings_json();
            err = crate::ui_data::duplicate_root_error(patch.get("dataDirs").unwrap_or(&Json::Null), current.get("dataDirs"));
        }
        if let Some(e) = err {
            return api_error(400, &e);
        }
    }
    match crate::ui_data::write_settings_json(&patch) {
        Ok(next) => json_resp(&next, 200),
        Err(_) => internal_error(),
    }
}

/// Kick a background self-update; progress goes out on the event hub.
fn start_update(ctx: &UiCtx) -> bool {
    if ctx.update_running.swap(true, Ordering::SeqCst) {
        return false;
    }
    let base = crate::config::read_config().map(|c| c.gateway_base_url).filter(|g| !g.is_empty());
    let base = match base {
        Some(b) => b,
        None => {
            ctx.update_running.store(false, Ordering::SeqCst);
            ctx.events.emit(&obj(vec![("type", Json::str("update-error")), ("message", Json::str("not connected to a gateway"))]));
            return true;
        }
    };
    let events = ctx.events.clone();
    let running = ctx.update_running.clone();
    std::thread::spawn(move || {
        let mut on_progress = |ev: &crate::update::UpdateProgress| {
            let mut e = obj(vec![("type", Json::str("update-progress"))]);
            if let Json::Obj(o) = ev.to_json() {
                for (k, v) in o.iter() {
                    e.set(k, v.clone());
                }
            }
            events.emit(&e);
        };
        match crate::update::run_update(&base, &|m: &str| say(m), &mut on_progress) {
            Ok(r) => events.emit(&obj(vec![
                ("type", Json::str("update-done")),
                ("alreadyLatest", Json::Bool(r.already_latest)),
                ("version", Json::str(&r.remote_version.clone().unwrap_or(r.local_version.clone()))),
                ("daemonRestarted", Json::Bool(r.daemon_restarted)),
            ])),
            Err(m) => events.emit(&obj(vec![("type", Json::str("update-error")), ("message", Json::str(&m))])),
        }
        running.store(false, Ordering::SeqCst);
    });
    true
}

// ── Connections ─────────────────────────────────────────────────────────────

fn http_date() -> String {
    chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// Read one request; None when the peer closed or idled out.
fn read_request(reader: &mut BufReader<TcpStream>) -> Result<Option<(Request, bool)>, u16> {
    let mut head: Vec<u8> = Vec::new();
    loop {
        let mut line: Vec<u8> = Vec::new();
        let n = reader.read_until(b'\n', &mut line).map_err(|_| 0u16)?;
        if n == 0 {
            return if head.is_empty() { Ok(None) } else { Err(0) };
        }
        if head.is_empty() && (line == b"\r\n" || line == b"\n") {
            // Stray CRLF between requests.
            continue;
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEADER_BYTES {
            return Err(431);
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n").flat_map(|l| l.split('\n'));
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    if method.is_empty() || target.is_empty() {
        return Err(400);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    let get = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let mut keep = version != "HTTP/1.0";
    if let Some(c) = get("connection") {
        let c = c.to_lowercase();
        if c.contains("close") {
            keep = false;
        } else if c.contains("keep-alive") {
            keep = true;
        }
    }
    if get("expect").map(|e| e.eq_ignore_ascii_case("100-continue")).unwrap_or(false) {
        let _ = reader.get_mut().write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    let mut body: Vec<u8> = Vec::new();
    if get("transfer-encoding").map(|t| t.to_lowercase().contains("chunked")).unwrap_or(false) {
        loop {
            let mut size_line = String::new();
            if reader.read_line(&mut size_line).map_err(|_| 0u16)? == 0 {
                return Err(0);
            }
            let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("").trim(), 16).map_err(|_| 400u16)?;
            if size == 0 {
                // Trailers, up to the empty line.
                loop {
                    let mut t = String::new();
                    if reader.read_line(&mut t).map_err(|_| 0u16)? == 0 || t == "\r\n" || t == "\n" {
                        break;
                    }
                }
                break;
            }
            if body.len() + size > MAX_BODY_BYTES {
                return Err(413);
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk).map_err(|_| 0u16)?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf).map_err(|_| 0u16)?;
        }
    } else if let Some(len) = get("content-length").and_then(|l| l.parse::<usize>().ok()) {
        if len > MAX_BODY_BYTES {
            return Err(413);
        }
        body = vec![0u8; len];
        reader.read_exact(&mut body).map_err(|_| 0u16)?;
    }
    // Absolute-form targets carry the origin; the path starts after it.
    let path_and_query = match target.find("://") {
        Some(i) => match target[i + 3..].find('/') {
            Some(j) => target[i + 3 + j..].to_string(),
            None => "/".to_string(),
        },
        None => target.clone(),
    };
    let path_and_query = path_and_query.split('#').next().unwrap_or("").to_string();
    let (raw_path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (path_and_query.clone(), String::new()),
    };
    Ok(Some((Request { method, path: normalize_pathname(&raw_path), query, headers, body }, keep)))
}

fn write_head(stream: &mut TcpStream, status: u16, headers: &[(String, String)], extra: &[(&str, String)]) -> std::io::Result<()> {
    let mut s = format!("HTTP/1.1 {} {}\r\n", status, reason(status));
    for (k, v) in headers {
        s.push_str(&format!("{}: {}\r\n", k, v));
    }
    for (k, v) in extra {
        s.push_str(&format!("{}: {}\r\n", k, v));
    }
    s.push_str(&format!("date: {}\r\n\r\n", http_date()));
    stream.write_all(s.as_bytes())
}

/// Stream server-sent events: hello, every event of the hub, a ping every 15 s.
fn serve_sse(stream: &mut TcpStream, resp: &Resp, hub: &EventHub) {
    if write_head(stream, resp.status, &resp.headers, &[("transfer-encoding", "chunked".to_string())]).is_err() {
        return;
    }
    let send = |stream: &mut TcpStream, text: &str| -> bool {
        let chunk = format!("{:x}\r\n{}\r\n", text.len(), text);
        stream.write_all(chunk.as_bytes()).is_ok() && stream.flush().is_ok()
    };
    if !send(stream, &format!("data: {}\n\n", obj(vec![("type", Json::str("hello"))]).stringify())) {
        return;
    }
    let rx = hub.subscribe();
    loop {
        match rx.recv_timeout(Duration::from_millis(SSE_PING_MS)) {
            Ok(evt) => {
                if !send(stream, &format!("data: {}\n\n", evt)) {
                    return;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !send(stream, ": ping\n\n") {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

fn serve_connection(stream: TcpStream, ctx: Arc<UiCtx>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(IDLE_TIMEOUT_SECS)));
    let _ = stream.set_nodelay(true);
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    loop {
        let (req, keep) = match read_request(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => return,
            Err(0) => return,
            Err(code) => {
                let body = reason(code).as_bytes().to_vec();
                let _ = write_head(&mut writer, code, &[("content-type".to_string(), "text/plain;charset=utf-8".to_string())], &[("content-length", body.len().to_string()), ("connection", "close".to_string())]);
                let _ = writer.write_all(&body);
                return;
            }
        };
        let resp = handle(&req, &ctx);
        match &resp.body {
            Body::Sse => {
                serve_sse(&mut writer, &resp, &ctx.events);
                return;
            }
            Body::None => {
                if write_head(&mut writer, resp.status, &resp.headers, &[]).is_err() {
                    return;
                }
            }
            Body::Bytes(b) => {
                let ok = write_head(&mut writer, resp.status, &resp.headers, &[("content-length", b.len().to_string())]).is_ok() && (req.method == "HEAD" || writer.write_all(b).is_ok());
                if !ok {
                    return;
                }
            }
        }
        let _ = writer.flush();
        if !keep {
            return;
        }
    }
}

/// `tryServeUi`: bind; None when the port is taken; "::" falls back to 0.0.0.0.
fn try_serve_ui(port: u16, host: &str) -> Result<Option<TcpListener>, String> {
    match TcpListener::bind((host, port)) {
        Ok(l) => Ok(Some(l)),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Ok(None),
        Err(e) => {
            if host == "::" {
                return try_serve_ui(port, "0.0.0.0");
            }
            Err(format!("Failed to start server. Is port {} in use? ({})", port, e))
        }
    }
}

fn run_server(listener: TcpListener, ctx: Arc<UiCtx>) {
    std::thread::Builder::new()
        .name("hx-ui-accept".to_string())
        .spawn(move || {
            for conn in listener.incoming() {
                let stream = match conn {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let ctx = ctx.clone();
                let _ = std::thread::Builder::new().name("hx-ui-conn".to_string()).spawn(move || serve_connection(stream, ctx));
            }
        })
        .ok();
}

// ── Containers ──────────────────────────────────────────────────────────────

/// `isInsideContainer`: Linux only, from the Docker and Podman markers and PID 1's cgroup.
fn is_inside_container() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    if std::path::Path::new("/.dockerenv").exists() || std::path::Path::new("/run/.containerenv").exists() {
        return true;
    }
    let cgroup = match std::fs::read_to_string("/proc/1/cgroup") {
        Ok(c) => c.to_lowercase(),
        Err(_) => return false,
    };
    ["docker", "containerd", "kubepods", "libpod", "podman", "lxc"].iter().any(|w| {
        let mut rest = cgroup.as_str();
        while let Some(i) = rest.find(w) {
            let before = if i == 0 { None } else { rest[..i].chars().last() };
            let after = rest[i + w.len()..].chars().next();
            let word = |c: Option<char>| c.map(|c| c.is_ascii_alphanumeric() || c == '_').unwrap_or(false);
            if !word(before) && !word(after) {
                return true;
            }
            rest = &rest[i + w.len()..];
        }
        false
    })
}

fn container_access_note(port: u16, name: &str) -> Vec<String> {
    vec![
        "[hx]   ↑ running inside a container — open that link in your HOST machine's browser.".to_string(),
        format!("[hx]     if it doesn't load, this container isn't publishing port {}. Recreate it", port),
        format!("[hx]     with the port published, then run `{} ui` again:", name),
        format!("[hx]         docker run -p {}:{} …    (a running container can't have -p added)", port, port),
    ]
}

fn launch_link_note(name: &str) -> String {
    let h = LAUNCH_TTL_MS / 3_600_000.0;
    let ttl = if h >= 1.0 && h.fract() == 0.0 { format!("{}h", h as u64) } else { format!("{} min", crate::js::math_round(LAUNCH_TTL_MS / 60_000.0) as u64) };
    format!("[hx]   open this link within {} to sign in; once open, the tab stays signed in until you stop {} ui", ttl, name)
}

/// Nudge connected browsers when anything under ~/.let/hx changes, throttled
/// so the 1.5 s tick does not turn into a refetch storm.
fn watch_hx_dir(events: Arc<EventHub>) -> Option<notify::RecommendedWatcher> {
    use notify::{EventKind, RecursiveMode, Watcher};
    let last = Arc::new(Mutex::new(0.0f64));
    let pending = Arc::new(AtomicBool::new(false));
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let ev = match res {
            Ok(ev) => ev,
            Err(_) => return,
        };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        let now = crate::fsutil::now_ms();
        let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
        if now - *l >= CHANGE_NUDGE_MIN_MS {
            *l = now;
            events.emit(&obj(vec![("type", Json::str("changed"))]));
        } else if !pending.swap(true, Ordering::SeqCst) {
            let events = events.clone();
            let last = last.clone();
            let pending = pending.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(CHANGE_NUDGE_MIN_MS as u64));
                pending.store(false, Ordering::SeqCst);
                *last.lock().unwrap_or_else(|e| e.into_inner()) = crate::fsutil::now_ms();
                events.emit(&obj(vec![("type", Json::str("changed"))]));
            });
        }
    })
    .ok()?;
    watcher.watch(crate::home::hx_dir(), RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

/// `hx ui [--port <n>] [--no-open]`.
pub fn cmd_ui(name: &str, args: &[String]) -> Result<i32, String> {
    let mut requested: Option<u16> = None;
    if let Some(p) = flag(args, "port") {
        let n = js_number(Some(&p));
        if n.fract() != 0.0 || !(1.0..=65535.0).contains(&n) {
            say(&format!("invalid --port: {}", p));
            return Ok(64);
        }
        requested = Some(n as u16);
    }
    let assets = match load_ui_assets() {
        Some(a) => a,
        None => {
            say("The web UI isn't bundled in this build and ui/dist doesn't exist.");
            say("From a source checkout, build it once: bun run build:ui");
            return Ok(1);
        }
    };
    let strict = requested.is_some();
    let base_port = requested.unwrap_or(UI_DEFAULT_PORT);
    let in_container = is_inside_container();
    let bind_host = if in_container { "::" } else { "127.0.0.1" };
    let ui_host = if in_container { "127.0.0.1" } else { "localhost" };
    let no_open = has_flag(args, "no-open");

    let mut port = base_port;
    let mut listener = try_serve_ui(base_port, bind_host)?;
    if listener.is_none() && !strict {
        if let Some(existing) = read_server_info() {
            if let Some(url) = probe_existing_instance(&existing, ui_host) {
                say(&format!("[hx] HX Client UI already running at {}", url));
                say(&launch_link_note(name));
                if in_container {
                    for line in container_access_note(existing.port, name) {
                        say(&line);
                    }
                } else if !no_open {
                    crate::connect::open_browser(&url);
                }
                return Ok(0);
            }
            remove_server_info();
        }
        let mut p = base_port.saturating_add(1);
        while listener.is_none() && (p as u32) <= base_port as u32 + UI_PORT_SCAN_SPAN as u32 {
            listener = try_serve_ui(p, bind_host)?;
            if listener.is_some() {
                port = p;
            }
            if p == u16::MAX {
                break;
            }
            p += 1;
        }
        if listener.is_some() {
            say(&format!("[hx] port {} is in use by another app — serving on http://{}:{}", base_port, ui_host, port));
        }
    }
    let listener = match listener {
        Some(l) => l,
        None => {
            let range = if strict { format!("{}", base_port) } else { format!("{}-{}", base_port, base_port as u32 + UI_PORT_SCAN_SPAN as u32) };
            say(&format!("port {} is in use — stop the other process or pass --port <n> (try: lsof -i :{})", range, base_port));
            return Ok(1);
        }
    };
    let ctx = Arc::new(UiCtx { auth: UiAuth::new(), assets, port, events: Arc::new(EventHub::new()), update_running: Arc::new(AtomicBool::new(false)) });
    write_server_info(&ServerInfo { port, pid: std::process::id(), owner_key: ctx.auth.owner_key.clone() })?;
    let _watcher = watch_hx_dir(ctx.events.clone());
    let disk = ctx.assets.mode == AssetMode::Disk;
    let launch_url = format!("http://{}:{}/#k={}", ui_host, port, ctx.auth.mint_launch_token());
    run_server(listener, ctx.clone());
    say(&format!("[hx] HX Client UI → {}", launch_url));
    say(&launch_link_note(name));
    if disk {
        say("[hx] serving ui/dist from disk (source checkout)");
    }
    if in_container {
        for line in container_access_note(port, name) {
            say(&line);
        }
    }
    say("[hx] Ctrl+C to stop");
    if !in_container && !no_open {
        crate::connect::open_browser(&launch_url);
    }
    #[cfg(unix)]
    {
        let mut signals = signal_hook::iterator::Signals::new([signal_hook::consts::signal::SIGINT, signal_hook::consts::signal::SIGTERM]).map_err(|e| e.to_string())?;
        if signals.forever().next().is_some() {
            remove_server_info();
        }
    }
    // Windows: Bun's SIGINT is Ctrl+C in the console, and nothing delivers
    // SIGTERM there (crate::daemon does the same).
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        let stopped = std::sync::Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let _ = crate::platform::on_ctrl_c(Box::new(move || flag.store(true, Ordering::SeqCst)));
        while !stopped.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        remove_server_info();
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_decoding() {
        assert_eq!(form_decode("claude-cli%3A~%2Fscratch%2Fnotes"), "claude-cli:~/scratch/notes");
        assert_eq!(form_decode("a+b%zz"), "a b%zz");
    }

    #[test]
    fn numbers_like_javascript() {
        assert_eq!(js_number(Some("100")), 100.0);
        assert_eq!(js_number(None), 0.0);
        assert!(js_number(Some("abc")).is_nan());
        assert_eq!(js_number(Some("0x10")), 16.0);
        assert_eq!(or_default(js_number(Some("abc")), 24.0), 24.0);
    }

    #[test]
    fn pathname_dot_segments() {
        assert_eq!(normalize_pathname("/a/../b"), "/b");
        assert_eq!(normalize_pathname("/"), "/");
        assert_eq!(normalize_pathname("/api/x"), "/api/x");
    }
}
