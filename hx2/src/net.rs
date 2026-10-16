//! The gateway calls of the hot path (src/uploader.ts) over an HTTP/1.1
//! client that sends exactly the request Bun's fetch sends.
//!
//! The TypeScript client sets no User-Agent, so every gateway call carries
//! Bun's defaults: `accept: */*`, `accept-encoding: gzip, deflate, br, zstd`,
//! `connection: keep-alive`, `user-agent: Bun/1.3.14`, plus `content-type`
//! and `content-length` when there is a body. hx2 sends the same headers with
//! one difference the program decided on 10-16: it names itself,
//! `user-agent: hx2/<version>`, so the hx and hx2 fleets can be told apart
//! before hx is retired. The differential harness compares every other
//! header (all but `host`) and checks that hx2 sends exactly that one. The
//! client here speaks plain HTTP to loopback hosts, the one transport the
//! TypeScript client allows without TLS; HTTPS to the hosted gateway is the
//! next card's work (the TLS stack is not part of the hot-path spike).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::js::{js, lossy, slice};
use crate::json::{drop_nulls, obj, Json};

/// hx2 names itself to let.ai (the program doc, rule 4, decided 10-16): the
/// one header that differs from the TypeScript client's `Bun/<version>`.
pub const USER_AGENT: &str = concat!("hx2/", env!("CARGO_PKG_VERSION"));

pub const GATEWAY_TIMEOUT_MS: u64 = 60_000;
pub const GATEWAY_BATCH_TIMEOUT_MS: u64 = 120_000;

/// Deadline for a chunk PUT: a 60 s floor plus one second per 64 KiB.
pub fn chunk_put_timeout_ms(bytes: usize) -> u64 {
    GATEWAY_TIMEOUT_MS + ((bytes + 65_535) / 65_536) as u64 * 1000
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct BlockerDestination {
    pub vault_org_id: String,
    pub reason: String,
    pub org_name: Option<String>,
    pub org_slug: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub repo_slug: Option<String>,
    pub last_seen_at: Option<String>,
}

impl BlockerDestination {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("vaultOrgId", Json::str(&self.vault_org_id)),
            ("reason", Json::str(&self.reason)),
            ("orgName", Json::opt_str(self.org_name.as_deref())),
            ("orgSlug", Json::opt_str(self.org_slug.as_deref())),
            ("projectId", Json::opt_str(self.project_id.as_deref())),
            ("projectName", Json::opt_str(self.project_name.as_deref())),
            ("projectSlug", Json::opt_str(self.project_slug.as_deref())),
            ("repoSlug", Json::opt_str(self.repo_slug.as_deref())),
            ("lastSeenAt", Json::opt_str(self.last_seen_at.as_deref())),
        ])
    }
}

#[derive(Clone, Debug)]
pub struct Blocker {
    /// vault_offline | vault_home_unreachable
    pub reason: String,
    pub destinations: Vec<BlockerDestination>,
}

#[derive(Clone, Debug)]
pub struct HxHttpError {
    pub status: u16,
    pub message: String,
    pub blocker: Option<Blocker>,
}

impl HxHttpError {
    pub fn new(status: u16, message: String, blocker: Option<Blocker>) -> HxHttpError {
        HxHttpError { status, message, blocker }
    }

    /// 429 + 5xx: the gateway or storage cannot accept uploads right now.
    pub fn server_unavailable(&self) -> bool {
        self.status == 429 || self.status >= 500
    }

    /// The per-session hold a 503 names, if any.
    pub fn vault_block_reason(&self) -> Option<&'static str> {
        if self.status != 503 {
            return None;
        }
        if let Some(b) = &self.blocker {
            if b.reason == "vault_offline" {
                return Some("vault_offline");
            }
            if b.reason == "vault_home_unreachable" {
                return Some("vault_home_unreachable");
            }
        }
        if self.message.contains("\"error\":\"vault_home_unreachable\"") {
            return Some("vault_home_unreachable");
        }
        if self.message.contains("vault_offline") {
            return Some("vault_offline");
        }
        None
    }

    pub fn vault_offline(&self) -> bool {
        self.vault_block_reason().is_some()
    }

    /// 410 session_deleted: the session was permanently deleted server-side.
    pub fn session_deleted(&self) -> bool {
        self.status == 410 && self.message.contains("session_deleted")
    }
}

/// What a gateway call can fail with: an HTTP status, or a transport failure
/// whose message is the one the TypeScript runtime would have printed.
#[derive(Clone, Debug)]
pub enum NetError {
    Http(HxHttpError),
    /// A call that exceeded its deadline (net.ts FetchTimeoutError, named
    /// "TimeoutError" so logs and classifiers can tell it from a peer error).
    Timeout(String),
    Other(String),
}

impl NetError {
    pub fn message(&self) -> String {
        match self {
            NetError::Http(e) => e.message.clone(),
            NetError::Timeout(m) => m.clone(),
            NetError::Other(m) => m.clone(),
        }
    }

    pub fn http(&self) -> Option<&HxHttpError> {
        match self {
            NetError::Http(e) => Some(e),
            _ => None,
        }
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, NetError::Timeout(_))
    }
}

/// Bun's message for a refused connection, logged verbatim by the daemon.
pub const UNABLE_TO_CONNECT: &str = "Unable to connect. Is the computer able to access the url?";
/// Bun's message for a connection that dropped mid-request.
const CONNECTION_CLOSED: &str =
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

// ── Transport ───────────────────────────────────────────────────────────────

struct Url {
    scheme: String,
    host: String,
    port: u16,
    /// Path plus query, as sent on the request line.
    target: String,
}

fn parse_url(url: &str) -> Option<Url> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let authority = authority.split('@').last().unwrap_or(authority);
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = &authority[1..end];
        let port = authority[end + 1..].strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()),
            None => (authority.to_string(), None),
        }
    };
    let default_port = if scheme.eq_ignore_ascii_case("https") { 443 } else { 80 };
    Some(Url { scheme: scheme.to_lowercase(), host, port: port.unwrap_or(default_port), target: path.to_string() })
}

fn is_loopback_host(h: &str) -> bool {
    let h = h.to_lowercase();
    if h == "localhost" || h == "::1" || h == "[::1]" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn is_secure_fetch_url(url: &str) -> bool {
    match parse_url(url) {
        Some(u) => u.scheme == "https" || (u.scheme == "http" && is_loopback_host(&u.host)),
        None => false,
    }
}

/// `assertSecureFetchUrl`: the error text of the TypeScript client.
pub fn assert_secure_fetch_url(url: &str, label: &str) -> Result<(), NetError> {
    if is_secure_fetch_url(url) {
        return Ok(());
    }
    let where_ = match parse_url(url) {
        Some(u) => {
            let default_port = if u.scheme == "https" { 443 } else { 80 };
            let host = if u.port == default_port { u.host.clone() } else { format!("{}:{}", u.host, u.port) };
            format!("{}://{}", u.scheme, host)
        }
        None => "<unparseable url>".to_string(),
    };
    Err(NetError::Other(format!(
        "{}: refusing to fetch over an insecure transport ({}); gateway URLs must be https (http allowed only for localhost).",
        label, where_
    )))
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Idle keep-alive connections by host:port — what Bun's fetch keeps between
/// requests, so a pass over thousands of sessions reuses a handful of
/// connections instead of opening four per session. (A fresh connection per
/// request exhausted macOS's 16k ephemeral ports after about 4,000 sessions
/// of the 10,000-session scenario; the port range and TIME_WAIT are not the
/// servers' business, the connection count is Bun's behavior.)
fn idle_pool() -> &'static Mutex<HashMap<String, Vec<TcpStream>>> {
    static POOL: OnceLock<Mutex<HashMap<String, Vec<TcpStream>>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Idle connections kept per host beyond which a returned one is closed.
const IDLE_PER_HOST: usize = 16;

fn take_idle(key: &str) -> Option<TcpStream> {
    let mut p = idle_pool().lock().unwrap_or_else(|e| e.into_inner());
    p.get_mut(key).and_then(|v| v.pop())
}

fn put_idle(key: &str, s: TcpStream) {
    let mut p = idle_pool().lock().unwrap_or_else(|e| e.into_inner());
    let v = p.entry(key.to_string()).or_default();
    if v.len() < IDLE_PER_HOST {
        v.push(s);
    }
}

/// One HTTP/1.1 request under a deadline, on a kept-alive connection when
/// the pool has one for the host, else on a fresh one. A pooled connection
/// the peer closed while it sat idle fails before any response byte
/// arrives; the request is then sent once more on a fresh connection.
pub fn request(
    label: &str,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<Response, NetError> {
    let u = parse_url(url).ok_or_else(|| NetError::Other(format!("{}: invalid url", label)))?;
    if u.scheme != "http" {
        return Err(NetError::Other(format!("{}: {} is not supported by this build yet (plain http to loopback only)", label, u.scheme)));
    }
    let deadline = Duration::from_millis(timeout_ms);
    let timed_out = || NetError::Timeout(format!("{} timed out after {}s", label, crate::js::math_round(timeout_ms as f64 / 1000.0) as i64));
    let io_err = |e: std::io::Error| -> NetError {
        match e.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => timed_out(),
            std::io::ErrorKind::ConnectionRefused => NetError::Other(UNABLE_TO_CONNECT.to_string()),
            _ => NetError::Other(CONNECTION_CLOSED.to_string()),
        }
    };
    let connect = || -> Result<TcpStream, NetError> {
        let addrs = (u.host.as_str(), u.port).to_socket_addrs().map_err(|_| NetError::Other(UNABLE_TO_CONNECT.to_string()))?;
        let mut last_err: Option<std::io::Error> = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, deadline) {
                Ok(s) => return Ok(s),
                Err(e) => last_err = Some(e),
            }
        }
        Err(match last_err {
            Some(e) if e.kind() == std::io::ErrorKind::TimedOut => timed_out(),
            _ => NetError::Other(UNABLE_TO_CONNECT.to_string()),
        })
    };

    let host_header = if u.port == 80 { u.host.clone() } else { format!("{}:{}", u.host, u.port) };
    let key = format!("{}:{}", u.host, u.port);
    let mut head = String::new();
    head.push_str(&format!("{} {} HTTP/1.1\r\n", method, u.target));
    head.push_str(&format!("host: {}\r\n", host_header));
    head.push_str("connection: keep-alive\r\n");
    head.push_str(&format!("user-agent: {}\r\n", USER_AGENT));
    head.push_str("accept: */*\r\n");
    head.push_str("accept-encoding: gzip, deflate, br, zstd\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{}: {}\r\n", k, v));
    }
    if let Some(b) = body {
        head.push_str(&format!("content-length: {}\r\n", b.len()));
    }
    head.push_str("\r\n");

    // The exchange on one connection: the request, then the whole response.
    // Ok((response, keep)): keep says the connection may serve another
    // request. Err((error, started)): started says response bytes had
    // arrived, so the peer may have acted on the request.
    let exchange = |stream: &mut TcpStream| -> Result<(Response, bool), (NetError, bool)> {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(deadline));
        let _ = stream.set_write_timeout(Some(deadline));
        stream.write_all(head.as_bytes()).map_err(|e| (io_err(e), false))?;
        if let Some(b) = body {
            stream.write_all(b).map_err(|e| (io_err(e), false))?;
        }
        stream.flush().map_err(|e| (io_err(e), false))?;

        // Headers, then the body by content-length or chunked transfer
        // coding, else until the peer closes (which ends the connection).
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut tmp = [0u8; 16384];
        let header_end;
        loop {
            if let Some(i) = find_header_end(&buf) {
                header_end = i;
                break;
            }
            let n = stream.read(&mut tmp).map_err(|e| (io_err(e), !buf.is_empty()))?;
            if n == 0 {
                return Err((NetError::Other(CONNECTION_CLOSED.to_string()), !buf.is_empty()));
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let head_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let mut lines = head_text.split("\r\n");
        let status_line = lines.next().unwrap_or("");
        let status: u16 = status_line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut keep = !status_line.starts_with("HTTP/1.0");
        let mut content_length: Option<usize> = None;
        let mut chunked = false;
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                let k = k.trim().to_lowercase();
                let v = v.trim();
                if k == "content-length" {
                    content_length = v.parse().ok();
                } else if k == "transfer-encoding" && v.to_lowercase().contains("chunked") {
                    chunked = true;
                } else if k == "connection" {
                    let v = v.to_lowercase();
                    if v.contains("close") {
                        keep = false;
                    } else if v.contains("keep-alive") {
                        keep = true;
                    }
                }
            }
        }
        let mut rest: Vec<u8> = buf[header_end + 4..].to_vec();
        let body_bytes: Vec<u8> = if method == "HEAD" || status == 204 || status == 304 {
            Vec::new()
        } else if chunked {
            loop {
                if let Some(decoded) = decode_chunked(&rest) {
                    break decoded;
                }
                let n = stream.read(&mut tmp).map_err(|e| (io_err(e), true))?;
                if n == 0 {
                    return Err((NetError::Other(CONNECTION_CLOSED.to_string()), true));
                }
                rest.extend_from_slice(&tmp[..n]);
            }
        } else if let Some(len) = content_length {
            while rest.len() < len {
                let n = stream.read(&mut tmp).map_err(|e| (io_err(e), true))?;
                if n == 0 {
                    return Err((NetError::Other(CONNECTION_CLOSED.to_string()), true));
                }
                rest.extend_from_slice(&tmp[..n]);
            }
            rest.truncate(len);
            rest
        } else {
            keep = false;
            loop {
                let n = match stream.read(&mut tmp) {
                    Ok(n) => n,
                    Err(e) => return Err((io_err(e), true)),
                };
                if n == 0 {
                    break rest;
                }
                rest.extend_from_slice(&tmp[..n]);
            }
        };
        Ok((Response { status, body: body_bytes }, keep))
    };

    let mut pooled = take_idle(&key);
    loop {
        let (mut stream, reused) = match pooled.take() {
            Some(s) => (s, true),
            None => (connect()?, false),
        };
        match exchange(&mut stream) {
            Ok((resp, keep)) => {
                if keep {
                    put_idle(&key, stream);
                }
                return Ok(resp);
            }
            Err((e, started)) => {
                if reused && !started {
                    continue;
                }
                return Err(e);
            }
        }
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Decode a complete chunked body; None while more bytes are needed.
fn decode_chunked(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let line_end = data[i..].windows(2).position(|w| w == b"\r\n")? + i;
        let size_text = std::str::from_utf8(&data[i..line_end]).ok()?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        i = line_end + 2;
        if size == 0 {
            // Trailers end with an empty line.
            if data.len() >= i + 2 {
                return Some(out);
            }
            return None;
        }
        if data.len() < i + size + 2 {
            return None;
        }
        out.extend_from_slice(&data[i..i + size]);
        i += size + 2;
    }
}

// ── The protocol ────────────────────────────────────────────────────────────

fn auth_headers(cfg_token: &str) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {}", cfg_token)), ("content-type", "application/json".to_string())]
}

fn nullable_string(v: Option<&Json>) -> Option<String> {
    v.and_then(|x| x.as_string())
}

/// `vaultBlockerFromDestinations`: the sanitized held destinations of a response.
pub fn vault_blocker_from_destinations(destinations: Option<&Json>) -> Option<Blocker> {
    let list = destinations?.as_arr()?;
    let mut sanitized: Vec<BlockerDestination> = Vec::new();
    for raw in list {
        if raw.as_obj().is_none() {
            continue;
        }
        let reason = match raw.get_string("reason").as_deref() {
            Some("vault_offline") => "vault_offline",
            Some("vault_home_unreachable") => "vault_home_unreachable",
            _ => continue,
        };
        let vault_org_id = match raw.get_string("vaultOrgId") {
            Some(v) => v,
            None => continue,
        };
        sanitized.push(BlockerDestination {
            vault_org_id,
            reason: reason.to_string(),
            org_name: nullable_string(raw.get("orgName")),
            org_slug: nullable_string(raw.get("orgSlug")),
            project_id: nullable_string(raw.get("projectId")),
            project_name: nullable_string(raw.get("projectName")),
            project_slug: nullable_string(raw.get("projectSlug")),
            repo_slug: nullable_string(raw.get("repoSlug")),
            last_seen_at: nullable_string(raw.get("lastSeenAt")),
        });
    }
    if sanitized.is_empty() {
        return None;
    }
    let reason = if sanitized.iter().any(|d| d.reason == "vault_home_unreachable") { "vault_home_unreachable" } else { "vault_offline" };
    Some(Blocker { reason: reason.to_string(), destinations: sanitized })
}

/// `throwHttp`: the HxHttpError for a non-2xx response.
fn http_error(res: &Response, label: &str) -> NetError {
    let txt = res.text();
    let mut blocker: Option<Blocker> = None;
    if let Ok(body) = Json::parse(&txt) {
        let err = body.get_string("error");
        if matches!(err.as_deref(), Some("vault_offline") | Some("vault_home_unreachable")) {
            let reason = err.unwrap_or_default();
            blocker = vault_blocker_from_destinations(body.get("destinations"));
            if blocker.is_none() {
                if let Some(v) = body.get_string("vaultOrgId") {
                    if v.len() <= 128 {
                        blocker = Some(Blocker {
                            reason: reason.clone(),
                            destinations: vec![BlockerDestination {
                                vault_org_id: v,
                                reason: reason.clone(),
                                org_name: None,
                                org_slug: None,
                                project_id: None,
                                project_name: None,
                                project_slug: None,
                                repo_slug: None,
                                last_seen_at: None,
                            }],
                        });
                    }
                }
            }
        }
    }
    let excerpt = lossy(slice(&js(&txt), 0, 200));
    NetError::Http(HxHttpError::new(res.status, format!("{} failed: {} {}", label, res.status, excerpt), blocker))
}

fn plain_error(res: &Response, label: &str) -> NetError {
    let txt = res.text();
    let excerpt = lossy(slice(&js(&txt), 0, 200));
    NetError::Other(format!("{} failed: {} {}", label, res.status, excerpt))
}

fn parse_json_body(res: &Response, label: &str) -> Result<Json, NetError> {
    Json::parse(&res.text()).map_err(|_| NetError::Other(format!("{}: response is not JSON", label)))
}

pub struct Gateway {
    pub base_url: String,
    pub token: String,
}

impl Gateway {
    fn post(&self, label: &str, path: &str, body: &str, timeout_ms: u64) -> Result<Response, NetError> {
        assert_secure_fetch_url(&self.base_url, "gateway request")?;
        let headers = auth_headers(&self.token);
        request(label, "POST", &format!("{}{}", self.base_url, path), &headers, Some(body.as_bytes()), timeout_ms)
    }

    /// POST /devices/heartbeat with `{}`.
    pub fn send_heartbeat(&self) -> Result<(), NetError> {
        let res = self.post("heartbeat", "/devices/heartbeat", "{}", GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "heartbeat"));
        }
        Ok(())
    }

    /// POST /devices/sync-status.
    pub fn send_sync_status(&self, total: u64, done: u64, total_bytes: u64) -> Result<(), NetError> {
        let body = obj(vec![("total", Json::num(total as f64)), ("done", Json::num(done as f64)), ("totalBytes", Json::num(total_bytes as f64))]);
        let res = self.post("sync-status", "/devices/sync-status", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "sync-status"));
        }
        Ok(())
    }

    /// POST /sessions/append-url.
    pub fn request_append_url(&self, family: &str, session_id: &str, byte_count: u64, repo_slug: Option<&str>) -> Result<Json, NetError> {
        let body = obj(vec![
            ("family", Json::str(family)),
            ("sessionId", Json::str(session_id)),
            ("byteCount", Json::num(byte_count as f64)),
            ("repoSlug", Json::opt_str(repo_slug)),
        ]);
        let res = self.post("append-url", "/sessions/append-url", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "append-url"));
        }
        parse_json_body(&res, "append-url")
    }

    /// POST /sessions/commit; returns the parsed response (`totalBytes` matters).
    pub fn commit_chunk(&self, body: &Json) -> Result<Json, NetError> {
        let res = self.post("commit", "/sessions/commit", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "commit"));
        }
        parse_json_body(&res, "commit")
    }

    /// POST /sessions/verify.
    pub fn verify_sessions(&self, sessions: Vec<Json>) -> Result<Vec<Json>, NetError> {
        let body = obj(vec![("sessions", Json::Arr(sessions))]);
        let res = self.post("verify", "/sessions/verify", &body.stringify(), GATEWAY_BATCH_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "verify"));
        }
        let json = parse_json_body(&res, "verify")?;
        Ok(json.get("results").and_then(|r| r.as_arr()).cloned().unwrap_or_default())
    }

    /// POST /sessions/reattribute.
    pub fn reattribute_sessions(&self, items: Vec<Json>) -> Result<Vec<Json>, NetError> {
        let body = obj(vec![("items", Json::Arr(items))]);
        let res = self.post("reattribute", "/sessions/reattribute", &body.stringify(), GATEWAY_BATCH_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "reattribute"));
        }
        let json = parse_json_body(&res, "reattribute")?;
        Ok(json.get("results").and_then(|r| r.as_arr()).cloned().unwrap_or_default())
    }

    /// POST /sessions/team-mirror; returns the gateway's `teams` count.
    pub fn upload_team_mirror(&self, mirror: Json) -> Result<f64, NetError> {
        let body = obj(vec![("mirror", mirror)]);
        let res = self.post("team-mirror upload", "/sessions/team-mirror", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "team-mirror upload"));
        }
        let json = parse_json_body(&res, "team-mirror upload")?;
        Ok(json.get_f64("teams").unwrap_or(0.0))
    }

    /// POST /sessions/group-mirror; returns the gateway's `groups` count.
    pub fn upload_group_mirror(&self, mirror: Json) -> Result<f64, NetError> {
        let body = obj(vec![("mirror", mirror)]);
        let res = self.post("group-mirror upload", "/sessions/group-mirror", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "group-mirror upload"));
        }
        let json = parse_json_body(&res, "group-mirror upload")?;
        Ok(json.get_f64("groups").unwrap_or(0.0))
    }

    /// GET /route?repo=… ; Ok(None) for a non-2xx answer (the caller falls back).
    pub fn route(&self, repo: &str) -> Result<Option<Json>, NetError> {
        assert_secure_fetch_url(&self.base_url, "route discovery")?;
        let headers = vec![("authorization", format!("Bearer {}", self.token))];
        let url = format!("{}/route?repo={}", self.base_url, encode_uri_component(repo));
        let res = request("route discovery", "GET", &url, &headers, None, 30_000)?;
        if !res.ok() {
            return Ok(None);
        }
        Ok(Some(parse_json_body(&res, "route discovery")?))
    }
}

/// PUT the chunk bytes to a signed URL the gateway handed out.
pub fn put_chunk(upload_url: &str, bytes: &[u8]) -> Result<(), NetError> {
    assert_secure_fetch_url(upload_url, "PUT chunk")?;
    let headers = vec![("content-type", "application/x-ndjson".to_string())];
    let res = request("PUT chunk", "PUT", upload_url, &headers, Some(bytes), chunk_put_timeout_ms(bytes.len()))?;
    if !res.ok() {
        return Err(http_error(&res, "PUT chunk"));
    }
    Ok(())
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// `dropNulls(meta)` for a commit body.
pub fn commit_body(family: &str, session_id: &str, chunk_id: &str, replace: bool, vault_org_id: Option<&str>, meta: Json) -> Json {
    let mut body = obj(vec![
        ("family", Json::str(family)),
        ("sessionId", Json::str(session_id)),
        ("chunkId", Json::str(chunk_id)),
    ]);
    // `replace: args.replace || undefined` — a false flag is dropped by JSON.stringify.
    if replace {
        body.set("replace", Json::Bool(true));
    }
    body.set("vaultOrgId", Json::opt_str(vault_org_id));
    body.set("meta", drop_nulls(&meta));
    body
}

// ── The rest of the protocol (M4) ───────────────────────────────────────────

/// `fetchWhoami`'s answer: `ok` with the gateway's email and device name, or
/// not ok with `unauthorized` set on a 401/403 (the token was revoked).
pub struct WhoamiResult {
    pub ok: bool,
    pub unauthorized: bool,
    pub email: Option<String>,
    pub device_name: Option<String>,
}

/// What the gateway holds for this device (`fetchDeviceInventory`).
pub struct DeviceInventory {
    pub sessions: f64,
    pub bytes: f64,
    pub oldest_at: Json,
    pub newest_at: Json,
}

/// How long `hx status` waits on /whoami.
const WHOAMI_TIMEOUT_MS: u64 = 6000;

impl Gateway {
    /// GET /whoami: who this device token belongs to. Any transport failure
    /// reads as not ok and not unauthorized; only an insecure gateway URL is
    /// an error (the assertion sits outside the TypeScript client's try).
    pub fn whoami(&self) -> Result<WhoamiResult, NetError> {
        assert_secure_fetch_url(&self.base_url, "hx whoami")?;
        let headers = vec![("authorization", format!("Bearer {}", self.token))];
        let res = match request("whoami", "GET", &format!("{}/whoami", self.base_url), &headers, None, WHOAMI_TIMEOUT_MS) {
            Ok(r) => r,
            Err(_) => return Ok(WhoamiResult { ok: false, unauthorized: false, email: None, device_name: None }),
        };
        if !res.ok() {
            return Ok(WhoamiResult { ok: false, unauthorized: res.status == 401 || res.status == 403, email: None, device_name: None });
        }
        let body = Json::parse(&res.text()).ok();
        let pick = |k: &str| body.as_ref().and_then(|b| b.get_string(k)).filter(|s| !s.is_empty());
        Ok(WhoamiResult { ok: true, unauthorized: false, email: pick("email"), device_name: pick("deviceName") })
    }

    /// GET /devices/inventory: None on any failure (a gateway that predates
    /// the endpoint 404s and the status row is simply omitted).
    pub fn fetch_device_inventory(&self) -> Option<DeviceInventory> {
        if assert_secure_fetch_url(&self.base_url, "gateway request").is_err() {
            return None;
        }
        let headers = auth_headers(&self.token);
        let res = request("inventory", "GET", &format!("{}/devices/inventory", self.base_url), &headers, None, GATEWAY_TIMEOUT_MS).ok()?;
        if !res.ok() {
            return None;
        }
        let json = Json::parse(&res.text()).ok()?;
        let sessions = match json.get("sessions") {
            Some(Json::Num(n)) => *n,
            _ => return None,
        };
        let bytes = match json.get("bytes") {
            Some(Json::Num(n)) => *n,
            _ => return None,
        };
        let nullish = |v: Option<&Json>| match v {
            None | Some(Json::Null) => Json::Null,
            Some(x) => x.clone(),
        };
        Some(DeviceInventory { sessions, bytes, oldest_at: nullish(json.get("oldestAt")), newest_at: nullish(json.get("newestAt")) })
    }

    /// POST /sessions/retitle.
    pub fn retitle_sessions(&self, items: Vec<Json>) -> Result<Vec<Json>, NetError> {
        let body = obj(vec![("items", Json::Arr(items))]);
        let res = self.post("retitle", "/sessions/retitle", &body.stringify(), GATEWAY_BATCH_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "retitle"));
        }
        let json = parse_json_body(&res, "retitle")?;
        Ok(json.get("results").and_then(|r| r.as_arr()).cloned().unwrap_or_default())
    }

    /// POST /sessions/agent-append-url.
    pub fn request_agent_append_url(&self, family: &str, session_id: &str, agent_id: &str, byte_count: u64) -> Result<Json, NetError> {
        let body = obj(vec![
            ("family", Json::str(family)),
            ("sessionId", Json::str(session_id)),
            ("agentId", Json::str(agent_id)),
            ("byteCount", Json::num(byte_count as f64)),
        ]);
        let res = self.post("agent-append-url", "/sessions/agent-append-url", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "agent-append-url"));
        }
        parse_json_body(&res, "agent-append-url")
    }

    /// POST /sessions/agent-commit.
    pub fn commit_agent_chunk(&self, body: &Json) -> Result<Json, NetError> {
        let res = self.post("agent-commit", "/sessions/agent-commit", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "agent-commit"));
        }
        parse_json_body(&res, "agent-commit")
    }

    /// POST /sessions/workflow with the null fields dropped; an HxHttpError
    /// on failure so a 404 (a gateway that predates the endpoint) pauses the
    /// child lanes the way the TypeScript client's does.
    pub fn upload_workflow_run(&self, args: &Json) -> Result<(), NetError> {
        let res = self.post("workflow upload", "/sessions/workflow", &drop_nulls(args).stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(http_error(&res, "workflow upload"));
        }
        parse_json_body(&res, "workflow upload")?;
        Ok(())
    }

    /// POST /sessions/tasks; returns the gateway's `count`.
    pub fn upload_tasks(&self, family: &str, session_id: &str, tasks: Vec<Json>) -> Result<f64, NetError> {
        let body = obj(vec![("family", Json::str(family)), ("sessionId", Json::str(session_id)), ("tasks", Json::Arr(tasks))]);
        let res = self.post("tasks upload", "/sessions/tasks", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "tasks upload"));
        }
        let json = parse_json_body(&res, "tasks upload")?;
        Ok(json.get_f64("count").unwrap_or(0.0))
    }

    /// POST /sessions/plan.
    pub fn upload_plan(&self, family: &str, session_id: &str, plan_file_path: &str, content: &str) -> Result<(), NetError> {
        let body = obj(vec![
            ("family", Json::str(family)),
            ("sessionId", Json::str(session_id)),
            ("planFilePath", Json::str(plan_file_path)),
            ("content", Json::str(content)),
        ]);
        let res = self.post("plan upload", "/sessions/plan", &body.stringify(), GATEWAY_TIMEOUT_MS)?;
        if !res.ok() {
            return Err(plain_error(&res, "plan upload"));
        }
        parse_json_body(&res, "plan upload")?;
        Ok(())
    }
}

/// The agent-commit body (`commitAgentChunk`): `replace` only when true,
/// `vaultOrgId` verbatim (null for let.ai), `meta` with its nulls dropped.
pub fn agent_commit_body(family: &str, session_id: &str, agent_id: &str, chunk_id: &str, replace: bool, vault_org_id: Option<Json>, meta: Json) -> Json {
    let mut body = obj(vec![
        ("family", Json::str(family)),
        ("sessionId", Json::str(session_id)),
        ("agentId", Json::str(agent_id)),
        ("chunkId", Json::str(chunk_id)),
    ]);
    if replace {
        body.set("replace", Json::Bool(true));
    }
    // `vaultOrgId: args.vaultOrgId` — the append-url response's field as it
    // came: absent (an old gateway) is dropped by JSON.stringify, null is sent.
    if let Some(v) = vault_org_id {
        body.set("vaultOrgId", v);
    }
    body.set("meta", drop_nulls(&meta));
    body
}
