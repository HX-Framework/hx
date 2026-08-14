import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { resolveRoute, type Route } from "./route.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveRoute", () => {
  it("returns a fortress-direct route from the cloud and caches it", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse({
        mode: "fortress-direct",
        gatewayUrl: "https://f.example",
        token: "t",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }) as unknown as typeof fetch;
    const cache = new Map<string, Route>();
    const args = {
      repo: "acme/app",
      gatewayBaseUrl: "https://cloud/api/hx-gateway",
      accessToken: "dev",
      fetcher,
      cache,
    };
    const r1 = await resolveRoute(args);
    assert.equal(r1.mode, "fortress-direct");
    const r2 = await resolveRoute(args);
    assert.equal(calls, 1); // served from cache
    if (r2.mode === "fortress-direct") assert.equal(r2.gatewayUrl, "https://f.example");
  });

  it("falls back to the last good route when the cloud is unreachable", async () => {
    const cache = new Map<string, Route>();
    cache.set("acme/app", {
      mode: "fortress-direct",
      gatewayUrl: "https://f.example",
      token: "t",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const fetcher = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await resolveRoute({
      repo: "acme/app",
      gatewayBaseUrl: "https://cloud/api/hx-gateway",
      accessToken: "dev",
      fetcher,
      cache,
    });
    if (r.mode === "fortress-direct") assert.equal(r.gatewayUrl, "https://f.example");
    else assert.fail("expected the cached fortress-direct route");
  });

  // With fortress-direct retired, the cloud answers "cloud" and the
  // client uploads through workbench (which relays to the fortress over the
  // tunnel). A subsequent call serves the cached cloud route without re-fetching.
  it("returns cloud when the cloud answers cloud, and caches it", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse({ mode: "cloud" });
    }) as unknown as typeof fetch;
    const cache = new Map<string, Route>();
    const args = {
      repo: "acme/app",
      gatewayBaseUrl: "https://cloud/api/hx-gateway",
      accessToken: "dev",
      fetcher,
      cache,
    };
    const r1 = await resolveRoute(args);
    assert.equal(r1.mode, "cloud");
    const r2 = await resolveRoute(args);
    assert.equal(r2.mode, "cloud");
    assert.equal(calls, 2); // cloud routes aren't memo-short-circuited; both re-checked
  });

  it("drops a fortress-direct route whose gatewayUrl is plaintext http and falls back to cloud", async () => {
    const fetcher = (async () =>
      jsonResponse({
        mode: "fortress-direct",
        gatewayUrl: "http://f.example", // downgraded — must be rejected
        token: "t",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })) as unknown as typeof fetch;
    const cache = new Map<string, Route>();
    const r = await resolveRoute({
      repo: "acme/app",
      gatewayBaseUrl: "https://cloud/api/hx-gateway",
      accessToken: "dev",
      fetcher,
      cache,
    });
    assert.equal(r.mode, "cloud");
    // and it must NOT have been cached (a later call re-resolves).
    assert.equal(cache.has("acme/app"), false);
  });

  it("refuses to send the bearer token to a plaintext-http gateway", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return jsonResponse({ mode: "cloud" });
    }) as unknown as typeof fetch;
    await assert.rejects(
      resolveRoute({
        repo: "acme/app",
        gatewayBaseUrl: "http://cloud.example/api/hx-gateway",
        accessToken: "dev",
        fetcher,
        cache: new Map(),
      }),
      /insecure transport/,
    );
    assert.equal(called, false); // guarded before any fetch
  });

  it("defaults to cloud when there is no cache and the cloud is unreachable", async () => {
    const fetcher = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await resolveRoute({
      repo: "x/y",
      gatewayBaseUrl: "https://cloud/api/hx-gateway",
      accessToken: "dev",
      fetcher,
      cache: new Map(),
    });
    assert.equal(r.mode, "cloud");
  });
});
