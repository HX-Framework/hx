import { test, expect, describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { isRemoteNewer, secureFetch } from "./update.js";

test("newer remote semver triggers update", () => {
  expect(isRemoteNewer("76.0.0", "76.0.1")).toBe(true);
  expect(isRemoteNewer("76.0.0", "77.0.0")).toBe(true);
});

test("same-or-older remote does not update", () => {
  expect(isRemoteNewer("76.0.1", "76.0.1")).toBe(false);
  expect(isRemoteNewer("76.1.0", "76.0.9")).toBe(false);
});

test("unparseable remote version means 'unknown' -> false (fall through to sha guard)", () => {
  expect(isRemoteNewer("76.0.0", "garbage")).toBe(false);
  expect(isRemoteNewer("76.0.0", null)).toBe(false);
});

describe("secureFetch redirect handling", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses to follow an https→http cross-scheme redirect (the self-update downgrade)", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      // The (https) gateway 302s to a plaintext attacker host.
      return new Response(null, { status: 302, headers: { location: "http://attacker.example/hx.gz" } });
    }) as unknown as typeof fetch;
    await assert.rejects(
      secureFetch("https://gw.example/download/hx-darwin-arm64.gz"),
      /insecure transport/,
    );
    // We requested the https origin but never fetched the http redirect target.
    assert.equal(seen.length, 1);
    assert.equal(seen[0], "https://gw.example/download/hx-darwin-arm64.gz");
  });

  it("follows a secure https→https redirect and returns the final response", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith("/hx.gz")) {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example/final.gz" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await secureFetch("https://gw.example/hx.gz");
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["https://gw.example/hx.gz", "https://cdn.example/final.gz"]);
  });

  it("caps redirect chains", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      // Always redirect to another https hop → must hit the cap, not loop forever.
      const n = Number(new URL(String(url)).searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { location: `https://gw.example/x?n=${n + 1}` } });
    }) as unknown as typeof fetch;
    await assert.rejects(secureFetch("https://gw.example/x?n=0"), /too many redirects/);
  });
});
