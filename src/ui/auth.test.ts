import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  CLIENT_PROOF_LABEL,
  LAUNCH_TTL_MS,
  SERVER_PROOF_LABEL,
  createUiAuth,
  hmacProof,
  isAllowedHost,
  isAllowedOrigin,
  mintToken,
  tokensMatch,
} from "./auth.js";

describe("mintToken", () => {
  it("produces distinct url-safe tokens with ≥256 bits", () => {
    const a = mintToken();
    const b = mintToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });
});

describe("tokensMatch", () => {
  it("accepts equal strings and rejects everything else", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abd", "abc"), false);
    assert.equal(tokensMatch("abcd", "abc"), false); // length differs — no throw
    assert.equal(tokensMatch("", "abc"), false);
    assert.equal(tokensMatch(null, "abc"), false);
    assert.equal(tokensMatch(undefined, "abc"), false);
  });
});

describe("createUiAuth — launch tokens are reusable within a short TTL", () => {
  it("exchanges a minted launch token repeatedly while it's valid", () => {
    const auth = createUiAuth();
    assert.equal(auth.exchange("wrong"), null);
    const lt = auth.mintLaunchToken();
    // Reusable — a preview/prefetch and the real page load both succeed.
    assert.equal(auth.exchange(lt), auth.sessionToken);
    assert.equal(auth.exchange(lt), auth.sessionToken);
    assert.equal(auth.exchange(lt), auth.sessionToken);
  });

  it("mints distinct tokens; each is independently valid until used", () => {
    const auth = createUiAuth();
    const a = auth.mintLaunchToken();
    const b = auth.mintLaunchToken();
    assert.notEqual(a, b);
    assert.equal(auth.exchange(b), auth.sessionToken);
    assert.equal(auth.exchange(a), auth.sessionToken); // b's use didn't consume a
  });

  it("rejects a launch token past its TTL", () => {
    const auth = createUiAuth();
    const t0 = 1_000_000;
    const lt = auth.mintLaunchToken(t0);
    assert.equal(auth.exchange(lt, t0 + LAUNCH_TTL_MS + 1), null); // expired
    const lt2 = auth.mintLaunchToken(t0);
    assert.equal(auth.exchange(lt2, t0 + LAUNCH_TTL_MS - 1), auth.sessionToken); // within window
  });

  it("validates only the session token, never a launch token or the owner key", () => {
    const auth = createUiAuth();
    const lt = auth.mintLaunchToken();
    assert.equal(auth.isValidSession(auth.sessionToken), true);
    assert.equal(auth.isValidSession(lt), false);
    assert.equal(auth.isValidSession(auth.ownerKey), false);
    assert.equal(auth.isValidSession(null), false);
  });
});

describe("createUiAuth — reuse handshake (mutual ownerKey proof)", () => {
  it("verifies a correct client proof and rejects wrong/absent ones", () => {
    const auth = createUiAuth();
    const nonce = "n-abc";
    const good = hmacProof(auth.ownerKey, CLIENT_PROOF_LABEL, nonce);
    assert.equal(auth.verifyOwnerProof(nonce, good), true);
    assert.equal(auth.verifyOwnerProof(nonce, "forged"), false);
    assert.equal(auth.verifyOwnerProof(nonce, null), false);
    // A proof over a different nonce must not verify (bound to the nonce).
    assert.equal(auth.verifyOwnerProof("other", good), false);
    // The server proof uses a DISTINCT label — a client proof can't pose as it.
    assert.notEqual(auth.serverProof(nonce), good);
    assert.equal(auth.serverProof(nonce), hmacProof(auth.ownerKey, SERVER_PROOF_LABEL, nonce));
  });

  it("a wrong owner key can neither prove nor be impersonated", () => {
    const auth = createUiAuth();
    const nonce = "n-xyz";
    const wrongKeyProof = hmacProof(mintToken(), CLIENT_PROOF_LABEL, nonce);
    assert.equal(auth.verifyOwnerProof(nonce, wrongKeyProof), false);
  });
});

describe("isAllowedHost", () => {
  it("accepts loopback spellings of our port only", () => {
    assert.equal(isAllowedHost("localhost:8000", 8000), true);
    assert.equal(isAllowedHost("127.0.0.1:8000", 8000), true);
    assert.equal(isAllowedHost("[::1]:8000", 8000), true);
    assert.equal(isAllowedHost("LOCALHOST:8000", 8000), true);
    assert.equal(isAllowedHost("localhost:8001", 8000), false);
    assert.equal(isAllowedHost("evil.example:8000", 8000), false);
    assert.equal(isAllowedHost("localhost", 8000), false);
    assert.equal(isAllowedHost(null, 8000), false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts absent or loopback origins of our port only", () => {
    assert.equal(isAllowedOrigin(null, 8000), true);
    assert.equal(isAllowedOrigin("http://localhost:8000", 8000), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:8000", 8000), true);
    assert.equal(isAllowedOrigin("http://localhost:5199", 8000), false);
    assert.equal(isAllowedOrigin("https://evil.example", 8000), false);
    assert.equal(isAllowedOrigin("null", 8000), false);
  });
});
