import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { isSecureFetchUrl, assertSecureFetchUrl } from "./net.js";

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
