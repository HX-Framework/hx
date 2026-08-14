// Read-only view-model providers for the HX Client UI.
//
// Everything here READS: discovery, ~/.let/hx state/config, the daemon's
// stdout log, and two harmless gateway GETs (whoami, ping via probe). No
// provider mutates daemon state — state.json stays daemon-owned.
//
// The server process is long-lived while the daemon keeps writing, so every
// snapshot resets the in-process state cache before reading (loadState caches
// forever per process by design) and re-reads config per request.

import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig, type HxConfig } from "../config.js";
import { getDaemonOps, STDOUT_LOG } from "../daemon.js";
import { buildSyncDoctorReport, type SyncDoctorReport } from "../diagnostics.js";
import { assertSecureFetchUrl } from "../net.js";
import { readActivity, type ActivityEntry } from "../activity.js";
import { readOrgNames } from "../org-names.js";
import { discoverAll, readHead, type DiscoveredFile, type HeadMeta } from "../sources.js";
import {
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
  resolveDataRoots,
  samePhysicalDir,
  type DataRoot,
  type ResolvedRoots,
  type RootOrigin,
} from "../roots.js";
import { readSettings } from "../settings.js";
import { extractTitleFallback, readHeadLines } from "./preview.js";
import { isDeletedSession, loadState, minOffset, resetStateCache, type FileState } from "../state.js";
import { HX_VERSION } from "../version.js";
import { computeSyncReport } from "../watch.js";

export const FAMILY_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code CLI",
  "claude-desktop": "Claude Code Desktop",
  "codex-cli": "Codex CLI",
  "codex-desktop": "Codex Desktop",
  unknown: "Unknown tool",
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

/** "letai" (shared let.ai store) or a vault org id — friendly name when the
 *  daemon has ever learned one, short id otherwise. */
export function destLabelFor(destKey: string, names: Record<string, string> = {}): string {
  if (destKey === "letai") return "let.ai";
  const known = names[destKey];
  if (known) return known;
  return destKey.length > 14 ? `${destKey.slice(0, 12)}…` : destKey;
}

export interface FolderVM {
  id: string; // `${family}:${cwd}`
  family: string;
  tool: string;
  path: string;
  /** Sessions whose transcript is on THIS machine now (discovered on disk). */
  sessions: number;
  repo: string | null;
  branch: string | null;
  /** Destination store keys observed in state offsets ("letai" | org id). */
  dests: string[];
  lastUploadAtMs: number;
  /** Workspace attribution: true/false only when CONFIRMED (gateway route echo
   *  persisted by the daemon); null = unknown. Storage keys can NOT stand in
   *  for this — a cloud-hosted org's sessions rest in the let.ai store while
   *  fully attributed. */
  attributed: boolean | null;
  /** Repo present AND attribution CONFIRMED absent — never inferred. */
  unlinkedRepo: boolean;
}

export interface SessionVM {
  id: string;
  path: string;
  title: string;
  sizeBytes: number;
  uploadedBytes: number;
  pendingBytes: number;
  lastUploadAtMs: number;
  dests: string[];
  /** Permanently deleted server-side (tombstoned): uploads stopped forever,
   *  local file kept. Rendered as "Deleted from HX" — new activity in the
   *  session will no longer upload. */
  deleted: boolean;
}

export interface DestinationVM {
  key: string;
  label: string;
  personal: boolean;
  sessions: number;
  folders: number;
  bytes: number;
  lastUploadAtMs: number;
  blocked: { sessions: number; reason: string; orgName: string | null } | null;
}

export interface RecentUploadVM {
  atMs: number;
  title: string;
  folder: string;
  family: string;
  dests: string[];
  sizeBytes: number;
}

/** One watched data root, as shown in the UI's "Watched locations" card. */
export interface DataRootVM {
  family: "claude" | "codex";
  /** Absolute config-dir root — the identity used for settings add/remove. */
  configDir: string;
  /** ~-collapsed variant for display. */
  display: string;
  origin: RootOrigin;
  exists: boolean;
  /** Discovered transcript files under this root (parent sessions only). */
  files: number;
}

export interface UiSnapshot {
  generatedAt: number;
  device: {
    name: string | null;
    platform: string;
    arch: string;
    hxVersion: string;
    connected: boolean;
    gatewayHost: string | null;
    daemon: { managerName: string; loaded: boolean; pid: number | null };
  };
  sync: {
    total: number;
    done: number;
    totalBytes: number;
    behind: number;
    waiting: number;
    /** Partially-synced sessions under no current root (removed root). */
    unwatched: number;
    lastUploadAtMs: number;
  };
  folders: FolderVM[];
  destinations: DestinationVM[];
  recent: RecentUploadVM[];
  doctor: SyncDoctorReport;
  /** The watched data roots (see uiEffectiveRoots for whose truth this is). */
  dataRoots: DataRootVM[];
  /** Where dataRoots came from: the daemon's stamp, or this process's own
   *  resolution (daemon not yet upgraded / never ran). */
  dataRootsFrom: "daemon" | "local";
  /** CLAUDE_CONFIG_DIR / CODEX_HOME values visible to THIS UI-server process
   *  that the effective root set does not cover — surfaced as an "add this?"
   *  suggestion. The classic shape: var exported in .bashrc, `hx ui` launched
   *  from that shell, daemon under systemd/launchd never saw it. */
  shellDetected: { claude?: string; codex?: string };
}

// readHead is cheap (≤64 lines) but folders hold hundreds of files; cache
// heads per (path, mtime) across snapshots. Sessions without an explicit
// title get one derived from their first user message (same rule the
// workbench uses for fallback titles).
const headCache = new Map<string, { mtimeMs: number; head: HeadMeta }>();

async function headsFor(files: DiscoveredFile[]): Promise<Map<string, HeadMeta>> {
  const out = new Map<string, HeadMeta>();
  const POOL = 16;
  for (let i = 0; i < files.length; i += POOL) {
    await Promise.all(
      files.slice(i, i + POOL).map(async (f) => {
        const cached = headCache.get(f.path);
        if (cached && cached.mtimeMs === f.mtimeMs) {
          out.set(f.path, cached.head);
          return;
        }
        // Never walk the user's project dirs from the UI — the daemon already
        // resolved each repo slug and cached it in state.json (read in
        // groupFolders). Re-detecting here would touch macOS-protected folders
        // and fire a redundant TCC prompt (see readHead / detectRepoSlug).
        const head = await readHead(f.path, f.source, { resolveRepoFromDisk: false });
        if (!head.title) {
          head.title = extractTitleFallback(await readHeadLines(f.path));
        }
        headCache.set(f.path, { mtimeMs: f.mtimeMs, head });
        out.set(f.path, head);
      }),
    );
  }
  return out;
}

const homePrefix = `${os.homedir()}`;

function collapseHome(p: string): string {
  return p.startsWith(homePrefix) ? `~${p.slice(homePrefix.length)}` : p;
}

export interface FileFacts {
  file: DiscoveredFile;
  head: HeadMeta;
  state: FileState | null;
}

export function folderIdFor(family: string, cwd: string): string {
  return `${family}:${cwd}`;
}

/** Pure fold of per-file facts into folder rows — unit-tested. */
export function groupFolders(facts: FileFacts[]): FolderVM[] {
  const byId = new Map<string, FolderVM>();
  for (const { file, head, state } of facts) {
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    const id = folderIdFor(family, cwd);
    let row = byId.get(id);
    if (!row) {
      row = {
        id,
        family,
        tool: familyLabel(family),
        path: cwd,
        sessions: 0,
        repo: null,
        branch: null,
        dests: [],
        lastUploadAtMs: 0,
        attributed: null,
        unlinkedRepo: false,
      };
      byId.set(id, row);
    }
    row.sessions += 1;
    // Repo slug comes from the daemon's cached state (state.repoSlug), not from
    // a fresh on-disk walk — the UI must not re-enter project folders (macOS
    // TCC). head.repoSlug is a fallback for any caller that still resolves it.
    const repoSlug = state?.repoSlug ?? head.repoSlug ?? null;
    if (repoSlug && !row.repo) row.repo = repoSlug;
    if (head.gitBranch && !row.branch) row.branch = head.gitBranch;
    if (state) {
      row.lastUploadAtMs = Math.max(row.lastUploadAtMs, state.lastUploadAtMs || 0);
      for (const key of Object.keys(state.offsets)) {
        if ((state.offsets[key] ?? 0) > 0 && !row.dests.includes(key)) row.dests.push(key);
      }
      // Confirmed knowledge only: any file confirmed attributed lifts the
      // folder; confirmed-false only sticks while nothing contradicts it.
      if (state.attributed === true) row.attributed = true;
      else if (state.attributed === false && row.attributed === null) row.attributed = false;
    }
  }
  for (const row of byId.values()) {
    row.dests.sort();
    // Vault-store offsets are attribution proof in themselves (only attributed
    // sessions fan out to an org vault).
    if (row.dests.some((d) => d !== "letai")) row.attributed = true;
    row.unlinkedRepo = row.repo !== null && row.attributed === false;
  }
  return [...byId.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Pure fold of per-file facts into destination rows — unit-tested. */
export function groupDestinations(
  facts: FileFacts[],
  names: Record<string, string> = {},
): DestinationVM[] {
  const byKey = new Map<string, DestinationVM & { folderIds: Set<string> }>();
  for (const { file, head, state } of facts) {
    if (!state) continue;
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    for (const [key, uploaded] of Object.entries(state.offsets)) {
      if ((uploaded ?? 0) <= 0) continue;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          label: destLabelFor(key, names),
          personal: key === "letai",
          sessions: 0,
          folders: 0,
          bytes: 0,
          lastUploadAtMs: 0,
          blocked: null,
          folderIds: new Set<string>(),
        };
        byKey.set(key, row);
      }
      row.sessions += 1;
      row.bytes += uploaded ?? 0;
      row.lastUploadAtMs = Math.max(row.lastUploadAtMs, state.lastUploadAtMs || 0);
      row.folderIds.add(folderIdFor(family, cwd));
    }
    const blocker = state.blocker;
    if (blocker) {
      for (const dest of blocker.destinations) {
        const key = dest.vaultOrgId;
        const row = byKey.get(key);
        if (row) {
          row.blocked = {
            sessions: (row.blocked?.sessions ?? 0) + 1,
            reason: blocker.reason,
            orgName: dest.orgName ?? row.blocked?.orgName ?? null,
          };
          if (dest.orgName) row.label = dest.orgName;
        }
      }
    }
  }
  return [...byKey.values()]
    .map(({ folderIds, ...row }) => ({ ...row, folders: folderIds.size }))
    .sort((a, b) => (a.personal ? 1 : 0) - (b.personal ? 1 : 0) || b.bytes - a.bytes);
}

/**
 * The root set this UI process should discover with. Device truth is what the
 * LONG-RUNNING daemon stamped into state.json — this server may run under a
 * different environment (launched from a shell that exports CLAUDE_CONFIG_DIR
 * while the systemd/launchd daemon never saw it, or vice versa), and every
 * number we show must describe what the background service actually mirrors.
 * Our own resolution is only the fallback for a daemon that predates the
 * stamp or has never run.
 */
async function uiEffectiveRoots(): Promise<{ roots: ResolvedRoots; from: "daemon" | "local" }> {
  resetStateCache();
  const state = await loadState();
  if (state.effectiveRoots) {
    return {
      roots: { claude: state.effectiveRoots.claude, codex: state.effectiveRoots.codex },
      from: "daemon",
    };
  }
  return { roots: resolveDataRoots(await readSettings()), from: "local" };
}

async function collectFacts(): Promise<{ facts: FileFacts[]; roots: ResolvedRoots; rootsFrom: "daemon" | "local" }> {
  const { roots, from } = await uiEffectiveRoots();
  const files = await discoverAll(roots);
  const heads = await headsFor(files);
  const state = await loadState();
  return {
    facts: files.map((file) => ({
      file,
      head: heads.get(file.path) as HeadMeta,
      state: state.files[file.path] ?? null,
    })),
    roots,
    rootsFrom: from,
  };
}

/** Pure fold: per-root VM rows from the resolved roots + discovered files. */
export function buildDataRootVMs(roots: ResolvedRoots, files: DiscoveredFile[]): DataRootVM[] {
  const countByRoot = new Map<string, number>();
  for (const f of files) {
    countByRoot.set(f.rootDir, (countByRoot.get(f.rootDir) ?? 0) + 1);
  }
  const rows = (family: "claude" | "codex", list: DataRoot[]): DataRootVM[] =>
    list.map((r) => ({
      family,
      configDir: r.configDir,
      display: collapseHome(r.configDir),
      origin: r.origin,
      exists: r.exists,
      files: countByRoot.get(r.configDir) ?? 0,
    }));
  return [...rows("claude", roots.claude), ...rows("codex", roots.codex)];
}

/** Env values THIS process sees that the effective set doesn't cover. Reuses
 *  the resolver so realpath dedupe decides "covered", not string equality. */
export function detectShellRoots(
  selfResolved: ResolvedRoots,
  effective: ResolvedRoots,
): { claude?: string; codex?: string } {
  const out: { claude?: string; codex?: string } = {};
  for (const family of ["claude", "codex"] as const) {
    const env = selfResolved[family].find((r) => r.origin === "env");
    if (!env) continue; // no env var, or it deduped into an already-known root
    if (effective[family].some((r) => samePhysicalDir(r.configDir, env.configDir))) continue;
    // Never one-click-suggest a root that CONTAINS the family default (e.g.
    // CLAUDE_CONFIG_DIR=$HOME): legal for the tool, but adding it would sweep
    // <root>/projects — for $HOME that's ~/projects — into the upload surface
    // on a single click. A deliberate manual add remains possible.
    const def = family === "claude" ? DEFAULT_CLAUDE_ROOT : DEFAULT_CODEX_ROOT;
    if (def === env.configDir || def.startsWith(env.configDir + path.sep)) continue;
    out[family] = env.configDir;
  }
  return out;
}

export async function buildSnapshot(): Promise<UiSnapshot> {
  resetStateCache();
  const cfg = await readConfig();
  const { facts, roots, rootsFrom } = await collectFacts();
  const report = await computeSyncReport(roots);
  const doctor = buildSyncDoctorReport(report, cfg?.gatewayBaseUrl ?? "", Date.now(), roots);
  const dataRoots = buildDataRootVMs(roots, facts.map((f) => f.file));
  const shellDetected = detectShellRoots(resolveDataRoots(await readSettings()), roots);

  let daemon = { managerName: "none", loaded: false, pid: null as number | null };
  try {
    const ops = getDaemonOps();
    const state = await ops.state();
    daemon = { managerName: ops.managerName, loaded: state.loaded, pid: state.pid };
  } catch {
    // unsupported platform — report as not running
  }

  const folders = groupFolders(facts);
  const destinations = groupDestinations(facts, await readOrgNames());
  const lastUploadAtMs = facts.reduce((m, f) => Math.max(m, f.state?.lastUploadAtMs ?? 0), 0);

  const gatewayHost = ((): string | null => {
    try {
      return cfg?.gatewayBaseUrl ? new URL(cfg.gatewayBaseUrl).host : null;
    } catch {
      return null;
    }
  })();

  return {
    generatedAt: Date.now(),
    device: {
      name: cfg?.deviceName ?? null,
      platform: os.platform(),
      arch: os.arch(),
      hxVersion: HX_VERSION,
      connected: Boolean(cfg?.accessToken),
      gatewayHost,
      daemon,
    },
    sync: {
      total: report.snapshot.total,
      done: report.snapshot.done,
      totalBytes: report.snapshot.totalBytes,
      behind: report.behind.length,
      waiting: report.skipped.length,
      unwatched: report.unwatched,
      lastUploadAtMs,
    },
    folders,
    destinations,
    recent: facts
      .filter((f) => (f.state?.lastUploadAtMs ?? 0) > 0)
      .sort((a, b) => (b.state?.lastUploadAtMs ?? 0) - (a.state?.lastUploadAtMs ?? 0))
      .slice(0, 20)
      .map(({ file, head, state }) => ({
        atMs: state?.lastUploadAtMs ?? 0,
        title: head.title ?? path.basename(file.path),
        folder: collapseHome(head.cwd ?? path.dirname(file.path)),
        family: head.family,
        dests: Object.keys(state?.offsets ?? {}).filter((k) => (state?.offsets[k] ?? 0) > 0),
        sizeBytes: file.size,
      })),
    doctor,
    dataRoots,
    dataRootsFrom: rootsFrom,
    shellDetected,
  };
}

export async function buildSessions(folderId: string): Promise<SessionVM[]> {
  resetStateCache();
  const { facts } = await collectFacts();
  const fullState = await loadState();
  const out: SessionVM[] = [];
  for (const { file, head, state } of facts) {
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    if (folderIdFor(family, cwd) !== folderId) continue;
    const uploaded = state ? minOffset(state) : 0;
    const sessionId = head.sessionId ?? path.basename(file.path, ".jsonl");
    const deleted = isDeletedSession(fullState, state?.family ?? family, sessionId);
    out.push({
      id: head.sessionId ?? path.basename(file.path),
      path: file.path,
      title: head.title ?? path.basename(file.path, ".jsonl"),
      sizeBytes: file.size,
      uploadedBytes: uploaded,
      // A deleted session has nothing pending by definition — uploads are
      // permanently stopped, whatever the local file grows to.
      pendingBytes: deleted ? 0 : Math.max(0, file.size - uploaded),
      lastUploadAtMs: state?.lastUploadAtMs ?? 0,
      dests: Object.keys(state?.offsets ?? {}).filter((k) => (state?.offsets[k] ?? 0) > 0),
      deleted,
    });
  }
  return out.sort((a, b) => b.lastUploadAtMs - a.lastUploadAtMs);
}

/** Only paths the discovery scan yields may be previewed or sized. Scans with
 *  the daemon's effective roots (stamp-first) — the preview surface must match
 *  what the device actually mirrors, not this process's private env. */
export async function isDiscoveredPath(p: string): Promise<boolean> {
  const { roots } = await uiEffectiveRoots();
  const files = await discoverAll(roots);
  return files.some((f) => f.path === p);
}

export type LogLevel = "info" | "up" | "warn";

/** Pure log-line classifier — unit-tested. */
export function classifyLogLine(body: string): LogLevel {
  if (/\(\+[\d,]+B/.test(body)) return "up";
  if (/failed=[1-9]/.test(body)) return "warn";
  if (/\[error\]|error[:\s]|warn|not progressing|backing off|unavailable/i.test(body)) {
    return "warn";
  }
  return "info";
}

const LOG_TAIL_MAX = 256 * 1024;

export async function tailDaemonLog(maxLines: number): Promise<{ body: string; level: LogLevel }[]> {
  try {
    // Open first, size via fstat on the handle — no stat-then-open race.
    const fh = await open(STDOUT_LOG, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - LOG_TAIL_MAX);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift(); // first line is torn
      return lines
        .filter((l) => l.trim().length > 0)
        .slice(-maxLines)
        .map((body) => ({ body, level: classifyLogLine(body) }));
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

// ── whoami (email for the identity chip) — cached, token never exposed ──
let whoamiCache: { at: number; email: string | null } | null = null;
const WHOAMI_TTL_MS = 5 * 60_000;

export async function cachedWhoami(fetcher: typeof fetch = fetch): Promise<{ email: string | null }> {
  if (whoamiCache && Date.now() - whoamiCache.at < WHOAMI_TTL_MS) {
    return { email: whoamiCache.email };
  }
  const cfg = await readConfig();
  if (!cfg?.accessToken || !cfg.gatewayBaseUrl) return { email: null };
  try {
    const url = `${cfg.gatewayBaseUrl}/whoami`;
    assertSecureFetchUrl(url, "gateway");
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
    const email = res.ok ? ((await res.json()) as { email?: string }).email ?? null : null;
    whoamiCache = { at: Date.now(), email };
    return { email };
  } catch {
    whoamiCache = { at: Date.now(), email: null };
    return { email: null };
  }
}

export async function readConfigForProbe(): Promise<HxConfig | null> {
  return readConfig();
}

const ACTIVITY_MAX_HOURS = 7 * 24;

export async function activitySince(hours: number): Promise<ActivityEntry[]> {
  const h = Math.min(ACTIVITY_MAX_HOURS, Math.max(1, hours));
  return readActivity(Date.now() - h * 3_600_000);
}
