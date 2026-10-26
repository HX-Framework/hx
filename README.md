# hx

Per-device background daemon (binary: `hx`) that watches local
`~/.claude/projects/*.jsonl` and `~/.codex/sessions/**/*.jsonl` session files
and ships changes to a session gateway. Per-user, per-device: one connection per
OS environment (see [Platforms](#platforms)).

## Platforms

The background service runs on **macOS** (per-user LaunchAgent, via launchd),
**Linux** (systemd user unit) and **Windows** (per-user Task Scheduler logon
task) — laptop, desktop, or server alike. On Linux without a systemd user
session (Docker and other containers), it falls back to a
[shell-startup hook](#running-in-a-container) automatically.

Every backend runs as the invoking user, in their session, with their profile —
no sudo, no Administrator, no system-wide writes. On Windows that rules out a
Windows Service by construction: the SCM would run it as LocalSystem, which has
no `%USERPROFILE%` and therefore cannot see `~/.claude` at all.

Prebuilt binaries ship for five targets: `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `windows-x64` (x64 builds use Bun's `baseline`
target for broad CPU compatibility). Windows also ships a second artifact,
`windows-x64-svc` — the same program compiled windowless, so the background
mirror doesn't park a console window on the desktop; the scheduled task runs
that one and `hx update` keeps both in step. There is no `windows-arm64` Bun
target, so ARM Windows runs the x64 build under emulation.

**One client per OS environment.** hx mirrors the machine it is installed on and
nothing else: a Windows install watches `C:\Users\<you>\.claude`, and an install
inside WSL or a VM watches that environment's own `~/.claude`. They share no
state and do not coordinate — run both and you get two devices, which is the
intended model, not a defect.

## The background service

The service is defined as a background process, so it gives way to the apps you
are working in, even when hx itself misbehaves:

| | macOS (launchd) | Linux (systemd user unit) | Windows (Task Scheduler) |
|---|---|---|---|
| CPU | `ProcessType` `Background`, `Nice` 10 | `Nice=10`, `CPUWeight=20` | priority 7 (below normal) |
| Disk I/O | throttled: the `Background` class plus `LowPriorityBackgroundIO` | `IOSchedulingClass=idle` | not set |
| Restart after a crash | at most once a minute (`ThrottleInterval` 60) | after 60 s (`RestartSec=60`); gives up after 5 starts in 10 minutes | within 5 minutes, by the repeating trigger |
| Memory | none from launchd; hx's [watchdog](#freeze-and-memory-watchdog) kills it above 1536 MB of RSS | `MemoryHigh=1G`, `MemoryMax=2G`, `MemorySwapMax=512M`, and the watchdog | none from Task Scheduler; the watchdog |
| Stop | SIGKILL 5 s after SIGTERM (`ExitTimeOut` 5) | SIGKILL 5 s after SIGTERM (`TimeoutStopSec=5`) | immediate (`taskkill /F`) |

On Linux, `CPUWeight` and the memory limits are cgroup v2 settings. They only
take effect when your user manager has the controller: systemd gives it the
memory controller by default and the cpu controller since systemd 252. Where a
controller is missing, the setting does nothing and the unit still starts.
`Nice` and `IOSchedulingClass` work in every user unit; the idle I/O class only
matters with an I/O scheduler that supports priorities, such as BFQ. After the
unit gives up, `hx start` (or `hx restart`, or `hx update`) brings it back.

**Crash loops.** On every platform hx also spaces out its own restarts when it
keeps ending abnormally; see [Crash-loop backoff](#crash-loop-backoff).

**Stopping.** A stop sends SIGTERM first. A daemon whose event loop is frozen
never runs its SIGTERM handler, so launchd and systemd send SIGKILL 5 seconds
later. `hx stop` and `hx restart` also send it themselves if the daemon is
still running after 5 seconds, which covers a definition installed before
these settings, and say so when they had to. The container hook already sends
SIGKILL after 1.5 seconds.

hx owns the service definition (`~/Library/LaunchAgents/ai.let.hx-vision.plist`,
`~/.config/systemd/user/hx-vision.service`): `hx start`, `hx restart`, `hx
update` and the daemon itself rewrite it. When a new version of the daemon starts
under an older definition — `hx update` restarts the service with the previous
version's template — it writes its own and has launchd or systemd reload it, so
an update needs no reinstall. On Linux, put local changes in a drop-in
(`systemctl --user edit hx-vision.service`), which hx never touches.

**Logs.** The daemon writes `~/.let/hx/stdout.log` and `~/.let/hx/stderr.log`.
When either passes 20 MB, the daemon copies its last 20 MB to `<log>.1` (the
previous `.1` becomes `.2`) and empties the live file, so each log takes
at most about 60 MB. `hx logs` starts with the last lines across that boundary,
then follows the live file.

## Running in a container

Install as usual — no special setup. A container has no systemd user session, so
`hx start` (and the implicit start in `hx connect`) uses a **shell-startup hook**
instead: it writes `~/.let/hx/bootstrap.sh` and sources it from `~/.bashrc` and
`~/.profile`, so the mirror runs in the background and **relaunches whenever the
container starts a bash shell — including on `docker restart`**. Editing those
files needs your consent (hx asks; answer yes), so the mirror survives a restart
without any change to your image or entrypoint.

```sh
# interactive
hx connect          # approves the device, asks to edit ~/.bashrc + ~/.profile

# scripted / non-interactive
hx connect --no-start
hx start --yes      # start + wire the dotfiles without prompting
```

Notes:

- The container's start command must start (or `docker exec` into) a **bash**
  shell for the restart hook to fire — the usual case. If it never starts a
  shell (e.g. a raw entrypoint), run `hx watch` in the foreground instead.
- Persist `~/.let` on a volume if the container is **recreated** (not just
  restarted), so the device token isn't lost.
- Declining the dotfile edit (or a non-interactive run without `--yes`) still
  starts the mirror for the current session; hx prints the one line to add
  yourself for restart persistence.

## Install

End users install a prebuilt binary with the one-line installer their workbench
provides:

```sh
curl -fsSL <your-workbench>/install.sh | sh
hx connect          # approve this device (browser flow) + start the mirror
```

`hx connect` seeds the gateway URL into `~/.let/hx/config.json` (hx's single
source of truth for where to upload) and brings up the background mirror via
launchd (macOS) or systemd (Linux).

## Install from sources

Prefer to build the binary yourself instead of downloading a prebuilt one? Clone
the repo and run the from-source entrypoint — it reaches the same connected,
mirroring `hx` as the one-line installer above, compiling locally instead of
downloading:

```sh
git clone https://github.com/hx-framework/hx && cd hx
./install-from-source.sh
```

The gateway URL is optional and defaults to production (`https://let.ai/_api/hx-gateway`).
Pass your workbench's hx gateway explicitly instead (e.g.
`./install-from-source.sh https://<your-workbench>/_api/hx-gateway`) to connect to a
different environment. The script requires [Bun](https://bun.sh) — if it's missing it
offers to install it for you — then: `bun install` → `bun run build` → installs
`./dist/hx` to `~/.let/bin/hx` (ad-hoc code-signing it on macOS), adds `~/.let/bin` to
your shell's `PATH`, seeds the gateway into `~/.let/hx/config.json`, and hands off to the
same interactive `hx connect` device flow (browser approval + background mirror).
`bun run install:connect` runs the same entrypoint.

The `PATH` edit lands in your shell's startup file (`~/.zshrc`, `~/.bashrc`,
`~/.bash_profile` on macOS, `~/.config/fish/config.fish`, or `~/.profile`), so **new**
terminals find `hx` on their own. The shell you ran the installer from won't — a process
can't change its parent's environment — so it prints the one-time `source` command to
bridge it. Run that, or open a new terminal.

## Commands

```sh
hx connect [--local] [--device-name NAME]   # approve device + start mirror
hx status                                    # connection status + link quality
hx logs                                      # tail the daemon
hx ui [--port N] [--no-open]                 # open the HX Client web app
hx start | stop | restart                    # background-mirror service
hx update                                    # fetch the latest binary, restart daemon
hx disconnect [--local]                      # forget the device token
hx uninstall [--purge]                       # remove daemon + binary
hx --version

# Foreground (debug):
hx watch [--local] [--once] [--only /abs/path.jsonl]
hx tick  [--local]                           # one upload pass, exit
```

## Web UI

```sh
hx ui [--port N] [--no-open]
```

Serves the **HX Client** web app — everything the daemon knows, in a browser:
watched folders and where each one uploads (with the why: repo →
destination), sync status with a live traffic chart, a transcript inspector
showing the exact bytes that leave the machine, privacy controls (pause,
per-folder exclusions, future-folder rules, a personal-sessions gate), daemon
lifecycle controls, Sync Doctor, self-update, and a live log tail.

The app is embedded in the `hx` binary and served from `http://localhost:8000`
(loopback; `--port` if 8000 is busy — by default hx scans forward and says so).
The printed URL carries a one-time key — open exactly that link; a second `hx
ui` reuses the running instance instead of racing it. Ctrl-C stops the server;
the background mirror is unaffected.

**In a container**, your browser is on the host, so `hx ui` detects the
container and binds a wildcard (`::`, dual-stack — falling back to IPv4 `0.0.0.0`
if the container has no IPv6) instead of the container's unreachable loopback,
then prints a `http://127.0.0.1:8000/…` link — copy it into your **host**
browser. That requires the container to publish the port, e.g. `docker run -p
8000:8000 …` (a running container can't have `-p` added; recreate it). The link
uses `127.0.0.1`, not `localhost`, on purpose: Docker Desktop (Windows/macOS)
also publishes on the host's IPv6 and `localhost` resolves to IPv6 (`::1`) first
there, but its IPv6 forwarding accepts the connection then drops it — the IPv4
literal takes the path that works on every platform. The wider bind is not a
wider door: every request still passes the Host allowlist and carries the
one-time key, so a hit on the raw container IP is refused, and nothing leaves
the container unless you publish the port yourself. Works the same on Docker
Desktop (macOS/Windows/WSL2), native Linux Docker, and Podman. Settings changes land in
`~/.let/hx/settings.json` and the daemon honors them within one poll interval
(also visible to `hx status`, e.g. a `Paused` row).

`--local` is **additive**: regular behavior is untouched, and sessions are
*also* mirrored to a local dev gateway (`http://localhost:9000`). `hx connect
--local` pairs the device with the dev gateway as a second connection
(`config.local.json` — the main config is never re-pointed), then `hx watch
--local` / `hx tick --local` upload every chunk to both gateways. The tee lane
keeps its own offsets (`state.local.json`), so a dev stack that's down only
stalls the local mirror, never the real one. (`hx update --local` is the one
non-tee use: it fetches the binary *from* the dev gateway.)

The daemon keeps these files in `~/.let/hx/`:

- `config.json` — device token + gateway URL (mode 0600).
- `state.json` — per-file byte offset, so a restart doesn't re-upload.
- `stdout.log`, `stderr.log` — the daemon's output, rotated at 20 MB into
  `.1` and `.2` (see [The background service](#the-background-service)).
- `watch-run.json`, `watch-exits.json` — the running daemon, and the recent
  runs that ended abnormally (see [Crash-loop backoff](#crash-loop-backoff)).

## What it watches

| Family | Path | Detected by |
|---|---|---|
| `claude-desktop` | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `entrypoint: "claude-desktop"` |
| `claude-cli` | same dir | `entrypoint: "cli" \| "claude-code-vscode"` |
| `codex-desktop` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta.originator` contains `desktop` |
| `codex-cli` | same | `session_meta.originator` contains `cli` (default) |

Watch mechanism is mtime-polling at ~1.5s (chokidar 4 drops fsevents, and a
recursive watch on `~/.claude/projects/<encoded-path>/` would blow the FD
limit).

### Desktop sidebars

hx also mirrors how you group sessions in the two desktop apps, so the web UI
shows the same groups. It uploads group names, their order, whether each is
collapsed, and which session ids sit in each, never message content:

- Claude Code Desktop's groups, read from its Local Storage leveldb;
- Codex Desktop's sidebar sections (`src/codex-sections.ts`), read from
  `~/.codex/.codex-global-state.json` (the signed-in account's sections) and
  `~/.codex/state_<N>.sqlite` (which threads Codex lists, and its Pinned
  list). Both files are opened read-only.

Both go up in one upload (`POST /sessions/group-mirror`, Codex's as its
`codex` field), on start, within about a second of a change to either app's
files, and every 20 s as a safety net.

### Watched locations (custom data roots)

The paths above are relative to a **data root** — `~/.claude` / `~/.codex` by
default. Claude Code relocates its entire tree when `CLAUDE_CONFIG_DIR` is
set; Codex does the same via `CODEX_HOME`. hx watches a configurable *set* of
roots per family:

- the default root, always;
- every root added under **Privacy Controls → Watched Locations** in the web
  UI (stored in `~/.let/hx/settings.json` as `dataDirs`, up to 8 per family;
  a root that doesn't exist yet is fine — it arms for when the dir appears);
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when present in the hx process's **own**
  environment. Note the background service (launchd / systemd) never reads
  your shell profile, so an env var exported in `.bashrc` reaches `hx watch`
  run from that shell but *not* the daemon — the UI shows such a value as
  "set in your shell" with a one-click **Add**; adding it is the durable fix.

Discovery keeps its 30-day window per root, so a newly added root backfills
the last 30 days of sessions on the next tick. Switching `CLAUDE_CONFIG_DIR`
never migrates old transcripts — they stay in the previous dir, which is why
hx watches the whole set rather than one root. Prefer **adding** a root over
copying the tree: copies create twin files for the same session (harmless —
per-session uploader election shadows the stale copy — but the copy buys
nothing). `hx status` and `hx doctor sync` print the effective root set.

## Upload pipeline

For each change, the chunk between `state.offset` and EOF (trimmed at the last
`\n` so a JSON line isn't split):

1. `POST /api/sessions/append-url` → mint a V4 signed PUT URL for a staging object.
2. `PUT <signedUrl>` — bytes go directly to object storage; never traverse the gateway.
3. `POST /api/sessions/commit` — the gateway composes staging into the canonical object and updates the `sessions` row.
4. Bump `state.offset`.

Every gateway and storage call runs under a deadline (60 s for the small
JSON calls, 60 s plus one second per 64 KiB for a chunk PUT), so a peer that
accepts a connection and never answers surfaces as a retryable error instead
of pinning an upload worker.

### Progress watchdog

The daemon also watches itself: if an upload pass has been running for longer
than the watchdog limit and the daemon has written no log line in that time,
it exits with code 70 so the service manager (launchd, systemd, Task
Scheduler, or the container shell hook) starts a fresh process. The limit is
10 minutes by default and can be changed without a restart through
`~/.let/hx/settings.json`:

```json
{ "tuning": { "watchdogMinutes": 15 } }
```

`0` disables it; positive values below 2 are raised to 2. For a foreground
`hx watch` the `HX_WATCHDOG_MINUTES` environment variable overrides the
setting.

The progress watchdog runs on the daemon's event loop, so it cannot fire when
that loop is frozen. The freeze and memory watchdog below covers that case.

### Freeze and memory watchdog

A second watchdog runs on its own thread, so it keeps working when the
daemon's event loop does not. The main thread adds 1 to a counter once a
second; the watchdog thread reads it, and the process RSS, every 250 ms. It
kills the daemon with SIGKILL when:

- the counter has not moved for `freezeSeconds` (default 60): the event loop
  is frozen, or
- the RSS is above `memoryCeilingMb` (default 1536).

SIGKILL because nothing else ends a frozen daemon: its SIGTERM and SIGINT
handlers are JavaScript, and they never run while the loop is stuck. The
service manager then starts a fresh daemon, subject to the
[crash-loop backoff](#crash-loop-backoff).

Both limits live in `~/.let/hx/settings.json`, re-read every 30 seconds:

```json
{ "tuning": { "freezeSeconds": 60, "memoryCeilingMb": 1536 } }
```

`0` turns a check off. Positive values below 10 seconds and 512 MB are raised
to those floors. The memory default is about 1.6 times the highest RSS
measured for a healthy daemon: 935 MB while re-uploading a 319 MB transcript
from zero, on a machine with 35,000 Claude Desktop sessions and 19 GB of
transcripts, where a caught-up daemon levels off at about 920 MB. RSS counts
shared and file-backed pages too, so it reads higher than the memory
footprint Activity Monitor shows (577 to 670 MB in the same runs).

A kill writes one line to `~/.let/hx/stderr.log`:

```
2026-10-14 17:42:03 [hx] watchdog: killing pid 4242 with SIGKILL: the event loop has not run for 60 s (freeze limit 60 s); rss 412 MB
2026-10-14 17:42:03 [hx] watchdog: killing pid 4242 with SIGKILL: rss 1540 MB is over the memory limit of 1536 MB; the event loop last ran 0 s ago
```

The next daemon then logs the reason to `~/.let/hx/stdout.log`, which is what
`hx logs` and the web UI show:

```
2026-10-14 17:42:13 [hx] warning: the previous run (pid 4242) ended abnormally: killed by the watchdog: the event loop has not run for 60 s (freeze limit 60 s); 1 abnormal exit in the last 30 min
```

### Crash-loop backoff

An abnormal exit is a daemon run that ended without being told to stop: a
watchdog kill, a non-zero exit (the progress watchdog's 70 included), a crash,
or any signal other than the SIGTERM or SIGINT of a stop. Each run records
itself in `~/.let/hx/watch-run.json`, and the abnormal exits are kept in
`~/.let/hx/watch-exits.json`. When there were 3 or more in the last 30 minutes,
the next start waits before its first pass, 1 minute at first and doubling
with each further abnormal exit, up to 30 minutes, and logs one line:

```
2026-10-14 17:50:01 [hx] crash loop: 4 abnormal exits in the last 30 min (previous run: killed by the watchdog: rss 1540 MB is over the memory limit of 1536 MB); backing off 2 min before the first pass
```

Time spent waiting does not count toward the 30 minutes, so a daemon that
keeps failing stays at one start per half hour until it runs for 30 minutes
without an abnormal exit. While it waits the daemon makes no gateway calls,
so the device reads as offline.

A start you ask for begins at once: `hx start`, `hx restart`, `hx update`,
`hx connect`, `hx retry`, and the web UI's daemon controls clear the history
first.

## Develop

Requires [Bun](https://bun.sh) `1.3.14`.

```sh
bun install
bun run dev -- <subcmd>   # run from source, e.g. bun run dev -- status
bun test                  # run the suite
bun run typecheck
bun run lint
bun run build             # compile a native binary to ./dist/hx
```

## Versioning

`hx version` prints `hx version: <X.Y.Z>` — a stable semver, the single source
of truth in [`src/version.ts`](src/version.ts) (read from `package.json`).

Bump the `version` field in [`package.json`](package.json) whenever a change is
something an hx user could observe — a new or changed command, upload/daemon
behavior, a fixed bug. `release.yml` publishes whatever version is committed on
`main`, and `hx update` pulls it when the remote semver is newer than the
running binary's.

## Releases

`hx update` never talks to GitHub directly. A workbench-side download proxy
authenticates to GitHub with a token and streams the requested asset back, so
laptops only ever talk to their own gateway. CI publishes:

- `builds/hx-X.Y.Z` — rolling, overwritten on every push to `main`.
- `releases/hx-X.Y.Z` — immutable, cut on manual dispatch.
- `dev/hx-<branch>` — per-branch dev builds (manual dispatch), for local testing only.
