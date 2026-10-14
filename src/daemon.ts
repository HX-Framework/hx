// Daemon lifecycle for `hx start | stop | restart | status | logs`.
//
// macOS uses a per-user LaunchAgent (~/Library/LaunchAgents/<Label>.plist
// loaded with `launchctl bootstrap gui/$uid`). Linux uses a systemd user
// unit (~/.config/systemd/user/hx-vision.service loaded with
// `systemctl --user enable --now`). Both run as the invoking user — no
// sudo, no system writes — and both respawn on crash.
//
// The binary path that gets baked into the plist/unit is whatever
// `process.execPath` is at install time (Bun-compiled binary path, or
// node for tsx engineer runs). `hx update` writes a new binary at the
// SAME path and asks the service manager to restart so the new binary
// takes over.
//
// Both definitions also mark hx as a background process (lower CPU and I/O
// priority, slower respawn, and on Linux a memory ceiling) — see
// "Background-process limits" below. The daemon keeps the installed
// definition current itself (reconcileServiceDefinition) and rotates its own
// log files (startLogRotation).

import { homedir, platform, userInfo } from "node:os";
import { basename, join, dirname, win32 as winPath } from "node:path";
import { writeFile, mkdir, unlink, readFile, open } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { HX_DIR } from "./hx-home.js";

export { HX_DIR };
export const STDOUT_LOG = join(HX_DIR, "stdout.log");
export const STDERR_LOG = join(HX_DIR, "stderr.log");

const LAUNCHD_LABEL = "ai.let.hx-vision";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

const SYSTEMD_UNIT_NAME = "hx-vision.service";
const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);

/** Where the service manager sends the daemon's stdout and stderr. */
export interface LogPaths {
  stdout: string;
  stderr: string;
}

const DAEMON_LOGS: LogPaths = { stdout: STDOUT_LOG, stderr: STDERR_LOG };

// ─────────────────────── Background-process limits ───────────────────────
//
// hx uploads in the background; nothing it does is more urgent than the app
// the user is working in. On 2026-10-14 a runaway `hx watch` (an endless
// promise loop, fixed separately) reached a 122 GB memory footprint and filled
// swap while running at normal priority, and launchd restarted it 10 s after
// every crash. These limits make the service yield to foreground work even
// when hx itself misbehaves. All three backends get the same intent:
//
//   • lower CPU priority: launchd ProcessType=Background + Nice, systemd Nice +
//     CPUWeight, Task Scheduler priority 7 (below normal);
//   • lower disk I/O priority: launchd LowPriorityBackgroundIO (and the
//     Background class itself), systemd IOSchedulingClass=idle;
//   • at most one respawn a minute: launchd ThrottleInterval, systemd
//     RestartSec (Task Scheduler's 5-minute supervision trigger already is);
//   • a memory ceiling where the platform has one: systemd MemoryHigh /
//     MemoryMax / MemorySwapMax. launchd has no working per-job memory limit
//     on macOS, and Task Scheduler has none.

/** nice(3) value for the daemon on macOS and Linux; apps run at 0. */
const SERVICE_NICE = 10;

/**
 * Seconds between two spawns of the daemon by its service manager. Every start
 * re-runs the startup catch-up pass, so the old 5–10 s respawn turned a crash
 * loop into hundreds of full passes an hour.
 */
const RESPAWN_DELAY_SEC = 60;

/**
 * systemd: give up after this many starts within START_LIMIT_INTERVAL_SEC.
 * With RESPAWN_DELAY_SEC between automatic restarts this only trips when the
 * daemon dies within about a minute of starting, five times running — a
 * crash at startup, not an occasional crash. `hx start` / `hx restart` /
 * `hx update` clear the counter (reset-failed) before they start the unit.
 */
const START_LIMIT_BURST = 5;
const START_LIMIT_INTERVAL_SEC = 600;

/**
 * systemd memory ceiling. A healthy daemon on the heaviest device measured
 * (2026-10-14: 35k Claude Desktop session files, 16 GB of transcripts) held
 * 0.47–0.58 GB; the macOS-only Claude Desktop store re-read on `main` pushes
 * that to 2–3.4 GB, and Linux has no Claude Desktop. MemoryHigh starts kernel
 * reclaim and allocation throttling at about twice the healthy footprint;
 * MemoryMax OOM-kills the unit (and Restart= brings it back) well before it
 * can take the machine down. MemorySwapMax keeps the cap real: without it the
 * kernel would page the overflow out to swap, which is how the 2026-10-14
 * runaway filled 27.5 GB of swap.
 */
const MEMORY_HIGH = "1G";
const MEMORY_MAX = "2G";
const MEMORY_SWAP_MAX = "512M";

export interface DaemonState {
  /** Service manager has the unit loaded (regardless of process state). */
  loaded: boolean;
  /** PID of the running daemon process, or null if not running. */
  pid: number | null;
}

export interface DaemonOps {
  install(opts: InstallOpts): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  /**
   * Stop the background service and keep it stopped until `hx start`. A bare
   * unload isn't enough: launchd re-bootstraps everything under
   * ~/Library/LaunchAgents at the next login (systemd user units likewise
   * auto-start when enabled), so stop also disables the service — install()
   * re-enables it. Resolves with whether anything was actually running, and
   * throws if the service survived the stop, so the CLI never reports
   * "stopped" while the daemon is still alive.
   */
  stop(): Promise<{ wasRunning: boolean }>;
  /**
   * Restart the already-installed service so it re-execs the binary at its
   * configured path — used by `hx update` after the binary is atomically
   * swapped in place. Prefers an in-place restart (launchd `kickstart -k`,
   * systemd `restart`) over a bootout→bootstrap cycle, which on macOS can
   * race launchd's teardown and fail with "Bootstrap failed: 5: Input/output
   * error". Throws if the service does not come back up.
   */
  restart(opts: InstallOpts): Promise<void>;
  state(): Promise<DaemonState>;
  /** Pretty-printed name for messages, e.g. "launchd" or "systemd (user)". */
  managerName: string;
  /**
   * True when install()/restart() may edit the user's shell dotfiles and the
   * caller should ask for consent first — the container shell-hook backend.
   * Absent on managers that own their own system files (launchd, systemd).
   */
  needsDotfileConsent?: boolean;
  /** Shell-hook backend only: are the startup dotfiles already wired? Lets the
   *  caller skip re-prompting on repeat `hx connect` / `hx start`. */
  dotfilesWired?(): boolean;
}

export interface InstallOpts {
  /** Absolute path to the hx binary that the service manager should exec. */
  binPath: string;
  /**
   * Shell-hook (container) backend only: whether the user allowed editing
   * ~/.bashrc / ~/.profile so the mirror restarts with the container. Ignored
   * by the launchd / systemd backends, which don't touch dotfiles.
   */
  dotfileConsent?: "granted" | "denied";
}

export function getDaemonOps(): DaemonOps {
  switch (platform()) {
    case "darwin":
      return macOps();
    case "linux":
      return linuxOps();
    case "win32":
      return windowsOps();
    default:
      return unsupportedOps();
  }
}

// ─────────────────────────── macOS / launchd ────────────────────────────

function macTarget(): string {
  return `gui/${userInfo().uid}`;
}

function macState(): DaemonState {
  const r = spawnSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "pipe" });
  if (r.status !== 0) return { loaded: false, pid: null };
  // launchctl list prints a plist-fragment with PID = N or "-" (idle).
  const out = r.stdout.toString();
  const m = out.match(/"PID"\s*=\s*(\d+);/);
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

/** Block the current thread for `ms` without spinning — fine for a one-shot CLI. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `launchctl bootout` returns before launchd has finished tearing the job
 * down. Poll until the label is gone (or we time out) so the bootstrap that
 * follows doesn't collide with the dying job.
 */
function waitUntilUnloaded(maxMs = 2000): void {
  const deadline = Date.now() + maxMs;
  while (macState().loaded && Date.now() < deadline) {
    sleepSync(100);
  }
}

// launchd surfaces the bootout→bootstrap race as a transient I/O error
// ("Bootstrap failed: 5: Input/output error") or an in-progress error
// ("Bootstrap failed: 37: Operation already in progress"). Both clear once the
// old job is fully reaped, so retry a few times with backoff before giving up.
const TRANSIENT_BOOTSTRAP =
  /Bootstrap failed: (5|37|125)\b|Input\/output error|Operation (already|now) in progress/i;

function bootstrapWithRetry(target: string, plistPath: string): void {
  const backoffMs = [150, 300, 600, 1000, 2000];
  let lastDetail = "";
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    const r = spawnSync("launchctl", ["bootstrap", target, plistPath], { stdio: "pipe" });
    if (r.status === 0) return;
    lastDetail = failureDetail(r);
    if (attempt === backoffMs.length || !TRANSIENT_BOOTSTRAP.test(lastDetail)) break;
    sleepSync(backoffMs[attempt]);
  }
  throw new Error(`launchctl bootstrap ${target} ${plistPath} failed: ${lastDetail}`);
}

/**
 * Unload the job (if loaded) and load it again from the plist on disk. This is
 * the only way to make launchd pick up a CHANGED plist: launchd reads the file
 * when it loads the job, and `kickstart` respawns the definition it already
 * holds. It is also never delayed by ThrottleInterval, because the bootstrap
 * creates a fresh job.
 */
function reloadLaunchdJob(target: string): void {
  // bootout is the modern "unload"; tolerate "not loaded" so this is idempotent.
  spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  // Let launchd finish reaping the old job before bootstrapping the new one,
  // and retry the bootstrap through the transient teardown race.
  waitUntilUnloaded();
  // Enable BEFORE bootstrap: `hx stop` disables the service (so a relogin
  // can't resurrect it), and bootstrapping a disabled service fails with
  // "Bootstrap failed: 119". Enabling an already-enabled service is a no-op.
  runOrThrow("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`]);
  bootstrapWithRetry(target, LAUNCHD_PLIST);
}

/**
 * Write `content` to `path` unless the file already holds exactly that.
 * Resolves with whether the file changed. A plain write, not a rename, so a
 * definition the user keeps as a symlink stays a symlink.
 */
async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) return false;
  await writeFile(path, content);
  return true;
}

function macOps(): DaemonOps {
  return {
    managerName: "launchd",
    async install({ binPath }) {
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(LAUNCHD_PLIST, renderPlist(binPath));
      reloadLaunchdJob(macTarget());
    },
    async restart({ binPath }) {
      // Refresh the on-disk plist so a changed binary path is captured.
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const changed = await writeIfChanged(LAUNCHD_PLIST, renderPlist(binPath));
      const target = macTarget();
      if (macState().loaded && !changed) {
        // In-place restart: kill the running instance and respawn it from the
        // same plist, re-exec'ing the binary at its (now atomically-swapped)
        // path. This sidesteps the bootout→bootstrap teardown race entirely.
        // launchd holds a kickstart until ThrottleInterval has passed since the
        // last spawn, so a daemon started less than a minute ago comes back up
        // to a minute late; one that has been running longer restarts at once.
        runOrThrow("launchctl", ["kickstart", "-k", `${target}/${LAUNCHD_LABEL}`]);
      } else {
        // Not loaded, or the plist changed and launchd must read it again.
        reloadLaunchdJob(target);
      }
    },
    async uninstall() {
      const target = macTarget();
      spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      if (existsSync(LAUNCHD_PLIST)) {
        await unlink(LAUNCHD_PLIST);
      }
    },
    async start() {
      runOrThrow("launchctl", ["kickstart", "-k", `${macTarget()}/${LAUNCHD_LABEL}`]);
    },
    async stop() {
      const target = macTarget();
      // Disable first so the stop sticks: launchd re-bootstraps everything in
      // ~/Library/LaunchAgents at the next login, so a plain bootout means
      // "stopped until you next log in" — not what "Run `hx start` to resume"
      // promises. install() re-enables. Disabling is independent of load state,
      // so do it even when the job isn't currently loaded.
      spawnSync("launchctl", ["disable", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      const before = macState();
      if (!before.loaded) return { wasRunning: false };
      const r = spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
      // bootout returns before launchd finishes tearing the job down — wait,
      // then confirm the label is actually gone instead of reporting success
      // blind (the old fire-and-forget printed "stopped" even on failure).
      waitUntilUnloaded();
      if (macState().loaded) {
        throw new Error(`launchctl bootout ${target}/${LAUNCHD_LABEL} failed: ${failureDetail(r)}`);
      }
      return { wasRunning: true };
    },
    async state() {
      return macState();
    },
  };
}

// ─────────────────────────── Linux / systemd ────────────────────────────

// systemd user services need a running per-user manager AND a session bus to
// reach it. Containers (and other minimal Linux images) usually have neither —
// and may not ship `systemctl` at all — so `systemctl --user …` fails before it
// does any work. Probe with a cheap read: `show-environment` exits 0 only when
// the user bus is actually reachable. Returns the failure reason, or null when
// the session is available.
function systemdUserError(): string | null {
  const r = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "pipe" });
  if (!r.error && r.status === 0) return null;
  return failureDetail(r);
}

function probeOk(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return !r.error && r.status === 0;
}

// The shell-hook backend needs bash (the shell whose startup files we hook) and
// setsid (to launch the mirror in its own session so it survives the sourcing
// shell exiting, and so `hx stop` can kill the whole process group). Both ship
// on any real Linux; probing keeps the "not supported" path honest on images
// stripped down past them.
function containerToolsAvailable(): boolean {
  return probeOk("bash", ["-c", "exit 0"]) && probeOk("sh", ["-c", "command -v setsid >/dev/null 2>&1"]);
}

// Linux has three background backends, chosen at runtime by capability:
//   • systemd user session reachable → the systemd unit (laptops, servers);
//   • else bash + setsid present     → the shell-startup hook (containers);
//   • else                           → unsupported, with a `hx watch` pointer.
function linuxOps(): DaemonOps {
  if (systemdUserError() === null) return systemdOps();
  if (containerToolsAvailable()) return shellHookOps();
  return unsupportedOps(
    `hx can't run in the background here: no systemd user session, and no bash + ` +
      `setsid to hook into. Run \`hx watch\` to mirror in the foreground instead.`,
  );
}

function linuxState(): DaemonState {
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT_NAME], { stdio: "pipe" });
  const loaded = enabled.status === 0;
  const show = spawnSync(
    "systemctl",
    ["--user", "show", SYSTEMD_UNIT_NAME, "--property=MainPID"],
    { stdio: "pipe" },
  );
  if (show.status !== 0) return { loaded, pid: null };
  const m = show.stdout.toString().match(/MainPID=(\d+)/);
  const pid = m ? Number(m[1]) : 0;
  return { loaded, pid: pid > 0 ? pid : null };
}

/**
 * Clear the unit's failed state, which also zeroes its start-rate counter.
 * Once the unit has hit StartLimitBurst, systemd refuses every `start` ("start
 * request repeated too quickly") until this runs, and an explicit `hx start`,
 * `hx restart` or `hx update` must always be able to bring hx back. Fails
 * harmlessly when the unit is not loaded yet.
 */
function clearStartLimit(): void {
  spawnSync("systemctl", ["--user", "reset-failed", SYSTEMD_UNIT_NAME], { stdio: "ignore" });
}

function systemdOps(): DaemonOps {
  return {
    managerName: "systemd (user)",
    async install({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const changed = await writeIfChanged(SYSTEMD_UNIT_PATH, renderSystemdUnit(binPath));
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
      clearStartLimit();
      runOrThrow("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME]);
      // `start` leaves an already-running unit alone, so a changed definition
      // (new limits) would not apply until the next restart. `restart` starts
      // a stopped unit too.
      runOrThrow("systemctl", ["--user", changed ? "restart" : "start", SYSTEMD_UNIT_NAME]);
    },
    async restart({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(SYSTEMD_UNIT_PATH, renderSystemdUnit(binPath));
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
      clearStartLimit();
      // `restart` re-execs ExecStart (the swapped binary) when running, and
      // starts the unit when it was stopped — either way we end up running.
      runOrThrow("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
    },
    async uninstall() {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { stdio: "ignore" });
      if (existsSync(SYSTEMD_UNIT_PATH)) {
        await unlink(SYSTEMD_UNIT_PATH);
      }
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    },
    async start() {
      runOrThrow("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
    },
    async stop() {
      const before = linuxState();
      // disable --now = stop now AND drop the login autostart, so "stopped"
      // holds until `hx start` re-enables (mirrors the launchd disable).
      // Tolerate a missing unit so stop stays idempotent.
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { stdio: "ignore" });
      // Verify instead of trusting the exit code: is-active exits 0 only while
      // the unit is still running.
      const active = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME], { stdio: "pipe" });
      if (active.status === 0) {
        throw new Error(`systemctl --user disable --now ${SYSTEMD_UNIT_NAME} failed: unit still active`);
      }
      return { wasRunning: before.pid !== null };
    },
    async state() {
      return linuxState();
    },
  };
}

// ───────────────────── Linux / container (shell hook) ─────────────────────
//
// No systemd user session (Docker, minimal images) → keep hx alive by hooking
// the shell's startup files: a guarded launcher at ~/.let/hx/bootstrap.sh,
// sourced from ~/.bashrc and ~/.profile. Every bash shell the container starts —
// including the one it re-runs on `docker restart` — re-launches the mirror if
// it isn't already up. This is the only restart-durable mechanism that doesn't
// require controlling the container's entrypoint. Editing the user's dotfiles
// needs consent (DaemonOps.needsDotfileConsent); without it we still run for the
// current session but can't persist across a restart.

const BOOTSTRAP_PATH = join(HX_DIR, "bootstrap.sh");
const WATCH_PID_PATH = join(HX_DIR, "watch.pid");
const WATCH_LOCK_PATH = join(HX_DIR, "watch.lock");
const DISABLED_FLAG_PATH = join(HX_DIR, "disabled");
const CONFIG_JSON_PATH = join(HX_DIR, "config.json");
const HOOK_DOTFILES = [join(homedir(), ".bashrc"), join(homedir(), ".profile")];
const HOOK_BEGIN = "# >>> hx >>>";
const HOOK_END = "# <<< hx <<<";

/** POSIX single-quote a string so it can't break out of the generated script. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The line each dotfile sources. Absolute path (not $HOME-relative) so it's
// unambiguous, shell-quoted so an odd install path can't break it.
function hookSourceLine(): string {
  return `[ -f ${shquote(BOOTSTRAP_PATH)} ] && . ${shquote(BOOTSTRAP_PATH)}`;
}

// The launcher hx writes to bootstrap.sh. Runs on every bash startup; the guards
// keep it a no-op once connected+running, and self-heals on crash (while-loop
// mirrors systemd Restart=always / RestartSec=5). setsid detaches it into its
// own session/process-group so exiting the sourcing shell doesn't kill it and
// `hx stop` can group-kill it.
//
// Singleton guarantee: the `__hx_alive` fast-path avoids spawning when a
// supervisor is already up, but two shells starting at once (e.g. a `docker
// restart` entrypoint racing a `docker exec` login) could both pass it and
// launch. To make "at most one supervisor" atomic, the launched process takes a
// lifetime-held `flock` and bows out if another holds it. flock is the right
// tool here: the lock is atomic (no check-then-act window) and the kernel
// releases it when the holder dies — even on crash/SIGKILL — so, unlike a
// pidfile/mkdir lock, it can never leak a stale lock that wedges future starts.
// flock ships with setsid in util-linux (already required by this backend); if
// it's somehow absent we skip the guard and fall back to the fast-path-only
// best-effort, i.e. exactly the prior behavior.
export function renderBootstrap(binPath: string): string {
  const cfg = shquote(CONFIG_JSON_PATH);
  const disabled = shquote(DISABLED_FLAG_PATH);
  const pid = shquote(WATCH_PID_PATH);
  const lock = shquote(WATCH_LOCK_PATH);
  const bin = shquote(binPath);
  const logf = shquote(STDOUT_LOG);
  const loop =
    `if command -v flock >/dev/null 2>&1; then exec 9> ${lock}; flock -n 9 || exit 0; fi; ` +
    `echo $$ > ${pid}; while true; do ${bin} watch >> ${logf} 2>&1; sleep 5; done`;
  return `# Managed by hx — do not edit. Regenerated by \`hx start\` / \`hx update\`.
# True only when $1 is a live, non-zombie process. \`kill -0\` alone reports a
# zombie (dead-but-unreaped, common under a non-reaping container PID 1) as
# alive, which would wedge the relaunch below — so check /proc state directly.
__hx_alive() {
  [ -n "$1" ] || return 1
  __st=$(cat /proc/"$1"/stat 2>/dev/null) || return 1
  __st=\${__st##*) }   # strip through the last ") " → "<state> <ppid> ..."
  case \${__st%% *} in Z|X|x|"") return 1 ;; *) return 0 ;; esac
}
__hx_boot() {
  [ -f ${cfg} ] || return          # not connected → nothing to mirror
  [ -f ${disabled} ] && return      # \`hx stop\` set this flag
  [ -x ${bin} ] || return
  __hx_alive "$(cat ${pid} 2>/dev/null)" && return   # already running
  setsid sh -c ${shquote(loop)} >/dev/null 2>&1 &
}
__hx_boot; unset -f __hx_boot __hx_alive; unset __st
`;
}

/**
 * Supervisor pid from the pidfile, or null if absent/garbage. Requires pid > 1:
 * killWatch group-kills `-pid`, and `kill(-1)` is the POSIX "signal every
 * process" special case — a corrupt pidfile must never be able to trigger it.
 * Our supervisor is always a child (pid > 1), so this rejects nothing real.
 */
function readWatchPid(): number | null {
  try {
    const n = Number(readFileSync(WATCH_PID_PATH, "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

// Liveness via /proc, NOT `kill(pid, 0)` — the latter succeeds for a zombie
// (a dead process not yet reaped), and containers routinely leave zombies
// because PID 1 isn't a reaping init. A zombie supervisor must read as dead so
// `hx stop` doesn't report a false "survived" and the hook relaunches after a
// crash. Linux-only, which is fine: this backend only runs on Linux.
function pidAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Format: `pid (comm) state ...`; comm may contain ')' so scan past the last.
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim()[0];
    return state !== "Z" && state !== "X" && state !== "x";
  } catch {
    return false; // no /proc entry → gone
  }
}

function dotfilesWired(): boolean {
  return HOOK_DOTFILES.some((f) => {
    try {
      return readFileSync(f, "utf8").includes(HOOK_BEGIN);
    } catch {
      return false;
    }
  });
}

/** Append the hx marker block, unless already present (idempotent). Pure. */
export function insertHookBlock(content: string): string {
  if (content.includes(HOOK_BEGIN)) return content;
  return `${content}\n${HOOK_BEGIN}\n${hookSourceLine()}\n${HOOK_END}\n`;
}

/** Remove the hx marker block (and its surrounding newlines). Pure. */
export function stripHookBlock(content: string): string {
  const re = new RegExp(`\\n?${escapeRegExp(HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(HOOK_END)}\\n?`, "g");
  return content.replace(re, "\n");
}

async function wireDotfiles(): Promise<void> {
  for (const f of HOOK_DOTFILES) {
    let cur = "";
    try {
      cur = await readFile(f, "utf8");
    } catch {
      // missing → create it (never create ~/.bash_profile: it would shadow the
      // user's existing ~/.profile for login shells).
    }
    const next = insertHookBlock(cur);
    if (next !== cur) await writeFile(f, next);
  }
}

async function unwireDotfiles(): Promise<void> {
  for (const f of HOOK_DOTFILES) {
    let cur: string;
    try {
      cur = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (!cur.includes(HOOK_BEGIN)) continue;
    await writeFile(f, stripHookBlock(cur));
  }
}

// Run bootstrap.sh once, now, so `hx start` / `hx connect` brings the mirror up
// in this session without waiting for a new shell. Same guards as the hook, so
// it's a no-op when already running. The setsid child reparents to init and
// outlives this call.
function launchNow(): void {
  spawnSync("sh", [BOOTSTRAP_PATH], { stdio: "ignore" });
  // The detached supervisor writes its pidfile a beat after we return; wait for
  // it (briefly) so the caller's state() reflects the running process rather
  // than racing it and reporting "will respawn on demand" for a live daemon.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const pid = readWatchPid();
    if (pid !== null && pidAlive(pid)) return;
    sleepSync(50);
  }
}

// Kill the supervisor's whole process group (setsid made its pid the group
// leader), so the respawn loop AND the running `hx watch` both die. Poll for the
// group to clear, escalating to SIGKILL. Returns whether it was running.
function killWatch(): boolean {
  const pid = readWatchPid();
  if (pid === null) return false;
  const wasRunning = pidAlive(pid);
  try {
    process.kill(-pid, "SIGTERM"); // whole group: supervisor + its `hx watch`
  } catch {
    // group already gone
  }
  const deadline = Date.now() + 1500;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(100);
  // Unconditional final SIGKILL sweeps any straggler in the group (e.g. an
  // `hx watch` that outlived a zombied supervisor); harmless if already dead.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
  sleepSync(100);
  return wasRunning;
}

function shellHookState(): DaemonState {
  const loaded = existsSync(BOOTSTRAP_PATH) && !existsSync(DISABLED_FLAG_PATH);
  const pid = readWatchPid();
  return { loaded, pid: pid !== null && pidAlive(pid) ? pid : null };
}

function shellHookOps(): DaemonOps {
  return {
    managerName: "shell hook (container)",
    needsDotfileConsent: true,
    dotfilesWired,
    async install({ binPath, dotfileConsent }) {
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(BOOTSTRAP_PATH, renderBootstrap(binPath));
      await unlink(DISABLED_FLAG_PATH).catch(() => {}); // re-enable (mirror systemd)
      if (dotfileConsent === "granted") await wireDotfiles();
      launchNow();
    },
    async restart({ binPath, dotfileConsent }) {
      // `hx update` swapped the binary in place — regenerate with the (possibly
      // new) path, kill the old process, relaunch.
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(BOOTSTRAP_PATH, renderBootstrap(binPath));
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      if (dotfileConsent === "granted") await wireDotfiles();
      killWatch();
      await unlink(WATCH_PID_PATH).catch(() => {});
      launchNow();
    },
    async uninstall() {
      killWatch();
      await unlink(WATCH_PID_PATH).catch(() => {});
      await unlink(WATCH_LOCK_PATH).catch(() => {});
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      await unlink(BOOTSTRAP_PATH).catch(() => {});
      await unwireDotfiles();
    },
    async start() {
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      launchNow();
    },
    async stop() {
      // disabled flag = stay stopped across new shells and restarts (bootstrap
      // checks it), mirroring the launchd/systemd disable-on-stop.
      await writeFile(DISABLED_FLAG_PATH, "");
      const wasRunning = killWatch();
      const after = readWatchPid();
      if (after !== null && pidAlive(after)) {
        throw new Error(`hx background process (pid ${after}) survived stop`);
      }
      await unlink(WATCH_PID_PATH).catch(() => {});
      return { wasRunning };
    },
    async state() {
      return shellHookState();
    },
  };
}

// ─────────────────────── Windows / Task Scheduler ────────────────────────
//
// A per-user LOGON TASK, created with `schtasks /Create /XML`. This is the
// Windows analogue of the macOS LaunchAgent and the systemd --user unit: it
// runs as the invoking user, inside their session, with their profile — so it
// can actually see ~/.claude — and it needs no Administrator rights.
//
// Deliberately NOT a Windows Service. The SCM requires elevation to install and
// runs services as LocalSystem or a dedicated service account, neither of which
// has the user's %USERPROFILE%. Such a service could not find the transcripts it
// exists to mirror, and it would break the "no sudo, no system writes" property
// the launchd and systemd backends both preserve.
//
// Supervision. systemd has Restart=always and launchd has KeepAlive; Task
// Scheduler's restart-on-failure is capped by a retry count, so instead the task
// carries TWO triggers — at logon, and every 5 minutes — with
// MultipleInstancesPolicy=IgnoreNew. While the mirror is alive the repeat
// trigger is ignored; once it dies, the next tick revives it. That is the same
// shape as the container hook's `while true; …; sleep 5` loop, without a
// supervisor process of our own.
//
// Single instance. IgnoreNew makes the SCHEDULER the single-instance owner,
// exactly as launchd and systemd are for their backends. So this backend needs
// no lock file — which is fortunate, because Windows has no crash-safe advisory
// lock reachable from Bun without FFI.

const WIN_TASK_NAME = "hx-vision";
const WIN_SERVICE_EXE = "hx-svc.exe";

/**
 * The binary the scheduled task should run. The installer ships two: `hx.exe`
 * (console — the CLI) and `hx-svc.exe`, compiled with --windows-hide-console so
 * the background mirror doesn't park a console window on the desktop at every
 * logon and every 5-minute supervision tick.
 *
 * Falls back to the CLI binary when the service build isn't present (running
 * from source, or an install predating it): a visible console window is a
 * cosmetic regression, not a reason to refuse to mirror.
 */
export function windowsServiceBinary(
  binPath: string,
  exists: (p: string) => boolean = (p) => existsSync(p),
): string {
  // path.win32 explicitly, not the ambient `path`: this function only ever
  // handles Windows paths, and the ambient module is POSIX-flavored when the
  // process runs on Linux — which would silently reduce `C:\Users\me\bin\hx.exe`
  // to a bare filename. Being explicit also lets CI cover it from Linux.
  const candidate = winPath.join(winPath.dirname(binPath), WIN_SERVICE_EXE);
  return exists(candidate) ? candidate : binPath;
}

/** `DOMAIN\user` when the domain is known, else the bare username. */
function windowsUserId(): string {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME || userInfo().username;
  return domain ? `${domain}\\${user}` : user;
}

/**
 * The task definition. Two settings here are load-bearing and easy to lose:
 *
 *   • ExecutionTimeLimit PT0S — "no limit". The DEFAULT is 3 days, after which
 *     the scheduler would terminate a perfectly healthy mirror.
 *   • StartWhenAvailable — runs a trigger that was missed because the machine
 *     was asleep or off, instead of silently skipping it.
 *
 * The battery settings matter on laptops, which is most of the fleet: the
 * defaults refuse to start (and stop a running task) on battery power.
 *
 * Priority 7 is the background-process setting: the scheduler starts the
 * process in BELOW_NORMAL_PRIORITY_CLASS. Microsoft's TaskSettings.Priority
 * docs: 0 realtime, 1 high, 2–3 above normal, 4–6 normal ("interactive
 * tasks"), 7–8 below normal ("background tasks"), 9–10 idle. 7 is also the
 * scheduler's default, but it is spelled out so the intent survives anyone
 * editing the XML.
 */
export function renderTaskXml(binPath: string, userId: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>hx-vision session mirror</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>2024-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(binPath)}</Command>
      <Arguments>watch</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// State comes from the Task Scheduler COM service, not `schtasks /Query` and
// not a process scan.
//
// Not schtasks: it prints LOCALIZED labels ("Status: Running") that a German or
// Japanese Windows spells differently, so parsing them works on the developer's
// machine and fails on the customer's.
//
// Not a process scan: resolving the PID by matching a running process's path
// against the task's declared executable looked exact, and is not. When the
// windowless service build is absent the task runs the CLI binary itself — so
// `hx status` matched ITS OWN process and reported the daemon as running from a
// stopped state. IRunningTask.EnginePID is the PID the scheduler is actually
// running, which is the question being asked.
const WIN_STATE_PS = [
  `$ErrorActionPreference='SilentlyContinue';`,
  `$svc = New-Object -ComObject Schedule.Service;`,
  `$svc.Connect();`,
  `$t = $svc.GetFolder('\\').GetTask('${WIN_TASK_NAME}');`,
  `if (-not $t) { 'Absent'; ''; exit };`,
  // State is an enum: 1 Disabled, 2 Queued, 3 Ready, 4 Running.
  `switch ($t.State) { 1 {'Disabled'} 2 {'Ready'} 3 {'Ready'} 4 {'Running'} default {'Unknown'} };`,
  // NOT $pid — that is PowerShell's own automatic variable for this process.
  `$enginePid = ($t.GetInstances(0) | Select-Object -First 1).EnginePID;`,
  `if ($enginePid) { "$enginePid" } else { '' }`,
].join(" ");

/**
 * Parse the two-line state probe: task state, then the service PID (or blank).
 *
 * `loaded` follows the same meaning the other backends give it — the service
 * manager will bring this up on its own. A DISABLED task will not, and `stop()`
 * disables deliberately so the stop survives the next logon, so Disabled reads
 * as not-loaded exactly like a disabled systemd unit does.
 */
export function parseWinState(stdout: string): DaemonState {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  const state = lines[0] ?? "";
  if (!state || state === "Absent") return { loaded: false, pid: null };
  const pid = Number(lines[1]);
  return {
    loaded: state !== "Disabled",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

function winState(): DaemonState {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_STATE_PS], {
    stdio: "pipe",
  });
  if (r.error || r.status !== 0) return { loaded: false, pid: null };
  return parseWinState(r.stdout.toString());
}

/** Write the task XML where schtasks can read it. */
async function writeTaskXml(xml: string): Promise<string> {
  const target = join(HX_DIR, `task-${process.pid}.xml`);
  // `schtasks /XML` requires UTF-16; handed a UTF-8 file it fails with a parse
  // error that names neither the encoding nor the line.
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
  await writeFile(target, buf);
  return target;
}

/** (Re)register the task at `binPath` and start it. Shared by install/restart. */
async function winRegister(binPath: string): Promise<void> {
  await mkdir(HX_DIR, { recursive: true });
  const exe = windowsServiceBinary(binPath);
  const xmlPath = await writeTaskXml(renderTaskXml(exe, windowsUserId()));
  try {
    // /F overwrites an existing registration, which also re-enables a task that
    // `hx stop` disabled — matching install()'s re-enable on the other backends.
    runOrThrow("schtasks", ["/Create", "/TN", WIN_TASK_NAME, "/XML", xmlPath, "/F"]);
  } finally {
    await unlink(xmlPath).catch(() => {});
  }
  // Bounce any instance still running the PREVIOUS definition. /Create /F
  // rewrites the task but does not touch a live process, and
  // MultipleInstancesPolicy=IgnoreNew makes the /Run below a no-op while one is
  // alive — so without this, `hx restart` reports success while the old process
  // keeps running, and `hx update` leaves the daemon on the old binary. launchd
  // gets this from bootout+bootstrap; this gives Task Scheduler the same meaning
  // of install(): registered, enabled, and running the CURRENT definition.
  winKill();
  // /Create registers but does not run; the logon trigger has already passed.
  runOrThrow("schtasks", ["/Run", "/TN", WIN_TASK_NAME]);
}

/** Poll briefly for the service process to appear after a start. */
function waitForWinPid(maxMs = 5000): DaemonState {
  const deadline = Date.now() + maxMs;
  let last = winState();
  while (last.pid === null && Date.now() < deadline) {
    sleepSync(200);
    last = winState();
  }
  return last;
}

/** Cheap liveness probe. Windows has no zombie state, so unlike the container
 *  backend's /proc read, kill(pid, 0) is a truthful answer here — and it costs
 *  nothing next to spawning PowerShell for a full state query. */
function winPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the running instance and WAIT for it to actually be gone.
 *
 * `schtasks /End` asks the scheduler to stop the instance it knows about and
 * returns before the process has exited; a process the scheduler lost track of
 * survives it entirely. So follow up with taskkill — but BY PID, resolved from
 * the task's own declared executable (see winState), not by image name. The
 * task runs either binary depending on the install: the windowless service
 * build normally, or the CLI binary when that build is absent. An /IM sweep
 * hardcoded to one of them silently kills nothing in the other case, which is
 * exactly how `hx stop` came to report "survived stop" against a live mirror.
 *
 * /T kills the tree: Windows has no process group to signal the way the POSIX
 * backends do with kill(-pid).
 */
function winKill(maxMs = 8000): DaemonState {
  const before = winState();
  spawnSync("schtasks", ["/End", "/TN", WIN_TASK_NAME], { stdio: "ignore" });
  if (before.pid !== null) {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(before.pid)], { stdio: "ignore" });
    const deadline = Date.now() + maxMs;
    while (winPidAlive(before.pid) && Date.now() < deadline) sleepSync(100);
  }
  return winState();
}

function windowsOps(): DaemonOps {
  return {
    managerName: "Task Scheduler",
    async install({ binPath }) {
      await winRegister(binPath);
    },
    async restart({ binPath }) {
      // `hx update` swapped the binary in place — re-register so a changed path
      // is captured. winRegister bounces the live instance itself.
      await winRegister(binPath);
      if (waitForWinPid().pid === null) {
        throw new Error(
          `scheduled task ${WIN_TASK_NAME} was (re)registered but no process appeared; ` +
            `check Task Scheduler history for the task's last result.`,
        );
      }
    },
    async uninstall() {
      winKill();
      spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"], { stdio: "ignore" });
    },
    async start() {
      runOrThrow("schtasks", ["/Change", "/TN", WIN_TASK_NAME, "/ENABLE"]);
      runOrThrow("schtasks", ["/Run", "/TN", WIN_TASK_NAME]);
    },
    async stop() {
      const before = winState();
      // Disable BEFORE killing, and in that order: a task left enabled comes
      // back at the next logon — and, with the 5-minute supervision trigger,
      // possibly within seconds — which would make "Run `hx start` to resume" a
      // lie. install() re-enables via /Create /F.
      spawnSync("schtasks", ["/Change", "/TN", WIN_TASK_NAME, "/DISABLE"], { stdio: "ignore" });
      const after = winKill();
      if (after.pid !== null) {
        throw new Error(`hx background process (pid ${after.pid}) survived stop`);
      }
      return { wasRunning: before.pid !== null };
    },
    async state() {
      return winState();
    },
  };
}

// ───────────────────────── Unsupported platforms ─────────────────────────

function unsupportedOps(
  msg = `hx daemon mode is not yet supported on ${platform()}. Use \`hx watch\` to run in a terminal.`,
): DaemonOps {
  return {
    managerName: "none",
    async install() {
      throw new Error(msg);
    },
    async restart() {
      throw new Error(msg);
    },
    async uninstall() {
      // No-op; nothing to remove on unsupported platforms.
    },
    async start() {
      throw new Error(msg);
    },
    async stop(): Promise<{ wasRunning: boolean }> {
      throw new Error(msg);
    },
    async state() {
      return { loaded: false, pid: null };
    },
  };
}

// ─────────────────────────────── Templates ────────────────────────────────
//
// hx owns these files: install(), restart() and the daemon's own
// reconcileServiceDefinition() rewrite them whole, so the first line of each
// says so. Changing a template changes every installed definition the next
// time an updated daemon starts — keep the output deterministic.

const MANAGED_NOTE =
  "Managed by hx. hx start, hx update and the hx daemon rewrite this file, so local edits do not last.";

/**
 * The LaunchAgent plist. Measured on macOS 26.4 with a probe job: without the
 * background keys launchd spawns the job as `spawn type = daemon (3)` at nice 0
 * and scheduler priority 20; with them, as `spawn type = background (5)` at
 * nice 10 and priority 4, the darwin-background band.
 *
 *   • ProcessType=Background — launchd puts the process in the
 *     darwin-background band (setpriority(2), PRIO_DARWIN_BG): the lowest CPU
 *     scheduling priority, disk I/O throttled like a setiopolicy_np(3)
 *     throttleable policy, and network I/O throttled on sockets it opens.
 *     While the machine is idle hx runs as before; under contention it waits.
 *   • LowPriorityBackgroundIO — the kernel treats the job's filesystem I/O as
 *     low priority while it is in that band (`launchctl print` lists it as
 *     "low priority background i/o").
 *   • Nice=10 — ordinary nice(3). Redundant while ProcessType holds, and still
 *     right if a later macOS changes what Background means.
 *   • ThrottleInterval=60 — launchd spawns the job at most once a minute
 *     (default: every 10 s). A job that ran longer than that is respawned at
 *     once, so this only slows a crash loop. It also holds `kickstart -k` back
 *     until a minute has passed since the last spawn (see restart()).
 *
 * The log paths are a parameter only so tests can render the file without the
 * caller's home directory in it.
 */
export function renderPlist(binPath: string, logs: LogPaths = DAEMON_LOGS): string {
  // The daemon runs `hx watch`, which reads the gateway + token from
  // ~/.let/hx/config.json — so no HX_GATEWAY_URL is injected into the service
  // environment. That's deliberate: a stale env var must never be able to
  // override config (the bug that broke `hx update` on a connected device).
  const envEntries: Array<[string, string]> = [
    ["PATH", "/usr/local/bin:/usr/bin:/bin"],
  ];
  const envBlock = envEntries
    .map(([k, v]) => `      <key>${k}</key><string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MANAGED_NOTE} -->
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(binPath)}</string>
      <string>watch</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>ThrottleInterval</key><integer>${RESPAWN_DELAY_SEC}</integer>
    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityBackgroundIO</key><true/>
    <key>Nice</key><integer>${SERVICE_NICE}</integer>
    <key>StandardOutPath</key><string>${escapeXml(logs.stdout)}</string>
    <key>StandardErrorPath</key><string>${escapeXml(logs.stderr)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envBlock}
    </dict>
  </dict>
</plist>
`;
}

/**
 * The systemd --user unit. What each setting needs to take effect in a USER
 * unit (systemd's user@.service delegates the memory and pids controllers to
 * the user manager, and cpu as well since systemd 252):
 *
 *   • Nice=10, IOSchedulingClass=idle — applied by the user manager to the
 *     process it forks (setpriority(2), ioprio_set(2)). Lowering your own
 *     priority needs no privilege, so these work in every user unit, cgroup v1
 *     or v2. The idle I/O class only matters under an I/O scheduler that
 *     honours I/O priorities (BFQ); with mq-deadline or none it is accepted and
 *     has no effect.
 *   • CPUWeight=20 — cgroup v2 `cpu.weight` (default 100): under contention hx
 *     gets a fifth of the CPU share of a default-weighted sibling. Needs the cpu
 *     controller delegated (systemd 252+, or a Delegate= drop-in for
 *     user@.service on older releases). Nice covers the case where it is not:
 *     nice only ranks processes that share a cpu cgroup, and without the cpu
 *     controller they all do.
 *   • MemoryHigh / MemoryMax / MemorySwapMax — cgroup v2 `memory.high`,
 *     `memory.max`, `memory.swap.max`. Need the memory controller, which user
 *     managers get by default on the unified (v2) hierarchy. On the legacy v1
 *     hierarchy no controller is delegated to a user manager, so these do
 *     nothing there.
 *   • Restart/RestartSec/StartLimit* — the manager's own bookkeeping; work
 *     everywhere. StartLimit* belongs in [Unit] (systemd 230+).
 *
 * systemd writes cgroup attributes only for controllers available to the
 * manager; a setting whose controller is missing is left unapplied and the
 * unit still starts.
 *
 * The log paths are a parameter only so tests can render the file without the
 * caller's home directory in it.
 */
export function renderSystemdUnit(binPath: string, logs: LogPaths = DAEMON_LOGS): string {
  // No HX_GATEWAY_URL in the unit: `hx watch` reads the gateway + token from
  // ~/.let/hx/config.json, and a stale env var must never override config.
  return `# ${MANAGED_NOTE}
# To override a setting, use a drop-in: systemctl --user edit ${SYSTEMD_UNIT_NAME}
[Unit]
Description=hx-vision session mirror
After=network-online.target
StartLimitIntervalSec=${START_LIMIT_INTERVAL_SEC}
StartLimitBurst=${START_LIMIT_BURST}

[Service]
Type=simple
ExecStart=${binPath} watch
Restart=always
RestartSec=${RESPAWN_DELAY_SEC}
Nice=${SERVICE_NICE}
IOSchedulingClass=idle
CPUWeight=20
MemoryHigh=${MEMORY_HIGH}
MemoryMax=${MEMORY_MAX}
MemorySwapMax=${MEMORY_SWAP_MAX}
StandardOutput=append:${logs.stdout}
StandardError=append:${logs.stderr}

[Install]
WantedBy=default.target
`;
}

// ─────────────── Keeping the installed definition current ───────────────
//
// install() and restart() write the definition from the template of the hx
// binary that RUNS them. `hx update` is run by the OLD binary: it swaps the new
// binary in at the same path and then restarts the service with the OLD
// template. A device that only ever updates would therefore keep the
// definition it was first installed with — without any of the limits above —
// until someone ran `hx start` by hand.
//
// So the daemon checks for itself. When its service manager starts it, it
// renders the definition with its own template; if the installed file differs,
// it rewrites the file and has the manager load it. Guard rails:
//   • only in the process the service manager started — a foreground
//     `hx watch` never touches the service;
//   • only when the definition runs this very binary — a definition pointed
//     at another binary is left alone;
//   • at most one reload per distinct definition per hour, so a file that
//     something keeps reverting cannot become a restart loop.

export type ServiceKind = "launchd" | "systemd";

/** The service manager that started this process, when it started it as hx's service. */
export function serviceManagerOf(
  env: NodeJS.ProcessEnv = process.env,
  plat: string = platform(),
  readCgroup: () => string = () => readFileSync("/proc/self/cgroup", "utf8"),
): ServiceKind | null {
  // launchd sets XPC_SERVICE_NAME to the job's label for every process it
  // spawns (verified with a probe job on macOS 26.4).
  if (plat === "darwin") return env.XPC_SERVICE_NAME === LAUNCHD_LABEL ? "launchd" : null;
  if (plat === "linux") {
    // systemd runs each unit in a cgroup named after it, e.g.
    // 0::/user.slice/user-1000.slice/user@1000.service/app.slice/hx-vision.service
    try {
      const inUnit = readCgroup()
        .split("\n")
        .some((line) => line.trimEnd().endsWith(`/${SYSTEMD_UNIT_NAME}`));
      return inUnit ? "systemd" : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The binary an installed definition runs, as written in it, or null. */
export function definitionBinPath(kind: ServiceKind, content: string): string | null {
  if (kind === "launchd") {
    const m = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
    return m ? unescapeXml(m[1]) : null;
  }
  const m = content.match(/^ExecStart=(.+) watch$/m);
  return m ? m[1] : null;
}

export type DefinitionPlan =
  | { action: "current" }
  | { action: "rewrite"; next: string }
  | { action: "skip"; reason: string };

/**
 * Decide what to do with an installed definition, given the binary this
 * process runs. `sameFile` says whether two paths name the same file; the
 * caller follows symlinks, tests pass a stub.
 */
export function planDefinitionUpdate(
  kind: ServiceKind,
  installed: string,
  runningBin: string,
  sameFile: (a: string, b: string) => boolean,
  logs: LogPaths = DAEMON_LOGS,
): DefinitionPlan {
  const bin = definitionBinPath(kind, installed);
  if (bin === null) return { action: "skip", reason: "no binary path found in it" };
  if (!sameFile(bin, runningBin)) {
    return { action: "skip", reason: `it runs ${bin}, not this binary (${runningBin})` };
  }
  // Render with the path exactly as the definition spells it, so this only
  // ever changes the template, never which binary the service runs.
  const next = kind === "launchd" ? renderPlist(bin, logs) : renderSystemdUnit(bin, logs);
  return next === installed ? { action: "current" } : { action: "rewrite", next };
}

const RELOAD_MARKER_PATH = join(HX_DIR, "service-reload.json");
const RELOAD_RETRY_MS = 60 * 60_000;

/**
 * True when the marker records a reload to exactly `next` less than an hour
 * before `now`. A marker from the future (clock change) does not count.
 */
export function reloadedRecently(marker: string | null, next: string, now: number): boolean {
  if (!marker) return false;
  try {
    const m = JSON.parse(marker) as { sha256?: unknown; at?: unknown };
    return (
      m.sha256 === sha256Hex(next) &&
      typeof m.at === "number" &&
      now >= m.at &&
      now - m.at < RELOAD_RETRY_MS
    );
  } catch {
    return false;
  }
}

/**
 * Bring the installed service definition up to this binary's template and have
 * the service manager load it. Called by `hx watch` before the watch loop
 * starts. Resolves "reloading" when the service manager is about to stop this
 * process and start the new definition, so the caller can hold off on work it
 * would have to abandon; anything else means carry on.
 */
export async function reconcileServiceDefinition(
  log: (msg: string) => void,
): Promise<"current" | "reloading" | "skipped"> {
  const kind = serviceManagerOf();
  if (kind === null) return "skipped";
  const path = kind === "launchd" ? LAUNCHD_PLIST : SYSTEMD_UNIT_PATH;
  const installed = await readFile(path, "utf8").catch(() => null);
  if (installed === null) return "skipped"; // removed under us: uninstall wins
  const plan = planDefinitionUpdate(kind, installed, process.execPath, sameFile);
  if (plan.action === "current") return "current";
  if (plan.action === "skip") {
    log(`[hx] left the service definition ${path} as it is: ${plan.reason}`);
    return "skipped";
  }
  const marker = await readFile(RELOAD_MARKER_PATH, "utf8").catch(() => null);
  if (reloadedRecently(marker, plan.next, Date.now())) {
    log(`[hx] the service definition ${path} changed back after a reload less than an hour ago; not reloading again yet`);
    return "skipped";
  }
  try {
    await writeFile(path, plan.next);
    await writeFile(
      RELOAD_MARKER_PATH,
      JSON.stringify({ sha256: sha256Hex(plan.next), at: Date.now() }),
      { mode: 0o600 },
    );
    log(`[hx] updated the service definition ${path} to this version; reloading the service`);
    if (kind === "launchd") reloadLaunchdFromJob();
    else reloadSystemdFromUnit();
    return "reloading";
  } catch (err) {
    log(`[hx] could not update the service definition ${path}: ${(err as Error).message}`);
    return "skipped";
  }
}

/**
 * Reload the LaunchAgent from inside its own job. `bootout` stops the job's
 * process, so the job cannot unload and reload itself; a helper in its own
 * session does it. spawn({ detached: true }) calls setsid(2), and launchd's
 * cleanup of a stopped job kills only the job's process group (see
 * AbandonProcessGroup in launchd.plist(5)), so the helper outlives the bootout.
 * Verified with a probe job on macOS 26.4. The helper is `hx restart` from this
 * same binary — it writes the plist from its own path, then bootout, wait for
 * the unload, enable, bootstrap with retries: the path `hx start` has always
 * taken — and its output goes to the daemon's own log descriptors.
 */
function reloadLaunchdFromJob(): void {
  const child = spawn(process.execPath, ["restart"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.unref();
}

/**
 * Reload the systemd unit from inside it. The manager re-reads the file, then
 * performs the restart itself: it stops this process (SIGTERM) and starts the
 * new definition. --no-block returns once the job is queued. systemctl runs in
 * this unit's cgroup, so the stop can reach it before it exits; a death by
 * signal is therefore not a failure.
 */
function reloadSystemdFromUnit(): void {
  runOrThrow("systemctl", ["--user", "daemon-reload"]);
  const r = spawnSync("systemctl", ["--user", "--no-block", "restart", SYSTEMD_UNIT_NAME], {
    stdio: "pipe",
  });
  if (r.error || (r.status !== 0 && r.signal === null)) {
    throw new Error(`systemctl --user --no-block restart ${SYSTEMD_UNIT_NAME} failed: ${failureDetail(r)}`);
  }
}

/** Same file on disk, following symlinks; falls back to comparing the paths. */
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Turn a spawnSync result into a human-readable failure reason. When the
// process couldn't even be launched (binary missing, no bus to connect to)
// spawnSync leaves `status` null/undefined and puts the real cause on `error` —
// surface that instead of a meaningless "(exit undefined)".
function failureDetail(r: ReturnType<typeof spawnSync>): string {
  if (r.error) return r.error.message;
  const stderr = r.stderr?.toString().trim() ?? "";
  const stdout = r.stdout?.toString().trim() ?? "";
  return stderr || stdout || `exit ${r.status ?? "unknown"}`;
}

function runOrThrow(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.error || r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${failureDetail(r)}`);
  }
}

/**
 * Mirror this process's stdout/stderr into the daemon log files. Windows only.
 *
 * launchd has StandardOutPath and systemd has StandardOutput=append: — the
 * service manager does the redirection, so `hx watch` just prints and `hx logs`
 * finds it. Task Scheduler has NO equivalent. Worse, the service build is
 * compiled --windows-hide-console and has no console to print to either: without
 * this, every line the daemon emits is discarded and `hx logs` is empty forever,
 * on the one platform where it is the only diagnostic a user has.
 *
 * The file write comes first and the real stream second, both inside a try — the
 * windowless build's stdout is not a valid handle, and a throw there would take
 * the mirror down over a log line.
 *
 * The file writes are synchronous, on a descriptor this module owns
 * (ownLogFds): a line is on disk before the next one is printed, a crash loses
 * nothing that was already logged, and log rotation can close and reopen the
 * file between two writes (see rotateOwnLog).
 */
export function teeStdioToLogs(): void {
  if (platform() !== "win32") return;
  mkdirSync(HX_DIR, { recursive: true });
  for (const [stream, target] of [
    [process.stdout, STDOUT_LOG],
    [process.stderr, STDERR_LOG],
  ] as const) {
    if (!holdLogFile(target)) continue; // a log we cannot open must never stop the mirror
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      writeHeldLog(target, chunk);
      try {
        return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      } catch {
        // No console attached (the windowless service build) — the file write
        // above is the real output, so report success.
        return true;
      }
    }) as typeof stream.write;
  }
}

// ───────────────────────────── Log rotation ─────────────────────────────
//
// stdout.log and stderr.log used to grow forever: one laptop's stdout.log had
// reached 424 MB (2.2 million lines) by 2026-10-14. The daemon now keeps each
// under LOG_MAX_BYTES and keeps LOG_KEEP older copies (<log>.1, <log>.2), so a
// log takes at most about (LOG_KEEP + 1) × LOG_MAX_BYTES of disk.
//
// On macOS and Linux the service manager, not hx, opens the log: launchd's
// StandardOutPath / StandardErrorPath, systemd's `append:` and the container
// hook's `>>` all open it O_APPEND (lsof shows launchd's as "AP") and hold that
// descriptor for the life of the process. Renaming the file would send every
// later write to the renamed copy, so rotation copies and then truncates in
// place: the tail goes to <log>.1, older copies shift up, and the live file is
// cut to zero. Because the writer's descriptor is O_APPEND, its next write
// lands at the new end — offset 0 — leaving no hole. A line another process
// writes between the copy and the truncate is lost; none of the daemon's own
// lines can be, because rotation runs synchronously on the JavaScript thread
// that logs them.
//
// On Windows hx writes the files itself (teeStdioToLogs) and closes its own
// descriptor around the rotation instead.
//
// Only a process that writes a log rotates it. The daemon checks at startup
// (which also trims a log that grew large before rotation existed), once a
// minute, and after every LOG_CHECK_BYTES of its own output — so even a loop
// that starves the timers cannot fill the disk with log lines.

export const LOG_MAX_BYTES = 20 * 1024 * 1024;
export const LOG_KEEP = 2;
const LOG_CHECK_INTERVAL_MS = 60_000;
const LOG_CHECK_BYTES = 1024 * 1024;
const LOG_COPY_CHUNK = 1024 * 1024;

/** Log files this process writes itself (the Windows tee): path → descriptor. */
const ownLogFds = new Map<string, number>();

/**
 * Open `path` for appending and keep the descriptor, so this process writes the
 * log itself (writeHeldLog) and rotation can close and reopen it. Returns
 * whether the file could be opened.
 */
export function holdLogFile(path: string): boolean {
  if (ownLogFds.has(path)) return true;
  try {
    ownLogFds.set(path, openSync(path, "a"));
    return true;
  } catch {
    return false;
  }
}

/** Append to a log opened with holdLogFile. Never throws. */
export function writeHeldLog(path: string, chunk: unknown): void {
  const fd = ownLogFds.get(path);
  if (fd === undefined) return;
  try {
    if (typeof chunk === "string") writeSync(fd, chunk);
    else if (chunk instanceof Uint8Array) writeSync(fd, chunk);
  } catch {
    /* a log we cannot write must never crash the mirror */
  }
}

/** Close a log opened with holdLogFile. */
export function releaseLogFile(path: string): void {
  const fd = ownLogFds.get(path);
  ownLogFds.delete(path);
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

/** `<log>.1`, `<log>.2`, … */
export function rotatedLogPath(path: string, generation: number): string {
  return `${path}.${generation}`;
}

/**
 * Rotate one log in place when it is larger than `maxBytes`: copy its last
 * `maxBytes` (from the start of a line) to `<log>.1`, shift older copies up
 * to `<log>.<keep>`, and truncate the live file to zero. Returns whether it
 * rotated. Never throws: a log that cannot be rotated is left as it is.
 */
export function rotateLogFile(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  if (fileSize(path) <= maxBytes) return false;
  const tmp = `${rotatedLogPath(path, 1)}.tmp`;
  try {
    if (keep > 0) copyLogTail(path, tmp, maxBytes);
    truncateSync(path, 0);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was copied */
    }
    return false;
  }
  if (keep > 0) {
    try {
      for (let g = keep; g > 1; g--) {
        try {
          renameSync(rotatedLogPath(path, g - 1), rotatedLogPath(path, g));
        } catch {
          /* that generation does not exist yet */
        }
      }
      renameSync(tmp, rotatedLogPath(path, 1));
    } catch {
      // The live file is already cut. Losing the copy loses old lines, never
      // the ability to log, so give up quietly.
    }
  }
  return true;
}

/**
 * Copy the last `maxBytes` of `src` to `dst`, starting at a line boundary. The
 * second pass picks up anything appended during the first, so the truncate
 * that follows loses as little as possible. Copies in 1 MiB chunks: rotating a
 * 424 MB log must not need 424 MB of memory.
 */
function copyLogTail(src: string, dst: string, maxBytes: number): void {
  const inFd = openSync(src, "r");
  try {
    const outFd = openSync(dst, "w", 0o600);
    try {
      let end = fstatSync(inFd).size;
      let pos = lineStartAtOrAfter(inFd, Math.max(0, end - maxBytes));
      const buf = Buffer.allocUnsafe(LOG_COPY_CHUNK);
      for (let pass = 0; pass < 2 && pos < end; pass++) {
        while (pos < end) {
          const n = readSync(inFd, buf, 0, Math.min(buf.length, end - pos), pos);
          if (n <= 0) break;
          writeSync(outFd, buf, 0, n);
          pos += n;
        }
        end = fstatSync(inFd).size;
      }
    } finally {
      closeSync(outFd);
    }
  } finally {
    closeSync(inFd);
  }
}

/**
 * The offset of the first line that starts at or after `offset`. Looks at most
 * 64 KiB ahead; a line longer than that is cut where `offset` falls.
 */
function lineStartAtOrAfter(fd: number, offset: number): number {
  if (offset === 0) return 0;
  const buf = Buffer.alloc(64 * 1024);
  const n = readSync(fd, buf, 0, buf.length, offset - 1);
  const nl = buf.subarray(0, n).indexOf(0x0a);
  return nl === -1 ? offset : offset + nl;
}

/** Is descriptor `fd` open on the regular file at `path` (same device and inode)? */
export function fdWritesFile(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd);
    const onDisk = statSync(path);
    return held.isFile() && held.dev === onDisk.dev && held.ino === onDisk.ino;
  } catch {
    return false;
  }
}

/**
 * The daemon logs this process writes: the files its stdout / stderr point at
 * (launchd, systemd, the container hook), or the ones the Windows tee holds.
 * A foreground `hx watch` in a terminal writes neither.
 */
function logsThisProcessWrites(): string[] {
  return [STDOUT_LOG, STDERR_LOG].filter(
    (path) => ownLogFds.has(path) || fdWritesFile(1, path) || fdWritesFile(2, path),
  );
}

/**
 * rotateLogFile, plus: when this process holds the log itself (holdLogFile),
 * close the descriptor first, so no write goes through a handle whose idea of
 * the file predates the truncate, and reopen it at the new end afterwards.
 */
export function rotateOwnLog(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  if (!ownLogFds.has(path)) return rotateLogFile(path, maxBytes, keep);
  if (fileSize(path) <= maxBytes) return false;
  releaseLogFile(path);
  try {
    return rotateLogFile(path, maxBytes, keep);
  } finally {
    // If this fails the next lines have nowhere to go; the console copy still happens.
    holdLogFile(path);
  }
}

/** Size of the file at `path`, or 0 when it cannot be read. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

let logRotationStarted = false;

/**
 * Keep the daemon logs this process writes under LOG_MAX_BYTES: rotate now,
 * once a minute, and after every LOG_CHECK_BYTES written through
 * process.stdout / process.stderr. Does nothing in a process that writes
 * neither log. `log` reports each rotation (it writes to the fresh file, so
 * its first line says what happened). Call after teeStdioToLogs.
 */
export function startLogRotation(log: (msg: string) => void): void {
  if (logRotationStarted) return;
  logRotationStarted = true;
  if (logsThisProcessWrites().length === 0) return;
  const mb = Math.round(LOG_MAX_BYTES / (1024 * 1024));
  const check = (): void => {
    try {
      for (const path of logsThisProcessWrites()) {
        if (rotateOwnLog(path)) {
          const name = basename(path);
          log(`[hx] rotated ${name} (over ${mb} MB); earlier lines are in ${name}.1`);
        }
      }
    } catch {
      /* rotation must never take the mirror down */
    }
  };
  check();
  setInterval(check, LOG_CHECK_INTERVAL_MS).unref();
  let written = 0;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      const ok = (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      written += byteLength(chunk);
      if (written >= LOG_CHECK_BYTES) {
        written = 0; // before check(): its own log line comes back through here
        check();
      }
      return ok;
    }) as typeof stream.write;
  }
}

// ─────────────────────────────── tail logs ────────────────────────────────

/**
 * The last `count` lines of a daemon log, continuing into `<log>.1` when the
 * live file was rotated recently and holds fewer. Reads at most about
 * `maxBytes` (1 MiB, or 512 bytes per requested line if that is more) from the
 * end of each file, so a log that grew huge before rotation existed costs a
 * bounded read rather than the whole file in memory. `size` is the live file's
 * length: where a follower should continue from.
 */
export async function recentLogLines(
  path: string,
  count: number,
  maxBytes = Math.max(1024 * 1024, count * 512),
): Promise<{ lines: string[]; size: number }> {
  const live = await lastLinesOf(path, count, maxBytes);
  if (live.lines.length >= count) return live;
  const older = await lastLinesOf(rotatedLogPath(path, 1), count - live.lines.length, maxBytes);
  return { lines: [...older.lines, ...live.lines], size: live.size };
}

async function lastLinesOf(
  path: string,
  count: number,
  maxBytes: number,
): Promise<{ lines: string[]; size: number }> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return { lines: [], size: 0 };
  }
  try {
    const { size } = await fh.stat();
    if (count <= 0) return { lines: [], size };
    const start = Math.max(0, size - maxBytes);
    // Read from one byte early: the first segment is then the rest of a line
    // that began before `start`, or empty when `start` begins a line. Either
    // way it is not a whole line, so it is dropped.
    const from = start > 0 ? start - 1 : 0;
    const buf = Buffer.alloc(size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines: lines.slice(-count), size };
  } finally {
    await fh.close();
  }
}

/**
 * Follow the daemon's stdout + stderr logs: print the last `linesBack` lines of
 * each, then stream whatever is appended until Ctrl+C.
 *
 * Implemented in-process rather than by spawning `tail -f`. `tail` is absent on
 * stock Windows, and it is not guaranteed on a stripped-down container image
 * either — the two environments where `hx logs` is most likely to be the only
 * diagnostic available. Polling matches how the watcher already detects change
 * (mtime polling, not fs.watch), so this adds no new platform surface.
 */
const TAIL_POLL_MS = 250;

export async function tailLogs(linesBack = 50): Promise<void> {
  await mkdir(HX_DIR, { recursive: true });
  const files = [STDOUT_LOG, STDERR_LOG];
  // Append-create (flag "a") is idempotent: it creates a missing log but never
  // truncates one the daemon may have just started writing.
  for (const p of files) {
    await writeFile(p, "", { flag: "a" });
  }

  // Seed from the tail of each file (continuing into <log>.1 right after a
  // rotation), then follow from the live file's current end.
  const offsets = new Map<string, number>();
  for (const p of files) {
    const { lines, size } = await recentLogLines(p, linesBack);
    offsets.set(p, size);
    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
  }

  let stopped = false;
  const onSig = (): void => {
    stopped = true;
  };
  process.once("SIGINT", onSig);
  try {
    while (!stopped) {
      for (const p of files) {
        // Open FIRST, then size the handle we hold — not the path. Statting the
        // path and opening it afterwards is a TOCTOU: the file can be rotated
        // or replaced in between, and we would then read a length measured
        // against a file we are no longer holding.
        let fh;
        try {
          fh = await open(p, "r");
        } catch {
          continue; // log removed under us — pick it up again when it returns
        }
        try {
          const { size } = await fh.stat();
          const prev = offsets.get(p) ?? 0;
          // Shrunk = truncated or rotated. Restart from the top rather than
          // waiting for the file to grow past an offset that no longer exists.
          if (size < prev) {
            offsets.set(p, 0);
            continue;
          }
          if (size === prev) continue;
          const buf = Buffer.alloc(size - prev);
          const { bytesRead } = await fh.read(buf, 0, buf.length, prev);
          if (bytesRead > 0) process.stdout.write(buf.subarray(0, bytesRead));
          offsets.set(p, prev + bytesRead);
        } finally {
          await fh.close();
        }
      }
      await new Promise((r) => setTimeout(r, TAIL_POLL_MS));
    }
  } finally {
    process.removeListener("SIGINT", onSig);
  }
}
