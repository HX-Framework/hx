# The differential harness

Two hx binaries run on the same inputs; any difference in what leaves a
binary fails the build. This is how the TypeScript design fixes and, later,
the Rust port (hx2, on the `hx-2.0` branch) are proven to behave exactly like
the client people run today. Everything in `harness/` runs in GitHub Actions
(`.github/workflows/differential.yml`); nothing here is meant for a laptop.

## What runs

```
harness/
  gateway/        the fake gateway: the full hx protocol, an in-memory store,
                  faults, a JSONL recording of every request
  fixtures/       the fixture generator: three HOME shapes, all generated,
                  nothing copied from a real machine
  lib/            Snappy compressor + leveldb writer (for the Claude Desktop
                  fixture), normalization rules, comparators, shared types
  run/            scenarios.ts (the catalog), run-scenario.ts (drive one
                  binary), run-harness.ts (reference vs candidate + report)
  golden/<os>/    committed, normalized CLI outputs per scenario step
  broken/         patches that make a candidate differ on purpose
  ci/build.sh     one binary from one source checkout, as release.yml does it
  reference.lock.json  the commit the reference is built from
```

For each scenario the driver generates a fresh fixture home, starts a fresh
fake gateway on `127.0.0.1:48621` (and, for fortress-direct, a second one on
`48622`), writes the binary's own `config.json`, `device-id` and
`settings.json`, then runs the steps: `hx watch --once`, `hx status`,
`hx doctor sync`, `hx tick`, `hx retry`, `hx backfill`, `hx reattribute`,
`hx update`, `hx connect`, `hx disconnect`, `hx ui` with its API probed, or a
long-running `hx watch` killed with SIGKILL. The reference runs first, then
the candidate, both against the same home path (transcript contents embed
their cwd, so the stored bytes must match byte for byte).

### Fixture shapes

| Shape | What it holds |
| --- | --- |
| `small` | The curated core: 13 Claude Code transcripts covering every parsing quirk (a user and an AI title, a plan attachment, a cwd-change twin, a 70 MB file past the 64 MB per-pass budget, a 5 MiB single line, emoji/CJK/a lone surrogate, a message past the 4,000-unit cap, a file and a directory older than the 30-day window, an empty file), two subagent lanes with meta sidecars, a workflow run (journal + script + lane), tasks for two sessions, a team config, git repositories the cwds point at (a clone, a linked worktree, a non-GitHub remote) and an encoded `@owner@name@xxxxxx` scratch cwd; four Codex rollouts (CLI, desktop originator, archived) and a `state_5.sqlite` with a user name, an AI title and a missing row; five Claude Desktop session files and a Local Storage leveldb with a stale `.log` and an authoritative Snappy-compressed `.ldb` (two groups, assignments, unread ids, a vestigial `dframe-store`). |
| `claude-like` | The core plus 600 sessions over 150 project dirs, 60 lanes, 30 workflow runs, 120 task sets, 300 Claude Desktop files: the shape of a real `~/.claude`. |
| `synthetic-10k` | The core plus 10,000 sessions over 200 project dirs with 500 lanes, 30 KB each. |

Timestamps inside files are fixed; only mtimes follow the clock (set relative
to the moment of generation), so discovery windows and tiers classify the
files the same way whenever a run happens.

### Scenarios

| Scenario | Fault | What it proves |
| --- | --- | --- |
| `baseline` | none | Two full passes, a third after a transcript grows, every CLI command, the `hx ui` API, both update paths (already current; a newer version whose bytes are identical), pairing after a disconnect |
| `claude-like`, `synthetic-10k` | none | The two larger shapes, two passes each |
| `outage` | every call answers 503 | The pass pauses after two files, heartbeats keep going, the next pass recovers byte-exact |
| `unreachable` | the gateway is not listening | Same, for a refused connection |
| `vault-held` | a vault answers held (the 200 shape) | The let.ai copy lands, the hold is recorded, `hx status` and `hx doctor` name the Fortress, `hx retry --blocked` drains it |
| `vault-503` | 503 `vault_offline` and 503 `vault_home_unreachable` | The pre-fan-out shapes: the sessions are skipped, the others upload, the holds clear |
| `tombstone` | 410 `session_deleted` | The session stops forever, the local file stays, every surface says so |
| `kill9` | SIGKILL mid-catch-up | The end state after two more passes is byte-exact (requests are not compared: which chunk was in flight is timing) |
| `readonly-state` | `~/.let/hx` is read-only | The daemon stays up and sends nothing it cannot record; writable again, it delivers everything |
| `retry-all` | an outage, then `hx retry --all` | Backoffs clear and one foreground pass runs |
| `fortress-direct` | a fortress-direct route | Session bytes go to the second gateway with the capability token; sidecars and child lanes stay on the cloud gateway |
| `paused`, `excluded` | settings | Pause/resume; the personal gate and an exclude rule |

Fault scenarios run with `tuning.uploadConcurrency: 1`, so which file hits a
fault first is not a race.

### What is compared

| Surface | Rule |
| --- | --- |
| Stored bytes | Every canonical object (parent sessions, agent lanes, per destination) and every sidecar: size and sha256, exact |
| Requests | Per step, per session: the sequence of method, path, query, headers and body (the signed PUT by size and sha256). Requests that belong to no session per endpoint. Batch endpoints (`verify`, `reattribute`, `retitle`) as sorted multisets of their items. `sync-status`: the last snapshot of a step. `heartbeat`: present or not |
| `state.json`, `activity.jsonl`, `config.json`, `settings.json`, `org-names.json` | Normalized deep equality; `activity.jsonl` as a multiset |
| CLI steps | Exit code or signal; normalized stdout and stderr (sorted lines for pooled passes) |
| `hx ui` | Every probe's status and normalized JSON |
| Fixture expectations | The uploaded group mirror equals what the leveldb encodes (macOS); Codex titles come from `state_5.sqlite`; every discovered session reached the store |
| Coverage | All 24 calls of the protocol appear in the reference recording |

Normalization (`lib/normalize.ts`) hides exactly: the candidate's name (`hx2`
→ `hx`, the one allowed difference, in output, User-Agent and asset names),
each binary's version string, run-relative timestamps (compared with a
per-scenario tolerance; the fixed content timestamps are compared exactly),
the connection probe's latency/throughput/grade, the fixture home and work
paths, local ports, pids and launch tokens.

### Goldens

`harness/golden/<Linux|macOS>/<scenario>/<step>.txt` hold normalized CLI
outputs (`hx status`, `hx doctor sync` text and `--json`, `hx connect`,
`hx update`, usage errors) written from the reference run. The candidate is
compared with them on every run, so a change in CLI output shows up even when
the differential comparison is trivially equal. To refresh them after a
deliberate change, download the `harness-differential-<os>` artifact's
`goldens/` directory and commit it.

## Running it

Every pull request runs the workflow: the reference is built from
`harness/reference.lock.json`, the candidate from the pull request, and three
jobs must pass — the candidate against itself three times (determinism), the
reference against the candidate, and the reference against three
deliberately broken candidates with `--expect fail` (a 3 MiB chunk, a dropped
trailing newline per chunk, a dropped `titleSource` in commit metadata).

To test any binary — an hx2 release asset, say — start the workflow by hand
(`Actions › Differential harness › Run workflow`) with `candidate_url_linux`
and `candidate_url_macos` pointing at the gzipped binaries and
`candidate_name: hx2`. `reference_ref` moves the reference for one run.

The entry points, for a CI job or a dedicated machine:

```
bun harness/run/run-harness.ts --reference <bin> --candidate <bin> [--candidate-name hx2] \
    [--scenarios all|a,b] [--out harness-out] [--expect pass|fail] [--goldens harness/golden/Linux]
bun harness/run/run-scenario.ts --binary <bin> --scenario baseline --out <dir>
bun harness/fixtures/gen-home.ts --out <home> --shape small --seed s
bun test harness
```

## Through the real Cloudflare edge (not done here)

The fake gateway records what the client sends; it cannot tell whether the
Cloudflare edge in front of let.ai accepts it. Cloudflare refuses some HTTP
clients by their signature (error 1010), and hx sends Bun's default
User-Agent on every gateway call, so a port must be checked against the real
edge once. That needs a throwaway test device paired to the dev environment:
`hx connect` against dev with a device named for the harness, then
`hx status` and `hx watch --once` over the real edge, kept for hx2's turn.
Pairing a device is a decision for the environment's owner; the harness does
not do it.

## Adding a scenario

Add an entry to `run/scenarios.ts`: a shape, a seed, an initial gateway
configuration, steps. Step kinds: `run` (the binary with arguments),
`gateway` / `fortress` (change faults, routes, tombstones at run time),
`gateway-stop` / `gateway-start`, `watch-kill` (SIGKILL after N composed
chunks), `ui` (start `hx ui` and probe its API), `chmod-hx-dir`, `grow`
(append to a transcript), `settings`. Placeholders `<SELF>`, `<SELF+1>`,
`<FORTRESS>` and `<SESSION:n>` resolve at run time. Nothing in a fixture may
come from a real machine: hx is a public repository.
