//! The web UI's static files (src/ui/assets.ts): embedded into the binary at
//! build time from ui/dist (build.rs), or, in a source checkout built
//! without them, read from that checkout's ui/dist. Lookups go through the
//! map only, so a request path never reaches the filesystem.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));

#[derive(Clone, Copy, PartialEq)]
pub enum AssetMode {
    Embedded,
    Disk,
}

pub enum AssetSource {
    Embedded(&'static [u8]),
    Disk(PathBuf),
}

impl AssetSource {
    pub fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            AssetSource::Embedded(b) => Some(b.to_vec()),
            AssetSource::Disk(p) => std::fs::read(p).ok(),
        }
    }
}

pub struct UiAssets {
    pub mode: AssetMode,
    pub files: HashMap<String, AssetSource>,
    /// CSP `'sha256-…'` tokens of index.html's inline scripts.
    pub inline_script_hashes: Vec<String>,
}

/// `inlineScriptHashesOf`: every `<script>` without a `src=` attribute, its
/// body hashed, empty bodies skipped.
pub fn inline_script_hashes_of(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("<script") {
        let open = from + rel;
        let attrs_start = open + "<script".len();
        let gt = match lower[attrs_start..].find('>') {
            Some(g) => attrs_start + g,
            None => break,
        };
        let attrs = &lower[attrs_start..gt];
        let has_src = attrs.match_indices("src=").any(|(i, _)| {
            i == 0 || {
                let prev = attrs.as_bytes()[i - 1];
                !(prev.is_ascii_alphanumeric() || prev == b'_')
            }
        });
        if has_src {
            from = attrs_start;
            continue;
        }
        let body_start = gt + 1;
        let close = match lower[body_start..].find("</script>") {
            Some(c) => body_start + c,
            None => break,
        };
        let body = &html[body_start..close];
        if !body.trim().is_empty() {
            out.push(format!("'sha256-{}'", crate::crypto::base64(&crate::crypto::sha256(body.as_bytes()))));
        }
        from = close + "</script>".len();
    }
    out
}

/// `contentTypeFor`.
pub fn content_type_for(url_path: &str) -> &'static str {
    let ext = match url_path.rfind('.') {
        Some(i) => url_path[i..].to_ascii_lowercase(),
        None => String::new(),
    };
    match ext.as_str() {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        ".json" => "application/json",
        ".map" => "application/json",
        ".txt" => "text/plain; charset=utf-8",
        ".woff2" => "font/woff2",
        ".woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// `mapDistDir`: URL path → file, every file under a dist directory.
fn map_dist_dir(dist: &Path) -> HashMap<String, AssetSource> {
    let mut files = HashMap::new();
    let mut stack = vec![dist.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(t) if t.is_file() => {
                    let rel = p.strip_prefix(dist).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                    let key = if rel.starts_with('/') { rel } else { format!("/{}", rel) };
                    files.insert(key, AssetSource::Disk(p));
                }
                _ => {}
            }
        }
    }
    files
}

fn with_hashes(mode: AssetMode, files: HashMap<String, AssetSource>) -> UiAssets {
    let inline_script_hashes = files
        .get("/index.html")
        .and_then(|f| f.bytes())
        .map(|b| inline_script_hashes_of(&String::from_utf8_lossy(&b)))
        .unwrap_or_default();
    UiAssets { mode, files, inline_script_hashes }
}

/// `loadUiAssets`: embedded first, the source checkout's ui/dist second.
pub fn load_ui_assets() -> Option<UiAssets> {
    if !UI_ASSETS.is_empty() {
        let files: HashMap<String, AssetSource> = UI_ASSETS.iter().map(|(k, v)| (k.to_string(), AssetSource::Embedded(*v))).collect();
        return Some(with_hashes(AssetMode::Embedded, files));
    }
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("ui").join("dist");
    let files = map_dist_dir(&dist);
    if files.contains_key("/index.html") {
        return Some(with_hashes(AssetMode::Disk, files));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_hashes_skip_src_and_empty() {
        let html = "<script>var a=1</script><script src=\"/x.js\"></script><SCRIPT type=module> </SCRIPT>";
        let h = inline_script_hashes_of(html);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0], format!("'sha256-{}'", crate::crypto::base64(&crate::crypto::sha256(b"var a=1"))));
    }
}
