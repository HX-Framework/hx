// All hx client state lives under ~/.let/hx, so the `hx` and `hx-session-vault`
// tools share one home (binaries under ~/.let/bin). Earlier builds kept state in
// ~/.hx; migrate it once, on first load, so existing device ids, auth tokens and
// upload offsets carry over with no re-auth.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const HX_DIR = join(homedir(), ".let", "hx");
const LEGACY_HX_DIR = join(homedir(), ".hx");
const ACL_MARKER = join(HX_DIR, ".acl-v1");

/**
 * Narrow ~/.let/hx to its owner on Windows.
 *
 * Everything under here is written with `{ mode: 0o600 }` — the device access
 * token, the upload offsets, the UI server's ownerKey. On POSIX that mode IS
 * the protection. On Windows, Node maps `mode` only onto the READ-ONLY
 * ATTRIBUTE and grants no ACL whatsoever, so those call sites document a
 * guarantee the OS is not providing. Default NTFS profile ACLs do keep other
 * standard users out of C:\Users\<you>, so this is hardening rather than a
 * hole — but it should be explicit rather than assumed.
 *
 * Runs at most once, tracked by a marker file: icacls is a process spawn, and
 * paying it on every invocation of a CLI this chatty would be wasteful. The
 * marker is only written on success, so a transient failure retries next run
 * instead of silently never applying.
 */
function hardenWindowsAcl(): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) return;
  // Claim the marker with O_EXCL so CREATING it is the check — an
  // existsSync-then-write leaves a window where two hx processes both decide
  // they are the one to harden. Rolled back below if icacls fails, so a
  // transient failure still retries on the next run.
  try {
    writeFileSync(ACL_MARKER, "", { flag: "wx" });
  } catch {
    return; // another process claimed it, or it is already done
  }
  const r = spawnSync(
    "icacls",
    [HX_DIR, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
    { stdio: "ignore" },
  );
  if (r.error || r.status !== 0) {
    try {
      unlinkSync(ACL_MARKER);
    } catch {
      // Could not roll back; the only cost is that we do not retry.
    }
  }
}

let done = false;

/** Move ~/.hx → ~/.let/hx once, then ensure the directory exists. Idempotent. */
export function ensureHxHome(): string {
  if (done) return HX_DIR;
  done = true;
  if (!existsSync(HX_DIR) && existsSync(LEGACY_HX_DIR)) {
    try {
      mkdirSync(join(homedir(), ".let"), { recursive: true });
      renameSync(LEGACY_HX_DIR, HX_DIR);
    } catch {
      // Cross-device move or permission issue — leave the legacy dir untouched;
      // callers mkdir(HX_DIR) and start fresh (a rare one-time re-auth).
    }
  }
  mkdirSync(HX_DIR, { recursive: true });
  hardenWindowsAcl();
  return HX_DIR;
}

// Migrate as soon as any state module imports this.
ensureHxHome();
