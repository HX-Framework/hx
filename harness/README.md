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
                  binary), run-harness.ts (reference vs candidate + report),
                  measure.ts (the design-fix numbers: rusage, strace, sampled
                  memory), watch-only.ts (a bare fs.watch, for measure.ts)
  variants/       patches that change one design choice for a measurement
                  (no-file-events: the daemon polls, as 77.11 did)
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
`hx update`, `hx connect`, `hx disconnect`, `hx ui` with its API probed, a
long-running `hx watch` killed with SIGKILL, or a long-running `hx watch` left
to run for a fixed time (a transcript may grow while it runs) and then
stopped with SIGTERM. The reference runs first, then the candidate, both
against the same home path (transcript contents embed their cwd, so the
stored bytes must match byte for byte).

### Fixture shapes

| Shape | What it holds |
| --- | --- |
| `small` | The curated core: 13 Claude Code transcripts covering every parsing quirk (a user and an AI title, a plan attachment, a cwd-change twin, a 70 MB file past the 64 MB per-pass budget, a 5 MiB single line, emoji/CJK/a lone surrogate, a message past the 4,000-unit cap, a file and a directory older than the 30-day window, an empty file), two subagent lanes with meta sidecars, a workflow run (journal + script + lane), tasks for two sessions, a team config, git repositories the cwds point at (a clone, a linked worktree, a non-GitHub remote) and an encoded `@owner@name@xxxxxx` scratch cwd; four Codex rollouts (CLI, desktop originator, archived) and a `state_5.sqlite` with a user name, an AI title and a missing row; five Claude Desktop session files and a Local Storage leveldb with a stale `.log` and an authoritative Snappy-compressed `.ldb` (two groups, assignments, unread ids, a vestigial `dframe-store`). |
| `claude-like` | The core plus 600 sessions over 150 project dirs, 60 lanes, 30 workflow runs, 120 task sets, 300 Claude Desktop files: the shape of a real `~/.claude`. |
| `synthetic-10k` | The core plus 10,000 sessions over 200 project dirs with 500 lanes, 30 KB each. |

A scenario can ask for the Claude Desktop store of current builds instead
(`fixture: { ccdLayout: "scoped" }`, used by `ccd-accounts`): the sidebar kept
per account (`customGroupsByScope`, and the drawn sections in
`codeSidebarByScope` in an order of their own), the live account named by
`lastSidebarScopeKey`, thirty signed-out accounts' groups, the newest write in
a log numbered BELOW an older table and spanning three log blocks, a flat
`frame-store` of an older build left beside it, a session the group list's
`order` still keeps in the group it was moved out of, and a stale
`collapsedGroups`. The manifest carries the expected mirror, the write that
switches to the second account (`ccdSwitch`) and the mirror after it.

Timestamps inside files are fixed; only mtimes follow the clock. They are set
relative to one moment per scenario, taken before the reference starts and
shared by both runs, so the two binaries find the same mtimes and the same
dates even when a scenario runs across midnight UTC, and discovery windows
and tiers classify the files the same way whenever a run happens. The
candidate starts a whole reference run after that moment (up to about five
minutes, for synthetic-10k), so it finds every file that much older than the
reference did: an mtime placed closer than that to an age the client tests
(5 and 15 minutes, 48 hours, a whole number of days, 30 days) can classify
differently in the two runs. Every session in a folder carries
one branch: `hx ui` shows a folder under the branch of whichever session its
stat pool returned first, an order no port can be held to.

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
| `daemon-backoff` | a held vault, every workflow upload 503, a transcript grows 12 s in | The long-running daemon for 50 s then SIGTERM: held sessions retry on their 20 s backoff, the workflow sidecar retries on its own backoff (77.12) instead of every tick, the stuck line is logged once per hold, the grown transcript uploads within the run (file events or polling, never a fresh process's first sweep), and `hx status` reads a current snapshot after the stop |
| `ccd-accounts` | the per-account Claude Desktop store; an account switch 6 s into a 15 s daemon run | The mirror is the live account's drawn groups, from the newest write wherever it sits; after the switch the second account's mirror is uploaded within 3 s (the leveldb watch: the 20 s mirror timer never fires in the run) |
| `paused`, `excluded` | settings | Pause/resume; the personal gate and an exclude rule |

Fault scenarios run with `tuning.uploadConcurrency: 1`, so which file hits a
fault first is not a race.

### What is compared

| Surface | Rule |
| --- | --- |
| Stored bytes | Every canonical object (parent sessions, agent lanes, per destination) and every sidecar: size and sha256, exact |
| Requests | Per step, per session: the sequence of method, path, query, headers and body (the signed PUT by size and sha256). Requests that belong to no session per endpoint. Batch endpoints (`verify`, `reattribute`, `retitle`) as sorted multisets of their items. `sync-status`: the last snapshot of a step. `heartbeat`: present or not. In a long-running daemon step (`watch-for`), a REFUSED workflow upload (5xx) leaves the sequence and is compared as presence per run: since 77.12 the client retries it on a backoff, so how many attempts a run has time for is timing; the first refusal is the fact |
| `state.json`, `activity.jsonl`, `config.json`, `settings.json`, `org-names.json` | Normalized deep equality; `activity.jsonl` as a multiset |
| `state.journal.jsonl` | Empty or absent at the end of every run (candidate and reference alike): the offsets journal (77.12) is folded into `state.json` at every exit that is not a kill, so the compared `state.json` is current and no reader that ignores the journal is stale |
| `ccd-index.json` | The saved Claude Desktop index (77.12), normalized, when the reference writes one; a reference that predates it says nothing about the candidate, a candidate that drops it while the reference writes it fails |
| CLI steps | Exit code or signal; normalized stdout and stderr (sorted lines for pooled passes; for a long-running daemon step the SET of distinct lines, with the per-tick `uploaded=`/`failed=` counters summed over the run and the pass-level backoff's length masked — which tick a session's retry lands in follows the clock, and the backoff doubles once per failing tick in a row) |
| `hx ui` | Every probe's status and normalized JSON |
| Fixture expectations | The uploaded group mirror equals what the leveldb encodes (macOS); with the per-account store, the second account's mirror is uploaded within 3 s of the switch (the check names the measured time); Codex titles come from `state_5.sqlite`; every discovered session reached the store |
| Coverage | All 24 calls of the protocol appear in the reference recording |

Normalization (`lib/normalize.ts`) hides exactly: the candidate's name (`hx2`
→ `hx`, the one allowed difference, in output, User-Agent and asset names),
each binary's version string, run-relative timestamps (compared with a
per-scenario tolerance; the fixed content timestamps and the fixture's
mtimes, the same instants in both runs, are compared exactly),
the connection probe's latency/throughput/grade, the fixture home and work
paths, local ports, pids and launch tokens, and the two numbers in the stuck
line (`waiting out a retry backoff for another <n> min (<n> consecutive
failures`): the countdown is measured against the moment the tick ran and the
failure count climbs with every retry a run had time for, so both follow
timing — the reason and the hold it names are the fact. Object key order is
not compared either: the client adds a top-level key to `state.json` when it
first records that kind of fact, so the order follows which session it
ingested first.

### Contracts taught for the 77.12 design fixes

Each rule above that names 77.12 was added when the fix it covers made the
harness fail against the 77.11 reference, and says what the fix changed on
purpose. Everything else the fixes touched — the offsets journal, the saved
index, file events as hints, the lane and workflow gates — left every compared
surface identical: stored bytes, request sequences, `state.json`,
`activity.jsonl`, CLI output and the `hx ui` API.

| Fix | What a server, a person or the UI can see | Rule |
| --- | --- | --- |
| Offsets journal (`state.journal.jsonl`) | Nothing: readers replay it; every exit folds it | `state.journal.jsonl` empty or absent at run end |
| Lane and workflow gates | Nothing: an unchanged lane or run made no request before either | none |
| Workflow upload backoff | Fewer refused `/sessions/workflow` attempts during an outage; a 404/401/403 now pauses the lane like the child lanes | refused workflow uploads compared as presence per run in `watch-for` steps |
| Stuck-line dedupe key | One `[stuck]` line per hold instead of one per countdown minute | daemon stdout as distinct lines; the stuck line's numbers masked |
| (not a fix) the daemon's clock | The held sessions' retries land in two ticks whose split varies run to run, so the per-tick counters and the pass-level backoff length vary with them — found by the candidate-vs-itself jobs of the first run | per-tick counters summed, backoff length masked, in daemon steps |
| Saved Claude Desktop index (`ccd-index.json`) | A new cache file in `~/.let/hx` | compared when the reference writes it |
| File events as hints | Nothing, unless watching fails: one `[hx] file events unavailable (…)` line | none (a failure to arm shows up as a diff, which is the point) |

### Contract taught for the per-account Claude Desktop reader (77.14.1, hx2 78.0.1)

Claude Desktop now keeps its sidebar per account, and the drawn sections apart
from the group list; the reader it replaced read fields current builds no
longer write. On the flat store every scenario but `ccd-accounts` uses,
nothing changed: the flat fixture is byte-identical, and so is everything
compared. On the per-account store a client that predates the reader uploads
another mirror (77.11.0 latches onto the older build's leftover `frame-store`
and uploads its stale group). hx 77.14.0 read the per-account store but sent
each group's stored sort direction, which for alphabetical sorting is the
opposite of the one Claude Desktop draws, and each group's own "show empty"
flag, which Claude Desktop never reads; the fixture holds clients to the drawn
values, so hx is held from 77.14.1. So:

| What a server, a person or the UI can see | Rule |
| --- | --- |
| The mirror is the live account's drawn groups, and follows a write within about a second | a run whose version predates the reader (hx before 77.14.1, hx2 before 78.0.1) is not held to the per-account fixture; when the reference predates it, its `/sessions/group-mirror` requests, its `[groups]` log lines and its mirror hash in `state.json` leave the comparison, and the candidate is held to the fixture instead. A reference that has the reader is compared as before |

### Goldens

`harness/golden/<Linux|macOS>/<scenario>/<step>.txt` hold normalized CLI
outputs (`hx status`, `hx doctor sync` text and `--json`, `hx connect`,
`hx update`, usage errors) written from the reference run. The candidate is
compared with them on every run, so a change in CLI output shows up even when
the differential comparison is trivially equal. JSON output is rendered from
its normalized value (keys and object lists sorted, timestamps masked), and
calendar dates are masked too, so a golden holds for months. They are kept per
OS because the fixture home's path is embedded in every transcript line, and
its length shapes the byte counts the commands print. To refresh them after a
deliberate change in CLI output or in the fixture (the byte counts the
commands print follow it), download the `harness-differential-<os>` artifact and
either commit its `goldens/` directory or write them from its reference runs:

    bun harness/run/write-goldens.ts --out harness/golden/Linux --run <artifact>/baseline/reference

## Running it

Every pull request runs the workflow: the reference is built from
`harness/reference.lock.json`, the candidate from the pull request, and three
jobs must pass — the candidate against itself three times (determinism), the
reference against the candidate, and the reference against three
deliberately broken candidates with `--expect fail` (a 3 MiB chunk, a dropped
trailing newline per chunk, a dropped `titleSource` in commit metadata).

A fourth job, `measure`, runs `harness/run/measure.ts` with both binaries
on each OS and attaches `measurements.json` and `measurements.md`: disk
writes per one-shot pass and per 45 s of daemon with a 5 MB state and growing
transcripts, file checks per second of an idle daemon under `strace -c`
(Linux, the per-syscall summaries attached as `idle-<run>-strace.txt`), its
CPU and RSS, refused workflow uploads and `[stuck]` lines in the
`daemon-backoff` run, and (macOS) the second pass over 10,000 Claude Desktop
files. Every number is the operating system's view of the process (rusage,
strace, /proc, ps); nothing is instrumented inside the binary.

The idle daemon's resident memory is also sampled once a second from outside
the process (`idle-memory` rows; `/proc/<pid>/status` and `smaps_rollup` on
Linux, `ps` on macOS): VmRSS at the end and at its highest, VmHWM, RssAnon,
RssFile, AnonHugePages, threads, inotify instances and watches, and any child
process, with every sample in `<run>-memory.jsonl`, the mappings behind the
peak in `<run>-smaps-peak.txt` and `memory.md`, and the runner's kernel,
transparent-hugepage setting and inotify limits recorded with the numbers.
On Linux the `maximum RSS` rows are the process's `VmHWM`, read from
`/proc/<pid>/status` every 50 ms while it runs: `ru_maxrss` as Bun's
`resourceUsage()` returns it there is not the child's figure (it grows with
the measuring process's own life; the `rusage-check` rows, a bare child that
touches 300 MB beside what Bun reports for it, show the gap on every run), and
the field is kilobytes on Linux and bytes on macOS besides. macOS keeps
`ru_maxrss`, which `ps` agrees with. On Linux a third binary joins the idle
measurements: the candidate built with `harness/variants/no-file-events.patch`
applied (the daemon never arms file events, so it polls as 77.11 did), in a
third column, so the memory of the recursive watch is read off the table. A
`watch-only` row runs `harness/run/watch-only.ts`, a bare Bun script holding
`fs.watch(recursive)` on the same tree for 20 s, with and without the watch:
the runtime's watcher by itself, apart from anything hx does with the events.

To test any binary — an hx2 release asset, say — start the workflow by hand
(`Actions › Differential harness › Run workflow`) with `candidate_url_linux`
and `candidate_url_macos` pointing at the gzipped binaries and
`candidate_name: hx2`. `reference_ref` moves the reference for one run.

The entry points, for a CI job or a dedicated machine:

```
bun harness/run/run-harness.ts --reference <bin> --candidate <bin> [--candidate-name hx2] \
    [--scenarios all|a,b] [--out harness-out] [--expect pass|fail] [--goldens harness/golden/Linux]
bun harness/run/run-scenario.ts --binary <bin> --scenario baseline --out <dir>
bun harness/run/measure.ts --reference <bin> --candidate <bin> --out measure-out
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
chunks), `watch-for` (run the daemon for a fixed time, optionally growing a
transcript or writing the Claude Desktop account switch part-way, then
SIGTERM), `ui` (start `hx ui` and probe its API),
`chmod-hx-dir`, `grow` (append to a transcript), `settings`. Gateway faults:
`outageStatus` (every call), `workflowStatus` (`POST /sessions/workflow`
only), `heldVaults`, `vault503`, `tombstones`, `putDelayMs`. Placeholders `<SELF>`, `<SELF+1>`,
`<FORTRESS>` and `<SESSION:n>` resolve at run time. Nothing in a fixture may
come from a real machine: hx is a public repository.
