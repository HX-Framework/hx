// Read Claude Code Desktop's per-session metadata files.
//
// Source of truth: ~/Library/Application Support/Claude/claude-code-sessions/
//                    <accountId>/<orgId>/local_<uuid>.json
//
// Each file is the persisted session-metadata object CCD writes to disk. We use
// it for two things the jsonl can't give us:
//   • the CCD-canonical title + titleSource (CCD's sidebar label)
//   • the ccdSessionId ("local_<uuid>") ↔ cliSessionId (jsonl id) mapping,
//     which is the key CCD's custom-group assignments reference
//
// Trimmed to the fields hx needs. When CCD isn't installed the directory is
// absent and every reader degrades to an empty result.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { posix as posixPath, win32 as winPath } from "node:path";
import os from "node:os";

/**
 * Claude Desktop's per-user data directory. Electron puts this under
 * ~/Library/Application Support on macOS and %APPDATA% (Roaming) on Windows.
 * Returns null where CCD does not ship, so every reader degrades to an empty
 * result instead of scanning a path that cannot exist.
 */
export function ccdAppDir(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string | null {
  // posix explicitly, for the same reason the win32 branch below is explicit:
  // the ambient path module follows the HOST, so this joined with "\\" when
  // called on Windows — which is both wrong and untestable from Windows CI.
  if (platform === "darwin") {
    return posixPath.join(home, "Library", "Application Support", "Claude");
  }
  if (platform === "win32") {
    // path.win32 explicitly: the ambient module is POSIX-flavored when this
    // runs on Linux, which would join with "/" and produce a path Windows
    // cannot open. Being explicit also lets CI cover it from Linux.
    // %APPDATA% is Roaming; fall back to its canonical location when the
    // variable is missing (a context that never loaded the user's environment).
    return winPath.join(env.APPDATA || winPath.join(home, "AppData", "Roaming"), "Claude");
  }
  return null;
}

const CCD_ROOT = ccdAppDir();
const CCD_DIR = CCD_ROOT === null ? null : path.join(CCD_ROOT, "claude-code-sessions");

export interface CcdSessionMeta {
  /** CCD's internal id, "local_<uuid>". */
  ccdSessionId: string;
  /** The jsonl/CLI session id — matches hx's `sessionId`. */
  cliSessionId: string | null;
  title: string | null;
  /** CCD's provenance: "user" (renamed) | "ai" (generated). */
  titleSource: "user" | "ai" | null;
  isArchived: boolean;
  lastActivityAt: number;
}

async function listSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  if (CCD_DIR === null) return out; // CCD doesn't ship on this platform
  let accountDirs: string[];
  try {
    accountDirs = await readdir(CCD_DIR);
  } catch {
    return out;
  }
  for (const acc of accountDirs) {
    if (acc.startsWith(".")) continue;
    const accPath = path.join(CCD_DIR, acc);
    let orgs: string[];
    try {
      orgs = await readdir(accPath);
    } catch {
      continue;
    }
    for (const org of orgs) {
      if (org.startsWith(".")) continue;
      const orgPath = path.join(accPath, org);
      let files: string[];
      try {
        files = await readdir(orgPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        out.push(path.join(orgPath, f));
      }
    }
  }
  return out;
}

async function readSessionFile(filePath: string): Promise<CcdSessionMeta | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  if (typeof d.sessionId !== "string") return null;
  const titleSourceRaw = typeof d.titleSource === "string" ? d.titleSource : null;
  return {
    ccdSessionId: d.sessionId,
    cliSessionId: typeof d.cliSessionId === "string" ? d.cliSessionId : null,
    title: typeof d.title === "string" && d.title.trim() ? d.title : null,
    titleSource: titleSourceRaw === "user" || titleSourceRaw === "ai" ? titleSourceRaw : null,
    isArchived: d.isArchived === true,
    lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : 0,
  };
}

/** All CCD session-metadata records (including archived). */
export async function readCcdRecents(): Promise<CcdSessionMeta[]> {
  const files = await listSessionFiles();
  const records = await Promise.all(files.map(readSessionFile));
  return records.filter((r): r is CcdSessionMeta => !!r);
}

// Reading every local_*.json on each 1.5s watcher tick would be wasteful, so we
// cache the cliSessionId → meta map and refresh it at most every TTL. Titles and
// group membership change rarely, so mild staleness is fine.
const CCD_CACHE_TTL_MS = 10_000;
let cachedMap: Map<string, CcdSessionMeta> | null = null;
let cachedAtMs = 0;

/** cliSessionId → CCD metadata, cached with a short TTL. */
export async function getCcdRecentsByCliId(
  nowMs: number,
): Promise<Map<string, CcdSessionMeta>> {
  if (cachedMap && nowMs - cachedAtMs < CCD_CACHE_TTL_MS) return cachedMap;
  const recents = await readCcdRecents();
  const byCli = new Map<string, CcdSessionMeta>();
  for (const r of recents) {
    if (r.cliSessionId) byCli.set(r.cliSessionId, r);
  }
  cachedMap = byCli;
  cachedAtMs = nowMs;
  return byCli;
}
