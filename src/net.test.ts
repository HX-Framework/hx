import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { FetchTimeoutError, chunkPutTimeoutMs, isSecureFetchUrl, assertSecureFetchUrl, withDeadline } from "./net.js";

describe("isSecureFetchUrl", () => {
  it("accepts https to any host", () => {
    assert.equal(isSecureFetchUrl("https://workbench.let.ai/_api/hx-gateway"), true);
    assert.equal(isSecureFetchUrl("https://storage.googleapis.com/bucket/obj?sig=x"), true);
    assert.equal(isSecureFetchUrl("https://f.example/sessions/append-url"), true);
  });

  it("rejects plaintext http to a non-loopback host", () => {
    assert.equal(isSecureFetchUrl("http://workbench.let.ai/_api/hx-gateway"), false);
    assert.equal(isSecureFetchUrl("http://evil.example/x"), false);
    assert.equal(isSecureFetchUrl("http://10.0.0.5/x"), false);
  });

  it("allows plaintext http only for loopback (the --local dev gateway)", () => {
    assert.equal(isSecureFetchUrl("http://localhost:9000/workbench/_api/hx-gateway"), true);
    assert.equal(isSecureFetchUrl("http://127.0.0.1:9000/x"), true);
    assert.equal(isSecureFetchUrl("http://127.5.5.5/x"), true);
    assert.equal(isSecureFetchUrl("http://[::1]:9000/x"), true);
  });

  it("rejects non-http(s) schemes and garbage", () => {
    assert.equal(isSecureFetchUrl("ftp://host/x"), false);
    assert.equal(isSecureFetchUrl("file:///etc/passwd"), false);
    assert.equal(isSecureFetchUrl("javascript:alert(1)"), false);
    assert.equal(isSecureFetchUrl("not a url"), false);
    assert.equal(isSecureFetchUrl(""), false);
  });

  it("does not treat a loopback-lookalike hostname as loopback", () => {
    // A host that merely contains "localhost" or "127.0.0.1" as a label is not loopback.
    assert.equal(isSecureFetchUrl("http://localhost.evil.example/x"), false);
    assert.equal(isSecureFetchUrl("http://127.0.0.1.evil.example/x"), false);
  });
});

describe("assertSecureFetchUrl", () => {
  it("passes for a secure url", () => {
    assertSecureFetchUrl("https://f.example/x", "test");
  });

  it("throws for an insecure url and does not leak the query string", () => {
    let msg = "";
    try {
      assertSecureFetchUrl("http://evil.example/x?token=SECRET", "upload");
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /upload/);
    assert.match(msg, /http:\/\/evil\.example/);
    assert.equal(msg.includes("SECRET"), false);
  });
});

describe("withDeadline", () => {
  it("passes a normal result through and clears its timer", async () => {
    const out = await withDeadline("x", 1_000, async () => 42);
    assert.equal(out, 42);
  });

  it("rejects with a TimeoutError when the peer never answers", async () => {
    // A server that accepts the request and never responds — the shape that
    // used to pin an upload worker for the rest of the daemon's life.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const t0 = Date.now();
      await assert.rejects(
        withDeadline("probe", 200, (signal) => fetch(`http://127.0.0.1:${server.port}/`, { signal })),
        (err: unknown) => err instanceof FetchTimeoutError && /probe timed out after 0s/.test((err as Error).message),
      );
      assert.ok(Date.now() - t0 < 5_000, "gave up at the deadline, not later");
    } finally {
      server.stop(true);
    }
  });

  it("covers the body read too: headers that arrive and a body that stalls", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/plain" } }),
    });
    try {
      await assert.rejects(
        withDeadline("stalled body", 200, async (signal) => {
          const res = await fetch(`http://127.0.0.1:${server.port}/`, { signal });
          return res.text();
        }),
        (err: unknown) => err instanceof FetchTimeoutError,
      );
    } finally {
      server.stop(true);
    }
  });

  it("sizes the chunk deadline to the payload", () => {
    assert.equal(chunkPutTimeoutMs(0), 60_000);
    assert.equal(chunkPutTimeoutMs(4 * 1024 * 1024), 60_000 + 64_000);
    assert.ok(chunkPutTimeoutMs(32 * 1024 * 1024) < 10 * 60_000, "the grown chunk fits under the watchdog default");
  });
});
