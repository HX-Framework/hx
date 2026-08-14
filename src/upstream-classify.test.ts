// vault_home_unreachable (MC-2602's fail-closed hold for a session whose home
// Fortress is not connected) must classify as a PER-SESSION skip, never as a
// pass-wide "gateway unavailable" — one held session froze a device's entire
// upload loop on 2026-07-30.
import { describe, expect, it } from "bun:test";
import { HxHttpError, throwHttp } from "./uploader.js";
import { classifyUpstreamError, SessionUpstreamUnavailable } from "./watch.js";

const holdBody = '{"error":"vault_home_unreachable","vaultOrgId":"org-1","destinations":[]}';

describe("classifyUpstreamError", () => {
  it("treats a vault_home_unreachable 503 as a per-session skip on the cloud route", () => {
    const err = new HxHttpError(503, `append-url failed: 503 ${holdBody}`);
    const out = classifyUpstreamError(err, false);
    expect(out).toBeInstanceOf(SessionUpstreamUnavailable);
    expect(out?.reason).toBe("vault_home_unreachable");
  });

  it("still treats vault_offline as a per-session skip", () => {
    const err = new HxHttpError(503, 'commit failed: 503 {"error":"vault_offline"}');
    expect(classifyUpstreamError(err, false)?.reason).toBe("vault_offline");
  });

  it("leaves a bare cloud 503 to the pass-level pause", () => {
    expect(classifyUpstreamError(new HxHttpError(503, "boom: 503 <html>"), false)).toBeNull();
  });

  it("treats a bare 5xx on a fortress-direct route as that store being down", () => {
    expect(classifyUpstreamError(new HxHttpError(503, "boom"), true)?.reason).toBe(
      "store_unreachable",
    );
  });

  it("never classifies a 4xx as unavailable", () => {
    expect(classifyUpstreamError(new HxHttpError(404, "nope"), false)).toBeNull();
  });

  it("prefers the structured blocker's reason over message sniffing", () => {
    const err = new HxHttpError(503, "held", {
      reason: "vault_home_unreachable",
      destinations: [
        {
          vaultOrgId: "org-1",
          reason: "vault_home_unreachable",
          orgName: "Yaspa Dev",
          orgSlug: null,
          projectId: null,
          projectName: null,
          projectSlug: null,
          repoSlug: null,
          lastSeenAt: null,
        },
      ],
    });
    expect(err.vaultBlockReason).toBe("vault_home_unreachable");
    expect(err.vaultOffline).toBe(true);
  });

  it("throwHttp synthesizes the blocker from the hold's top-level vaultOrgId", async () => {
    // The exact body the gateway sent during the 2026-07-30 incident.
    const res = new Response(holdBody, { status: 503 });
    let thrown: unknown;
    try {
      await throwHttp(res, "append-url");
    } catch (e) {
      thrown = e;
    }
    const err = thrown as HxHttpError;
    expect(err).toBeInstanceOf(HxHttpError);
    expect(err.vaultBlockReason).toBe("vault_home_unreachable");
    expect(err.blocker?.reason).toBe("vault_home_unreachable");
    expect(err.blocker?.destinations[0]?.vaultOrgId).toBe("org-1");
  });

  it("keeps non-503 statuses out of the vault-hold classification", () => {
    expect(new HxHttpError(500, "vault_home_unreachable mentioned").vaultBlockReason).toBeNull();
  });
});
