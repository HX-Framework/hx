//! `~/.let/hx/config.json` and `config.local.json`: the gateway and the
//! device token of each upload lane (src/config.ts).

use std::fs;
use std::path::PathBuf;

use crate::fsutil::{node_error, write_atomic_0600_node};
use crate::home::hx_dir;
use crate::json::Json;

#[derive(Clone, Debug)]
pub struct HxConfig {
    pub gateway_base_url: String,
    pub access_token: Option<String>,
    /// `evidenceUpload: false` withholds the session cwd from the gateway.
    pub evidence_upload: Option<bool>,
    /// Cached by `hx status` from the gateway's /whoami.
    pub email: Option<String>,
    pub device_name: Option<String>,
    /// The upload lane this config belongs to: "main" (config.json) or
    /// "local" (config.local.json, the `--local` tee) — never persisted.
    pub scope: &'static str,
}

pub fn config_path() -> PathBuf {
    hx_dir().join("config.json")
}

pub fn local_config_path() -> PathBuf {
    hx_dir().join("config.local.json")
}

fn parse(v: &Json, scope: &'static str) -> HxConfig {
    HxConfig {
        gateway_base_url: v.get_string("gatewayBaseUrl").unwrap_or_default(),
        access_token: v.get_string("accessToken").filter(|t| !t.is_empty()),
        evidence_upload: v.get("evidenceUpload").and_then(|b| b.as_bool()),
        email: v.get_string("email").filter(|e| !e.is_empty()),
        device_name: v.get_string("deviceName").filter(|d| !d.is_empty()),
        scope,
    }
}

/// `readConfig()` as the parsed object: None when the file is missing or not JSON.
pub fn read_config_raw() -> Option<Json> {
    let raw = fs::read_to_string(config_path()).ok()?;
    Json::parse(&raw).ok()
}

/// `readConfig()`: None when the file is missing or not JSON.
pub fn read_config() -> Option<HxConfig> {
    read_config_raw().map(|v| parse(&v, "main"))
}

/// `readLocalConfig()`: the `--local` tee's connection, stamped "local".
pub fn read_local_config() -> Option<HxConfig> {
    let raw = fs::read_to_string(local_config_path()).ok()?;
    let v = Json::parse(&raw).ok()?;
    Some(parse(&v, "local"))
}

/// `writeConfig(cfg)`: the directory, then `config.json.tmp` (mode 0600,
/// pretty-printed) renamed over the target; `stateScope` is never persisted.
/// Errors carry the runtime's text (`EACCES: permission denied, open '…'`).
pub fn write_config_json(cfg: &Json) -> Result<(), String> {
    fs::create_dir_all(hx_dir()).map_err(|e| node_error(&e, "mkdir", hx_dir()))?;
    let mut persisted = cfg.clone();
    persisted.remove("stateScope");
    write_atomic_0600_node(&config_path(), persisted.stringify_pretty().as_bytes())
}
