import { describe, it, beforeAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_PROOF_LABEL,
  SERVER_PROOF_LABEL,
  createUiAuth,
  hmacProof,
  type UiAuth,
} from "./auth.js";
import { createEventHub, handleUiRequest, type UiServerCtx } from "./server.js";
import { DEFAULT_CLAUDE_ROOT } from "../roots.js";
import type { UiAssets } from "./assets.js";

const PORT = 8000;
let auth: UiAuth;
let ctx: UiServerCtx;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hx-ui-test-"));
  const indexPath = join(dir, "index.html");
  const appPath = join(dir, "app.js");
  writeFileSync(indexPath, "<!doctype html><title>hx</title>");
  writeFileSync(appPath, "console.log(1)");
  const assets: UiAssets = {
    mode: "disk",
    files: { "/index.html": indexPath, "/assets/app.js": appPath },
    inlineScriptHashes: ["'sha256-testhash'"],
  };
  auth = createUiAuth();
  const providers = {
    snapshot: () => Promise.resolve({ generatedAt: 1 } as never),
    sessions: (folderId: string) =>
      Promise.resolve(folderId === "known" ? ([{ id: "s1" }] as never[]) : []),
    preview: (filePath: string) =>
      Promise.resolve(filePath === "/ok.jsonl" ? [{ role: "Me" as const, text: "hi" }] : null),
    logs: () => Promise.resolve([{ body: "[hx] tick", level: "info" as const }]),
    probe: () => Promise.resolve({ up: true }),
    whoami: () => Promise.resolve({ email: "dev@local.test" }),
    activity: () => Promise.resolve([{ at: 1, bytes: 10, dest: "letai" }]),
  };
  const actions = {
    readSettings: () => Promise.resolve({ personalSync: true }),
    writeSettings: (patch: Record<string, unknown>) => Promise.resolve({ personalSync: true, ...patch }),
    daemon: (action: string) => Promise.resolve({ managerName: "test", loaded: action !== "stop", pid: 1 }),
    retryBlocked: () => Promise.resolve({ sessions: 2, files: 2, restarted: true }),
    updateCheck: () => Promise.resolve({ current: "1.0.0", latest: "1.0.0", updateAvailable: false }),
    startUpdate: () => Promise.resolve(true),
    disconnect: () => Promise.resolve({ disconnected: true }),
  };
  ctx = { auth, assets, providers, actions, events: createEventHub(), port: PORT };
});

const req = (
  path: string,
  opts: { method?: string; host?: string; origin?: string; token?: string; body?: unknown } = {},
): Request => {
  const headers: Record<string, string> = { host: opts.host ?? `localhost:${PORT}` };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.token) headers["x-hx-ui-token"] = opts.token;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body) headers["content-type"] = "application/json";
  return new Request(`http://localhost:${PORT}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
  });
};

describe("handleUiRequest — request gates", () => {
  it("rejects foreign Host headers on every route", async () => {
    for (const path of ["/", "/api/instance", "/api/ping"]) {
      const res = await handleUiRequest(req(path, { host: "evil.example:8000" }), ctx);
      assert.equal(res.status, 403, path);
    }
  });

  it("rejects cross-origin state-changing requests", async () => {
    const res = await handleUiRequest(
      req("/api/auth", { method: "POST", origin: "https://evil.example", body: { token: "x" } }),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("sets security headers on every response", async () => {
    const res = await handleUiRequest(req("/"), ctx);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    // script-src carries exact inline hashes, never 'unsafe-inline'
    assert.match(csp, /script-src 'self' 'sha256-testhash'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  });
});

describe("handleUiRequest — static shell", () => {
  it("serves index.html at / without auth", async () => {
    const res = await handleUiRequest(req("/"), ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /doctype html/);
  });

  it("serves hashed assets with immutable caching", async () => {
    const res = await handleUiRequest(req("/assets/app.js"), ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });

  it("404s unknown paths, including traversal shapes", async () => {
    for (const path of ["/nope.js", "/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const res = await handleUiRequest(req(path), ctx);
      assert.equal(res.status, 404, path);
    }
  });

  it("405s non-GET on static paths", async () => {
    const res = await handleUiRequest(req("/", { method: "POST" }), ctx);
    assert.equal(res.status, 405);
  });
});

describe("handleUiRequest — auth flow", () => {
  it("identifies itself without auth", async () => {
    const res = await handleUiRequest(req("/api/instance"), ctx);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { app: string; version: string };
    assert.equal(body.app, "hx-ui");
    assert.ok(body.version.length > 0);
  });

  it("exchanges a launch token for the session token, reusably within its TTL", async () => {
    const bad = await handleUiRequest(
      req("/api/auth", { method: "POST", body: { token: "wrong" } }),
      ctx,
    );
    assert.equal(bad.status, 401);

    const lt = auth.mintLaunchToken();
    const good = await handleUiRequest(
      req("/api/auth", { method: "POST", body: { token: lt } }),
      ctx,
    );
    assert.equal(good.status, 200);
    const body = (await good.json()) as { sessionToken: string };
    assert.equal(body.sessionToken, auth.sessionToken);

    // A second fetch of the same link (preview/prefetch/second tab) still
    // works — the token isn't consumed.
    const again = await handleUiRequest(
      req("/api/auth", { method: "POST", body: { token: lt } }),
      ctx,
    );
    assert.equal(again.status, 200);
  });

  it("reissues a fresh launch token only on a valid ownerKey proof", async () => {
    const nonce = "nonce-1";
    // No proof / wrong proof → 401, and no session token needed to call it.
    assert.equal(
      (await handleUiRequest(req("/api/instance/reissue", { method: "POST", body: { nonce, proof: "no" } }), ctx)).status,
      401,
    );
    const proof = hmacProof(auth.ownerKey, CLIENT_PROOF_LABEL, nonce);
    const ok = await handleUiRequest(
      req("/api/instance/reissue", { method: "POST", body: { nonce, proof } }),
      ctx,
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { launchToken: string; serverProof: string };
    // The reissued token works for a real exchange, and the server proved itself.
    assert.equal(body.serverProof, hmacProof(auth.ownerKey, SERVER_PROOF_LABEL, nonce));
    const ex = await handleUiRequest(
      req("/api/auth", { method: "POST", body: { token: body.launchToken } }),
      ctx,
    );
    assert.equal(ex.status, 200);
  });

  it("rejects malformed auth bodies", async () => {
    const res = await handleUiRequest(
      req("/api/auth", { method: "POST", body: { token: 42 } }),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  it("gates /api behind the session token", async () => {
    const anon = await handleUiRequest(req("/api/ping"), ctx);
    assert.equal(anon.status, 401);
    const launch = await handleUiRequest(req("/api/ping", { token: auth.mintLaunchToken() }), ctx);
    assert.equal(launch.status, 401); // launch token is not a session token
    const ok = await handleUiRequest(req("/api/ping", { token: auth.sessionToken }), ctx);
    assert.equal(ok.status, 204);
  });

  it("serves data endpoints only with a session token", async () => {
    assert.equal((await handleUiRequest(req("/api/snapshot"), ctx)).status, 401);
    const snap = await handleUiRequest(req("/api/snapshot", { token: auth.sessionToken }), ctx);
    assert.equal(snap.status, 200);
    assert.deepEqual(await snap.json(), { generatedAt: 1 });

    const noFolder = await handleUiRequest(req("/api/sessions", { token: auth.sessionToken }), ctx);
    assert.equal(noFolder.status, 400);
    const sessions = await handleUiRequest(
      req("/api/sessions?folder=known", { token: auth.sessionToken }),
      ctx,
    );
    assert.equal(sessions.status, 200);

    const badPreview = await handleUiRequest(
      req("/api/session-preview?path=/etc/passwd", { token: auth.sessionToken }),
      ctx,
    );
    assert.equal(badPreview.status, 404); // provider vetoes non-discovered paths
    const okPreview = await handleUiRequest(
      req("/api/session-preview?path=/ok.jsonl", { token: auth.sessionToken }),
      ctx,
    );
    assert.equal(okPreview.status, 200);

    const logs = await handleUiRequest(req("/api/logs", { token: auth.sessionToken }), ctx);
    assert.equal(logs.status, 200);
  });

  it("serves and validates the action endpoints", async () => {
    const t = auth.sessionToken;
    // settings round-trip + unknown-key rejection
    const settings = await handleUiRequest(req("/api/settings", { token: t }), ctx);
    assert.equal(settings.status, 200);
    const patched = await handleUiRequest(
      req("/api/settings", { method: "POST", token: t, body: { personalSync: false } }),
      ctx,
    );
    assert.equal(patched.status, 200);
    const badKey = await handleUiRequest(
      req("/api/settings", { method: "POST", token: t, body: { accessToken: "sneaky" } }),
      ctx,
    );
    assert.equal(badKey.status, 400);
    // dataDirs: valid patch accepted and echoed back through writeSettings
    const dirsOk = await handleUiRequest(
      req("/api/settings", {
        method: "POST",
        token: t,
        body: { dataDirs: { claude: ["/data/claude-work"], codex: [] } },
      }),
      ctx,
    );
    assert.equal(dirsOk.status, 200);
    const dirsBody = (await dirsOk.json()) as { dataDirs?: { claude: string[] } };
    assert.deepEqual(dirsBody.dataDirs?.claude, ["/data/claude-work"]);
    // dataDirs: strict 400s — wrong shape, unknown family, relative path,
    // non-string entries, over the per-family cap
    for (const bad of [
      { dataDirs: "nope" },
      { dataDirs: { gemini: [] } },
      { dataDirs: { claude: ["relative/path"] } },
      { dataDirs: { claude: [42] } },
      { dataDirs: { claude: Array.from({ length: 9 }, (_, i) => `/x/${i}`) } },
      { dataDirs: { claude: [DEFAULT_CLAUDE_ROOT] } }, // already watched by default
    ]) {
      const res = await handleUiRequest(
        req("/api/settings", { method: "POST", token: t, body: bad }),
        ctx,
      );
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    // daemon action validation
    const badAction = await handleUiRequest(
      req("/api/daemon", { method: "POST", token: t, body: { action: "explode" } }),
      ctx,
    );
    assert.equal(badAction.status, 400);
    const stop = await handleUiRequest(
      req("/api/daemon", { method: "POST", token: t, body: { action: "stop" } }),
      ctx,
    );
    assert.equal(stop.status, 200);
    // retry / update-check / update / disconnect
    assert.equal((await handleUiRequest(req("/api/retry-blocked", { method: "POST", token: t }), ctx)).status, 200);
    assert.equal((await handleUiRequest(req("/api/update-check", { token: t }), ctx)).status, 200);
    assert.equal((await handleUiRequest(req("/api/update", { method: "POST", token: t }), ctx)).status, 200);
    assert.equal((await handleUiRequest(req("/api/disconnect", { method: "POST", token: t }), ctx)).status, 200);
    // all actions are session-gated
    assert.equal((await handleUiRequest(req("/api/disconnect", { method: "POST" }), ctx)).status, 401);
    // and Origin-gated like every non-GET
    const crossSite = await handleUiRequest(
      req("/api/disconnect", { method: "POST", token: t, origin: "https://evil.example" }),
      ctx,
    );
    assert.equal(crossSite.status, 403);
  });

  it("404s unknown authed api routes without leaking to anonymous callers", async () => {
    const anon = await handleUiRequest(req("/api/does-not-exist"), ctx);
    assert.equal(anon.status, 401);
    const authed = await handleUiRequest(
      req("/api/does-not-exist", { token: auth.sessionToken }),
      ctx,
    );
    assert.equal(authed.status, 404);
  });
});
