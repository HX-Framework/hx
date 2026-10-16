//! `~/.let/hx/config.json`: the gateway and the device token (src/config.ts).

use std::fs;

use crate::home::hx_dir;
use crate::json::Json;

#[derive(Clone, Debug)]
pub struct HxConfig {
    pub gateway_base_url: String,
    pub access_token: Option<String>,
    /// `evidenceUpload: false` withholds the session cwd from the gateway.
    pub evidence_upload: Option<bool>,
}

/// `readConfig()`: None when the file is missing or not JSON.
pub fn read_config() -> Option<HxConfig> {
    let raw = fs::read_to_string(hx_dir().join("config.json")).ok()?;
    let v = Json::parse(&raw).ok()?;
    let gateway = v.get_string("gatewayBaseUrl").unwrap_or_default();
    let token = v.get_string("accessToken").filter(|t| !t.is_empty());
    let evidence = v.get("evidenceUpload").and_then(|b| b.as_bool());
    Some(HxConfig { gateway_base_url: gateway, access_token: token, evidence_upload: evidence })
}
