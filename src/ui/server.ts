// The HX Client UI server: a pure request handler plus a thin Bun.serve
// shell. Everything stateful (auth tokens, asset map, bound port) rides in a
// context object so the handler is unit-testable with plain Request values.
//
// Surface (Phase relevant to serving the static app; data endpoints arrive
// with the view wiring):
//   GET  /            → index.html            (no auth — app shell only)
//   GET  /assets/*    → embedded static files (no auth)
//   GET  /api/instance → { app, version }     (no auth — instance discovery)
//   POST /api/auth     → { sessionToken }     (launch-token gated)
//   GET  /api/ping     → 204                  (session-token gated)
//
// Static serving is unauthenticated by design: the browser must be able to
// load the shell before the SPA has exchanged the fragment token, and the
// shell contains no data — every read lives behind /api with the session
// header. Host/Origin checks apply to every request, static included.

import type { Server } from "bun";
import { isAllowedHost, isAllowedOrigin, type UiAuth } from "./auth.js";
import { contentTypeFor, type UiAssets } from "./assets.js";
import { instanceIdentity } from "./instance.js";
import type { SessionVM, UiSnapshot, LogLevel } from "./data.js";
import type { PreviewLine } from "./preview.js";
import { dataDirsPatchError } from "../settings.js";
import { duplicateRootError } from "../roots.js";

/** Read-only data the API serves; injected so the handler tests with fakes. */
export interface UiProviders {
  snapshot(): Promise<UiSnapshot>;
  sessions(folderId: string): Promise<SessionVM[]>;
  preview(filePath: string): Promise<PreviewLine[] | null>;
  logs(maxLines: number): Promise<{ body: string; level: LogLevel }[]>;
  probe(): Promise<unknown>;
  whoami(): Promise<{ email: string | null }>;
  activity(hours: number): Promise<unknown[]>;
}

/** State-changing actions — injected the same way. Every one of these maps to
 *  an existing CLI behavior; the daemon stays the sole writer of state.json
 *  (retry-blocked stops it first, exactly like `hx retry --blocked`). */
export interface UiActions {
  readSettings(): Promise<unknown>;
  writeSettings(patch: Record<string, unknown>): Promise<unknown>;
  daemon(action: "start" | "stop" | "restart"): Promise<unknown>;
  retryBlocked(): Promise<unknown>;
  updateCheck(): Promise<unknown>;
  /** Kick a background self-update; progress arrives on the event hub.
   *  Resolves false when an update is already running. */
  startUpdate(): Promise<boolean>;
  disconnect(): Promise<{ disconnected: boolean }>;
}

/** Fan-out for server-sent events (update progress, state-changed nudges). */
export interface UiEventHub {
  subscribe(fn: (evt: object) => void): () => void;
  emit(evt: object): void;
}

export function createEventHub(): UiEventHub {
  const subs = new Set<(evt: object) => void>();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit(evt) {
      for (const fn of subs) {
        try {
          fn(evt);
        } catch {
          // a broken subscriber must not break the rest
        }
      }
    },
  };
}

export interface UiServerCtx {
  auth: UiAuth;
  assets: UiAssets;
  providers: UiProviders;
  actions: UiActions;
  events: UiEventHub;
  /** The bound port — Host/Origin checks compare against it. */
  port: number;
}

// script-src carries exact hashes of index.html's inline scripts (the theme
// bootstrap) instead of 'unsafe-inline'; style-src keeps 'unsafe-inline' for
// React style attributes — standard, and styles can't exfiltrate.
export function cspFor(inlineScriptHashes: string[]): string {
  const scriptSrc = ["'self'", ...inlineScriptHashes].join(" ");
  return (
    `default-src 'self'; script-src ${scriptSrc}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'none'"
  );
}

function finish(res: Response, cache: string, csp: string): Response {
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", cache);
  return res;
}

function json(body: unknown, status = 200, cache = "no-store", csp = cspFor([])): Response {
  return finish(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
    cache,
    csp,
  );
}

function apiError(status: number, error: string): Response {
  return json({ error }, status);
}

export async function handleUiRequest(req: Request, ctx: UiServerCtx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!isAllowedHost(req.headers.get("host"), ctx.port)) {
    return apiError(403, "forbidden host");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (!isAllowedOrigin(req.headers.get("origin"), ctx.port)) {
      return apiError(403, "forbidden origin");
    }
  }

  if (path.startsWith("/api/")) return handleApi(req, path, ctx);

  // Static shell. GET/HEAD only; everything resolves through the asset map.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return apiError(405, "method not allowed");
  }
  const assetPath = path === "/" ? "/index.html" : path;
  const filePath = ctx.assets.files[assetPath];
  const csp = cspFor(ctx.assets.inlineScriptHashes);
  if (!filePath) {
    return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  }
  const cache =
    assetPath === "/index.html"
      ? "no-cache"
      : assetPath.startsWith("/assets/")
        ? "public, max-age=31536000, immutable" // Vite content-hashed names
        : "public, max-age=3600";
  return finish(
    new Response(Bun.file(filePath), {
      headers: { "content-type": contentTypeFor(assetPath) },
    }),
    cache,
    csp,
  );
}

async function handleApi(req: Request, path: string, ctx: UiServerCtx): Promise<Response> {
  if (path === "/api/instance") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return apiError(405, "method not allowed");
    }
    return json(instanceIdentity());
  }

  if (path === "/api/auth") {
    if (req.method !== "POST") return apiError(405, "method not allowed");
    let token: unknown;
    try {
      const body = (await req.json()) as { token?: unknown };
      token = body.token;
    } catch {
      return apiError(400, "invalid body");
    }
    if (typeof token !== "string") return apiError(400, "invalid body");
    const sessionToken = ctx.auth.exchange(token);
    if (!sessionToken) return apiError(401, "invalid token");
    return json({ sessionToken });
  }

  // Instance-reuse handshake: authenticated by proof-of-ownerKey (the second
  // `hx ui` process reads ownerKey from the 0600 file — same uid), NOT by a
  // session token, which the reuse caller doesn't have. Mints a fresh launch
  // token (reusable within its TTL, like every launch token) and proves our own
  // ownerKey knowledge back, so the caller can confirm we're the genuine server
  // before opening the browser.
  if (path === "/api/instance/reissue") {
    if (req.method !== "POST") return apiError(405, "method not allowed");
    let nonce: unknown, proof: unknown;
    try {
      const body = (await req.json()) as { nonce?: unknown; proof?: unknown };
      nonce = body.nonce;
      proof = body.proof;
    } catch {
      return apiError(400, "invalid body");
    }
    if (typeof nonce !== "string" || typeof proof !== "string") return apiError(400, "invalid body");
    if (!ctx.auth.verifyOwnerProof(nonce, proof)) return apiError(401, "invalid proof");
    return json({
      launchToken: ctx.auth.mintLaunchToken(),
      serverProof: ctx.auth.serverProof(nonce),
    });
  }

  if (!ctx.auth.isValidSession(req.headers.get("x-hx-ui-token"))) {
    return apiError(401, "unauthorized");
  }

  if (path === "/api/ping") {
    return finish(new Response(null, { status: 204 }), "no-store", cspFor([]));
  }

  if (req.method === "POST") {
    switch (path) {
      case "/api/settings": {
        let patch: Record<string, unknown>;
        try {
          patch = (await req.json()) as Record<string, unknown>;
        } catch {
          return apiError(400, "invalid body");
        }
        const allowed = new Set(["pause", "personalSync", "excludedFolders", "excludeRules", "dataDirs"]);
        for (const key of Object.keys(patch)) {
          if (!allowed.has(key)) return apiError(400, `unknown setting: ${key}`);
        }
        // dataDirs gets strict validation: the disk parser silently drops
        // garbage, but an API write should fail loudly instead of appearing
        // to accept a location it actually threw away.
        if ("dataDirs" in patch) {
          let err = dataDirsPatchError(patch.dataDirs);
          if (!err) {
            // Judge only entries the caller is ADDING: pre-existing ones are
            // the write path's to self-heal, never a reason to 400 an
            // unrelated mutation (full-array PATCH semantics).
            const current = (await ctx.actions.readSettings()) as {
              dataDirs?: { claude?: string[]; codex?: string[] };
            } | null;
            err = duplicateRootError(
              patch.dataDirs as { claude?: unknown; codex?: unknown },
              current?.dataDirs,
            );
          }
          if (err) return apiError(400, err);
        }
        return json(await ctx.actions.writeSettings(patch));
      }
      case "/api/daemon": {
        let action: unknown;
        try {
          action = ((await req.json()) as { action?: unknown }).action;
        } catch {
          return apiError(400, "invalid body");
        }
        if (action !== "start" && action !== "stop" && action !== "restart") {
          return apiError(400, "invalid action");
        }
        return json(await ctx.actions.daemon(action));
      }
      case "/api/retry-blocked":
        return json(await ctx.actions.retryBlocked());
      case "/api/update": {
        const started = await ctx.actions.startUpdate();
        return started ? json({ started: true }) : apiError(409, "update already running");
      }
      case "/api/disconnect":
        return json(await ctx.actions.disconnect());
      default:
        return apiError(404, "not found");
    }
  }

  if (req.method !== "GET") return apiError(405, "method not allowed");
  const query = new URL(req.url).searchParams;

  if (path === "/api/events") return sseResponse(ctx.events);

  switch (path) {
    case "/api/settings":
      return json(await ctx.actions.readSettings());
    case "/api/update-check":
      return json(await ctx.actions.updateCheck());
    case "/api/snapshot":
      return json(await ctx.providers.snapshot());
    case "/api/sessions": {
      const folder = query.get("folder");
      if (!folder) return apiError(400, "missing folder");
      return json(await ctx.providers.sessions(folder));
    }
    case "/api/session-preview": {
      const file = query.get("path");
      if (!file) return apiError(400, "missing path");
      const lines = await ctx.providers.preview(file);
      if (lines === null) return apiError(404, "not found");
      return json({ lines });
    }
    case "/api/logs": {
      const n = Math.min(2_000, Math.max(50, Number(query.get("lines")) || 500));
      return json({ lines: await ctx.providers.logs(n) });
    }
    case "/api/probe":
      return json(await ctx.providers.probe());
    case "/api/whoami":
      return json(await ctx.providers.whoami());
    case "/api/activity": {
      const hours = Number(query.get("hours")) || 24;
      return json({ entries: await ctx.providers.activity(hours) });
    }
    default:
      return apiError(404, "not found");
  }
}

const SSE_PING_MS = 15_000; // idleTimeout is 120 s — pings keep well under it

function sseResponse(hub: UiEventHub): Response {
  const enc = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (evt: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          // stream already closed — the cancel() below unsubscribes
        }
      };
      send({ type: "hello" });
      unsub = hub.subscribe(send);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          // closed — cleanup happens in cancel()
        }
      }, SSE_PING_MS);
    },
    cancel() {
      unsub();
      if (ping) clearInterval(ping);
    },
  });
  return finish(
    new Response(stream, {
      headers: { "content-type": "text/event-stream", connection: "keep-alive" },
    }),
    "no-store",
    cspFor([]),
  );
}

/**
 * Bind <hostname>:<port> (loopback by default). Returns null when the port is
 * taken (the caller decides between instance-reuse and scanning); rethrows
 * anything else (EACCES and friends are real errors, not "try the next port").
 *
 * `hostname` is 127.0.0.1 on a normal host; `hx ui` passes "::" only when it
 * detects a container, so a published port can forward in over either IP family
 * (dual-stack). If the container has no IPv6, the "::" bind fails and we retry
 * IPv4-only ("0.0.0.0"). The bind address is not an access boundary — the Host
 * allowlist and token gate every request regardless of it (see container.ts /
 * SECURITY.md).
 */
export function tryServeUi(
  port: number,
  auth: UiAuth,
  assets: UiAssets,
  providers: UiProviders,
  actions: UiActions,
  events: UiEventHub,
  hostname = "127.0.0.1",
): Server<undefined> | null {
  const ctx: UiServerCtx = { auth, assets, providers, actions, events, port };
  const serveOn = (host: string): Server<undefined> | null => {
    try {
      return Bun.serve({
        hostname: host,
        port,
        // SSE streams ride this connection later; pings stay well under it.
        idleTimeout: 120,
        fetch: (req) => handleUiRequest(req, ctx),
      });
    } catch (err) {
      if ((err as { code?: string }).code === "EADDRINUSE") return null; // port taken
      // A container without IPv6 can't bind "::" — fall back to IPv4-only so hx
      // still comes up (localhost may then need 127.0.0.1, but it runs).
      if (host === "::") return serveOn("0.0.0.0");
      throw err;
    }
  };
  return serveOn(hostname);
}
