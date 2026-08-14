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
}

export interface HxCcdGroupMirrorBlob {
  groupingEnabled: boolean;
  groups: HxCcdGroup[];
  unreadIds: string[];
  note?: string | null;
  syncedAtMs?: number | null;
}
