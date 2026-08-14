// Per-repo upload route discovery. Before uploading a session's
// chunk, hx asks the cloud where that repo's sessions should land.
// Newer gateways also echo `attributedOrgIds` — the org ids the repo
// auto-attributes to for this user (empty = attaches to no workspace, i.e.
// personal); the settings-driven personal gate persists it per file. Routes:
//   • { mode: "cloud" }            → upload through the cloud gateway (default)
//   • { mode: "fortress-direct" }  → upload straight to the org's Fortress with
//                                    a short-lived capability token.
// Discovery is OFF the hot path: results are cached per repo, and when the cloud
// is unreachable we reuse the last good route rather than blocking an upload.

import { isSecureFetchUrl, assertSecureFetchUrl } from "./net.js";

export type Route =
  | { mode: "cloud"; attributedOrgIds?: string[] }
  | {
      mode: "fortress-direct";
      gatewayUrl: string;
      token: string;
      expiresAt: string;
      attributedOrgIds?: string[];
    };

export interface ResolveRouteOpts {
  repo: string;
  gatewayBaseUrl: string;
  accessToken: string;
  fetcher?: typeof fetch;
  cache?: Map<string, Route>;
  now?: () => number;
}

// Re-resolve a fortress route while it still has comfortably more than this much
// life left, so the capability token never expires mid-upload.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

const memo = new Map<string, Route>();

export async function resolveRoute(opts: ResolveRouteOpts): Promise<Route> {
  const { repo, gatewayBaseUrl, accessToken } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const cache = opts.cache ?? memo;
  const now = opts.now ?? Date.now;

  const cached = cache.get(repo);
  if (
    cached &&
    cached.mode === "fortress-direct" &&
    Date.parse(cached.expiresAt) - now() > REFRESH_BEFORE_EXPIRY_MS
  ) {
    return cached;
  }
  // The route request carries the bearer token; never send it over cleartext to
  // a non-loopback host (a downgraded/impersonated gateway URL from config).
  assertSecureFetchUrl(gatewayBaseUrl, "route discovery");
  try {
    const res = await fetcher(`${gatewayBaseUrl}/route?repo=${encodeURIComponent(repo)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return cached ?? { mode: "cloud" };
    const route = (await res.json()) as Route;
    // A fortress-direct route sends session bytes + a capability token straight
    // to `route.gatewayUrl`. That URL comes from the gateway response, so treat
    // it as untrusted: if it isn't https (loopback http excepted), drop the
    // route and fall back to cloud rather than uploading over cleartext.
    if (route.mode === "fortress-direct" && !isSecureFetchUrl(route.gatewayUrl)) {
      return cached ?? { mode: "cloud" };
    }
    cache.set(repo, route);
    return route;
  } catch {
    // Cloud unreachable — discovery is not on the hot path; use the last good
    // route so uploads keep flowing to the same place they were already going.
    return cached ?? { mode: "cloud" };
  }
}
