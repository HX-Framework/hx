// Source-path discovery + family classification.
//
// A fixed watch SHAPE over a configurable set of data roots (see roots.ts —
// default ~/.claude / ~/.codex plus any CLAUDE_CONFIG_DIR / CODEX_HOME style
// roots from settings or this process's env). Per root, the exact paths hx
// mirrors:
//
//   <claudeRoot>/projects/<encoded-cwd>/<session-id>.jsonl
//     → Claude Code Desktop OR Claude Code CLI; family is decided by the
//       `entrypoint` field on the first event we can read.
//
//   <codexRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-<iso>-<uuid>.jsonl
//     → Codex Desktop OR Codex CLI; family decided by the `originator`
//       field on the `session_meta` event at the head of the file.
//
//   <codexRoot>/archived_sessions/...   (same shape, included if recent)
//
// We intentionally do not scrape `<claudeRoot>/sessions/*.json` (the live PID
// tracker) — it's transient liveness state, not the transcript itself.

import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  claudeProjectsDir,
  codexArchivedDir,
  codexSessionsDir,
  type DataRoot,
  type ResolvedRoots,
} from "./roots.js";

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded fan-out for the discovery stat() storm. The watch loop sweeps these
// dirs every FAST_POLL_MS (1.5s); statting ~100k recent files one-await-at-a-
// time took ~7s/sweep — above the poll interval, so the daemon never idled and
// burned a full core sweeping back-to-back. Batching to a bounded pool brings a
// sweep back under a second. Bounded (not an unbounded Promise.all over every
// path) so a pathological dir can't open tens of thousands of FDs at once.
const STAT_CONCURRENCY = 64;

/**
 * Run `fn` over `items` with at most `limit` in flight at a time. Results are
 * collected by side effect inside `fn` (callers push into a shared array), so
 * the return is void; ordering is not preserved.
 */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i]!);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}

export type Family =
  | "claude-desktop"
  | "claude-cli"
  | "codex-desktop"
  | "codex-cli"
  | "unknown";

export interface DiscoveredFile {
  path: string;
  size: number;
  mtimeMs: number;
  source: "claude" | "codex";
  /** The config-dir root this file was discovered under (see roots.ts). */
  rootDir: string;
}

/** All recent Claude-projects jsonls across the given roots. `maxAgeMs`
 *  overrides the 30-day window — the attribution sweep passes Infinity so
 *  already-uploaded sessions older than the live-ingest window (bounded only
 *  by on-disk retention, ~8 weeks) can still be re-attributed; the watch
 *  loop's cadence keeps the default. */
export async function discoverClaudeFiles(
  roots: DataRoot[],
  { maxAgeMs = RECENT_WINDOW_MS }: { maxAgeMs?: number } = {},
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const now = Date.now();
  // Gather candidate jsonl paths across all recent project dirs first (the
  // dir-level mtime prune skips >30-day dirs before we ever read their files),
  // then batch the per-file stats — that sequential stat loop was the daemon's
  // hot path. The project-dir reads are themselves pooled so a machine with
  // thousands of project dirs doesn't serialize the readdirs either. One
  // candidate pool spans every root, so extra roots share the same bound.
  const candidates: Array<{ path: string; rootDir: string }> = [];
  for (const root of roots) {
    let projects: string[];
    try {
      projects = await readdir(claudeProjectsDir(root.configDir));
    } catch {
      continue; // no projects/ under this root (yet) — nothing to sweep
    }
    await mapPool(projects, STAT_CONCURRENCY, async (dir) => {
      if (dir.startsWith(".") || dir === "memory") return;
      const full = path.join(claudeProjectsDir(root.configDir), dir);
      const dirStat = await statSafe(full);
      if (!dirStat?.isDir || now - dirStat.mtimeMs > maxAgeMs) return;
      for (const f of await readdirSafe(full)) {
        if (f.endsWith(".jsonl")) {
          candidates.push({ path: path.join(full, f), rootDir: root.configDir });
        }
      }
    });
  }
  await mapPool(candidates, STAT_CONCURRENCY, async (c) => {
    const st = await statSafe(c.path);
    if (!st || st.isDir || st.size === 0) return;
    if (now - st.mtimeMs > maxAgeMs) return;
    out.push({ path: c.path, size: st.size, mtimeMs: st.mtimeMs, source: "claude", rootDir: c.rootDir });
  });
  return out;
}

// ── Child execution lanes (subagents + workflow agents) ─────────────────────
//
// Claude Code persists every child agent's transcript as its own jsonl under a
// per-session artifact directory:
//
//   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl
//   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.meta.json
//   ~/.claude/projects/<slug>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl (+ .meta.json)
//   ~/.claude/projects/<slug>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
//   ~/.claude/projects/<slug>/<sessionId>/workflows/scripts/<name>-<runId>.js
//
// CRITICAL: the artifact dir follows the session's CURRENT cwd, while the main
// jsonl stays under the slug of the cwd at session START — after EnterWorktree
// they live under DIFFERENT slugs. So children are discovered by scanning every
// project dir for session-id subdirectories, never by looking "next to" the
// parent jsonl.

export interface DiscoveredChildFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** The parent Claude session id (the <sessionId>/ dir the child lives under). */
  parentSessionId: string;
  agentId: string;
  /** Workflow run id when the child lives under subagents/workflows/<runId>/. */
  runId: string | null;
  /** Sibling agent-<agentId>.meta.json path, if present. */
  metaPath: string | null;
  /** The config-dir root this child was discovered under. */
  rootDir: string;
}

export interface DiscoveredWorkflowRun {
  parentSessionId: string;
  runId: string;
  journalPath: string | null;
  /** Newest mtime across journal + script — drives the hash-gate re-read. */
  mtimeMs: number;
  scriptPath: string | null;
  /** The workflow's meta.name, recovered from the script filename. */
  scriptName: string | null;
}

const AGENT_FILE_RE = /^agent-([a-zA-Z0-9_-]+)\.jsonl$/;
const SCRIPT_FILE_RE = /^(.+)-(wf_[a-zA-Z0-9-]+)\.js$/;

async function statSafe(p: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
  try {
    const st = await stat(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

async function readdirSafe(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

/** Collect agent-*.jsonl files in one directory into `out`. */
async function collectAgentFiles(
  dir: string,
  parentSessionId: string,
  runId: string | null,
  now: number,
  rootDir: string,
  out: DiscoveredChildFile[],
): Promise<void> {
  for (const f of await readdirSafe(dir)) {
    const m = AGENT_FILE_RE.exec(f);
    if (!m) continue;
    const p = path.join(dir, f);
    const st = await statSafe(p);
    if (!st || st.isDir || st.size === 0) continue;
    if (now - st.mtimeMs > RECENT_WINDOW_MS) continue;
    const metaPath = path.join(dir, `agent-${m[1]}.meta.json`);
    out.push({
      path: p,
      size: st.size,
      mtimeMs: st.mtimeMs,
      parentSessionId,
      agentId: m[1]!,
      runId,
      metaPath: (await statSafe(metaPath)) ? metaPath : null,
      rootDir,
    });
  }
}

/**
 * All recent child-lane transcripts + workflow runs across every project dir.
 * Scans only session-id SUBDIRECTORIES (rare next to the flat jsonl files), so
 * the added cost over discoverClaudeFiles is a few readdirs per active session.
 */
export async function discoverClaudeChildren(roots: DataRoot[]): Promise<{
  children: DiscoveredChildFile[];
  runs: DiscoveredWorkflowRun[];
}> {
  const children: DiscoveredChildFile[] = [];
  const runs: DiscoveredWorkflowRun[] = [];
  const now = Date.now();
  for (const root of roots) {
  for (const dir of await readdirSafe(claudeProjectsDir(root.configDir))) {
    if (dir.startsWith(".") || dir === "memory") continue;
    const projectDir = path.join(claudeProjectsDir(root.configDir), dir);
    const pst = await statSafe(projectDir);
    if (!pst?.isDir || now - pst.mtimeMs > RECENT_WINDOW_MS) continue;
    for (const entry of await readdirSafe(projectDir)) {
      if (entry.endsWith(".jsonl") || entry.startsWith(".")) continue;
      const sessionDir = path.join(projectDir, entry);
      const sst = await statSafe(sessionDir);
      if (!sst?.isDir) continue;
      const sessionId = entry;

      // Interactive subagents.
      const subagentsDir = path.join(sessionDir, "subagents");
      await collectAgentFiles(subagentsDir, sessionId, null, now, root.configDir, children);

      // Workflow runs: per-run agent transcripts + journal.
      const wfRoot = path.join(subagentsDir, "workflows");
      for (const runId of await readdirSafe(wfRoot)) {
        const runDir = path.join(wfRoot, runId);
        const rst = await statSafe(runDir);
        if (!rst?.isDir) continue;
        await collectAgentFiles(runDir, sessionId, runId, now, root.configDir, children);
        const journalPath = path.join(runDir, "journal.jsonl");
        const jst = await statSafe(journalPath);
        // One session can appear under SEVERAL project dirs (the cwd changed
        // mid-session — e.g. into a worktree) — and, with multiple data roots,
        // under several ROOTS — splitting a run's artifacts: journal under one
        // project dir, script under another. Merge into any entry the script
        // scan already created instead of pushing a twin — two entries share
        // the upload key (sessionId+runId) and alternating content hashes
        // re-upload the sidecar every pass, forever. `runs` spans all roots,
        // so the merge covers the cross-root split for free.
        const existing = runs.find(
          (r) => r.parentSessionId === sessionId && r.runId === runId,
        );
        if (existing) {
          // Only fill a MISSING journal — don't clobber a journal already found
          // under another project dir (a run split across dirs can have a
          // journal in each; keep the first and let mtime track the newest).
          if (jst && !jst.isDir) {
            if (!existing.journalPath) existing.journalPath = journalPath;
            existing.mtimeMs = Math.max(existing.mtimeMs, jst.mtimeMs);
          }
          continue;
        }
        runs.push({
          parentSessionId: sessionId,
          runId,
          journalPath: jst && !jst.isDir ? journalPath : null,
          mtimeMs: jst?.mtimeMs ?? rst.mtimeMs,
          scriptPath: null,
          scriptName: null,
        });
      }

      // Persisted workflow scripts (<name>-<runId>.js) — attach to their run,
      // or surface as a script-only run if the run dir hasn't appeared yet.
      const scriptsDir = path.join(sessionDir, "workflows", "scripts");
      for (const f of await readdirSafe(scriptsDir)) {
        const m = SCRIPT_FILE_RE.exec(f);
        if (!m) continue;
        const scriptPath = path.join(scriptsDir, f);
        const sstat = await statSafe(scriptPath);
        if (!sstat || sstat.isDir) continue;
        const existing = runs.find(
          (r) => r.parentSessionId === sessionId && r.runId === m[2],
        );
        if (existing) {
          existing.scriptPath = scriptPath;
          existing.scriptName = m[1]!;
          existing.mtimeMs = Math.max(existing.mtimeMs, sstat.mtimeMs);
        } else {
          runs.push({
            parentSessionId: sessionId,
            runId: m[2]!,
            journalPath: null,
            mtimeMs: sstat.mtimeMs,
            scriptPath,
            scriptName: m[1]!,
          });
        }
      }
    }
  }
  }
  return { children, runs };
}

/** All recent Codex rollout jsonls (sessions + archived) across the roots.
 *  `maxAgeMs` overrides the 30-day window (see {@link discoverClaudeFiles}). */
export async function discoverCodexFiles(
  roots: DataRoot[],
  { includeArchived = true, maxAgeMs = RECENT_WINDOW_MS }: {
    includeArchived?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const now = Date.now();
  // Collect candidate rollout paths during the walk, then batch the per-file
  // stats once (same hot-loop fix as the Claude sweep).
  const candidates: Array<{ path: string; rootDir: string }> = [];
  async function walk(dir: string, rootDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        subdirs.push(full);
      } else if (
        e.isFile() &&
        e.name.startsWith("rollout-") &&
        e.name.endsWith(".jsonl")
      ) {
        candidates.push({ path: full, rootDir });
      }
    }
    // Dir-level mtime prune: the Codex tree is sessions/<YYYY>/<MM>/<DD>/, and a
    // date-dir whose mtime is older than the recent window can't hold anything
    // recent — skip recursing it instead of walking every archived day forever.
    // Mirrors the >30-day project-dir skip discoverClaudeFiles already does.
    await mapPool(subdirs, STAT_CONCURRENCY, async (d) => {
      const st = await statSafe(d);
      if (!st?.isDir || now - st.mtimeMs > maxAgeMs) return;
      await walk(d, rootDir);
    });
  }
  for (const root of roots) {
    await walk(codexSessionsDir(root.configDir), root.configDir);
    if (includeArchived) await walk(codexArchivedDir(root.configDir), root.configDir);
  }
  await mapPool(candidates, STAT_CONCURRENCY, async (c) => {
    const st = await statSafe(c.path);
    if (!st || st.isDir || st.size === 0) return;
    if (now - st.mtimeMs > maxAgeMs) return;
    out.push({ path: c.path, size: st.size, mtimeMs: st.mtimeMs, source: "codex", rootDir: c.rootDir });
  });
  return out;
}

export async function discoverAll(roots: ResolvedRoots): Promise<DiscoveredFile[]> {
  const [a, b] = await Promise.all([
    discoverClaudeFiles(roots.claude),
    discoverCodexFiles(roots.codex),
  ]);
  return [...a, ...b];
}

/**
 * Read the head of a jsonl to extract session id + family + light metadata.
 * Caps at the first 64 lines — enough to see the meta event.
 */
export interface HeadMeta {
  sessionId: string | null;
  family: Family;
  cwd: string | null;
  gitBranch: string | null;
  /** Canonical lowercase `owner/name` GitHub slug for cwd's repo, or null. */
  repoSlug: string | null;
  entrypoint: string | null;
  originator: string | null;
  modelProvider: string | null;
  title: string | null;
}

export async function readHead(
  filePath: string,
  source: "claude" | "codex",
  opts: { resolveRepoFromDisk?: boolean } = {},
): Promise<HeadMeta> {
  const out: HeadMeta = {
    sessionId: null,
    family: "unknown",
    cwd: null,
    gitBranch: null,
    repoSlug: null,
    entrypoint: null,
    originator: null,
    modelProvider: null,
    title: null,
  };
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      n += 1;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (source === "claude") {
        if (typeof d.sessionId === "string" && !out.sessionId) out.sessionId = d.sessionId;
        if (typeof d.cwd === "string" && !out.cwd) out.cwd = d.cwd;
        if (typeof d.gitBranch === "string") out.gitBranch = d.gitBranch;
        if (typeof d.entrypoint === "string" && !out.entrypoint) {
          out.entrypoint = d.entrypoint;
        }
      } else {
        if (d.type === "session_meta" && d.payload && typeof d.payload === "object") {
          const p = d.payload as Record<string, unknown>;
          if (typeof p.cwd === "string") out.cwd = p.cwd;
          if (typeof p.originator === "string") out.originator = p.originator;
          if (typeof p.model_provider === "string") out.modelProvider = p.model_provider;
          if (typeof p.id === "string" && !out.sessionId) out.sessionId = p.id;
        }
        if (d.type === "thread_meta" && d.payload && typeof d.payload === "object") {
          const p = d.payload as Record<string, unknown>;
          if (typeof p.title === "string") out.title = p.title;
        }
      }
      if (n >= 64) break;
    }
  } finally {
    stream.destroy();
  }

  // Family classification.
  if (source === "claude") {
    if (out.entrypoint === "claude-desktop") out.family = "claude-desktop";
    else if (out.entrypoint === "cli" || out.entrypoint === "claude-code-vscode")
      out.family = "claude-cli";
    else if (!out.entrypoint) out.family = "claude-cli";
    else out.family = out.entrypoint.includes("desktop") ? "claude-desktop" : "claude-cli";
  } else {
    const origin = (out.originator ?? "").toLowerCase();
    if (origin.includes("desktop")) out.family = "codex-desktop";
    else if (origin.includes("cli")) out.family = "codex-cli";
    else out.family = "codex-cli";
  }

  if (!out.sessionId) {
    // Fall back to filename stem (Claude jsonl names ARE the sessionId; Codex
    // jsonl names end in the v7 uuid).
    const stem = path.basename(filePath, ".jsonl");
    if (source === "codex") {
      const parts = stem.split("-");
      if (parts.length >= 6) out.sessionId = parts.slice(-5).join("-");
      else out.sessionId = stem;
    } else {
      out.sessionId = stem;
    }
  }

  // Derive the GitHub repo from the session's cwd by walking up to `.git` on
  // disk (the ONLY step here that touches the real working directory), falling
  // back to the encoded-workdir-name parse — which still works after an
  // ephemeral workdir (pool scratch dirs, GC'd at job end) is gone, and never
  // touches the filesystem at all. The daemon needs the slug to route uploads
  // and persists it to state.json; the UI passes resolveRepoFromDisk:false and
  // reads that cached slug instead. Re-walking from the UI would re-enter the
  // user's project folders — some under macOS-protected roots
  // (Documents/Desktop/Downloads) — and fire a redundant TCC prompt for a
  // value the daemon has already resolved.
  if (out.cwd) {
    out.repoSlug =
      (opts.resolveRepoFromDisk !== false ? await detectRepoSlug(out.cwd) : null) ??
      repoSlugFromEncodedCwd(out.cwd);
  }

  return out;
}

/**
 * Normalize a git remote URL to a canonical lowercase `owner/name` GitHub slug.
 * Handles ssh (`git@github.com:owner/name.git`), https
 * (`https://github.com/owner/name(.git)`) and `ssh://` forms. Returns null for
 * non-GitHub remotes — those sessions stay Uncategorized.
 */
export function normalizeGithubSlug(url: string): string | null {
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const name = m[2].replace(/\.git$/i, "").toLowerCase();
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

async function readOriginSlug(configPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  // Walk the ini-ish git config across EVERY [remote "…"] section. `origin`
  // wins when it resolves to GitHub; otherwise the first GitHub remote does —
  // a fork whose canonical remote is `upstream`, or a clone whose only remote
  // has another name, still attributes (they used to fall out as null).
  let currentRemote: string | null = null;
  let originSlug: string | null = null;
  let firstSlug: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const m = /^remote\s+"(.+)"$/i.exec(sec[1].trim());
      currentRemote = m ? m[1] : null;
      continue;
    }
    if (currentRemote) {
      const u = /^url\s*=\s*(.+)$/i.exec(line);
      if (u) {
        const slug = normalizeGithubSlug(u[1]);
        if (slug) {
          if (/^origin$/i.test(currentRemote)) originSlug ??= slug;
          firstSlug ??= slug;
        }
      }
    }
  }
  return originSlug ?? firstSlug;
}

/**
 * Repo slug from an ENCODED path segment — the durable-attribution convention
 * for ephemeral workdirs: a spawner that clones a repo into a throwaway dir
 * names it `<prefix>@<owner>@<name>@<rand>` (the forge pool does, via
 * mkdtemp), so the transcript's cwd itself carries the repo after the dir —
 * and its .git — are long gone. `@` is not a legal character in GitHub
 * owner/repo names, and the trailing part must be EXACTLY mkdtemp's 6 random
 * alphanumerics — both constraints exist to keep an ordinary directory that
 * happens to contain `@`s (an email-ish name, an npm-scope mirror) from
 * parsing as a slug: a false positive doesn't just mislabel the session, it
 * BLOCKS server-side rule repair (a stored slug wins over rules). Deepest
 * matching segment wins (closest to the actual workdir).
 */
export function repoSlugFromEncodedCwd(cwd: string): string | null {
  const segments = cwd.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const m = /^[^@]+@([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)@[A-Za-z0-9]{6}$/.exec(
      segments[i] ?? "",
    );
    if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  }
  return null;
}

/**
 * From a session's cwd, walk up to the nearest `.git`, read its config, and
 * return the origin remote's canonical `owner/name` slug. `.git` may be a dir
 * (normal clone) or a file (`gitdir: …`, for linked worktrees/submodules), in
 * which case the config lives in the common dir. Returns null when there's no
 * git, no origin, or a non-GitHub remote.
 */
export async function detectRepoSlug(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 40; i += 1) {
    const gitPath = path.join(dir, ".git");
    // Read `.git` directly rather than stat-then-read (a TOCTOU race + an extra
    // syscall). It's a regular file for linked worktrees/submodules (a
    // `gitdir: …` pointer) and a directory for a normal clone — which surfaces
    // as EISDIR from readFile.
    let pointer: string | null;
    try {
      pointer = await readFile(gitPath, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "EISDIR") {
        // Normal clone: config lives directly inside the .git directory.
        return readOriginSlug(path.join(gitPath, "config"));
      }
      // No .git here (ENOENT) or it's unreadable — walk up to the parent.
      pointer = null;
    }
    if (pointer !== null) {
      // `.git` file points at the real gitdir; config may live in commondir.
      const m = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (m) {
        const target = m[1].trim();
        const gitdir = path.isAbsolute(target) ? target : path.resolve(dir, target);
        let configPath = path.join(gitdir, "config");
        try {
          await stat(configPath);
        } catch {
          try {
            const common = (
              await readFile(path.join(gitdir, "commondir"), "utf8")
            ).trim();
            configPath = path.join(path.resolve(gitdir, common), "config");
          } catch {
            /* keep the direct path; readOriginSlug will null out if missing */
          }
        }
        return readOriginSlug(configPath);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
