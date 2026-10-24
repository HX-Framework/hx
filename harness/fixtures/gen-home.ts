// Generates a fixture HOME for one harness run: the files hx reads, shaped
// like a real machine, with none of a real machine's data.
//
//   bun harness/fixtures/gen-home.ts --out <home> --shape small|claude-like|synthetic-10k --seed <s>
//
// Everything is derived from the seed, so two runs produce byte-identical
// transcripts, sidecars, Codex and Claude Desktop files. Only mtimes depend
// on the clock: they are set relative to `now` (the moment of generation) so
// the client's 30-day window, its hot/warm/cold tiers and its 15-minute live
// window classify the files the same way whenever the run happens. Content
// never embeds `now`, so the bytes the gateway stores are the same in every
// run.
//
// What a shape contains (all three share the curated core; the two larger
// ones add generated bulk):
//   • Claude Code transcripts under .claude/projects/<encoded cwd>/<id>.jsonl —
//     CLI and desktop entrypoints, user/assistant/tool events, custom and AI
//     titles, a plan_mode_exit attachment, a cwd-change twin, a file older
//     than the window, a directory older than the window, an empty file, a
//     70 MB file (past the 64 MB per-pass budget), a 5 MiB single line (a
//     chunk cut with no newline), and texts with emoji, CJK, a lone surrogate
//     and a message past the 4,000-unit excerpt cap;
//   • subagent lanes with meta sidecars, a workflow run with journal + script;
//   • tasks, a plan, a team config;
//   • git repositories the cwds point at (a normal clone, a linked worktree,
//     a non-GitHub remote) and an encoded `@owner@name@xxxxxx` scratch cwd;
//   • Codex rollouts (CLI, desktop originator, an archived one) and a
//     state_5.sqlite with a user name, an AI title and a missing row;
//   • Claude Desktop session metadata files and a Local Storage leveldb with
//     a stale .log and an authoritative Snappy-compressed .ldb (grouping,
//     unread ids, a vestigial dframe-store) — or, with ccdLayout "scoped",
//     the store of current builds (writeScopedCcdStore).
//
// The manifest written beside the tree lists every session with its expected
// identity, plus what the group mirror must contain, so the harness can
// assert fixture-level facts and not only that two binaries agree.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Prng } from "../lib/prng.js";
import { buildLdb, buildLdbEntries, buildLog, buildLogBatches, localStorageKey, localStorageValue, type KeyValue } from "../lib/leveldb-writer.js";

export type Shape = "small" | "claude-like" | "synthetic-10k";

/** The layout of the Claude Desktop Local Storage store: "flat", the
 *  grouping fields of builds until 2026 (the default), or "scoped", the
 *  per-account store of current builds with its drawn sections. */
export type CcdLayout = "flat" | "scoped";

export interface GenOptions {
  out: string;
  shape: Shape;
  seed: string;
  /** Epoch ms the mtimes are relative to; defaults to Date.now(). */
  now?: number;
  ccdLayout?: CcdLayout;
}

export interface ManifestSession {
  family: string;
  sessionId: string;
  path: string;
  bytes: number;
  /** mtime as an offset from the manifest's `now`, in ms (negative = past). */
  mtimeOffsetMs: number;
  repoSlug: string | null;
  note?: string;
}

export interface ExpectedGroupMirror {
  groupingEnabled: boolean;
  groups: Array<{
    id: string;
    name: string;
    subtitle: string | null;
    sectionName: string | null;
    collapsed: boolean;
    sessionIds: string[];
    sortBy?: string | null;
    ascending?: boolean | null;
    shown?: boolean;
    showEmpty?: boolean;
  }>;
  unreadIds: string[];
  /** The scoped layouts: which one, CCD's session filter, the hashed account. */
  layout?: string;
  statusFilter?: string | null;
  scope?: string | null;
}

export interface Manifest {
  shape: Shape;
  seed: string;
  now: number;
  home: string;
  ccdLayout?: CcdLayout;
  sessions: ManifestSession[];
  /** Files written but expected to be ignored by discovery, with the reason. */
  ignored: Array<{ path: string; reason: string }>;
  expectations: {
    groupMirror: ExpectedGroupMirror;
    /** ccdLayout "scoped": the mirror once `ccdSwitch` is written. */
    groupMirrorAfterSwitch?: ExpectedGroupMirror;
    codexTitles: Record<string, { title: string; source: "user" | "ai" }>;
  };
  /** ccdLayout "scoped": the write that switches Claude Desktop to its second
   *  account, to append to `file` (relative to the home) during a run. */
  ccdSwitch?: { file: string; appendBase64: string };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed base for every timestamp INSIDE a file: content must not depend on
// the clock. Sessions get consecutive minutes from here.
const CONTENT_EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

interface Ctx {
  home: string;
  now: number;
  ccdLayout: CcdLayout;
  rng: Prng;
  manifest: Manifest;
  /** Paths whose mtime to set, applied after all writes (writes bump dirs). */
  mtimes: Array<{ path: string; offsetMs: number; kind: "file" | "dir" }>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function encodeCwd(cwd: string): string {
  // Claude Code names the project dir after the cwd with every separator
  // (and dot) replaced by "-".
  return cwd.replace(/[/\\.]/g, "-");
}

function write(ctx: Ctx, rel: string, content: string | Buffer, mtimeOffsetMs: number): string {
  const p = join(ctx.home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  ctx.mtimes.push({ path: p, offsetMs: mtimeOffsetMs, kind: "file" });
  return p;
}

function dirMtime(ctx: Ctx, rel: string, mtimeOffsetMs: number): void {
  const p = join(ctx.home, rel);
  mkdirSync(p, { recursive: true });
  ctx.mtimes.push({ path: p, offsetMs: mtimeOffsetMs, kind: "dir" });
}

// ── Claude Code transcript lines ────────────────────────────────────────────

interface ClaudeSessionSpec {
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
  entrypoint: "cli" | "claude-desktop";
  /** Approximate size of the transcript in bytes. */
  approxBytes: number;
  customTitle?: string;
  aiTitle?: string;
  planFilePath?: string;
  /** Text overrides for the curated edge cases. */
  userTexts?: string[];
  /** One line of this many bytes with no newline until the end. */
  singleLineBytes?: number;
  /** Seed for this session's own generator (content is per-session). */
  seed: string;
  /** The project directory's own mtime offset. */
  contentIndex: number;
}

function claudeEvent(spec: ClaudeSessionSpec, t: number, extra: Record<string, unknown>, uuid: string, parent: string | null): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    userType: "external",
    cwd: spec.cwd,
    sessionId: spec.sessionId,
    version: "2.1.0",
    ...(spec.gitBranch !== null ? { gitBranch: spec.gitBranch } : {}),
    entrypoint: spec.entrypoint,
    ...extra,
    uuid,
    timestamp: iso(t),
  });
}

function claudeTranscript(spec: ClaudeSessionSpec): string {
  const rng = new Prng(`claude:${spec.seed}`);
  const t0 = CONTENT_EPOCH + spec.contentIndex * 7 * MIN;
  const lines: string[] = [];
  let t = t0;
  let parent: string | null = null;
  let turn = 0;
  const userTexts = spec.userTexts ?? [];
  const push = (line: string): void => {
    lines.push(line);
  };
  const nextUuid = (): string => rng.uuid();

  if (spec.singleLineBytes) {
    // One event whose text fills the line past the chunk size.
    const u = nextUuid();
    const text = "x".repeat(spec.singleLineBytes);
    push(claudeEvent(spec, t, { type: "user", message: { role: "user", content: text } }, u, null));
    return `${lines.join("\n")}\n`;
  }

  let bytes = 0;
  while (bytes < spec.approxBytes) {
    const uUser = nextUuid();
    const text = userTexts[turn] ?? rng.paragraph(rng.int(40, 400));
    const userLine = claudeEvent(spec, t, { type: "user", message: { role: "user", content: text } }, uUser, parent);
    push(userLine);
    bytes += userLine.length + 1;
    t += rng.int(2, 40) * 1000;
    parent = uUser;
    const uAsst = nextUuid();
    const useTool = rng.float() < 0.5;
    const content: unknown[] = [{ type: "text", text: rng.paragraph(rng.int(60, 600)) }];
    if (useTool) content.push({ type: "tool_use", id: `toolu_${rng.alnum(20)}`, name: rng.pick(["Read", "Edit", "Bash", "Grep"]), input: { file_path: `${spec.cwd}/src/${rng.alnum(6)}.ts` } });
    const asstLine = claudeEvent(
      spec,
      t,
      {
        type: "assistant",
        message: {
          id: `msg_${rng.alnum(24)}`,
          type: "message",
          role: "assistant",
          model: "example-model",
          content,
          stop_reason: useTool ? "tool_use" : "end_turn",
          usage: { input_tokens: rng.int(100, 5000), output_tokens: rng.int(20, 800) },
        },
        requestId: `req_${rng.alnum(24)}`,
      },
      uAsst,
      parent,
    );
    push(asstLine);
    bytes += asstLine.length + 1;
    t += rng.int(2, 40) * 1000;
    parent = uAsst;
    if (useTool) {
      const uRes = nextUuid();
      const resLine = claudeEvent(
        spec,
        t,
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${rng.alnum(20)}`, content: rng.paragraph(rng.int(50, 1500)) }] },
          toolUseResult: { stdout: rng.sentence(6), stderr: "", interrupted: false },
        },
        uRes,
        parent,
      );
      push(resLine);
      bytes += resLine.length + 1;
      t += rng.int(1, 20) * 1000;
      parent = uRes;
    }
    if (turn === 0 && spec.customTitle) push(JSON.stringify({ type: "custom-title", customTitle: spec.customTitle, sessionId: spec.sessionId }));
    if (turn === 1 && spec.aiTitle) push(JSON.stringify({ type: "ai-title", aiTitle: spec.aiTitle, sessionId: spec.sessionId }));
    if (turn === 2 && spec.planFilePath) {
      push(JSON.stringify({ type: "attachment", attachment: { type: "plan_mode_exit", planFilePath: spec.planFilePath }, sessionId: spec.sessionId, timestamp: iso(t) }));
    }
    turn += 1;
  }
  push(JSON.stringify({ type: "summary", summary: rng.sentence(8), leafUuid: parent }));
  return `${lines.join("\n")}\n`;
}

function agentTranscript(seed: string, parentSessionId: string, cwd: string, approxBytes: number, contentIndex: number): string {
  const rng = new Prng(`agent:${seed}`);
  let t = CONTENT_EPOCH + contentIndex * 7 * MIN + 3 * MIN;
  const lines: string[] = [];
  let bytes = 0;
  let parent: string | null = null;
  while (bytes < approxBytes) {
    const u = rng.uuid();
    const line = JSON.stringify({
      parentUuid: parent,
      isSidechain: true,
      userType: "external",
      cwd,
      sessionId: parentSessionId,
      version: "2.1.0",
      gitBranch: "main",
      entrypoint: "cli",
      type: rng.float() < 0.5 ? "user" : "assistant",
      message: { role: "user", content: [{ type: "text", text: rng.paragraph(rng.int(40, 300)) }] },
      uuid: u,
      timestamp: iso(t),
    });
    lines.push(line);
    bytes += line.length + 1;
    t += rng.int(1, 30) * 1000;
    parent = u;
  }
  return `${lines.join("\n")}\n`;
}

// ── Codex rollouts ──────────────────────────────────────────────────────────

interface CodexSessionSpec {
  id: string;
  cwd: string;
  originator: string;
  archived: boolean;
  approxBytes: number;
  seed: string;
  contentIndex: number;
  /** Day of the session folder (YYYY/MM/DD) and the file stamp. */
  day: { y: number; m: number; d: number };
}

function codexRollout(spec: CodexSessionSpec): { name: string; content: string } {
  const rng = new Prng(`codex:${spec.seed}`);
  let t = CONTENT_EPOCH + spec.contentIndex * 11 * MIN;
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      timestamp: iso(t),
      type: "session_meta",
      payload: {
        id: spec.id,
        timestamp: iso(t),
        cwd: spec.cwd,
        originator: spec.originator,
        cli_version: "0.40.0",
        instructions: null,
        git: { commit_hash: rng.alnum(40), branch: "main", repository_url: "git@github.com:acme/repo.git" },
        model_provider: "openai",
      },
    }),
  );
  let bytes = 0;
  while (bytes < spec.approxBytes) {
    const user = rng.paragraph(rng.int(30, 300));
    const l1 = JSON.stringify({ timestamp: iso(t), type: "event_msg", payload: { type: "user_message", message: user } });
    const l2 = JSON.stringify({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } });
    t += rng.int(2, 30) * 1000;
    const asst = rng.paragraph(rng.int(60, 500));
    const l3 = JSON.stringify({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: asst }] } });
    const l4 = JSON.stringify({ timestamp: iso(t), type: "event_msg", payload: { type: "agent_message", message: asst } });
    for (const l of [l1, l2, l3, l4]) {
      lines.push(l);
      bytes += l.length + 1;
    }
    t += rng.int(2, 30) * 1000;
  }
  const stamp = `${spec.day.y}-${String(spec.day.m).padStart(2, "0")}-${String(spec.day.d).padStart(2, "0")}T10-${String(spec.contentIndex % 60).padStart(2, "0")}-00`;
  return { name: `rollout-${stamp}-${spec.id}.jsonl`, content: `${lines.join("\n")}\n` };
}

// ── The curated core every shape shares ────────────────────────────────────

interface Core {
  repoCli: ClaudeSessionSpec;
  repoDesktop: ClaudeSessionSpec;
  subagentParent: ClaudeSessionSpec;
}

function writeCore(ctx: Ctx): Core {
  const { home, rng } = ctx;
  const repo = join(home, "work", "acme-repo");
  const gitlab = join(home, "work", "gitlab-proj");
  const scratch = join(home, "scratch", "notes");
  const encoded = join(home, "tmp", "pool@acme@encoded@ab12cd");
  const worktree = join(repo, ".worktrees", "wt1");

  // Git repositories the session cwds point at. A normal clone with a GitHub
  // origin, a linked worktree (a `.git` FILE with a gitdir pointer, whose
  // config lives in the common dir), and a clone whose only remote is not
  // GitHub.
  write(ctx, "work/acme-repo/.git/config", `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:Acme/Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`, -3 * DAY);
  write(ctx, "work/acme-repo/.git/HEAD", "ref: refs/heads/main\n", -3 * DAY);
  write(ctx, "work/acme-repo/.git/worktrees/wt1/commondir", "../..\n", -2 * DAY);
  write(ctx, "work/acme-repo/.git/worktrees/wt1/HEAD", "ref: refs/heads/feature\n", -2 * DAY);
  write(ctx, "work/acme-repo/.worktrees/wt1/.git", `gitdir: ${join(repo, ".git", "worktrees", "wt1")}\n`, -2 * DAY);
  write(ctx, "work/acme-repo/README.md", "# acme repo (fixture)\n", -3 * DAY);
  write(ctx, "work/gitlab-proj/.git/config", `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://gitlab.example.test/acme/proj.git\n`, -3 * DAY);
  write(ctx, "scratch/notes/todo.txt", "fixture scratch dir, no git\n", -1 * DAY);

  const planPath = join(home, ".claude", "plans", "offsets-journal.md");
  write(ctx, ".claude/plans/offsets-journal.md", "# Plan\n\n1. Keep offsets in a journal.\n2. Snapshot hourly.\n", -2 * HOUR);

  const sessions: Array<ClaudeSessionSpec & { mtimeOffsetMs: number; dirMtimeOffsetMs?: number; note: string; projectDir?: string }> = [];
  const mk = (seed: string, partial: Partial<ClaudeSessionSpec> & { cwd: string; mtimeOffsetMs: number; note: string; dirMtimeOffsetMs?: number; projectDir?: string }): (typeof sessions)[number] => {
    const s = {
      sessionId: rng.uuid(),
      gitBranch: "main",
      entrypoint: "cli" as const,
      approxBytes: 40_000,
      seed,
      contentIndex: sessions.length,
      ...partial,
    };
    sessions.push(s);
    return s;
  };

  const repoCli = mk("repo-cli", {
    cwd: repo,
    mtimeOffsetMs: -1 * HOUR,
    approxBytes: 60_000,
    customTitle: "Offsets journal design",
    aiTitle: "Designing the offsets journal",
    planFilePath: planPath,
    note: "GitHub repo, user title, plan attachment, tasks",
  });
  const repoDesktop = mk("repo-desktop", {
    cwd: repo,
    entrypoint: "claude-desktop",
    mtimeOffsetMs: -90 * MIN,
    approxBytes: 30_000,
    aiTitle: "Reviewing the upload pipeline",
    note: "desktop entrypoint, Claude Desktop metadata carries the title",
  });
  mk("norepo", { cwd: scratch, gitBranch: null, mtimeOffsetMs: -5 * HOUR, note: "no git repo: repoSlug null (personal)" });
  mk("nongithub", { cwd: gitlab, mtimeOffsetMs: -6 * HOUR, note: "non-GitHub remote: repoSlug null" });
  mk("encoded", { cwd: encoded, gitBranch: null, mtimeOffsetMs: -7 * HOUR, note: "encoded scratch cwd that no longer exists: slug acme/encoded" });
  mk("worktree", { cwd: worktree, gitBranch: "feature", mtimeOffsetMs: -8 * HOUR, note: "linked worktree: slug via gitdir + commondir" });
  const twin = mk("twin", { cwd: repo, mtimeOffsetMs: -2 * DAY, approxBytes: 20_000, note: "twin: the older copy under the original cwd" });
  const subagentParent = mk("subagents", { cwd: repo, mtimeOffsetMs: -30 * MIN, approxBytes: 50_000, note: "parent of two subagent lanes and a workflow run" });
  mk("big", { cwd: repo, mtimeOffsetMs: -4 * HOUR, approxBytes: 70 * 1024 * 1024, note: "70 MB: past the 64 MB per-pass budget" });
  mk("longline", { cwd: repo, mtimeOffsetMs: -9 * HOUR, singleLineBytes: 5 * 1024 * 1024, note: "one 5 MiB line: the chunk is cut with no newline" });
  mk("unicode", {
    cwd: repo,
    mtimeOffsetMs: -10 * HOUR,
    approxBytes: 30_000,
    userTexts: [
      "Café ☕ — 日本語のテキスト 🚀 and a lone surrogate \ud83d here",
      `${"𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ".repeat(100)}${"x".repeat(4000)}`,
      "A title-length test: " + "w".repeat(120),
    ],
    note: "emoji, CJK, lone surrogate, a message past the 4,000-unit cap",
  });
  mk("old-file", { cwd: repo, mtimeOffsetMs: -40 * DAY, approxBytes: 10_000, note: "file older than the 30-day window inside a fresh dir" });
  mk("old-dir", { cwd: gitlab, mtimeOffsetMs: -35 * DAY, approxBytes: 10_000, dirMtimeOffsetMs: -40 * DAY, projectDir: ".claude/projects/-old-dir-fixture", note: "project dir older than the window" });

  for (const s of sessions) {
    const dirRel = s.projectDir ?? `.claude/projects/${encodeCwd(s.cwd)}`;
    const rel = `${dirRel}/${s.sessionId}.jsonl`;
    const content = claudeTranscript(s);
    const p = write(ctx, rel, content, s.mtimeOffsetMs);
    const inWindow = s.mtimeOffsetMs > -30 * DAY && (s.dirMtimeOffsetMs ?? 0) > -30 * DAY;
    const slug = s.cwd === repo || s.cwd === worktree ? "acme/repo" : s.cwd === encoded ? "acme/encoded" : null;
    if (inWindow) {
      ctx.manifest.sessions.push({
        family: s.entrypoint === "claude-desktop" ? "claude-desktop" : "claude-cli",
        sessionId: s.sessionId,
        path: p,
        bytes: Buffer.byteLength(content),
        mtimeOffsetMs: s.mtimeOffsetMs,
        repoSlug: slug,
        note: s.note,
      });
    } else {
      ctx.manifest.ignored.push({ path: p, reason: s.note });
    }
    if (s.dirMtimeOffsetMs !== undefined) dirMtime(ctx, dirRel, s.dirMtimeOffsetMs);
  }

  // The twin's newer copy: the same session continued under the worktree cwd,
  // on the worktree's branch. Every session in a folder carries the same
  // branch on purpose: hx ui shows a folder under the branch of whichever
  // session the discovery stat pool returned first (groupFolders in
  // src/ui/data.ts), and that order is a race no port can be held to.
  {
    const newer = { ...twin, cwd: worktree, gitBranch: "feature", contentIndex: twin.contentIndex, approxBytes: 26_000 };
    const content = claudeTranscript(newer);
    const p = write(ctx, `.claude/projects/${encodeCwd(worktree)}/${twin.sessionId}.jsonl`, content, -1 * HOUR);
    ctx.manifest.sessions.push({
      family: "claude-cli",
      sessionId: twin.sessionId,
      path: p,
      bytes: Buffer.byteLength(content),
      mtimeOffsetMs: -1 * HOUR,
      repoSlug: "acme/repo",
      note: "twin: the newer copy, elected uploader",
    });
  }

  // An empty transcript: discovery skips size 0.
  {
    const p = write(ctx, `.claude/projects/${encodeCwd(repo)}/${rng.uuid()}.jsonl`, "", -20 * MIN);
    ctx.manifest.ignored.push({ path: p, reason: "empty file" });
  }

  // Subagent lanes + a workflow run under the parent's session-artifact dir.
  {
    const sessionDir = `.claude/projects/${encodeCwd(repo)}/${subagentParent.sessionId}`;
    for (let i = 0; i < 2; i++) {
      const agentId = rng.alnum(12);
      write(ctx, `${sessionDir}/subagents/agent-${agentId}.jsonl`, agentTranscript(`sub-${i}`, subagentParent.sessionId, repo, 12_000, subagentParent.contentIndex), -25 * MIN);
      write(
        ctx,
        `${sessionDir}/subagents/agent-${agentId}.meta.json`,
        JSON.stringify({ agentType: i === 0 ? "Explore" : "general-purpose", description: rng.sentence(5), toolUseId: `toolu_${rng.alnum(20)}` }),
        -25 * MIN,
      );
    }
    const runId = `wf_${rng.alnum(8)}`;
    const wfAgent = rng.alnum(12);
    write(ctx, `${sessionDir}/subagents/workflows/${runId}/agent-${wfAgent}.jsonl`, agentTranscript("wf-0", subagentParent.sessionId, repo, 8_000, subagentParent.contentIndex), -22 * MIN);
    write(ctx, `${sessionDir}/subagents/workflows/${runId}/agent-${wfAgent}.meta.json`, JSON.stringify({ agentType: "workflow-subagent", worktreePath: worktree }), -22 * MIN);
    write(
      ctx,
      `${sessionDir}/subagents/workflows/${runId}/journal.jsonl`,
      `${[
        JSON.stringify({ t: iso(CONTENT_EPOCH), type: "start", runId }),
        JSON.stringify({ t: iso(CONTENT_EPOCH + MIN), type: "agent", agentId: wfAgent, state: "done" }),
      ].join("\n")}\n`,
      -21 * MIN,
    );
    write(ctx, `${sessionDir}/workflows/scripts/review-${runId}.js`, `export const meta = { name: "review" };\nexport default async () => 1;\n`, -23 * MIN);
  }

  // Tasks for two sessions, a team config.
  for (const [sid, n] of [[repoCli.sessionId, 3], [subagentParent.sessionId, 2]] as const) {
    for (let i = 1; i <= n; i++) {
      write(
        ctx,
        `.claude/tasks/${sid}/${i}.json`,
        JSON.stringify({ id: String(i), subject: `Task ${i}: ${rng.sentence(4)}`, description: rng.sentence(10), activeForm: `Doing task ${i}`, status: i === 1 ? "completed" : "pending", blocks: [], blockedBy: i > 1 ? [String(i - 1)] : [], metadata: {} }, null, 2),
        -40 * MIN,
      );
    }
  }
  write(ctx, ".claude/teams/alpha/config.json", JSON.stringify({ name: "alpha", members: ["lead", "builder"], created: iso(CONTENT_EPOCH) }, null, 2), -50 * MIN);

  // Codex: rollouts + state DB.
  const codexSpecs: Array<CodexSessionSpec & { title?: { name: string | null; title: string }; mtimeOffsetMs: number }> = [
    { id: rng.uuid(), cwd: repo, originator: "codex_cli_rs", archived: false, approxBytes: 20_000, seed: "c1", contentIndex: 0, day: { y: 2026, m: 10, d: 14 }, title: { name: "Rename the retry flag", title: "Rename retry flag in cli" }, mtimeOffsetMs: -3 * HOUR },
    { id: rng.uuid(), cwd: scratch, originator: "codex_cli_rs", archived: false, approxBytes: 15_000, seed: "c2", contentIndex: 1, day: { y: 2026, m: 10, d: 14 }, title: { name: null, title: "Fix the login bug" }, mtimeOffsetMs: -4 * HOUR },
    { id: rng.uuid(), cwd: repo, originator: "Codex Desktop", archived: false, approxBytes: 18_000, seed: "c3", contentIndex: 2, day: { y: 2026, m: 10, d: 13 }, mtimeOffsetMs: -26 * HOUR },
    { id: rng.uuid(), cwd: repo, originator: "codex_cli_rs", archived: true, approxBytes: 12_000, seed: "c4", contentIndex: 3, day: { y: 2026, m: 10, d: 10 }, title: { name: null, title: "Archived session title" }, mtimeOffsetMs: -5 * DAY },
  ];
  mkdirSync(join(home, ".codex"), { recursive: true });
  const db = new Database(join(home, ".codex", "state_5.sqlite"), { create: true });
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT, created_at INTEGER)");
  for (const c of codexSpecs) {
    const { name, content } = codexRollout(c);
    const dayDir = `.codex/${c.archived ? "archived_sessions" : "sessions"}/${c.day.y}/${String(c.day.m).padStart(2, "0")}/${String(c.day.d).padStart(2, "0")}`;
    const p = write(ctx, `${dayDir}/${name}`, content, c.mtimeOffsetMs);
    ctx.manifest.sessions.push({
      family: c.originator.toLowerCase().includes("desktop") ? "codex-desktop" : "codex-cli",
      sessionId: c.id,
      path: p,
      bytes: Buffer.byteLength(content),
      mtimeOffsetMs: c.mtimeOffsetMs,
      repoSlug: c.cwd === repo ? "acme/repo" : null,
      note: c.archived ? "codex archived rollout" : `codex ${c.originator}`,
    });
    if (c.title) {
      db.run("INSERT INTO threads (id, title, name, created_at) VALUES (?, ?, ?, ?)", [c.id, c.title.title, c.title.name, 1760000000]);
      ctx.manifest.expectations.codexTitles[c.id] = c.title.name ? { title: c.title.name, source: "user" } : { title: c.title.title, source: "ai" };
    }
  }
  db.close();
  ctx.mtimes.push({ path: join(home, ".codex", "state_5.sqlite"), offsetMs: -3 * HOUR, kind: "file" });

  // Claude Desktop: per-session metadata + Local Storage leveldb.
  const ccdRoot = "Library/Application Support/Claude";
  const account = "acct_fixture";
  const org = "org_fixture";
  const localIds = { repoCli: `local_${rng.uuid()}`, repoDesktop: `local_${rng.uuid()}`, unknown: `local_${rng.uuid()}`, archived: `local_${rng.uuid()}`, noCli: `local_${rng.uuid()}` };
  // A session Claude Desktop knows by a CLI id that has no transcript on
  // disk: the client still resolves the group member to that CLI id.
  const unknownCli = rng.uuid();
  const ccdFile = (localId: string, cliSessionId: string | null, title: string, titleSource: "user" | "ai", isArchived: boolean, idx: number): void => {
    write(
      ctx,
      `${ccdRoot}/claude-code-sessions/${account}/${org}/${localId}.json`,
      JSON.stringify({ sessionId: localId, ...(cliSessionId ? { cliSessionId } : {}), title, titleSource, isArchived, lastActivityAt: CONTENT_EPOCH + idx * HOUR, cwd: repo }),
      -(60 + idx) * MIN,
    );
  };
  ccdFile(localIds.repoCli, repoCli.sessionId, "Offsets journal design (desktop name)", "ai", false, 0);
  ccdFile(localIds.repoDesktop, repoDesktop.sessionId, "Pipeline review", "user", false, 1);
  ccdFile(localIds.unknown, unknownCli, "A session with no transcript on disk", "ai", false, 2);
  const archivedCli = rng.uuid();
  ccdFile(localIds.archived, archivedCli, "Archived session", "user", true, 3);
  ccdFile(localIds.noCli, null, "Session without a CLI id yet", "ai", false, 4);

  const state = {
    state: {
      groupByByMode: { code: "custom" },
      customGroups: [
        { id: "cg-alpha", name: "Alpha", subtitle: null, sectionName: "Work" },
        { id: "cg-beta", name: "Beta", subtitle: "second group", sectionName: null },
      ],
      customGroupOrder: { "cg-alpha": [`code:${localIds.repoCli}`, `code:${localIds.repoDesktop}`], "cg-beta": [`code:${localIds.unknown}`] },
      customGroupAssignments: { [`code:${localIds.repoCli}`]: "cg-alpha", [`code:${localIds.repoDesktop}`]: "cg-alpha", [`code:${localIds.unknown}`]: "cg-beta", [`code:${localIds.noCli}`]: "cg-beta" },
      collapsedGroups: ["cg-beta"],
    },
    version: 0,
  };
  const unread = { state: { unreadIds: [`code:${localIds.repoCli}`, `code:${localIds.unknown}`] }, version: 0 };
  const kvs: KeyValue[] = [
    { key: localStorageKey("file://", "frame-store"), value: localStorageValue(JSON.stringify(state)) },
    { key: localStorageKey("file://", "dframe-store"), value: localStorageValue(JSON.stringify({ state: { mru: [`code:${localIds.repoCli}`] }, version: 0 })) },
    { key: localStorageKey("file://", "epitaxy-unread-v1"), value: localStorageValue(JSON.stringify(unread)) },
  ];
  // Filler entries push the table to several Snappy blocks. Their names sort
  // after the three above and share no prefix with them, so each key keeps
  // its full spelling in the block (leveldb stores keys as deltas).
  const filler: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < 48; i++) filler.push({ name: `pref-${String(i).padStart(3, "0")}`, value: JSON.stringify({ value: rng.paragraph(300) }) });
  if (ctx.ccdLayout === "scoped") {
    writeScopedCcdStore(ctx, { ccdRoot, scope: `${account}/${org}`, repo, localIds, repoCli: repoCli.sessionId, repoDesktop: repoDesktop.sessionId, unknownCli, archivedCli, filler });
    return { repoCli, repoDesktop, subagentParent };
  }
  for (const f of filler) kvs.push({ key: localStorageKey("file://", f.name), value: localStorageValue(f.value) });
  write(ctx, `${ccdRoot}/Local Storage/leveldb/000012.ldb`, buildLdb(kvs, { compress: true, blockSize: 4096 }), -70 * MIN);
  // A stale write-ahead log that sorts BEFORE the table: grouping off. The
  // client reads newest-first, so the .ldb's value must win.
  write(
    ctx,
    `${ccdRoot}/Local Storage/leveldb/000009.log`,
    buildLog([[{ key: localStorageKey("file://", "frame-store"), value: localStorageValue(JSON.stringify({ state: { groupByByMode: { code: "repo" }, customGroups: [] }, version: 0 })) }]]),
    -3 * DAY,
  );
  write(ctx, `${ccdRoot}/Local Storage/leveldb/CURRENT`, "MANIFEST-000010\n", -70 * MIN);
  write(ctx, `${ccdRoot}/Local Storage/leveldb/LOCK`, "", -70 * MIN);

  ctx.manifest.expectations.groupMirror = {
    groupingEnabled: true,
    groups: [
      { id: "cg-alpha", name: "Alpha", subtitle: null, sectionName: "Work", collapsed: false, sessionIds: [repoCli.sessionId, repoDesktop.sessionId] },
      { id: "cg-beta", name: "Beta", subtitle: "second group", sectionName: null, collapsed: true, sessionIds: [unknownCli, localIds.noCli] },
    ],
    unreadIds: [repoCli.sessionId, unknownCli],
  };

  return { repoCli, repoDesktop, subagentParent };
}

/**
 * The Local Storage store of current Claude Desktop builds: the sidebar kept
 * per account scope (`<accountId>/<orgId>`), the live one named by
 * `lastSidebarScopeKey`, and the drawn sections (`codeSidebarByScope`) in an
 * order of their own beside the group list (`customGroupsByScope`, creation
 * order). The newest write sits in a log numbered BELOW the table that holds
 * an older one, as on a live machine, and is long enough (thirty signed-out
 * accounts' groups) to span three log blocks. A flat `frame-store` from an
 * older build is left in the table. The group list's `order` still keeps a
 * moved session in its old group, and `collapsedGroups` still says a section
 * is closed that the drawn sections show open: the mirror follows the
 * sections. `ccdSwitch` is the write that switches to the second account.
 */
function writeScopedCcdStore(
  ctx: Ctx,
  f: {
    ccdRoot: string;
    scope: string;
    repo: string;
    localIds: { repoCli: string; repoDesktop: string; unknown: string; archived: string; noCli: string };
    repoCli: string;
    repoDesktop: string;
    unknownCli: string;
    archivedCli: string;
    filler: Array<{ name: string; value: string }>;
  },
): void {
  const ORIGIN = "https://claude.ai";
  const A = f.scope;
  const B = "acct_second/org_second";
  const ids = f.localIds;
  // A generator of its own, so the flat layout's files stay byte-identical.
  const r = new Prng(`${ctx.manifest.seed}:ccd-scoped`);
  const b1 = `local_${r.uuid()}`;
  const b1Cli = r.uuid();
  const b2 = `local_${r.uuid()}`;
  for (const [localId, cliSessionId, idx] of [[b1, b1Cli, 0], [b2, null, 1]] as const) {
    write(
      ctx,
      `${f.ccdRoot}/claude-code-sessions/acct_second/org_second/${localId}.json`,
      JSON.stringify({ sessionId: localId, ...(cliSessionId ? { cliSessionId } : {}), title: `Second account session ${idx}`, titleSource: "user", isArchived: false, lastActivityAt: CONTENT_EPOCH + idx * HOUR, cwd: f.repo }),
      -(80 + idx) * MIN,
    );
  }
  const code = (id: string): string => `code:${id}`;
  const show = { metadata: false, emptyGroups: false, sideChats: false };
  const builtin = (id: string, order: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: id, v: 2, name: "", order, sortBy: "recency", ascending: false, show, collapsed: false, shown: true, groupBy: "none", ...extra });
  const manual = (id: string, name: string, order: number, members: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: "manual", v: 2, name, order, sortBy: "created", ascending: false, show, collapsed: false, shown: true, groupBy: "none", members: members.map(code), ...extra });
  const dead: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) {
    const members = Array.from({ length: 24 }, () => code(`local_${r.uuid()}`));
    dead[`acct_dead_${i}/org_dead_${i}`] = {
      groups: [
        { id: `cg-dead-${i}-a`, name: "Old work" },
        { id: `cg-dead-${i}-b`, name: "Ideas" },
      ],
      assignments: Object.fromEntries(members.map((m, j) => [m, j % 2 ? `cg-dead-${i}-b` : `cg-dead-${i}-a`])),
      order: { [`cg-dead-${i}-a`]: members.filter((_, j) => j % 2 === 0), [`cg-dead-${i}-b`]: members.filter((_, j) => j % 2 === 1) },
    };
  }
  const stateFor = (live: string, alphaName: string): unknown => ({
    state: {
      collapsed: false,
      sidebarWidth: 420,
      lastKnownMode: "code",
      groupByByMode: { code: "custom" },
      recentsStatusFilter: "active",
      collapsedGroups: ["pinned", "custom-cg-beta"],
      customGroupsByScope: {
        ...dead,
        [A]: {
          groups: [
            { id: "cg-alpha", name: alphaName },
            { id: "cg-beta", name: "Beta" },
            { id: "cg-gamma", name: "Gamma" },
          ],
          assignments: { [code(ids.repoCli)]: "cg-alpha", [code(ids.repoDesktop)]: "cg-gamma", [code(ids.unknown)]: "cg-beta", [code(ids.archived)]: "cg-beta", [code(ids.noCli)]: "cg-beta" },
          order: { "cg-alpha": [code(ids.repoCli), code(ids.repoDesktop)], "cg-beta": [code(ids.unknown), code(ids.archived), code(ids.noCli)], "cg-gamma": [code(ids.repoDesktop)] },
        },
        [B]: { groups: [{ id: "cg-old", name: "Old Project" }], assignments: { [code(b1)]: "cg-old", [code(b2)]: "cg-old" }, order: { "cg-old": [code(b1), code(b2)] } },
      },
      codeSidebarByScope: {
        [A]: {
          sections: [
            builtin("pinned", 0, { collapsed: true }),
            builtin("routines", 1, { shown: false }),
            manual("cg-gamma", "Gamma", 2, [ids.repoDesktop], { sortBy: "alpha", ascending: true }),
            manual("cg-alpha", alphaName, 3, [ids.repoCli], { collapsed: true }),
            manual("cg-beta", "Beta", 4, [ids.unknown, ids.archived, ids.noCli], { show: { ...show, emptyGroups: true } }),
            builtin("sessions", 5),
          ],
          migratedFrom: 1,
          prefsSeeded: true,
        },
        [B]: { sections: [builtin("pinned", 0), manual("cg-old", "Old Project", 2, [b1, b2]), builtin("sessions", 3)], migratedFrom: 1, prefsSeeded: true },
      },
      pendingLegacyGroupMigration: null,
      lastSidebarScopeKey: live,
    },
    version: 1,
    shared: {},
  });
  const value = (v: unknown): Buffer => localStorageValue(JSON.stringify(v));
  const key = (name: string): Buffer => localStorageKey(ORIGIN, name);
  const legacy = { state: { groupByByMode: { code: "custom" }, customGroups: [{ id: "cg-legacy", name: "Legacy" }], customGroupOrder: { "cg-legacy": [code(ids.repoCli)] }, customGroupAssignments: {}, collapsedGroups: [] }, version: 0 };
  const dir = `${f.ccdRoot}/Local Storage/leveldb`;
  write(
    ctx,
    `${dir}/000012.ldb`,
    buildLdbEntries(
      [
        { key: localStorageKey("file://", "frame-store"), seq: 5, value: value(legacy) },
        { key: key("dframe-store.backup.v1"), seq: 29, value: value({ state: { collapsed: false, sidebarWidth: 420, lastSidebarScopeKey: A }, version: 1, shared: {} }) },
        { key: key("dframe-store"), seq: 30, value: value(stateFor(A, "Alpha (old name)")) },
        { key: key("epitaxy-unread-v1"), seq: 31, value: value({ state: { unreadIds: [ids.repoCli, ids.unknown], explicitUnreadIds: [] }, version: 1 }) },
        ...f.filler.map((x, i) => ({ key: key(x.name), seq: 32 + i, value: localStorageValue(x.value) })),
      ],
      { compress: true, blockSize: 4096 },
    ),
    -70 * MIN,
  );
  const log = buildLogBatches([{ seq: 100, entries: [{ key: key("branch-status-cache"), value: value({ entries: [] }) }, { key: key("dframe-store"), value: value(stateFor(A, "Alpha")) }] }]);
  write(ctx, `${dir}/000011.log`, log, -5 * MIN);
  write(ctx, `${dir}/CURRENT`, "MANIFEST-000010\n", -70 * MIN);
  write(ctx, `${dir}/LOCK`, "", -70 * MIN);
  ctx.manifest.ccdSwitch = {
    file: `${dir}/000011.log`,
    appendBase64: buildLogBatches([{ seq: 102, entries: [{ key: key("dframe-store"), value: value(stateFor(B, "Alpha")) }] }], { startOffset: log.length }).toString("base64"),
  };

  const hash16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const group = (id: string, name: string, collapsed: boolean, sessionIds: string[], sortBy: string, ascending: boolean, showEmpty: boolean) => ({ id, name, subtitle: null, sectionName: null, collapsed, sessionIds, sortBy, ascending, shown: true, showEmpty });
  const unreadIds = [f.repoCli, f.unknownCli];
  ctx.manifest.expectations.groupMirror = {
    groupingEnabled: true,
    groups: [
      group("cg-gamma", "Gamma", false, [f.repoDesktop], "alpha", true, false),
      group("cg-alpha", "Alpha", true, [f.repoCli], "created", false, false),
      group("cg-beta", "Beta", false, [f.unknownCli, f.archivedCli, ids.noCli], "created", false, true),
    ],
    unreadIds,
    layout: "sections",
    statusFilter: "active",
    scope: hash16(A),
  };
  ctx.manifest.expectations.groupMirrorAfterSwitch = {
    groupingEnabled: true,
    groups: [group("cg-old", "Old Project", false, [b1Cli, b2], "created", false, false)],
    unreadIds,
    layout: "sections",
    statusFilter: "active",
    scope: hash16(B),
  };
}

// ── Generated bulk for the larger shapes ───────────────────────────────────

function writeBulk(ctx: Ctx, opts: { sessions: number; dirs: number; lanes: number; ccdFiles: number; bytes: () => number; tasks: number; runs: number }): void {
  const { home, rng } = ctx;
  const repos = ["acme-repo", "acme-two", "acme-three"].map((n) => join(home, "work", n));
  for (const r of repos.slice(1)) {
    write(ctx, `${r.slice(home.length + 1)}/.git/config`, `[remote "origin"]\n\turl = https://github.com/acme/${r.split("/").pop()}.git\n`, -3 * DAY);
  }
  const dirs: string[] = [];
  for (let i = 0; i < opts.dirs; i++) {
    const base = rng.pick(repos);
    dirs.push(i % 7 === 0 ? base : join(base, "packages", `pkg-${rng.alnum(5)}`));
  }
  const ccdRoot = "Library/Application Support/Claude/claude-code-sessions/acct_fixture/org_fixture";
  let ccdWritten = 0;
  for (let i = 0; i < opts.sessions; i++) {
    const cwd = dirs[i % dirs.length]!;
    const sid = rng.uuid();
    const spec: ClaudeSessionSpec = {
      sessionId: sid,
      cwd,
      gitBranch: rng.pick(["main", "dev", `feat/${rng.alnum(5)}`]),
      entrypoint: rng.float() < 0.3 ? "claude-desktop" : "cli",
      approxBytes: opts.bytes(),
      seed: `bulk-${i}`,
      contentIndex: 100 + i,
      ...(rng.float() < 0.3 ? { aiTitle: rng.sentence(5) } : {}),
    };
    const content = claudeTranscript(spec);
    const mtimeOffsetMs = -rng.int(20 * MIN, 29 * DAY);
    const p = write(ctx, `.claude/projects/${encodeCwd(cwd)}/${sid}.jsonl`, content, mtimeOffsetMs);
    ctx.manifest.sessions.push({
      family: spec.entrypoint === "claude-desktop" ? "claude-desktop" : "claude-cli",
      sessionId: sid,
      path: p,
      bytes: Buffer.byteLength(content),
      mtimeOffsetMs,
      repoSlug: `acme/${cwd.split("/work/")[1]!.split("/")[0]}`,
    });
    if (i < opts.lanes) {
      const agentId = rng.alnum(12);
      const dir = `.claude/projects/${encodeCwd(cwd)}/${sid}/subagents`;
      write(ctx, `${dir}/agent-${agentId}.jsonl`, agentTranscript(`bulk-lane-${i}`, sid, cwd, rng.int(2_000, 20_000), 100 + i), mtimeOffsetMs + 60_000);
      write(ctx, `${dir}/agent-${agentId}.meta.json`, JSON.stringify({ agentType: "Explore", description: rng.sentence(4), toolUseId: `toolu_${rng.alnum(20)}` }), mtimeOffsetMs + 60_000);
    }
    if (i < opts.runs) {
      const runId = `wf_${rng.alnum(8)}`;
      const dir = `.claude/projects/${encodeCwd(cwd)}/${sid}`;
      write(ctx, `${dir}/subagents/workflows/${runId}/journal.jsonl`, `${JSON.stringify({ t: iso(CONTENT_EPOCH), type: "start", runId })}\n`, mtimeOffsetMs + 60_000);
      write(ctx, `${dir}/workflows/scripts/sweep-${runId}.js`, `export const meta = { name: "sweep" };\n`, mtimeOffsetMs + 60_000);
    }
    if (i < opts.tasks) {
      write(ctx, `.claude/tasks/${sid}/1.json`, JSON.stringify({ id: "1", subject: rng.sentence(4), description: rng.sentence(8), activeForm: null, status: "pending", blocks: [], blockedBy: [], metadata: {} }), mtimeOffsetMs);
    }
    if (ccdWritten < opts.ccdFiles) {
      ccdWritten += 1;
      write(ctx, `${ccdRoot}/local_${rng.uuid()}.json`, JSON.stringify({ sessionId: `local_${rng.uuid()}`, cliSessionId: sid, title: rng.sentence(5), titleSource: rng.pick(["user", "ai"]), isArchived: false, lastActivityAt: CONTENT_EPOCH + i * MIN, cwd }), mtimeOffsetMs);
    }
  }
}

export function generateHome(opts: GenOptions): Manifest {
  const now = opts.now ?? Date.now();
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  const ccdLayout = opts.ccdLayout ?? "flat";
  const ctx: Ctx = {
    home: opts.out,
    now,
    ccdLayout,
    rng: new Prng(`${opts.shape}:${opts.seed}`),
    manifest: {
      shape: opts.shape,
      seed: opts.seed,
      now,
      home: opts.out,
      ...(ccdLayout === "flat" ? {} : { ccdLayout }),
      sessions: [],
      ignored: [],
      expectations: { groupMirror: { groupingEnabled: false, groups: [], unreadIds: [] }, codexTitles: {} },
    },
    mtimes: [],
  };
  writeCore(ctx);
  if (opts.shape === "claude-like") {
    const rng = ctx.rng;
    writeBulk(ctx, { sessions: 600, dirs: 150, lanes: 60, ccdFiles: 300, bytes: () => Math.round(5_000 * Math.exp(rng.float() * 6)), tasks: 120, runs: 30 });
  } else if (opts.shape === "synthetic-10k") {
    writeBulk(ctx, { sessions: 10_000, dirs: 200, lanes: 500, ccdFiles: 2_000, bytes: () => 30_000, tasks: 200, runs: 50 });
  }
  // mtimes last: every write above bumped its parent directory. Files first,
  // then directories deepest-first, so a directory's stamp is not undone by a
  // child's.
  const files = ctx.mtimes.filter((m) => m.kind === "file");
  const dirs = ctx.mtimes.filter((m) => m.kind === "dir").sort((a, b) => b.path.length - a.path.length);
  for (const m of files) {
    const t = new Date(now + m.offsetMs);
    utimesSync(m.path, t, t);
  }
  // Every directory a discovered session lives in reads as recently touched
  // (a creation bumps it on a real machine); explicitly aged dirs keep theirs.
  const aged = new Set(dirs.map((d) => d.path));
  const touched = new Set<string>();
  for (const s of ctx.manifest.sessions) {
    const dir = dirname(s.path);
    if (aged.has(dir) || touched.has(dir)) continue;
    touched.add(dir);
    const t = new Date(now - 10 * MIN);
    utimesSync(dir, t, t);
  }
  for (const m of dirs) {
    const t = new Date(now + m.offsetMs);
    utimesSync(m.path, t, t);
  }
  const manifestPath = `${opts.out}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(ctx.manifest, null, 2));
  return ctx.manifest;
}

// CLI entry: bun harness/fixtures/gen-home.ts --out <home> --shape <s> --seed <s> [--now <ms>] [--ccd-layout flat|scoped]
if (import.meta.main) {
  const arg = (name: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const out = arg("out");
  const shape = (arg("shape", "small") ?? "small") as Shape;
  const seed = arg("seed", "harness") ?? "harness";
  const nowArg = arg("now");
  const ccdLayout = (arg("ccd-layout", "flat") ?? "flat") as CcdLayout;
  if (!out) {
    console.error("usage: gen-home.ts --out <home> [--shape small|claude-like|synthetic-10k] [--seed s] [--now ms] [--ccd-layout flat|scoped]");
    process.exit(64);
  }
  const started = Date.now();
  const m = generateHome({ out, shape, seed, now: nowArg ? Number(nowArg) : undefined, ccdLayout });
  console.log(`generated ${m.sessions.length} sessions (${m.ignored.length} ignored) under ${out} in ${Date.now() - started} ms`);
}
