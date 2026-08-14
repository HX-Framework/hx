// Light-weight tail parser. We don't need a full summary on each
// commit — just enough metadata to keep the gateway's sessions index
// useful for display:
//   - eventCount, userTextCount, assistantCount
//   - lastUserText / lastAssistantText (capped at 4KB each)
//   - lastActivityAt
//
// Parses only the bytes between (offset, EOF). Caller already has those
// bytes in memory from the upload path; we reuse them.

const MAX_BODY = 4000;

function bodyText(text: string): string {
  const t = text.trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n\n…` : t;
}

function extractText(
  content: unknown,
  preferTypes: string[],
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && typeof b === "object" && preferTypes.includes(String(b.type ?? "")) && b.text) {
      out.push(String(b.text));
    }
  }
  return out.join("\n\n");
}

export interface ChunkSummary {
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  /** First user message seen in this chunk — a stable label source. */
  firstUserText: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
  lastActivityAt: string | null;
  /** Best title found in this chunk (a CCD-renamed title beats an AI one). */
  title: string | null;
  titleSource: "user" | "ai" | null;
}

export function summariseChunk(text: string): ChunkSummary {
  const out: ChunkSummary = {
    eventCount: 0,
    userTextCount: 0,
    assistantCount: 0,
    firstUserText: null,
    lastUserText: null,
    lastAssistantText: null,
    lastActivityAt: null,
    title: null,
    titleSource: null,
  };
  // CCD writes the sidebar title into the jsonl as `custom-title` (user-set) and
  // `ai-title` (generated) events. A user title always wins over an AI one; the
  // latest of each kind wins. Resolved after the scan.
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    out.eventCount += 1;
    if (d.type === "custom-title" && typeof d.customTitle === "string" && d.customTitle.trim()) {
      customTitle = d.customTitle.trim();
    } else if (d.type === "ai-title" && typeof d.aiTitle === "string" && d.aiTitle.trim()) {
      aiTitle = d.aiTitle.trim();
    }
    let ts: string | null = null;
    if (typeof d.timestamp === "string") {
      ts = d.timestamp;
    } else if (
      d.message &&
      typeof (d.message as { timestamp?: unknown }).timestamp === "string"
    ) {
      ts = (d.message as { timestamp: string }).timestamp;
    }
    if (ts) out.lastActivityAt = ts;

    const type = String(d.type ?? "");
    if (type === "user") {
      out.userTextCount += 1;
      const msg = (d.message ?? {}) as { content?: unknown };
      const txt = extractText(msg.content, ["text"]);
      if (txt) {
        out.lastUserText = bodyText(txt);
        out.firstUserText ??= out.lastUserText;
      }
    } else if (type === "assistant") {
      out.assistantCount += 1;
      const msg = (d.message ?? {}) as { content?: unknown };
      const txt = extractText(msg.content, ["text"]);
      if (txt) out.lastAssistantText = bodyText(txt);
    } else if (type === "event_msg" && d.payload) {
      const p = d.payload as { type?: string; message?: string };
      if (p.type === "user_message" && p.message) {
        out.userTextCount += 1;
        out.lastUserText = bodyText(p.message);
        out.firstUserText ??= out.lastUserText;
      } else if (p.type === "agent_message" && p.message) {
        out.assistantCount += 1;
        out.lastAssistantText = bodyText(p.message);
      }
    } else if (type === "response_item" && d.payload) {
      const p = d.payload as { type?: string; role?: string; content?: unknown };
      if (p.type === "message" && p.role === "user") {
        const txt = extractText(p.content, ["input_text", "text"]);
        if (txt) {
          out.userTextCount += 1;
          out.lastUserText = bodyText(txt);
          out.firstUserText ??= out.lastUserText;
        }
      } else if (p.type === "message" && p.role === "assistant") {
        const txt = extractText(p.content, ["output_text", "text"]);
        if (txt) {
          out.assistantCount += 1;
          out.lastAssistantText = bodyText(txt);
        }
      }
    }
  }
  if (customTitle) {
    out.title = customTitle;
    out.titleSource = "user";
  } else if (aiTitle) {
    out.title = aiTitle;
    out.titleSource = "ai";
  }
  return out;
}
