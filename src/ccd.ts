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

import { readdir, readFile, stat } from "node:fs/promises";
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
let CCD_DIR = CCD_ROOT === null ? null : path.join(CCD_ROOT, "claude-code-sessions");

/** Test seam — point the session-metadata store at a fixture dir (null
 *  restores the platform default) and drop the caches. Linux CI has no CCD
 *  paths at all, so the cache/fingerprint logic is untestable without this. */
export function setCcdSessionsDirForTests(dir: string | null): void {
  CCD_DIR = dir ?? (CCD_ROOT === null ? null : path.join(CCD_ROOT, "claude-code-sessions"));
  recordsCache = null;
  recordsInFlight = null;
  cachedMap = null;
}

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

/** All CCD session-metadata records (including archived). Uncached — prefer
 *  {@link readCcdRecentsCached} anywhere called on a timer or the hot path. */
export async function readCcdRecents(): Promise<CcdSessionMeta[]> {
  const files = await listSessionFiles();
  const records = await Promise.all(files.map(readSessionFile));
  return records.filter((r): r is CcdSessionMeta => !!r);
}

/**
 * Cheap change fingerprint over the CCD session-metadata store: every
 * `local_*.json`'s (path, size, mtime), sorted. A rewrite bumps the file's
 * mtime even though the org dir's mtime stays put — so this must stat files,
 * not directories. Stats only; no file is ever read here.
 */
export async function ccdSessionsFingerprint(): Promise<string> {
  const files = await listSessionFiles();
  const parts = await Promise.all(
    files.map(async (p) => {
      try {
        const st = await stat(p);
        return `${p}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${p}:gone`;
      }
    }),
  );
  return parts.sort().join("|");
}

// Reading every local_*.json on each 1.5s watcher tick would be wasteful, so we
// cache the records and refresh at most every TTL — and even then only when the
// store's stat fingerprint moved (a TTL expiry alone costs stats, not reads).
// Single-flight: concurrent misses (the upload pool) share one refresh.
const CCD_CACHE_TTL_MS = 10_000;
let recordsCache: { atMs: number; fp: string; records: CcdSessionMeta[] } | null = null;
let recordsInFlight: Promise<CcdSessionMeta[]> | null = null;

/** All CCD records, ≤ TTL stale, re-read only when the store changed. */
export async function readCcdRecentsCached(nowMs: number): Promise<CcdSessionMeta[]> {
  if (recordsCache && nowMs - recordsCache.atMs < CCD_CACHE_TTL_MS) return recordsCache.records;
  if (recordsInFlight) return recordsInFlight;
  recordsInFlight = (async () => {
    try {
      const fp = await ccdSessionsFingerprint();
      if (recordsCache && recordsCache.fp === fp) {
        recordsCache = { ...recordsCache, atMs: nowMs };
        return recordsCache.records;
      }
      const records = await readCcdRecents();
      recordsCache = { atMs: nowMs, fp, records };
      return records;
    } finally {
      recordsInFlight = null;
    }
  })();
  return recordsInFlight;
}

let cachedMap: { records: CcdSessionMeta[]; byCli: Map<string, CcdSessionMeta> } | null = null;

/** cliSessionId → CCD metadata, derived from the cached records (the map is
 *  rebuilt only when the records array identity changes). */
export async function getCcdRecentsByCliId(
  nowMs: number,
): Promise<Map<string, CcdSessionMeta>> {
  const records = await readCcdRecentsCached(nowMs);
  if (cachedMap && cachedMap.records === records) return cachedMap.byCli;
  const byCli = new Map<string, CcdSessionMeta>();
  for (const r of records) {
    if (r.cliSessionId) byCli.set(r.cliSessionId, r);
  }
  cachedMap = { records, byCli };
  return byCli;
}
