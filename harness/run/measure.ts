// The measurement runner: the numbers behind the TypeScript design fixes
// (HX2 program, Build hx2 step 3) and the Rust port's exit check (step 4),
// produced on the CI runner for a reference binary and a candidate, side by
// side.
//
//   bun harness/run/measure.ts --reference <bin> --candidate <bin> --out <dir> --work <dir>
//       [--only writes,idle,backoff,ccd-index,founder,idle-hot] [--candidate-name hx2]
//
// Each measurement runs the same fixture and the same steps with both
// binaries and records what the operating system can tell about the process:
// CPU time, maximum resident size, block I/O (rusage, through Bun.spawn's
// resourceUsage()), on Linux the system calls strace counts, and for the
// idle windows a resident-size and CPU sample per second (/proc on Linux, ps
// on macOS). Nothing is instrumented inside the binary. What is measured, and
// the fix or check it measures:
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
//   idle-hot             idle-syscalls + idle-cpu on the hot-path shape
//                        (600 parent transcripts, nothing else)
//   founder              the hx2 exit check: a tree the size of the founder's
//                        laptop (4,800 transcripts, 36,000 Claude Desktop
//                        files): the catch-up passes, then the daemon idle for
//                        two minutes after a 30 s warm-up, sampled every
//                        second — median and maximum resident size, CPU as a
//                        share of one core, against the program's 50 MB and 1%
//
// Nothing here runs on a laptop by design: .github/workflows/differential.yml
// runs it in the `measure` jobs and attaches measurements.json / .md plus the
// per-syscall strace summaries.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FakeGateway } from "../gateway/gateway.js";
import { generateHome, type Manifest } from "../fixtures/gen-home.js";
import { Prng } from "../lib/prng.js";
import type { BinaryName } from "../lib/types.js";
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
const candidateName = (arg("candidate-name", "hx") ?? "hx") as BinaryName;
const only = new Set(
  (arg("only", "writes,idle,backoff,ccd-index") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (!reference || !candidate) {
  console.error("usage: measure.ts --reference <bin> --candidate <bin> [--out dir] [--work dir] [--only a,b] [--candidate-name hx2]");
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

// ── Per-second samples of a running process (the idle windows) ─────────────

interface Sample {
  atMs: number;
  rssBytes: number;
  /** CPU time consumed so far (user + system), or null when unreadable. */
  cpuMs: number | null;
}

/** "mm:ss.cc", "hh:mm:ss" or "dd-hh:mm:ss" (ps cputime) in milliseconds. */
export function parseCpuTime(s: string): number | null {
  let days = 0;
  let rest = s.trim();
  if (rest.includes("-")) {
    const [d, r] = rest.split("-");
    days = Number(d);
    rest = r ?? "";
  }
  const parts = rest.split(":").map(Number);
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p)) || !Number.isFinite(days)) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return Math.round((days * 86_400 + secs) * 1000);
}

/** The resident size and CPU time of `pid` right now: /proc on Linux, ps elsewhere. */
function sampleProcess(pid: number): Sample | null {
  const atMs = Date.now();
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^VmRSS:\s+(\d+) kB/m.exec(status);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the ")" that closes comm: state, ppid, pgrp, session,
      // tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(after[11]) + Number(after[12]);
      // /proc reports CPU time in USER_HZ ticks, 100 per second on Linux.
      return { atMs, rssBytes: m ? Number(m[1]) * 1024 : 0, cpuMs: Number.isFinite(ticks) ? Math.round(ticks * 10) : null };
    } catch {
      return null;
    }
  }
  const r = Bun.spawnSync(["ps", "-o", "rss=,cputime=", "-p", String(pid)]);
  const text = r.stdout.toString().trim();
  if (!text) return null;
  const [rssKb, cpu] = text.split(/\s+/);
  return { atMs, rssBytes: Number(rssKb) * 1024, cpuMs: parseCpuTime(cpu ?? "") };
}

/** Run the long-running daemon for `durationMs`, calling `during` on its
 *  schedule and sampling the process once a second, then SIGTERM it and wait
 *  for the exit. */
async function runDaemon(
  cmd: string[],
  env: Record<string, string>,
  durationMs: number,
  during?: { everyMs: number; fn: (n: number) => void },
  sample = false,
): Promise<Usage & { stdout: string; samples: Sample[] }> {
  const startedAt = Date.now();
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const samples: Sample[] = [];
  let n = 0;
  let nextAt = startedAt + (during?.everyMs ?? Infinity);
  let nextSample = startedAt + 1000;
  while (Date.now() - startedAt < durationMs && proc.exitCode === null && proc.signalCode === null) {
    if (during && Date.now() >= nextAt) {
      during.fn(n++);
      nextAt += during.everyMs;
    }
    if (sample && Date.now() >= nextSample) {
      const s = sampleProcess(proc.pid);
      if (s) samples.push(s);
      nextSample += 1000;
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
  return { ...usageOf(proc, startedAt, proc.signalCode ?? String(code)), stdout, samples };
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
/** rusage's ru_maxrss is kilobytes on Linux and bytes on macOS. */
const maxRssUnit = process.platform === "linux" ? "ru_maxrss (kilobytes)" : "ru_maxrss (bytes)";

const rows: Row[] = [];
function row(measurement: string, metric: string, unit: string, ref: number | string, cand: number | string): void {
  rows.push({ measurement, metric, unit, reference: ref, candidate: cand });
}

/** Median of a list (0 when empty). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** CPU as a share of one core and the resident sizes over the samples taken
 *  after `warmupMs`. CPU comes from the first and last sample's cumulative
 *  CPU time over the wall time between them. */
function idleFromSamples(samples: Sample[], startedAt: number, warmupMs: number): Measurement {
  const idle = samples.filter((s) => s.atMs - startedAt >= warmupMs);
  const withCpu = idle.filter((s) => s.cpuMs !== null);
  const first = withCpu[0];
  const last = withCpu[withCpu.length - 1];
  const cpuPercent =
    first && last && last !== first && last.atMs > first.atMs ? Math.round((((last.cpuMs ?? 0) - (first.cpuMs ?? 0)) / (last.atMs - first.atMs)) * 1000) / 10 : -1;
  const rss = idle.map((s) => s.rssBytes);
  return {
    idleSamples: idle.length,
    idleWindowSecs: idle.length >= 2 ? Math.round((idle[idle.length - 1]!.atMs - idle[0]!.atMs) / 1000) : 0,
    idleCpuPercent: cpuPercent,
    idleRssMedianBytes: median(rss),
    idleRssMaxBytes: rss.length ? Math.max(...rss) : 0,
    idleRssLastBytes: rss.length ? rss[rss.length - 1]! : 0,
    startupRssMaxBytes: samples.length ? Math.max(...samples.map((s) => s.rssBytes)) : 0,
  };
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

async function measureIdle(binary: string, who: string, shape: Manifest["shape"], label: string): Promise<Measurement> {
  const h = await prepareHome(binary, label, shape);
  try {
    await runOnce([binary, "watch", "--once"], h.env, 900_000); // catch up
    await runOnce([binary, "watch", "--once"], h.env, 900_000);
    const result: Measurement = {};
    const IDLE_MS = 75_000;
    const strace = process.platform === "linux" ? Bun.which("strace") : null;
    const timeout = Bun.which("timeout");
    if (strace && timeout) {
      // The per-syscall summary is written into the artifact directory, so
      // the split between the safety sweep, the tick's reads and the watch
      // itself can be read after the run.
      const summary = join(out, `strace-${label}-${who}.txt`);
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
    const plain = await runDaemon([binary, "watch"], h.env, 60_000, undefined, true);
    result.idleCpuPercent = Math.round((plain.cpuMs / plain.elapsedMs) * 1000) / 10;
    result.idleMaxRss = plain.maxRssBytes;
    result.idleWrites = bytesOut(plain);
    result.idleExit = plain.exit;
    Object.assign(result, prefixKeys("sampled", idleFromSamples(plain.samples, Date.now() - plain.elapsedMs, 20_000)));
    return result;
  } finally {
    h.gateway.stop();
  }
}

function prefixKeys(prefix: string, m: Measurement): Measurement {
  const out: Measurement = {};
  for (const [k, v] of Object.entries(m)) out[`${prefix}${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v;
  return out;
}

// ── workflow-retries (the backoff, the stuck-line key) ──────────────────────

async function measureBackoff(binary: string, name: string): Promise<Measurement> {
  const scenario = scenarioByName("daemon-backoff");
  const outDir = join(out, "daemon-backoff", name);
  const meta = await runScenario({ binary, name: name === "candidate" ? candidateName : "hx", scenario, outDir, home: join(workDir, "home-backoff"), workDir, log: () => {} });
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

// ── founder (the hx2 exit check: memory and idle CPU on a founder-sized tree) ─

const FOUNDER_WARMUP_MS = 30_000;
const FOUNDER_IDLE_MS = 120_000;

async function measureFounder(binary: string): Promise<Measurement> {
  const h = await prepareHome(binary, "founder", "founder");
  try {
    const first = await runOnce([binary, "watch", "--once"], h.env, 1_800_000);
    const second = await runOnce([binary, "watch", "--once"], h.env, 1_800_000);
    const daemon = await runDaemon([binary, "watch"], h.env, FOUNDER_WARMUP_MS + FOUNDER_IDLE_MS, undefined, true);
    const startedAt = Date.now() - daemon.elapsedMs;
    const commits = h.gateway.record.filter((r) => r.path === "/sessions/commit").length;
    return {
      sessions: h.manifest.sessions.length,
      ccdFiles: 36_000,
      firstPassElapsedMs: first.elapsedMs,
      firstPassCpuMs: first.cpuMs,
      firstPassMaxRss: first.maxRssBytes,
      firstPassExit: first.exit,
      secondPassElapsedMs: second.elapsedMs,
      secondPassCpuMs: second.cpuMs,
      secondPassMaxRss: second.maxRssBytes,
      daemonSecs: Math.round(daemon.elapsedMs / 1000),
      daemonCpuMs: daemon.cpuMs,
      daemonMaxRss: daemon.maxRssBytes,
      daemonWrites: bytesOut(daemon),
      daemonCommits: commits,
      daemonExit: daemon.exit,
      warmupSecs: FOUNDER_WARMUP_MS / 1000,
      ...idleFromSamples(daemon.samples, startedAt, FOUNDER_WARMUP_MS),
    };
  } finally {
    h.gateway.stop();
  }
}

// ── Run everything requested, both binaries ────────────────────────────────

const results: Record<string, { reference: Measurement; candidate: Measurement }> = {};
async function both(name: string, fn: (binary: string, who: "reference" | "candidate") => Promise<Measurement>): Promise<void> {
  log(`\n=== ${name}`);
  const ref = await fn(reference!, "reference");
  log(`    reference: ${JSON.stringify(ref)}`);
  const cand = await fn(candidate!, "candidate");
  log(`    candidate: ${JSON.stringify(cand)}`);
  results[name] = { reference: ref, candidate: cand };
}

if (only.has("writes")) await both("writes", (b) => measureWrites(b));
if (only.has("idle")) await both("idle", (b, who) => measureIdle(b, who, "claude-like", "idle"));
if (only.has("idle-hot")) await both("idle-hot", (b, who) => measureIdle(b, who, "hot-claude-like", "idle-hot"));
if (only.has("backoff")) await both("backoff", (b, who) => measureBackoff(b, who));
if (only.has("ccd-index") && process.platform === "darwin") await both("ccd-index", (b) => measureCcdIndex(b));
if (only.has("founder")) await both("founder", (b) => measureFounder(b));

// ── Report ──────────────────────────────────────────────────────────────────

const R = results["writes"];
if (R) {
  row("writes-per-pass", "state.json before the pass", "bytes", R.reference.stateBytes!, R.candidate.stateBytes!);
  row("writes-per-pass", `disk writes of one pass (${R.reference.grownTranscripts} grown transcripts)`, outUnit, R.reference.passWrites!, R.candidate.passWrites!);
  row("writes-per-pass", "journal left after the pass", "bytes", R.reference.journalAfterPass!, R.candidate.journalAfterPass!);
  row("writes-daemon", `disk writes of a 45 s daemon (${R.reference.daemonCommits} commits)`, outUnit, R.reference.daemonWrites!, R.candidate.daemonWrites!);
  row("writes-daemon", "daemon CPU time", "ms", R.reference.daemonCpuMs!, R.candidate.daemonCpuMs!);
}
function idleRows(name: string, label: string): void {
  const I = results[name];
  if (!I) return;
  if (I.reference.fileChecksPerSec !== undefined) {
    row(`${name}-syscalls`, `file checks per second at idle (stat + open + readdir, ${I.reference.tracedSecs} s)`, "calls/s", I.reference.fileChecksPerSec!, I.candidate.fileChecksPerSec!);
    row(`${name}-syscalls`, "stat family", "calls/s", I.reference.statPerSec!, I.candidate.statPerSec!);
    row(`${name}-syscalls`, "open", "calls/s", I.reference.openPerSec!, I.candidate.openPerSec!);
    row(`${name}-syscalls`, "readdir", "calls/s", I.reference.readdirPerSec!, I.candidate.readdirPerSec!);
    row(`${name}-syscalls`, "read", "calls/s", I.reference.readPerSec!, I.candidate.readPerSec!);
    row(`${name}-syscalls`, "all system calls", "calls/s", I.reference.syscallsPerSec!, I.candidate.syscallsPerSec!);
  }
  row(`${name}-cpu`, `CPU of a 60 s idle daemon (${label})`, "% of one core", I.reference.idleCpuPercent!, I.candidate.idleCpuPercent!);
  row(`${name}-cpu`, "CPU over the last 40 s of that daemon (sampled)", "% of one core", I.reference.sampledIdleCpuPercent!, I.candidate.sampledIdleCpuPercent!);
  row(`${name}-cpu`, "maximum RSS", maxRssUnit, I.reference.idleMaxRss!, I.candidate.idleMaxRss!);
  row(`${name}-cpu`, "resident size over the last 40 s, median (sampled)", "bytes", I.reference.sampledIdleRssMedianBytes!, I.candidate.sampledIdleRssMedianBytes!);
  row(`${name}-cpu`, "disk writes while idle", outUnit, I.reference.idleWrites!, I.candidate.idleWrites!);
}
idleRows("idle", "600 sessions, 60 lanes, 30 runs");
idleRows("idle-hot", "600 parent transcripts, the hot-path shape");
const B = results["backoff"];
if (B) {
  row("workflow-retries", `refused workflow uploads in the ${B.reference.daemonSecs} s daemon-backoff run`, "requests", B.reference.workflowUploadsRefused!, B.candidate.workflowUploadsRefused!);
  row("workflow-retries", "[error] workflow lines", "lines", B.reference.workflowErrorLines!, B.candidate.workflowErrorLines!);
  row("stuck-line", "[stuck] lines in the same run", "lines", B.reference.stuckLines!, B.candidate.stuckLines!);
  row("stuck-line", "daemon log lines in total", "lines", B.reference.logLines!, B.candidate.logLines!);
}
const C = results["ccd-index"];
if (C) {
  row("ccd-index", `second one-shot pass with ${C.reference.ccdFiles} Claude Desktop files: block reads`, inUnit, C.reference.secondPassReads!, C.candidate.secondPassReads!);
  row("ccd-index", "second pass CPU time", "ms", C.reference.secondPassCpuMs!, C.candidate.secondPassCpuMs!);
  row("ccd-index", "second pass maximum RSS", maxRssUnit, C.reference.secondPassMaxRss!, C.candidate.secondPassMaxRss!);
  row("ccd-index", "second pass wall time", "ms", C.reference.secondPassElapsedMs!, C.candidate.secondPassElapsedMs!);
  row("ccd-index", "saved index", "bytes", C.reference.savedIndexBytes!, C.candidate.savedIndexBytes!);
}
const F = results["founder"];
if (F) {
  row("founder", `transcripts in the tree (plus ${F.reference.ccdFiles} Claude Desktop files)`, "sessions", F.reference.sessions!, F.candidate.sessions!);
  row("founder", "first one-shot pass: wall time", "ms", F.reference.firstPassElapsedMs!, F.candidate.firstPassElapsedMs!);
  row("founder", "first one-shot pass: CPU time", "ms", F.reference.firstPassCpuMs!, F.candidate.firstPassCpuMs!);
  row("founder", "first one-shot pass: maximum RSS", maxRssUnit, F.reference.firstPassMaxRss!, F.candidate.firstPassMaxRss!);
  row("founder", "second one-shot pass: wall time", "ms", F.reference.secondPassElapsedMs!, F.candidate.secondPassElapsedMs!);
  row("founder", "second one-shot pass: CPU time", "ms", F.reference.secondPassCpuMs!, F.candidate.secondPassCpuMs!);
  row("founder", "second one-shot pass: maximum RSS", maxRssUnit, F.reference.secondPassMaxRss!, F.candidate.secondPassMaxRss!);
  row("founder-idle", `daemon: idle CPU over ${F.reference.idleWindowSecs} s after a ${F.reference.warmupSecs} s warm-up (sampled)`, "% of one core", F.reference.idleCpuPercent!, F.candidate.idleCpuPercent!);
  row("founder-idle", "daemon: resident size while idle, median (sampled)", "bytes", F.reference.idleRssMedianBytes!, F.candidate.idleRssMedianBytes!);
  row("founder-idle", "daemon: resident size while idle, maximum (sampled)", "bytes", F.reference.idleRssMaxBytes!, F.candidate.idleRssMaxBytes!);
  row("founder-idle", "daemon: resident size at the end (sampled)", "bytes", F.reference.idleRssLastBytes!, F.candidate.idleRssLastBytes!);
  row("founder-idle", "daemon: resident size peak over the whole run, including the start-up pass (sampled)", "bytes", F.reference.startupRssMaxBytes!, F.candidate.startupRssMaxBytes!);
  row("founder-idle", `daemon: CPU time over the whole ${F.reference.daemonSecs} s run (rusage)`, "ms", F.reference.daemonCpuMs!, F.candidate.daemonCpuMs!);
  row("founder-idle", "daemon: maximum RSS over the whole run", maxRssUnit, F.reference.daemonMaxRss!, F.candidate.daemonMaxRss!);
  row("founder-idle", "daemon: disk writes over the whole run", outUnit, F.reference.daemonWrites!, F.candidate.daemonWrites!);
  row("founder-idle", "daemon: how it ended", "exit", F.reference.daemonExit!, F.candidate.daemonExit!);
}

const fmt = (v: number | string): string => (typeof v === "number" ? v.toLocaleString("en-US") : v);
const md: string[] = [];
md.push(`# Measurements (${process.platform}-${process.arch})`);
md.push("");
md.push(
  `Reference \`${reference}\`, candidate \`${candidate}\` (${candidateName}), ${new Date().toISOString()}. Every number is the operating system's view of the process (rusage, strace, /proc or ps samples); nothing is instrumented inside the binary.`,
);
md.push("");
md.push("| Measurement | Metric | Unit | Reference | Candidate |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of rows) md.push(`| ${r.measurement} | ${r.metric} | ${r.unit} | ${fmt(r.reference)} | ${fmt(r.candidate)} |`);
md.push("");
writeFileSync(join(out, "measurements.json"), JSON.stringify({ platform: `${process.platform}-${process.arch}`, reference, candidate, candidateName, generatedAt: new Date().toISOString(), rows, raw: results }, null, 2));
writeFileSync(join(out, "measurements.md"), `${md.join("\n")}\n`);
log(`\n${md.join("\n")}`);
