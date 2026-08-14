// Inspector preview: the last few conversational turns of a session file,
// rendered as the same Me/Agent/Tool lines the transcript uploads as. Reads
// a bounded tail (64 KB) of the jsonl — never the whole file.

import { open } from "node:fs/promises";

export type PreviewRole = "Me" | "Agent" | "Tool";
export interface PreviewLine {
  role: PreviewRole;
  text: string;
}

const TAIL_BYTES = 64 * 1024;
const MAX_LINES = 12;
const MAX_TEXT = 220;

const clip = (s: string): string => {
  const t = s.replaceAll(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

interface ClaudeContentPart {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** Pure jsonl-tail → preview-lines extractor — unit-tested. */
export function extractPreviewLines(rawLines: string[]): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Claude Code events: { type: "user"|"assistant", message: { content } }
    const type = obj.type;
    const message = obj.message as { content?: unknown; role?: string } | undefined;
    if ((type === "user" || type === "assistant") && message?.content !== undefined) {
      const role: PreviewRole = type === "user" ? "Me" : "Agent";
      const content = message.content;
      if (typeof content === "string") {
        if (content.trim()) out.push({ role, text: clip(content) });
        continue;
      }
      if (Array.isArray(content)) {
        for (const part of content as ClaudeContentPart[]) {
          if (part.type === "text" && part.text?.trim()) {
            out.push({ role, text: clip(part.text) });
          } else if (part.type === "tool_use" && part.name) {
            out.push({ role: "Tool", text: clip(part.name) });
          }
        }
      }
      continue;
    }

    // Codex rollout items: { type: "response_item", payload: { type, role, content } }
    const payload = obj.payload as
      | { type?: string; role?: string; content?: unknown; name?: string }
      | undefined;
    if (obj.type === "response_item" && payload) {
      if (payload.type === "message" && Array.isArray(payload.content)) {
        const role: PreviewRole = payload.role === "user" ? "Me" : "Agent";
        for (const part of payload.content as ClaudeContentPart[]) {
          if (typeof part.text === "string" && part.text.trim()) {
            out.push({ role, text: clip(part.text) });
          }
        }
      } else if (payload.type === "function_call" && payload.name) {
        out.push({ role: "Tool", text: clip(payload.name) });
      }
    }
  }
  return out.slice(-MAX_LINES);
}

const TITLE_MAX = 64;

/** First user message from a jsonl HEAD, clipped to a title — unit-tested.
 *  Skips harness-injected user events (tag-/caveat-shaped), which aren't
 *  something the person typed. */
export function extractTitleFallback(rawLines: string[]): string | null {
  const lines = extractPreviewLines(rawLines);
  const me = lines.find(
    (l) => l.role === "Me" && !l.text.startsWith("<") && !l.text.startsWith("Caveat:"),
  );
  if (!me) return null;
  const t = me.text;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

const HEAD_BYTES = 32 * 1024;

/** Read the first ~32 KB of a session file for title derivation. */
export async function readHeadLines(filePath: string): Promise<string[]> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths
    // come from the discovery scan, never from request input.
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      const text = buf.subarray(0, bytesRead).toString("utf-8");
      const lines = text.split("\n");
      if (bytesRead === HEAD_BYTES) lines.pop(); // last line may be torn
      return lines;
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

export async function previewSessionFile(filePath: string): Promise<PreviewLine[]> {
  try {
    // Open first, size via fstat on the handle — no stat-then-open race.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the
    // route handler admits only paths present in the discovery scan.
    const fh = await open(filePath, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift(); // torn first line
      return extractPreviewLines(lines);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}
