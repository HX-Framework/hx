#!/usr/bin/env bash
# Build one hx binary from a source checkout, the way release.yml does it
# (web UI, embedded asset manifest, then `bun build --compile` for the
# runner's own platform). Used by .github/workflows/differential.yml for the
# reference, the candidate and the deliberately broken candidates.
#
#   harness/ci/build.sh <source dir> <output binary>
set -euo pipefail

src="${1:?source dir}"
out="${2:?output binary}"

cd "$src"
bun install --frozen-lockfile
(cd ui && bun install --frozen-lockfile && bun run build)
bun run gen:ui
mkdir -p "$(dirname "$out")"
bun build --compile --minify ./src/cli.ts --outfile "$out"
chmod +x "$out"
"$out" --version
