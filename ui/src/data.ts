// Static labels shared across views. All session/folder/destination DATA is
// live — fetched from the local hx ui server (see api.ts / store.tsx).

import type { DataRootInfo } from "./api";

export const TOOL_ORDER = ["Claude Code CLI", "Claude Code Desktop", "Codex CLI", "Codex Desktop"];
export const TOOL_NOTE: Record<string, string> = {
  "Claude Code CLI": "~/.claude/projects",
  "Codex CLI": "~/.codex/sessions",
};

/** TOOL_NOTE derived from the live watch roots — "~/.claude/projects" grows a
 *  "+ 1 more location" suffix when extra data roots are configured. Falls back
 *  to the static strings until the snapshot arrives. */
export function toolNotesFor(dataRoots: DataRootInfo[]): Record<string, string> {
  const note = (family: "claude" | "codex", sub: string, fallback: string): string => {
    const roots = dataRoots.filter((r) => r.family === family);
    if (roots.length === 0) return fallback;
    const first = `${roots[0].display}/${sub}`;
    return roots.length === 1 ? first : `${first} + ${roots.length - 1} more location${roots.length > 2 ? "s" : ""}`;
  };
  return {
    ...TOOL_NOTE,
    "Claude Code CLI": note("claude", "projects", TOOL_NOTE["Claude Code CLI"]),
    "Codex CLI": note("codex", "sessions", TOOL_NOTE["Codex CLI"]),
  };
}

export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many || one + "s")}`;
