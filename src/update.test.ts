import { test, expect, describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { DaemonOps } from "./daemon.js";
import { isRemoteNewer, runUpdate, secureFetch } from "./update.js";

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

// ── The shared service slot (hx2) ───────────────────────────────────────────
// hx2 runs the service: `hx update` swaps hx's own binary and leaves the
// service alone, since only `hx start` moves the device back to hx.

describe("runUpdate and the shared service slot", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const run = async (slot: string): Promise<{ restarted: number; result: Awaited<ReturnType<typeof runUpdate>>; installed: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "hx-update-slot-"));
    try {
      const binPath = join(dir, "hx");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own tmp dir
      writeFileSync(binPath, "old binary");
      const fresh = Buffer.from("new binary");
      const sha = createHash("sha256").update(fresh).digest("hex");
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith("/hx-version")) return new Response("999.0.0\n");
        if (u.endsWith(".gz")) return new Response(gzipSync(fresh));
        if (u.endsWith(".sha256")) return new Response(`${sha}  asset\n`);
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;
      let restarted = 0;
      const ops = {
        managerName: "launchd",
        install: async () => {},
        uninstall: async () => {},
        start: async () => {},
        stop: async () => ({ wasRunning: true }),
        restart: async () => {
          restarted += 1;
        },
        state: async () => ({ loaded: true, pid: 42 }),
        slotBinary: () => slot,
      } as DaemonOps;
      const result = await runUpdate({ gatewayBaseUrl: "https://gw.example", binPath, daemonOps: ops });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own tmp dir
      return { restarted, result, installed: readFileSync(binPath, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("restarts a service that runs hx", async () => {
    const r = await run("/Users/me/.let/bin/hx");
    assert.equal(r.installed, "new binary");
    assert.equal(r.restarted, 1);
    assert.equal(r.result.daemonRestarted, true);
    assert.equal(r.result.serviceRunsHx2, false);
  });

  it("swaps hx's binary but leaves a service that runs hx2 alone", async () => {
    const r = await run("/Users/me/.let/bin/hx2");
    assert.equal(r.installed, "new binary");
    assert.equal(r.restarted, 0);
    assert.equal(r.result.daemonRestarted, false);
    assert.equal(r.result.serviceRunsHx2, true);
  });
});
