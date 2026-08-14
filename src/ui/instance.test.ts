import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_PROOF_LABEL, hmacProof, mintToken } from "./auth.js";
import {
  probeExistingInstance,
  readServerInfo,
  removeServerInfo,
  writeServerInfo,
  type ServerInfo,
} from "./instance.js";

const tmp = () => mkdtempSync(join(tmpdir(), "hx-ui-instance-"));

const OWNER = mintToken();
const INFO: ServerInfo = { port: 8123, pid: 4242, ownerKey: OWNER };

describe("server-info file", () => {
  it("round-trips and removes", async () => {
    const dir = tmp();
    assert.equal(await readServerInfo(dir), null);
    await writeServerInfo(INFO, dir);
    assert.deepEqual(await readServerInfo(dir), INFO);
    await removeServerInfo(dir);
    assert.equal(await readServerInfo(dir), null);
    await removeServerInfo(dir); // second removal is a no-op, not an error
  });

  it("treats malformed content as absent", async () => {
    const dir = tmp();
    await writeServerInfo({ ...INFO, port: "nope" as unknown as number }, dir);
    assert.equal(await readServerInfo(dir), null);
    await writeServerInfo({ ...INFO, ownerKey: "has spaces!" }, dir);
    assert.equal(await readServerInfo(dir), null);
  });
});

interface StubReq {
  method?: string;
  body?: { nonce?: string; proof?: string };
}

const fetcher = (fn: (url: string, req: StubReq) => Response): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as StubReq["body"]) : undefined;
    return Promise.resolve(fn(String(input), { method: init?.method, body }));
  }) as typeof fetch;

/** A faithful genuine-server stub: verifies the client proof and answers with a
 *  fresh launch token + a valid server proof over the same nonce. */
const genuineServer = (ownerKey: string, launchToken = "fresh-tok") =>
  fetcher((url, req) => {
    if (!url.endsWith("/api/instance/reissue")) return new Response(null, { status: 404 });
    const nonce = req.body?.nonce ?? "";
    const expectClient = hmacProof(ownerKey, "hx-ui-reissue", nonce);
    if (req.body?.proof !== expectClient) return new Response(null, { status: 401 });
    return Response.json({
      launchToken,
      serverProof: hmacProof(ownerKey, SERVER_PROOF_LABEL, nonce),
    });
  });

describe("probeExistingInstance", () => {
  it("returns a fresh launch url when the mutual proof verifies", async () => {
    const result = await probeExistingInstance(INFO, genuineServer(OWNER, "fresh-tok"));
    assert.deepEqual(result, { url: "http://localhost:8123/#k=fresh-tok" });
  });

  it("uses the given uiHost in the printed url (127.0.0.1 for containers)", async () => {
    const result = await probeExistingInstance(INFO, genuineServer(OWNER, "fresh-tok"), "127.0.0.1");
    assert.deepEqual(result, { url: "http://127.0.0.1:8123/#k=fresh-tok" });
  });

  it("rejects a squatter that can't produce a valid server proof", async () => {
    // Occupant returns a token but a bogus serverProof (doesn't know ownerKey).
    const result = await probeExistingInstance(
      INFO,
      fetcher(() => Response.json({ launchToken: "attacker", serverProof: "garbage" })),
    );
    assert.equal(result, null);
  });

  it("rejects a server proof computed under a DIFFERENT owner key", async () => {
    // A squatter that somehow returns a well-formed proof but for the wrong key.
    const result = await probeExistingInstance(INFO, genuineServer(mintToken()));
    assert.equal(result, null);
  });

  it("never leaks a usable secret: the request carries only an HMAC, not ownerKey", async () => {
    let sentBody: StubReq["body"];
    await probeExistingInstance(
      INFO,
      fetcher((url, req) => {
        sentBody = req.body;
        return genuineServerResponse(OWNER, req.body?.nonce ?? "");
      }),
    );
    assert.ok(sentBody?.proof);
    assert.notEqual(sentBody?.proof, OWNER); // the raw owner key is never sent
    assert.equal(String(JSON.stringify(sentBody)).includes(OWNER), false);
  });

  it("rejects a 401 (occupant refuses our client proof)", async () => {
    const result = await probeExistingInstance(
      INFO,
      fetcher(() => new Response(null, { status: 401 })),
    );
    assert.equal(result, null);
  });

  it("treats a dead port as stale", async () => {
    const result = await probeExistingInstance(INFO, (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    assert.equal(result, null);
  });
});

function genuineServerResponse(ownerKey: string, nonce: string): Response {
  return Response.json({
    launchToken: "fresh-tok",
    serverProof: hmacProof(ownerKey, SERVER_PROOF_LABEL, nonce),
  });
}
