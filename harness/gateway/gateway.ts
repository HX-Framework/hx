// The fake hx gateway: answers the whole protocol the client speaks, stores
// every byte it is sent, and records every request on the wire.
//
// What the client talks to in production is let.ai's hx gateway (and, for a
// fortress-direct route, an org's own hx-fortress) behind the Cloudflare
// edge, plus the signed PUT target the gateway hands out. This server stands
// in for all three on 127.0.0.1 (the client allows plain http only on
// loopback), with these properties the differential harness relies on:
//
//   • deterministic responses — chunk ids are a counter, expiry stamps are
//     fixed, so two runs against two fresh instances see the same bytes;
//   • an in-memory store with the gateway's compose semantics (replace vs
//     append per destination, parent sessions and agent lanes apart), so the
//     stored bytes of every session can be compared after a run;
//   • faults switched at runtime: a wholesale outage, held or offline vaults
//     (both the 200-with-held-destinations shape and the 503 vault_offline /
//     vault_home_unreachable shapes), a 410 session_deleted tombstone, a
//     per-PUT delay (for the kill -9 scenario);
//   • a recording: one JSON line per request with method, path, query, every
//     header (User-Agent included), the parsed JSON body or the PUT body's
//     size and sha256, the status answered, and the session the request
//     belongs to, so request sequences can be compared per session.
//
// Nothing here is reachable from outside the machine, and nothing here keeps
// a byte after the process ends.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import type { Server } from "bun";

export interface HeldVault {
  reason: "vault_offline" | "vault_home_unreachable";
  orgName: string | null;
  orgSlug: string | null;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  repoSlug: string | null;
  lastSeenAt: string | null;
}

export interface RouteSpec {
  /** Vault org ids this repo fans out to, besides the shared let.ai store. */
  vaultOrgIds?: string[];
  /** When set, /route answers fortress-direct with this gateway URL + token. */
  fortress?: { gatewayUrl: string; token: string; expiresAt?: string };
  /** What /route echoes as attributedOrgIds (defaults to vaultOrgIds). */
  attributedOrgIds?: string[];
}

export interface GatewayConfig {
  accessToken: string;
  email: string;
  deviceName: string;
  userId: string;
  /** Served at GET /download/<name>-version. */
  version: string;
  /** Path of the binary served (gzipped) at GET /download/<name>-<os>-<arch>.gz. */
  releaseBinary?: string;
  connect: { pendingPolls: number; interval: number; expiresIn: number; expired?: boolean };
  routes: Record<string, RouteSpec>;
  /** Vaults that answer "held" (status held in the destination list). */
  heldVaults: Record<string, HeldVault>;
  /** Repos whose append-url answers 503 vault_offline / vault_home_unreachable
   *  (the pre-fan-out shapes). Keyed by repoSlug. */
  vault503: Record<string, { vaultOrgId: string; held: HeldVault }>;
  /** "<family>:<sessionId>" keys that are permanently deleted server-side. */
  tombstones: string[];
  /** Every endpoint answers this status (an outage), 0 = healthy. */
  outageStatus: number;
  /** Milliseconds to hold each PUT before answering. */
  putDelayMs: number;
  /** Where the recording goes (JSONL, appended). Omit to keep it in memory only. */
  recordPath?: string;
  /** A label for the recording (cloud | fortress). */
  label: string;
}

export const DEFAULT_CONFIG: GatewayConfig = {
  accessToken: "hx-harness-token",
  email: "harness@example.test",
  deviceName: "harness-device",
  userId: "user_harness",
  version: "0.0.0",
  connect: { pendingPolls: 1, interval: 1, expiresIn: 60 },
  routes: {},
  heldVaults: {},
  vault503: {},
  tombstones: [],
  outageStatus: 0,
  putDelayMs: 0,
  label: "cloud",
};

export interface RecordedRequest {
  seq: number;
  tMs: number;
  label: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyBytes: number;
  bodySha256?: string;
  status: number;
  /** "<family>:<sessionId>" when the request belongs to one session. */
  sessionKey?: string;
  /** Agent lane id for child-lane requests. */
  lane?: string;
}

interface StagedChunk {
  sessionKey: string;
  lane: string | null;
  vaultOrgId: string | null;
  bytes: Buffer | null;
}

const FIXED_EXPIRY = "2099-01-01T00:00:00.000Z";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function destKey(vaultOrgId: string | null): string {
  return vaultOrgId ?? "letai";
}

export class FakeGateway {
  readonly config: GatewayConfig;
  readonly record: RecordedRequest[] = [];
  private server: Server<undefined> | null = null;
  private startedAt = 0;
  private seq = 0;
  private chunkSeq = 0;
  private pollCount = new Map<string, number>();
  private deviceCodeSeq = 0;
  private chunks = new Map<string, StagedChunk>();
  /** "<family>:<sessionId>[:<agentId>]:<destKey>" → canonical bytes. */
  private canonical = new Map<string, { bytes: Buffer; components: number }>();
  private sidecars = new Map<string, string>();

  constructor(config: Partial<GatewayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("gateway not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(port = 0): string {
    if (this.config.recordPath) mkdirSync(dirname(this.config.recordPath), { recursive: true });
    this.startedAt = Date.now();
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 120,
      fetch: (req) => this.handle(req),
    });
    return this.baseUrl;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** Change the configuration between steps (faults, routes, tombstones). */
  update(patch: Partial<GatewayConfig>): void {
    Object.assign(this.config, patch);
  }

  /** Counts for the driver to wait on (kill -9 after N commits). */
  stats(): { requests: number; commits: number; puts: number } {
    let commits = 0;
    let puts = 0;
    for (const r of this.record) {
      if (r.path === "/sessions/commit" || r.path === "/sessions/agent-commit") commits += 1;
      if (r.method === "PUT") puts += 1;
    }
    return { requests: this.record.length, commits, puts };
  }

  /** Everything the store holds, as a manifest the comparator can diff. */
  manifest(): Record<string, { bytes: number; sha256: string; components?: number }> {
    const out: Record<string, { bytes: number; sha256: string; components?: number }> = {};
    for (const [key, v] of [...this.canonical.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[key] = { bytes: v.bytes.length, sha256: sha256(v.bytes), components: v.components };
    }
    for (const [key, text] of [...this.sidecars.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[key] = { bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) };
    }
    return out;
  }

  /** The canonical bytes of one object, for debugging a diff. */
  canonicalBytes(key: string): Buffer | null {
    return this.canonical.get(key)?.bytes ?? null;
  }

  private note(entry: Omit<RecordedRequest, "seq" | "tMs" | "label">): void {
    const rec: RecordedRequest = { seq: ++this.seq, tMs: Date.now() - this.startedAt, label: this.config.label, ...entry };
    this.record.push(rec);
    if (this.config.recordPath) appendFileSync(this.config.recordPath, `${JSON.stringify(rec)}\n`);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const headers: Record<string, string> = {};
    for (const [k, v] of [...req.headers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) headers[k] = v;
    const raw = Buffer.from(await req.arrayBuffer());
    let body: unknown = undefined;
    const isJson = (headers["content-type"] ?? "").includes("application/json");
    if (raw.length > 0 && isJson) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = { $unparseable: raw.toString("utf8").slice(0, 200) };
      }
    }
    const annotate: { sessionKey?: string; lane?: string; noise?: boolean } = {};
    let res: Response;
    try {
      res = await this.route(req.method, path, url.searchParams, headers, body, raw, annotate);
    } catch (err) {
      res = json({ error: "harness_gateway_error", message: (err as Error).message }, 500);
    }
    // A browser the client opened for pairing (macOS runners open Safari on
    // the approve URL) and anything else off the protocol is not the client
    // speaking: answered, never recorded.
    if (annotate.noise) return res;
    this.note({
      method: req.method,
      path,
      query: url.search.replace(/^\?/, ""),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(req.method === "PUT" ? { bodySha256: sha256(raw) } : {}),
      bodyBytes: raw.length,
      status: res.status,
      ...annotate,
    });
    return res;
  }

  private authorized(headers: Record<string, string>): boolean {
    return headers["authorization"] === `Bearer ${this.config.accessToken}`;
  }

  private async route(
    method: string,
    path: string,
    query: URLSearchParams,
    headers: Record<string, string>,
    body: unknown,
    raw: Buffer,
    annotate: { sessionKey?: string; lane?: string; noise?: boolean },
  ): Promise<Response> {
    const c = this.config;
    if (method === "GET" && (path === "/approve" || path === "/favicon.ico" || path.startsWith("/.well-known/"))) {
      annotate.noise = true;
      return new Response("<!doctype html><title>hx harness</title><p>Approve this device in the fake gateway: it is approved by the next poll.</p>", {
        status: path === "/approve" ? 200 : 404,
        headers: { "content-type": "text/html" },
      });
    }
    if (c.outageStatus > 0) return json({ error: "service_unavailable" }, c.outageStatus);

    // ── Signed PUT target (object storage stands in) ─────────────────────
    if (method === "PUT" && path.startsWith("/_put/")) {
      const chunkId = path.slice("/_put/".length);
      const staged = this.chunks.get(chunkId);
      if (!staged) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      annotate.sessionKey = staged.sessionKey;
      if (staged.lane) annotate.lane = staged.lane;
      if (c.putDelayMs > 0) await new Promise((r) => setTimeout(r, c.putDelayMs));
      staged.bytes = Buffer.from(raw);
      return new Response(null, { status: 200 });
    }

    // ── Downloads (the update channel; unauthenticated) ───────────────────
    if (method === "GET" && path.startsWith("/download/")) {
      const asset = path.slice("/download/".length);
      const m = /^(hx2?)-(.+?)(\.gz|\.sha256)?$/.exec(asset);
      if (!m) return new Response("not found", { status: 404 });
      if (m[2] === "version") return new Response(`${c.version}\n`, { headers: { "content-type": "text/plain" } });
      if (!c.releaseBinary) return new Response("no release", { status: 404 });
      const bin = readFileSync(c.releaseBinary);
      if (m[3] === ".sha256") return new Response(`${sha256(bin)}  ${m[1]}-${m[2]}\n`, { headers: { "content-type": "text/plain" } });
      if (m[3] === ".gz") {
        const gz = gzipSync(bin, { level: 1 });
        return new Response(gz, { headers: { "content-type": "application/gzip", "content-length": String(gz.length) } });
      }
      return new Response("not found", { status: 404 });
    }

    // ── Device pairing (unauthenticated) ──────────────────────────────────
    if (method === "POST" && path === "/devices/code") {
      const deviceCode = `dc-${++this.deviceCodeSeq}`;
      this.pollCount.set(deviceCode, 0);
      const userCode = "HXAB-CD23";
      return json({
        deviceCode,
        userCode,
        verificationUri: `${this.baseUrl}/approve`,
        verificationUriComplete: `${this.baseUrl}/approve?code=${userCode}`,
        expiresIn: c.connect.expiresIn,
        interval: c.connect.interval,
      });
    }
    if (method === "POST" && path === "/devices/poll") {
      const dc = (body as { deviceCode?: string } | undefined)?.deviceCode ?? "";
      if (c.connect.expired || !this.pollCount.has(dc)) return json({ error: "expired" }, 410);
      const n = (this.pollCount.get(dc) ?? 0) + 1;
      this.pollCount.set(dc, n);
      if (n <= c.connect.pendingPolls) return json({ status: "pending" }, 202);
      return json({ status: "approved", accessToken: c.accessToken, userId: c.userId, deviceName: c.deviceName });
    }

    // ── Everything else carries the device bearer ─────────────────────────
    if (!this.authorized(headers)) return json({ error: "unauthorized" }, 401);

    if (method === "GET" && path === "/whoami") return json({ email: c.email, deviceName: c.deviceName, userId: c.userId });
    if (method === "POST" && path === "/devices/disconnect") return json({ ok: true });
    if (method === "GET" && path === "/ping") {
      const bytes = Number(query.get("bytes") ?? 0);
      if (bytes > 0) return new Response(Buffer.alloc(bytes, 0x2e), { headers: { "content-type": "application/octet-stream" } });
      return new Response("pong", { headers: { "content-type": "text/plain" } });
    }
    if (method === "GET" && path === "/devices/inventory") {
      const sessions = new Set<string>();
      let bytes = 0;
      for (const [key, v] of this.canonical) {
        const parts = key.split(":");
        if (parts.length !== 3) continue; // agent lanes carry a fourth part
        sessions.add(`${parts[0]}:${parts[1]}`);
        bytes += v.bytes.length;
      }
      return json({ sessions: sessions.size, bytes, oldestAt: null, newestAt: null });
    }
    if (method === "POST" && path === "/devices/heartbeat") return json({ ok: true });
    if (method === "POST" && path === "/devices/sync-status") return json({ ok: true });
    if (method === "GET" && path === "/route") {
      const repo = query.get("repo") ?? "";
      const spec = c.routes[repo];
      const attributedOrgIds = spec?.attributedOrgIds ?? spec?.vaultOrgIds ?? [];
      if (spec?.fortress) {
        return json({
          mode: "fortress-direct",
          gatewayUrl: spec.fortress.gatewayUrl,
          token: spec.fortress.token,
          expiresAt: spec.fortress.expiresAt ?? FIXED_EXPIRY,
          attributedOrgIds,
        });
      }
      return json({ mode: "cloud", attributedOrgIds });
    }

    // ── Session uploads ───────────────────────────────────────────────────
    const b = (body ?? {}) as Record<string, unknown>;
    const family = typeof b.family === "string" ? b.family : "";
    const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
    const sessionKey = family && sessionId ? `${family}:${sessionId}` : undefined;
    if (sessionKey) annotate.sessionKey = sessionKey;
    const tombstoned = sessionKey !== undefined && c.tombstones.includes(sessionKey);

    if (method === "POST" && path === "/sessions/append-url") {
      if (!sessionKey) return json({ error: "bad_request" }, 400);
      if (tombstoned) return json({ error: "session_deleted" }, 410);
      const repoSlug = typeof b.repoSlug === "string" ? b.repoSlug : null;
      const v503 = repoSlug ? c.vault503[repoSlug] : undefined;
      if (v503) {
        if (v503.held.reason === "vault_home_unreachable") {
          return json({ error: "vault_home_unreachable", vaultOrgId: v503.vaultOrgId, destinations: [] }, 503);
        }
        return json(
          { error: "vault_offline", destinations: [{ vaultOrgId: v503.vaultOrgId, ...v503.held }] },
          503,
        );
      }
      const vaultIds = (repoSlug && c.routes[repoSlug]?.vaultOrgIds) || [];
      const destinations = [null, ...vaultIds].map((vaultOrgId) => {
        const held = vaultOrgId ? c.heldVaults[vaultOrgId] : undefined;
        if (held) return { vaultOrgId, status: "held" as const, ...held };
        const chunkId = `c${String(++this.chunkSeq).padStart(6, "0")}`;
        this.chunks.set(chunkId, { sessionKey, lane: null, vaultOrgId, bytes: null });
        return {
          vaultOrgId,
          chunkId,
          uploadUrl: `${this.baseUrl}/_put/${chunkId}?sig=harness`,
          objectName: `staging/${family}/${sessionId}/${chunkId}`,
          expiresAt: FIXED_EXPIRY,
          status: "ready" as const,
        };
      });
      const first = destinations.find((d) => d.status === "ready");
      const legacy = first && first.status === "ready"
        ? { chunkId: first.chunkId, uploadUrl: first.uploadUrl, objectName: first.objectName, expiresAt: first.expiresAt, vaultOrgId: first.vaultOrgId }
        : { chunkId: "", uploadUrl: "", objectName: "", expiresAt: FIXED_EXPIRY, vaultOrgId: null };
      return json({ ...legacy, destinations });
    }

    if (method === "POST" && path === "/sessions/commit") {
      if (!sessionKey) return json({ error: "bad_request" }, 400);
      if (tombstoned) return json({ error: "session_deleted" }, 410);
      return this.compose(`${sessionKey}`, b);
    }

    if (method === "POST" && path === "/sessions/agent-append-url") {
      const agentId = typeof b.agentId === "string" ? b.agentId : "";
      if (!sessionKey || !agentId) return json({ error: "bad_request" }, 400);
      annotate.lane = agentId;
      if (tombstoned) return json({ error: "session_deleted" }, 410);
      const chunkId = `a${String(++this.chunkSeq).padStart(6, "0")}`;
      this.chunks.set(chunkId, { sessionKey, lane: agentId, vaultOrgId: null, bytes: null });
      return json({
        chunkId,
        uploadUrl: `${this.baseUrl}/_put/${chunkId}?sig=harness`,
        objectName: `staging/${family}/${sessionId}/agents/${agentId}/${chunkId}`,
        expiresAt: FIXED_EXPIRY,
        vaultOrgId: null,
      });
    }

    if (method === "POST" && path === "/sessions/agent-commit") {
      const agentId = typeof b.agentId === "string" ? b.agentId : "";
      if (!sessionKey || !agentId) return json({ error: "bad_request" }, 400);
      annotate.lane = agentId;
      if (tombstoned) return json({ error: "session_deleted" }, 410);
      return this.compose(`${sessionKey}:${agentId}`, b);
    }

    if (method === "POST" && path === "/sessions/verify") {
      const items = Array.isArray(b.sessions) ? (b.sessions as Array<Record<string, unknown>>) : [];
      const results = items.map((it) => {
        const key = `${String(it.family)}:${String(it.sessionId)}`;
        if (c.tombstones.includes(key)) return { family: it.family, sessionId: it.sessionId, status: "deleted", storeBytes: null };
        const canon = this.canonical.get(`${key}:letai`);
        const storeBytes = canon ? canon.bytes.length : 0;
        const status = storeBytes === Number(it.byteCount) ? "ok" : "divergent";
        return { family: it.family, sessionId: it.sessionId, status, storeBytes };
      });
      return json({ results });
    }

    if (method === "POST" && path === "/sessions/reattribute") {
      const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>) : [];
      return json({
        ok: true,
        results: items.map((it) => ({
          family: it.family,
          sessionId: it.sessionId,
          status: typeof it.repoSlug === "string" ? "attributed" : "unresolved",
          repoSlug: typeof it.repoSlug === "string" ? it.repoSlug : null,
          orgId: typeof it.repoSlug === "string" ? "org_harness" : null,
          projectId: null,
        })),
      });
    }

    if (method === "POST" && path === "/sessions/retitle") {
      const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>) : [];
      return json({
        ok: true,
        results: items.map((it) => ({
          family: it.family,
          sessionId: it.sessionId,
          status: c.tombstones.includes(`${String(it.family)}:${String(it.sessionId)}`) ? "deleted" : "queued",
        })),
      });
    }

    if (method === "POST" && path === "/sessions/tasks") {
      if (!sessionKey) return json({ error: "bad_request" }, 400);
      const tasks = Array.isArray(b.tasks) ? b.tasks : [];
      this.sidecars.set(`${sessionKey}:tasks`, JSON.stringify(tasks));
      return json({ ok: true, count: tasks.length });
    }
    if (method === "POST" && path === "/sessions/plan") {
      if (!sessionKey) return json({ error: "bad_request" }, 400);
      this.sidecars.set(`${sessionKey}:plan`, JSON.stringify({ planFilePath: b.planFilePath, content: b.content }));
      return json({ ok: true });
    }
    if (method === "POST" && path === "/sessions/workflow") {
      if (!sessionKey) return json({ error: "bad_request" }, 400);
      this.sidecars.set(`${sessionKey}:wf:${String(b.runId)}`, JSON.stringify({ scriptName: b.scriptName, script: b.script, journal: b.journal }));
      return json({ ok: true });
    }
    if (method === "POST" && path === "/sessions/team-mirror") {
      const mirror = (b.mirror ?? {}) as { teams?: unknown[] };
      this.sidecars.set("device:team-mirror", JSON.stringify(mirror.teams ?? []));
      return json({ ok: true, teams: Array.isArray(mirror.teams) ? mirror.teams.length : 0 });
    }
    if (method === "POST" && path === "/sessions/group-mirror") {
      const mirror = (b.mirror ?? {}) as { groups?: unknown[]; groupingEnabled?: boolean; unreadIds?: unknown[] };
      this.sidecars.set(
        "device:group-mirror",
        JSON.stringify({ groupingEnabled: mirror.groupingEnabled, groups: mirror.groups ?? [], unreadIds: mirror.unreadIds ?? [] }),
      );
      return json({ ok: true, groups: Array.isArray(mirror.groups) ? mirror.groups.length : 0 });
    }

    annotate.noise = !path.startsWith("/sessions/") && !path.startsWith("/devices/");
    return json({ error: "not_found", path }, 404);
  }

  /** The gateway's compose step: staged chunk → canonical (replace or append). */
  private compose(objectKey: string, b: Record<string, unknown>): Response {
    const chunkId = typeof b.chunkId === "string" ? b.chunkId : "";
    const staged = this.chunks.get(chunkId);
    if (!staged || !staged.bytes) return json({ error: "unknown_chunk", chunkId }, 400);
    const vaultOrgId = typeof b.vaultOrgId === "string" ? b.vaultOrgId : null;
    const key = `${objectKey}:${destKey(vaultOrgId)}`;
    const prev = this.canonical.get(key);
    const replace = b.replace === true || !prev;
    const next = replace
      ? { bytes: staged.bytes, components: 1 }
      : { bytes: Buffer.concat([prev!.bytes, staged.bytes]), components: prev!.components + 1 };
    this.canonical.set(key, next);
    this.chunks.delete(chunkId);
    return json({ ok: true, totalBytes: next.bytes.length, componentCount: next.components });
  }
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
