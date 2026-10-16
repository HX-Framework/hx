//! The light tail parser behind the commit metadata (src/parse.ts).

use crate::js::{js, lossy, slice, trim, JsStr};
use crate::json::Json;

const MAX_BODY: usize = 4000;

/// `detach`: a UTF-8 round trip, which also turns a lone surrogate into U+FFFD.
fn detach(s: &[u16]) -> JsStr {
    js(&lossy(s))
}

fn body_text(text: &[u16]) -> JsStr {
    let t = trim(text);
    if t.len() > MAX_BODY {
        let mut cut: JsStr = slice(t, 0, MAX_BODY).to_vec();
        cut.extend(js("\n\n…"));
        detach(&cut)
    } else {
        detach(t)
    }
}

fn extract_text(content: Option<&Json>, prefer_types: &[&str]) -> JsStr {
    let content = match content {
        Some(c) => c,
        None => return Vec::new(),
    };
    if !content.truthy() {
        return Vec::new();
    }
    if let Json::Str(s) = content {
        return s.clone();
    }
    let arr = match content.as_arr() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut parts: Vec<JsStr> = Vec::new();
    for b in arr {
        if b.as_obj().is_none() {
            continue;
        }
        let kind = b.get("type").map(|t| lossy(&t.to_js_string())).unwrap_or_default();
        if !prefer_types.contains(&kind.as_str()) {
            continue;
        }
        if let Some(text) = b.get("text") {
            if text.truthy() {
                parts.push(text.to_js_string());
            }
        }
    }
    let mut out: JsStr = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.extend(js("\n\n"));
        }
        out.extend_from_slice(p);
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct ChunkSummary {
    pub event_count: u64,
    pub user_text_count: u64,
    pub assistant_count: u64,
    pub first_user_text: Option<JsStr>,
    pub last_user_text: Option<JsStr>,
    pub last_assistant_text: Option<JsStr>,
    pub last_activity_at: Option<JsStr>,
    pub title: Option<JsStr>,
    /// "user" | "ai"
    pub title_source: Option<&'static str>,
}

pub fn summarise_chunk(text: &str) -> ChunkSummary {
    let mut out = ChunkSummary::default();
    let mut custom_title: Option<JsStr> = None;
    let mut ai_title: Option<JsStr> = None;
    for raw in text.split('\n') {
        if raw.is_empty() {
            continue;
        }
        let d = match Json::parse(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        out.event_count += 1;
        let kind = d.get("type").map(|t| lossy(&t.to_js_string())).unwrap_or_default();
        let kind_is = |k: &str| d.get("type").map(|t| matches!(t, Json::Str(s) if lossy(s) == k)).unwrap_or(false);
        if kind_is("custom-title") {
            if let Some(Json::Str(s)) = d.get("customTitle") {
                if !trim(s).is_empty() {
                    custom_title = Some(trim(s).to_vec());
                }
            }
        } else if kind_is("ai-title") {
            if let Some(Json::Str(s)) = d.get("aiTitle") {
                if !trim(s).is_empty() {
                    ai_title = Some(trim(s).to_vec());
                }
            }
        }
        let mut ts: Option<JsStr> = None;
        if let Some(Json::Str(s)) = d.get("timestamp") {
            ts = Some(s.clone());
        } else if let Some(Json::Str(s)) = d.get("message").and_then(|m| m.get("timestamp")) {
            ts = Some(s.clone());
        }
        if let Some(t) = ts {
            out.last_activity_at = Some(t);
        }
        let message = d.get("message");
        let message_content = message.filter(|m| m.as_obj().is_some()).and_then(|m| m.get("content"));
        if kind == "user" {
            out.user_text_count += 1;
            let txt = extract_text(message_content, &["text"]);
            if !txt.is_empty() {
                let body = body_text(&txt);
                if out.first_user_text.is_none() {
                    out.first_user_text = Some(body.clone());
                }
                out.last_user_text = Some(body);
            }
        } else if kind == "assistant" {
            out.assistant_count += 1;
            let txt = extract_text(message_content, &["text"]);
            if !txt.is_empty() {
                out.last_assistant_text = Some(body_text(&txt));
            }
        } else if kind == "event_msg" {
            if let Some(p) = d.get("payload").filter(|p| p.truthy()) {
                let ptype = p.get_string("type").unwrap_or_default();
                let message = p.get("message").filter(|m| m.truthy());
                if ptype == "user_message" {
                    if let Some(m) = message {
                        out.user_text_count += 1;
                        let body = body_text(&m.to_js_string());
                        if out.first_user_text.is_none() {
                            out.first_user_text = Some(body.clone());
                        }
                        out.last_user_text = Some(body);
                    }
                } else if ptype == "agent_message" {
                    if let Some(m) = message {
                        out.assistant_count += 1;
                        out.last_assistant_text = Some(body_text(&m.to_js_string()));
                    }
                }
            }
        } else if kind == "response_item" {
            if let Some(p) = d.get("payload").filter(|p| p.truthy()) {
                let ptype = p.get_string("type").unwrap_or_default();
                let role = p.get_string("role").unwrap_or_default();
                if ptype == "message" && role == "user" {
                    let txt = extract_text(p.get("content"), &["input_text", "text"]);
                    if !txt.is_empty() {
                        out.user_text_count += 1;
                        let body = body_text(&txt);
                        if out.first_user_text.is_none() {
                            out.first_user_text = Some(body.clone());
                        }
                        out.last_user_text = Some(body);
                    }
                } else if ptype == "message" && role == "assistant" {
                    let txt = extract_text(p.get("content"), &["output_text", "text"]);
                    if !txt.is_empty() {
                        out.assistant_count += 1;
                        out.last_assistant_text = Some(body_text(&txt));
                    }
                }
            }
        }
    }
    if let Some(t) = custom_title {
        out.title = Some(t);
        out.title_source = Some("user");
    } else if let Some(t) = ai_title {
        out.title = Some(t);
        out.title_source = Some("ai");
    }
    out
}

/// `findPlanPathInText`: the last plan_mode / plan_mode_exit attachment's path.
pub fn find_plan_path_in_text(text: &str) -> Option<String> {
    let mut plan: Option<String> = None;
    for line in text.split('\n') {
        if line.is_empty() || !line.contains("plan_mode") {
            continue;
        }
        let d = match Json::parse(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if d.get_string("type").as_deref() != Some("attachment") {
            continue;
        }
        let a = match d.get("attachment").filter(|a| a.truthy()) {
            Some(a) => a,
            None => continue,
        };
        let kind = a.get_string("type").unwrap_or_default();
        if kind != "plan_mode" && kind != "plan_mode_exit" {
            continue;
        }
        if let Some(p) = a.get_string("planFilePath") {
            if !p.is_empty() {
                plan = Some(p);
            }
        }
    }
    plan
}
