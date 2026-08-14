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

The daemon keeps two files in `~/.let/hx/`:

- `config.json` — device token + gateway URL (mode 0600).
- `state.json` — per-file byte offset, so a restart doesn't re-upload.

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
