#!/bin/sh
# hx — build-from-source installer + connect entrypoint.
#
# Reaches the same running, connected hx daemon as the prebuilt
# `curl … | sh` installer, but compiles the binary locally from this checkout
# instead of downloading it. Everything after the build — seeding the gateway
# URL into ~/.let/hx/config.json and the interactive `hx connect` device flow
# (which opens your browser) — is identical to the binary installer.
#
# Usage (the gateway URL is optional and defaults to production, let.ai):
#
#   ./install-from-source.sh [gateway-url]
#
# where <gateway-url> is your workbench's hx gateway, e.g.
# https://<your-workbench>/_api/hx-gateway.
set -eu

INSTALL_DIR="${HOME}/.let/bin"
BIN="${INSTALL_DIR}/hx"
HX_DIR="${HOME}/.let/hx"
CONFIG="${HX_DIR}/config.json"
DEFAULT_GATEWAY_URL="https://let.ai/_api/hx-gateway"

usage() {
  echo "usage: ./install-from-source.sh [gateway-url]" >&2
  exit 2
}

# --- parse args --------------------------------------------------------
# A single optional positional <gateway-url>, defaulting to production. `hx connect`
# has no --gateway flag and no env var: the gateway is read only from
# config.json, so we seed it below.
GATEWAY_URL="$DEFAULT_GATEWAY_URL"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    -*)
      echo "hx: unknown option: $1" >&2
      usage
      ;;
    *)
      GATEWAY_URL="$1"   # last positional wins; default already set
      shift
      ;;
  esac
done

# --- require Bun (offer to install) -------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  printf "Bun is required to build from source. Install Bun now? (Y/n) " >&2
  read ans </dev/tty || ans=""
  case "$ans" in
    [nN]*) echo "Install Bun then re-run:  curl -fsSL https://bun.sh/install | bash" >&2; exit 1 ;;
    *)
      curl -fsSL https://bun.sh/install | bash
      # The installer edits shell rc, NOT this process — add bun to PATH now.
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      command -v bun >/dev/null 2>&1 || { echo "hx: Bun install failed." >&2; exit 1; }
      ;;
  esac
fi

# --- build -------------------------------------------------------------
# Run from the repo root regardless of where the script was invoked from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

echo "Installing dependencies…"
bun install

echo "Building hx…"
bun run build

# --- install -----------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/dist/hx" "$BIN"

# Ad-hoc code signature (macOS only). `--sign -` is an ad-hoc signature — the
# only no-cost option for a locally built binary. Without it the kernel can
# kill a freshly compiled unsigned binary with "code signature invalid".
if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$BIN"
fi

echo "Installed hx to $BIN"

# --- PATH into shell-rc ------------------------------------------------
# Without this, ~/.let/bin is on no shell's PATH and `hx` is not a command the
# user can type — not in this terminal, and not in a new one either. The build
# above only drops a binary; `hx connect` below reaches it by absolute path, so
# the gap is invisible until the user types plain `hx` and gets "command not
# found". The prebuilt one-line installer does this same append; from-source
# installs are entitled to a working `hx` too.
#
# rc file, the PATH line, and the keyword that loads rc all depend on the shell:
#   zsh            -> ~/.zshrc                    'source'
#   bash on darwin -> ~/.bash_profile             'source'  (Terminal.app runs
#                                                  bash as a LOGIN shell, which
#                                                  reads .bash_profile, not
#                                                  .bashrc)
#   bash on linux  -> ~/.bashrc                   'source'
#   fish           -> ~/.config/fish/config.fish  'source'  (fish syntax)
#   anything else  -> ~/.profile                  '.'       (sh has no 'source')
#
# $SHELL is only the *login* shell from the password DB; it doesn't change when
# the user starts a different shell. The shell that invoked this script is our
# parent, so read its name off $PPID and fall back to $SHELL when ps can't say.
#
# Only match shells a human sits in: an sh/dash parent is nearly always a
# wrapper (`sh install-from-source.sh`, a Makefile), and trusting it would send
# a zsh user's PATH line to ~/.profile, which zsh never reads. $SHELL answers
# those, and still lands a genuine sh user on ~/.profile via the default below.
hx_shell=$(basename "${SHELL:-/bin/sh}")
if command -v ps >/dev/null 2>&1; then
  _pcomm=$(ps -o comm= -p "$PPID" 2>/dev/null || true)
  _pcomm=${_pcomm#-}        # login shells show as '-zsh' / '-bash'
  _pcomm=${_pcomm##*/}      # strip any dir: '/bin/zsh' -> 'zsh'
  case "$_pcomm" in
    zsh|bash|fish) hx_shell=$_pcomm ;;
  esac
fi

case "$hx_shell" in
  zsh)
    RC="${HOME}/.zshrc"
    PATH_LINE='export PATH="$HOME/.let/bin:$PATH"'
    SOURCE_KW="source"
    ;;
  bash)
    if [ "$(uname -s)" = "Darwin" ]; then
      RC="${HOME}/.bash_profile"
    else
      RC="${HOME}/.bashrc"
    fi
    PATH_LINE='export PATH="$HOME/.let/bin:$PATH"'
    SOURCE_KW="source"
    ;;
  fish)
    RC="${HOME}/.config/fish/config.fish"
    mkdir -p "${HOME}/.config/fish"
    PATH_LINE='fish_add_path "$HOME/.let/bin"'
    SOURCE_KW="source"
    ;;
  *)
    RC="${HOME}/.profile"
    PATH_LINE='export PATH="$HOME/.let/bin:$PATH"'
    SOURCE_KW="."
    ;;
esac
touch "$RC" 2>/dev/null || true

# An unwritable rc must not fail the install — the binary is built and `hx
# connect` below still works. Read-only rc files (home-manager/chezmoi symlink
# them into an immutable store) and unwritable $HOME (containers) are both real,
# and under `set -e` an unguarded `>>` aborts here, between build and connect.
#
# Report success only when the line landed: an unconditional "Added …" would
# claim a PATH that was never set — the exact gap this block closes. As the
# `elif` condition the append is also exempt from `set -e`, whatever /bin/sh is.
#
# `2>/dev/null` ahead of the `>>`, not after: redirections are applied in order,
# so with the append first the shell's own "Permission denied" reaches the real
# stderr before /dev/null is in place.
#
# Idempotency: full-line fixed-string match, so a rebuild never stacks a second
# copy. A loose substring grep would treat any past mention of .let/bin as
# "done" — including one in a different rc file.
path_written=0
if grep -qxF "$PATH_LINE" "$RC" 2>/dev/null; then
  path_written=1
elif {
  echo ""
  echo "# Added by hx installer ($(date '+%Y-%m-%d'))"
  echo "$PATH_LINE"
} 2>/dev/null >> "$RC"; then
  path_written=1
  echo "Added ~/.let/bin to PATH in $RC"
fi

# Is `hx` reachable as a bare command in the shell that ran this script? This
# process inherited that shell's PATH, so `command -v` answers exactly that.
# Decides only whether the closing note below is needed: a shell that already
# has ~/.let/bin (a prior install) needs no bridge.
hx_on_path=0
command -v hx >/dev/null 2>&1 && hx_on_path=1

# --- seed the gateway into config.json (single source of truth) --------
# hx reads the gateway from ~/.let/hx/config.json; `hx connect` writes the
# device token alongside it. There is no --gateway flag and no env var, so the
# gateway MUST be on disk before connect runs. Three cases, matching the binary
# installer:
#
#   1. No config.json    -> seed gatewayBaseUrl so `hx connect` knows where to
#                           call.
#   2. Same gateway      -> leave it untouched, so a rebuild never clobbers a
#                           live device token.
#   3. Different gateway -> the device follows this build's gateway. Stop any
#                           running daemon (it holds the old gateway + token in
#                           memory), drop state.json (per-gateway upload offsets
#                           the new gateway doesn't have), and write a fresh
#                           config with only the new gateway. The old token
#                           authenticated only the old gateway and is dropped
#                           with it; `hx connect` mints a new one below.
mkdir -p "$HX_DIR"
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$GATEWAY_URL" > "$CONFIG"
  chmod 600 "$CONFIG" 2>/dev/null || true
else
  saved_gw=$(sed -n 's/.*"gatewayBaseUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -n 1)
  if [ "${saved_gw%/}" != "${GATEWAY_URL%/}" ]; then
    "$BIN" stop >/dev/null 2>&1 || true
    rm -f "${HX_DIR}/state.json"
    printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$GATEWAY_URL" > "$CONFIG"
    chmod 600 "$CONFIG" 2>/dev/null || true
  fi
fi

# --- CTA box -----------------------------------------------------------
# The prebuilt one-line installer ends on this same box. The two installers are
# separate programs with no library between them, so this layout is a
# deliberate copy — keep them looking alike by hand. The styling is what's
# duplicated; the PATH logic above is the actual fix.
#
# Colors only when stdout is a terminal that can show them, and only when the
# user hasn't opted out: a redirected install ("| tee", CI) gets clean ASCII
# with no escape cruft, TERM=dumb (Emacs shell-mode, some CI runners — a real
# pty that cannot render ANSI) would otherwise show a wall of literal
# "^[[38;5;39m", and NO_COLOR is the cross-tool opt-out (no-color.org; any
# value counts, including empty).
COLOR=0
[ -t 1 ] && COLOR=1
case "${TERM:-}" in dumb | "") COLOR=0 ;; esac
[ -n "${NO_COLOR+x}" ] && COLOR=0
if [ "$COLOR" = 1 ]; then
  ESC=$(printf '\033')
  DIM="${ESC}[2m"; BLD="${ESC}[1m"; ACC="${ESC}[38;5;39m"; RST="${ESC}[0m"
else
  DIM=; BLD=; ACC=; RST=
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]8* | *[Uu][Tt][Ff]-8*)
    BOX_TL='╭'; BOX_TR='╮'; BOX_BL='╰'; BOX_BR='╯'; BOX_H='─'; BOX_V='│'
    ;;
  *)
    BOX_TL='+'; BOX_TR='+'; BOX_BL='+'; BOX_BR='+'; BOX_H='-'; BOX_V='|'
    ;;
esac

# N copies of a glyph, and right-pad to a width: POSIX printf has no '%-*s'
# dynamic width, so both are built by hand. ASCII inputs only — ${#…} counts
# bytes rather than glyphs in some shells, which would misalign the rules.
str_repeat() {
  _n=$1; _c=$2; _s=
  while [ "$_n" -gt 0 ]; do _s="${_s}${_c}"; _n=$(( _n - 1 )); done
  printf '%s' "$_s"
}
pad_to() {
  _p=$1; _w=$2
  while [ "${#_p}" -lt "$_w" ]; do _p="${_p} "; done
  printf '%s' "$_p"
}

# One message line over one command line. Inner width = 3-space pad + widest of
# (message, command) + 3-space pad.
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

# --- connect -----------------------------------------------------------
# Hand off to the interactive `hx connect` device flow (opens the browser to
# approve this device, then starts the background mirror). Redirect </dev/tty
# when one is available so it can prompt even if this script was piped in.
#
# Run it as a child rather than exec'ing: the PATH bridge below has to be the
# LAST thing on screen. connect ends with its own pairing card and a wall of
# output, so anything printed before it scrolls out of view — and a bridge the
# user scrolls past is a bridge they don't cross. exec would replace this
# process and forfeit the chance to print anything at all. `set -e` would abort
# on a failed connect, so catch the status and carry it to our own exit: a
# failed connect still needs the bridge, since retrying means typing `hx`.
connect_status=0
if (: </dev/tty) 2>/dev/null; then
  "$BIN" connect </dev/tty || connect_status=$?
else
  "$BIN" connect || connect_status=$?
fi

# Nothing to say when `hx` already resolves. Otherwise the closing card depends
# on whether the rc line landed: sourcing an rc we failed to write bridges
# nothing, so that case asks for the line by hand instead — the one instruction
# that still works, and the last thing on screen either way.
if [ "$hx_on_path" = 0 ]; then
  echo ""
  if [ "$path_written" = 1 ]; then
    draw_cta "Run this to use hx in this terminal:" "$SOURCE_KW $RC"
    echo ""
    printf '  %s(new terminals find hx automatically)%s\n' "$DIM" "$RST"
  else
    draw_cta "Couldn't write $RC. Add this line to it:" "$PATH_LINE"
  fi
fi

exit "$connect_status"
