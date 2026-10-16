// The measurement runner: the numbers behind the TypeScript design fixes
// (HX2 program, Build hx2 step 3) and the Rust port's exit check (steps 4
// and 5), produced on the CI runner for a reference binary and a candidate,
// side by side.
//
//   bun harness/run/measure.ts --reference <bin> --candidate <bin> --out <dir> --work <dir>
//       [--only writes,idle,backoff,ccd-index,founder,idle-hot] [--candidate-name hx2]
//       [--variant <bin> --variant-name "<label>"]
//
// Each measurement runs the same fixture and the same steps with both
// binaries and records what the operating system can tell about the process:
// CPU time, maximum resident size, block I/O (rusage, through Bun.spawn's
// resourceUsage()), on Linux the system calls strace counts, and for the
// idle daemon its resident memory and CPU time sampled once a second from
// outside the process (/proc on Linux; ps and proc_pid_rusage on macOS).
// Nothing is instrumented inside the binary. What is measured, and the fix
// or check it measures:
//
//   writes-per-pass      one-shot pass, 10 grown transcripts, a 5 MB state:
//                        bytes written per pass (the offsets journal)
//   writes-daemon        the same growth fed to a running daemon for 45 s
//   idle-syscalls        a daemon idle for 75 s on a 600-session tree under
//                        strace -c (Linux): file checks per second (file
//                        events + the lane and workflow gates); then a second
//                        daemon traced for 45 s with every stat-family and
//                        readlink call's path (harness/lib/stat-trace.ts),
//                        the first 15 s — the start-up pass — counted apart,
//                        into <label>-<who>-stat-paths.txt
//   idle-cpu             the same daemon without strace: CPU% and RSS
//   idle-memory          that daemon's resident memory over its 60 s: VmRSS,
//                        VmHWM, RssAnon, RssFile, AnonHugePages, threads,
//                        inotify watches and child processes (Linux; RSS
//                        from ps and the physical footprint on macOS), and
//                        the mappings behind the peak
//   watch-only           a bare Bun script holding fs.watch(recursive) on
//                        the same tree, with and without the watch: the
//                        memory of the runtime's watcher by itself
//   workflow-retries     the daemon-backoff scenario: refused workflow
//                        uploads and [stuck] lines in 50 s (the backoff and
//                        the dedupe key)
//   ccd-index            a one-shot pass with 10,000 Claude Desktop files,
//                        second run: block reads, CPU, RSS (the saved index,
//                        macOS only — the store exists only there)
//   idle-hot             idle-syscalls + idle-cpu + idle-memory on the
//                        hot-path shape (600 parent transcripts, nothing else)
//   founder              the hx2 exit check: a tree the size of the founder's
//                        laptop (4,800 transcripts, 36,000 Claude Desktop
//                        files): the catch-up passes, then the daemon idle for
//                        two minutes after a 30 s warm-up, sampled every
//                        second — median and maximum resident size (and, on
//                        macOS, the physical footprint), CPU as a share of one
//                        core, against the program's 50 MB and 1%
//
// A third binary, --variant, joins the idle measurements when given: the
// workflow builds the candidate with harness/variants/no-file-events.patch
// applied (Linux), so the cost of the recursive watch is measured on its own.
//
// macOS memory is read two ways. `ps` reports the resident set size, which
// counts pages the process gave back as reusable (malloc_zone_pressure_relief
// marks them and the kernel keeps them resident until it needs them); the
// physical footprint — the number Activity Monitor shows, read through
// proc_pid_rusage by harness/run/phys-footprint.c, compiled with the runner's
// cc — does not. Both are reported for every macOS sample.
//
// Nothing here runs on a laptop by design: .github/workflows/differential.yml
// runs it in the `measure` jobs and attaches measurements.json / .md, the
// per-second memory samples, the strace summaries and the smaps of the peak.

import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import { FakeGateway } from "../gateway/gateway.js";
import { CCD_DIR_MTIME_SEC, ccdMtimeSec, generateHome, type Manifest } from "../fixtures/gen-home.js";
import { ccdIndexByteDiffs } from "../lib/compare.js";
import { summarizeStatTrace } from "../lib/stat-trace.js";
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
const variant = arg("variant");
const variantName = arg("variant-name", "variant") ?? "variant";
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
  console.error("usage: measure.ts --reference <bin> --candidate <bin> [--variant <bin> --variant-name <label>] [--only a,b] [--candidate-name hx2] [--out dir] [--work dir]");
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
  /** The process's maximum resident size: on Linux VmHWM from /proc, read
   *  every 50 ms while it ran (see maxRssOf); on macOS ru_maxrss. */
  maxRssBytes: number;
  /** ru_maxrss as Bun's resourceUsage() hands it back (kilobytes on Linux
   *  scaled to bytes here, bytes on macOS). On Linux this is not the child's
   *  figure: see the rusage-check measurement. */
  bunMaxRssBytes: number;
  blocksIn: number;
  blocksOut: number;
  exit: string;
}

type Measurement = Record<string, number | string>;
type Who = "reference" | "candidate" | "variant";
interface Row {
  measurement: string;
  metric: string;
  unit: string;
  reference: number | string;
  candidate: number | string;
  variant?: number | string;
}

/** The child's VmHWM (its maximum resident size, in kB, as the kernel keeps
 *  it) read from /proc while it runs: a `Hwm` is polled every 50 ms by
 *  runOnce and runDaemon and keeps the highest reading. The mark only ever
 *  grows, so the last reading before the exit is the figure. Linux only. */
class Hwm {
  kb = -1;
  poll(pid: number): void {
    if (process.platform !== "linux") return;
    const v = procNumber(readOr(`/proc/${pid}/status`), "VmHWM");
    if (v > this.kb) this.kb = v;
  }
}

/** Bun 1.3 hands resourceUsage().maxRSS back as the kernel gave it —
 *  ru_maxrss is kilobytes on Linux and bytes on macOS (getrusage(2)) — and
 *  Bun 1.4 reports bytes on every platform. The table says bytes, so the
 *  scale follows the Bun version: a 1.4 upgrade would otherwise multiply the
 *  Linux figure by 1,024 once more. */
export function bunMaxRssToBytes(maxRss: number, bunVersion: string = Bun.version, platform: string = process.platform): number {
  if (!(maxRss >= 0)) return -1;
  const [major = 0, minor = 0] = bunVersion.split(".").map((p) => Number(p));
  const bytesAlready = major > 1 || (major === 1 && minor >= 4);
  if (bytesAlready) return maxRss;
  return platform === "linux" ? maxRss * 1024 : maxRss;
}

function usageOf(proc: ReturnType<typeof Bun.spawn>, startedAt: number, exit: string, hwm: Hwm): Usage {
  const u = proc.resourceUsage();
  // Bun 1.3 hands the CPU times back as BigInt (microseconds) although the
  // declaration says number; every field goes through Number() so arithmetic
  // and JSON.stringify never meet a BigInt.
  const n = (v: unknown): number => Number(v);
  // The 77.12.0 run printed the Linux figure unscaled; see bunMaxRssToBytes.
  // On Linux the figure is not the child's (rusage-check below), so the
  // maximum RSS the rows trust is the polled VmHWM there.
  const bunMaxRss = u ? n(u.maxRSS) : -1;
  const bunMaxRssBytes = bunMaxRssToBytes(bunMaxRss);
  return {
    elapsedMs: Date.now() - startedAt,
    cpuMs: u ? Math.round(n(u.cpuTime.total) / 1000) : -1,
    maxRssBytes: process.platform === "linux" ? (hwm.kb > 0 ? hwm.kb * 1024 : -1) : bunMaxRssBytes,
    bunMaxRssBytes,
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
  const hwm = new Hwm();
  const poll = setInterval(() => hwm.poll(proc.pid), 50);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  clearInterval(poll);
  if (proc.signalCode || code !== 0) log(`    ${cmd.slice(1).join(" ")}: exit ${proc.signalCode ?? code}\n${stderr.slice(0, 800)}`);
  return { ...usageOf(proc, startedAt, proc.signalCode ?? String(code), hwm), stdout };
}

/** Something to do while the daemon runs: on a schedule (`during`), or a
 *  sample of the process taken from outside it (`sample`, given its pid). */
interface Schedule {
  everyMs: number;
  fn: (n: number) => void;
}
interface Sampler {
  everyMs: number;
  fn: (pid: number, elapsedMs: number) => void;
}

/** Run the long-running daemon for `durationMs`, calling `during` on its
 *  schedule and `sample` on its own, then SIGTERM it and wait for the exit. */
async function runDaemon(cmd: string[], env: Record<string, string>, durationMs: number, during?: Schedule, sample?: Sampler): Promise<Usage & { stdout: string }> {
  const startedAt = Date.now();
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  let n = 0;
  let nextAt = startedAt + (during?.everyMs ?? Infinity);
  let nextSampleAt = startedAt + (sample?.everyMs ?? Infinity);
  const hwm = new Hwm();
  const alive = (): boolean => proc.exitCode === null && proc.signalCode === null;
  while (Date.now() - startedAt < durationMs && alive()) {
    hwm.poll(proc.pid);
    if (during && Date.now() >= nextAt) {
      during.fn(n++);
      nextAt += during.everyMs;
    }
    if (sample && Date.now() >= nextSampleAt) {
      sample.fn(proc.pid, Date.now() - startedAt);
      nextSampleAt += sample.everyMs;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // The last sample is taken at the end of the window, before the stop.
  if (sample && alive()) sample.fn(proc.pid, Date.now() - startedAt);
  // A command that ended on its own (a `timeout`-wrapped daemon) needs no stop.
  if (alive()) proc.kill("SIGTERM");
  const stopAt = Date.now() + 20_000;
  while (Date.now() < stopAt && alive()) {
    hwm.poll(proc.pid);
    await new Promise((r) => setTimeout(r, 50));
  }
  if (alive()) proc.kill("SIGKILL");
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([out, err]);
  if (!proc.signalCode || proc.signalCode !== "SIGTERM") log(`    daemon ended ${proc.signalCode ?? code}: ${stderr.slice(0, 400)}`);
  return { ...usageOf(proc, startedAt, proc.signalCode ?? String(code), hwm), stdout };
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
const maxRssHow = process.platform === "linux" ? "VmHWM, polled every 50 ms" : "ru_maxrss";

const rows: Row[] = [];
function row(measurement: string, metric: string, unit: string, ref: number | string, cand: number | string, vari?: number | string): void {
  rows.push({ measurement, metric, unit, reference: ref, candidate: cand, ...(vari === undefined ? {} : { variant: vari }) });
}
const fmt = (v: number | string): string => (typeof v === "number" ? v.toLocaleString("en-US") : v);

// ── Resident memory, sampled from outside the process ───────────────────────

interface MemSample {
  atMs: number;
  /** VmRSS (Linux) or the rss column of ps (macOS), kB. */
  rssKb: number;
  /** The physical footprint (macOS: proc_pid_rusage's ri_phys_footprint, the
   *  number Activity Monitor shows), kB. -1 off macOS, or when the helper
   *  could not be built. */
  footprintKb: number;
  /** CPU time the process has consumed so far (user + system), ms; null
   *  when unreadable. From /proc/<pid>/stat on Linux, ps cputime on macOS. */
  cpuMs: number | null;
  /** VmHWM: the kernel's high-water mark of VmRSS, the number ru_maxrss
   *  reports for the process itself. -1 off Linux. */
  hwmKb: number;
  anonKb: number;
  fileKb: number;
  anonHugeKb: number;
  /** LazyFree: pages the process gave back with madvise(MADV_FREE) that the
   *  kernel has not reclaimed yet. They still count in VmRSS until it does,
   *  so a Linux RSS can hold memory nothing in the process uses. -1 off Linux. */
  lazyFreeKb: number;
  threads: number;
  /** inotify instances the process holds, and the watches across them. */
  inotifyInstances: number;
  inotifyWatches: number;
  /** Child processes alive at the sample, and the largest one's RSS: the
   *  rusage of a waited-for process carries the largest child it reaped. */
  children: number;
  childRssKb: number;
}

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** `Key:   12345 kB` (or a bare number) out of a /proc text; -1 when absent. */
function procNumber(text: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
  return m ? Number(m[1]) : -1;
}

/** CPU time of a Linux process from /proc/<pid>/stat, in ms: utime + stime,
 *  in USER_HZ ticks (100 a second on Linux). null when unreadable. */
function procCpuMs(pid: number): number | null {
  const stat = readOr(`/proc/${pid}/stat`);
  if (!stat) return null;
  // Fields after the ")" that closes comm: state, ppid, pgrp, session,
  // tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime.
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(after[11]) + Number(after[12]);
  return Number.isFinite(ticks) ? Math.round(ticks * 10) : null;
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

function sampleLinux(pid: number, atMs: number): MemSample | null {
  const status = readOr(`/proc/${pid}/status`);
  if (!status) return null;
  const rollup = readOr(`/proc/${pid}/smaps_rollup`);
  let children = 0;
  let childRssKb = 0;
  let inotifyInstances = 0;
  let inotifyWatches = 0;
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      for (const child of readOr(`/proc/${pid}/task/${tid}/children`).trim().split(/\s+/).filter(Boolean)) {
        children += 1;
        childRssKb = Math.max(childRssKb, procNumber(readOr(`/proc/${child}/status`), "VmRSS"));
      }
    }
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target = "";
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (target !== "anon_inode:inotify") continue;
      inotifyInstances += 1;
      inotifyWatches += (readOr(`/proc/${pid}/fdinfo/${fd}`).match(/^inotify wd:/gm) ?? []).length;
    }
  } catch {
    // the process ended between two reads
  }
  return {
    atMs,
    rssKb: procNumber(status, "VmRSS"),
    footprintKb: -1,
    cpuMs: procCpuMs(pid),
    hwmKb: procNumber(status, "VmHWM"),
    anonKb: procNumber(status, "RssAnon"),
    fileKb: procNumber(status, "RssFile"),
    anonHugeKb: procNumber(rollup, "AnonHugePages"),
    lazyFreeKb: procNumber(rollup, "LazyFree"),
    threads: procNumber(status, "Threads"),
    inotifyInstances,
    inotifyWatches,
    children,
    childRssKb,
  };
}

function psRssKb(pid: string): number {
  const r = Bun.spawnSync(["ps", "-o", "rss=", "-p", pid]);
  const v = Number(r.stdout.toString().trim());
  return Number.isFinite(v) && v > 0 ? v : -1;
}

/** The phys-footprint helper (harness/run/phys-footprint.c), built once per
 *  run with the runner's cc; null where it cannot be built (not macOS, no
 *  compiler), in which case every macOS sample's footprint reads -1. */
let footprintHelper: string | null | undefined;
function footprintHelperPath(): string | null {
  if (footprintHelper !== undefined) return footprintHelper;
  footprintHelper = null;
  if (process.platform !== "darwin") return null;
  const cc = Bun.which("cc");
  if (!cc) {
    log("    phys-footprint: no cc on this runner; macOS samples carry the ps RSS only");
    return null;
  }
  const bin = join(workDir, "phys-footprint");
  const r = Bun.spawnSync([cc, "-O2", "-o", bin, join(import.meta.dir, "phys-footprint.c")]);
  if (r.exitCode !== 0) {
    log(`    phys-footprint: cc failed (${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`);
    return null;
  }
  footprintHelper = bin;
  return bin;
}

/** The physical footprint of a macOS process in kB, or -1. */
function footprintKbOf(pid: number): number {
  const helper = footprintHelperPath();
  if (!helper) return -1;
  const r = Bun.spawnSync([helper, String(pid)]);
  if (r.exitCode !== 0) return -1;
  const [footprint] = r.stdout.toString().trim().split(/\s+/);
  const bytes = Number(footprint);
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024) : -1;
}

function sampleDarwin(pid: number, atMs: number): MemSample | null {
  const r = Bun.spawnSync(["ps", "-o", "rss=,cputime=", "-p", String(pid)]);
  const text = r.stdout.toString().trim();
  if (!text) return null;
  const [rssText, cpu] = text.split(/\s+/);
  const rssKb = Number(rssText);
  if (!Number.isFinite(rssKb) || rssKb <= 0) return null;
  const kids = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim().split(/\s+/).filter(Boolean);
  let childRssKb = 0;
  for (const child of kids) childRssKb = Math.max(childRssKb, psRssKb(child));
  return {
    atMs,
    rssKb,
    footprintKb: footprintKbOf(pid),
    cpuMs: parseCpuTime(cpu ?? ""),
    hwmKb: -1,
    anonKb: -1,
    fileKb: -1,
    anonHugeKb: -1,
    lazyFreeKb: -1,
    threads: -1,
    inotifyInstances: -1,
    inotifyWatches: -1,
    children: kids.length,
    childRssKb,
  };
}

function sampleProcess(pid: number, atMs: number): MemSample | null {
  if (process.platform === "linux") return sampleLinux(pid, atMs);
  if (process.platform === "darwin") return sampleDarwin(pid, atMs);
  return null;
}

/** Resident kB per mapping name in a /proc/<pid>/smaps dump, largest first. */
function smapsByMapping(text: string, top: number): Array<{ mapping: string; rssKb: number; mappings: number }> {
  const agg = new Map<string, { rssKb: number; mappings: number }>();
  let current: { rssKb: number; mappings: number } | null = null;
  for (const line of text.split("\n")) {
    const header = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (header) {
      const name = header[1] || "[anonymous]";
      current = agg.get(name) ?? { rssKb: 0, mappings: 0 };
      current.mappings += 1;
      agg.set(name, current);
      continue;
    }
    const rss = /^Rss:\s+(\d+) kB/.exec(line);
    if (rss && current) current.rssKb += Number(rss[1]);
  }
  return [...agg]
    .map(([mapping, v]) => ({ mapping, ...v }))
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, top);
}

/** Median of a list (-1 when empty). */
function median(values: number[]): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function summarizeSamples(samples: MemSample[]): Measurement {
  if (samples.length === 0) return { memSamples: 0 };
  const last = samples[samples.length - 1]!;
  const peak = samples.reduce((a, b) => (b.rssKb > a.rssKb ? b : a));
  const tail = samples.filter((s) => s.atMs >= 30_000);
  const footprints = samples.filter((s) => s.footprintKb >= 0);
  return {
    memSamples: samples.length,
    rssEndKb: last.rssKb,
    rssPeakKb: peak.rssKb,
    rssPeakAtMs: peak.atMs,
    rssMedianLast30sKb: median(tail.map((s) => s.rssKb)),
    footprintEndKb: last.footprintKb,
    footprintPeakKb: footprints.length ? Math.max(...footprints.map((s) => s.footprintKb)) : -1,
    footprintMedianLast30sKb: median(tail.filter((s) => s.footprintKb >= 0).map((s) => s.footprintKb)),
    hwmEndKb: last.hwmKb,
    anonEndKb: last.anonKb,
    fileEndKb: last.fileKb,
    anonHugeEndKb: last.anonHugeKb,
    lazyFreeEndKb: last.lazyFreeKb,
    lazyFreePeakKb: Math.max(...samples.map((s) => s.lazyFreeKb)),
    threadsEnd: last.threads,
    inotifyInstancesEnd: last.inotifyInstances,
    inotifyWatchesEnd: last.inotifyWatches,
    childrenMax: Math.max(...samples.map((s) => s.children)),
    childRssMaxKb: Math.max(...samples.map((s) => s.childRssKb)),
  };
}

/** CPU as a share of one core and the resident sizes over the samples taken
 *  after `warmupMs`. CPU comes from the first and last sample's cumulative
 *  CPU time over the wall time between them: the operating system's own
 *  count, not the harness's. */
function idleFromSamples(samples: MemSample[], warmupMs: number): Measurement {
  const idle = samples.filter((s) => s.atMs >= warmupMs);
  const withCpu = idle.filter((s) => s.cpuMs !== null);
  const first = withCpu[0];
  const last = withCpu[withCpu.length - 1];
  const cpuPercent = first && last && last !== first && last.atMs > first.atMs ? Math.round((((last.cpuMs ?? 0) - (first.cpuMs ?? 0)) / (last.atMs - first.atMs)) * 1000) / 10 : -1;
  const rss = idle.map((s) => s.rssKb);
  const footprint = idle.filter((s) => s.footprintKb >= 0).map((s) => s.footprintKb);
  return {
    idleSamples: idle.length,
    idleWindowSecs: idle.length >= 2 ? Math.round((idle[idle.length - 1]!.atMs - idle[0]!.atMs) / 1000) : 0,
    idleCpuPercent: cpuPercent,
    idleRssMedianKb: median(rss),
    idleRssMaxKb: rss.length ? Math.max(...rss) : -1,
    idleRssLastKb: rss.length ? rss[rss.length - 1]! : -1,
    idleFootprintMedianKb: median(footprint),
    idleFootprintMaxKb: footprint.length ? Math.max(...footprint) : -1,
    idleFootprintLastKb: footprint.length ? footprint[footprint.length - 1]! : -1,
    startupRssMaxKb: samples.length ? Math.max(...samples.map((s) => s.rssKb)) : -1,
  };
}

/** The per-second samples and the peak's mappings, per run, for memory.md. */
const memoryDetails: Record<string, { samples: MemSample[]; peakMappings: ReturnType<typeof smapsByMapping> }> = {};

/** Sample a daemon once a second; keep the smaps of its highest VmRSS. The
 *  samples stay reachable through `samples` for the window summaries. */
/** `vmmapAtMs`: moments (ms after start) at which, on macOS, `vmmap
 *  --summary` records the malloc zones behind the footprint — how much of it
 *  is allocated and how much is freed memory the allocator still holds —
 *  into <label>-vmmap-<s>s.txt. */
function memorySampler(label: string, vmmapAtMs: number[] = []): { sampler: Sampler; samples: MemSample[]; finish: () => Measurement } {
  const samples: MemSample[] = [];
  const vmmapDue = [...vmmapAtMs];
  let peakRssKb = -1;
  let peakSmaps = "";
  return {
    samples,
    sampler: {
      everyMs: 1_000,
      fn: (pid, atMs) => {
        const s = sampleProcess(pid, atMs);
        if (!s) return;
        samples.push(s);
        if (process.platform === "linux" && s.rssKb > peakRssKb) {
          peakRssKb = s.rssKb;
          peakSmaps = readOr(`/proc/${pid}/smaps`);
        }
        while (process.platform === "darwin" && vmmapDue.length > 0 && atMs >= vmmapDue[0]!) {
          const at = vmmapDue.shift()!;
          // Reading another process's zones can need privileges: then sudo
          // (passwordless on the CI runner).
          let r = Bun.spawnSync(["vmmap", "--summary", String(pid)]);
          if (r.exitCode !== 0) r = Bun.spawnSync(["sudo", "-n", "vmmap", "--summary", String(pid)]);
          writeFileSync(join(out, `${label}-vmmap-${Math.round(at / 1000)}s.txt`), `${r.stdout.toString()}${r.stderr.toString()}`);
        }
      },
    },
    finish: () => {
      writeFileSync(join(out, `${label}-memory.jsonl`), `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
      if (peakSmaps) writeFileSync(join(out, `${label}-smaps-peak.txt`), peakSmaps);
      memoryDetails[label] = { samples, peakMappings: peakSmaps ? smapsByMapping(peakSmaps, 15) : [] };
      return summarizeSamples(samples);
    },
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
    const commits = h.gateway.stats().parentCommits;
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
      daemonBunMaxRss: daemon.bunMaxRssBytes,
      daemonExit: daemon.exit,
    };
  } finally {
    h.gateway.stop();
  }
}

// ── idle-syscalls / idle-cpu / idle-memory (file events, the gates) ─────────

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

/** The second idle daemon of the idle measurements, traced with every
 *  stat-family and readlink call's path; its first PATH_TRACE_STARTUP_MS
 *  hold the start-up pass. */
const PATH_TRACE_MS = 45_000;
const PATH_TRACE_STARTUP_MS = 15_000;

/** The idle daemon on one shape: `label` names the measurement (its home,
 *  its strace summary and memory samples), so `idle` and `idle-hot` keep
 *  their files apart. */
async function measureIdle(binary: string, who: Who, shape: Manifest["shape"], label: string): Promise<Measurement> {
  const h = await prepareHome(binary, label, shape);
  try {
    await runOnce([binary, "watch", "--once"], h.env, 900_000); // catch up
    await runOnce([binary, "watch", "--once"], h.env, 900_000);
    const result: Measurement = {};
    const IDLE_MS = 75_000;
    const strace = process.platform === "linux" ? Bun.which("strace") : null;
    const timeout = Bun.which("timeout");
    if (strace && timeout) {
      // The per-syscall summary is part of the artifact.
      const summary = join(out, `${label}-${who}-strace.txt`);
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
      const memory = sum(["mmap", "munmap", "mremap", "madvise", "mprotect", "brk"]);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      Object.assign(result, {
        tracedSecs: Math.round(secs),
        tracedExit: traced.exit,
        statPerSec: Math.round(stat / secs),
        openPerSec: Math.round(open / secs),
        readdirPerSec: Math.round(dents / secs),
        readPerSec: Math.round(read / secs),
        memoryCallsPerSec: Math.round(memory / secs),
        syscallsPerSec: Math.round(total / secs),
        fileChecksPerSec: Math.round((stat + open + dents) / secs),
      });
      // Which paths those stat calls take, from a second traced daemon: each
      // stat-family and readlink call with its path and a timestamp, the
      // start-up pass apart from the idle time after it (the summary above
      // counts both). Not for the variant, whose question is memory.
      if (who !== "variant") {
        const trace = join(workDir, `${label}-${who}-stat-trace.txt`);
        rmSync(trace, { force: true });
        await runDaemon(
          [strace, "-f", "-ttt", "-s", "4096", "-e", "trace=%%stat,readlink,readlinkat", "-o", trace, timeout, "-s", "TERM", String(PATH_TRACE_MS / 1000), binary, "watch"],
          h.env,
          PATH_TRACE_MS + 30_000,
        );
        if (existsSync(trace)) {
          const paths = summarizeStatTrace(readFileSync(trace, "utf8"), h.home, PATH_TRACE_STARTUP_MS, PATH_TRACE_MS);
          writeFileSync(join(out, `${label}-${who}-stat-paths.txt`), `${label}, ${who}: stat-family and readlink calls by path (strace -f -ttt, ${PATH_TRACE_MS / 1000} s; the first ${PATH_TRACE_STARTUP_MS / 1000} s hold the daemon's start-up pass)\n\n${paths.text}`);
          Object.assign(result, { idleStatPerSec: paths.idleStatPerSec, idleReadlinkPerSec: paths.idleReadlinkPerSec, startupStatCalls: paths.startupStatCalls });
          rmSync(trace, { force: true });
        }
      }
    } else {
      result.strace = "not available";
    }
    const memory = memorySampler(`${label}-${who}`);
    const plain = await runDaemon([binary, "watch"], h.env, 60_000, undefined, memory.sampler);
    result.idleCpuPercent = Math.round((plain.cpuMs / plain.elapsedMs) * 1000) / 10;
    result.idleMaxRss = plain.maxRssBytes;
    result.idleBunMaxRss = plain.bunMaxRssBytes;
    result.idleWrites = bytesOut(plain);
    result.idleExit = plain.exit;
    Object.assign(result, memory.finish());
    // The last 40 s, from the samples: CPU the operating system counted
    // while the daemon had nothing to do, apart from its start-up pass.
    const sampled = idleFromSamples(memory.samples, 20_000);
    result.sampledIdleCpuPercent = sampled.idleCpuPercent!;
    result.sampledIdleRssMedianKb = sampled.idleRssMedianKb!;
    result.sampledIdleFootprintMedianKb = sampled.idleFootprintMedianKb!;
    return result;
  } finally {
    h.gateway.stop();
  }
}

// ── watch-only (the runtime's recursive watcher by itself) ──────────────────

/** A bare Bun script (harness/run/watch-only.ts, run by the bun that runs
 *  this file) holds fs.watch(recursive) on the idle fixture's roots for 20 s,
 *  or holds nothing: the difference is the watcher's own memory. */
async function measureWatchOnly(home: string, armed: boolean): Promise<Measurement> {
  const memory = memorySampler(`watch-only-${armed ? "with" : "without"}`);
  const r = await runDaemon(
    [process.execPath, join(import.meta.dir, "watch-only.ts"), "--home", home, "--watch", armed ? "yes" : "no", "--seconds", "20"],
    clientEnv(home),
    30_000,
    undefined,
    memory.sampler,
  );
  let info: { dirCount?: number; events?: number; roots?: number } = {};
  try {
    info = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as typeof info;
  } catch {
    // the script died before its summary line; the samples still stand
  }
  return { exit: r.exit, cpuMs: r.cpuMs, maxRss: r.maxRssBytes, bunMaxRss: r.bunMaxRssBytes, roots: info.roots ?? -1, dirCount: info.dirCount ?? -1, events: info.events ?? -1, ...memory.finish() };
}

// ── rusage-check (what Bun's resourceUsage().maxRSS is on Linux) ─────────────

/** A child that touches `mb` megabytes, reads its own VmHWM from /proc and
 *  prints it, beside what Bun's resourceUsage() then reports for it and
 *  this process's own VmHWM at that moment. Linux only: the three numbers
 *  say whose high-water mark the field is. */
async function measureRusageCheck(mb: number): Promise<Measurement> {
  const script = `const a = new Uint8Array(${mb} * 1024 * 1024); a.fill(1); const s = require("node:fs").readFileSync("/proc/self/status", "utf8"); const m = /^VmHWM:\\s+(\\d+)/m.exec(s); console.log(JSON.stringify({ hwmKb: m ? Number(m[1]) : -1, sum: a[0] + a[a.length - 1] }));`;
  const r = await runOnce([process.execPath, "-e", script], clientEnv(workDir), 60_000);
  let own = -1;
  try {
    own = (JSON.parse(r.stdout.trim()) as { hwmKb: number }).hwmKb;
  } catch {
    // the child did not print its summary; the other two numbers still stand
  }
  return {
    touchedMb: mb,
    childOwnHwmKb: own,
    childPolledHwmKb: r.maxRssBytes > 0 ? Math.round(r.maxRssBytes / 1024) : -1,
    bunMaxRssKb: r.bunMaxRssBytes > 0 ? Math.round(r.bunMaxRssBytes / 1024) : -1,
    parentHwmKb: procNumber(readOr("/proc/self/status"), "VmHWM"),
    exit: r.exit,
  };
}

// ── workflow-retries (the backoff, the stuck-line key) ──────────────────────

async function measureBackoff(binary: string, who: Who): Promise<Measurement> {
  const scenario = scenarioByName("daemon-backoff");
  const outDir = join(out, "daemon-backoff", who);
  const meta = await runScenario({ binary, name: who === "reference" ? "hx" : candidateName, scenario, outDir, home: join(workDir, "home-backoff"), workDir, log: () => {} });
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

/** Each binary's saved index, kept for the byte comparison in the report. */
const savedCcdIndex: Partial<Record<Who, string>> = {};

async function measureCcdIndex(binary: string, who: Who): Promise<Measurement> {
  const h = await prepareHome(binary, "ccd", "small");
  try {
    const org = join(h.home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct_measure", "org_measure");
    mkdirSync(org, { recursive: true });
    const rng = new Prng("ccd-measure");
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const sid = rng.uuid();
      const p = join(org, `local_${sid}.json`);
      writeFileSync(p, JSON.stringify({ sessionId: `local_${sid}`, cliSessionId: rng.uuid(), title: rng.sentence(6), titleSource: i % 2 ? "user" : "ai", isArchived: false, lastActivityAt: 1_750_000_000_000 + i * 1000, cwd: `/work/${rng.alnum(5)}` }));
      // Fixed stamps, as the fixture's own Claude Desktop files have: with
      // the clock's, each binary's saved index printed its own 10,000
      // fractional mtimes, and the two files differed in size by chance.
      utimesSync(p, ccdMtimeSec(1_000 + i), ccdMtimeSec(1_000 + i));
    }
    utimesSync(org, CCD_DIR_MTIME_SEC, CCD_DIR_MTIME_SEC);
    const first = await runOnce([binary, "watch", "--once"], h.env, 600_000);
    const second = await runOnce([binary, "watch", "--once"], h.env, 600_000);
    const indexPath = join(h.home, ".let", "hx", "ccd-index.json");
    const saved = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    savedCcdIndex[who] = saved;
    return {
      ccdFiles: N,
      firstPassElapsedMs: first.elapsedMs,
      firstPassCpuMs: first.cpuMs,
      firstPassMaxRss: first.maxRssBytes,
      secondPassElapsedMs: second.elapsedMs,
      secondPassCpuMs: second.cpuMs,
      secondPassMaxRss: second.maxRssBytes,
      secondPassReads: bytesIn(second),
      savedIndexBytes: Buffer.byteLength(saved),
    };
  } finally {
    h.gateway.stop();
  }
}

// ── founder (the hx2 exit check: memory and idle CPU on a founder-sized tree) ─

const FOUNDER_WARMUP_MS = 30_000;
const FOUNDER_IDLE_MS = 120_000;

async function measureFounder(binary: string, who: Who): Promise<Measurement> {
  const h = await prepareHome(binary, "founder", "founder");
  try {
    const first = await runOnce([binary, "watch", "--once"], h.env, 1_800_000);
    const second = await runOnce([binary, "watch", "--once"], h.env, 1_800_000);
    // The zones at the end of the warm-up and near the end of the idle window.
    const memory = memorySampler(`founder-${who}`, [20_000, 140_000]);
    const daemon = await runDaemon([binary, "watch"], h.env, FOUNDER_WARMUP_MS + FOUNDER_IDLE_MS, undefined, memory.sampler);
    const commits = h.gateway.stats().parentCommits;
    const summary = memory.finish();
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
      ...summary,
      ...idleFromSamples(memory.samples, FOUNDER_WARMUP_MS),
    };
  } finally {
    h.gateway.stop();
  }
}

// ── The runner's environment ────────────────────────────────────────────────

function environment(): Record<string, string | number> {
  const e: Record<string, string | number> = {
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    kernel: osRelease(),
    totalMemoryBytes: totalmem(),
  };
  if (process.platform === "linux") {
    e.transparentHugepageEnabled = readOr("/sys/kernel/mm/transparent_hugepage/enabled").trim();
    e.transparentHugepageDefrag = readOr("/sys/kernel/mm/transparent_hugepage/defrag").trim();
    e.inotifyMaxUserWatches = readOr("/proc/sys/fs/inotify/max_user_watches").trim();
    e.inotifyMaxUserInstances = readOr("/proc/sys/fs/inotify/max_user_instances").trim();
  }
  if (process.platform === "darwin") e.physFootprintHelper = footprintHelperPath() ? "built" : "unavailable";
  return e;
}

// ── Run what was asked for, both binaries (and the variant where it applies) ─

const results: Record<string, { reference: Measurement; candidate: Measurement; variant?: Measurement }> = {};
async function both(name: string, fn: (binary: string, who: Who) => Promise<Measurement>, opts: { variant?: boolean } = {}): Promise<void> {
  log(`\n=== ${name}`);
  const ref = await fn(reference!, "reference");
  log(`    reference: ${JSON.stringify(ref)}`);
  const cand = await fn(candidate!, "candidate");
  log(`    candidate: ${JSON.stringify(cand)}`);
  results[name] = { reference: ref, candidate: cand };
  if (opts.variant && variant) {
    const vari = await fn(variant, "variant");
    log(`    ${variantName}: ${JSON.stringify(vari)}`);
    results[name]!.variant = vari;
  }
}

const env = environment();
log(`environment: ${JSON.stringify(env)}`);
const rusageChecks: Measurement[] = [];
if (process.platform === "linux" && only.has("idle")) {
  log("\n=== rusage-check (first)");
  rusageChecks.push(await measureRusageCheck(300));
  log(`    ${JSON.stringify(rusageChecks[0])}`);
}
if (only.has("writes")) await both("writes", (b) => measureWrites(b));
if (only.has("idle")) await both("idle", (b, who) => measureIdle(b, who, "claude-like", "idle"), { variant: true });
let watchOnly: { without: Measurement; with: Measurement } | null = null;
if (only.has("idle") && (process.platform === "linux" || process.platform === "darwin")) {
  log("\n=== watch-only");
  const home = join(workDir, "home-idle");
  watchOnly = { without: await measureWatchOnly(home, false), with: await measureWatchOnly(home, true) };
  log(`    without: ${JSON.stringify(watchOnly.without)}`);
  log(`    with: ${JSON.stringify(watchOnly.with)}`);
}
if (only.has("idle-hot")) await both("idle-hot", (b, who) => measureIdle(b, who, "hot-claude-like", "idle-hot"));
if (only.has("backoff")) await both("backoff", (b, who) => measureBackoff(b, who));
if (only.has("ccd-index") && process.platform === "darwin") await both("ccd-index", (b, who) => measureCcdIndex(b, who));
if (only.has("founder")) await both("founder", (b, who) => measureFounder(b, who));
if (process.platform === "linux" && only.has("idle")) {
  log("\n=== rusage-check (last)");
  rusageChecks.push(await measureRusageCheck(300));
  log(`    ${JSON.stringify(rusageChecks[1])}`);
}

// ── Report ──────────────────────────────────────────────────────────────────

const R = results["writes"];
if (R) {
  row("writes-per-pass", "state.json before the pass", "bytes", R.reference.stateBytes!, R.candidate.stateBytes!);
  row("writes-per-pass", `disk writes of one pass (${R.reference.grownTranscripts} grown transcripts)`, outUnit, R.reference.passWrites!, R.candidate.passWrites!);
  row("writes-per-pass", "journal left after the pass", "bytes", R.reference.journalAfterPass!, R.candidate.journalAfterPass!);
  row("writes-daemon", `disk writes of a 45 s daemon (${R.reference.daemonCommits} commits)`, outUnit, R.reference.daemonWrites!, R.candidate.daemonWrites!);
  row("writes-daemon", "daemon CPU time", "ms", R.reference.daemonCpuMs!, R.candidate.daemonCpuMs!);
  row("writes-daemon", `daemon maximum RSS (${process.platform === "linux" ? "VmHWM, polled" : "ru_maxrss"})`, "bytes", R.reference.daemonMaxRss!, R.candidate.daemonMaxRss!);
}
function idleRows(name: string, label: string): void {
  const I = results[name];
  if (!I) return;
  const V = I.variant;
  const vOf = (key: string): number | string | undefined => V?.[key];
  if (I.reference.fileChecksPerSec !== undefined) {
    row(`${name}-syscalls`, `file checks per second at idle (stat + open + readdir, ${I.reference.tracedSecs} s)`, "calls/s", I.reference.fileChecksPerSec!, I.candidate.fileChecksPerSec!, vOf("fileChecksPerSec"));
    row(`${name}-syscalls`, "stat family", "calls/s", I.reference.statPerSec!, I.candidate.statPerSec!, vOf("statPerSec"));
    row(`${name}-syscalls`, "open", "calls/s", I.reference.openPerSec!, I.candidate.openPerSec!, vOf("openPerSec"));
    row(`${name}-syscalls`, "readdir", "calls/s", I.reference.readdirPerSec!, I.candidate.readdirPerSec!, vOf("readdirPerSec"));
    row(`${name}-syscalls`, "read", "calls/s", I.reference.readPerSec!, I.candidate.readPerSec!, vOf("readPerSec"));
    row(`${name}-syscalls`, "memory (mmap, munmap, mremap, madvise, mprotect, brk)", "calls/s", I.reference.memoryCallsPerSec!, I.candidate.memoryCallsPerSec!, vOf("memoryCallsPerSec"));
    row(`${name}-syscalls`, "all system calls", "calls/s", I.reference.syscallsPerSec!, I.candidate.syscallsPerSec!, vOf("syscallsPerSec"));
  }
  if (I.reference.idleStatPerSec !== undefined && I.candidate.idleStatPerSec !== undefined) {
    const after = `after the first ${PATH_TRACE_STARTUP_MS / 1000} s of a ${PATH_TRACE_MS / 1000} s traced daemon (by path: ${name}-<who>-stat-paths.txt)`;
    row(`${name}-syscalls`, `stat family, ${after}`, "calls/s", I.reference.idleStatPerSec!, I.candidate.idleStatPerSec!);
    row(`${name}-syscalls`, `readlink, ${after}`, "calls/s", I.reference.idleReadlinkPerSec!, I.candidate.idleReadlinkPerSec!);
    row(`${name}-syscalls`, `stat family in those first ${PATH_TRACE_STARTUP_MS / 1000} s (the start-up pass)`, "calls", I.reference.startupStatCalls!, I.candidate.startupStatCalls!);
  }
  row(`${name}-cpu`, `CPU of a 60 s idle daemon (${label})`, "% of one core", I.reference.idleCpuPercent!, I.candidate.idleCpuPercent!, vOf("idleCpuPercent"));
  row(`${name}-cpu`, "CPU over the last 40 s of that daemon (sampled)", "% of one core", I.reference.sampledIdleCpuPercent!, I.candidate.sampledIdleCpuPercent!, vOf("sampledIdleCpuPercent"));
  row(`${name}-cpu`, `maximum RSS (${maxRssHow})`, "bytes", I.reference.idleMaxRss!, I.candidate.idleMaxRss!, vOf("idleMaxRss"));
  if (process.platform === "linux") {
    row(`${name}-cpu`, "maximum RSS as Bun's resourceUsage() reports it (ru_maxrss, scaled to bytes for this Bun version): not the daemon's figure, see rusage-check", "bytes", I.reference.idleBunMaxRss!, I.candidate.idleBunMaxRss!, vOf("idleBunMaxRss"));
  }
  row(`${name}-cpu`, "disk writes while idle", outUnit, I.reference.idleWrites!, I.candidate.idleWrites!, vOf("idleWrites"));
  if (I.reference.memSamples !== undefined && Number(I.reference.memSamples) > 0) {
    const sampledAs = process.platform === "linux" ? "VmRSS from /proc" : "RSS from ps";
    row(`${name}-memory`, `resident memory at the end of the 60 s (${sampledAs}, sampled once a second)`, "kB", I.reference.rssEndKb!, I.candidate.rssEndKb!, vOf("rssEndKb"));
    row(`${name}-memory`, "resident memory, median of the last 30 s", "kB", I.reference.rssMedianLast30sKb!, I.candidate.rssMedianLast30sKb!, vOf("rssMedianLast30sKb"));
    row(`${name}-memory`, "resident memory, highest sample", "kB", I.reference.rssPeakKb!, I.candidate.rssPeakKb!, vOf("rssPeakKb"));
    row(`${name}-memory`, "when the highest sample was taken", "ms after start", I.reference.rssPeakAtMs!, I.candidate.rssPeakAtMs!, vOf("rssPeakAtMs"));
    if (process.platform === "darwin") {
      row(`${name}-memory`, "physical footprint at the end (proc_pid_rusage: what Activity Monitor shows; reusable pages excluded)", "kB", I.reference.footprintEndKb!, I.candidate.footprintEndKb!);
      row(`${name}-memory`, "physical footprint, median of the last 30 s", "kB", I.reference.footprintMedianLast30sKb!, I.candidate.footprintMedianLast30sKb!);
      row(`${name}-memory`, "physical footprint, highest sample", "kB", I.reference.footprintPeakKb!, I.candidate.footprintPeakKb!);
    }
    if (process.platform === "linux") {
      row(`${name}-memory`, "VmHWM at the end (the kernel's high-water mark; ru_maxrss of the process itself)", "kB", I.reference.hwmEndKb!, I.candidate.hwmEndKb!, vOf("hwmEndKb"));
      row(`${name}-memory`, "RssAnon at the end", "kB", I.reference.anonEndKb!, I.candidate.anonEndKb!, vOf("anonEndKb"));
      row(`${name}-memory`, "RssFile at the end", "kB", I.reference.fileEndKb!, I.candidate.fileEndKb!, vOf("fileEndKb"));
      row(`${name}-memory`, "AnonHugePages at the end", "kB", I.reference.anonHugeEndKb!, I.candidate.anonHugeEndKb!, vOf("anonHugeEndKb"));
      row(`${name}-memory`, "LazyFree at the end (MADV_FREE pages still counted in RSS)", "kB", I.reference.lazyFreeEndKb!, I.candidate.lazyFreeEndKb!, vOf("lazyFreeEndKb"));
      row(`${name}-memory`, "LazyFree, highest sample", "kB", I.reference.lazyFreePeakKb!, I.candidate.lazyFreePeakKb!, vOf("lazyFreePeakKb"));
      row(`${name}-memory`, "threads at the end", "threads", I.reference.threadsEnd!, I.candidate.threadsEnd!, vOf("threadsEnd"));
      row(`${name}-memory`, "inotify instances at the end", "instances", I.reference.inotifyInstancesEnd!, I.candidate.inotifyInstancesEnd!, vOf("inotifyInstancesEnd"));
      row(`${name}-memory`, "inotify watches at the end", "watches", I.reference.inotifyWatchesEnd!, I.candidate.inotifyWatchesEnd!, vOf("inotifyWatchesEnd"));
    }
    row(`${name}-memory`, "child processes seen at once, at most", "processes", I.reference.childrenMax!, I.candidate.childrenMax!, vOf("childrenMax"));
    row(`${name}-memory`, "largest child process seen", "kB", I.reference.childRssMaxKb!, I.candidate.childRssMaxKb!, vOf("childRssMaxKb"));
  }
}
idleRows("idle", "600 sessions, 60 lanes, 30 runs");
idleRows("idle-hot", "600 parent transcripts, the hot-path shape");
if (watchOnly) {
  const w = watchOnly;
  const what = `a bare Bun ${Bun.version} script on the idle fixture's tree for 20 s, without fs.watch (reference column) and with fs.watch(recursive) on the ${w.with.roots} roots (candidate column)`;
  row("watch-only", `${what}: resident memory at the end`, "kB", w.without.rssEndKb!, w.with.rssEndKb!);
  row("watch-only", "the same: highest sample", "kB", w.without.rssPeakKb!, w.with.rssPeakKb!);
  row("watch-only", `the same: maximum RSS (${process.platform === "linux" ? "VmHWM, polled" : "ru_maxrss"})`, "bytes", w.without.maxRss!, w.with.maxRss!);
  row("watch-only", "the same: CPU time", "ms", w.without.cpuMs!, w.with.cpuMs!);
  row("watch-only", "directories under the roots", "directories", w.with.dirCount!, w.with.dirCount!);
  if (process.platform === "linux") row("watch-only", "inotify watches held at the end", "watches", w.without.inotifyWatchesEnd!, w.with.inotifyWatchesEnd!);
}
for (const [i, c] of rusageChecks.entries()) {
  const when = i === 0 ? "first thing in the job" : "last thing in the job";
  row("rusage-check", `a bare Bun child that touches ${c.touchedMb} MB, ${when}: VmHWM it read from its own /proc/self/status (reference column) and the figure Bun's resourceUsage().maxRSS gives its parent for it (candidate column)`, "kB", c.childOwnHwmKb!, c.bunMaxRssKb!);
  row("rusage-check", `the same child: VmHWM polled by the parent (reference column) and the parent's own VmHWM when it read the child's rusage (candidate column)`, "kB", c.childPolledHwmKb!, c.parentHwmKb!);
}
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
  row("ccd-index", "second pass maximum RSS", "bytes", C.reference.secondPassMaxRss!, C.candidate.secondPassMaxRss!);
  row("ccd-index", "second pass wall time", "ms", C.reference.secondPassElapsedMs!, C.candidate.secondPassElapsedMs!);
  row("ccd-index", "saved index", "bytes", C.reference.savedIndexBytes!, C.candidate.savedIndexBytes!);
  // The same check the differential runs on every scenario's saved index:
  // each file is exactly what JSON.stringify writes for its own content, and
  // every entry is byte-identical to the reference's for the same path (the
  // order of the entries is the reference's read race, savedAtMs its clock).
  const refSaved = savedCcdIndex.reference ?? "";
  const candSaved = savedCcdIndex.candidate ?? "";
  if (refSaved && candSaved) {
    const entries = (text: string): number => {
      const v = JSON.parse(text) as { dirs?: object; files?: object };
      return Object.keys(v.dirs ?? {}).length + Object.keys(v.files ?? {}).length;
    };
    const diffs = ccdIndexByteDiffs(refSaved, candSaved, (k) => k.split(workDir).join("<WORK>"));
    row("ccd-index", "saved index: entries (dirs and files)", "entries", entries(refSaved), entries(candSaved));
    row("ccd-index", "saved index: differences from the reference, byte for byte per entry (first 40 listed in the log)", "differences", 0, diffs.length);
    for (const d of diffs) log(`    ccd-index bytes: ${d}`);
  }
}
const F = results["founder"];
if (F) {
  const sampledAs = process.platform === "linux" ? "VmRSS from /proc" : "RSS from ps";
  row("founder", `transcripts in the tree (plus ${F.reference.ccdFiles} Claude Desktop files)`, "sessions", F.reference.sessions!, F.candidate.sessions!);
  row("founder", "first one-shot pass: wall time", "ms", F.reference.firstPassElapsedMs!, F.candidate.firstPassElapsedMs!);
  row("founder", "first one-shot pass: CPU time", "ms", F.reference.firstPassCpuMs!, F.candidate.firstPassCpuMs!);
  row("founder", `first one-shot pass: maximum RSS (${maxRssHow})`, "bytes", F.reference.firstPassMaxRss!, F.candidate.firstPassMaxRss!);
  row("founder", "second one-shot pass: wall time", "ms", F.reference.secondPassElapsedMs!, F.candidate.secondPassElapsedMs!);
  row("founder", "second one-shot pass: CPU time", "ms", F.reference.secondPassCpuMs!, F.candidate.secondPassCpuMs!);
  row("founder", `second one-shot pass: maximum RSS (${maxRssHow})`, "bytes", F.reference.secondPassMaxRss!, F.candidate.secondPassMaxRss!);
  row("founder-idle", `daemon: idle CPU over ${F.reference.idleWindowSecs} s after a ${F.reference.warmupSecs} s warm-up (sampled)`, "% of one core", F.reference.idleCpuPercent!, F.candidate.idleCpuPercent!);
  row("founder-idle", `daemon: resident size while idle, median (${sampledAs}, sampled)`, "kB", F.reference.idleRssMedianKb!, F.candidate.idleRssMedianKb!);
  row("founder-idle", "daemon: resident size while idle, maximum (sampled)", "kB", F.reference.idleRssMaxKb!, F.candidate.idleRssMaxKb!);
  row("founder-idle", "daemon: resident size at the end (sampled)", "kB", F.reference.idleRssLastKb!, F.candidate.idleRssLastKb!);
  if (process.platform === "darwin") {
    row("founder-idle", "daemon: physical footprint while idle, median (proc_pid_rusage: what Activity Monitor shows; reusable pages excluded)", "kB", F.reference.idleFootprintMedianKb!, F.candidate.idleFootprintMedianKb!);
    row("founder-idle", "daemon: physical footprint while idle, maximum", "kB", F.reference.idleFootprintMaxKb!, F.candidate.idleFootprintMaxKb!);
    row("founder-idle", "daemon: physical footprint at the end", "kB", F.reference.idleFootprintLastKb!, F.candidate.idleFootprintLastKb!);
  }
  row("founder-idle", "daemon: resident size peak over the whole run, including the start-up pass (sampled)", "kB", F.reference.startupRssMaxKb!, F.candidate.startupRssMaxKb!);
  row("founder-idle", `daemon: CPU time over the whole ${F.reference.daemonSecs} s run (rusage)`, "ms", F.reference.daemonCpuMs!, F.candidate.daemonCpuMs!);
  row("founder-idle", `daemon: maximum RSS over the whole run (${maxRssHow})`, "bytes", F.reference.daemonMaxRss!, F.candidate.daemonMaxRss!);
  if (process.platform === "linux") {
    row("founder-idle", "daemon: VmHWM at the end", "kB", F.reference.hwmEndKb!, F.candidate.hwmEndKb!);
    row("founder-idle", "daemon: RssAnon at the end", "kB", F.reference.anonEndKb!, F.candidate.anonEndKb!);
    row("founder-idle", "daemon: RssFile at the end", "kB", F.reference.fileEndKb!, F.candidate.fileEndKb!);
    row("founder-idle", "daemon: threads at the end", "threads", F.reference.threadsEnd!, F.candidate.threadsEnd!);
    row("founder-idle", "daemon: inotify watches at the end", "watches", F.reference.inotifyWatchesEnd!, F.candidate.inotifyWatchesEnd!);
  }
  row("founder-idle", "daemon: disk writes over the whole run", outUnit, F.reference.daemonWrites!, F.candidate.daemonWrites!);
  row("founder-idle", "daemon: how it ended", "exit", F.reference.daemonExit!, F.candidate.daemonExit!);
}

const withVariant = rows.some((r) => r.variant !== undefined);
const md: string[] = [];
md.push(`# Measurements (${process.platform}-${process.arch})`);
md.push("");
md.push(
  `Reference \`${reference}\`, candidate \`${candidate}\` (${candidateName})${variant ? `, ${variantName} \`${variant}\`` : ""}, ${new Date().toISOString()}. Every number is the operating system's view of the process (rusage, strace, /proc, ps, proc_pid_rusage); nothing is instrumented inside the binary.`,
);
md.push("");
md.push(
  `Runner: kernel ${env.kernel}, Bun ${env.bun}, ${Math.round(Number(env.totalMemoryBytes) / 1_073_741_824)} GiB of memory${process.platform === "linux" ? `, transparent hugepages \`${env.transparentHugepageEnabled}\` (defrag \`${env.transparentHugepageDefrag}\`), inotify max_user_watches ${env.inotifyMaxUserWatches}` : ""}${process.platform === "darwin" ? `, phys-footprint helper ${env.physFootprintHelper}` : ""}.`,
);
md.push("");
md.push(`| Measurement | Metric | Unit | Reference | Candidate |${withVariant ? ` Candidate, ${variantName} |` : ""}`);
md.push(`| --- | --- | --- | --- | --- |${withVariant ? " --- |" : ""}`);
for (const r of rows) {
  md.push(`| ${r.measurement} | ${r.metric} | ${r.unit} | ${fmt(r.reference)} | ${fmt(r.candidate)} |${withVariant ? ` ${r.variant === undefined ? "" : fmt(r.variant)} |` : ""}`);
}
md.push("");

// memory.md: the per-second samples at a glance and the mappings behind the peak.
const mem: string[] = [];
mem.push(`# Resident memory, sampled (${process.platform}-${process.arch})`);
mem.push("");
mem.push(
  "The idle daemons (60 s for idle and idle-hot, 150 s for founder) and the 20 s watch-only scripts, sampled once a second from outside the process: /proc/<pid>/status and smaps_rollup on Linux, ps and proc_pid_rusage on macOS. Every sample is in `<run>-memory.jsonl`; on Linux the smaps of the sample with the highest VmRSS is in `<run>-smaps-peak.txt`. The table below shows every sample of the first ten seconds and one every five seconds after that.",
);
mem.push("");
for (const [label, d] of Object.entries(memoryDetails)) {
  mem.push(`## ${label}`);
  mem.push("");
  mem.push("| t (s) | RSS kB | footprint kB | CPU ms | VmHWM kB | RssAnon kB | RssFile kB | AnonHugePages kB | LazyFree kB | threads | inotify instances / watches | children (largest kB) |");
  mem.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of d.samples) {
    const sec = Math.round(s.atMs / 1000);
    if (s.atMs > 10_000 && sec % 5 !== 0) continue;
    mem.push(`| ${sec} | ${fmt(s.rssKb)} | ${fmt(s.footprintKb)} | ${s.cpuMs === null ? "?" : fmt(s.cpuMs)} | ${fmt(s.hwmKb)} | ${fmt(s.anonKb)} | ${fmt(s.fileKb)} | ${fmt(s.anonHugeKb)} | ${fmt(s.lazyFreeKb)} | ${s.threads} | ${s.inotifyInstances} / ${fmt(s.inotifyWatches)} | ${s.children} (${fmt(s.childRssKb)}) |`);
  }
  if (d.peakMappings.length > 0) {
    const peak = d.samples.reduce((a, b) => (b.rssKb > a.rssKb ? b : a));
    mem.push("");
    mem.push(`Mappings behind the highest sample (VmRSS ${fmt(peak.rssKb)} kB at ${Math.round(peak.atMs / 1000)} s), resident kB per mapping name:`);
    mem.push("");
    mem.push("| mapping | resident kB | mappings |");
    mem.push("| --- | --- | --- |");
    for (const m of d.peakMappings) mem.push(`| \`${m.mapping}\` | ${fmt(m.rssKb)} | ${m.mappings} |`);
  }
  mem.push("");
}

writeFileSync(
  join(out, "measurements.json"),
  JSON.stringify({ platform: `${process.platform}-${process.arch}`, reference, candidate, candidateName, variant: variant ?? null, variantName: variant ? variantName : null, environment: env, generatedAt: new Date().toISOString(), rows, raw: { ...results, watchOnly, rusageChecks }, memory: memoryDetails }, null, 2),
);
writeFileSync(join(out, "measurements.md"), `${md.join("\n")}\n`);
writeFileSync(join(out, "memory.md"), `${mem.join("\n")}\n`);
log(`\n${md.join("\n")}`);
