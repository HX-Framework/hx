// Single-instance bookkeeping for `hx ui`.
//
// While the server runs it keeps ~/.let/hx/ui/server.json (0600):
//   { port, pid, ownerKey }
// ownerKey is a per-run secret that NEVER appears in a URL or argv — it lives
// only in this 0600 file. A second `hx ui` that finds its port taken reads the
// file and runs a mutual-HMAC handshake with the occupant: it proves it knows
// ownerKey (so the occupant only reissues for the real owner) and requires the
// occupant to prove the same (so a port-squatter can't impersonate the real
// server and get the browser pointed at it). Only on a verified handshake does
// the occupant hand back a FRESH launch token to re-open the
// browser. A crash leaves a stale file; the handshake fails and the caller
// cleans it up and starts its own server.

import { mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HX_DIR } from "../hx-home.js";
import { HX_VERSION } from "../version.js";
import { CLIENT_PROOF_LABEL, SERVER_PROOF_LABEL, hmacProof, tokensMatch } from "./auth.js";

export const UI_DIR = join(HX_DIR, "ui");

const infoPath = (dir: string): string => join(dir, "server.json");

export interface ServerInfo {
  port: number;
  pid: number;
  /** Same-uid ownership secret — never leaves this 0600 file. */
  ownerKey: string;
}

export async function writeServerInfo(info: ServerInfo, dir: string = UI_DIR): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is
  // UI_DIR under ~/.let/hx (tests inject a tmpdir), never request input.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = infoPath(dir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

export async function readServerInfo(dir: string = UI_DIR): Promise<ServerInfo | null> {
  try {
    const raw = await readFile(infoPath(dir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServerInfo>;
    // Strict shape gate: the port feeds a loopback probe URL, so it must be a
    // real port number, not arbitrary file content.
    if (
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65535 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.ownerKey !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.ownerKey)
    ) {
      return null;
    }
    return parsed as ServerInfo;
  } catch {
    return null;
  }
}

export async function removeServerInfo(dir: string = UI_DIR): Promise<void> {
  await unlink(infoPath(dir)).catch(() => {});
}

/** Identity payload of GET /api/instance — deliberately free of secrets. */
export interface InstanceIdentity {
  app: "hx-ui";
  version: string;
}

export function instanceIdentity(): InstanceIdentity {
  return { app: "hx-ui", version: HX_VERSION };
}

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Is the recorded instance alive, genuinely ours, and answering on its port?
 * Runs the mutual-HMAC reuse handshake; returns a launch URL (carrying a fresh
 * launch token the occupant minted) when verified, null to treat as stale.
 */
export async function probeExistingInstance(
  info: ServerInfo,
  fetcher: typeof fetch = fetch,
  uiHost = "localhost",
): Promise<{ url: string } | null> {
  const base = `http://127.0.0.1:${info.port}`;
  const nonce = randomBytes(18).toString("base64url");
  try {
    // We prove we know ownerKey (proof over our nonce); the occupant, if it's
    // the real server, proves the same and returns a fresh launch token.
    const res = await fetcher(`${base}/api/instance/reissue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce,
        proof: hmacProof(info.ownerKey, CLIENT_PROOF_LABEL, nonce),
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { launchToken?: unknown; serverProof?: unknown };
    if (typeof body.launchToken !== "string" || typeof body.serverProof !== "string") return null;
    // The occupant must prove it, too — a squatter that doesn't know ownerKey
    // fails here, so we never point the browser at an impostor.
    if (!tokensMatch(body.serverProof, hmacProof(info.ownerKey, SERVER_PROOF_LABEL, nonce))) {
      return null;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(body.launchToken)) return null;
    return { url: `http://${uiHost}:${info.port}/#k=${body.launchToken}` };
  } catch {
    return null;
  }
}
