// Shape of the CCD sidebar group mirror the daemon uploads. Defined here (not
// imported from the server) so the daemon has no server-side dependency; the
// gateway's own schema for this blob must stay in sync with this.

export interface HxCcdGroup {
  /** CCD's group id (e.g. "cg-<uuid>"). */
  id: string;
  name: string;
  subtitle?: string | null;
  sectionName?: string | null;
  collapsed: boolean;
  /** Member sessions in CCD's order, as cli/jsonl sessionIds (what the workbench
   *  keys sessions by). Resolved from CCD's internal "local_<uuid>" ids; an id
   *  that couldn't be resolved keeps its "local_<uuid>" form as a fallback. */
  sessionIds: string[];
  /** The scoped layouts only (blob `layout` set). How CCD sorts the group's
   *  sessions ("created", "recency" or "alpha"; null when it does not say),
   *  and the direction the rows are drawn in (true: oldest first, A to Z).
   *  For "alpha" CCD stores the opposite direction; this is the drawn one.
   *  The members above are in stored order, never sorted by activity here, so
   *  session activity never changes the blob. */
  sortBy?: string | null;
  ascending?: boolean | null;
  /** false: CCD does not draw the group's section. Current builds draw every
   *  group's section (only Routines can be switched off), so the sections
   *  layout always sends true. */
  shown?: boolean;
  /** CCD's "show empty groups", one setting for every group: false hides a
   *  group when no session it would show is left (archived ones are hidden
   *  by statusFilter). */
  showEmpty?: boolean;
}

export interface HxCcdGroupMirrorBlob {
  groupingEnabled: boolean;
  /** The live CCD account's groups, in the order CCD draws them. */
  groups: HxCcdGroup[];
  unreadIds: string[];
  note?: string | null;
  syncedAtMs?: number | null;
  /** Which layout of CCD's store was read: "sections" (current builds: the
   *  drawn sections of the live account) or "scoped-groups" (per-account group
   *  lists with no sections). Absent for the flat layout of older builds. */
  layout?: "sections" | "scoped-groups";
  /** CCD's session filter for its sidebar ("active" hides archived sessions),
   *  or null. Present with `layout`. */
  statusFilter?: string | null;
  /** The group members CCD has archived, in the id space of `sessionIds` (the
   *  server has no archived flag of its own, so this is what `statusFilter`
   *  hides). Present with `layout`. */
  archivedIds?: string[];
  /** The live CCD account, as the first 16 hex of sha256 of its scope key;
   *  changes when CCD switches accounts. Present with `layout`; null when CCD
   *  names no live account. */
  scope?: string | null;
  /** Codex Desktop's sidebar sections (codex-sections.ts). Absent when the
   *  Codex read failed, so the server keeps the last ones it had; null when no
   *  Codex home holds Codex's state. */
  codex?: HxCodexSidebarBlob | null;
}

/** One Codex Desktop sidebar section, in the group shape the mirror carries. */
export interface HxCodexSection {
  /** Codex's own section id (a UUID), or "pinned" for Codex's built-in Pinned list. */
  id: string;
  name: string;
  collapsed: boolean;
  /** Codex thread ids in Codex's order. A thread id is the rollout's
   *  session_meta id, which is the sessionId hx uploads the session under. */
  sessionIds: string[];
  /** Codex draws a section with no thread in it. */
  showEmpty: boolean;
}

/** Codex Desktop's sections, every one in Codex's sidebar order. hx leaves
 *  out the threads Codex's sidebar hides, so no status filter rides along. */
export interface HxCodexSidebarBlob {
  groups: HxCodexSection[];
}
