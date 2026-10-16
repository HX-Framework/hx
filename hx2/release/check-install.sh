#!/bin/sh
# Installs hx2 on macOS or Linux the way a person does, `curl … | sh`, from a
# stand-in let.ai on 127.0.0.1 that serves this build (serve.py), checks what
# the installer left, uninstalls and checks that nothing of hx2 is left.
# First, with nothing published, the installer must say so and install nothing.
#
# Usage: check-install.sh <release dir> <version> <work dir> [<expected asset>]
# The whole run happens under <work dir>/home, which stands in for $HOME. With
# an expected asset, the run fails when this machine would install another.
set -eu

release_dir=$1
version=$2
work=$3
expect_asset=${4:-}
here=$(cd "$(dirname "$0")" && pwd)
port=47913
base="http://127.0.0.1:$port"
py=$(command -v python3 || command -v python)

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
asset="hx2-$os-$arch"
if [ -n "$expect_asset" ] && [ "$expect_asset" != "$asset" ]; then
  echo "FAIL: this machine installs $asset, not $expect_asset" >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() {
  echo "ok: $*"
}

server=
start_server() {
  : > "$work/requests.log"
  "$py" "$here/serve.py" --port "$port" --scripts "$here" --log "$work/requests.log" "$@" &
  server=$!
  i=0
  until curl -fsS -o /dev/null "$base/install-hx2.sh" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 100 ] || fail "the stand-in server did not start"
    sleep 0.1
  done
  : > "$work/requests.log"
}
stop_server() {
  [ -n "$server" ] && kill "$server" 2>/dev/null && wait "$server" 2>/dev/null || true
  server=
}
trap stop_server EXIT

mkdir -p "$work"
real_home=$HOME
export HOME="$work/home"
rm -rf "$HOME"
mkdir -p "$HOME"

# 1. Nothing published: one line, exit 1, nothing installed.
start_server --empty
set +e
curl -fsSL "$base/install-hx2.sh?channel=build" | sh > "$work/empty.out" 2>&1
code=$?
set -e
cat "$work/empty.out"
[ "$code" -eq 1 ] || fail "with nothing published the installer exited $code, not 1"
grep -qx 'hx2: no hx2 build has been published yet.' "$work/empty.out" || fail "the installer did not say that nothing is published"
[ ! -e "$HOME/.let/bin/hx2" ] || fail "the installer installed something with nothing published"
pass "nothing published: the installer says so, exits 1 and installs nothing"
stop_server

# 2. Install this build.
start_server --release "$release_dir"
curl -fsSL "$base/install-hx2.sh?channel=build" | sh > "$work/install.out" 2>&1 || {
  cat "$work/install.out"
  fail "the installer failed"
}
cat "$work/install.out"
grep -q 'hx2 installed' "$work/install.out" || fail "the installer did not report the install"
bin="$HOME/.let/bin/hx2"
[ -x "$bin" ] || fail "$bin is missing or not executable"
got=$("$bin" --version)
[ "$got" = "hx2 version: $version" ] || fail "hx2 --version printed '$got', not 'hx2 version: $version'"
pass "hx2 --version: $got"
grep -q "\"gatewayBaseUrl\": \"$base/_api/hx-gateway\"" "$HOME/.let/hx/config.json" || fail "config.json does not name the gateway the script came from"
pass "config.json names the gateway"

# The PATH line went into the rc file of the shell that ran `curl | sh`, and a
# fresh shell that reads it finds hx2.
rc=
for f in .profile .bashrc .bash_profile .zshrc .config/fish/config.fish; do
  if grep -q '^# Added by hx2 installer' "$HOME/$f" 2>/dev/null; then
    [ -z "$rc" ] || fail "the PATH line went into more than one rc file"
    rc="$HOME/$f"
  fi
done
[ -n "$rc" ] || fail "no rc file carries the PATH line"
got=$(env -i HOME="$HOME" PATH=/usr/bin:/bin sh -c ". \"$rc\" && hx2 --version")
[ "$got" = "hx2 version: $version" ] || fail "a fresh shell reading $rc printed '$got'"
pass "a fresh shell that reads $(basename "$rc") finds hx2"

# What was fetched: the script, then the version file, the binary and its
# checksum, each on the build channel, and nothing else.
cat "$work/requests.log"
for want in \
  "GET /install-hx2.sh?channel=build 200" \
  "GET /_api/hx-gateway/download/hx2-version?channel=build 200" \
  "GET /_api/hx-gateway/download/$asset.gz?channel=build 200" \
  "GET /_api/hx-gateway/download/$asset.sha256?channel=build 200"; do
  grep -qx "$want" "$work/requests.log" || fail "not requested: $want"
done
[ "$(wc -l < "$work/requests.log" | tr -d ' ')" -eq 4 ] || fail "the installer made requests beyond the three downloads"
pass "the installer fetched hx2-version, $asset.gz and $asset.sha256 on the build channel"

# 3. Install again over the first install, as an update by script would.
curl -fsSL "$base/install-hx2.sh?channel=build" | sh > "$work/reinstall.out" 2>&1 || {
  cat "$work/reinstall.out"
  fail "installing over an existing install failed"
}
got=$("$bin" --version)
[ "$got" = "hx2 version: $version" ] || fail "after the second install hx2 --version printed '$got'"
if grep -q 'already connected' "$work/reinstall.out"; then
  fail "the second install claims a connection this device never made"
fi
pass "installing over an existing install works"
stop_server

# 4. Uninstall. hx2 uninstall removes the binary and keeps ~/.let/hx (and,
# like hx, leaves the rc line for the person to delete). Until hx2 has the
# command, the check removes what hx uninstall removes, so the end state is
# checked the same way either way.
set +e
"$bin" uninstall > "$work/uninstall.out" 2>&1
code=$?
set -e
cat "$work/uninstall.out"
if [ "$code" -eq 64 ] && grep -q 'is not available in this build' "$work/uninstall.out"; then
  echo "hx2 has no uninstall command in this build; removing what hx uninstall removes"
  rm -f "$bin"
elif [ "$code" -ne 0 ]; then
  fail "hx2 uninstall exited $code"
fi
[ ! -e "$bin" ] || fail "$bin is still there after the uninstall"
[ -f "$HOME/.let/hx/config.json" ] || fail "the uninstall removed ~/.let/hx without --purge"
pass "uninstalled: the binary is gone and ~/.let/hx stays"

# --purge removes ~/.let/hx as well; after it, no file of hx2's is left.
rm -rf "$HOME/.let/hx"
left=$(cd "$HOME" && find . -type f ! -path "./$(basename "$rc")" ! -path "./.config/fish/config.fish" | sort)
[ -z "$left" ] || fail "files left after the uninstall: $left"
pass "nothing of hx2 is left under the home but the rc line"

export HOME="$real_home"
echo "all install checks passed for $asset $version"
