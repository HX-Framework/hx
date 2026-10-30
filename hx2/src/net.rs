//! The gateway calls (src/uploader.ts and the commands around it) over an
//! HTTP/1.1 client that sends exactly the request Bun's fetch sends.
//!
//! The TypeScript client sets no User-Agent, so every gateway call carries
//! Bun's defaults: `accept: */*`, `accept-encoding: gzip, deflate, br, zstd`,
//! `connection: keep-alive`, `user-agent: Bun/1.3.14`, plus `content-type`
//! and `content-length` when there is a body (a POST without one sends
//! `content-length: 0`). hx2 sends the same headers with one difference the
//! program decided on 10-16: it names itself, `user-agent: hx2/<version>`, so
//! the hx and hx2 fleets can be told apart before hx is retired. The
//! differential harness compares every other header (all but `host`) and
//! checks that hx2 sends exactly that one.
//!
//! The transport is the one Bun's fetch gives the client: HTTPS anywhere
//! (rustls, trusting the Mozilla root store Bun bundles plus the PEM file
//! NODE_EXTRA_CA_CERTS names), plain HTTP to loopback hosts (the only
//! cleartext the client allows), kept-alive connections per origin, a
//! response body decoded by its content-encoding (gzip, deflate, br and zstd,
//! the four the request advertises), and redirects followed up to 20 hops,
//! unless the caller takes them itself (`hx update` checks every hop).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
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

/// Bun's message for a redirect chain past its limit.
const TOO_MANY_REDIRECTS: &str =
    "The response redirected too many times. For more information, pass `verbose: true` in the second argument to fetch()";

/// The redirect hops fetch follows before it gives up.
const MAX_REDIRECTS: usize = 20;

struct Url {
    scheme: String,
    host: String,
    port: u16,
    /// Path plus query, as sent on the request line.
    target: String,
}

fn parse_url(url: &str) -> Option<Url> {
    let (scheme, rest) = url.split_once("://")?;
    let rest = rest.split('#').next().unwrap_or("");
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_string()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_string()),
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
    if host.is_empty() {
        return None;
    }
    let scheme = scheme.to_lowercase();
    let default_port = if scheme == "https" { 443 } else { 80 };
    Some(Url { scheme, host: host.to_lowercase(), port: port.unwrap_or(default_port), target: path })
}

/// `scheme://host[:port]` of a URL, the origin a redirect is compared against.
fn origin_of(url: &str) -> String {
    match parse_url(url) {
        Some(u) => format!("{}://{}:{}", u.scheme, u.host, u.port),
        None => String::new(),
    }
}

/// `new URL(location, base).toString()` for the shapes a Location header takes.
pub fn resolve_url(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }
    let (scheme, rest) = match base.split_once("://") {
        Some(x) => x,
        None => return location.to_string(),
    };
    if let Some(rest_loc) = location.strip_prefix("//") {
        return format!("{}://{}", scheme, rest_loc);
    }
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    if location.starts_with('/') {
        return format!("{}://{}{}", scheme, authority, location);
    }
    let path = &rest[auth_end..];
    let path = path.split(['?', '#']).next().unwrap_or("");
    if location.starts_with('?') {
        return format!("{}://{}{}{}", scheme, authority, if path.is_empty() { "/" } else { path }, location);
    }
    let dir = match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "/",
    };
    let joined = crate::fsutil::normalize_posix(&format!("{}{}", dir, location));
    let keep_slash = location.ends_with('/') && !joined.ends_with('/');
    format!("{}://{}{}{}", scheme, authority, joined, if keep_slash { "/" } else { "" })
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
    /// The reason phrase of the status line (`res.statusText`).
    pub status_text: String,
    /// Header names lowercased, in the order the server sent them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// `res.headers.get(name)` for a lowercase name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// The client's TLS settings: the Mozilla roots, NODE_EXTRA_CA_CERTS, HTTP/1.1.
fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        // Bun, like Node, adds the certificates of the PEM file this names.
        if let Ok(path) = std::env::var("NODE_EXTRA_CA_CERTS") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                for der in pem_certificates(&text) {
                    let _ = roots.add(rustls::pki_types::CertificateDer::from(der));
                }
            }
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("the ring provider supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(cfg)
    })
    .clone()
}

/// The DER bodies of every `CERTIFICATE` block of a PEM text.
fn pem_certificates(text: &str) -> Vec<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let after = &rest[start + BEGIN.len()..];
        let end = match after.find(END) {
            Some(e) => e,
            None => break,
        };
        if let Some(der) = crate::crypto::base64_decode(&after[..end]) {
            if !der.is_empty() {
                out.push(der);
            }
        }
        rest = &after[end + END.len()..];
    }
    out
}

/// One connection: plain TCP to loopback, or TLS.
enum Conn {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Conn {
    fn tcp(&self) -> &TcpStream {
        match self {
            Conn::Plain(s) => s,
            Conn::Tls(t) => &t.sock,
        }
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(buf),
            Conn::Tls(t) => t.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(buf),
            Conn::Tls(t) => t.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(t) => t.flush(),
        }
    }
}

/// The connection as `exchange` drives it: every block sent or received
/// renews the watchdog's network wait, so an upload or a download that keeps
/// moving is never read as a freeze, however long it takes.
struct Watched<'a> {
    conn: &'a mut Conn,
    wait: &'a crate::watchdog::NetworkWait,
}

impl Read for Watched<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.conn.read(buf)?;
        if n > 0 {
            self.wait.progress();
        }
        Ok(n)
    }
}

impl Write for Watched<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.conn.write(buf)?;
        if n > 0 {
            self.wait.progress();
        }
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.conn.flush()
    }
}

/// Idle keep-alive connections by origin — what Bun's fetch keeps between
/// requests, so a pass over thousands of sessions reuses a handful of
/// connections instead of opening four per session. (A fresh connection per
/// request exhausted macOS's 16k ephemeral ports after about 4,000 sessions
/// of the 10,000-session scenario; the port range and TIME_WAIT are not the
/// servers' business, the connection count is Bun's behavior.)
fn idle_pool() -> &'static Mutex<HashMap<String, Vec<Conn>>> {
    static POOL: OnceLock<Mutex<HashMap<String, Vec<Conn>>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Idle connections kept per origin beyond which a returned one is closed.
const IDLE_PER_HOST: usize = 16;

fn take_idle(key: &str) -> Option<Conn> {
    let mut p = idle_pool().lock().unwrap_or_else(|e| e.into_inner());
    p.get_mut(key).and_then(|v| v.pop())
}

fn put_idle(key: &str, s: Conn) {
    let mut p = idle_pool().lock().unwrap_or_else(|e| e.into_inner());
    let v = p.entry(key.to_string()).or_default();
    if v.len() < IDLE_PER_HOST {
        v.push(s);
    }
}

/// What a failed TLS handshake or read says, in the words Bun uses where it
/// has them.
fn tls_message(e: &std::io::Error) -> Option<String> {
    let inner = e.get_ref()?;
    let tls = inner.downcast_ref::<rustls::Error>()?;
    Some(match tls {
        rustls::Error::InvalidCertificate(c) => match c {
            rustls::CertificateError::UnknownIssuer => "unable to get local issuer certificate".to_string(),
            rustls::CertificateError::Expired => "certificate has expired".to_string(),
            rustls::CertificateError::NotValidForName => "Hostname/IP does not match certificate's altnames".to_string(),
            other => format!("certificate verify failed: {:?}", other),
        },
        other => other.to_string(),
    })
}

fn timed_out(label: &str, timeout_ms: u64) -> NetError {
    NetError::Timeout(format!("{} timed out after {}s", label, crate::js::math_round(timeout_ms as f64 / 1000.0) as i64))
}

fn map_io(e: std::io::Error, label: &str, timeout_ms: u64) -> NetError {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => timed_out(label, timeout_ms),
        std::io::ErrorKind::ConnectionRefused => NetError::Other(UNABLE_TO_CONNECT.to_string()),
        _ => match tls_message(&e) {
            Some(m) => NetError::Other(m),
            None => NetError::Other(CONNECTION_CLOSED.to_string()),
        },
    }
}

/// One HTTP/1.1 request under a deadline, redirects followed the way fetch
/// follows them: a 303 (and a 301 or 302 answering a POST) turns into a GET
/// without a body, and a hop to another origin drops the authorization header.
pub fn request(
    label: &str,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<Response, NetError> {
    let mut current = url.to_string();
    let mut method = method.to_string();
    let mut body = body;
    let mut headers: Vec<(&str, String)> = headers.to_vec();
    for hop in 0..=MAX_REDIRECTS {
        let res = send_once(label, &method, &current, &headers, body, timeout_ms, &mut |_, _| {})?;
        if !matches!(res.status, 301 | 302 | 303 | 307 | 308) {
            return Ok(res);
        }
        let location = match res.header("location") {
            Some(l) => l.to_string(),
            None => return Ok(res),
        };
        if hop == MAX_REDIRECTS {
            return Err(NetError::Other(TOO_MANY_REDIRECTS.to_string()));
        }
        let next = resolve_url(&current, &location);
        let to_get = (res.status == 303 && method != "GET" && method != "HEAD") || ((res.status == 301 || res.status == 302) && method == "POST");
        if to_get {
            method = "GET".to_string();
            body = None;
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
        }
        if origin_of(&next) != origin_of(&current) {
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        }
        current = next;
    }
    Err(NetError::Other(TOO_MANY_REDIRECTS.to_string()))
}

/// One request with no redirect following: a 3xx comes back as it is
/// (fetch's `redirect: "manual"`), and `progress` hears (body bytes received,
/// content-length or 0) for every block of a 2xx body as it arrives.
pub fn request_manual(
    label: &str,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    timeout_ms: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Response, NetError> {
    send_once(label, method, url, headers, None, timeout_ms, progress)
}

/// One exchange on a kept-alive connection when the pool has one for the
/// origin, else on a fresh one. A pooled connection the peer closed while it
/// sat idle fails before any response byte arrives; the request is then sent
/// once more on a fresh connection.
fn send_once(
    label: &str,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<&[u8]>,
    timeout_ms: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Response, NetError> {
    let u = parse_url(url).ok_or_else(|| NetError::Other(format!("{}: invalid url", label)))?;
    let tls = match u.scheme.as_str() {
        "https" => true,
        "http" => false,
        other => return Err(NetError::Other(format!("{}: unsupported protocol {}:", label, other))),
    };
    let deadline = Duration::from_millis(timeout_ms);
    let connect = || -> Result<Conn, NetError> {
        let addrs = (u.host.as_str(), u.port).to_socket_addrs().map_err(|_| NetError::Other(UNABLE_TO_CONNECT.to_string()))?;
        let mut last_err: Option<std::io::Error> = None;
        let mut stream: Option<TcpStream> = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, deadline) {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        let s = match stream {
            Some(s) => s,
            None => {
                return Err(match last_err {
                    Some(e) if e.kind() == std::io::ErrorKind::TimedOut => timed_out(label, timeout_ms),
                    _ => NetError::Other(UNABLE_TO_CONNECT.to_string()),
                })
            }
        };
        let _ = s.set_nodelay(true);
        if !tls {
            return Ok(Conn::Plain(s));
        }
        let name = rustls::pki_types::ServerName::try_from(u.host.as_str())
            .map(|n| n.to_owned())
            .map_err(|_| NetError::Other(format!("{}: invalid host name {}", label, u.host)))?;
        let conn = rustls::ClientConnection::new(tls_config(), name).map_err(|e| NetError::Other(e.to_string()))?;
        Ok(Conn::Tls(Box::new(rustls::StreamOwned::new(conn, s))))
    };

    let default_port = if tls { 443 } else { 80 };
    let host_name = if u.host.contains(':') { format!("[{}]", u.host) } else { u.host.clone() };
    let host_header = if u.port == default_port { host_name } else { format!("{}:{}", host_name, u.port) };
    let key = format!("{}://{}:{}", u.scheme, u.host, u.port);
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

    // From the name lookup to the last byte of the response this thread is
    // blocked, which the freeze watchdog reads as waiting while the exchange
    // moves (watchdog::network_wait).
    let wait = crate::watchdog::network_wait(timeout_ms);
    let mut pooled = take_idle(&key);
    loop {
        let (mut stream, reused) = match pooled.take() {
            Some(s) => (s, true),
            None => (connect()?, false),
        };
        match exchange(&mut stream, &head, body, method, deadline, label, timeout_ms, &wait, progress) {
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

/// The exchange on one connection: the request, then the whole response.
/// Ok((response, keep)): keep says the connection may serve another request.
/// Err((error, started)): started says response bytes had arrived, so the
/// peer may have acted on the request.
#[allow(clippy::too_many_arguments)]
fn exchange(
    stream: &mut Conn,
    head: &str,
    body: Option<&[u8]>,
    method: &str,
    deadline: Duration,
    label: &str,
    timeout_ms: u64,
    wait: &crate::watchdog::NetworkWait,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(Response, bool), (NetError, bool)> {
    let _ = stream.tcp().set_read_timeout(Some(deadline));
    let _ = stream.tcp().set_write_timeout(Some(deadline));
    let mut stream = Watched { conn: stream, wait };
    let io = |e: std::io::Error, started: bool| (map_io(e, label, timeout_ms), started);
    stream.write_all(head.as_bytes()).map_err(|e| io(e, false))?;
    if let Some(b) = body {
        if !b.is_empty() {
            stream.write_all(b).map_err(|e| io(e, false))?;
        }
    }
    stream.flush().map_err(|e| io(e, false))?;

    // Headers, then the body by content-length or chunked transfer coding,
    // else until the peer closes (which ends the connection). A 1xx interim
    // answer is skipped.
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut tmp = vec![0u8; 65536];
    let (status, status_text, resp_headers, keep_hint, rest) = loop {
        let header_end;
        loop {
            if let Some(i) = find_header_end(&buf) {
                header_end = i;
                break;
            }
            let n = stream.read(&mut tmp).map_err(|e| io(e, !buf.is_empty()))?;
            if n == 0 {
                return Err((NetError::Other(CONNECTION_CLOSED.to_string()), !buf.is_empty()));
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let head_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let mut lines = head_text.split("\r\n");
        let status_line = lines.next().unwrap_or("");
        let status: u16 = status_line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let rest = buf[header_end + 4..].to_vec();
        if (100..200).contains(&status) && status != 101 {
            buf = rest;
            continue;
        }
        let mut hs: Vec<(String, String)> = Vec::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                hs.push((k.trim().to_lowercase(), v.trim().to_string()));
            }
        }
        let status_text = status_line.splitn(3, ' ').nth(2).unwrap_or("").trim().to_string();
        break (status, status_text, hs, !status_line.starts_with("HTTP/1.0"), rest);
    };
    let mut keep = keep_hint;
    let mut content_length: Option<u64> = None;
    let mut chunked = false;
    for (k, v) in &resp_headers {
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
    let total = if chunked { 0 } else { content_length.unwrap_or(0) };
    // Progress is for a body the caller will keep: a 2xx (fetch hands an
    // error status back before anyone reads its body).
    let reporting = (200..300).contains(&status);
    let mut report = |n: u64| {
        if reporting {
            progress(n, total);
        }
    };
    let raw_body: Vec<u8> = if method == "HEAD" || status == 204 || status == 304 {
        Vec::new()
    } else if chunked {
        let mut dec = ChunkedDecoder::default();
        let mut out: Vec<u8> = Vec::new();
        dec.feed(&rest, &mut out).map_err(|_| (NetError::Other(CONNECTION_CLOSED.to_string()), true))?;
        report(out.len() as u64);
        while !dec.done {
            let n = stream.read(&mut tmp).map_err(|e| io(e, true))?;
            if n == 0 {
                return Err((NetError::Other(CONNECTION_CLOSED.to_string()), true));
            }
            dec.feed(&tmp[..n], &mut out).map_err(|_| (NetError::Other(CONNECTION_CLOSED.to_string()), true))?;
            report(out.len() as u64);
        }
        out
    } else if let Some(len) = content_length {
        let len = len as usize;
        let mut out = rest;
        if out.capacity() < len {
            out.reserve(len - out.len().min(len));
        }
        report(out.len().min(len) as u64);
        while out.len() < len {
            let n = stream.read(&mut tmp).map_err(|e| io(e, true))?;
            if n == 0 {
                return Err((NetError::Other(CONNECTION_CLOSED.to_string()), true));
            }
            out.extend_from_slice(&tmp[..n]);
            report(out.len().min(len) as u64);
        }
        out.truncate(len);
        out
    } else {
        keep = false;
        let mut out = rest;
        report(out.len() as u64);
        loop {
            let n = match stream.read(&mut tmp) {
                Ok(n) => n,
                // A TLS peer that closes without close_notify ends a
                // close-delimited body the way a plain close does.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => 0,
                Err(e) => return Err(io(e, true)),
            };
            if n == 0 {
                break;
            }
            out.extend_from_slice(&tmp[..n]);
            report(out.len() as u64);
        }
        out
    };
    let encoding = resp_headers.iter().find(|(k, _)| k == "content-encoding").map(|(_, v)| v.clone());
    let body_bytes = if raw_body.is_empty() {
        raw_body
    } else {
        decode_body(encoding.as_deref(), raw_body).map_err(|m| (NetError::Other(m), true))?
    };
    Ok((Response { status, status_text, headers: resp_headers, body: body_bytes }, keep))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// `transfer-encoding: chunked`, decoded as the bytes arrive.
#[derive(Default)]
struct ChunkedDecoder {
    pending: Vec<u8>,
    /// Data bytes left in the current chunk.
    remaining: usize,
    in_data: bool,
    need_crlf: bool,
    trailers: bool,
    done: bool,
}

impl ChunkedDecoder {
    fn feed(&mut self, data: &[u8], out: &mut Vec<u8>) -> Result<(), ()> {
        self.pending.extend_from_slice(data);
        let mut i = 0usize;
        while !self.done {
            if self.in_data {
                let take = (self.pending.len() - i).min(self.remaining);
                out.extend_from_slice(&self.pending[i..i + take]);
                i += take;
                self.remaining -= take;
                if self.remaining > 0 {
                    break;
                }
                self.in_data = false;
                self.need_crlf = true;
            }
            if self.need_crlf {
                if self.pending.len() - i < 2 {
                    break;
                }
                i += 2;
                self.need_crlf = false;
            }
            let line_end = match self.pending[i..].windows(2).position(|w| w == b"\r\n") {
                Some(p) => i + p,
                None => break,
            };
            let line = self.pending[i..line_end].to_vec();
            i = line_end + 2;
            if self.trailers {
                if line.is_empty() {
                    self.done = true;
                }
                continue;
            }
            let text = std::str::from_utf8(&line).map_err(|_| ())?;
            let size_text = text.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size_text, 16).map_err(|_| ())?;
            if size == 0 {
                self.trailers = true;
                continue;
            }
            self.remaining = size;
            self.in_data = true;
        }
        self.pending.drain(..i);
        Ok(())
    }
}

/// Undo the codings a response names, last applied first, the way fetch
/// hands back a decoded body. An unknown coding leaves the bytes as they are.
fn decode_body(encoding: Option<&str>, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let enc = match encoding {
        Some(e) => e.to_ascii_lowercase(),
        None => return Ok(body),
    };
    let fail = |e: std::io::Error| format!("Decompression error: {}", e);
    let mut data = body;
    for coding in enc.split(',').map(|c| c.trim()).collect::<Vec<_>>().into_iter().rev() {
        data = match coding {
            "" | "identity" => data,
            "gzip" | "x-gzip" => {
                let mut out = Vec::new();
                flate2::read::MultiGzDecoder::new(&data[..]).read_to_end(&mut out).map_err(fail)?;
                out
            }
            "deflate" => {
                // Servers send either zlib-wrapped or raw deflate under this name.
                let mut out = Vec::new();
                match flate2::read::ZlibDecoder::new(&data[..]).read_to_end(&mut out) {
                    Ok(_) => out,
                    Err(_) => {
                        let mut raw = Vec::new();
                        flate2::read::DeflateDecoder::new(&data[..]).read_to_end(&mut raw).map_err(fail)?;
                        raw
                    }
                }
            }
            "br" => {
                let mut out = Vec::new();
                brotli_decompressor::Decompressor::new(&data[..], 4096).read_to_end(&mut out).map_err(fail)?;
                out
            }
            "zstd" => zstd::stream::decode_all(&data[..]).map_err(fail)?,
            _ => return Ok(data),
        };
    }
    Ok(data)
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
