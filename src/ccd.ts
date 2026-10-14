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
//
// The store is large on a long-lived machine: 34,971 files and 925 MB measured
// on one laptop, and CCD rewrites some of them every few seconds while it is
// open. The reader used to re-stat every file (35k stats plus a 7.6 MB
// fingerprint string) on every 10 s TTL lapse, and re-read ALL of them — 35k
// concurrent reads, about 7 s of CPU and 2-3 GB of allocation — whenever any
// single file had changed. During a catch-up that was the daemon's dominant
// cost: about one core continuously, and the allocation churn behind the
// multi-GB RSS swings (Request Pricing M13).
//
// It is now an INCREMENTAL index. Per file we remember (size, mtime) and the
// parsed record; a refresh stats the org directories first (CCD writes by
// rename, so a creation or rewrite bumps the parent dir's mtime), re-lists only
// the directories that moved, stats only their files, and re-reads only the
// files whose stat moved. Every stat and read goes through a bounded pool. A
// full per-file stat sweep still runs at most once per FULL_STAT interval as a
// safety net for in-place rewrites that leave the dir mtime alone.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { posix as posixPath, win32 as winPath } from "node:path";
import os from "node:os";
import { mapPool, readdirSafe, statSafe } from "./sources.js";

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

/** How long a refresh result is reused before the org dirs are re-statted.
 *  Titles and group membership may lag the store by this much. */
export const CCD_REFRESH_TTL_MS = 20_000;
/** How often EVERY file is re-statted regardless of dir mtimes — the safety
 *  net for a rewrite that leaves the parent dir's mtime alone. */
export const CCD_FULL_STAT_INTERVAL_MS = 60_000;
/** Stats and reads in flight at once. Bounds the memory of a refresh to this
 *  many file buffers (CCD session files are tens to a few hundred KB). */
export const CCD_IO_CONCURRENCY = 32;

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

interface IndexedFile {
  size: number;
  mtimeMs: number;
  record: CcdSessionMeta | null;
}

interface OrgDirListing {
  mtimeMs: number;
  /** Absolute paths of the local_*.json files present at `mtimeMs`. */
  files: string[];
}

// ── The index ───────────────────────────────────────────────────────────────
const index = new Map<string, IndexedFile>();
const orgDirs = new Map<string, OrgDirListing>();
/** Snapshot of every parsed record. Its IDENTITY changes only when the index
 *  changed, so callers can cache derived maps against it. */
let records: CcdSessionMeta[] = [];
let version = 0;
let lastRefreshAtMs = Number.NEGATIVE_INFINITY;
let lastFullStatAtMs = Number.NEGATIVE_INFINITY;
let refreshInFlight: Promise<void> | null = null;

function resetIndex(): void {
  index.clear();
  orgDirs.clear();
  records = [];
  version = 0;
  lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  lastFullStatAtMs = Number.NEGATIVE_INFINITY;
  cachedMap = null;
}

/** Test seam — point the session-metadata store at a fixture dir (null
 *  restores the platform default) and drop the index. Linux CI has no CCD
 *  paths at all, so the index logic is untestable without this. */
export function setCcdSessionsDirForTests(dir: string | null): void {
  CCD_DIR = dir ?? (CCD_ROOT === null ? null : path.join(CCD_ROOT, "claude-code-sessions"));
  resetIndex();
}

/** Monotonic counter bumped whenever the indexed records changed — the cache
 *  key for anything derived from them (the group mirror). */
export function ccdIndexVersion(): number {
  return version;
}

function isSessionFile(name: string): boolean {
  return name.startsWith("local_") && name.endsWith(".json");
}

/** <store>/<accountId>/<orgId> for every account and org on disk. */
async function listOrgDirs(): Promise<string[]> {
  const out: string[] = [];
  if (CCD_DIR === null) return out; // CCD doesn't ship on this platform
  let accountDirs: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed CCD store path
    accountDirs = await readdir(CCD_DIR);
  } catch {
    return out;
  }
  for (const acc of accountDirs) {
    if (acc.startsWith(".")) continue;
    const accPath = path.join(CCD_DIR, acc);
    for (const org of await readdirSafe(accPath)) {
      if (org.startsWith(".")) continue;
      out.push(path.join(accPath, org));
    }
  }
  return out;
}

async function listSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await listOrgDirs()) {
    for (const f of await readdirSafe(dir)) {
      if (isSessionFile(f)) out.push(path.join(dir, f));
    }
  }
  return out;
}

async function readSessionFile(filePath: string): Promise<CcdSessionMeta | null> {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path listed from the CCD store
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

/** All CCD session-metadata records (including archived), read fresh through
 *  the bounded pool. Uncached — prefer {@link readCcdRecentsCached} anywhere
 *  called on a timer or the hot path. */
export async function readCcdRecents(): Promise<CcdSessionMeta[]> {
  const files = await listSessionFiles();
  const out: CcdSessionMeta[] = [];
  await mapPool(files, CCD_IO_CONCURRENCY, async (p) => {
    const r = await readSessionFile(p);
    if (r) out.push(r);
  });
  return out;
}

/**
 * One refresh of the index. `fullStat` re-stats every known file; otherwise
 * only the files of org dirs whose mtime moved (plus any dir not seen before)
 * are statted. Reads happen only for files whose (size, mtime) moved.
 */
async function refreshNow(nowMs: number, fullStat: boolean): Promise<void> {
  if (CCD_DIR === null) {
    if (index.size > 0 || orgDirs.size > 0) {
      resetIndex();
      version += 1;
    }
    lastRefreshAtMs = nowMs;
    return;
  }
  let changed = false;
  const dirs = await listOrgDirs();
  const seenDirs = new Set(dirs);
  const toStat = new Set<string>();

  // Directory pass: a dir whose mtime moved is re-listed and its files queued
  // for a stat. Deletions and renames surface here (both bump the dir).
  await mapPool(dirs, CCD_IO_CONCURRENCY, async (dir) => {
    const st = await statSafe(dir);
    const known = orgDirs.get(dir);
    if (!st || !st.isDir) {
      if (known) {
        for (const p of known.files) if (index.delete(p)) changed = true;
        orgDirs.delete(dir);
      }
      return;
    }
    if (known && known.mtimeMs === st.mtimeMs) {
      if (fullStat) for (const p of known.files) toStat.add(p);
      return;
    }
    const present: string[] = [];
    for (const f of await readdirSafe(dir)) {
      if (isSessionFile(f)) present.push(path.join(dir, f));
    }
    if (known) {
      const presentSet = new Set(present);
      for (const p of known.files) {
        if (!presentSet.has(p) && index.delete(p)) changed = true;
      }
    }
    orgDirs.set(dir, { mtimeMs: st.mtimeMs, files: present });
    for (const p of present) toStat.add(p);
  });
  // An account or org dir that vanished takes its files with it.
  for (const [dir, listing] of [...orgDirs]) {
    if (seenDirs.has(dir)) continue;
    for (const p of listing.files) if (index.delete(p)) changed = true;
    orgDirs.delete(dir);
  }

  // File pass: stat each queued file; read only what moved.
  await mapPool([...toStat], CCD_IO_CONCURRENCY, async (p) => {
    const st = await statSafe(p);
    if (!st || st.isDir) {
      if (index.delete(p)) changed = true;
      return;
    }
    const known = index.get(p);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return;
    const record = await readSessionFile(p);
    index.set(p, { size: st.size, mtimeMs: st.mtimeMs, record });
    changed = true;
  });

  if (fullStat) lastFullStatAtMs = nowMs;
  lastRefreshAtMs = nowMs;
  if (changed) {
    version += 1;
    const next: CcdSessionMeta[] = [];
    for (const e of index.values()) if (e.record) next.push(e.record);
    records = next;
  }
}

/**
 * Bring the index up to date if it is older than the TTL (or `force`), and
 * return its version. Single-flight: concurrent callers share one refresh.
 * The first call builds the whole index — one bounded read of every file.
 */
export async function refreshCcdIndex(
  nowMs: number,
  opts: { force?: boolean } = {},
): Promise<number> {
  if (!opts.force && nowMs - lastRefreshAtMs < CCD_REFRESH_TTL_MS) return version;
  if (refreshInFlight) {
    await refreshInFlight;
    return version;
  }
  const fullStat = opts.force === true || nowMs - lastFullStatAtMs >= CCD_FULL_STAT_INTERVAL_MS;
  refreshInFlight = refreshNow(nowMs, fullStat).finally(() => {
    refreshInFlight = null;
  });
  await refreshInFlight;
  return version;
}

/** All CCD records, at most CCD_REFRESH_TTL_MS stale. The returned array keeps
 *  its identity while nothing on disk changed. */
export async function readCcdRecentsCached(nowMs: number): Promise<CcdSessionMeta[]> {
  await refreshCcdIndex(nowMs);
  return records;
}

let cachedMap: { records: CcdSessionMeta[]; byCli: Map<string, CcdSessionMeta> } | null = null;

/** cliSessionId → CCD metadata, derived from the indexed records (the map is
 *  rebuilt only when the records array identity changes). */
export async function getCcdRecentsByCliId(
  nowMs: number,
): Promise<Map<string, CcdSessionMeta>> {
  const current = await readCcdRecentsCached(nowMs);
  if (cachedMap && cachedMap.records === current) return cachedMap.byCli;
  const byCli = new Map<string, CcdSessionMeta>();
  for (const r of current) {
    if (r.cliSessionId) byCli.set(r.cliSessionId, r);
  }
  cachedMap = { records: current, byCli };
  return byCli;
}
