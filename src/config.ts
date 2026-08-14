// ~/.let/hx/config.json holds the device token + gateway URL between sessions.
// Atomic-write (tmp + rename) so a crash never leaves the file half-written.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HX_DIR } from "./hx-home.js";

export interface HxConfig {
  /** Send the session's cwd to the gateway as attribution EVIDENCE (lets
   *  server-side org rules repair sessions whose repo went undetected). Default
   *  true; set false on devices whose org considers local paths sensitive —
   *  detection then relies purely on client-side resolution. */
  evidenceUpload?: boolean;
  /**
   * The gateway this device talks to — the single source of truth for every
   * command (no env var, no flag, no compile-time default). Seeded by the
   * installer on a fresh install, re-pointed by the installer when it's run
   * from a DIFFERENT gateway (each environment's install.sh carries its own
   * URL, so installing from one is the explicit act of mirroring to it — the
   * installer then drops the old token + upload state alongside), written by
   * `hx connect`, and preserved by `hx disconnect` (which only drops the
   * token) so a reconnect needs no reinstall. The `--local` tee keeps its own
   * connection in config.local.json and never touches this one.
   */
  gatewayBaseUrl: string;
  /**
   * Device auth — present only once the device is connected. A config that has
   * a `gatewayBaseUrl` but no `accessToken` is "configured but not connected"
   * (freshly installed, or post-`hx disconnect`); commands that upload require
   * the token (see `ensureConfig` in cli.ts).
   */
  accessToken?: string;
  userId?: string;
  deviceName?: string;
  // Cached the first time `hx status` resolves it from the gateway's /whoami,
  // so the "Logged in as: …" header shows instantly on later runs (and offline).
  // Optional: configs written before this field, and the moment right after
  // `hx connect`, simply don't have it yet.
  email?: string;
  /**
   * In-memory lane marker, never persisted: `readLocalConfig` stamps "local"
   * on the config it returns so the upload pipeline keeps the `--local` tee's
   * offsets in state.local.json instead of the main lane's state.json
   * (see StateScope in state.ts).
   */
  stateScope?: "main" | "local";
}

const CONFIG_DIR = HX_DIR;
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// The `--local` tee's connection to the local dev gateway — a SECOND, additive
// device link (own token), so mirroring to dev never clobbers the main one.
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, "config.local.json");
// The device id lives in its own file, NOT config.json: `hx disconnect` clears
// config.json (the auth token) but must keep the device id, so reconnecting
// the same machine restores the sessions that disconnect hid on the server.
const DEVICE_ID_PATH = path.join(CONFIG_DIR, "device-id");

export function configPath(): string {
  return CONFIG_PATH;
}

export function localConfigPath(): string {
  return LOCAL_CONFIG_PATH;
}

export function deviceIdPath(): string {
  return DEVICE_ID_PATH;
}

// Stable per-machine id, generated once and reused across connects. Survives
// `hx disconnect`; only `hx uninstall --purge` (which removes ~/.let/hx) clears it.
export async function ensureDeviceId(): Promise<string> {
  if (existsSync(DEVICE_ID_PATH)) {
    try {
      const existing = (await readFile(DEVICE_ID_PATH, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // Fall through and regenerate — an unreadable id file is no worse than
      // a missing one; a fresh id just starts a new device lineage.
    }
  }
  const id = randomUUID();
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${DEVICE_ID_PATH}.tmp`;
  await writeFile(tmp, id, { mode: 0o600 });
  await rename(tmp, DEVICE_ID_PATH);
  return id;
}

export async function readConfig(): Promise<HxConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as HxConfig;
  } catch {
    return null;
  }
}

/** The `--local` tee's connection, stamped with its state scope so everything
 *  downstream (offsets, artifact hashes) stays in the local lane's files. */
export async function readLocalConfig(): Promise<HxConfig | null> {
  if (!existsSync(LOCAL_CONFIG_PATH)) return null;
  try {
    const raw = await readFile(LOCAL_CONFIG_PATH, "utf8");
    return { ...(JSON.parse(raw) as HxConfig), stateScope: "local" };
  } catch {
    return null;
  }
}

async function writeTo(target: string, cfg: HxConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  // stateScope is an in-memory lane marker (see HxConfig) — never persist it.
  const { stateScope: _lane, ...persisted } = cfg;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

export async function writeConfig(cfg: HxConfig): Promise<void> {
  await writeTo(CONFIG_PATH, cfg);
}

export async function writeLocalConfig(cfg: HxConfig): Promise<void> {
  await writeTo(LOCAL_CONFIG_PATH, cfg);
}
