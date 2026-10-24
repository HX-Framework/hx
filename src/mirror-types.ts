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
   *  sessions ("created", "recency", "alpha"…; null when it does not say):
   *  the members above are in stored order, never sorted by activity here, so
   *  session activity never changes the blob. */
  sortBy?: string | null;
  ascending?: boolean | null;
  /** false: the user switched the group's section off, and CCD does not draw it. */
  shown?: boolean;
  /** CCD's "show empty groups" for the section: false hides the section when
   *  no session it would show is left (archived ones are hidden by statusFilter). */
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
}
