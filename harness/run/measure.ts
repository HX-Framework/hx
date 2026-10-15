// The measurement runner: the numbers behind the TypeScript design fixes
// (HX2 program, Build hx2 step 3), produced on the CI runner for a reference
// binary and a candidate, side by side.
//
//   bun harness/run/measure.ts --reference <bin> --candidate <bin> --out <dir> --work <dir>
//
// Each measurement runs the same fixture and the same steps with both
// binaries and records what the operating system can tell about the process:
// CPU time, maximum resident size, block I/O (rusage, through Bun.spawn's
// resourceUsage()), and on Linux the system calls strace counts. Nothing is
// instrumented inside the binary. What is measured, and the fix it measures:
//
//   writes-per-pass      one-shot pass, 10 grown transcripts, a 5 MB state:
//                        bytes written per pass (the offsets journal)
//   writes-daemon        the same growth fed to a running daemon for 45 s
//   idle-syscalls        a daemon idle for 75 s on a 600-session tree under
//                        strace -c (Linux): file checks per second (file
//                        events + the lane and workflow gates)
//   idle-cpu             the same daemon without strace: CPU% and RSS
//   workflow-retries     the daemon-backoff scenario: refused workflow
//                        uploads and [stuck] lines in 50 s (the backoff and
//                        the dedupe key)
//   ccd-index            a one-shot pass with 10,000 Claude Desktop files,
//                        second run: block reads, CPU, RSS (the saved index,
//                        macOS only — the store exists only there)
//
// Nothing here runs on a laptop by design: .github/workflows/differential.yml
// runs it in the `measure` job and attaches measurements.json / .md.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FakeGateway } from "../gateway/gateway.js";
import { generateHome, type Manifest } from "../fixtures/gen-home.js";
import { Prng } from "../lib/prng.js";
import { appendTranscriptLines, binaryVersion, clientEnv, runScenario, writeClientFiles } from "./run-scenario.js";
import { scenarioByName } from "./scenarios.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const reference = arg("reference");
const candidate = arg("candidate");
const out = arg("out", join(process.cwd(), "measure-out")) ?? "";
const workDir = arg("work", join(process.cwd(), ".measure-work")) ?? "";
if (!reference || !candidate) {
  console.error("usage: measure.ts --reference <bin> --candidate <bin> [--out dir] [--work dir]");
  process.exit(64);
}
mkdirSync(out, { recursive: true });
mkdirSync(workDir, { recursive: true });
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const PORT = 48631;
const BLOCK = 512; // Linux reports ru_oublock/ru_inblock in 512-byte units

interface Usage {
  elapsedMs: number;
  cpuMs: number;
  maxRssBytes: number;
  blocksIn: number;
  blocksOut: number;
  exit: string;
}

type Measurement = Record<string, number | string>;
interface Row {
  measurement: string;
  metric: string;
  unit: string;
  reference: number | string;
  candidate: number | string;
}

function usageOf(proc: ReturnType<typeof Bun.spawn>, startedAt: number, exit: string): Usage {
  const u = proc.resourceUsage();
  // Bun 1.3 hands the CPU times back as BigInt (microseconds) although the
  // declaration says number; every field goes through Number() so arithmetic
  // and JSON.stringify never meet a BigInt.
  const n = (v: unknown): number => Number(v);
  return {
    elapsedMs: Date.now() - startedAt,
    cpuMs: u ? Math.round(n(u.cpuTime.total) / 1000) : -1,
    maxRssBytes: u ? n(u.maxRSS) : -1,
    blocksIn: u ? n(u.ops.in) : -1,
    blocksOut: u ? n(u.ops.out) : -1,
    exit,
  };
}

/** Run a command to completion. */
async function runOnce(cmd: string[], env: Record<string, string>, timeoutMs: number): Promise<Usage & { stdout: string }> {
  const startedAt = Date.now();
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (proc.signalCode || code !== 0) log(`    ${cmd.slice(1).join(" ")}: exit ${proc.signalCode ?? code}\n${stderr.slice(0, 800)}`);
  return { ...usageOf(proc, startedAt, proc.signalCode ?? String(code)), stdout };
}

/** Run the long-running daemon for `durationMs`, calling `during` on its
 *  schedule, then SIGTERM it and wait for the exit. */
async function runDaemon(
  cmd: string[],
  env: Record<string, string>,
  durationMs: number,
  during?: { everyMs: number; fn: (n: number) => void },
): Promise<Usage & { stdout: string }> {
  const startedAt = Date.now();
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  let n = 0;
  let nextAt = startedAt + (during?.everyMs ?? Infinity);
  while (Date.now() - startedAt < durationMs && proc.exitCode === null && proc.signalCode === null) {
    if (during && Date.now() >= nextAt) {
      during.fn(n++);
      nextAt += during.everyMs;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // A command that ended on its own (a `timeout`-wrapped daemon) needs no stop.
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  const stopAt = Date.now() + 20_000;
  while (Date.now() < stopAt && proc.exitCode === null && proc.signalCode === null) await new Promise((r) => setTimeout(r, 50));
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([out, err]);
  if (!proc.signalCode || proc.signalCode !== "SIGTERM") log(`    daemon ended ${proc.signalCode ?? code}: ${stderr.slice(0, 400)}`);
  return { ...usageOf(proc, startedAt, proc.signalCode ?? String(code)), stdout };
}

interface Home {
  home: string;
  manifest: Manifest;
  gateway: FakeGateway;
  env: Record<string, string>;
}

/** A fresh fixture home connected to a fresh fake gateway. */
async function prepareHome(binary: string, name: string, shape: Manifest["shape"], settings: Record<string, unknown> = {}): Promise<Home> {
  const home = join(workDir, `home-${name}`);
  const manifest = generateHome({ out: home, shape, seed: `measure-${name}` });
  const version = await binaryVersion(binary, home);
  const gateway = new FakeGateway({ version, releaseBinary: binary, label: "cloud", recordPath: join(workDir, `gateway-${name}.jsonl`) });
  rmSync(join(workDir, `gateway-${name}.jsonl`), { force: true });
  const url = gateway.start(PORT);
  writeClientFiles(home, gateway, url, settings);
  return { home, manifest, gateway, env: clientEnv(home, { url, token: gateway.config.accessToken }) };
}

/** Inflate state.json to the shape of a long-lived laptop: `count` delivered
 *  entries for transcripts that no longer exist (Claude Code prunes at 30
 *  days; the state keeps them). About 470 bytes each, as on the founder's
 *  machine, so 11,000 entries make the 5 MB file the fixes were measured
 *  against. */
function inflateState(home: string, count: number): number {
  const p = join(home, ".let", "hx", "state.json");
  const state = JSON.parse(readFileSync(p, "utf8")) as { files: Record<string, unknown>; destinations?: unknown };
  const rng = new Prng("inflate");
  const projects = join(home, ".claude", "projects");
  for (let i = 0; i < count; i++) {
    const sid = rng.uuid();
    const dir = `-inflated-${rng.alnum(3)}-${String(i % 97).padStart(2, "0")}`;
    const size = rng.int(8_000, 900_000);
    state.files[join(projects, dir, `${sid}.jsonl`)] = {
      path: join(projects, dir, `${sid}.jsonl`),
      family: i % 4 === 0 ? "claude-desktop" : "claude-cli",
      sessionId: sid,
      cwd: `~/work/${dir}`,
      repoSlug: i % 3 === 0 ? null : `acme/${dir}`,
      attributed: i % 3 !== 0,
      offsets: { letai: size },
      lastKnownSize: size,
      lastMtimeMs: 1_750_000_000_000 + i * 60_000,
      lastUploadAtMs: 1_750_000_000_000 + i * 60_000 + 5_000,
      attributionVersion: 3,
    };
  }
  const text = JSON.stringify(state);
  writeFileSync(p, text, { mode: 0o600 });
  return Buffer.byteLength(text);
}

function bytesOut(u: Usage): number | string {
  return u.blocksOut < 0 ? "n/a" : process.platform === "linux" ? u.blocksOut * BLOCK : u.blocksOut;
}
function bytesIn(u: Usage): number | string {
  return u.blocksIn < 0 ? "n/a" : process.platform === "linux" ? u.blocksIn * BLOCK : u.blocksIn;
}
const outUnit = process.platform === "linux" ? "bytes written (ru_oublock × 512)" : "block output operations (ru_oublock)";
const inUnit = process.platform === "linux" ? "bytes read (ru_inblock × 512)" : "block input operations (ru_inblock)";

const rows: Row[] = [];
function row(measurement: string, metric: string, unit: string, ref: number | string, cand: number | string): void {
  rows.push({ measurement, metric, unit, reference: ref, candidate: cand });
}

// ── writes-per-pass / writes-daemon (the offsets journal) ───────────────────

async function measureWrites(binary: string): Promise<Measurement> {
  const h = await prepareHome(binary, "writes", "small");
  try {
    await runOnce([binary, "watch", "--once"], h.env, 600_000); // pass 1: everything uploads
    await runOnce([binary, "watch", "--once"], h.env, 600_000); // pass 2: the 70 MB file's tail
    const stateBytes = inflateState(h.home, 11_000);
    const sessions = h.manifest.sessions.filter((s) => s.path.includes(".claude")).slice(0, 10);
    for (const [i, s] of sessions.entries()) appendTranscriptLines(s.path, s.sessionId, 3_000, `measure-writes-${i}`);
    const pass = await runOnce([binary, "watch", "--once"], h.env, 600_000);
    const stateAfter = Buffer.byteLength(readFileSync(join(h.home, ".let", "hx", "state.json"), "utf8"));
    const journalPath = join(h.home, ".let", "hx", "state.journal.jsonl");
    const journalAfter = existsSync(journalPath) ? Buffer.byteLength(readFileSync(journalPath, "utf8")) : 0;

    // The daemon: a transcript grows every 3 s for 45 s.
    const daemon = await runDaemon([binary, "watch"], h.env, 45_000, {
      everyMs: 3_000,
      fn: (n) => {
        const s = sessions[n % sessions.length]!;
        appendTranscriptLines(s.path, s.sessionId, 3_000, `measure-writes-daemon-${n}`);
      },
    });
    const commits = h.gateway.record.filter((r) => r.path === "/sessions/commit").length;
    return {
      stateBytes,
      grownTranscripts: sessions.length,
      passWrites: bytesOut(pass),
      passElapsedMs: pass.elapsedMs,
      passCpuMs: pass.cpuMs,
      stateAfterPass: stateAfter,
      journalAfterPass: journalAfter,
      daemonWrites: bytesOut(daemon),
      daemonCommits: commits,
      daemonElapsedMs: daemon.elapsedMs,
      daemonCpuMs: daemon.cpuMs,
      daemonMaxRss: daemon.maxRssBytes,
      daemonExit: daemon.exit,
    };
  } finally {
    h.gateway.stop();
  }
}

// ── idle-syscalls / idle-cpu (file events, the lane and workflow gates) ─────

function parseStraceSummary(text: string): Record<string, number> {
  // strace -c: "% time  seconds  usecs/call  calls  errors  syscall" rows,
  // then a "total" row that must not be counted as a call.
  const counts: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*[\d.]+\s+[\d.]+\s+\d+\s+(\d+)\s+(?:\d+\s+)?([a-z_0-9]+)\s*$/.exec(line);
    if (m && m[2] !== "total") counts[m[2]!] = (counts[m[2]!] ?? 0) + Number(m[1]);
  }
  return counts;
}

async function measureIdle(binary: string): Promise<Measurement> {
  const h = await prepareHome(binary, "idle", "claude-like");
  try {
    await runOnce([binary, "watch", "--once"], h.env, 900_000); // catch up
    await runOnce([binary, "watch", "--once"], h.env, 900_000);
    const result: Measurement = {};
    const IDLE_MS = 75_000;
    const strace = process.platform === "linux" ? Bun.which("strace") : null;
    const timeout = Bun.which("timeout");
    if (strace && timeout) {
      const summary = join(workDir, `strace-${binary.replace(/[^a-z0-9]/gi, "_")}.txt`);
      rmSync(summary, { force: true });
      // `timeout` is the traced parent and stops the daemon with SIGTERM after
      // IDLE_MS; strace then exits with the summary. Stopping strace itself
      // would only detach it and leave the daemon running.
      const traced = await runDaemon(
        [strace, "-f", "-c", "-o", summary, timeout, "-s", "TERM", String(IDLE_MS / 1000), binary, "watch"],
        h.env,
        IDLE_MS + 30_000,
      );
      const counts = existsSync(summary) ? parseStraceSummary(readFileSync(summary, "utf8")) : {};
      const sum = (names: string[]): number => names.reduce((a, n) => a + (counts[n] ?? 0), 0);
      const secs = IDLE_MS / 1000;
      const stat = sum(["newfstatat", "statx", "stat", "lstat", "fstat", "fstatat64"]);
      const open = sum(["openat", "open"]);
      const dents = sum(["getdents64", "getdents"]);
      const read = sum(["read", "pread64"]);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      Object.assign(result, {
        tracedSecs: Math.round(secs),
        tracedExit: traced.exit,
        statPerSec: Math.round(stat / secs),
        openPerSec: Math.round(open / secs),
        readdirPerSec: Math.round(dents / secs),
        readPerSec: Math.round(read / secs),
        syscallsPerSec: Math.round(total / secs),
        fileChecksPerSec: Math.round((stat + open + dents) / secs),
      });
    } else {
      result.strace = "not available";
    }
    const plain = await runDaemon([binary, "watch"], h.env, 60_000);
    result.idleCpuPercent = Math.round((plain.cpuMs / plain.elapsedMs) * 1000) / 10;
    result.idleMaxRss = plain.maxRssBytes;
    result.idleWrites = bytesOut(plain);
    result.idleExit = plain.exit;
    return result;
  } finally {
    h.gateway.stop();
  }
}

// ── workflow-retries (the backoff, the stuck-line key) ──────────────────────

async function measureBackoff(binary: string, name: string): Promise<Measurement> {
  const scenario = scenarioByName("daemon-backoff");
  const outDir = join(out, "daemon-backoff", name);
  const meta = await runScenario({ binary, name: "hx", scenario, outDir, home: join(workDir, "home-backoff"), workDir, log: () => {} });
  const requests = readFileSync(join(outDir, "gateway.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { path: string; status: number });
  const step = meta.steps.find((s) => s.name === "daemon")!;
  const stdout = readFileSync(join(outDir, "steps", `${String(step.index).padStart(2, "0")}-daemon.stdout`), "utf8");
  const lines = stdout.split("\n");
  return {
    daemonSecs: Math.round((step.endedAtMs - step.startedAtMs) / 1000),
    workflowUploadsRefused: requests.filter((r) => r.path === "/sessions/workflow" && r.status >= 500).length,
    stuckLines: lines.filter((l) => l.includes("[stuck]")).length,
    workflowErrorLines: lines.filter((l) => l.includes("[error] workflow")).length,
    logLines: lines.filter((l) => l.trim()).length,
    failures: meta.failures.join("; ") || "none",
  };
}

// ── ccd-index (the saved Claude Desktop index; macOS only) ──────────────────

async function measureCcdIndex(binary: string): Promise<Measurement> {
  const h = await prepareHome(binary, "ccd", "small");
  try {
    const org = join(h.home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct_measure", "org_measure");
    mkdirSync(org, { recursive: true });
    const rng = new Prng("ccd-measure");
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const sid = rng.uuid();
      writeFileSync(
        join(org, `local_${sid}.json`),
        JSON.stringify({ sessionId: `local_${sid}`, cliSessionId: rng.uuid(), title: rng.sentence(6), titleSource: i % 2 ? "user" : "ai", isArchived: false, lastActivityAt: 1_750_000_000_000 + i * 1000, cwd: `/work/${rng.alnum(5)}` }),
      );
    }
    const first = await runOnce([binary, "watch", "--once"], h.env, 600_000);
    const second = await runOnce([binary, "watch", "--once"], h.env, 600_000);
    const indexPath = join(h.home, ".let", "hx", "ccd-index.json");
    return {
      ccdFiles: N,
      firstPassElapsedMs: first.elapsedMs,
      firstPassCpuMs: first.cpuMs,
      firstPassMaxRss: first.maxRssBytes,
      secondPassElapsedMs: second.elapsedMs,
      secondPassCpuMs: second.cpuMs,
      secondPassMaxRss: second.maxRssBytes,
      secondPassReads: bytesIn(second),
      savedIndexBytes: existsSync(indexPath) ? Buffer.byteLength(readFileSync(indexPath, "utf8")) : 0,
    };
  } finally {
    h.gateway.stop();
  }
}

// ── Run everything, both binaries ───────────────────────────────────────────

const results: Record<string, { reference: Measurement; candidate: Measurement }> = {};
async function both(name: string, fn: (binary: string, who: "reference" | "candidate") => Promise<Measurement>): Promise<void> {
  log(`\n=== ${name}`);
  const ref = await fn(reference!, "reference");
  log(`    reference: ${JSON.stringify(ref)}`);
  const cand = await fn(candidate!, "candidate");
  log(`    candidate: ${JSON.stringify(cand)}`);
  results[name] = { reference: ref, candidate: cand };
}

await both("writes", (b) => measureWrites(b));
await both("idle", (b) => measureIdle(b));
await both("backoff", (b, who) => measureBackoff(b, who));
if (process.platform === "darwin") await both("ccd-index", (b) => measureCcdIndex(b));

// ── Report ──────────────────────────────────────────────────────────────────

const R = results["writes"]!;
row("writes-per-pass", "state.json before the pass", "bytes", R.reference.stateBytes!, R.candidate.stateBytes!);
row("writes-per-pass", `disk writes of one pass (${R.reference.grownTranscripts} grown transcripts)`, outUnit, R.reference.passWrites!, R.candidate.passWrites!);
row("writes-per-pass", "journal left after the pass", "bytes", R.reference.journalAfterPass!, R.candidate.journalAfterPass!);
row("writes-daemon", `disk writes of a 45 s daemon (${R.reference.daemonCommits} commits)`, outUnit, R.reference.daemonWrites!, R.candidate.daemonWrites!);
row("writes-daemon", "daemon CPU time", "ms", R.reference.daemonCpuMs!, R.candidate.daemonCpuMs!);
const I = results["idle"]!;
if (I.reference.fileChecksPerSec !== undefined) {
  row("idle-syscalls", `file checks per second at idle (stat + open + readdir, ${I.reference.tracedSecs} s)`, "calls/s", I.reference.fileChecksPerSec!, I.candidate.fileChecksPerSec!);
  row("idle-syscalls", "stat family", "calls/s", I.reference.statPerSec!, I.candidate.statPerSec!);
  row("idle-syscalls", "open", "calls/s", I.reference.openPerSec!, I.candidate.openPerSec!);
  row("idle-syscalls", "readdir", "calls/s", I.reference.readdirPerSec!, I.candidate.readdirPerSec!);
  row("idle-syscalls", "read", "calls/s", I.reference.readPerSec!, I.candidate.readPerSec!);
  row("idle-syscalls", "all system calls", "calls/s", I.reference.syscallsPerSec!, I.candidate.syscallsPerSec!);
}
row("idle-cpu", "CPU of a 60 s idle daemon (600 sessions, 60 lanes, 30 runs)", "% of one core", I.reference.idleCpuPercent!, I.candidate.idleCpuPercent!);
row("idle-cpu", "maximum RSS", "bytes", I.reference.idleMaxRss!, I.candidate.idleMaxRss!);
row("idle-cpu", "disk writes while idle", outUnit, I.reference.idleWrites!, I.candidate.idleWrites!);
const B = results["backoff"]!;
row("workflow-retries", `refused workflow uploads in the ${B.reference.daemonSecs} s daemon-backoff run`, "requests", B.reference.workflowUploadsRefused!, B.candidate.workflowUploadsRefused!);
row("workflow-retries", "[error] workflow lines", "lines", B.reference.workflowErrorLines!, B.candidate.workflowErrorLines!);
row("stuck-line", "[stuck] lines in the same run", "lines", B.reference.stuckLines!, B.candidate.stuckLines!);
row("stuck-line", "daemon log lines in total", "lines", B.reference.logLines!, B.candidate.logLines!);
const C = results["ccd-index"];
if (C) {
  row("ccd-index", `second one-shot pass with ${C.reference.ccdFiles} Claude Desktop files: block reads`, inUnit, C.reference.secondPassReads!, C.candidate.secondPassReads!);
  row("ccd-index", "second pass CPU time", "ms", C.reference.secondPassCpuMs!, C.candidate.secondPassCpuMs!);
  row("ccd-index", "second pass maximum RSS", "bytes", C.reference.secondPassMaxRss!, C.candidate.secondPassMaxRss!);
  row("ccd-index", "second pass wall time", "ms", C.reference.secondPassElapsedMs!, C.candidate.secondPassElapsedMs!);
  row("ccd-index", "saved index", "bytes", C.reference.savedIndexBytes!, C.candidate.savedIndexBytes!);
}

const fmt = (v: number | string): string => (typeof v === "number" ? v.toLocaleString("en-US") : v);
const md: string[] = [];
md.push(`# Measurements (${process.platform}-${process.arch})`);
md.push("");
md.push(`Reference \`${reference}\`, candidate \`${candidate}\`, ${new Date().toISOString()}. Every number is the operating system's view of the process (rusage, strace); nothing is instrumented inside the binary.`);
md.push("");
md.push("| Measurement | Metric | Unit | Reference | Candidate |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of rows) md.push(`| ${r.measurement} | ${r.metric} | ${r.unit} | ${fmt(r.reference)} | ${fmt(r.candidate)} |`);
md.push("");
writeFileSync(join(out, "measurements.json"), JSON.stringify({ platform: `${process.platform}-${process.arch}`, reference, candidate, generatedAt: new Date().toISOString(), rows, raw: results }, null, 2));
writeFileSync(join(out, "measurements.md"), `${md.join("\n")}\n`);
log(`\n${md.join("\n")}`);
