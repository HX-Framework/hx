// Three-step chunked upload:
//   1. POST /sessions/append-url     → { chunkId, uploadUrl }
//   2. PUT  <uploadUrl> <bytes>          (direct to GCS)
//   3. POST /sessions/commit         → gateway runs GCS Compose

import type { HxConfig } from "./config.js";
import type { Family } from "./sources.js";
import type { HxCcdGroupMirrorBlob } from "./mirror-types.js";
import type { SyncBlockerDetails, SyncBlockerDestination } from "./state.js";
import { assertSecureFetchUrl } from "./net.js";

/** One fan-out target for a chunk. `ready` carries a signed staging URL; `held`
 *  means that org's vault is offline right now — skip it this pass and retry. */
export type AppendDestination =
  | {
      vaultOrgId: string | null;
      chunkId: string;
      uploadUrl: string;
      objectName: string;
      expiresAt: string;
      status: "ready";
    }
  | (SyncBlockerDestination & { status: "held" });

export interface AppendUrlResponse {
  chunkId: string;
  uploadUrl: string;
  objectName: string;
  expiresAt: string;
  /** The store org the gateway resolved for this chunk (null = let.ai-hosted).
   *  Carried back at commit so both steps write to the same store. Absent from a
   *  gateway that predates per-session routing. */
  vaultOrgId?: string | null;
  /** Every distinct store this chunk should fan out to (the legacy fields above
   *  mirror the first ready one). Absent from a gateway that predates fan-out →
   *  treat as the single legacy destination. */
  destinations?: AppendDestination[];
}

export interface CommitMeta {
  sourcePath?: string;
  title?: string | null;
  /** CCD title provenance ("user" | "ai" | "fallback"). */
  titleSource?: "user" | "ai" | "fallback" | null;
  /** CCD's internal session id ("local_<uuid>") for group mapping. */
  ccdSessionId?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  /** Canonical lowercase `owner/name` GitHub slug for the session's repo. */
  repoSlug?: string | null;
  entrypoint?: string | null;
  originator?: string | null;
  modelProvider?: string | null;
  lastUserText?: string | null;
  lastAssistantText?: string | null;
  eventCount?: number;
  userTextCount?: number;
  assistantCount?: number;
  lastActivityAt?: string | null;
}

/**
 * HTTP failure from a gateway/storage call, carrying the status code so the
 * watcher can tell a wholesale outage from a single bad request.
 */
export class HxHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Sanitized routing/liveness metadata for a per-session hold. */
    public readonly blocker?: SyncBlockerDetails,
  ) {
    super(message);
    this.name = "HxHttpError";
  }

  /** 429 + 5xx mean the gateway/storage can't accept uploads right now (rate
   *  limit, vault offline, gateway down). The pipeline should pause and retry
   *  later rather than re-POST every pending file on every 1.5s poll. Other 4xx
   *  are per-request faults that shouldn't stall the whole daemon. */
  get serverUnavailable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** A 503 whose body names a PER-SESSION vault condition — `vault_offline`,
   *  or the MC-2602 `vault_home_unreachable` hold (home Fortress not
   *  connected): THIS session's vault is down while the gateway itself is
   *  healthy. Callers should skip just this file with a long per-file backoff
   *  instead of pausing the whole pass — other sessions (and other stores)
   *  keep uploading. */
  get vaultOffline(): boolean {
    return this.vaultBlockReason !== null;
  }

  /** The specific per-session hold named by a 503, or null when the 503 is
   *  (as far as this client can tell) the shared gateway itself. */
  get vaultBlockReason(): "vault_offline" | "vault_home_unreachable" | null {
    if (this.status !== 503) return null;
    if (
      this.blocker &&
      (this.blocker.reason === "vault_offline" || this.blocker.reason === "vault_home_unreachable")
    ) {
      return this.blocker.reason;
    }
    if (this.message.includes('"error":"vault_home_unreachable"')) return "vault_home_unreachable";
    if (this.message.includes("vault_offline")) return "vault_offline";
    return null;
  }

  /** 410 session_deleted: the session was PERMANENTLY deleted server-side. The
   *  one terminal per-session signal in the protocol — callers record it in
   *  state (deletedSessions) and never upload any lane of the session again.
   *  Retrying would only re-410 forever; re-uploading is exactly what the
   *  server-side tombstone exists to refuse. Same body from the cloud gateway
   *  and a fortress-direct gateway, so this is the single code path. */
  get sessionDeleted(): boolean {
    return this.status === 410 && this.message.includes("session_deleted");
  }
}

/** Reduce an untrusted gateway destination list to the fixed, non-sensitive
 * blocker allowlist used by state/status/doctor. */
export function vaultBlockerFromDestinations(destinations: unknown): SyncBlockerDetails | undefined {
  if (!Array.isArray(destinations)) return undefined;
  const sanitized = destinations.flatMap((raw): SyncBlockerDestination[] => {
    if (!raw || typeof raw !== "object") return [];
    const d = raw as Record<string, unknown>;
    const reason =
      d.reason === "vault_offline" || d.reason === "vault_home_unreachable" ? d.reason : null;
    if (typeof d.vaultOrgId !== "string" || reason === null) return [];
    const nullableString = (value: unknown): string | null =>
      typeof value === "string" ? value : null;
    return [{
      vaultOrgId: d.vaultOrgId,
      reason,
      orgName: nullableString(d.orgName),
      orgSlug: nullableString(d.orgSlug),
      projectId: nullableString(d.projectId),
      projectName: nullableString(d.projectName),
      projectSlug: nullableString(d.projectSlug),
      repoSlug: nullableString(d.repoSlug),
      lastSeenAt: nullableString(d.lastSeenAt),
    }];
  });
  return sanitized.length > 0
    ? {
        reason: sanitized.some((d) => d.reason === "vault_home_unreachable")
          ? "vault_home_unreachable"
          : "vault_offline",
        destinations: sanitized,
      }
    : undefined;
}

export async function throwHttp(res: Response, label: string): Promise<never> {
  const txt = await res.text().catch(() => "");
  let blocker: SyncBlockerDetails | undefined;
  try {
    const body = JSON.parse(txt) as { error?: unknown; vaultOrgId?: unknown; destinations?: unknown };
    if (body.error === "vault_offline" || body.error === "vault_home_unreachable") {
      blocker = vaultBlockerFromDestinations(body.destinations);
      // The MC-2602 hold answers `destinations: []` with the home vault named at
      // the top level — synthesize the single-entry blocker so status/doctor
      // can still name the org holding this session.
      if (!blocker && typeof body.vaultOrgId === "string" && body.vaultOrgId.length <= 128) {
        blocker = {
          reason: body.error,
          destinations: [{
            vaultOrgId: body.vaultOrgId,
            reason: body.error,
            orgName: null,
            orgSlug: null,
            projectId: null,
            projectName: null,
            projectSlug: null,
            repoSlug: null,
            lastSeenAt: null,
          }],
        };
      }
    }
  } catch {
    // Old gateways and storage services may return text/HTML. Keep the bounded
    // legacy message and simply omit structured diagnostics.
  }
  throw new HxHttpError(
    res.status,
    `${label} failed: ${res.status} ${txt.slice(0, 200)}`,
    blocker,
  );
}

function authHeaders(cfg: HxConfig): Record<string, string> {
  // Chokepoint for every token-bearing gateway POST in this module: the device
  // bearer token must never leave over cleartext. Assert the configured gateway
  // is https (loopback http excepted) here so a downgraded/hand-edited
  // `cfg.gatewayBaseUrl` fails closed before the token is put on the wire,
  // matching the guard resolveRoute already applies to the same URL.
  assertSecureFetchUrl(cfg.gatewayBaseUrl, "gateway request");
  return {
    authorization: `Bearer ${cfg.accessToken}`,
    "content-type": "application/json",
  };
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// Liveness ping the watcher sends on a timer (and once on start) so the
// gateway knows the daemon is alive even when there's nothing to upload.
// Best-effort: the caller swallows transient failures — the next beat, or any
// real upload, refreshes lastSeenAt just the same.
export async function sendHeartbeat(cfg: HxConfig): Promise<void> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/devices/heartbeat`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: "{}",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`heartbeat failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

/** Catch-up progress the watcher reports as it works through the on-disk
 *  backlog. `total`/`done` are session counts; `totalBytes` is the on-disk size
 *  of ALL those sessions (the whole payload — not the part already sent).
 *  Drives the Devices page + `hx status` sync indicators. */
export interface SyncSnapshot {
  total: number;
  done: number;
  totalBytes: number;
}

// Report the daemon's catch-up progress so the Devices page can show a sync
// bar while a freshly connected machine streams its history up. Best-effort,
// like the heartbeat — a dropped report just means the bar updates on the next
// one; the next real upload refreshes liveness regardless.
export async function sendSyncStatus(cfg: HxConfig, snap: SyncSnapshot): Promise<void> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/devices/sync-status`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`sync-status failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

export async function requestAppendUrl(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; byteCount: number; repoSlug?: string | null },
): Promise<AppendUrlResponse> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/append-url`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) await throwHttp(res, "append-url");
  return (await res.json()) as AppendUrlResponse;
}

export async function putChunk(uploadUrl: string, bytes: Buffer): Promise<void> {
  // `uploadUrl` is a signed target the gateway just handed us (append-url
  // response / a fan-out destination). It carries the session bytes, so refuse
  // to PUT it over cleartext to a non-loopback host — an impersonated gateway
  // could otherwise redirect an upload to http and exfiltrate transcripts.
  assertSecureFetchUrl(uploadUrl, "PUT chunk");
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson" },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) await throwHttp(res, "PUT chunk");
}

export async function commitChunk(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    chunkId: string;
    /** Replace the canonical with this chunk instead of appending — sent on the
     *  first chunk of any from-zero upload so a server canonical that diverged
     *  from this file (wiped store, lost local state) converges back to the
     *  source instead of accreting duplicate bytes. Gateways that predate the
     *  flag ignore it and append, today's behavior. */
    replace?: boolean;
    /** The store org append-url resolved, echoed back so commit writes to the
     *  same store. `null` (let.ai) is sent verbatim; only `undefined` is dropped. */
    vaultOrgId?: string | null;
    meta?: CommitMeta;
  },
): Promise<{ ok: true; totalBytes: number; componentCount: number }> {
  const body = {
    family: args.family,
    sessionId: args.sessionId,
    chunkId: args.chunkId,
    replace: args.replace || undefined,
    vaultOrgId: args.vaultOrgId,
    meta: args.meta
      ? dropNulls(args.meta as unknown as Record<string, unknown>)
      : undefined,
  };
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/commit`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttp(res, "commit");
  return (await res.json()) as { ok: true; totalBytes: number; componentCount: number };
}

/** One session in a reattribute batch: the re-detected slug when the client
 *  resolved one, else the session's cwd as EVIDENCE for server-side org rules.
 *  Omitted fields are omitted on the wire — the gateway's carry-forward means
 *  an item can never erase what the server already knows. */
export interface ReattributeItem {
  family: Family;
  sessionId: string;
  repoSlug?: string;
  cwd?: string;
  /** Retract previously-uploaded cwd evidence (evidenceUpload:false devices). */
  withholdCwd?: boolean;
}

export interface ReattributeResult {
  family: string;
  sessionId: string;
  status: "attributed" | "unmatched" | "unresolved" | "sticky" | "not_found" | "deleted";
  repoSlug?: string | null;
  orgId?: string | null;
  projectId?: string | null;
}

// The attribution sweep's transport (reattribute.ts): metadata-only repair of
// already-uploaded sessions. PG-only on the gateway side — no bytes move, no
// storage is re-routed. A gateway that predates the route 404s; the sweep
// treats that as "not yet, retry next start" (the version stamp isn't written).
export async function reattributeSessions(
  cfg: HxConfig,
  items: ReattributeItem[],
): Promise<{ ok: true; results: ReattributeResult[] }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/reattribute`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ items }),
  });
  if (!res.ok) await throwHttp(res, "reattribute");
  return (await res.json()) as { ok: true; results: ReattributeResult[] };
}

// ── Child execution lanes (subagents + workflow agents) ────────────────────
// Same 3-step chunked contract as the parent transcript, against dedicated
// endpoints (an old gateway 404s these — child bytes must never compose into
// the parent canonical by accident).

export interface AgentCommitMeta {
  kind: "subagent" | "workflow_agent";
  runId?: string | null;
  /** Parent tool_use id from agent-<id>.meta.json — the child↔parent join. */
  toolUseId?: string | null;
  agentType?: string | null;
  label?: string | null;
  worktreePath?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  eventCount?: number;
  lastActivityAt?: string | null;
}

export async function requestAgentAppendUrl(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; agentId: string; byteCount: number },
): Promise<AppendUrlResponse> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/agent-append-url`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) await throwHttp(res, "agent-append-url");
  return (await res.json()) as AppendUrlResponse;
}

export async function commitAgentChunk(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    agentId: string;
    chunkId: string;
    /** Replace the child canonical instead of appending — sent on the first
     *  chunk of any from-zero upload (divergence repair, like the parent's).
     *  No feature detection: the agent endpoints and the flag ship together. */
    replace?: boolean;
    vaultOrgId?: string | null;
    meta?: AgentCommitMeta;
  },
): Promise<{ ok: true; totalBytes: number; componentCount: number }> {
  const body = {
    family: args.family,
    sessionId: args.sessionId,
    agentId: args.agentId,
    chunkId: args.chunkId,
    replace: args.replace || undefined,
    vaultOrgId: args.vaultOrgId,
    meta: args.meta
      ? dropNulls(args.meta as unknown as Record<string, unknown>)
      : undefined,
  };
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/agent-commit`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttp(res, "agent-commit");
  return (await res.json()) as { ok: true; totalBytes: number; componentCount: number };
}

/** Workflow-run sidecar: persisted script + journal.jsonl, whole-file,
 *  hash-gated by the caller. */
export async function uploadWorkflowRun(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    runId: string;
    scriptName?: string | null;
    script?: string | null;
    journal?: string | null;
  },
): Promise<{ ok: true }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/workflow`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(dropNulls(args as unknown as Record<string, unknown>)),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`workflow upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true };
}

/** Agent-team mirror — the device's ~/.claude/teams/* configs, rewritten in
 *  place. Hash-gated by the caller; empty teams still uploads (clears state). */
export async function uploadTeamMirror(
  cfg: HxConfig,
  mirror: { teams: Array<{ name: string; config: unknown }>; syncedAtMs?: number | null },
): Promise<{ ok: true; teams: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/team-mirror`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ mirror }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`team-mirror upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; teams: number };
}

// ── Canonical divergence audit ──────────────────────────────────────────────
// Ask the gateway to compare, per session, the canonical object's ACTUAL size
// in the store against the bytes this device believes it has uploaded (its
// persisted offset). "divergent" means the store lost or mangled the canonical
// (e.g. an ephemeral-filesystem deploy wiped it) — the watcher responds by
// resetting that file's offset to 0, which re-uploads it with replace:true.

/** What the SERVER holds for this device — the "in cloud" half of the count. */
export interface DeviceInventory {
  sessions: number;
  bytes: number;
  oldestAt: string | null;
  newestAt: string | null;
}

/**
 * Ask the gateway what it has for this device.
 *
 * `hx status` can only count what is still on disk, and Claude Code prunes
 * transcripts after 30 days — so the local number is a rolling window while the
 * archive keeps growing. Reporting only the local one makes the product look
 * like a mirror of that window instead of the archive it is.
 *
 * Best-effort by design: a gateway that predates the endpoint 404s and the row
 * is simply omitted, never an error.
 */
export async function fetchDeviceInventory(cfg: HxConfig): Promise<DeviceInventory | null> {
  try {
    const res = await fetch(`${cfg.gatewayBaseUrl}/devices/inventory`, {
      headers: authHeaders(cfg),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<DeviceInventory>;
    if (typeof json.sessions !== "number" || typeof json.bytes !== "number") return null;
    return {
      sessions: json.sessions,
      bytes: json.bytes,
      oldestAt: json.oldestAt ?? null,
      newestAt: json.newestAt ?? null,
    };
  } catch {
    return null;
  }
}

export interface VerifySessionsItem {
  family: Family;
  sessionId: string;
  byteCount: number;
}

export interface VerifySessionsResult {
  family: string;
  sessionId: string;
  // "deleted" = permanently deleted server-side (tombstoned) — terminal; the
  // audit records it and stops ever uploading the session again. Older daemons
  // ignore the unrecognized status (a silent no-op), which is what makes the
  // widening backward-safe.
  status: "ok" | "divergent" | "skipped" | "deleted";
  storeBytes: number | null;
}

export async function verifySessions(
  cfg: HxConfig,
  sessions: VerifySessionsItem[],
): Promise<VerifySessionsResult[]> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/verify`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ sessions }),
  });
  if (!res.ok) await throwHttp(res, "verify");
  const json = (await res.json()) as { results: VerifySessionsResult[] };
  return json.results;
}

// ── Sidecar artifacts (tasks / plan) ───────────────────────────────────────
// Whole-file uploads — small JSON/markdown rewritten in place, so there's no
// append/compose; the gateway just overwrites the canonical sidecar object.

export async function uploadTasks(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; tasks: unknown[] },
): Promise<{ ok: true; count: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/tasks`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tasks upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; count: number };
}

export async function uploadPlan(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; planFilePath: string; content: string },
): Promise<{ ok: true }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/plan`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`plan upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true };
}

// CCD sidebar group mirror — the device's whole grouping, rewritten in place.
// Hash-gated by the caller so an unchanged mirror never re-uploads.
export async function uploadGroupMirror(
  cfg: HxConfig,
  mirror: HxCcdGroupMirrorBlob,
): Promise<{ ok: true; groups: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/group-mirror`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ mirror }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`group-mirror upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; groups: number };
}
