// The scenario catalog: every input and every fault the harness runs both
// binaries through.
//
// A scenario is a fixture shape, an initial gateway configuration and an
// ordered list of steps. The driver (run-scenario.ts) executes it once per
// binary, against a fresh fixture home and a fresh gateway, and the
// comparators (compare.ts) diff the two runs.
//
// Placeholders the driver resolves at run time:
//   "<SELF>"      the binary under test (served as the release asset)
//   "<SELF+1>"    the binary's version with the patch number bumped
//   "<FORTRESS>"  the fortress gateway's URL
//   "<SESSION:n>" "<family>:<sessionId>" of the fixture manifest's nth session

import type { HeldVault } from "../gateway/gateway.js";
import type { Scenario } from "../lib/types.js";

const SERIAL = { tuning: { uploadConcurrency: 1, childConcurrency: 1 } };

const ACME_HELD: HeldVault = {
  reason: "vault_offline",
  orgName: "Acme",
  orgSlug: "acme",
  projectId: "proj_acme",
  projectName: "Acme Platform",
  projectSlug: "platform",
  repoSlug: "acme/repo",
  lastSeenAt: "2026-01-20T08:00:00.000Z",
};

const once = (name: string): Scenario["steps"][number] => ({ kind: "run", name, args: ["watch", "--once"], sortLines: true, expectExit: 0 });
const status = (name: string): Scenario["steps"][number] => ({ kind: "run", name, args: ["status"], expectExit: 0 });

export const SCENARIOS: Scenario[] = [
  {
    name: "baseline",
    description:
      "The curated home: two full passes (the 70 MB file needs both), a third after a transcript grows, every CLI command, the hx ui API, the update channel and the pairing flow.",
    shape: "small",
    seed: "baseline",
    steps: [
      { kind: "run", name: "version", args: ["--version"], expectExit: 0 },
      { kind: "run", name: "help", args: ["help"], expectExit: 0 },
      once("watch1"),
      status("status1"),
      { kind: "run", name: "doctor-text", args: ["doctor", "sync"] },
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
      once("watch2"),
      status("status2"),
      { kind: "grow", name: "grow", sessionIndex: 0, bytes: 3000 },
      once("watch3"),
      { kind: "run", name: "status-detailed", args: ["status", "--detailed"] },
      { kind: "ui", name: "ui", port: 48700 },
      { kind: "run", name: "tick", args: ["tick"], sortLines: true, expectExit: 0 },
      { kind: "run", name: "backfill", args: ["backfill"], sortLines: true, expectExit: 0 },
      { kind: "run", name: "reattribute", args: ["reattribute", "--force"], expectExit: 0 },
      { kind: "run", name: "update-same", args: ["update"], expectExit: 0 },
      { kind: "gateway", name: "gateway-newer", patch: { version: "<SELF+1>", releaseBinary: "<SELF>" } },
      { kind: "run", name: "update-download", args: ["update"], expectExit: 0, timeoutMs: 300_000 },
      { kind: "run", name: "connect-already", args: ["connect", "--no-start"], expectExit: 0 },
      { kind: "run", name: "disconnect", args: ["disconnect"], expectExit: 0 },
      { kind: "run", name: "connect-pair", args: ["connect", "--no-start", "--device-name", "harness-device"], expectExit: 0 },
      status("status3"),
      { kind: "run", name: "retry-none", args: ["retry", "--blocked"], expectExit: 0 },
      { kind: "run", name: "doctor-usage", args: ["doctor"], expectExit: 64 },
      { kind: "run", name: "unknown-command", args: ["no-such-command"], expectExit: 64 },
      { kind: "run", name: "tick-not-connected", args: ["tick"], env: { HOME: "<EMPTY-HOME>" }, expectExit: 2 },
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
    goldens: ["version", "help", "status1", "doctor-text", "doctor-json", "update-same", "update-download", "connect-already", "connect-pair", "retry-none", "doctor-usage", "unknown-command", "tick-not-connected"],
  },
  {
    name: "claude-like",
    description: "A tree shaped like a real ~/.claude: 600 sessions over 150 project dirs, 60 lanes, 30 workflow runs, 300 Claude Desktop files.",
    shape: "claude-like",
    seed: "claude-like",
    steps: [once("watch1"), status("status1"), once("watch2"), { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] }],
    compare: { requests: "per-session", tsToleranceMs: 60_000 },
  },
  {
    name: "synthetic-10k",
    description: "10,000 sessions over 200 project dirs with 500 subagent lanes, 30 KB each.",
    shape: "synthetic-10k",
    seed: "synthetic-10k",
    steps: [once("watch1"), status("status1"), once("watch2")],
    compare: { requests: "per-session", tsToleranceMs: 180_000 },
  },
  {
    name: "outage",
    description: "Every gateway call answers 503 during the first pass; the second pass recovers byte-exact.",
    shape: "small",
    seed: "outage",
    settings: SERIAL,
    gateway: { outageStatus: 503 },
    steps: [
      once("watch1"),
      status("status1"),
      { kind: "gateway", name: "gateway-healthy", patch: { outageStatus: 0 } },
      once("watch2"),
      status("status2"),
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "unreachable",
    description: "The gateway is not listening during the first pass (connection refused); the second pass recovers.",
    shape: "small",
    seed: "unreachable",
    settings: SERIAL,
    steps: [
      { kind: "gateway-stop", name: "gateway-stop" },
      once("watch1"),
      status("status1"),
      { kind: "gateway-start", name: "gateway-start" },
      once("watch2"),
      status("status2"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "vault-held",
    description: "acme/repo fans out to a vault the gateway reports as held (the 200 shape); the let.ai copy lands, the hold is recorded, hx retry --blocked drains it once the vault is back.",
    shape: "small",
    seed: "vault-held",
    settings: SERIAL,
    gateway: { routes: { "acme/repo": { vaultOrgIds: ["org-acme"] } }, heldVaults: { "org-acme": ACME_HELD } },
    steps: [
      once("watch1"),
      status("status1"),
      { kind: "run", name: "doctor-text", args: ["doctor", "sync"] },
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
      { kind: "gateway", name: "vault-back", patch: { heldVaults: {} } },
      { kind: "run", name: "retry-blocked", args: ["retry", "--blocked"], sortLines: true, expectExit: 0 },
      status("status2"),
      once("watch2"),
      { kind: "run", name: "status-detailed", args: ["status", "--detailed"] },
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "vault-503",
    description: "append-url answers 503 vault_offline for acme/repo and 503 vault_home_unreachable for acme/encoded; other sessions upload; the holds clear with hx retry --blocked.",
    shape: "small",
    seed: "vault-503",
    settings: SERIAL,
    gateway: {
      routes: { "acme/repo": { vaultOrgIds: ["org-acme"] }, "acme/encoded": { vaultOrgIds: ["org-enc"] } },
      vault503: {
        "acme/repo": { vaultOrgId: "org-acme", held: ACME_HELD },
        "acme/encoded": { vaultOrgId: "org-enc", held: { ...ACME_HELD, reason: "vault_home_unreachable", orgName: "Encoded Org", orgSlug: "enc", repoSlug: "acme/encoded" } },
      },
    },
    steps: [
      once("watch1"),
      status("status1"),
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
      { kind: "gateway", name: "vaults-back", patch: { vault503: {} } },
      { kind: "run", name: "retry-blocked", args: ["retry", "--blocked"], sortLines: true, expectExit: 0 },
      once("watch2"),
      status("status2"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "tombstone",
    description: "The server has permanently deleted the first fixture session (410 session_deleted): it stops forever, the local file stays, every surface says so.",
    shape: "small",
    seed: "tombstone",
    settings: SERIAL,
    gateway: { tombstones: ["<SESSION:0>"] },
    storeComplete: false,
    steps: [
      once("watch1"),
      status("status1"),
      once("watch2"),
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
      { kind: "ui", name: "ui", port: 48700 },
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "kill9",
    description: "SIGKILL the long-running daemon in the middle of its first catch-up (after 10 composed chunks, each PUT slowed to 200 ms), then finish with two one-shot passes: the end state must be byte-exact.",
    shape: "small",
    seed: "kill9",
    steps: [
      { kind: "watch-kill", name: "watch-killed", killAfterCommits: 10, putDelayMs: 200 },
      once("watch1"),
      once("watch2"),
      // A session killed between its commit and its sidecar sync keeps its
      // tasks and plan unsent until it grows; hx backfill is the way back.
      { kind: "run", name: "backfill", args: ["backfill"], sortLines: true, expectExit: 0 },
      status("status1"),
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
    ],
    compare: { requests: "end-state", tsToleranceMs: 60_000 },
  },
  {
    name: "readonly-state",
    description: "~/.let/hx is read-only during the first pass: the daemon stays up and sends nothing it cannot record; the second pass, writable again, delivers everything.",
    shape: "small",
    seed: "readonly-state",
    settings: SERIAL,
    steps: [
      { kind: "chmod-hx-dir", name: "state-readonly", mode: 0o555 },
      once("watch1"),
      // status caches the whoami email in config.json, which it cannot write.
      { kind: "run", name: "status1", args: ["status"], expectExit: 1 },
      { kind: "chmod-hx-dir", name: "state-writable", mode: 0o700 },
      once("watch2"),
      status("status2"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "retry-all",
    description: "An outage leaves every file in a retry backoff; hx retry --all clears the backoffs and runs one foreground pass.",
    shape: "small",
    seed: "retry-all",
    settings: SERIAL,
    gateway: { outageStatus: 503 },
    steps: [
      once("watch1"),
      { kind: "gateway", name: "gateway-healthy", patch: { outageStatus: 0 } },
      { kind: "run", name: "retry-all", args: ["retry", "--all"], sortLines: true, expectExit: 0 },
      status("status1"),
      once("watch2"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "fortress-direct",
    description: "acme/repo routes fortress-direct: session bytes go to a second gateway with a capability token; sidecars and child lanes stay on the cloud gateway.",
    shape: "small",
    seed: "fortress-direct",
    settings: SERIAL,
    fortress: { accessToken: "fortress-cap-token", label: "fortress" },
    gateway: { routes: { "acme/repo": { fortress: { gatewayUrl: "<FORTRESS>", token: "fortress-cap-token" }, attributedOrgIds: ["org-fortress"] } } },
    steps: [once("watch1"), status("status1"), once("watch2"), { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] }],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "daemon-backoff",
    description:
      "The long-running daemon for 50 s: acme/repo fans out to a held vault, every workflow upload answers 503, and a transcript grows 12 s in. Held sessions retry on their 20 s backoff; the workflow sidecar retries on its own backoff (77.12) rather than every tick; the stuck line is logged once per hold, not once per countdown minute; the grown transcript uploads within the run, found by file events or the polling tick, never by a fresh process's first sweep. SIGTERM ends it; the snapshot must be current when `hx status` reads it.",
    shape: "small",
    seed: "daemon-backoff",
    settings: SERIAL,
    gateway: { routes: { "acme/repo": { vaultOrgIds: ["org-acme"] } }, heldVaults: { "org-acme": ACME_HELD }, workflowStatus: 503 },
    steps: [
      // sessionIndex 2 is the no-repo session (~/scratch/notes): not held, so
      // its growth uploads at once.
      { kind: "watch-for", name: "daemon", durationMs: 50_000, grow: { atMs: 12_000, sessionIndex: 2, bytes: 3000 } },
      status("status1"),
      { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] },
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "ccd-accounts",
    description:
      "The Claude Desktop store of current builds: the sidebar kept per account, the drawn sections in an order of their own, the newest write in a log numbered below an older table and spanning three log blocks, a flat key of an older build left beside it. Two one-shot passes upload everything and a transcript grows; then the daemon runs 15 s, and 6 s in Claude Desktop switches accounts (one more write to its log). The mirror follows from the leveldb watch within about a second; the 20 s mirror timer never fires in the run. (The grown transcript gives the daemon's first pass an upload, which counts as contact, so no run sends the start-up heartbeat; with nothing to upload, whether it goes out races the reply to the progress report.)",
    shape: "small",
    seed: "ccd-accounts",
    fixture: { ccdLayout: "scoped" },
    steps: [
      once("watch1"),
      once("watch2"),
      { kind: "grow", name: "grow", sessionIndex: 2, bytes: 3000 },
      { kind: "watch-for", name: "daemon", durationMs: 15_000, ccdSwitch: { atMs: 6_000 } },
      status("status1"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "paused",
    description: "settings.json pauses sync: the first pass uploads nothing and says so; resumed, the second pass uploads everything.",
    shape: "small",
    seed: "paused",
    settings: { ...SERIAL, pause: { untilMs: null } },
    steps: [
      once("watch1"),
      status("status1"),
      { kind: "settings", name: "resume", patch: { pause: null } },
      once("watch2"),
      status("status2"),
    ],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
  {
    name: "excluded",
    description: "personalSync off and an exclude rule for ~/scratch: sessions with no repo stay on the machine, the excluded folder too; doctor lists why.",
    shape: "small",
    seed: "excluded",
    settings: { ...SERIAL, personalSync: false, excludeRules: ["~/scratch"] },
    gateway: { routes: { "acme/repo": { attributedOrgIds: ["org-acme"] } } },
    storeComplete: false,
    steps: [once("watch1"), { kind: "run", name: "doctor-json", args: ["doctor", "sync", "--json"] }, status("status1"), once("watch2")],
    compare: { requests: "per-session", tsToleranceMs: 20_000 },
  },
];

export function scenarioByName(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario: ${name} (known: ${SCENARIOS.map((x) => x.name).join(", ")})`);
  return s;
}

export function selectScenarios(spec: string | undefined): Scenario[] {
  if (!spec || spec === "all") return SCENARIOS;
  return spec.split(",").map((n) => scenarioByName(n.trim()));
}
