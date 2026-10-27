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
                  measure.ts (the design-fix numbers and hx2's exit check:
                  rusage, strace, sampled memory), watch-only.ts (a bare
                  fs.watch, for measure.ts)
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
| `small` | The curated core: 13 Claude Code transcripts covering every parsing quirk (a user and an AI title, a plan attachment, a cwd-change twin, a 70 MB file past the 64 MB per-pass budget, a 5 MiB single line, emoji/CJK/a lone surrogate, a message past the 4,000-unit cap, a file and a directory older than the 30-day window, an empty file), two subagent lanes with meta sidecars, a workflow run (journal + script + lane), tasks for two sessions, a team config, git repositories the cwds point at (a clone, a linked worktree, a non-GitHub remote) and an encoded `@owner@name@xxxxxx` scratch cwd; four Codex rollouts (CLI, desktop originator, archived), a `state_5.sqlite` with a user name, an AI title and a missing row, and Codex Desktop's sidebar (a `.codex-global-state.json` with two accounts' sections; the database's sections, a pinned thread and threads the sidebar does not list; a project placed in a section; a later change to the sections); five Claude Desktop session files and a Local Storage leveldb with a stale `.log` and an authoritative Snappy-compressed `.ldb` (two groups, assignments, unread ids, a vestigial `dframe-store`). |
| `claude-like` | The core plus 600 sessions over 150 project dirs, 60 lanes, 30 workflow runs, 120 task sets, 300 Claude Desktop files: the shape of a real `~/.claude`. |
| `synthetic-10k` | The core plus 10,000 sessions over 200 project dirs with 500 lanes, 30 KB each. |
| `hot-small`, `hot-claude-like`, `hot-10k` | The hot-path shapes: the same Claude Code parent transcripts and git repositories, nothing else (see The hot-path surface below). |
| `founder` | The measurement tree: the hot core plus 4,800 transcripts over 700 project dirs and 36,000 Claude Desktop session files. |

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

Timestamps inside files are fixed; only mtimes follow the clock, apart from
the Claude Desktop store's, which are fixed too (`ccd-index.json` below). The
others are set relative to one moment per scenario, taken before the
reference starts and shared by both runs, so the two binaries find the same
mtimes and the same dates even when a scenario runs across midnight UTC, and
discovery windows and tiers classify the files the same way whenever a run
happens. The candidate starts a whole reference run after that moment (up to
about five minutes, for synthetic-10k), so it finds every file that much
older than the reference did: an mtime placed closer than that to an age the
client tests (5 and 15 minutes, 48 hours, a whole number of days, 30 days)
can classify differently in the two runs. Every session in a folder carries
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
| `codex-sections` | Codex Desktop's sidebar; a transcript grows before the daemon run, so its first pass has an upload; a change to the sidebar 5 s into a 12 s daemon run, written the way Codex writes it (a temp file renamed over the old one) | The group mirror carries Codex's sections as `codex`; after the change the changed sections are uploaded within 3 s (the watch on the Codex home: the 20 s mirror timer never fires in the run) |
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
| `ccd-index.json` | The saved Claude Desktop index (77.12), when the reference writes one; a reference that predates it says nothing about the candidate, a candidate that drops it while the reference writes it fails. Compared twice: normalized, and byte for byte per entry (`ccd-index.json bytes`): each file is exactly what `JSON.stringify` writes for its own content, the top-level keys come in the same order, and every `dirs` and `files` entry is byte-identical to the reference's for the same path. Not compared: `savedAtMs` (the save's clock) and the order of the `files` entries, which the reference writes in the order its 32 parallel stat-and-read workers complete, so two reference runs on one tree differ there. The fixture gives the Claude Desktop store fixed mtimes with sub-millisecond fractions (`ccdMtimeSec` in `fixtures/gen-home.ts`), so both runs stat the same stamps |
| CLI steps | Exit code or signal; normalized stdout and stderr (sorted lines for pooled passes; for a long-running daemon step the SET of distinct lines, with the per-tick `uploaded=`/`failed=` counters summed over the run and the pass-level backoff's length masked — which tick a session's retry lands in follows the clock, and the backoff doubles once per failing tick in a row) |
| `hx ui` | Every probe's status and normalized JSON |
| Fixture expectations | The uploaded group mirror equals what the leveldb encodes (macOS); with the per-account store, the second account's mirror is uploaded within 3 s of the switch (the check names the measured time); Codex titles come from `state_5.sqlite`; the mirror's `codex` equals the signed-in account's saved sidebar on every platform, and after a change the changed sections are uploaded within 3 s (hx from 77.15.0, hx2 from 78.0.2); every discovered session reached the store |
| Coverage | All 24 calls of the protocol appear in the reference recording |

Normalization (`lib/normalize.ts`) hides exactly: the candidate's name (`hx2`
→ `hx`, the one allowed difference, in output and asset names; for hx2 the
`user-agent` header too — hx2 names itself `hx2/<version>` where the
TypeScript client sends its runtime's default, decided 10-16, and a separate
check, `hx2 user-agent`, asserts that every request hx2 makes carries it),
each binary's version string, run-relative timestamps (compared with a
per-scenario tolerance; the fixed content timestamps and the fixture's
mtimes, the same instants in both runs, are compared exactly),
the connection probe's latency/throughput/grade, the fixture home and work
paths, local ports, pids and launch tokens, and the two numbers in the stuck
line (`waiting out a retry backoff for another <n> min (<n> consecutive
failures`): the countdown is measured against the moment the tick ran and the
failure count climbs with every retry a run had time for, so both follow
timing — the reason and the hold it names are the fact. The Codex title
sweep's version is masked too, in its log line (`[retitle] v<n>:`) and in the
`titleSyncVersion` stamp `state.json` keeps per file: hx 77.16.1 and hx2
78.0.6 raised it to sweep once more, and a fresh home sweeps every file under
any version, so the counts and the stamp's presence are the fact. Object key order is
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
| Saved Claude Desktop index (`ccd-index.json`) | A new cache file in `~/.let/hx` | compared when the reference writes it, normalized and byte for byte per entry |
| File events as hints | Nothing, unless watching fails: one `[hx] file events unavailable (…)` line | none (a failure to arm shows up as a diff, which is the point) |

### The hot-path surface (hx2, M3)

The Rust port (`hx2/`, built from the `hx-2.0` branch) starts with the hot
path: Claude Code transcripts through discovery (the 30-day window, newest
file wins per session), the tiered catalog with file events as hints and the
60 s safety sweep, chunking (4 MiB, cut at the last newline or the whole
window when it has none, the 64 MiB per-pass budget), the 3-step upload with
the same bodies, headers and `byteCount` semantics, and the state files
(`state.json` + the offsets journal with 77.12's checkpoint rules). Seven
scenarios exercise exactly that surface, on three fixture shapes that hold
parent transcripts only (no Codex rollouts, no Claude Desktop store, no child
lanes, no sidecars), with the steps hx2 answers:

| Scenario | Shape | What it proves |
| --- | --- | --- |
| `hot-baseline` | `hot-small` | Two full passes (the 70 MB file needs both), a third after a transcript grows; `--version`, `help` and the usage error |
| `hot-claude-like`, `hot-10k` | `hot-claude-like`, `hot-10k` | 600 and 10,000 parent transcripts, two passes each |
| `hot-outage`, `hot-unreachable` | `hot-small` | A 503 outage and a refused connection during the first pass; the second recovers byte-exact |
| `hot-kill9` | `hot-small` | SIGKILL mid-catch-up, then two one-shot passes: the end state is byte-exact |
| `hot-daemon` | `hot-small` | The long-running daemon for 50 s with a held vault and a transcript growing 12 s in: the 20 s hold retries, one stuck line per hold, file events, SIGTERM folds the journal |

`--scenarios hot-path` selects them. Every comparison above applies to them
unchanged; hx2 is passed as `--candidate-name hx2`, so its name is a
normalization rule and not a diff. A fourth shape, `founder`, is the
measurement tree: 4,800 transcripts over 700 project directories and 36,000
Claude Desktop session files, the size of the founder's laptop
(`measure.ts --only founder`).

The hot shapes have jobs of their own for the TypeScript binaries too
(`self-hot`, `differential-hot`): on Linux the runner shut the combined jobs
down 16 to 21 minutes in, during or after `hot-10k` ("The runner has
received a shutdown signal"), so the hot jobs run apart from the rest
(`--scenarios main` is every scenario but the hot ones) and sample the
machine's memory every 10 s into the step log and `harness-out/memory.log`.

### The daemon surface (hx2, M4)

After M4 hx2 carries the rest of the daemon: Codex rollouts and their
SQLite titles, the Claude Desktop session-metadata index (saved as
`ccd-index.json`) and the leveldb scan behind the group mirror, child lanes
and workflow sidecars, tasks and plans, verify and self-heal, reattribute
and the codex title sweep, the ledger and `hx status` / `hx status
--detailed` / `hx doctor sync`, `hx tick`, `hx backfill`, `hx reattribute`,
`hx retry` and the `--local` tee. The hx ui API, `hx update`, `hx connect`,
`hx disconnect` and the service commands came with M5 (below).

`--scenarios daemon` runs the full catalog with exactly those steps removed
(the `ui` steps and the `run` steps of `update`, `connect` and `disconnect`),
on both binaries alike, and drops the goldens of the removed steps. The
coverage check then requires every protocol call but the four only those
steps make (`devices/code`, `devices/poll`, `devices/disconnect`, the
`/download/…` pair). Until M5 the hx2 jobs ran `--scenarios daemon-main`
(the daemon surface without the hot-path shapes) and `--scenarios hot-path`,
all four sampling the runner's memory; `hx2-measure` runs `--only
founder,idle,idle-hot,ccd-index`.

The split is there because the driver is one bun process hosting the fake
gateway, and on a 16 GB Linux runner it was the process that ran out of room:
the TypeScript all-scenario jobs ended in "The runner has received a shutdown
signal" 16 to 21 minutes in, during or after `hot-10k`, and the first hx2
all-scenario job two minutes into `hot-10k` after fifteen scenarios in the
same process. The driver now streams the recording to disk instead of
holding every request (`FakeGateway.record` stays in memory only without a
`recordPath`), stages a PUT's bytes without copying them, and collects
garbage between the runs of a scenario; `memory.log` in each job's artifact
shows what that leaves.

### The whole client (hx2, M5)

After M5 hx2 carries every command: `hx connect` (the device-code flow and
the `--local` tee), `hx disconnect`, the service (`start`, `stop`,
`restart`, `logs`, `uninstall`), `hx update` from its own channel (the
`hx2-*` assets), and `hx ui` with the React app embedded as built. The hx2
jobs run `--scenarios main`, the same list as the TypeScript jobs, so the
`ui` probes, both update paths, the pairing after a disconnect and every
golden compare identical, and coverage requires all 24 protocol calls. The
`daemon` selections stay for a candidate that predates M5.

The service definitions never run in the harness, so the unit-test job
(`hx2-test`) checks them apart: `harness/run/service-defs.ts` renders the TypeScript client's
plist, systemd unit, container bootstrap and Task Scheduler XML for a fixed
binary path, and hx2's unit tests compare their own renderings with those
files byte for byte (and with the client's snapshot file). One service slot
(`ai.let.hx-vision`) is shared by hx and hx2, so the files may differ in the
binary's path alone.

`hx2-switch` runs the service for real: `harness/run/switch.ts` moves a
device's slot between hx and hx2 through launchd (macOS), systemd and the
container shell hook (Linux), against a recording fake gateway. `hx start`
uploads the `small` fixture; `hx2 connect` (the saved login, no pairing)
moves the device to hx2; hx takes it back (`hx restart` up to 77.12,
`hx start` from 77.13.0 on); `hx2 start` takes it again; hx takes it back
again; a transcript grows after every switch. It checks that every fixture
session is stored whole (before the first switch too, so no upload is in
flight when the slot moves); that after each switch every object got exactly
the bytes it was missing (the bytes PUT equal how much the store grew, and
no commit replaced an object the store already held); that each grown
transcript is stored byte for byte and went up through the client that held
the slot; that the daemon traffic is one stretch per phase in order (by
User-Agent) and each phase ends with exactly one `watch` process, the right
client's; and that `status` names the expected manager. Last, with hx in the
slot, `hx2 status`, `hx2 restart`, `hx2 update` and `hx2 stop` must leave
the slot with hx and say so, hx's daemon process unchanged. The same job then
runs `harness/run/service-commands.ts`: each client in turn runs `start`,
`status`, `restart`, `stop` (twice), `start`, `logs` (ended with SIGINT) and
`uninstall` through the same manager from the same starting state, and every
step's exit code, normalized output and number of `watch` processes must be
identical (`status` on its Daemon row). launchd and systemd run the service
with the user's own HOME, so on the runner the fixture is linked into it
(`~/.claude`, `~/.codex`, Claude Desktop's folder), and both scripts refuse
to run outside CI or over an existing path (`harness/run/service-home.ts`).

`measure.ts` reports the macOS daemon's `phys_footprint` beside its `ps` RSS
(`harness/run/phys-footprint.c`, compiled once per run with `cc`): RSS counts
pages the allocator has handed back through `malloc_zone_pressure_relief`,
the footprint does not.

### Contract taught for the per-account Claude Desktop reader (77.15.1, hx2 78.0.3)

Claude Desktop now keeps its sidebar per account, and the drawn sections apart
from the group list; the reader it replaced read fields current builds no
longer write. On the flat store every scenario but `ccd-accounts` uses,
nothing changed: the flat fixture is byte-identical, and so is everything
compared. On the per-account store a client that predates the reader uploads
another mirror (77.11.0 latches onto the older build's leftover `frame-store`
and uploads its stale group). hx 77.14.0 and 77.15.0 (hx2 78.0.1 and 78.0.2)
read the per-account store but sent each group's stored sort direction, which
for alphabetical sorting is the opposite of the one Claude Desktop draws, and
each group's own "show empty" flag, which Claude Desktop never reads; the
fixture holds clients to the drawn values, so hx is held from 77.15.1 and hx2
from 78.0.3. So:

| What a server, a person or the UI can see | Rule |
| --- | --- |
| The mirror is the live account's drawn groups, and follows a write within about a second | a run whose version predates the reader (hx before 77.15.1, hx2 before 78.0.3) is not held to the per-account fixture; when the reference predates it, its `/sessions/group-mirror` requests, its `[groups]` log lines and its mirror hash in `state.json` leave the comparison, and the candidate is held to the fixture instead. A reference that has the reader is compared as before |

### Contract taught for Codex sections in the mirror (77.15.0, hx2 78.0.2)

The group mirror carries Codex Desktop's sidebar sections as `codex`
(`src/codex-sections.ts`): left out when the Codex read fails, null when the
home holds no Codex state. A client that predates it sends no `codex`, makes
no upload when only Codex changed, logs a `[groups]` line without the Codex
count and keeps another mirror hash, so:

| What a server, a person or the UI can see | Rule |
| --- | --- |
| The mirror carries Codex's sections, and follows a change to them within about a second | a run whose version predates them (hx before 77.15.0, hx2 before 78.0.2) is not held to the Codex fixture; when the reference predates them, its `/sessions/group-mirror` requests, the stored mirror, its `[groups]` log lines and its mirror hash in `state.json` leave the comparison (the same rule as the per-account reader's), and the candidate is held to the fixture instead. A reference that sends `codex` is compared in full |

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
files, with the two saved indexes compared byte for byte per entry. A second
pass (here and on the founder tree) runs five times and each of its figures is
the median of the five, because one run's wall time on a shared macOS runner
moved by a factor of two between runs of the same binaries. Every
number is the operating system's view of the process (rusage, strace, /proc,
ps); nothing is instrumented inside the binary.

The `strace -c` window holds the daemon's start-up pass as well as its idle
time, and it counts calls without their paths. So on Linux a second daemon is
traced for 45 s with every stat-family, `readlink` and `openat` call's path
(`harness/lib/stat-trace.ts`; an open says which file a stat of a descriptor
was for, and a directory's open is counted apart as a directory read): the
calls are counted by syscall and path
pattern, the first 15 s apart from the rest, into
`<run>-<who>-stat-paths.txt`, and the table gets the idle rates after the
start-up pass.

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
