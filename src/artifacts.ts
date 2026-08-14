// Reads the two local sidecar artifacts that live next to a Claude Code
// session but NOT inside its jsonl:
//   • tasks — <claudeRoot>/tasks/<sessionId>/<n>.json  (one file per task)
//   • plan  — <claudeRoot>/plans/<slug>.md, referenced by a plan_mode /
//             plan_mode_exit attachment event inside the session jsonl (the
//             event carries the ABSOLUTE path, so plans need no root handling)
//
// Both are whole small files rewritten in place, so the watcher uploads them
// wholesale (hash-gated) rather than via the transcript's append/compose path.
// Tasks + teams are looked up across every watched Claude root (roots.ts);
// callers pass the derived tasks/teams dirs.

import { open, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export interface RawTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string | null;
  status: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown> | null;
}

export interface PlanArtifact {
  planFilePath: string;
  content: string;
}

export function hashContent(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/**
 * Read <tasksDir>/<sessionId>/*.json into a normalized task list, probing the
 * given tasks dirs IN ORDER and taking the first that exists. Order matters
 * when a copied tree left a frozen twin of the session's tasks under another
 * root — callers put the live transcript's own root first (see
 * orderTasksDirs in watch.ts) so the twin can't shadow the updating set.
 * Returns null when no root has a tasks dir for the session; [] when a dir
 * exists but is empty. Files are sorted by numeric id so they read in
 * creation order.
 */
export async function readTaskSet(
  sessionId: string,
  tasksDirs: string[],
): Promise<RawTask[] | null> {
  let dir: string | null = null;
  let entries: string[] = [];
  for (const tasksDir of tasksDirs) {
    const candidate = path.join(tasksDir, sessionId);
    try {
      const dstat = await stat(candidate);
      if (!dstat.isDirectory()) continue;
      entries = await readdir(candidate);
      dir = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (dir === null) return null;
  const jsonFiles = entries
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => {
      const an = parseInt(a, 10);
      const bn = parseInt(b, 10);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.localeCompare(b);
    });
  const tasks: RawTask[] = [];
  for (const f of jsonFiles) {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    tasks.push({
      id: String(d.id ?? f.replace(/\.json$/, "")),
      subject: typeof d.subject === "string" ? d.subject : "",
      description: typeof d.description === "string" ? d.description : "",
      activeForm: typeof d.activeForm === "string" ? d.activeForm : null,
      status: typeof d.status === "string" ? d.status : "pending",
      blocks: Array.isArray(d.blocks) ? d.blocks.map(String) : [],
      blockedBy: Array.isArray(d.blockedBy) ? d.blockedBy.map(String) : [],
      metadata: d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>) : null,
    });
  }
  return tasks;
}

/**
 * Scan a block of jsonl text for the LAST plan_mode / plan_mode_exit
 * attachment and return the referenced plan file path. Cheap quick-reject so
 * we only JSON.parse candidate lines. Used on each fresh chunk by the watcher.
 */
export function findPlanPathInText(text: string): string | null {
  let planFilePath: string | null = null;
  for (const line of text.split("\n")) {
    if (!line || !line.includes("plan_mode")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.type !== "attachment") continue;
    const a = d.attachment as Record<string, unknown> | undefined;
    if (!a) continue;
    if (a.type !== "plan_mode" && a.type !== "plan_mode_exit") continue;
    if (typeof a.planFilePath === "string" && a.planFilePath) planFilePath = a.planFilePath;
  }
  return planFilePath;
}

/** Read a plan markdown file off disk, or null if it's gone. */
export async function readPlanFile(planFilePath: string): Promise<PlanArtifact | null> {
  try {
    // Read directly and let the catch handle the non-file cases (ENOENT, or
    // EISDIR when the path is a directory). A separate stat()-then-readFile
    // would be a TOCTOU race and a redundant syscall.
    const content = await readFile(planFilePath, "utf8");
    return { planFilePath, content };
  } catch {
    return null;
  }
}

/** Whole-file variant for backfill: scan an entire jsonl for the plan path. */
export async function readPlanForJsonl(jsonlPath: string): Promise<PlanArtifact | null> {
  let text: string;
  try {
    text = await readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const planFilePath = findPlanPathInText(text);
  if (!planFilePath) return null;
  return readPlanFile(planFilePath);
}

/** All session ids that have a <tasksDir>/<id>/ dir under any watched root —
 *  drives backfill. Union across roots, deduped. */
export async function listTaskSessionIds(tasksDirs: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const tasksDir of tasksDirs) {
    try {
      const entries = await readdir(tasksDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) ids.add(e.name);
      }
    } catch {
      continue;
    }
  }
  return [...ids];
}

// ── Child-lane meta sidecars + agent-team configs ───────────────────────────

/** agent-<id>.meta.json next to a child transcript. Two shapes observed:
 *  subagents carry {agentType, description, toolUseId}; workflow agents carry
 *  {agentType: "workflow-subagent", worktreePath}. All fields best-effort. */
export interface AgentMetaSidecar {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  worktreePath: string | null;
}

export async function readAgentMeta(metaPath: string | null): Promise<AgentMetaSidecar | null> {
  if (!metaPath) return null;
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return {
      agentType: typeof d.agentType === "string" ? d.agentType : null,
      description: typeof d.description === "string" ? d.description : null,
      toolUseId: typeof d.toolUseId === "string" ? d.toolUseId : null,
      worktreePath: typeof d.worktreePath === "string" ? d.worktreePath : null,
    };
  } catch {
    return null;
  }
}

/** Read a small text file, or null. Used for workflow scripts + journals. */
export async function readTextFile(p: string | null, maxBytes = 500_000): Promise<string | null> {
  if (!p) return null;
  // Open once and stat/read through the same handle so the size check and the
  // read operate on the same inode — a bare stat()-then-readFile is a TOCTOU
  // race. The maxBytes guard stays: we check size before reading the bytes.
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(p, "r");
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fh.readFile("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export interface TeamConfig {
  name: string;
  config: unknown;
}

/** <teamsDir>/<name>/config.json for every active team, unioned across the
 *  watched Claude roots (the dir exists only while a team runs — empty result
 *  is the steady state). A team name present under several roots keeps the
 *  newest config (by config.json mtime). Sorted by name so the mirror hash in
 *  watch.ts is deterministic regardless of readdir/root order. */
export async function readTeamConfigs(teamsDirs: string[]): Promise<TeamConfig[]> {
  const best = new Map<string, { config: unknown; mtimeMs: number }>();
  for (const teamsDir of teamsDirs) {
    let entries: string[];
    try {
      entries = await readdir(teamsDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const cfgPath = path.join(teamsDir, name, "config.json");
      const raw = await readTextFile(cfgPath);
      if (!raw) continue;
      let config: unknown;
      try {
        config = JSON.parse(raw);
      } catch {
        continue; /* unreadable config — skip the team */
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(cfgPath)).mtimeMs;
      } catch {
        /* stat raced the team teardown — keep 0, any twin wins */
      }
      const prev = best.get(name);
      if (!prev || mtimeMs > prev.mtimeMs) best.set(name, { config, mtimeMs });
    }
  }
  return [...best.entries()]
    .map(([name, v]) => ({ name, config: v.config }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
