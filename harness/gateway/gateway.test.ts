import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { FakeGateway } from "./gateway.js";

let gw: FakeGateway;
let base: string;
const auth = { authorization: "Bearer hx-harness-token", "content-type": "application/json" };

beforeEach(() => {
  gw = new FakeGateway({ routes: { "acme/repo": { vaultOrgIds: ["org-acme"] } } });
  base = gw.start();
});

afterEach(() => gw.stop());

async function appendPutCommit(sessionId: string, text: string, replace: boolean): Promise<{ totalBytes: number; componentCount: number }> {
  const append = (await (
    await fetch(`${base}/sessions/append-url`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ family: "claude-cli", sessionId, byteCount: text.length, repoSlug: null }),
    })
  ).json()) as { chunkId: string; uploadUrl: string; destinations: Array<{ status: string }> };
  expect(append.destinations.length).toBe(1);
  const put = await fetch(append.uploadUrl, { method: "PUT", headers: { "content-type": "application/x-ndjson" }, body: text });
  expect(put.status).toBe(200);
  const commit = await fetch(`${base}/sessions/commit`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ family: "claude-cli", sessionId, chunkId: append.chunkId, replace: replace || undefined, vaultOrgId: null }),
  });
  return (await commit.json()) as { totalBytes: number; componentCount: number };
}

describe("FakeGateway", () => {
  it("composes chunks: replace then append, and verify agrees with the store", async () => {
    const a = await appendPutCommit("s1", "line1\n", true);
    expect(a).toEqual({ ok: true, totalBytes: 6, componentCount: 1 } as never);
    const b = await appendPutCommit("s1", "line2\n", false);
    expect(b.totalBytes).toBe(12);
    expect(b.componentCount).toBe(2);
    const verify = (await (
      await fetch(`${base}/sessions/verify`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sessions: [{ family: "claude-cli", sessionId: "s1", byteCount: 12 }, { family: "claude-cli", sessionId: "s1", byteCount: 5 }] }),
      })
    ).json()) as { results: Array<{ status: string; storeBytes: number }> };
    expect(verify.results[0]!.status).toBe("ok");
    expect(verify.results[1]!.status).toBe("divergent");
    expect(gw.manifest()["claude-cli:s1:letai"]!.bytes).toBe(12);
    const inv = (await (await fetch(`${base}/devices/inventory`, { headers: auth })).json()) as Record<string, unknown>;
    expect(inv).toEqual({ sessions: 1, bytes: 12, oldestAt: null, newestAt: null });
  });

  it("fans out to a held vault, 410s a tombstone, and records every request", async () => {
    gw.update({ heldVaults: { "org-acme": { reason: "vault_offline", orgName: "Acme", orgSlug: "acme", projectId: "p1", projectName: "P", projectSlug: "p", repoSlug: "acme/repo", lastSeenAt: "2026-10-01T00:00:00.000Z" } } });
    const append = (await (
      await fetch(`${base}/sessions/append-url`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ family: "claude-cli", sessionId: "s2", byteCount: 10, repoSlug: "acme/repo" }),
      })
    ).json()) as { destinations: Array<{ vaultOrgId: string | null; status: string }> };
    expect(append.destinations.map((d) => [d.vaultOrgId, d.status])).toEqual([[null, "ready"], ["org-acme", "held"]]);

    gw.update({ tombstones: ["claude-cli:s3"] });
    const res = await fetch(`${base}/sessions/append-url`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ family: "claude-cli", sessionId: "s3", byteCount: 10 }),
    });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("session_deleted");

    expect(gw.record.map((r) => [r.method, r.path, r.status, r.sessionKey])).toEqual([
      ["POST", "/sessions/append-url", 200, "claude-cli:s2"],
      ["POST", "/sessions/append-url", 410, "claude-cli:s3"],
    ]);
    expect(gw.record[0]!.headers["user-agent"]).toMatch(/^Bun\//);
  });

  it("answers the pairing flow, whoami, ping, downloads and an outage", async () => {
    const code = (await (await fetch(`${base}/devices/code`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { deviceCode: string; interval: number };
    expect(code.interval).toBe(1);
    const pending = await fetch(`${base}/devices/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: code.deviceCode }) });
    expect(pending.status).toBe(202);
    const approved = (await (await fetch(`${base}/devices/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: code.deviceCode }) })).json()) as { status: string; accessToken: string };
    expect(approved.status).toBe("approved");
    expect(approved.accessToken).toBe("hx-harness-token");

    expect((await (await fetch(`${base}/whoami`, { headers: auth })).json())).toEqual({ email: "harness@example.test", deviceName: "harness-device", userId: "user_harness" });
    expect((await fetch(`${base}/whoami`)).status).toBe(401);
    const big = await fetch(`${base}/ping?bytes=4096`, { headers: auth });
    expect((await big.arrayBuffer()).byteLength).toBe(4096);
    gw.update({ version: "77.11.0" });
    expect(await (await fetch(`${base}/download/hx-version`)).text()).toBe("77.11.0\n");
    expect(await (await fetch(`${base}/download/hx2-version`)).text()).toBe("77.11.0\n");

    gw.update({ outageStatus: 503 });
    expect((await fetch(`${base}/devices/heartbeat`, { method: "POST", headers: auth, body: "{}" })).status).toBe(503);
  });
});
