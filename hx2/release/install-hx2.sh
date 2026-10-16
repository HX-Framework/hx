#!/bin/sh
# hx2 — laptop daemon for hx-vision
# One-liner install: curl -fsSL <this-url> | sh
#
# What this does:
#   - Detects your OS + CPU arch.
#   - Downloads the matching gzipped hx2 binary from your workbench
#     (${HX_GATEWAY_URL}/download/<asset>.gz) with a
#     live progress bar.
#   - Decompresses it locally and verifies it against a SHA-256 sum.
#   - Installs to ~/.let/bin/hx2 (no sudo).
#   - Detects the shell you're actually running (not just your login shell)
#     and adds ~/.let/bin to its PATH (~/.zshrc, ~/.bash_profile or
#     ~/.bashrc, ~/.config/fish/config.fish, or ~/.profile).
#   - Migrates legacy ~/.hx state to ~/.let/hx (same move the hx2 binary
#     does on first run) and seeds ~/.let/hx/config.json so 'hx2 connect'
#     knows where to call.
#   - Ends on one next step: hx2 connect.
#
# hx2 and hx share ~/.let/hx: one login, one upload state, one background
# service. A device that already runs hx keeps its login; 'hx2 connect'
# moves the service to hx2.
#
# Inspect before running:
#   curl -fsSL <this-url> -o install.sh
#   less install.sh
#   sh install.sh
set -eu

HX_GATEWAY_URL="http://127.0.0.1:47913/_api/hx-gateway"
HX_DOWNLOAD_BASE="${HX_GATEWAY_URL%/}/download"
# Dev-build selector appended to every asset fetch. Empty for a normal install;
# a branch-ref or build-channel query when the workbench rendered a dev-build
# installer (local-only — the proxy ignores it when deployed).
HX_QS="?channel=build"
BIN_DIR="${HOME}/.let/bin"

# --- platform detect ---------------------------------------------------
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *)
    echo "hx2: unsupported CPU arch: $arch" >&2
    exit 1
    ;;
esac
case "$os" in
  darwin|linux) ;;
  msys*|mingw*|cygwin*|windows*)
    echo "hx2: Windows is not supported yet. Use WSL2, or contact us." >&2
    exit 1
    ;;
  *)
    echo "hx2: unsupported OS: $os" >&2
    exit 1
    ;;
esac

asset="hx2-${os}-${arch}"

# --- is there a release to install? -------------------------------------
# The proxy answers the version file with 404 while hx2 has nothing published
# on this channel. Say so in one line rather than as a failed download. Any
# other answer, an outage included, falls through to the download below, which
# reports its own failure.
release_status=$(curl -sL -o /dev/null -w '%{http_code}' "${HX_DOWNLOAD_BASE}/hx2-version${HX_QS}" 2>/dev/null) || release_status=000
if [ "$release_status" = 404 ]; then
  echo "hx2: no hx2 build has been published yet." >&2
  exit 1
fi

# --- progress UI ------------------------------------------------------
# One animated line while we fetch + unpack, then a single next step.
# We animate only when stderr is a real terminal; piped or redirected
# installs (CI, "| tee", "2>file") fall back to plain one-line breadcrumbs
# with no carriage-return cruft. Status + animation go to stderr so the
# final instructions on stdout stay clean for "curl | sh > log".
BAR_WIDTH=24
TTY=0
[ -t 2 ] && TTY=1

# Color is a separate question from "is there a terminal to animate on", and
# has to be answered against a different stream: the bar and status lines go to
# stderr (TTY, above), but the cards and the final instructions go to STDOUT.
# Gating color on stderr alone wrote escape codes into the redirected file of a
# 'curl … | sh > log', which is exactly what that split was meant to avoid.
#
# Two more ways a terminal can want no color, both of which we honor:
#   TERM=dumb (or unset) -- a terminal that cannot render ANSI at all. Emacs
#     shell-mode and some CI runners allocate a real pty and set this; without
#     the check they'd render our boxes as a wall of literal "^[[38;5;39m".
#   NO_COLOR set          -- the user's explicit, cross-tool opt-out
#     (no-color.org). Any value counts, including empty.
COLOR=0
[ -t 1 ] && COLOR=1
case "${TERM:-}" in dumb | "") COLOR=0 ;; esac
[ -n "${NO_COLOR+x}" ] && COLOR=0

# Block-glyph bar + check mark on a UTF-8 locale; ASCII fallback otherwise.
UTF8=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]8* | *[Uu][Tt][Ff]-8*) UTF8=1 ;;
esac
if [ "$UTF8" = 1 ]; then
  GLYPH_FULL='█'; GLYPH_EMPTY='░'; OK_MARK='✓'
  BOX_TL='╭'; BOX_TR='╮'; BOX_BL='╰'; BOX_BR='╯'; BOX_H='─'; BOX_V='│'
else
  GLYPH_FULL='#'; GLYPH_EMPTY='-'; OK_MARK='OK'
  BOX_TL='+'; BOX_TR='+'; BOX_BL='+'; BOX_BR='+'; BOX_H='-'; BOX_V='|'
fi

# ESC/CR/CLR drive the in-place bar redraw on stderr, so they follow TTY.
if [ "$TTY" = 1 ]; then
  ESC=$(printf '\033')
  CR=$(printf '\r')
  CLR="${ESC}[K"
else
  ESC=; CR=; CLR=;
fi

# The SGR attributes follow COLOR, independently of the above.
if [ "$COLOR" = 1 ]; then
  _E=$(printf '\033')
  DIM="${_E}[2m"; BLD="${_E}[1m"; ACC="${_E}[38;5;39m"; GRN="${_E}[32m"; RST="${_E}[0m"
else
  DIM=; BLD=; ACC=; GRN=; RST=
fi

status() { [ "$TTY" = 1 ] || printf '  %s\n' "$1" >&2; }

draw_bar() {
  _pct=$1; _label=$2
  [ "$_pct" -lt 0 ] && _pct=0
  [ "$_pct" -gt 100 ] && _pct=100
  [ "$TTY" = 1 ] || return 0
  _filled=$(( _pct * BAR_WIDTH / 100 ))
  _i=0; _bar=
  while [ "$_i" -lt "$_filled" ]; do _bar="${_bar}${GLYPH_FULL}"; _i=$(( _i + 1 )); done
  while [ "$_i" -lt "$BAR_WIDTH" ]; do _bar="${_bar}${GLYPH_EMPTY}"; _i=$(( _i + 1 )); done
  printf '%s  %s%-11s%s %s%s%s %3d%%%s' "$CR" "$DIM" "$_label" "$RST" "$ACC" "$_bar" "$RST" "$_pct" "$CLR" >&2
}

# Indeterminate bar (a sliding block) for the brief window before we know
# the download's content-length.
draw_pulse() {
  _label=$1; _frame=$2
  [ "$TTY" = 1 ] || return 0
  _win=5
  _pos=$(( _frame % BAR_WIDTH ))
  _i=0; _bar=
  while [ "$_i" -lt "$BAR_WIDTH" ]; do
    _rel=$(( (_i - _pos + BAR_WIDTH) % BAR_WIDTH ))
    if [ "$_rel" -lt "$_win" ]; then _bar="${_bar}${GLYPH_FULL}"; else _bar="${_bar}${GLYPH_EMPTY}"; fi
    _i=$(( _i + 1 ))
  done
  printf '%s  %s%-11s%s %s%s%s%s' "$CR" "$DIM" "$_label" "$RST" "$ACC" "$_bar" "$RST" "$CLR" >&2
}

clear_line()  { [ "$TTY" = 1 ] && printf '%s%s' "$CR" "$CLR" >&2 || true; }
end_line()    { [ "$TTY" = 1 ] && printf '\n' >&2 || true; }
show_cursor() { [ "$TTY" = 1 ] && printf '%s[?25h' "$ESC" >&2 || true; }
hide_cursor() { [ "$TTY" = 1 ] && printf '%s[?25l' "$ESC" >&2 || true; }

# N copies of a glyph — box rules and padding. printf(1) has no '%-*s'
# dynamic widths in POSIX, so both are built by hand.
str_repeat() {
  _n=$1; _c=$2; _s=
  while [ "$_n" -gt 0 ]; do _s="${_s}${_c}"; _n=$(( _n - 1 )); done
  printf '%s' "$_s"
}

# Right-pad a string with spaces to a width (ASCII inputs only).
pad_to() {
  _p=$1; _w=$2
  while [ "${#_p}" -lt "$_w" ]; do _p="${_p} "; done
  printf '%s' "$_p"
}

# The pairing-code card: a small boxed label/value table, the same layout the
# hx binary prints when 'hx connect' runs in the foreground (see
# packages/hx-client/src/connect.ts renderPairingCard — keep the two in sync).
# Inner width = 3-space pad + label + 3-space gap + value + 3-space pad.
draw_code_card() {
  _code=$1; _host=$2
  _lc='Pairing code'; _lh='Workbench'
  _lw=${#_lc}; [ "${#_lh}" -gt "$_lw" ] && _lw=${#_lh}
  _vw=${#_code}; [ "${#_host}" -gt "$_vw" ] && _vw=${#_host}
  _in=$(( _lw + _vw + 9 ))
  _rule=$(str_repeat "$_in" "$BOX_H")
  _sp=$(str_repeat "$_in" ' ')
  printf '  %s%s%s%s%s\n' "$DIM" "$BOX_TL" "$_rule" "$BOX_TR" "$RST"
  printf '  %s%s%s%s%s%s%s\n' "$DIM" "$BOX_V" "$RST" "$_sp" "$DIM" "$BOX_V" "$RST"
  printf '  %s%s%s   %s%s%s   %s%s%s   %s%s%s\n' \
    "$DIM" "$BOX_V" "$RST" \
    "$DIM" "$(pad_to "$_lc" "$_lw")" "$RST" \
    "$BLD$ACC" "$(pad_to "$_code" "$_vw")" "$RST" \
    "$DIM" "$BOX_V" "$RST"
  printf '  %s%s%s   %s%s%s   %s   %s%s%s\n' \
    "$DIM" "$BOX_V" "$RST" \
    "$DIM" "$(pad_to "$_lh" "$_lw")" "$RST" \
    "$(pad_to "$_host" "$_vw")" \
    "$DIM" "$BOX_V" "$RST"
  printf '  %s%s%s%s%s%s%s\n' "$DIM" "$BOX_V" "$RST" "$_sp" "$DIM" "$BOX_V" "$RST"
  printf '  %s%s%s%s%s\n' "$DIM" "$BOX_BL" "$_rule" "$BOX_BR" "$RST"
}

# A boxed call-to-action: one message line over one command line, in the same
# box vocabulary as the pairing card above so the two read as one system. Used
# for the post-connect PATH bridge, which users miss when it's a dim footnote
# under the card (it's the one step that stands between them and a working
# 'hx').
#
# Inner width = 3-space pad + widest of (message, command) + 3-space pad.
# ASCII-only inputs, like pad_to: ${#…} counts bytes rather than glyphs in some
# shells, so a non-ASCII message would misalign the rules against the box.
draw_cta() {
  _msg=$1; _cmd=$2
  _w=${#_msg}; [ "${#_cmd}" -gt "$_w" ] && _w=${#_cmd}
  _in=$(( _w + 6 ))
  _rule=$(str_repeat "$_in" "$BOX_H")
  _sp=$(str_repeat "$_in" ' ')
  printf '  %s%s%s%s%s\n' "$ACC" "$BOX_TL" "$_rule" "$BOX_TR" "$RST"
  printf '  %s%s%s%s%s%s%s\n' "$ACC" "$BOX_V" "$RST" "$_sp" "$ACC" "$BOX_V" "$RST"
  printf '  %s%s%s   %s%s%s   %s%s%s\n' \
    "$ACC" "$BOX_V" "$RST" \
    "$BLD" "$(pad_to "$_msg" "$_w")" "$RST" \
    "$ACC" "$BOX_V" "$RST"
  printf '  %s%s%s%s%s%s%s\n' "$ACC" "$BOX_V" "$RST" "$_sp" "$ACC" "$BOX_V" "$RST"
  printf '  %s%s%s   %s%s%s   %s%s%s\n' \
    "$ACC" "$BOX_V" "$RST" \
    "$BLD$ACC" "$(pad_to "$_cmd" "$_w")" "$RST" \
    "$ACC" "$BOX_V" "$RST"
  printf '  %s%s%s%s%s%s%s\n' "$ACC" "$BOX_V" "$RST" "$_sp" "$ACC" "$BOX_V" "$RST"
  printf '  %s%s%s%s%s\n' "$ACC" "$BOX_BL" "$_rule" "$BOX_BR" "$RST"
}

# Silent on success; non-zero return on mismatch. The published .sha256 is
# "<hex>  hx-<os>-<arch>" form, so we verify the file under its asset name.
verify_checksum() {
  ( cd "$tmp" || exit 1
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c "$asset.sha256" >/dev/null 2>&1
    elif command -v shasum >/dev/null 2>&1; then
      _exp=$(awk '{print $1}' "$asset.sha256")
      _act=$(shasum -a 256 "$asset" | awk '{print $1}')
      [ "$_exp" = "$_act" ]
    else
      echo "hx2: neither sha256sum nor shasum available; cannot verify checksum" >&2
      exit 1
    fi
  )
}

# --- fetch + verify ---------------------------------------------------
mkdir -p "$BIN_DIR"
tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  show_cursor
}
trap cleanup EXIT
hide_cursor

# Save the binary under its asset name in the tempdir: gunzip strips the
# .gz suffix to leave "$tmp/$asset", which is exactly the filename the
# .sha256 references, so the verify step resolves it relative to cwd.
status "Downloading hx2…"
draw_bar 0 "Downloading"
: > "$tmp/dl-err"
curl -fL --silent --show-error -D "$tmp/dl-headers" "${HX_DOWNLOAD_BASE}/${asset}.gz${HX_QS}" -o "$tmp/$asset.gz" 2>"$tmp/dl-err" &
dl_pid=$!

# Drive the bar (0–85%) off bytes-on-disk vs. the response content-length,
# which the workbench-api download proxy always sets. Until the headers
# land we show an indeterminate pulse.
total=0
frame=0
while kill -0 "$dl_pid" 2>/dev/null; do
  if [ "$total" -le 0 ] && [ -s "$tmp/dl-headers" ]; then
    total=$(awk 'tolower($0) ~ /^content-length:/ {v=$2} END{gsub(/[^0-9]/,"",v); if (v=="") print 0; else print v+0}' "$tmp/dl-headers" 2>/dev/null || echo 0)
    [ -z "$total" ] && total=0
  fi
  if [ "$total" -gt 0 ]; then
    cur=$(wc -c < "$tmp/$asset.gz" 2>/dev/null || echo 0)
    [ -z "$cur" ] && cur=0
    pct=$(( cur * 85 / total ))
    [ "$pct" -gt 85 ] && pct=85
    draw_bar "$pct" "Downloading"
  else
    draw_pulse "Downloading" "$frame"
  fi
  frame=$(( frame + 1 ))
  sleep 0.08 2>/dev/null || sleep 1
done

dl_status=0
wait "$dl_pid" || dl_status=$?
if [ "$dl_status" -ne 0 ]; then
  clear_line
  show_cursor
  echo "hx2: download failed." >&2
  [ -s "$tmp/dl-err" ] && sed 's/^/hx2: /' "$tmp/dl-err" >&2
  echo "hx2: checked: ${HX_DOWNLOAD_BASE}/${asset}.gz" >&2
  echo "hx2: if this is a fresh deploy, the workbench-api may not yet have" >&2
  echo "    GITHUB_PAT_OSS_RELEASES configured — see the workbench docs." >&2
  exit 1
fi
draw_bar 85 "Downloading"

if ! curl -fsSL "${HX_DOWNLOAD_BASE}/${asset}.sha256${HX_QS}" -o "$tmp/$asset.sha256"; then
  clear_line
  show_cursor
  echo "hx2: failed to download checksum. Aborting." >&2
  exit 1
fi

status "Unpacking…"
draw_bar 90 "Unpacking"
if ! gunzip -f "$tmp/$asset.gz" 2>"$tmp/gz-err"; then
  clear_line
  show_cursor
  echo "hx2: decompress failed. Aborting." >&2
  [ -s "$tmp/gz-err" ] && sed 's/^/hx2: /' "$tmp/gz-err" >&2
  exit 1
fi

status "Verifying…"
draw_bar 96 "Verifying"
if ! verify_checksum; then
  clear_line
  show_cursor
  echo "hx2: checksum verification failed — refusing to install." >&2
  echo "hx2: the download may be corrupt or truncated; re-run to retry." >&2
  exit 1
fi
draw_bar 100 "Verifying"
end_line

# --- install ---------------------------------------------------------
mv "$tmp/$asset" "$BIN_DIR/hx2"
chmod +x "$BIN_DIR/hx2"

# macOS Gatekeeper quarantines binaries downloaded via curl. Stripping the
# quarantine xattr lets first-launch succeed without "cannot be opened
# because the developer cannot be verified" until we sign + notarize.
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$BIN_DIR/hx2" 2>/dev/null || true
fi

# --- detect the shell the user is actually running --------------------
# $SHELL is only the *login* shell recorded in the password DB. It does
# NOT change when the user starts a different shell, so a zsh-login user
# sitting in bash (or vice-versa) would otherwise get the wrong rc file
# and a re-exec into the wrong shell. What we want is the shell that ran
# this 'curl | sh': in that pipeline the parent of this 'sh' IS that
# interactive shell, so we read its name off $PPID and only fall back to
# $SHELL when ps can't answer.
hx_shell=$(basename "${SHELL:-/bin/sh}")
if command -v ps >/dev/null 2>&1; then
  _pcomm=$(ps -o comm= -p "$PPID" 2>/dev/null || true)
  _pcomm=${_pcomm#-}        # login shells show as '-zsh' / '-bash'
  _pcomm=${_pcomm##*/}      # strip any dir: '/bin/zsh' -> 'zsh'
  case "$_pcomm" in
    zsh|bash|fish|sh|dash|ksh|ksh93|mksh|ash) hx_shell=$_pcomm ;;
  esac
fi

# Absolute path to that shell, for the re-exec further down. Prefer $SHELL
# when it's the same kind (it's already a full path); else resolve the name
# on PATH; last resort, whatever $SHELL/sh we can name.
if [ "$(basename "${SHELL:-}")" = "$hx_shell" ] && [ -x "${SHELL:-/dev/null}" ]; then
  hx_shell_bin="$SHELL"
else
  hx_shell_bin=$(command -v "$hx_shell" 2>/dev/null || printf '%s' "${SHELL:-/bin/sh}")
fi

# --- PATH into shell-rc ----------------------------------------------
# rc file, the exact PATH line we append, the re-exec flags, and the keyword
# the user types to load rc all depend on which shell we detected:
#   zsh            -> ~/.zshrc                    interactive  (-i)
#   bash on darwin -> ~/.bash_profile             LOGIN (-i -l): Terminal.app
#                                                 runs bash as a login shell,
#                                                 which reads .bash_profile,
#                                                 NOT .bashrc
#   bash on linux  -> ~/.bashrc                   interactive  (-i)
#   fish           -> ~/.config/fish/config.fish  interactive  (-i); fish
#                                                 syntax (fish_add_path),
#                                                 'source' to load
#   anything else  -> ~/.profile                  LOGIN (-i -l); POSIX export,
#                                                 '.' to load (sh has no
#                                                 'source')
#
# Only PATH goes in the rc now. The gateway URL lives in ~/.let/hx/config.json
# (seeded below) — hx's single source of truth. Earlier installers also wrote
# an 'export HX_GATEWAY_URL=' line; re-installing against a different gateway
# stacked a *new* export (the idempotency check only deduped identical lines),
# the last silently won, and it hijacked which gateway a connected device
# talked to. No env var, no hijack.
case "$hx_shell" in
  zsh)
    rc="${HOME}/.zshrc"
    path_line='export PATH="$HOME/.let/bin:$PATH"'
    reexec_flags="-i"
    source_kw="source"
    ;;
  bash)
    if [ "$os" = darwin ]; then
      rc="${HOME}/.bash_profile"; reexec_flags="-i -l"
    else
      rc="${HOME}/.bashrc"; reexec_flags="-i"
    fi
    path_line='export PATH="$HOME/.let/bin:$PATH"'
    source_kw="source"
    ;;
  fish)
    rc="${HOME}/.config/fish/config.fish"
    mkdir -p "${HOME}/.config/fish"
    path_line='fish_add_path "$HOME/.let/bin"'
    reexec_flags="-i"
    source_kw="source"
    ;;
  *)
    rc="${HOME}/.profile"
    path_line='export PATH="$HOME/.let/bin:$PATH"'
    reexec_flags="-i -l"
    source_kw="."
    ;;
esac
# An unwritable rc must not fail the install. Read-only rc files
# (home-manager/chezmoi symlink them into an immutable store) and an unwritable
# $HOME (containers) are both real, and under 'set -e' an unguarded '>>' aborts
# the script right here — between the binary landing and the gateway seed, so
# the user is left with a half-installed hx and no config at all. /bin/sh is
# dash on Debian/Ubuntu and dash DOES abort on a failed redirect into a { }
# group; bash-as-sh doesn't, which is why this only ever bit Linux.
#
# 2>/dev/null ahead of the '>>', not after: redirections are applied in order,
# so with the append first the shell's own "Permission denied" reaches the real
# stderr before /dev/null is in place.
#
# Idempotency: full-line fixed-string match (grep -qxF); append the PATH line
# only if it's missing. A loose substring grep would treat any past mention of
# .let/bin as "done" — including in a different rc file.
touch "$rc" 2>/dev/null || true
path_written=0
if grep -qxF "$path_line" "$rc" 2>/dev/null; then
  path_written=1
elif {
  echo ""
  echo "# Added by hx2 installer ($(date '+%Y-%m-%d'))"
  echo "$path_line"
} 2>/dev/null >> "$rc"; then
  path_written=1
fi

# --- Gateway URL into hx config (single source of truth) -------------
# hx reads the gateway from ~/.let/hx/config.json; 'hx connect' adds the device
# token alongside it. First the one-time ~/.hx -> ~/.let/hx migration (the same
# gated move as the binary's ensureHxHome) so a legacy device id / auth token
# carries over and everything below sees one canonical layout. Skipped when
# ~/.let/hx already exists — exactly like the binary, which then ignores ~/.hx.
#
# Then config.json, three cases:
#
#   1. No config.json   -> seed gatewayBaseUrl so 'hx connect' knows where to
#      call. Gating on the config FILE matters: gating on the legacy ~/.hx dir
#      would skip the seed for a never-connected legacy install (dir present,
#      no config), leaving 'hx connect' with no gateway.
#   2. Same gateway     -> leave the config untouched, so a re-install /
#      upgrade never clobbers a live device token.
#   3. Different gateway-> the device follows the installer. Each environment
#      (beta.let.ai, letai.dev, a localhost dev gateway) serves install.sh
#      with its own URL baked in, so running one is the explicit "mirror to
#      THIS workbench" act — a device that kept its old gateway here would
#      reconnect to the wrong environment, which is exactly the bug this
#      branch exists to prevent. Stop the background daemon first (a running
#      mirror holds the old gateway + token in memory and re-persists upload
#      state for it), drop state.json (per-gateway upload offsets + artifact
#      hashes — the new gateway holds none of those bytes, and stale latches
#      would suppress the re-upload), and write a fresh config with only the
#      new gateway. The old token authenticated only the old gateway and is
#      dropped with it; that workbench keeps its sessions and simply shows
#      this device offline (remove it from its Devices page if you want it
#      gone). The preserved device-id means reconnecting back later restores
#      the device's sessions there. A corrupt or gateway-less config.json
#      lands in this branch too and self-heals.
hx_config_dir="${HOME}/.let/hx"
hx_config="${hx_config_dir}/config.json"
if [ -d "${HOME}/.hx" ] && [ ! -d "$hx_config_dir" ]; then
  mkdir -p "${HOME}/.let"
  mv "${HOME}/.hx" "$hx_config_dir" 2>/dev/null || true
fi
hx_repointed=0
hx_prev_host=
if [ ! -f "$hx_config" ]; then
  mkdir -p "$hx_config_dir"
  printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$HX_GATEWAY_URL" > "$hx_config"
  chmod 600 "$hx_config" 2>/dev/null || true
else
  hx_saved_gw=$(sed -n 's/.*"gatewayBaseUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$hx_config" 2>/dev/null | head -n 1)
  if [ "${hx_saved_gw%/}" != "${HX_GATEWAY_URL%/}" ]; then
    "$BIN_DIR/hx2" stop >/dev/null 2>&1 || true
    rm -f "${hx_config_dir}/state.json"
    printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$HX_GATEWAY_URL" > "$hx_config"
    chmod 600 "$hx_config" 2>/dev/null || true
    hx_repointed=1
    if [ -n "$hx_saved_gw" ]; then
      hx_prev_host=${hx_saved_gw#*://}; hx_prev_host=${hx_prev_host%%/*}
    fi
  fi
fi

# --- done ------------------------------------------------------------
show_cursor

echo ""
printf '  %shx2 installed %s%s\n' "$GRN" "$OK_MARK" "$RST"
echo ""

# Cross-environment install: say where the device points now (and where it
# pointed before) — the connect offer below is for the NEW gateway, and the
# old one will show this device offline from here on.
if [ "$hx_repointed" = 1 ]; then
  hx_new_host=${HX_GATEWAY_URL#*://}; hx_new_host=${hx_new_host%%/*}
  if [ -n "$hx_prev_host" ]; then
    printf '  Now pointing at %s%s%s (was %s).\n' "$BLD" "$hx_new_host" "$RST" "$hx_prev_host"
  else
    printf '  Now pointing at %s%s%s.\n' "$BLD" "$hx_new_host" "$RST"
  fi
  echo ""
fi

# Is hx reachable as a bare command right now? The install subshell inherits
# PATH from the shell that ran curl-pipe, so command -v answers exactly that.
# This does NOT gate the offer to connect — we make that whenever there's a
# terminal, fresh install or re-run alike — it only decides what the
# follow-up says: a bare 'hx connect' when hx is already on PATH, or a
# PATH-bridging step (fresh shell / source line) when it isn't.
hx_on_path=0
command -v hx2 >/dev/null 2>&1 && hx_on_path=1

# Already connected? An accessToken in config.json is written by a past
# 'hx connect' and dropped by 'hx disconnect' (which keeps the gateway URL),
# so a token in it means THIS device is already linked. Re-running the
# installer then shouldn't nag them to connect again — say so, and point at
# the one command that changes it. $hx_config is the post-migration path, so
# a legacy connected device (config still in ~/.hx a moment ago) lands here
# too. Runs before the tty probe so it short-circuits in every mode
# (interactive or CI). The three-way split mirrors the connect paths below:
# 'hx disconnect' only works in this shell if ~/.let/bin is on PATH, sourcing
# only helps if the rc actually took our PATH line, and the absolute path is
# what's left when neither holds.
if [ -s "$hx_config" ] && grep -q '"accessToken"' "$hx_config" 2>/dev/null; then
  # The login is hx's, shared through ~/.let/hx, and the background service
  # may still run hx. 'hx2 connect' reuses the login (no new pairing) and moves
  # the service to hx2; on a device that already runs hx2 it restarts it on the
  # binary just installed.
  echo "  This device is already connected. To run hx2 on it with the same login, run:"
  echo ""
  if [ "$hx_on_path" = 1 ]; then
    printf '      %shx2 connect%s\n' "$ACC" "$RST"
  elif [ "$path_written" = 1 ]; then
    printf '      %s%s %s && hx2 connect%s\n' "$ACC" "$source_kw" "$rc" "$RST"
  else
    printf '      %s%s connect%s\n' "$ACC" "$BIN_DIR/hx2" "$RST"
  fi
  echo ""
  exit 0
fi

# Fresh install: ~/.let/bin is NOT on the parent shell's PATH, and a
# subshell spawned by 'curl | sh' can never mutate its parent's
# environment — a kernel guarantee, not a shell quirk. So 'hx' isn't a
# command the user can type yet. With a controlling terminal we offer to
# bridge that gap for them; without one we fall back to a source line.
# (reexec_flags + hx_shell_bin were both worked out up top, per shell.)
#
# Probe /dev/tty by actually opening it — [ -c /dev/tty ] is NOT enough:
# the node exists even with no controlling terminal (CI, daemons, piped
# stdin), where opening it fails with ENXIO. The subshell contains that
# failure (no set -e abort) and 2>/dev/null hides the noise. No tty (or no
# usable shell binary) -> can't prompt, so fall through to the source line.
if (: </dev/tty) 2>/dev/null && [ -x "$hx_shell_bin" ]; then
  # One question, Enter-to-accept. Default (Enter, or anything but a leading
  # n) runs the device-code flow for them: hx by its full path — no PATH
  # entry and no child shell needed to reach it — backgrounded with nohup so
  # it outlives this pipeline (and a quick terminal close) while it waits on
  # the browser approval, then auto-starts the daemon. The user drops
  # straight back to their own prompt. No --gateway needed: the installer
  # seeded the gateway into ~/.let/hx/config.json above, and 'hx connect' reads
  # it from there (config.json is hx's single source of truth).
  #
  # Decline (n) keeps the original path: re-exec into a fresh interactive
  # instance of the user's OWN shell (hx_shell_bin — the same kind they ran
  # this from, found via $PPID up top), stdin reattached via /dev/tty, which
  # sources the rc we just edited so ~/.let/bin is on PATH and they can run
  # 'hx connect' themselves. exec replaces the image in place (no extra
  # nesting beyond the running pipeline); their original shell stays parked
  # in wait() until it exits.
  printf '  Open browser to connect this device? %s[Y/n]%s ' "$DIM" "$RST"
  read -r reply </dev/tty || reply=""
  case "$reply" in
    [Nn]*)
      echo ""
      if [ "$hx_on_path" = 1 ]; then
        # hx already reachable — no shell bridge needed, just the next step.
        echo "  Connect this device — run:"
        echo ""
        printf '      %shx2 connect%s\n' "$ACC" "$RST"
        echo ""
        exit 0
      fi
      if [ "$path_written" = 0 ]; then
        # The rc never took our PATH line, so a fresh shell would come up just
        # as PATH-less as this one — re-exec'ing would cost them a nesting
        # level and still leave 'hx' unrecognized. Name the binary that works.
        echo "  Connect this device — run:"
        echo ""
        printf '      %s%s connect%s\n' "$ACC" "$BIN_DIR/hx2" "$RST"
        echo ""
        exit 0
      fi
      printf '  %sopening a fresh shell so hx2 is ready — type exit to return%s\n' "$DIM" "$RST"
      echo ""
      echo "  Connect this device — run:"
      echo ""
      printf '      %shx2 connect%s\n' "$ACC" "$RST"
      echo ""
      rm -rf "$tmp"   # exec replaces this process, so the EXIT trap won't fire
      exec "$hx_shell_bin" $reexec_flags </dev/tty
      ;;
    *)
      echo ""
      mkdir -p "${HOME}/.let/hx"
      connect_log="${HOME}/.let/hx/connect.log"
      # Truncate up front: a stale log from a previous run would otherwise let
      # the code-lift below grep out last run's (long-expired) pairing code.
      : > "$connect_log"
      nohup "$BIN_DIR/hx2" connect </dev/null >"$connect_log" 2>&1 &
      printf '  %sOpening your browser to connect this device…%s\n' "$DIM" "$RST"
      echo ""

      # The browser approve page says "Check this matches your terminal" — but
      # 'hx connect' runs backgrounded with its output in $connect_log, so lift
      # the pairing code out of the log and card it here. XXXX-XXXX over the
      # gateway's user-code alphabet (A–Z minus I/O, plus 2–9) matches nothing
      # else hx prints before the code. Bounded wait: ~10 s covers a slow first
      # round-trip; past that, skip the card and point at the log instead — the
      # browser tab still shows the code either way.
      #
      # Same lift for the verification URL: 'hx connect' logs it on its own
      # "    https://…" line right after the card (see connect.ts), but
      # backgrounding swallows that into $connect_log too. openBrowser() inside
      # hx is also best-effort and silently does nothing on a headless setup
      # (e.g. WSL with no xdg-open target) — without this line the user would
      # have no way to reach the approve page at all.
      code=
      url=
      _t=0
      while [ "$_t" -lt 50 ]; do
        code=$(grep -m1 -oE '[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}' "$connect_log" 2>/dev/null || true)
        url=$(grep -m1 -oE 'https?://[^[:space:]]+' "$connect_log" 2>/dev/null || true)
        [ -n "$code" ] && [ -n "$url" ] && break
        _t=$(( _t + 1 ))
        sleep 0.2 2>/dev/null || sleep 1
      done
      if [ -n "$code" ]; then
        gw_host=${HX_GATEWAY_URL#*://}; gw_host=${gw_host%%/*}
        draw_code_card "$code" "$gw_host"
        echo ""
        echo "  Check the code matches what your browser shows, then approve there."
        echo ""
      else
        printf '  %sNo pairing code yet — details in %s%s\n' "$DIM" "$connect_log" "$RST"
        echo ""
      fi
      if [ -n "$url" ]; then
        echo "  Browser didn't open? Visit:"
        printf '    %s%s%s\n' "$ACC" "$url" "$RST"
        echo ""
      fi
      echo "  hx2 keeps running in the background once you approve."
      if [ "$hx_on_path" = 0 ]; then
        # Only meaningful when hx isn't already reachable: bridge THIS shell.
        # Boxed, not a dim footnote — this lands under the pairing card at the
        # end of a wall of output, and skipping it leaves 'hx' unrecognized in
        # the very terminal the user is about to type it into.
        #
        # Sourcing an rc we failed to write bridges nothing, and no new
        # terminal will find hx either, so that case asks for the line by hand
        # — the one instruction that still leads to a working 'hx'.
        echo ""
        if [ "$path_written" = 1 ]; then
          draw_cta "Run this to use hx2 in this terminal:" "$source_kw $rc"
          echo ""
          printf '  %s(new terminals find hx2 automatically)%s\n' "$DIM" "$RST"
        else
          draw_cta "Couldn't write $rc. Add this line to it:" "$path_line"
        fi
      fi
      echo ""
      exit 0
      ;;
  esac
fi

# No controlling tty (CI / redirected stdin): can't prompt or open an
# interactive shell, so print the next step non-interactively — bare when hx
# is already reachable, a one-time source when the rc took our PATH line, and
# the absolute path when it didn't (nothing to source, no new terminal will
# find hx either).
if [ "$hx_on_path" = 1 ]; then
  echo "  Connect this device — run:"
  echo ""
  printf '      %shx2 connect%s\n' "$ACC" "$RST"
  echo ""
elif [ "$path_written" = 1 ]; then
  echo "  Connect this device — run:"
  echo ""
  printf '      %s%s %s && hx2 connect%s\n' "$ACC" "$source_kw" "$rc" "$RST"
  echo ""
  printf '  %s(new terminals find hx2 automatically — no source needed)%s\n' "$DIM" "$RST"
  echo ""
else
  echo "  Connect this device — run:"
  echo ""
  printf '      %s%s connect%s\n' "$ACC" "$BIN_DIR/hx2" "$RST"
  echo ""
  printf '  %s(%s is not writable — add %s to it to type a bare hx2)%s\n' "$DIM" "$rc" "$path_line" "$RST"
  echo ""
fi
