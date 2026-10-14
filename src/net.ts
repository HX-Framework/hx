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

// ── Timeouts ────────────────────────────────────────────────────────────────
//
// No gateway or storage call may wait forever. Bun's fetch has no default
// timeout, and a peer that accepts the connection and then stops answering (a
// gateway whose database pool is stuck, a Fortress mid-restart) used to pin an
// upload worker for good: the pass never ended, nothing was logged, and the
// daemon sat at full CPU on its timers for hours while its backlog aged
// (Request Pricing M13). Every call now runs under a deadline sized for what
// it does; a hit surfaces as an ordinary error on the file's retry path.

/** A call that exceeded its deadline. Named so logs and classifiers can tell
 *  it from a peer error. */
export class FetchTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/** Deadline for the small JSON round trips (append-url, commit, heartbeat…). */
export const GATEWAY_TIMEOUT_MS = 60_000;
/** Deadline for the bulk metadata batches (verify, reattribute, retitle). */
export const GATEWAY_BATCH_TIMEOUT_MS = 120_000;

/** Deadline for a chunk PUT: a 60 s floor plus one second per 64 KiB — a
 *  64 KB/s link still gets a 4 MB chunk through (≈124 s), and the 32 MB grown
 *  chunk has about nine and a half minutes. */
export function chunkPutTimeoutMs(bytes: number): number {
  return GATEWAY_TIMEOUT_MS + Math.ceil(bytes / 65_536) * 1000;
}

/**
 * Run `work` under a deadline. The signal is wired into the fetch AND the
 * body read: `work` is expected to consume the response before returning, so
 * a peer that sends headers and then stalls on the body hits the same clock.
 * On expiry the pending fetch is aborted and the caller gets a
 * {@link FetchTimeoutError}.
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const reason = new FetchTimeoutError(label, timeoutMs);
  const timer = setTimeout(() => ctrl.abort(reason), timeoutMs);
  try {
    return await work(ctrl.signal);
  } catch (err) {
    // Whatever shape the runtime rejects with after an abort (the reason
    // itself, or a DOMException AbortError), the caller sees the deadline.
    if (ctrl.signal.aborted) throw reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
