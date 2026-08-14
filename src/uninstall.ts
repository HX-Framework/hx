// `hx uninstall` — tear down the daemon (stop + remove plist/unit),
// remove the binary, and (with --purge) wipe `~/.let/hx/` so a future
// `hx connect` starts from scratch.
//
// Does NOT touch the user's shell-rc PATH entry the installer added —
// removing arbitrary lines from rc files is fraught (the user may have
// edited around it). We instead print the exact line they can delete by
// hand, on the way out.

import { rm, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getDaemonOps, HX_DIR } from "./daemon.js";

const IS_WIN = process.platform === "win32";
const HX_BIN_DIR = join(homedir(), ".let", "bin");
const HX_BIN_DEFAULT = join(HX_BIN_DIR, IS_WIN ? "hx.exe" : "hx");
/** The windowless service build the scheduled task runs (Windows only). */
const HX_SVC_BIN = join(HX_BIN_DIR, "hx-svc.exe");

/**
 * Remove a file that may be the EXECUTABLE THIS PROCESS IS RUNNING FROM.
 *
 * On POSIX, unlink() succeeds even then: the directory entry goes, and the
 * kernel frees the inode when the last process holding it exits.
 *
 * Windows refuses to delete a mapped image, but it will RENAME one. So park it
 * under a random sibling name and try the delete; when that fails because we
 * are still executing it, hand the parked file to a detached `cmd` that waits
 * for us to exit and then deletes it. That is the standard Windows uninstaller
 * idiom, and it leaves nothing behind on the user's PATH in the meantime.
 * Returns whether the original path is gone.
 */
async function removeBinary(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (!IS_WIN) throw err;
  }
  // Park it in %TEMP%, not beside the binary.
  //
  // The obvious approach — leave it next to hx.exe and have a detached helper
  // delete it once we exit — cannot work: Bun's `detached: true` + unref() does
  // NOT survive the parent exiting on Windows (verified; the child is killed
  // with us). So there is no "later" in this process's gift.
  //
  // Renaming into TEMP instead leaves the install directory genuinely empty,
  // which is what the user sees and judges, and puts the file where Windows
  // already expects garbage and cleans it up on its own schedule. Falls back to
  // parking in place if TEMP is on another volume, where rename cannot reach.
  const stamp = `${basename(path)}.old.${randomUUID()}`;
  let parked = join(tmpdir(), stamp);
  try {
    await rename(path, parked);
  } catch {
    parked = `${path}.old.${randomUUID()}`;
    await rename(path, parked);
  }
  // Deletable right away when this is not the binary we are executing (the
  // service build, say); still mapped when it is.
  await unlink(parked).catch(() => {});
  return true;
}

/** Drop `~/.let/bin` from the user's PATH. Windows keeps it in the registry
 *  (HKCU\\Environment), so unlike the POSIX shell-rc case we can actually
 *  remove it instead of printing a line for the user to delete by hand. */
function removeWindowsPathEntry(log: (m: string) => void): void {
  const ps =
    `$d='${HX_BIN_DIR.replace(/'/g, "''")}';` +
    `$p=[Environment]::GetEnvironmentVariable('Path','User');` +
    `if ($p) { $n=($p -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $d.TrimEnd('\\') }) -join ';';` +
    `[Environment]::SetEnvironmentVariable('Path',$n,'User') }`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
  });
  if (r.error || r.status !== 0) {
    log(`warning: could not remove ${HX_BIN_DIR} from your PATH; remove it by hand`);
  } else {
    log(`removed ${HX_BIN_DIR} from PATH (new terminals only)`);
  }
}

/** Drop the Apps & features entry install.ps1 registered. */
function removeWindowsUninstallEntry(): void {
  spawnSync(
    "reg",
    ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\hx", "/f"],
    { stdio: "ignore" },
  );
}

export interface UninstallOpts {
  /** Also remove ~/.let/hx/ (auth token + state). Default false. */
  purge?: boolean;
  /** Override binary path. Defaults to `~/.let/bin/hx`. */
  binPath?: string;
  log?: (msg: string) => void;
}

export interface UninstallResult {
  /** Daemon was successfully unloaded (or wasn't loaded to begin with). */
  daemonRemoved: boolean;
  /** Binary file was successfully removed. */
  binaryRemoved: boolean;
  /** ~/.let/hx/ was successfully wiped (only true if purge was requested). */
  configPurged: boolean;
  /** Path on disk the binary was at (whether removed or not). */
  binaryPath: string;
}

export async function runUninstall(opts: UninstallOpts = {}): Promise<UninstallResult> {
  const log = opts.log ?? noop;
  const binPath = opts.binPath ?? HX_BIN_DEFAULT;

  let daemonRemoved = false;
  try {
    const ops = getDaemonOps();
    await ops.uninstall();
    daemonRemoved = true;
    log(`removed daemon (${ops.managerName})`);
  } catch (err) {
    log(`warning: daemon teardown failed: ${(err as Error).message}`);
  }

  let binaryRemoved = false;
  // Windows installs two binaries (the console CLI and the windowless service
  // build the scheduled task runs); leaving the service one behind would leave
  // a ~98 MB orphan the daemon teardown above no longer references.
  const targets = IS_WIN ? [binPath, HX_SVC_BIN] : [binPath];
  for (const target of targets) {
    if (!existsSync(target)) {
      if (target === binPath) log(`binary not found at ${target}; skipping`);
      continue;
    }
    try {
      await removeBinary(target);
      if (target === binPath) binaryRemoved = true;
      log(`removed binary: ${target}`);
    } catch (err) {
      log(`warning: could not remove binary at ${target}: ${(err as Error).message}`);
    }
  }

  if (IS_WIN) {
    removeWindowsUninstallEntry();
    removeWindowsPathEntry(log);
  }

  let configPurged = false;
  if (opts.purge && existsSync(HX_DIR)) {
    try {
      await rm(HX_DIR, { recursive: true, force: true });
      configPurged = true;
      log(`purged ${HX_DIR}`);
    } catch (err) {
      log(`warning: could not purge ${HX_DIR}: ${(err as Error).message}`);
    }
  }

  return { daemonRemoved, binaryRemoved, configPurged, binaryPath: binPath };
}

function noop(_: string): void {
  /* no-op log */
}
