// Moving a device between hx and hx2 through a real service manager: the exit
// check of the HX2 program's "Build hx2" step — hx → hx2 → hx loses nothing
// and uploads nothing twice.
//
// hx and hx2 share one service slot (`ai.let.hx-vision`) and the files in
// ~/.let/hx, so a device runs one of the two, and either one carries on from
// the offsets the other left. This script runs the background service the way
// a device does, through launchd, systemd or the container shell hook, against
// a recording fake gateway, and moves the slot twice:
//
//   1. `hx start`    hx takes the slot and uploads the fixture home;
//   2. `hx2 start`   hx2 takes the slot; a transcript grows; hx2 uploads it;
//   3. hx takes the slot back (`hx restart`, or `hx start` from 77.13.0 on,
//      the release whose other commands leave hx2's slot alone); another
//      transcript grows; hx uploads it.
//
// The checks, from the gateway's recording and store:
//   • every fixture session is in the store;
//   • in phases 2 and 3, every object got exactly the bytes it was missing:
//     the bytes PUT equal how much the store grew, and no commit replaced an
//     object the store already held (a client that lost the other's offsets
//     re-sends from zero);
//   • each grown transcript is stored whole, byte for byte, and went up
//     through the phase's client;
//   • the recording is one stretch of hx, then one of hx2, then one of hx
//     (hx2 names itself in its User-Agent, hx sends Bun's), and each phase
//     ends with one daemon process, the phase's client's: the two never ran
//     at once;
//   • `status` of the phase's client says the service runs under the
//     expected manager.
//
//   bun harness/run/switch.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>
//
// launchd and systemd start the service with the user's own HOME, not the
// caller's, so for them the fixture is linked into the real home (~/.claude,
// ~/.codex, and Claude Desktop's folder on macOS) and the client's files are
// written to the real ~/.let/hx. That runs on CI runners only, and refuses to
// start when any of those paths already exists. The shell hook (a container's
// backend) runs with the fixture as HOME.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { FakeGateway, type RecordedRequest } from "../gateway/gateway.js";
import { generateHome, type Manifest } from "../fixtures/gen-home.js";
import { appendTranscriptLines, CLOUD_PORT, clientEnv, writeClientFiles } from "./run-scenario.js";

type Client = "hx" | "hx2";
type Manager = "launchd" | "systemd" | "shell-hook";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hxArg = arg("hx");
const hx2Arg = arg("hx2");
const manager = arg("manager") as Manager | undefined;
const out = arg("out");
const work = arg("work");
if (!hxArg || !hx2Arg || !out || !work || !manager || !["launchd", "systemd", "shell-hook"].includes(manager)) {
  console.error("usage: switch.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>");
  process.exit(64);
}
const bins: Record<Client, string> = { hx: resolve(hxArg), hx2: resolve(hx2Arg) };
const realHome = manager !== "shell-hook";
if (realHome && process.env.GITHUB_ACTIONS !== "true") {
  console.error(`--manager ${manager} runs the service in this user's real home: CI runners only`);
  process.exit(64);
}
const MANAGER_NAME: Record<Manager, string> = { launchd: "launchd", systemd: "systemd (user)", "shell-hook": "shell hook (container)" };

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<Spawned> {
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clientOfUserAgent(ua: string | undefined): Client | "other" {
  if (ua?.startsWith("hx2/")) return "hx2";
  if (ua?.startsWith("Bun/")) return "hx";
  return "other";
}

/** `<hx|hx2> watch` processes running now, by client. */
async function watchProcesses(): Promise<Record<Client, number[]>> {
  const r = await run(["ps", "-A", "-o", "pid=,args="], { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const found: Record<Client, number[]> = { hx: [], hx2: [] };
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+watch(\s|$)/.exec(line);
    if (!m) continue;
    const name = basename(m[2]!);
    if (name === "hx" || name === "hx2") found[name].push(Number(m[1]));
  }
  return found;
}

// ── The home ────────────────────────────────────────────────────────────────

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const genDir = join(work, "switch-home");
const home = realHome ? homedir() : genDir;
const LINKED = [".claude", ".codex", join("Library", "Application Support", "Claude")];
const linked: string[] = [];

if (realHome) {
  for (const rel of [...LINKED, join(".let", "hx")]) {
    let present = false;
    try {
      lstatSync(join(home, rel));
      present = true;
    } catch {
      // absent, as it must be
    }
    if (present) {
      console.error(`refusing to run: ${join(home, rel)} already exists`);
      process.exit(64);
    }
  }
}
const manifest: Manifest = generateHome({ out: genDir, shape: "small", seed: "switch" });
if (realHome) {
  for (const rel of LINKED) {
    const source = join(genDir, rel);
    if (!existsSync(source)) continue;
    const target = join(home, rel);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    linked.push(target);
  }
}

const cloud = new FakeGateway({ version: "0.0.0", recordPath: join(out, "gateway.jsonl"), label: "cloud" });
const gatewayUrl = cloud.start(CLOUD_PORT);
writeClientFiles(home, cloud, gatewayUrl, {});
const env: Record<string, string> = clientEnv(home);
// systemctl --user finds the user manager through these two; without them it
// fails, and the clients pick the shell hook.
if (manager === "systemd") {
  for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
}

async function versionOf(client: Client): Promise<string> {
  const r = await run([bins[client], "--version"], env);
  const m = /version: (\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!m) throw new Error(`no version from ${bins[client]}: ${r.stdout}${r.stderr}`);
  return m[1]!;
}

function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const versions: Record<Client, string> = { hx: await versionOf("hx"), hx2: await versionOf("hx2") };
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

let cleanup: Spawned | null = null;
try {
  await phase("1 · hx takes the slot", "hx", ["start"], null, () => waitSynced());
  await phase("2 · hx2 takes the slot", "hx2", ["start"], 0, () => waitStoredWhole(0));
  await phase("3 · hx takes it back", "hx", [wayBack], 2, () => waitStoredWhole(2));
} finally {
  const hxDir = join(home, ".let", "hx");
  for (const f of ["stdout.log", "stderr.log", "state.json", "watch-run.json", "watch-exits.json", "bootstrap.sh"]) {
    const p = join(hxDir, f);
    if (existsSync(p)) cpSync(p, join(out, f));
  }
  // The reference takes the service down for good, whichever client holds it.
  cleanup = await run([bins.hx, "uninstall", "--purge"], env);
  log(`── cleanup: hx uninstall --purge → exit ${cleanup.code}\n${cleanup.stdout.trimEnd()}`);
  const left = await watchProcesses();
  for (const pid of [...left.hx, ...left.hx2]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const l of linked) {
    try {
      unlinkSync(l);
    } catch {
      // gone
    }
  }
  if (realHome) rmSync(hxDir, { recursive: true, force: true });
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

// One stretch per client, in order: hx, hx2, hx. Cleanup requests excluded.
{
  const end = phases.at(-1)?.seqTo ?? 0;
  const stretches: Array<{ client: Client | "other"; from: number; to: number; count: number }> = [];
  for (const r of requests) {
    if (r.seq >= end) break;
    const c = clientOfUserAgent(r.headers["user-agent"]);
    const last = stretches.at(-1);
    if (last && last.client === c) {
      last.to = r.seq;
      last.count += 1;
    } else stretches.push({ client: c, from: r.seq, to: r.seq, count: 1 });
  }
  const shape = stretches.map((s) => s.client).join(" → ");
  const problems: string[] = [];
  if (shape !== "hx → hx2 → hx") problems.push(`the recording runs ${shape || "(empty)"}`);
  for (let i = 1; i < stretches.length && i < phases.length; i++) {
    if (stretches[i]!.from < phases[i]!.seqFrom) problems.push(`${stretches[i]!.client} talked (request ${stretches[i]!.from}) before ${phases[i]!.name} began`);
  }
  check("the two clients never ran at once", problems, stretches.map((s) => `${s.client}: requests ${s.from}–${s.to} (${s.count})`).join("<br>"));
}

const ok = checks.every((c) => c.ok);
const lines: string[] = [];
lines.push(`## Moving the slot hx → hx2 → hx (${manager}): ${ok ? "nothing lost, nothing sent twice" : "FAILED"}`);
lines.push("");
lines.push(`${process.platform}-${process.arch} · hx ${versions.hx} · hx2 ${versions.hx2} · ${realHome ? "the user's own HOME, fixture linked in" : "the fixture as HOME"} · ${manifest.sessions.length} fixture sessions · ${requests.length} requests`);
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
      cleanup: cleanup ? { exit: cleanup.code, stdout: cleanup.stdout } : null,
    },
    null,
    2,
  ),
);
log(lines.join("\n"));
process.exit(ok ? 0 : 1);
