//! Auth for the local `hx ui` server (src/ui/auth.ts and instance.ts): a
//! reusable launch token in the URL fragment, exchanged for a session token
//! the SPA sends in `x-hx-ui-token`; an owner key that lives only in the 0600
//! server-info file and proves ownership with HMACs for the instance-reuse
//! handshake; and the Host and Origin allowlists.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::crypto::{ct_eq, hmac_sha256_b64url, mint_token, sha256};
use crate::home::hx_dir;
use crate::json::{obj, Json};

pub const LAUNCH_TTL_MS: f64 = 60.0 * 60_000.0;
pub const CLIENT_PROOF_LABEL: &str = "hx-ui-reissue";
pub const SERVER_PROOF_LABEL: &str = "hx-ui-instance";

/// `hmacProof`: HMAC-SHA256(ownerKey, "<label>:<nonce>") as base64url.
pub fn hmac_proof(owner_key: &str, label: &str, nonce: &str) -> String {
    hmac_sha256_b64url(owner_key, &format!("{}:{}", label, nonce))
}

/// `tokensMatch`: constant time, over the sha256 of each side.
pub fn tokens_match(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) if !x.is_empty() && !y.is_empty() => ct_eq(&sha256(x.as_bytes()), &sha256(y.as_bytes())),
        _ => false,
    }
}

pub struct UiAuth {
    pub owner_key: String,
    pub session_token: String,
    /// Outstanding launch tokens: sha256 digest → expiry (ms).
    launch: Mutex<Vec<([u8; 32], f64)>>,
}

impl UiAuth {
    pub fn new() -> UiAuth {
        UiAuth { owner_key: mint_token(), session_token: mint_token(), launch: Mutex::new(Vec::new()) }
    }

    /// A fresh launch token, reusable until its TTL runs out.
    pub fn mint_launch_token(&self) -> String {
        let now = crate::fsutil::now_ms();
        let mut l = self.launch.lock().unwrap_or_else(|e| e.into_inner());
        l.retain(|(_, exp)| *exp > now);
        let token = mint_token();
        l.push((sha256(token.as_bytes()), now + LAUNCH_TTL_MS));
        token
    }

    /// POST /api/auth: an unexpired launch token → the session token.
    pub fn exchange(&self, candidate: &str) -> Option<String> {
        if candidate.is_empty() {
            return None;
        }
        let now = crate::fsutil::now_ms();
        let cand = sha256(candidate.as_bytes());
        let l = self.launch.lock().unwrap_or_else(|e| e.into_inner());
        for (digest, exp) in l.iter() {
            if *exp <= now {
                continue;
            }
            if ct_eq(&cand, digest) {
                return Some(self.session_token.clone());
            }
        }
        None
    }

    pub fn is_valid_session(&self, header: Option<&str>) -> bool {
        tokens_match(header, Some(&self.session_token))
    }

    pub fn verify_owner_proof(&self, nonce: &str, proof: &str) -> bool {
        tokens_match(Some(proof), Some(&hmac_proof(&self.owner_key, CLIENT_PROOF_LABEL, nonce)))
    }

    pub fn server_proof(&self, nonce: &str) -> String {
        hmac_proof(&self.owner_key, SERVER_PROOF_LABEL, nonce)
    }
}

/// The DNS-rebinding gate: only loopback spellings of this server.
pub fn is_allowed_host(host: Option<&str>, port: u16) -> bool {
    let h = match host {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    h == format!("localhost:{}", port) || h == format!("127.0.0.1:{}", port) || h == format!("[::1]:{}", port)
}

/// The Origin gate for state-changing requests; no Origin at all passes.
pub fn is_allowed_origin(origin: Option<&str>, port: u16) -> bool {
    let o = match origin {
        Some(o) => o.to_lowercase(),
        None => return true,
    };
    o == format!("http://localhost:{}", port) || o == format!("http://127.0.0.1:{}", port) || o == format!("http://[::1]:{}", port)
}

// ── Single-instance bookkeeping ─────────────────────────────────────────────

pub fn ui_dir() -> PathBuf {
    hx_dir().join("ui")
}

fn info_path() -> PathBuf {
    ui_dir().join("server.json")
}

pub struct ServerInfo {
    pub port: u16,
    pub pid: u32,
    pub owner_key: String,
}

fn token_shaped(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `writeServerInfo`: ~/.let/hx/ui/server.json (0600), tmp then rename.
pub fn write_server_info(info: &ServerInfo) -> Result<(), String> {
    let dir = ui_dir();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|e| crate::fsutil::node_error(&e, "mkdir", &dir))?;
    let body = obj(vec![("port", Json::num(info.port as f64)), ("pid", Json::num(info.pid as f64)), ("ownerKey", Json::str(&info.owner_key))]);
    crate::fsutil::write_atomic_0600_node(&info_path(), body.stringify_pretty().as_bytes())
}

/// `readServerInfo`: the strict shape, or None.
pub fn read_server_info() -> Option<ServerInfo> {
    let raw = fs::read_to_string(info_path()).ok()?;
    let v = Json::parse(&raw).ok()?;
    let port = v.get_f64("port")?;
    let pid = v.get_f64("pid")?;
    let owner_key = v.get_string("ownerKey")?;
    if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) || !token_shaped(&owner_key) {
        return None;
    }
    Some(ServerInfo { port: port as u16, pid: pid as u32, owner_key })
}

pub fn remove_server_info() {
    let _ = fs::remove_file(info_path());
}

/// `instanceIdentity`.
pub fn instance_identity() -> Json {
    obj(vec![("app", Json::str("hx-ui")), ("version", Json::str(crate::HX_VERSION))])
}

const PROBE_TIMEOUT_MS: u64 = 1_500;

/// `probeExistingInstance`: the mutual-HMAC reuse handshake with the server
/// the file names; a launch URL when it is genuinely ours and alive.
pub fn probe_existing_instance(info: &ServerInfo, ui_host: &str) -> Option<String> {
    let base = format!("http://127.0.0.1:{}", info.port);
    let nonce = crate::crypto::base64url(&crate::crypto::random_bytes(18));
    let body = obj(vec![("nonce", Json::str(&nonce)), ("proof", Json::str(&hmac_proof(&info.owner_key, CLIENT_PROOF_LABEL, &nonce)))]);
    let headers = vec![("content-type", "application/json".to_string())];
    let res = crate::net::request("instance probe", "POST", &format!("{}/api/instance/reissue", base), &headers, Some(body.stringify().as_bytes()), PROBE_TIMEOUT_MS).ok()?;
    if !res.ok() {
        return None;
    }
    let v = Json::parse(&res.text()).ok()?;
    let launch = v.get_string("launchToken")?;
    let proof = v.get_string("serverProof")?;
    if !tokens_match(Some(&proof), Some(&hmac_proof(&info.owner_key, SERVER_PROOF_LABEL, &nonce))) {
        return None;
    }
    if !token_shaped(&launch) {
        return None;
    }
    Some(format!("http://{}:{}/#k={}", ui_host, info.port, launch))
}
