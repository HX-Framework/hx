// Read Claude Code Desktop's sidebar grouping straight off its leveldb.
//
// CCD persists its sidebar in a Zustand slice inside Chromium Local Storage.
// Builds have kept it under `dframe-store` and under `frame-store` (and a
// leftover of one can sit beside the live one, like the old `dframe-store`
// that held only an `mru` list); a shape guard skips any value that is not the
// sidebar state. Three layouts of that state:
//
//   • sections (current builds): everything is kept PER ACCOUNT SCOPE, a key
//     `<accountId>/<orgId>`, and `lastSidebarScopeKey` names the live one.
//     `codeSidebarByScope[scope].sections` is what the sidebar DRAWS: built-in
//     sections plus one `kind: "manual"` section per custom group, with its
//     place (`order`), its collapse state, its sort and its members.
//     `customGroupsByScope[scope]` keeps the groups too, but in creation
//     order, and its `order` lists keep a session in the group it was moved
//     out of; it is read only for what a section lacks.
//   • scoped-groups: `customGroupsByScope` with no sections.
//   • flat-groups (older builds): `customGroups`, `customGroupOrder` and
//     `customGroupAssignments`, read exactly as before.
//
// The mirror is the live scope's groups only. Another account's groups on this
// Mac, or groups a dead scope still holds long after they were deleted, never
// reach it; switching accounts in CCD switches the mirror.
//
// The value is read by leveldb sequence number (readLeveldbKeys in
// ccd-leveldb.ts), so the newest write wins wherever it sits. A store with no
// such key at all (not real leveldb: the tests' hand-written logs) falls back
// to the byte scan, which takes the first match newest file first.
//
// Every reader degrades to null/empty when the directory is absent (CCD not
// installed, or a platform CCD doesn't ship on).

import { createHash } from "node:crypto";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import {
  LeveldbKeyReader,
  decodeLocalStorageValue,
  isNewerRecord,
  leveldbScanBuffers,
  localStorageKeyMatcher,
  localStorageKeyName,
  readLeveldbValue,
  type LeveldbRecord,
} from "./ccd-leveldb.js";
import { ccdAppDir, readCcdRecentsCached, refreshCcdIndex } from "./ccd.js";
import type { HxCcdGroupMirrorBlob, HxCcdGroup } from "./mirror-types.js";

const CCD_ROOT = ccdAppDir();
let LS_DIR = CCD_ROOT === null ? null : path.join(CCD_ROOT, "Local Storage", "leveldb");

/** The Local Storage keys of the sidebar state, newest builds first. */
const SIDEBAR_KEYS = ["dframe-store", "frame-store"];
/** The Local Storage key of CCD's blue-dot (unread) sessions. */
const UNREAD_KEY = "epitaxy-unread-v1";

/** Test seam — point the Local Storage leveldb at a fixture dir (null
 *  restores the platform default) and drop the mirror cache. */
export function setCcdLeveldbDirForTests(dir: string | null): void {
  LS_DIR = dir ?? (CCD_ROOT === null ? null : path.join(CCD_ROOT, "Local Storage", "leveldb"));
  mirrorCache = null;
  mirrorInFlight = null;
  keyReader = null;
  viewCache = null;
}

/** The Local Storage leveldb directory read, or null when CCD has none here. */
export function ccdLeveldbDir(): string | null {
  return LS_DIR;
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
  customGroupsByScope?: unknown;
  codeSidebarByScope?: unknown;
  lastSidebarScopeKey?: unknown;
  recentsStatusFilter?: unknown;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `container[key]` when it is the container's own property and an object. */
function ownObj(container: unknown, key: string): Obj | null {
  if (!isObj(container) || !Object.prototype.hasOwnProperty.call(container, key)) return null;
  const v = container[key];
  return isObj(v) ? v : null;
}

// Is this parsed `state` the grouping slice (vs. the vestigial `dframe-store`
// {mru} value, or some other `*frame-store` we happened to match)? The grouping
// slice always carries the custom-group fields even when grouping is off.
function isGroupingState(state: DframeState | undefined | null): state is DframeState {
  return (
    !!state &&
    (Array.isArray(state.customGroups) ||
      state.groupByByMode != null ||
      isObj(state.customGroupsByScope) ||
      isObj(state.codeSidebarByScope))
  );
}

// Find the grouping `frame-store` value in one scannable buffer (a .log file or
// a decompressed .ldb data block) and return its parsed `state`, or null. The
// key+value live together in one block, so balancing braces to the buffer end
// recovers the whole value even across a multi-KB group list. `frame-store`
// substring-matches the legacy `dframe-store` key too; the shape guard skips any
// matched value that isn't the grouping slice so the stale `dframe-store` {mru}
// never wins. The fallback for a store with no sidebar key (see the top).
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
 *  a torn/unparseable match — same continue-scanning rule as before). The
 *  fallback for a store with no `epitaxy-unread-v1` key. */
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

/** The byte scan: ONE pass over the leveldb for both readers, newest file
 *  first, first parseable hit per reader. */
async function scanLeveldbOnce(dir: string, wantDframe: boolean, wantUnread: boolean): Promise<{ dframe: DframeState | null; unreadIds: string[] | null }> {
  let dframe: DframeState | null = null;
  let unread: string[] | null = null;
  for await (const buf of leveldbScanBuffers(dir)) {
    if (wantDframe && !dframe) dframe = scanBufferForDframe(buf);
    if (wantUnread && !unread) unread = scanBufferForUnread(buf);
    if ((!wantDframe || dframe) && (!wantUnread || unread)) break;
  }
  return { dframe, unreadIds: unread };
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

// ── The sidebar view: what the mirror needs from the state ─────────────────

/** A group as CCD's state describes it, members still CCD ids. */
interface ViewGroup {
  id: string;
  name: string;
  subtitle: unknown;
  sectionName: unknown;
  collapsed: boolean;
  members: string[];
  /** The scoped layouts only: the section's sort, whether it is switched on,
   *  and whether CCD shows it with nothing left to show. */
  sortBy?: string | null;
  ascending?: boolean | null;
  shown?: boolean;
  showEmpty?: boolean;
}

interface SidebarView {
  enabled: boolean;
  /** null for the flat layout, whose blob keeps its old shape exactly. */
  layout: "sections" | "scoped-groups" | null;
  groups: ViewGroup[];
  statusFilter: string | null;
  /** The live scope key, hashed (sha256, first 16 hex). */
  scope: string | null;
  note: string;
}

const DISABLED_NOTE = "no CCD custom grouping";

/** The trimmed name, or null when it is not a string or is blank. */
function trimmedName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Strip `code:` and drop repeats, first place kept. */
function memberIds(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const id = stripCodePrefix(r);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A scoped group's members from `customGroupsByScope[scope]`: `assignments`
 *  says which group a session is in; `order` gives the order, read only for
 *  sessions still assigned to the group. */
function scopedMembers(g1: Obj | null, gid: string): string[] {
  const assignments = g1 && isObj(g1.assignments) ? g1.assignments : {};
  const order = g1 && isObj(g1.order) ? g1.order : {};
  const listed = Object.prototype.hasOwnProperty.call(order, gid) && Array.isArray(order[gid]) ? (order[gid] as unknown[]) : [];
  const raw: unknown[] = [];
  for (const r of listed) {
    if (typeof r === "string" && Object.prototype.hasOwnProperty.call(assignments, r) && assignments[r] === gid) raw.push(r);
  }
  for (const [r, g] of Object.entries(assignments)) if (g === gid) raw.push(r);
  return memberIds(raw);
}

function resolveScoped(state: DframeState): SidebarView {
  const statusFilter = typeof state.recentsStatusFilter === "string" ? state.recentsStatusFilter : null;
  const scopeKey = typeof state.lastSidebarScopeKey === "string" && state.lastSidebarScopeKey !== "" ? state.lastSidebarScopeKey : null;
  if (scopeKey === null) {
    return { enabled: false, layout: "sections", groups: [], statusFilter, scope: null, note: "no live CCD sidebar scope" };
  }
  const scope = createHash("sha256").update(scopeKey).digest("hex").slice(0, 16);
  const g1 = ownObj(state.customGroupsByScope, scopeKey);
  const v1Groups = g1 && Array.isArray(g1.groups) ? (g1.groups as unknown[]) : [];
  const sb = ownObj(state.codeSidebarByScope, scopeKey);
  const sections = sb && Array.isArray(sb.sections) ? (sb.sections as unknown[]) : null;

  if (sections !== null) {
    // What the sidebar draws: the manual sections in their `order` (array
    // position breaks ties and places a section with no number last).
    const manual: Array<{ s: Obj; i: number; order: number }> = [];
    sections.forEach((s, i) => {
      if (isObj(s) && s.kind === "manual" && typeof s.id === "string" && s.id !== "") {
        manual.push({ s, i, order: typeof s.order === "number" && Number.isFinite(s.order) ? s.order : Infinity });
      }
    });
    manual.sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.i - b.i));
    const groups: ViewGroup[] = [];
    const seen = new Set<string>();
    for (const { s } of manual) {
      const id = s.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const v1 = v1Groups.find((g): g is Obj => isObj(g) && g.id === id) ?? null;
      groups.push({
        id,
        name: trimmedName(s.name) ?? trimmedName(v1?.name) ?? "Group",
        subtitle: v1 && typeof v1.subtitle === "string" ? v1.subtitle : null,
        sectionName: null,
        collapsed: s.collapsed === true,
        members: Array.isArray(s.members) ? memberIds(s.members as unknown[]) : scopedMembers(g1, id),
        sortBy: typeof s.sortBy === "string" ? s.sortBy : null,
        ascending: typeof s.ascending === "boolean" ? s.ascending : null,
        shown: s.shown !== false,
        showEmpty: isObj(s.show) && s.show.emptyGroups === true,
      });
    }
    if (groups.length === 0) {
      return { enabled: false, layout: "sections", groups: [], statusFilter, scope, note: "no CCD custom groups in the live account" };
    }
    return { enabled: true, layout: "sections", groups, statusFilter, scope, note: `CCD sidebar: ${groups.length} groups` };
  }

  // No sections for this scope: the scoped group list, while CCD groups by it.
  const custom = isObj(state.groupByByMode) && state.groupByByMode.code === "custom";
  const collapsed = Array.isArray(state.collapsedGroups) ? state.collapsedGroups.filter((c): c is string => typeof c === "string") : [];
  const groups: ViewGroup[] = [];
  if (custom) {
    const seen = new Set<string>();
    for (const g of v1Groups) {
      if (!isObj(g) || typeof g.id !== "string" || g.id === "" || seen.has(g.id)) continue;
      const id = g.id;
      seen.add(id);
      groups.push({
        id,
        name: trimmedName(g.name) ?? "Group",
        subtitle: typeof g.subtitle === "string" ? g.subtitle : null,
        sectionName: typeof g.sectionName === "string" ? g.sectionName : null,
        collapsed: collapsed.includes(id) || collapsed.includes(`custom-${id}`),
        members: scopedMembers(g1, id),
        sortBy: null,
        ascending: null,
        shown: true,
        showEmpty: false,
      });
    }
  }
  if (groups.length === 0) {
    return { enabled: false, layout: "scoped-groups", groups: [], statusFilter, scope, note: "no CCD custom groups in the live account" };
  }
  return { enabled: true, layout: "scoped-groups", groups, statusFilter, scope, note: `CCD custom grouping: ${groups.length} groups` };
}

/** The flat layout of older builds, read exactly as the client always has. */
function resolveFlat(dframe: DframeState): SidebarView {
  const enabled = dframe.groupByByMode?.code === "custom";
  if (!enabled || !Array.isArray(dframe.customGroups) || dframe.customGroups.length === 0) {
    return { enabled: false, layout: null, groups: [], statusFilter: null, scope: null, note: DISABLED_NOTE };
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

  const groups: ViewGroup[] = dframe.customGroups
    .filter((g): g is { id: string; name?: string; subtitle?: string | null; sectionName?: string | null } => !!g.id)
    .map((g) => ({
      id: g.id,
      name: g.name?.trim() || "Group",
      subtitle: g.subtitle ?? null,
      sectionName: g.sectionName ?? null,
      collapsed: collapsed.has(g.id),
      members: byGroup.get(g.id) ?? [],
    }));
  return { enabled: true, layout: null, groups, statusFilter: null, scope: null, note: `CCD custom grouping: ${groups.length} groups` };
}

function resolveView(state: DframeState): SidebarView {
  if (isObj(state.customGroupsByScope) || isObj(state.codeSidebarByScope)) return resolveScoped(state);
  return resolveFlat(state);
}

// ── Reading the store ──────────────────────────────────────────────────────

let keyReader: LeveldbKeyReader | null = null;
function readerFor(dir: string): LeveldbKeyReader {
  if (keyReader === null || keyReader.dir !== dir) {
    keyReader = new LeveldbKeyReader(dir, localStorageKeyMatcher([...SIDEBAR_KEYS, UNREAD_KEY]));
  }
  return keyReader;
}

function recordId(r: LeveldbRecord): string {
  return `${r.file}\u0000${r.block}\u0000${r.at}\u0000${r.seq}\u0000${r.key}`;
}

/** The parsed JSON object of a record's value: undefined when the file moved
 *  under the read (read the store again), null when it is not such a value. */
async function readRecordJson(dir: string, r: LeveldbRecord): Promise<Obj | null | undefined> {
  const raw = await readLeveldbValue(dir, r);
  if (raw === null) return undefined;
  const text = decodeLocalStorageValue(raw);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The view of the newest record that holds the sidebar state, by record:
 *  the 1.6 MB value is parsed once per write, not once per read. */
let viewCache: { id: string; view: SidebarView } | null = null;

/** The sidebar view and the unread ids. `view` is null when the store holds no
 *  sidebar state at all. */
async function readStore(dir: string): Promise<{ view: SidebarView | null; unreadIds: string[] }> {
  for (let attempt = 0; ; attempt++) {
    const recs = await readerFor(dir).newest();
    const sidebar: LeveldbRecord[] = [];
    const unread: LeveldbRecord[] = [];
    for (const r of recs.values()) {
      const name = localStorageKeyName(r.key);
      if (SIDEBAR_KEYS.includes(name)) sidebar.push(r);
      else if (name === UNREAD_KEY) unread.push(r);
    }
    const scan = sidebar.length === 0 || unread.length === 0 ? await scanLeveldbOnce(dir, sidebar.length === 0, unread.length === 0) : null;

    let moved = false;
    let view: SidebarView | null = null;
    if (sidebar.length === 0) {
      view = scan?.dframe ? resolveView(scan.dframe) : null;
    } else {
      const live = sidebar.filter((r) => r.live).sort((a, b) => (isNewerRecord(a, b) ? -1 : isNewerRecord(b, a) ? 1 : 0));
      for (const r of live) {
        const id = recordId(r);
        if (viewCache && viewCache.id === id) {
          view = viewCache.view;
          break;
        }
        const obj = await readRecordJson(dir, r);
        if (obj === undefined) {
          moved = true;
          break;
        }
        const state = obj && isObj(obj.state) ? (obj.state as DframeState) : null;
        if (!isGroupingState(state)) continue;
        view = resolveView(state);
        viewCache = { id, view };
        break;
      }
    }

    let unreadIds: string[] = [];
    if (unread.length === 0) {
      unreadIds = scan?.unreadIds ?? [];
    } else {
      const newest = unread.filter((r) => r.live).sort((a, b) => (isNewerRecord(a, b) ? -1 : isNewerRecord(b, a) ? 1 : 0))[0];
      if (newest) {
        const obj = await readRecordJson(dir, newest);
        if (obj === undefined) moved = true;
        else if (obj && isObj(obj.state) && Array.isArray(obj.state.unreadIds)) {
          unreadIds = (obj.state.unreadIds as unknown[]).filter((x): x is string => typeof x === "string");
        }
      }
    }
    if (!moved || attempt >= 2) return { view, unreadIds };
  }
}

// ── The mirror ─────────────────────────────────────────────────────────────

// Change gate: the leveldb is fingerprinted by stats alone (a readdir + a stat
// per file) and the session store is answered by the incremental index's
// version, so an unchanged pair returns the cached blob — the 20 s cadence
// then costs a dozen stats, not scans. The caller's content-hash gate
// (syncGroupMirror) is unaffected: it already excludes the volatile
// syncedAtMs, so a re-stamped cached blob never uploads.
let mirrorCache: { ldbFp: string | null; indexVersion: number; blob: HxCcdGroupMirrorBlob } | null = null;
// Single-flight: the daemon fires this on a timer regardless of whether the
// previous build finished. A build slowed by a loaded machine must join the
// one in flight, never stack a second scan on top of it.
let mirrorInFlight: Promise<HxCcdGroupMirrorBlob> | null = null;

/**
 * Assemble the CCD sidebar mirror the gateway stores. Returns a disabled-empty
 * mirror when CCD shows no custom groups or nothing could be read — the UI then
 * falls back to its own grouping dimensions.
 */
export function buildGroupMirror(nowMs: number): Promise<HxCcdGroupMirrorBlob> {
  if (mirrorInFlight) return mirrorInFlight.then((blob) => ({ ...blob, syncedAtMs: nowMs }));
  // Cleared by .finally() on the promise, never inside buildGroupMirrorNow:
  // see singleFlight in upload-scheduler.ts for why.
  mirrorInFlight = buildGroupMirrorNow(nowMs).finally(() => {
    mirrorInFlight = null;
  });
  return mirrorInFlight;
}

async function buildGroupMirrorNow(nowMs: number): Promise<HxCcdGroupMirrorBlob> {
  const empty: HxCcdGroupMirrorBlob = {
    groupingEnabled: false,
    groups: [],
    unreadIds: [],
    note: DISABLED_NOTE,
    syncedAtMs: nowMs,
  };

  let ldbFp: string | null = null;
  let indexVersion = -1;
  try {
    [ldbFp, indexVersion] = await Promise.all([leveldbFingerprint(), refreshCcdIndex(nowMs)]);
    if (mirrorCache && mirrorCache.ldbFp === ldbFp && mirrorCache.indexVersion === indexVersion) {
      return { ...mirrorCache.blob, syncedAtMs: nowMs };
    }
  } catch {
    // Fingerprinting failed — fall through to the full read (never worse than
    // the ungated behavior).
  }

  if (LS_DIR === null) return empty;
  let view: SidebarView | null;
  let unreadIds: string[];
  try {
    ({ view, unreadIds } = await readStore(LS_DIR));
  } catch {
    return empty;
  }

  // The scoped layouts name the layout, the view filter and the live account
  // (hashed) even when the account has no groups, so a reader can tell an
  // empty account from a client that predates them.
  const scoped = (blob: HxCcdGroupMirrorBlob, v: SidebarView): HxCcdGroupMirrorBlob =>
    v.layout === null ? blob : { ...blob, layout: v.layout, statusFilter: v.statusFilter, scope: v.scope };

  if (view === null || !view.enabled) {
    const base: HxCcdGroupMirrorBlob = { ...empty, unreadIds: (unreadIds ?? []).map(stripCodePrefix) };
    const blob = view === null ? base : scoped({ ...base, note: view.note }, view);
    mirrorCache = { ldbFp, indexVersion, blob };
    return blob;
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
    // The index was refreshed above, so this is the mapping as of
    // `indexVersion` — exactly what the cache entry below is keyed by.
    for (const r of await readCcdRecentsCached(nowMs)) {
      if (r.cliSessionId) cliByCcd.set(r.ccdSessionId, r.cliSessionId);
    }
  } catch {
    /* no CCD session metadata — fall back to the local_<uuid> ids */
  }
  const toCli = (localId: string): string => cliByCcd.get(localId) ?? localId;

  const groups: HxCcdGroup[] = view.groups.map((g) => {
    const out: HxCcdGroup = {
      id: g.id,
      name: g.name,
      subtitle: g.subtitle as string | null,
      sectionName: g.sectionName as string | null,
      collapsed: g.collapsed,
      sessionIds: g.members.map(toCli),
    };
    if (view.layout !== null) {
      out.sortBy = g.sortBy ?? null;
      out.ascending = g.ascending ?? null;
      out.shown = g.shown ?? true;
      out.showEmpty = g.showEmpty ?? false;
    }
    return out;
  });

  const blob = scoped(
    {
      groupingEnabled: true,
      groups,
      unreadIds: (unreadIds ?? []).map(stripCodePrefix).map(toCli),
      note: view.note,
      syncedAtMs: nowMs,
    },
    view,
  );
  mirrorCache = { ldbFp, indexVersion, blob };
  return blob;
}

// ── Watching the store ─────────────────────────────────────────────────────

/** A burst of writes settles this long before the mirror is read. */
export const CCD_STORE_DEBOUNCE_MS = 200;
/** A store written without pause is still read this often. */
export const CCD_STORE_MAX_WAIT_MS = 1_000;

/**
 * Call `onChange` when the Local Storage leveldb changes: every write CCD
 * commits lands in a .log (and a compaction rewrites .ldb files), so a write
 * reaches the mirror within about a second instead of at the next 20 s tick.
 * Events are debounced (CCD_STORE_DEBOUNCE_MS after the last, at most
 * CCD_STORE_MAX_WAIT_MS after the first). Returns null when there is no store
 * to watch; a watch that fails closes and reports through `onFailure`, and the
 * caller's timer keeps the mirror current at its own pace.
 */
export function watchCcdSidebarStore(onChange: () => void, onFailure: (reason: string) => void): { close(): void } | null {
  const dir = LS_DIR;
  if (dir === null) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAtMs = 0;
  let w: FSWatcher | null = null;
  const close = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      w?.close();
    } catch {
      // closing is best-effort
    }
    w = null;
  };
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- CCD's Local Storage leveldb
    w = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (name !== "" && !name.endsWith(".log") && !name.endsWith(".ldb")) return;
      const now = Date.now();
      if (timer === null) firstAtMs = now;
      else clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          onChange();
        },
        Math.max(0, Math.min(CCD_STORE_DEBOUNCE_MS, firstAtMs + CCD_STORE_MAX_WAIT_MS - now)),
      );
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    onFailure(`${dir}: ${(err as Error).message}`);
    return null;
  }
  w.on("error", (err) => {
    close();
    onFailure(`${dir}: ${err.message}`);
  });
  return { close };
}
