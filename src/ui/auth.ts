// Auth for the local HX Client UI server.
//
// Model: `hx ui` mints a short-TTL LAUNCH token (reusable within the TTL — see
// below) and opens the
// browser at http://localhost:<port>/#k=<launch-token>. The SPA exchanges the
// fragment (which never travels on the wire) via POST /api/auth for a SESSION
// token it keeps in sessionStorage and sends on every /api call in the
// `x-hx-ui-token` header. A custom header is deliberately used instead of a
// cookie: cookies on localhost are shared across every port (any other local
// dev server would receive them), while a header bound to the page's origin
// is port-scoped and CSRF-proof by construction.
//
// The launch token is REUSABLE within a short TTL (1h). It is NOT single-use:
// containers, link-preview/unfurl, prefetch, and multi-tab all commonly fetch
// the link more than once, and a single-use token turns the second fetch into
// a "link expired" error. The TTL bounds how long a token an attacker captured
// (e.g. from the browser-opener argv on a shared multi-user host) stays valid;
// see SECURITY.md for that residual. A fresh token is minted per browser-open.
//
// Ownership (the "is that instance really mine?" question a second `hx ui`
// asks) rides a separate per-run OWNER KEY that lives ONLY in the 0600
// server-info file — never in a URL or argv. The reuse handshake proves
// knowledge of it with HMACs over a fresh nonce (both directions), so no secret
// is disclosed to a port-squatter and the squatter can't impersonate us.

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time string comparison. Hashing both sides first makes the
 * comparison length-independent, so nothing about the expected value (not even
 * its length) leaks through timing.
 */
export function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// HMAC labels for the reuse handshake — distinct so a client proof can never be
// replayed as a server proof (or vice versa).
export const CLIENT_PROOF_LABEL = "hx-ui-reissue";
export const SERVER_PROOF_LABEL = "hx-ui-instance";

/** HMAC-SHA256(ownerKey, "<label>:<nonce>") as base64url. */
export function hmacProof(ownerKey: string, label: string, nonce: string): string {
  return createHmac("sha256", ownerKey).update(`${label}:${nonce}`).digest("base64url");
}

// The launch token lives wherever `hx ui` prints it: the terminal, the
// browser-opener argv on auto-open, and — for a container run as its foreground
// process — `docker logs`. Because it's reusable, the TTL (not single-use) is
// the replay bound: anyone who can read the printed URL can exchange it until it
// expires, so keep the window bounded. An hour is generous enough for manual /
// copy-paste open (notably the container flow, where there's no auto-open to
// consume it) while still bounding that residual. A fresh token is minted per
// `hx ui` run, and the Host allowlist + session token gate the API regardless.
export const LAUNCH_TTL_MS = 60 * 60_000;

export interface UiAuth {
  /** Same-uid ownership secret; lives only in the 0600 server-info file. */
  readonly ownerKey: string;
  readonly sessionToken: string;
  /** Mint a fresh short-TTL launch token for one browser open. */
  mintLaunchToken(nowMs?: number): string;
  /** POST /api/auth: a valid, unexpired launch token → the session token.
   *  Reusable within the token's TTL (not consumed on use). */
  exchange(launchToken: string | null, nowMs?: number): string | null;
  /** Gate for /api/* requests: the x-hx-ui-token header value. */
  isValidSession(headerToken: string | null): boolean;
  /** Reuse handshake: verify a caller's proof-of-ownerKey over their nonce. */
  verifyOwnerProof(nonce: string, proof: string | null): boolean;
  /** Reuse handshake: this server's proof-of-ownerKey over the caller's nonce. */
  serverProof(nonce: string): string;
}

export function createUiAuth(): UiAuth {
  const ownerKey = mintToken();
  const sessionToken = mintToken();
  // Outstanding launch tokens: sha256 digest → expiry. Storing the digest (not
  // the token) keeps comparison constant-time and never holds the raw secret.
  const launch: { digest: Buffer; expiresAt: number }[] = [];

  const sweep = (nowMs: number): void => {
    for (let i = launch.length - 1; i >= 0; i--) {
      if (launch[i]!.expiresAt <= nowMs) launch.splice(i, 1);
    }
  };

  return {
    ownerKey,
    sessionToken,
    mintLaunchToken(nowMs = Date.now()) {
      sweep(nowMs);
      const token = mintToken();
      launch.push({
        digest: createHash("sha256").update(token).digest(),
        expiresAt: nowMs + LAUNCH_TTL_MS,
      });
      return token;
    },
    exchange(candidate, nowMs = Date.now()) {
      if (!candidate) return null;
      const cand = createHash("sha256").update(candidate).digest();
      for (const entry of launch) {
        if (entry.expiresAt <= nowMs) continue;
        // Reusable within the TTL — do NOT consume, so a preview/prefetch that
        // hits the link first doesn't lock the real page out.
        if (timingSafeEqual(cand, entry.digest)) return sessionToken;
      }
      return null;
    },
    isValidSession(headerToken) {
      return tokensMatch(headerToken, sessionToken);
    },
    verifyOwnerProof(nonce, proof) {
      return tokensMatch(proof, hmacProof(ownerKey, CLIENT_PROOF_LABEL, nonce));
    },
    serverProof(nonce) {
      return hmacProof(ownerKey, SERVER_PROOF_LABEL, nonce);
    },
  };
}

/**
 * Host-header allowlist — the DNS-rebinding gate. A malicious page at
 * attacker.com can point its own DNS name at 127.0.0.1 and fetch
 * http://attacker.com:<port>/…; the socket connects to us, but the Host
 * header gives the game away. Only loopback spellings of ourselves pass.
 */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/**
 * Origin gate for state-changing requests. Browsers attach Origin to all
 * cross-origin requests (and same-origin non-GETs); a matching loopback
 * origin — or none at all (curl, same-origin GET) — passes. Anything else
 * is another site driving the user's browser at us.
 */
export function isAllowedOrigin(originHeader: string | null, port: number): boolean {
  if (originHeader === null) return true;
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(originHeader.toLowerCase());
}
