//! The connection probe of `hx status` (src/probe.ts): three round trips to
//! `/ping` for the latency, one sized download for the throughput, and a
//! grade from the weaker of the two.

use std::time::Instant;

use crate::config::HxConfig;
use crate::js::{math_round, num_to_string, to_fixed};
use crate::net::{request, NetError, UNABLE_TO_CONNECT};

const LATENCY_SAMPLES: usize = 3;
const BANDWIDTH_BYTES: u64 = 1024 * 1024;
const TIMEOUT_MS: u64 = 8000;

pub struct ProbeResult {
    pub up: bool,
    pub reason: Option<String>,
    pub latency_ms: f64,
    pub bytes_per_sec: Option<f64>,
    pub quality: &'static str,
}

/// `describeError`: the friendly cause of a failed ping.
fn describe_error(e: &NetError) -> String {
    match e {
        NetError::Timeout(_) => "timed out reaching gateway".to_string(),
        NetError::Http(h) => h.message.clone(),
        NetError::Other(m) => {
            if m.is_empty() {
                "can't reach gateway".to_string()
            } else {
                m.clone()
            }
        }
    }
}

fn ping(cfg: &HxConfig, bytes: Option<u64>) -> Result<(f64, usize), NetError> {
    // `Bearer ${cfg.accessToken}`: a missing token is the literal "undefined".
    let headers = vec![("authorization", format!("Bearer {}", cfg.access_token.clone().unwrap_or_else(|| "undefined".to_string())))];
    let url = match bytes {
        Some(n) => format!("{}/ping?bytes={}", cfg.gateway_base_url, n),
        None => format!("{}/ping", cfg.gateway_base_url),
    };
    let start = Instant::now();
    let res = request("ping", "GET", &url, &headers, None, TIMEOUT_MS)?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    if res.status == 401 {
        return Err(NetError::Other("not authorized (run `hx connect`)".to_string()));
    }
    if !res.ok() {
        return Err(NetError::Other(format!("gateway returned {}", res.status)));
    }
    Ok((elapsed, res.body.len()))
}

pub fn probe_connection(cfg: &HxConfig) -> ProbeResult {
    let mut samples: Vec<f64> = Vec::new();
    for _ in 0..LATENCY_SAMPLES {
        match ping(cfg, None) {
            Ok((ms, _)) => samples.push(ms),
            Err(e) => {
                let reason = match &e {
                    NetError::Other(m) if m == UNABLE_TO_CONNECT => m.clone(),
                    other => describe_error(other),
                };
                return ProbeResult { up: false, reason: Some(reason), latency_ms: 0.0, bytes_per_sec: None, quality: "Poor" };
            }
        }
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let latency_ms = math_round(samples[samples.len() / 2]);
    let bytes_per_sec = match ping(cfg, Some(BANDWIDTH_BYTES)) {
        Ok((ms, n)) if ms > 0.0 && n > 0 => Some((n as f64 / ms) * 1000.0),
        _ => None,
    };
    ProbeResult { up: true, reason: None, latency_ms, bytes_per_sec, quality: grade(latency_ms, bytes_per_sec) }
}

fn grade(latency_ms: f64, bytes_per_sec: Option<f64>) -> &'static str {
    let latency_score = if latency_ms <= 60.0 {
        3
    } else if latency_ms <= 150.0 {
        2
    } else if latency_ms <= 400.0 {
        1
    } else {
        0
    };
    let bandwidth_score = match bytes_per_sec {
        None => latency_score,
        Some(bps) => {
            let mbps = bps / 1_000_000.0;
            if mbps >= 8.0 {
                3
            } else if mbps >= 2.0 {
                2
            } else if mbps >= 0.5 {
                1
            } else {
                0
            }
        }
    };
    let score = latency_score.min(bandwidth_score);
    if score >= 3 {
        "Excellent"
    } else if score == 2 {
        "Good"
    } else if score == 1 {
        "Fair"
    } else {
        "Poor"
    }
}

/// `formatRate`.
pub fn format_rate(bytes_per_sec: Option<f64>) -> String {
    let bps = match bytes_per_sec {
        Some(v) if v != 0.0 => v,
        _ => return "throughput unknown".to_string(),
    };
    let mbps = bps / 1_000_000.0;
    if mbps >= 1.0 {
        return format!("{} MB/s", to_fixed(mbps, 1));
    }
    format!("{} KB/s", num_to_string(math_round(bps / 1000.0)))
}
