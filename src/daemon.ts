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

import { homedir, platform, userInfo } from "node:os";
import { join, dirname, win32 as winPath } from "node:path";
import { writeFile, mkdir, unlink, readFile, open, stat, copyFile, truncate, rename } from "node:fs/promises";
import { existsSync, readFileSync, createWriteStream, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { HX_DIR } from "./hx-home.js";

export { HX_DIR };
export const STDOUT_LOG = join(HX_DIR, "stdout.log");
export const STDERR_LOG = join(HX_DIR, "stderr.log");

const LAUNCHD_LABEL = "ai.let.hx-vision";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

const SYSTEMD_UNIT_NAME = "hx-vision.service";
const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);

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
  const backoffMs = [150, 300, 600, 1000];
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

function macOps(): DaemonOps {
  return {
    managerName: "launchd",
    async install({ binPath }) {
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const plist = renderPlist(binPath);
      await writeFile(LAUNCHD_PLIST, plist);
      const target = macTarget();
      // bootout is the modern "unload"; tolerate "not loaded" so install is idempotent.
      spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      // Let launchd finish reaping the old job before bootstrapping the new one,
      // and retry the bootstrap through the transient teardown race.
      waitUntilUnloaded();
      // Enable BEFORE bootstrap: `hx stop` disables the service (so a relogin
      // can't resurrect it), and bootstrapping a disabled service fails with
      // "Bootstrap failed: 119". Enabling an already-enabled service is a no-op.
      runOrThrow("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`]);
      bootstrapWithRetry(target, LAUNCHD_PLIST);
    },
    async restart({ binPath }) {
      // Refresh the on-disk plist so a changed binary path is captured.
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(LAUNCHD_PLIST, renderPlist(binPath));
      const target = macTarget();
      const label = `${target}/${LAUNCHD_LABEL}`;
      if (macState().loaded) {
        // In-place restart: kill the running instance and respawn it from the
        // same plist, re-exec'ing the binary at its (now atomically-swapped)
        // path. This sidesteps the bootout→bootstrap teardown race entirely.
        runOrThrow("launchctl", ["kickstart", "-k", label]);
      } else {
        // Not currently loaded — bring it up from scratch. Enable first: the
        // service may have been disabled by `hx stop`, and bootstrapping a
        // disabled service fails.
        runOrThrow("launchctl", ["enable", label]);
        bootstrapWithRetry(target, LAUNCHD_PLIST);
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

function systemdOps(): DaemonOps {
  return {
    managerName: "systemd (user)",
    async install({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const unit = renderSystemdUnit(binPath);
      await writeFile(SYSTEMD_UNIT_PATH, unit);
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
      runOrThrow("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    },
    async restart({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(SYSTEMD_UNIT_PATH, renderSystemdUnit(binPath));
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
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

function renderPlist(binPath: string): string {
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
    <key>StandardOutPath</key><string>${escapeXml(STDOUT_LOG)}</string>
    <key>StandardErrorPath</key><string>${escapeXml(STDERR_LOG)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envBlock}
    </dict>
  </dict>
</plist>
`;
}

function renderSystemdUnit(binPath: string): string {
  // No HX_GATEWAY_URL in the unit: `hx watch` reads the gateway + token from
  // ~/.let/hx/config.json, and a stale env var must never override config.
  return `[Unit]
Description=hx-vision session mirror
After=network-online.target

[Service]
Type=simple
ExecStart=${binPath} watch
Restart=always
RestartSec=5
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}

[Install]
WantedBy=default.target
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
 */
export function teeStdioToLogs(): void {
  if (platform() !== "win32") return;
  mkdirSync(HX_DIR, { recursive: true });
  for (const [stream, target] of [
    [process.stdout, STDOUT_LOG],
    [process.stderr, STDERR_LOG],
  ] as const) {
    const file = createWriteStream(target, { flags: "a" });
    file.on("error", () => {
      /* a log we cannot write must never crash the mirror */
    });
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        file.write(chunk as string | Uint8Array);
      } catch {
        /* see above */
      }
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

/** Cap for each daemon log. One previous generation is kept alongside, so the
 *  daemon's log footprint is bounded at twice this per stream. */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Bound the daemon logs, by copy-truncate.
 *
 * Nothing has ever rotated these. One device's stdout.log reached 242 MB and
 * 1,144,348 lines, spanning two gateway migrations — 70% of it a single error
 * repeated 798,704 times. A log that large is not a diagnostic; it is a reason
 * not to look.
 *
 * Renaming cannot be used. launchd (`StandardOutPath`) and systemd
 * (`StandardOutput=append:`) open the file themselves and hold the descriptor
 * for the life of the process, so a rename leaves them writing to the same
 * inode under its new name: `stdout.log` would sit empty while `stdout.log.1`
 * grew without limit — strictly worse than not rotating at all.
 *
 * Both open with O_APPEND, as does the Windows tee above, so every write is
 * positioned at end-of-file as it happens. Truncating in place is therefore
 * safe with the descriptor open: the next line lands at offset 0.
 *
 * `hx logs` already handles the result — it reads a shrink as "truncated or
 * rotated" and restarts from the top. The reader was built for a rotator that
 * was never written; this is it.
 *
 * The copy-then-truncate window is inherent to copytruncate and accepted here:
 * a line written between the two is copied to neither. At an hourly check on a
 * log this size that is a sub-millisecond gap against months of history, and
 * the alternative (holding a lock around the daemon's own stdout) would be a
 * far worse trade.
 *
 * Best-effort throughout: a log we cannot rotate must never take the daemon
 * down. Returns the paths actually rotated, for the caller to report.
 */
let rotationInFlight: Promise<string[]> | null = null;

export async function rotateLogsIfLarge(
  maxBytes: number = LOG_MAX_BYTES,
  targets: readonly string[] = [STDOUT_LOG, STDERR_LOG],
): Promise<string[]> {
  // These paths are DEVICE-global while callers are per-lane and in the same
  // process (cli.ts runs the main and `--local` watchers concurrently). Two
  // overlapping calls both pass the size check, then one truncates while the
  // other is still copying — and the "previous generation" ends up empty or
  // half-written, destroying the history this exists to preserve. Callers are
  // gated too; this makes the function safe on its own terms.
  if (rotationInFlight) return rotationInFlight;
  rotationInFlight = rotateGuarded(maxBytes, targets).finally(() => {
    rotationInFlight = null;
  });
  return rotationInFlight;
}

/** How long a rotate lock may sit before another process treats it as abandoned.
 *  Comfortably longer than copying a capped log, short enough that a killed
 *  daemon does not disable rotation until someone notices. */
const ROTATE_LOCK_STALE_MS = 5 * 60_000;

/**
 * Cross-process mutual exclusion, which the in-process guard cannot provide.
 *
 * A foreground `hx watch` runs the same command as the installed service, so
 * nothing distinguishes them and both may rotate. Staging plus an atomic rename
 * is NOT sufficient, and the comment that said it was overstated the guarantee:
 * the rename is atomic, but it says nothing about what was copied. A second
 * process that stats the log before the first truncates goes on to copy a file
 * being emptied underneath it, then renames that short copy over the complete
 * generation. Measured on a 600 MB log with a 350 ms stagger: 600 MB of history
 * became 375 MB. Started later still, `.1` ends up empty.
 *
 * O_EXCL create is the check — an exists-then-create leaves the same window.
 */
async function rotateGuarded(maxBytes: number, targets: readonly string[]): Promise<string[]> {
  const lock = join(HX_DIR, "rotate.lock");
  let held: ReturnType<typeof statSync> | undefined;
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    // statSync must be INSIDE a try. `throwIfNoEntry: false` suppresses ENOENT
    // and nothing else: EACCES on a directory whose ownership a sudo install
    // changed, EIO/ESTALE on an NFS or FUSE mount, and EPERM on Windows for a
    // lock another process is mid-delete all still throw. Uncaught, that
    // rejection reached a `void ...then()` inside setInterval, and Bun exits
    // the process on an unhandled rejection — an unreadable lock file would
    // have killed the daemon on the hour, in a function whose contract is that
    // a log it cannot rotate must never take the daemon down.
    try {
      held = statSync(lock, { throwIfNoEntry: false });
    } catch {
      return [];
    }
    // Held. Abandoned locks would otherwise disable rotation forever, so a
    // stale one may be taken over; a live one means someone else is already
    // doing this and there is nothing to add.
    if (!held || Date.now() - held.mtimeMs < ROTATE_LOCK_STALE_MS) return [];
    // Stale — clear it and rotate NOTHING this round.
    //
    // Breaking the lock and immediately taking it is not expressible atomically
    // with plain fs calls, and every attempt at it races. A plain write let
    // every process that saw the same stale lock win (3 of 25 trials lost
    // history). unlink-then-wx-create is no better: one process can complete
    // both steps inside another's window, so the second deletes the first's
    // FRESH lock and then wins its own create — measured at 2 of 40 trials with
    // 8 processes, and on an 800 MB log that turned 800 MB of kept history into
    // 580 MB.
    //
    // Removing it and returning has no race at all: unlink is idempotent, and
    // nobody rotates in the round that breaks the lock, so the next round is an
    // ordinary uncontested O_EXCL create that exactly one process wins. The
    // cost is one skipped cycle — rotation runs hourly against a 32 MB cap, so
    // a dead process delays rotation by an hour instead of disabling it forever.
    try {
      await unlink(lock);
    } catch {
      /* someone else cleared it first; either way it is gone */
    }
    return [];
  }
  try {
    return await rotateOnce(maxBytes, targets);
  } finally {
    try {
      // Only release OUR lock: another process may have cleared a lock it
      // judged stale and be about to acquire, and unlinking that one would let
      // two run together.
      if (readFileSync(lock, "utf8") === String(process.pid)) await unlink(lock);
    } catch {
      /* already gone, unreadable, or not ours to remove */
    }
  }
}

async function rotateOnce(maxBytes: number, targets: readonly string[]): Promise<string[]> {
  const rotated: string[] = [];
  for (const target of targets) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the
      // daemon's own two log paths under ~/.let/hx (tests inject a tmp path),
      // never request input.
      const st = await stat(target);
      if (st.size <= maxBytes) continue;
      // Copy to a per-process staging file, then RENAME into place, then
      // truncate. Copying straight onto `.1` opens it O_TRUNC, so a reader
      // would see a half-written generation; the rename makes the swap atomic.
      // Mutual exclusion is the LOCK's job, not the rename's — see
      // rotateGuarded. Staging stays per-pid so a stale lock takeover cannot
      // have two processes streaming into one inode.
      const staging = `${target}.rotating.${process.pid}`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      await copyFile(target, staging);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      await rename(staging, `${target}.1`);
      // Truncate last: a crash before here costs nothing, and one after leaves
      // the live log short but the generation intact.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      await truncate(target, 0);
      rotated.push(target);
    } catch {
      /* missing, unreadable, or a full disk — never fatal */
      try {
        // Do not leave a half-written staging file behind on failure.
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
        await unlink(`${target}.rotating.${process.pid}`);
      } catch {
        /* nothing to clean up */
      }
    }
  }
  return rotated;
}

// ─────────────────────────────── tail logs ────────────────────────────────

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

/**
 * The lines `hx logs -n N` should print before it starts following.
 *
 * Reaches back into the previous generation when the live file cannot fill the
 * request. A rotation minutes ago would otherwise turn `hx logs -n 500` into
 * "here are the 30 lines since we rotated", with no hint the rest exists — the
 * daemon says it kept a generation, so the tool that reads logs has to be able
 * to reach it. Only the LIVE file is followed afterwards; the rotated one is
 * finished by definition.
 *
 * Pure, so the fallback is actually testable: tailLogs itself writes to stdout
 * and then loops until SIGINT.
 */
export function seedBacklogLines(live: string, previous: string, linesBack: number): string[] {
  const split = (text: string): string[] => {
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const lines = split(live);
  if (lines.length < linesBack && previous.length > 0) {
    // concat, NOT unshift(...spread). `linesBack` is user input — `hx logs
    // --lines N` accepts any N — so the spread's argument count is unbounded,
    // and a rotated 32 MB log is roughly a million lines. At 1,000,000 the
    // spread throws RangeError: Maximum call stack size exceeded, turning a
    // large --lines into a crash where the plain slice before this change
    // simply returned everything.
    return split(previous).slice(-(linesBack - lines.length)).concat(lines);
  }
  return lines.slice(-linesBack);
}

export async function tailLogs(linesBack = 50): Promise<void> {
  await mkdir(HX_DIR, { recursive: true });
  const files = [STDOUT_LOG, STDERR_LOG];
  // Append-create (flag "a") is idempotent: it creates a missing log but never
  // truncates one the daemon may have just started writing.
  for (const p of files) {
    await writeFile(p, "", { flag: "a" });
  }

  // Seed from the tail of each file, then follow from its current end.
  const offsets = new Map<string, number>();
  for (const p of files) {
    const buf = await readFile(p).catch(() => Buffer.alloc(0));
    offsets.set(p, buf.length);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    const prev = await readFile(`${p}.1`, "utf8").catch(() => "");
    const recent = seedBacklogLines(buf.toString("utf8"), prev, linesBack);
    if (recent.length > 0) process.stdout.write(`${recent.join("\n")}\n`);
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
