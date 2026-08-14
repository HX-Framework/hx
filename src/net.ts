// Transport guards for every gateway- or storage-supplied URL we `fetch()`.
//
// hx talks to a gateway URL from its saved config, and the gateway hands back
// further URLs at runtime (signed upload targets, a fortress-direct route,
// self-update asset URLs). Those returned URLs are attacker-influenced the
// moment the gateway is impersonated or MITM'd on a non-TLS hop, so session
// bytes, the bearer token, or a downloaded binary could otherwise be sent in
// cleartext or to an unexpected host. Before any such `fetch()` we require the
// URL to be HTTPS — mirroring the scheme check `connect.ts#openBrowser` already
// applies before handing a gateway URL to the OS.
//
// Loopback exception: `--local` pairs the daemon with the `pnpm dev` gateway at
// `http://localhost:9000` (see cli.ts LOCAL_GATEWAY_URL). Loopback never leaves
// the machine, so plaintext there is not a transport exposure; we allow http
// only for localhost / 127.0.0.0/8 / ::1 and require https for everything else.

/** Hosts for which plaintext http is allowed (dev/loopback only). */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  // 127.0.0.0/8 — any 127.x.y.z is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * True iff `url` is a transport we're willing to send credentials/bytes over:
 * https anywhere, or http to a loopback host (the `--local` dev gateway).
 */
export function isSecureFetchUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return true;
  return false;
}

/**
 * Throw unless `url` is a secure fetch target (see `isSecureFetchUrl`). Call
 * this immediately before any `fetch()` of a gateway- or storage-supplied URL.
 * `label` names the call site so a rejection points at the right hop.
 */
export function assertSecureFetchUrl(url: string, label: string): void {
  if (!isSecureFetchUrl(url)) {
    // Don't echo the whole URL (may carry a signed query token); the scheme +
    // host is enough to diagnose a downgrade or a redirect to the wrong place.
    let where: string;
    try {
      const u = new URL(url);
      where = `${u.protocol}//${u.host}`;
    } catch {
      where = "<unparseable url>";
    }
    throw new Error(
      `${label}: refusing to fetch over an insecure transport (${where}); ` +
        `gateway URLs must be https (http allowed only for localhost).`,
    );
  }
}
