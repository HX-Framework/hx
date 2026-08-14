// Daemon-maintenance actions shared by the CLI and the UI server. Each one
// respects the state.json single-writer contract: an installed daemon is
// stopped before its state is mutated and brought back immediately after.
//
// dotfileConsent: the container (shell-hook) backend persists across restarts
// by editing ~/.bashrc + ~/.profile, which needs the user's consent. The CLI
// resolves it interactively; the UI server always passes "denied" — a browser
// click must not edit dotfiles. On launchd/systemd the value is irrelevant.

import { getDaemonOps, type DaemonState } from "./daemon.js";
import { clearAllFailures, clearBlockedFailures, resetStateCache } from "./state.js";
import { tickOnce } from "./watch.js";
import { assertSecureFetchUrl } from "./net.js";
import { writeConfig, type HxConfig } from "./config.js";

export type DotfileConsent = "granted" | "denied";

export interface DaemonActionResult {
  managerName: string;
  loaded: boolean;
  pid: number | null;
}

async function stateOf(ops = getDaemonOps()): Promise<DaemonActionResult> {
  const ds: DaemonState = await ops.state().catch(() => ({ loaded: false, pid: null }));
  return { managerName: ops.managerName, loaded: ds.loaded, pid: ds.pid };
}

export async function daemonAction(
  action: "start" | "stop" | "restart",
  dotfileConsent: DotfileConsent,
): Promise<DaemonActionResult> {
  const ops = getDaemonOps();
  const binPath = process.execPath;
  if (action === "stop") {
    await ops.stop();
  } else if (action === "restart") {
    await ops.restart({ binPath, dotfileConsent });
  } else {
    await ops.install({ binPath, dotfileConsent });
  }
  return stateOf(ops);
}

export interface RetryBlockedResult {
  sessions: number;
  files: number;
  restarted: boolean;
  /** Foreground pass result when the daemon wasn't running (CLI parity). */
  pass?: { uploaded: number; failed: number };
}

export async function retryBlocked(
  cfg: HxConfig,
  opts: {
    dotfileConsent: DotfileConsent;
    log: (msg: string) => void;
    foregroundPass?: boolean;
    /** "blocked" (default) releases vault holds only; "all" also clears the
     *  generic failure backoffs — the after-a-central-incident lever. */
    scope?: "blocked" | "all";
  },
): Promise<RetryBlockedResult> {
  const ops = getDaemonOps();
  const before = await ops.state().catch(() => ({ loaded: false, pid: null }));
  if (before.loaded) await ops.stop();
  resetStateCache();
  const cleared =
    opts.scope === "all" ? await clearAllFailures() : await clearBlockedFailures();
  if (before.loaded) {
    await ops.install({ binPath: process.execPath, dotfileConsent: opts.dotfileConsent });
    return { ...cleared, restarted: true };
  }
  if (opts.foregroundPass === false) return { ...cleared, restarted: false };
  const pass = await tickOnce(cfg, { oneShot: true }, opts.log);
  return { ...cleared, restarted: false, pass: { uploaded: pass.uploaded, failed: pass.failed } };
}

const DISCONNECT_TIMEOUT_MS = 8000;

/**
 * Revoke this device at the gateway (best-effort, bounded) and drop the local
 * token, keeping the gateway URL so a later `hx connect` re-pairs in place.
 * Returns false when there was nothing to disconnect.
 */
export async function disconnectDevice(cfg: HxConfig | null): Promise<boolean> {
  if (cfg?.accessToken) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DISCONNECT_TIMEOUT_MS);
    try {
      // Best-effort notify, but never over cleartext — a throw here is caught
      // and we still clear local state below, so the token isn't leaked to an
      // http gateway just to announce a disconnect.
      assertSecureFetchUrl(cfg.gatewayBaseUrl, "hx disconnect");
      const res = await fetch(`${cfg.gatewayBaseUrl}/devices/disconnect`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.accessToken}` },
        signal: ctrl.signal,
      });
      await res.arrayBuffer(); // release the socket so the process can exit
    } catch {
      // ignore — best-effort; fall through to clearing local state
    } finally {
      clearTimeout(timer);
    }
  }
  if (!cfg?.gatewayBaseUrl) return false;
  // config.json is the single source of truth for the gateway, so keep the
  // URL and drop only the token + identity.
  await writeConfig({ gatewayBaseUrl: cfg.gatewayBaseUrl });
  return true;
}
