//! Friendly names for vault org ids (src/org-names.ts). Best-effort.

use std::fs;

use crate::fsutil::write_atomic_0600;
use crate::home::hx_dir;
use crate::json::{Json, OMap};

pub fn read_org_names() -> OMap {
    let mut out = OMap::new();
    let raw = match fs::read_to_string(hx_dir().join("org-names.json")) {
        Ok(r) => r,
        Err(_) => return out,
    };
    if let Ok(Json::Obj(o)) = Json::parse(&raw) {
        for (k, v) in o.iter() {
            if let Some(s) = v.as_string() {
                if !s.trim().is_empty() {
                    out.set(k, Json::str(&s));
                }
            }
        }
    }
    out
}

/// Remember every (vaultOrgId, orgName) pair of a held destination list.
pub fn remember_org_names(dests: &[(String, Option<String>)]) {
    let with_names: Vec<(&String, &String)> =
        dests.iter().filter_map(|(id, name)| name.as_ref().filter(|n| !n.is_empty()).map(|n| (id, n))).collect();
    if with_names.is_empty() {
        return;
    }
    let mut current = read_org_names();
    let mut changed = false;
    for (id, name) in with_names {
        let same = current.get(id).and_then(|v| v.as_string()).as_deref() == Some(name.as_str());
        if !same {
            current.set(id, Json::str(name));
            changed = true;
        }
    }
    if !changed {
        return;
    }
    let text = Json::Obj(current).stringify_pretty();
    let _ = write_atomic_0600(&hx_dir().join("org-names.json"), text.as_bytes());
}
