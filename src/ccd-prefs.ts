// Read Claude Code Desktop's sidebar grouping straight off its leveldb.
//
// CCD persists its custom groups in a Zustand slice inside Chromium Local
// Storage. We scan the leveldb .log/.ldb files raw for the value bytes — far
// cheaper than a real leveldb client and it sidesteps Chromium's custom
// comparator.
//
// The slice was historically keyed `dframe-store`; newer CCD builds renamed it
// to `frame-store` (the grouping config moved with it, while a vestigial
// `dframe-store` now holds only an unrelated `mru` list). We search for
// `frame-store`, which substring-matches BOTH the current `frame-store` key and
// the legacy `dframe-store` key — so one scan covers old and new builds — and a
// shape guard skips any matched value that isn't the grouping slice (the leftover
// `dframe-store` {mru}, or any other `*frame-store`). When CCD renamed the slice
// without this fix, the reader latched onto the stale {mru} value and reported no
// grouping, which dropped /vision/sessions back to its by-repo fallback.
//
// Every reader degrades to null/empty when the directory is absent (CCD not
// installed, or a platform CCD doesn't ship on). The scan itself is raw byte
// matching, so it is platform-independent once the path is right.

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { leveldbScanBuffers } from "./ccd-leveldb.js";
import { ccdAppDir, ccdSessionsFingerprint, readCcdRecentsCached } from "./ccd.js";
import type { HxCcdGroupMirrorBlob, HxCcdGroup } from "./mirror-types.js";

const CCD_ROOT = ccdAppDir();
let LS_DIR = CCD_ROOT === null ? null : path.join(CCD_ROOT, "Local Storage", "leveldb");

/** Test seam — point the Local Storage leveldb at a fixture dir (null
 *  restores the platform default) and drop the mirror cache. */
export function setCcdLeveldbDirForTests(dir: string | null): void {
  LS_DIR = dir ?? (CCD_ROOT === null ? null : path.join(CCD_ROOT, "Local Storage", "leveldb"));
  mirrorCache = null;
}

interface DframeState {
  groupByByMode?: { code?: string | null };
  customGroups?: Array<{
    id?: string;
    name?: string;
    subtitle?: string | null;
    sectionName?: string | null;
  }>;
  customGroupOrder?: Record<string, string[]>;
  customGroupAssignments?: Record<string, string>;
  collapsedGroups?: string[];
}

// Is this parsed `state` the grouping slice (vs. the vestigial `dframe-store`
// {mru} value, or some other `*frame-store` we happened to match)? The grouping
// slice always carries the custom-group fields even when grouping is off.
function isGroupingState(state: DframeState | undefined | null): state is DframeState {
  return !!state && (Array.isArray(state.customGroups) || state.groupByByMode != null);
}

// Find the grouping `frame-store` value in one scannable buffer (a .log file or
// a decompressed .ldb data block) and return its parsed `state`, or null. The
// key+value live together in one block, so balancing braces to the buffer end
// recovers the whole value even across a multi-KB group list. `frame-store`
// substring-matches the legacy `dframe-store` key too; the shape guard skips any
// matched value that isn't the grouping slice so the stale `dframe-store` {mru}
// never wins.
function scanBufferForDframe(buf: Buffer): DframeState | null {
  const KEY = Buffer.from("frame-store", "utf8");
  let idx = 0;
  while ((idx = buf.indexOf(KEY, idx)) !== -1) {
    const scan = buf.subarray(idx + KEY.length);
    const stateOpen = scan.indexOf('{"state":');
    if (stateOpen >= 0) {
      let depth = 0;
      let endAt = -1;
      for (let j = stateOpen; j < scan.length; j++) {
        const c = scan[j];
        if (c === 0x7b /* { */) depth++;
        else if (c === 0x7d /* } */) {
          depth--;
          if (depth === 0) {
            endAt = j;
            break;
          }
        }
      }
      if (endAt > stateOpen) {
        try {
          const obj = JSON.parse(scan.subarray(stateOpen, endAt + 1).toString("utf8")) as {
            state?: DframeState;
          };
          if (isGroupingState(obj?.state)) return obj.state;
        } catch {
          /* not the value we want; keep scanning */
        }
      }
    }
    idx += KEY.length;
  }
  return null;
}

/** Find `unreadIds` in one scannable buffer — CCD's blue-dot sessions, stored
 *  under `epitaxy-unread-v1` (any wrapper key: the `"unreadIds":[…]` array is
 *  the signature). Returns null to keep scanning older buffers (no match, or
 *  a torn/unparseable match — same continue-scanning rule as before). */
function scanBufferForUnread(buf: Buffer): string[] | null {
  const m = buf.toString("utf8").match(/"unreadIds":\s*\[([^\]]{0,8000})\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse("[" + m[1] + "]") as unknown[];
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    /* torn match — keep scanning */
  }
  return null;
}

/**
 * ONE pass over the leveldb for BOTH readers (grouping slice + unreadIds) —
 * historically each reader iterated (and snappy-decompressed) every buffer
 * independently, doubling the scan. Newest file first, first parseable hit
 * wins per reader — identical results to the two independent scans, since
 * both consumed the same newest-first order and took their first hit.
 */
async function scanLeveldbOnce(): Promise<{ dframe: DframeState | null; unreadIds: string[] }> {
  if (LS_DIR === null) return { dframe: null, unreadIds: [] };
  let dframe: DframeState | null = null;
  let unread: string[] | null = null;
  for await (const buf of leveldbScanBuffers(LS_DIR)) {
    if (!dframe) dframe = scanBufferForDframe(buf);
    if (!unread) unread = scanBufferForUnread(buf);
    if (dframe && unread) break;
  }
  return { dframe, unreadIds: unread ?? [] };
}

/** Cheap change fingerprint over the leveldb dir: (name, size, mtime) of every
 *  .log/.ldb, sorted. Any Local Storage write lands in a .log (and compaction
 *  rewrites the file set), so an unchanged fingerprint means an unchanged
 *  store — the expensive decompress-and-scan can be skipped entirely. */
async function leveldbFingerprint(): Promise<string | null> {
  const dir = LS_DIR;
  if (dir === null) return null;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const parts = await Promise.all(
    files
      .filter((f) => f.endsWith(".log") || f.endsWith(".ldb"))
      .map(async (f) => {
        try {
          const st = await stat(path.join(dir, f));
          return `${f}:${st.size}:${st.mtimeMs}`;
        } catch {
          return `${f}:gone`;
        }
      }),
  );
  return parts.sort().join("|");
}

function stripCodePrefix(s: string): string {
  return s.replace(/^code:/, "");
}

// Change gate: both sources fingerprinted by stats alone (a readdir + a stat
// per file) before any byte is read or decompressed. Unchanged fingerprints
// return the cached blob — the 20 s cadence then costs stats, not scans. The
// caller's content-hash gate (syncGroupMirror) is unaffected: it already
// excludes the volatile syncedAtMs, so a re-stamped cached blob never uploads.
let mirrorCache: { ldbFp: string | null; sessFp: string; blob: HxCcdGroupMirrorBlob } | null = null;

/**
 * Assemble the CCD sidebar mirror the gateway stores. Returns a disabled-empty
 * mirror when CCD isn't in "Group by: Custom" mode or nothing could be read —
 * the UI then falls back to its own grouping dimensions.
 */
export async function buildGroupMirror(nowMs: number): Promise<HxCcdGroupMirrorBlob> {
  const empty: HxCcdGroupMirrorBlob = {
    groupingEnabled: false,
    groups: [],
    unreadIds: [],
    note: "no CCD custom grouping",
    syncedAtMs: nowMs,
  };

  let ldbFp: string | null = null;
  let sessFp = "";
  try {
    [ldbFp, sessFp] = await Promise.all([leveldbFingerprint(), ccdSessionsFingerprint()]);
    if (mirrorCache && mirrorCache.ldbFp === ldbFp && mirrorCache.sessFp === sessFp) {
      return { ...mirrorCache.blob, syncedAtMs: nowMs };
    }
  } catch {
    // Fingerprinting failed — fall through to the full read (never worse than
    // the ungated behavior).
  }

  let dframe: DframeState | null;
  let unreadIds: string[];
  try {
    ({ dframe, unreadIds } = await scanLeveldbOnce());
  } catch {
    return empty;
  }

  const enabled = dframe?.groupByByMode?.code === "custom";
  if (!enabled || !Array.isArray(dframe?.customGroups) || dframe.customGroups.length === 0) {
    const blob = { ...empty, unreadIds: (unreadIds ?? []).map(stripCodePrefix) };
    mirrorCache = { ldbFp, sessFp, blob };
    return blob;
  }

  const collapsed = new Set(Array.isArray(dframe.collapsedGroups) ? dframe.collapsedGroups : []);
  const order = dframe.customGroupOrder ?? {};
  const assignments = dframe.customGroupAssignments ?? {};

  // Per-group ordered ccdSessionId list: seed from CCD's order, then fold in any
  // assignment the order list missed (the two can drift).
  const byGroup = new Map<string, string[]>();
  for (const g of dframe.customGroups) if (g.id) byGroup.set(g.id, []);
  for (const [gid, ids] of Object.entries(order)) {
    const arr = byGroup.get(gid);
    if (!arr) continue;
    for (const raw of ids) arr.push(stripCodePrefix(raw));
  }
  for (const [rawSid, gid] of Object.entries(assignments)) {
    const sid = stripCodePrefix(rawSid);
    const arr = byGroup.get(gid);
    if (arr && !arr.includes(sid)) arr.push(sid);
  }

  // CCD references its sessions by an internal id ("local_<uuid>"), but the
  // workbench keys each session by the cli/jsonl sessionId. The ccdSessionId
  // link is only stamped on a session's *next* upload, so the bulk of
  // already-synced sessions carry no ccdSessionId and would never match a group
  // — dropping the whole list back to the by-repo fallback. Resolve each id to
  // the cli sessionId here (we already read CCD's per-session metadata for
  // titles), which the workbench can match against the always-present
  // session.sessionId. An id that can't be resolved keeps its local_<uuid> form
  // so a freshly-stamped session still matches via the ccdSessionId fallback.
  const cliByCcd = new Map<string, string>();
  try {
    // Cached — but pinned to THIS rebuild's fresh fingerprint: passing sessFp
    // forces a refresh when the TTL-cached records predate the change that
    // triggered this rebuild (they'd otherwise be cached under the fresh
    // fingerprint and never corrected).
    for (const r of await readCcdRecentsCached(nowMs, sessFp || undefined)) {
      if (r.cliSessionId) cliByCcd.set(r.ccdSessionId, r.cliSessionId);
    }
  } catch {
    /* no CCD session metadata — fall back to the local_<uuid> ids */
  }
  const toCli = (localId: string): string => cliByCcd.get(localId) ?? localId;

  const groups: HxCcdGroup[] = dframe.customGroups
    .filter((g): g is { id: string; name?: string; subtitle?: string | null; sectionName?: string | null } => !!g.id)
    .map((g) => ({
      id: g.id,
      name: g.name?.trim() || "Group",
      subtitle: g.subtitle ?? null,
      sectionName: g.sectionName ?? null,
      collapsed: collapsed.has(g.id),
      sessionIds: (byGroup.get(g.id) ?? []).map(toCli),
    }));

  const blob: HxCcdGroupMirrorBlob = {
    groupingEnabled: true,
    groups,
    unreadIds: (unreadIds ?? []).map(stripCodePrefix).map(toCli),
    note: `CCD custom grouping: ${groups.length} groups`,
    syncedAtMs: nowMs,
  };
  mirrorCache = { ldbFp, sessFp, blob };
  return blob;
}
