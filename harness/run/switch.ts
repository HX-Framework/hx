// Moving a device between hx and hx2 through a real service manager: the exit
// check of the HX2 program's "Build hx2" step — hx → hx2 → hx loses nothing
// and uploads nothing twice.
//
// hx and hx2 share one service slot (`ai.let.hx-vision`) and the files in
// ~/.let/hx, so a device runs one of the two, and either one carries on from
// the offsets the other left. This script runs the background service the way
// a device does, through launchd, systemd or the container shell hook, against
// a recording fake gateway, and moves the slot four times:
//
//   1. `hx start`      hx takes the slot and uploads the fixture home;
//   2. `hx2 connect`   the way a device joins hx2: the saved login, no new
//                      pairing, and the slot moves; a transcript grows; hx2
//                      uploads it;
//   3. hx takes the slot back (`hx restart`, or `hx start` from 77.13.0 on,
//      the release whose other commands leave hx2's slot alone); another
//      transcript grows; hx uploads it;
//   4. `hx2 start`     the switch command; a transcript grows; hx2 uploads it;
//   5. hx takes the slot back again; a transcript grows; hx uploads it;
//   6. with hx holding the slot, `hx2 status`, `hx2 restart`, `hx2 update`
//      (a newer hx2 on the channel) and `hx2 stop` leave it with hx and say
//      so, the mirror of 77.13.0: only `hx2 start` and `hx2 connect` move a
//      device to hx2.
//
// The checks, from the gateway's recording and store:
//   • every fixture session is in the store;
//   • after every switch, every object got exactly the bytes it was missing:
//     the bytes PUT equal how much the store grew, and no commit replaced an
//     object the store already held (a client that lost the other's offsets
//     re-sends from zero);
//   • each grown transcript is stored whole, byte for byte, and went up
//     through the phase's client;
//   • the daemon traffic (uploads, routes, heartbeats, progress reports) is
//     one stretch per phase in the phases' order (hx2 names itself in its
//     User-Agent, hx sends Bun's), and each phase ends with one daemon
//     process, the phase's client's: the two never ran at once;
//   • `status` of the phase's client says the service runs under the
//     expected manager, and `hx2 connect` made no pairing request;
//   • in phase 6, hx's daemon process runs on untouched through hx2's
//     status, restart and update, and hx2 prints what hx 77.13.0 prints
//     for the mirrored case, with the names swapped.
//
//   bun harness/run/switch.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>
//
// Where the fixture lives for each manager, and why launchd and systemd run
// on CI runners only: harness/run/service-home.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";

import { FakeGateway, type RecordedRequest } from "../gateway/gateway.js";
import { appendTranscriptLines, CLOUD_PORT } from "./run-scenario.js";
import { type Client, killWatchProcesses, type Manager, MANAGER_NAME, MANAGERS, prepareServiceHome, run, type Spawned, versionOf, watchProcesses } from "./service-home.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hxArg = arg("hx");
const hx2Arg = arg("hx2");
const manager = arg("manager") as Manager | undefined;
const out = arg("out");
const work = arg("work");
if (!hxArg || !hx2Arg || !out || !work || !manager || !MANAGERS.includes(manager)) {
  console.error("usage: switch.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>");
  process.exit(64);
}
const bins: Record<Client, string> = { hx: resolve(hxArg), hx2: resolve(hx2Arg) };

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clientOfUserAgent(ua: string | undefined): Client | "other" {
  if (ua?.startsWith("hx2/")) return "hx2";
  if (ua?.startsWith("Bun/")) return "hx";
  return "other";
}

// ── The home ────────────────────────────────────────────────────────────────

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const svc = prepareServiceHome({ manager, work, name: "switch-home", shape: "small", seed: "switch" });
const { home, manifest, env } = svc;
const cloud = new FakeGateway({ version: "0.0.0", recordPath: join(out, "gateway.jsonl"), label: "cloud" });
const gatewayUrl = cloud.start(CLOUD_PORT);
svc.connect(cloud, gatewayUrl);

function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const versions: Record<Client, string> = { hx: await versionOf(bins.hx, env), hx2: await versionOf(bins.hx2, env) };
const wayBack = atLeast(versions.hx, "77.13.0") ? "start" : "restart";
log(`hx ${versions.hx} (${bins.hx}), hx2 ${versions.hx2} (${bins.hx2}); ${manager}; home ${home}`);

// ── Waiting on the store ────────────────────────────────────────────────────

function storedKey(index: number): string {
  const s = manifest.sessions[index]!;
  return `${s.family}:${s.sessionId}:letai`;
}

function missingSessions(): string[] {
  const keys = Object.keys(cloud.manifest());
  return manifest.sessions.filter((s) => !keys.some((k) => k.startsWith(`${s.family}:${s.sessionId}:`))).map((s) => `${s.family}:${s.sessionId}`);
}

/** Every fixture session stored, and no commit for `quietMs`. */
async function waitSynced(timeoutMs = 300_000, quietMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCommits = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const commits = cloud.stats().commits;
    if (commits !== lastCommits) {
      lastCommits = commits;
      quietSince = Date.now();
    }
    if (missingSessions().length === 0 && Date.now() - quietSince >= quietMs) return;
    await sleep(500);
  }
  throw new Error(`the fixture home was not in the store after ${timeoutMs / 1000} s: missing ${missingSessions().join(", ")}`);
}

/** The grown transcript stored at its full size on disk. */
async function waitStoredWhole(index: number, timeoutMs = 180_000): Promise<void> {
  const s = manifest.sessions[index]!;
  const want = readFileSync(s.path).length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((cloud.manifest()[storedKey(index)]?.bytes ?? 0) === want) return;
    await sleep(500);
  }
  throw new Error(`${storedKey(index)}: ${cloud.manifest()[storedKey(index)]?.bytes ?? 0} of ${want} bytes stored after ${timeoutMs / 1000} s`);
}

// ── The phases ──────────────────────────────────────────────────────────────

type StoreManifest = Record<string, { bytes: number; sha256: string; components?: number }>;
interface Phase {
  name: string;
  client: Client;
  command: string[];
  grows: number | null;
  /** The first request of the phase (its command's), and one past its last. */
  seqFrom: number;
  seqTo: number;
  storedBefore: StoreManifest;
  storedAfter: StoreManifest;
  output: Spawned;
  status: Spawned | null;
  processes: Record<Client, number[]>;
  grownSha: string | null;
  errors: string[];
}
const phases: Phase[] = [];

async function phase(name: string, client: Client, command: string[], grows: number | null, wait: () => Promise<void>): Promise<void> {
  const p: Phase = {
    name,
    client,
    command,
    grows,
    seqFrom: cloud.requestCount + 1,
    seqTo: 0,
    storedBefore: cloud.manifest(),
    storedAfter: {},
    output: { code: null, stdout: "", stderr: "" },
    status: null,
    processes: { hx: [], hx2: [] },
    grownSha: null,
    errors: [],
  };
  phases.push(p);
  p.output = await run([bins[client], ...command], env);
  log(`── ${name}: ${client} ${command.join(" ")} → exit ${p.output.code}\n${p.output.stdout.trimEnd()}${p.output.stderr.trim() ? `\n${p.output.stderr.trimEnd()}` : ""}`);
  if (p.output.code !== 0) p.errors.push(`\`${client} ${command.join(" ")}\` exited ${p.output.code}`);
  try {
    // The transcript grows once the switch is done, so the new client is the
    // one that has to carry on from the stored offset.
    if (grows !== null) {
      const s = manifest.sessions[grows]!;
      appendTranscriptLines(s.path, s.sessionId, 40_000, `switch:${name}`);
      p.grownSha = sha256File(s.path);
    }
    await wait();
  } catch (err) {
    p.errors.push((err as Error).message);
  }
  // The last tick's progress report and heartbeat land inside the phase.
  await sleep(3_000);
  p.status = await run([bins[client], "status"], env);
  log(p.status.stdout.trimEnd());
  p.processes = await watchProcesses();
  p.storedAfter = cloud.manifest();
  p.seqTo = cloud.requestCount + 1;
}

// Phase 6: with hx holding the slot, hx2's other service commands leave it
// there and say so — the mirror of what hx 77.13.0 does for a slot that runs
// hx2. Only `hx2 start` (and `hx2 connect`, how a device joins hx2) moves it.
interface Probe {
  command: string;
  output: Spawned;
}
const LEAVE_ALONE = "6 · hx2 leaves hx's slot alone";
const leaveAlone = { ran: false, seqFrom: 0, seqTo: 0, before: { hx: [], hx2: [] } as Record<Client, number[]>, after: { hx: [], hx2: [] } as Record<Client, number[]>, probes: [] as Probe[] };

async function probe(args: string[]): Promise<Spawned> {
  const output = await run([bins.hx2, ...args], env);
  leaveAlone.probes.push({ command: `hx2 ${args.join(" ")}`, output });
  log(`── ${LEAVE_ALONE}: hx2 ${args.join(" ")} → exit ${output.code}\n${output.stdout.trimEnd()}${output.stderr.trim() ? `\n${output.stderr.trimEnd()}` : ""}`);
  return output;
}

function bumpPatch(version: string): string {
  const [a, b, c] = version.split(".").map(Number);
  return `${a}.${b}.${(c ?? 0) + 1}`;
}

async function leaveAlonePhase(): Promise<void> {
  leaveAlone.ran = true;
  leaveAlone.seqFrom = cloud.requestCount + 1;
  leaveAlone.before = await watchProcesses();
  await probe(["status"]);
  await probe(["restart"]);
  // A newer hx2 on the update channel: the binary is swapped (for the same
  // bytes), and the service is not touched.
  cloud.update({ version: bumpPatch(versions.hx2), releaseBinary: bins.hx2 });
  await probe(["update"]);
  cloud.update({ version: "0.0.0", releaseBinary: undefined });
  await sleep(3_000);
  leaveAlone.after = await watchProcesses();
  await probe(["stop"]);
  await probe(["status"]);
  leaveAlone.seqTo = cloud.requestCount + 1;
}

try {
  await phase("1 · hx takes the slot", "hx", ["start"], null, () => waitSynced());
  await phase("2 · hx2 connect moves the device to hx2", "hx2", ["connect"], 0, () => waitStoredWhole(0));
  await phase("3 · hx takes it back", "hx", [wayBack], 2, () => waitStoredWhole(2));
  await phase("4 · hx2 start takes it again", "hx2", ["start"], 3, () => waitStoredWhole(3));
  await phase("5 · hx takes it back again", "hx", [wayBack], 0, () => waitStoredWhole(0));
  await leaveAlonePhase();
} finally {
  const hxDir = join(home, ".let", "hx");
  for (const f of ["stdout.log", "stderr.log", "state.json", "watch-run.json", "watch-exits.json", "bootstrap.sh"]) {
    const p = join(hxDir, f);
    if (existsSync(p)) cpSync(p, join(out, f));
  }
  // The reference takes the service down for good, whichever client holds it.
  const cleanup = await run([bins.hx, "uninstall", "--purge"], env);
  log(`── cleanup: hx uninstall --purge → exit ${cleanup.code}\n${cleanup.stdout.trimEnd()}`);
  writeFileSync(join(out, "cleanup.txt"), `exit ${cleanup.code}\n${cleanup.stdout}${cleanup.stderr}`);
  await killWatchProcesses();
  svc.release();
  writeFileSync(join(out, "store.json"), JSON.stringify(cloud.manifest(), null, 2));
  cloud.stop();
}

// ── The checks ──────────────────────────────────────────────────────────────

const requests: RecordedRequest[] = readFileSync(join(out, "gateway.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as RecordedRequest);
interface Check {
  name: string;
  ok: boolean;
  details: string;
}
const checks: Check[] = [];
const check = (name: string, problems: string[], okDetails: string): void => {
  checks.push({ name, ok: problems.length === 0, details: problems.length ? problems.slice(0, 12).join("\n") : okDetails });
};
const objectKey = (r: RecordedRequest): string => (r.lane ? `${r.sessionKey}:${r.lane}:letai` : `${r.sessionKey}:letai`);
const isCommit = (r: RecordedRequest): boolean => r.path === "/sessions/commit" || r.path === "/sessions/agent-commit";

check("every fixture session is in the store", missingSessions(), `${manifest.sessions.length} sessions`);

for (const p of phases) {
  const window = requests.filter((r) => r.seq >= p.seqFrom && r.seq < p.seqTo);
  for (const e of p.errors) checks.push({ name: `${p.name}: ran`, ok: false, details: e });

  // `status` of the phase's client: running, under the expected manager.
  const daemonRow = /^Daemon:\s+(.*)$/m.exec(p.status?.stdout ?? "")?.[1] ?? "(no Daemon row)";
  check(
    `${p.name}: \`${p.client} status\``,
    daemonRow.startsWith(`running (${MANAGER_NAME[manager]}, pid `) ? [] : [`Daemon: ${daemonRow}`],
    `Daemon: ${daemonRow}`,
  );

  // One daemon process, the phase's client's.
  const other: Client = p.client === "hx" ? "hx2" : "hx";
  check(
    `${p.name}: one daemon, ${p.client}'s`,
    p.processes[p.client].length === 1 && p.processes[other].length === 0
      ? []
      : [`${p.processes.hx.length} hx watch (${p.processes.hx.join(", ") || "none"}), ${p.processes.hx2.length} hx2 watch (${p.processes.hx2.join(", ") || "none"})`],
    `${p.client} watch, pid ${p.processes[p.client].join(", ")}`,
  );

  if (p.grows === null) continue;

  // After a switch every object gets exactly the bytes it was missing.
  const putBytes = new Map<string, number>();
  for (const r of window) {
    if (r.method === "PUT" && r.status === 200 && r.sessionKey) putBytes.set(objectKey(r), (putBytes.get(objectKey(r)) ?? 0) + r.bodyBytes);
  }
  const twice: string[] = [];
  let grewBytes = 0;
  for (const key of new Set([...putBytes.keys(), ...Object.keys(p.storedAfter)])) {
    const isObject = p.storedAfter[key]?.components !== undefined || p.storedBefore[key]?.components !== undefined;
    if (!isObject && !putBytes.has(key)) continue; // a sidecar
    const grew = (p.storedAfter[key]?.bytes ?? 0) - (p.storedBefore[key]?.bytes ?? 0);
    const sent = putBytes.get(key) ?? 0;
    grewBytes += Math.max(grew, 0);
    if (sent !== grew) twice.push(`${key}: ${sent} bytes PUT, the store grew by ${grew}`);
  }
  for (const r of window) {
    if (isCommit(r) && r.status === 200 && (r.body as { replace?: unknown } | undefined)?.replace === true && p.storedBefore[objectKey(r)]) {
      twice.push(`${r.path} replaced ${objectKey(r)}, which the store held before the switch`);
    }
  }
  check(`${p.name}: only the missing bytes went up`, twice, `${putBytes.size} object(s) grew by ${grewBytes} bytes, and ${grewBytes} bytes were PUT; no replace`);

  // The grown transcript: whole, byte for byte, through the phase's client.
  const key = storedKey(p.grows);
  const stored = p.storedAfter[key];
  const commits = window.filter((r) => isCommit(r) && r.status === 200 && objectKey(r) === key);
  const problems: string[] = [];
  if (!stored || stored.sha256 !== p.grownSha) problems.push(`stored ${stored?.bytes ?? 0} bytes, sha256 ${stored?.sha256.slice(0, 12) ?? "none"}; on disk sha256 ${p.grownSha?.slice(0, 12)}`);
  if (commits.length === 0) problems.push("no commit for it in this phase");
  for (const r of commits) {
    if (clientOfUserAgent(r.headers["user-agent"]) !== p.client) problems.push(`commit ${r.seq} came from ${r.headers["user-agent"] ?? "(no user-agent)"}`);
  }
  check(`${p.name}: the grown transcript is stored whole, through ${p.client}`, problems, `${key}: ${stored?.bytes} bytes, sha256 matches the file; ${commits.length} commit(s) from ${p.client}`);
}

// One stretch of daemon traffic per phase, in the phases' order: hx, hx2,
// hx, hx2, hx. Only what a daemon sends counts (uploads, routes, heartbeats,
// progress reports); a command's own calls (whoami, ping, inventory,
// downloads) come from the CLI process. Cleanup requests are excluded.
{
  const end = phases.at(-1)?.seqTo ?? 0;
  const isDaemonCall = (r: RecordedRequest): boolean =>
    r.method === "PUT" || r.path.startsWith("/sessions/") || r.path === "/route" || r.path === "/devices/heartbeat" || r.path === "/devices/sync-status";
  const stretches: Array<{ client: Client | "other"; from: number; to: number; count: number }> = [];
  for (const r of requests) {
    if (r.seq >= end) break;
    if (!isDaemonCall(r)) continue;
    const c = clientOfUserAgent(r.headers["user-agent"]);
    const last = stretches.at(-1);
    if (last && last.client === c) {
      last.to = r.seq;
      last.count += 1;
    } else stretches.push({ client: c, from: r.seq, to: r.seq, count: 1 });
  }
  const shape = stretches.map((s) => s.client).join(" → ");
  const want = phases.map((p) => p.client).join(" → ");
  const problems: string[] = [];
  if (shape !== want) problems.push(`the daemon traffic runs ${shape || "(empty)"}, not ${want}`);
  for (let i = 1; i < stretches.length && i < phases.length; i++) {
    if (stretches[i]!.from < phases[i]!.seqFrom) problems.push(`${stretches[i]!.client} talked (request ${stretches[i]!.from}) before ${phases[i]!.name} began`);
  }
  check("the two daemons never ran at once", problems, stretches.map((s) => `${s.client}: requests ${s.from}–${s.to} (${s.count})`).join("<br>"));
}

// Phase 2: hx2 joins with the saved login — no new pairing.
{
  const p = phases.find((x) => x.command[0] === "connect");
  if (p) {
    const pairing = requests.filter((r) => r.seq >= p.seqFrom && r.seq < p.seqTo && (r.path === "/devices/code" || r.path === "/devices/poll"));
    const said = p.output.stdout.includes("Moved the background service from hx to hx2.");
    check(
      `${p.name}: the saved login, no new pairing`,
      [...pairing.map((r) => `${r.method} ${r.path}`), ...(said ? [] : ["no \"Moved the background service from hx to hx2.\" line"])],
      p.output.stdout.trim().replace(/\n/g, "<br>"),
    );
  }
}

// Phase 6: hx2's other service commands leave hx's slot alone.
if (!leaveAlone.ran) {
  checks.push({ name: `${LEAVE_ALONE}: ran`, ok: false, details: "an earlier phase stopped the run" });
} else {
  const output = (command: string, nth = 0): Spawned | undefined => leaveAlone.probes.filter((p) => p.command === command)[nth]?.output;
  const daemonRow = (s: Spawned | undefined): string => /^Daemon:\s+(.*)$/m.exec(s?.stdout ?? "")?.[1] ?? "(no Daemon row)";
  const says = (s: Spawned | undefined, want: string[], unwanted: string[] = []): string[] => {
    if (!s) return ["not run"];
    const problems: string[] = [];
    if (s.code !== 0) problems.push(`exit ${s.code}`);
    for (const w of want) if (!s.stdout.includes(w)) problems.push(`missing: ${w}`);
    for (const u of unwanted) if (s.stdout.includes(u)) problems.push(`unexpected: ${u}`);
    return problems;
  };
  const shown = (s: Spawned | undefined): string => s?.stdout.trim() ?? "(not run)";

  const running = daemonRow(output("hx2 status"));
  check(`${LEAVE_ALONE}: \`hx2 status\` names hx`, running.startsWith(`running hx (${MANAGER_NAME[manager]}, pid `) ? [] : [`Daemon: ${running}`], `Daemon: ${running}`);
  const restart = output("hx2 restart");
  check(
    `${LEAVE_ALONE}: \`hx2 restart\` leaves it alone`,
    says(restart, ["hx runs the background service on this device, so hx2 left it alone.", "Run `hx restart` to restart it, or `hx2 start` to move this device to hx2."]),
    shown(restart),
  );
  const update = output("hx2 update");
  check(
    `${LEAVE_ALONE}: \`hx2 update\` swaps hx2's binary and leaves the service alone`,
    says(update, ["hx2 updated to latest", "hx runs the background service on this device, so hx2 left it alone.", "Run `hx2 start` to move this device to hx2."], ["daemon restarted."]),
    shown(update),
  );
  // Through status, restart and update hx's daemon ran on: the same process,
  // no hx2 daemon, and nothing only a daemon sends came from hx2.
  const fromHx2 = requests.filter(
    (r) =>
      r.seq >= leaveAlone.seqFrom &&
      r.seq < leaveAlone.seqTo &&
      clientOfUserAgent(r.headers["user-agent"]) === "hx2" &&
      (r.method === "PUT" || r.path.startsWith("/sessions/") || r.path === "/devices/heartbeat" || r.path === "/devices/sync-status"),
  );
  const untouched = leaveAlone.before.hx.length === 1 && leaveAlone.before.hx.join() === leaveAlone.after.hx.join() && leaveAlone.after.hx2.length === 0;
  check(
    `${LEAVE_ALONE}: hx's daemon ran on, untouched`,
    [
      ...(untouched ? [] : [`hx watch before: ${leaveAlone.before.hx.join(", ") || "none"}; after: ${leaveAlone.after.hx.join(", ") || "none"}; hx2 watch after: ${leaveAlone.after.hx2.join(", ") || "none"}`]),
      ...fromHx2.slice(0, 5).map((r) => `hx2 sent ${r.method} ${r.path}`),
    ],
    `hx watch, pid ${leaveAlone.after.hx.join(", ")} before and after; no hx2 daemon; no daemon request from hx2`,
  );
  const stop = output("hx2 stop");
  const stopped = daemonRow(output("hx2 status", 1));
  check(
    `${LEAVE_ALONE}: \`hx2 stop\` stops hx's service and says whose it is`,
    [...says(stop, ["hx stopped (", "Run `hx start` to resume it, or `hx2 start` to move this device to hx2."]), ...(/^hx (stopped|loaded, not running)/.test(stopped) ? [] : [`then Daemon: ${stopped}`])],
    `${shown(stop)}\nthen Daemon: ${stopped}`,
  );
}

const ok = checks.every((c) => c.ok);
const lines: string[] = [];
lines.push(`## Moving the slot between hx and hx2 (${manager}): ${ok ? "nothing lost, nothing sent twice" : "FAILED"}`);
lines.push("");
lines.push(`${process.platform}-${process.arch} · hx ${versions.hx} · hx2 ${versions.hx2} · ${manager === "shell-hook" ? "the fixture as HOME" : "the user's own HOME, fixture linked in"} · ${manifest.sessions.length} fixture sessions · ${requests.length} requests`);
lines.push("");
lines.push("| Check | Result | Details |");
lines.push("| --- | --- | --- |");
for (const c of checks) lines.push(`| ${c.name} | ${c.ok ? "ok" : "**FAILED**"} | ${c.details.replace(/\n/g, "<br>").replace(/\|/g, "\\|")} |`);
lines.push("");
for (const p of phases) {
  lines.push(`#### ${p.name}: \`${p.client} ${p.command.join(" ")}\``);
  lines.push("```");
  lines.push(p.output.stdout.trimEnd() || "(no output)");
  lines.push("```");
}
if (leaveAlone.ran) {
  lines.push(`#### ${LEAVE_ALONE}`);
  lines.push("```");
  for (const p of leaveAlone.probes) lines.push(`$ ${p.command}`, p.output.stdout.trimEnd() || "(no output)");
  lines.push("```");
}
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
writeFileSync(
  join(out, "report.json"),
  JSON.stringify(
    {
      ok,
      manager,
      versions,
      checks,
      phases: phases.map((p) => ({ name: p.name, client: p.client, command: p.command, seqFrom: p.seqFrom, seqTo: p.seqTo, exit: p.output.code, stdout: p.output.stdout, status: p.status?.stdout, processes: p.processes })),
      leaveAlone: leaveAlone,
    },
    null,
    2,
  ),
);
log(lines.join("\n"));
process.exit(ok ? 0 : 1);
