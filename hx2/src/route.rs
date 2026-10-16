//! Per-repo upload route discovery (src/route.ts).

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

use crate::fsutil::now_ms;
use crate::json::Json;
use crate::net::{is_secure_fetch_url, Gateway};

#[derive(Clone, Debug)]
pub enum RouteMode {
    Cloud,
    FortressDirect { gateway_url: String, token: String, expires_at: String },
}

#[derive(Clone, Debug)]
pub struct Route {
    pub mode: RouteMode,
    /// Echoed by newer gateways; None when the response carried no array.
    pub attributed_org_ids: Option<Vec<String>>,
}

impl Route {
    fn cloud() -> Route {
        Route { mode: RouteMode::Cloud, attributed_org_ids: None }
    }
}

const REFRESH_BEFORE_EXPIRY_MS: f64 = 5.0 * 60_000.0;

fn parse_iso_ms(s: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64)
}

fn parse_route(v: &Json) -> Option<Route> {
    let mode = v.get_string("mode")?;
    let attributed = v.get("attributedOrgIds").and_then(|a| a.as_arr()).map(|a| a.iter().filter_map(|x| x.as_string()).collect::<Vec<_>>());
    if mode == "fortress-direct" {
        let gateway_url = v.get_string("gatewayUrl").unwrap_or_default();
        let token = v.get_string("token").unwrap_or_default();
        let expires_at = v.get_string("expiresAt").unwrap_or_default();
        return Some(Route { mode: RouteMode::FortressDirect { gateway_url, token, expires_at }, attributed_org_ids: attributed });
    }
    Some(Route { mode: RouteMode::Cloud, attributed_org_ids: attributed })
}

/// One route discovery in flight, shared by every caller that asks for the
/// same repo while it runs.
struct Flight {
    done: Mutex<Option<Route>>,
    cv: Condvar,
}

/// A scope's route cache (watch.ts ROUTE_CACHE) with its in-flight table.
pub struct RouteCache {
    routes: Mutex<HashMap<String, Route>>,
    inflight: Mutex<HashMap<String, Arc<Flight>>>,
}

impl RouteCache {
    pub fn new() -> RouteCache {
        RouteCache { routes: Mutex::new(HashMap::new()), inflight: Mutex::new(HashMap::new()) }
    }
}

/// `resolveRouteShared`: under the upload pool, N workers hitting the same
/// cold repo share ONE discovery fetch — the same result, no stampede. The
/// cloud route is never served from the cache (resolveRoute re-asks every
/// time), so the sharing is what keeps the route traffic at the client's level.
pub fn resolve_route_shared(repo: &str, gateway: &Gateway, cache: &RouteCache) -> Route {
    let (flight, leader) = {
        let mut inflight = cache.inflight.lock().unwrap_or_else(|e| e.into_inner());
        let existing = inflight.get(repo).cloned();
        match existing {
            Some(f) => (f, false),
            None => {
                let f = Arc::new(Flight { done: Mutex::new(None), cv: Condvar::new() });
                inflight.insert(repo.to_string(), f.clone());
                (f, true)
            }
        }
    };
    if !leader {
        let mut done = flight.done.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(r) = done.as_ref() {
                return r.clone();
            }
            done = flight.cv.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }
    let route = resolve_route(repo, gateway, &cache.routes);
    cache.inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(repo);
    *flight.done.lock().unwrap_or_else(|e| e.into_inner()) = Some(route.clone());
    flight.cv.notify_all();
    route
}

/// Where this repo's sessions upload. Never fails: a gateway that cannot be
/// reached answers with the last good route, or the cloud.
pub fn resolve_route(repo: &str, gateway: &Gateway, cache: &Mutex<HashMap<String, Route>>) -> Route {
    let cached = cache.lock().unwrap_or_else(|e| e.into_inner()).get(repo).cloned();
    if let Some(c) = &cached {
        if let RouteMode::FortressDirect { expires_at, .. } = &c.mode {
            if let Some(exp) = parse_iso_ms(expires_at) {
                if exp - now_ms() > REFRESH_BEFORE_EXPIRY_MS {
                    return c.clone();
                }
            }
        }
    }
    let fallback = || cached.clone().unwrap_or_else(Route::cloud);
    let fetched = match gateway.route(repo) {
        Ok(Some(v)) => v,
        Ok(None) => return fallback(),
        Err(_) => return fallback(),
    };
    let route = match parse_route(&fetched) {
        Some(r) => r,
        None => return fallback(),
    };
    if let RouteMode::FortressDirect { gateway_url, .. } = &route.mode {
        if !is_secure_fetch_url(gateway_url) {
            return fallback();
        }
    }
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(repo.to_string(), route.clone());
    route
}
