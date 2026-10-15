// Drive ONE binary through ONE scenario: a fresh fixture home, a fresh fake
// gateway (and fortress), every step in order, and everything the comparators
// need written to an output directory.
//
// Isolation: the binary reads and writes under HOME alone (its state in
// ~/.let/hx, the transcripts in ~/.claude and ~/.codex, Claude Desktop under
// ~/Library/Application Support/Claude on macOS), so pointing HOME at the
// fixture isolates it completely. Both binaries run against the SAME home
// path, one after the other, because transcript contents embed their cwd and
// the stored bytes must match exactly.
//
// Ports are fixed so the gateway URL the binary prints and persists is the
// same in both runs: 48621 (cloud), 48622 (fortress), 48700 (hx ui).

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { FakeGateway, type GatewayConfig } from "../gateway/gateway.js";
import { generateHome, type Manifest } from "../fixtures/gen-home.js";
import { Prng } from "../lib/prng.js";
import type { BinaryName, RunMeta, Scenario, Step, StepRecord } from "../lib/types.js";

export const CLOUD_PORT = 48621;
export const FORTRESS_PORT = 48622;
const DEVICE_ID = "7f1c2b3a-1111-4aaa-8bbb-harness00001";

export interface DriverOptions {
  binary: string;
  name: BinaryName;
  scenario: Scenario;
  outDir: string;
  /** The fixture home (wiped and regenerated). */
  home: string;
  /** The harness work directory, for path normalization. */
  workDir: string;
  log?: (line: string) => void;
}

interface Spawned {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function baseEnv(home: string, gateway?: { url: string; token: string }): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    // For the driver's stub binary only; hx reads its gateway from config.json.
    ...(gateway ? { HX_HARNESS_GATEWAY_URL: gateway.url, HX_HARNESS_ACCESS_TOKEN: gateway.token } : {}),
    USERPROFILE: home,
    TZ: "UTC",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NO_COLOR: "1",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

async function spawnCapture(cmd: string[], env: Record<string, string>, timeoutMs: number): Promise<Spawned> {
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.signalCode ? null : exitCode, signal: proc.signalCode ?? null, stdout, stderr, timedOut };
}

/** "hx version: X" → X (hx2 prints "hx2 version: X"). */
export async function binaryVersion(binary: string, home: string): Promise<string> {
  const r = await spawnCapture([binary, "--version"], baseEnv(home), 30_000);
  const m = /version: (\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!m) throw new Error(`could not read the version of ${binary}: ${r.stdout} ${r.stderr}`);
  return m[1]!;
}

function bumpPatch(version: string): string {
  const [a, b, c] = version.split(".").map(Number);
  return `${a}.${b}.${(c ?? 0) + 1}`;
}

function resolvePlaceholders<T>(value: T, ctx: { binary: string; version: string; fortressUrl: string | null; manifest: Manifest }): T {
  if (typeof value === "string") {
    if (value === "<SELF>") return ctx.binary as unknown as T;
    if (value === "<SELF+1>") return bumpPatch(ctx.version) as unknown as T;
    if (value === "<FORTRESS>") return (ctx.fortressUrl ?? "") as unknown as T;
    const m = /^<SESSION:(\d+)>$/.exec(value);
    if (m) {
      const s = ctx.manifest.sessions[Number(m[1])];
      if (!s) throw new Error(`manifest has no session ${m[1]}`);
      return `${s.family}:${s.sessionId}` as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, ctx)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolvePlaceholders(v, ctx);
    return out as T;
  }
  return value;
}

function writeHxFile(home: string, name: string, content: string): void {
  const dir = join(home, ".let", "hx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, { mode: 0o600 });
}

export async function runScenario(o: DriverOptions): Promise<RunMeta> {
  const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const { scenario } = o;
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(join(o.outDir, "steps"), { recursive: true });
  const startedAtMs = Date.now();

  // Fixture home.
  const manifest = generateHome({ out: o.home, shape: scenario.shape, seed: scenario.seed, now: startedAtMs });
  cpSync(`${o.home}.manifest.json`, join(o.outDir, "fixture.manifest.json"));
  // A second, empty home for the "not connected" step.
  const emptyHome = `${o.home}-empty`;
  rmSync(emptyHome, { recursive: true, force: true });
  mkdirSync(emptyHome, { recursive: true });

  const version = await binaryVersion(o.binary, o.home);
  log(`[${o.name}] ${o.binary} version ${version}, scenario ${scenario.name} (${manifest.sessions.length} sessions)`);

  // Gateways.
  const fortress = scenario.fortress
    ? new FakeGateway({ ...scenario.fortress, version, releaseBinary: o.binary, recordPath: join(o.outDir, "fortress.jsonl"), label: "fortress" })
    : null;
  const fortressUrl = fortress ? fortress.start(FORTRESS_PORT) : null;
  const ctx = { binary: o.binary, version, fortressUrl, manifest };
  const cloud = new FakeGateway({
    ...resolvePlaceholders(scenario.gateway ?? {}, ctx),
    version,
    releaseBinary: o.binary,
    recordPath: join(o.outDir, "gateway.jsonl"),
    label: "cloud",
  });
  const gatewayUrl = cloud.start(CLOUD_PORT);

  // The binary's own files: connected to the cloud gateway, a fixed device id.
  writeHxFile(o.home, "config.json", JSON.stringify({ gatewayBaseUrl: gatewayUrl, accessToken: cloud.config.accessToken, userId: cloud.config.userId, deviceName: cloud.config.deviceName }, null, 2));
  writeHxFile(o.home, "device-id", DEVICE_ID);
  writeHxFile(o.home, "settings.json", JSON.stringify(scenario.settings ?? {}, null, 2));

  const env = baseEnv(o.home, { url: gatewayUrl, token: cloud.config.accessToken });
  const steps: StepRecord[] = [];
  const failures: string[] = [];
  const stepFile = (index: number, name: string): string => join(o.outDir, "steps", `${String(index).padStart(2, "0")}-${name}`);

  let index = 0;
  for (const step of scenario.steps) {
    index += 1;
    const rec: StepRecord = {
      index,
      name: step.name,
      kind: step.kind,
      seqFrom: cloud.record.length + 1,
      seqTo: 0,
      fortressSeqFrom: (fortress?.record.length ?? 0) + 1,
      fortressSeqTo: 0,
      startedAtMs: Date.now(),
      endedAtMs: 0,
    };
    log(`[${o.name}] ${scenario.name} › ${index} ${step.name} (${step.kind})`);
    try {
      await runStep(step, { ...o, env, cloud, fortress, ctx, manifest, rec, stepFile: stepFile(index, step.name), log, emptyHome });
    } catch (err) {
      rec.error = (err as Error).message;
      failures.push(`${step.name}: ${rec.error}`);
      log(`[${o.name}]   error: ${rec.error}`);
    }
    rec.endedAtMs = Date.now();
    rec.seqTo = cloud.record.length + 1;
    rec.fortressSeqTo = (fortress?.record.length ?? 0) + 1;
    if (step.kind === "run" && step.expectExit !== undefined && rec.exitCode !== step.expectExit) {
      failures.push(`${step.name}: exit ${rec.exitCode ?? rec.signal}, expected ${step.expectExit}`);
    }
    steps.push(rec);
  }

  // Collect the binary's own files and the stores.
  const hxDir = join(o.home, ".let", "hx");
  try {
    chmodSync(hxDir, 0o700);
  } catch {
    // never made read-only
  }
  for (const f of ["state.json", "activity.jsonl", "config.json", "org-names.json", "settings.json", "stdout.log", "stderr.log", "watch-run.json", "watch-exits.json"]) {
    const p = join(hxDir, f);
    if (existsSync(p)) cpSync(p, join(o.outDir, f));
  }
  writeFileSync(join(o.outDir, "store.json"), JSON.stringify(cloud.manifest(), null, 2));
  if (fortress) writeFileSync(join(o.outDir, "fortress-store.json"), JSON.stringify(fortress.manifest(), null, 2));
  cloud.stop();
  fortress?.stop();

  const meta: RunMeta = {
    scenario: scenario.name,
    binary: o.binary,
    name: o.name,
    version,
    platform: process.platform,
    arch: process.arch,
    home: o.home,
    workDir: o.workDir,
    gatewayUrl,
    fortressUrl,
    startedAtMs,
    endedAtMs: Date.now(),
    steps,
    failures,
  };
  writeFileSync(join(o.outDir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

interface StepCtx extends DriverOptions {
  env: Record<string, string>;
  cloud: FakeGateway;
  fortress: FakeGateway | null;
  ctx: { binary: string; version: string; fortressUrl: string | null; manifest: Manifest };
  manifest: Manifest;
  rec: StepRecord;
  stepFile: string;
  log: (line: string) => void;
  emptyHome: string;
}

async function runStep(step: Step, c: StepCtx): Promise<void> {
  switch (step.kind) {
    case "run": {
      const env = { ...c.env };
      for (const [k, v] of Object.entries(step.env ?? {})) env[k] = v === "<EMPTY-HOME>" ? c.emptyHome : v;
      if (env.HOME !== c.env.HOME) env.USERPROFILE = env.HOME;
      const r = await spawnCapture([c.binary, ...step.args], env, step.timeoutMs ?? 10 * 60_000);
      writeFileSync(`${c.stepFile}.stdout`, r.stdout);
      writeFileSync(`${c.stepFile}.stderr`, r.stderr);
      writeFileSync(`${c.stepFile}.code`, `${r.exitCode ?? `signal ${r.signal}`}\n`);
      c.rec.exitCode = r.exitCode;
      c.rec.signal = r.signal;
      c.rec.timedOut = r.timedOut;
      if (r.timedOut) throw new Error(`timed out after ${step.timeoutMs ?? 600_000} ms`);
      return;
    }
    case "gateway":
      c.cloud.update(resolvePlaceholders(step.patch, c.ctx) as Partial<GatewayConfig>);
      return;
    case "fortress":
      if (!c.fortress) throw new Error("scenario has no fortress");
      c.fortress.update(resolvePlaceholders(step.patch, c.ctx) as Partial<GatewayConfig>);
      return;
    case "gateway-stop":
      c.cloud.stop();
      return;
    case "gateway-start":
      c.cloud.start(CLOUD_PORT);
      return;
    case "settings": {
      const p = join(c.home, ".let", "hx", "settings.json");
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      } catch {
        // not written yet
      }
      writeFileSync(p, JSON.stringify({ ...current, ...step.patch }, null, 2), { mode: 0o600 });
      return;
    }
    case "chmod-hx-dir":
      chmodSync(join(c.home, ".let", "hx"), step.mode);
      return;
    case "grow": {
      const s = c.manifest.sessions[step.sessionIndex];
      if (!s) throw new Error(`manifest has no session ${step.sessionIndex}`);
      const first = readFileSync(s.path, "utf8").split("\n")[0] ?? "{}";
      const head = JSON.parse(first) as { cwd?: string; entrypoint?: string; gitBranch?: string };
      const rng = new Prng(`grow:${c.scenario.name}:${step.name}`);
      const lines: string[] = [];
      let bytes = 0;
      let i = 0;
      while (bytes < step.bytes) {
        const line = JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: "external",
          cwd: head.cwd,
          sessionId: s.sessionId,
          version: "2.1.0",
          gitBranch: head.gitBranch,
          entrypoint: head.entrypoint,
          type: i % 2 === 0 ? "user" : "assistant",
          message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: rng.paragraph(200) }] },
          uuid: rng.uuid(),
          timestamp: new Date(Date.UTC(2026, 0, 6, 12, i, 0)).toISOString(),
        });
        lines.push(line);
        bytes += line.length + 1;
        i += 1;
      }
      appendFileSync(s.path, `${lines.join("\n")}\n`);
      const t = new Date();
      utimesSync(s.path, t, t);
      return;
    }
    case "watch-kill": {
      c.cloud.update({ putDelayMs: step.putDelayMs });
      const proc = Bun.spawn([c.binary, "watch"], { env: c.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const out = new Response(proc.stdout).text();
      const err = new Response(proc.stderr).text();
      const deadline = Date.now() + (step.timeoutMs ?? 120_000);
      let killed = false;
      while (Date.now() < deadline) {
        if (c.cloud.stats().commits >= step.killAfterCommits) {
          proc.kill("SIGKILL");
          killed = true;
          break;
        }
        if (proc.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!killed) proc.kill("SIGKILL");
      const exitCode = await proc.exited;
      const [stdout, stderr] = await Promise.all([out, err]);
      writeFileSync(`${c.stepFile}.stdout`, stdout);
      writeFileSync(`${c.stepFile}.stderr`, stderr);
      writeFileSync(`${c.stepFile}.code`, `${proc.signalCode ? `signal ${proc.signalCode}` : exitCode}\n`);
      c.rec.exitCode = proc.signalCode ? null : exitCode;
      c.rec.signal = proc.signalCode ?? null;
      c.cloud.update({ putDelayMs: 0 });
      if (!killed) throw new Error(`the daemon never reached ${step.killAfterCommits} commits (${c.cloud.stats().commits})`);
      return;
    }
    case "ui":
      return runUiStep(step.port, c);
  }
}

// ── hx ui: start the server, exchange the launch token, probe the API ──────

interface Probe {
  name: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

async function runUiStep(port: number, c: StepCtx): Promise<void> {
  const proc = Bun.spawn([c.binary, "ui", "--no-open", "--port", String(port)], { env: c.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const errText = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  const deadline = Date.now() + 30_000;
  let launchUrl: string | null = null;
  while (Date.now() < deadline && launchUrl === null) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: false }), 500))]);
    if (done) break;
    if (value) stdout += decoder.decode(value, { stream: true });
    const m = /HX Client UI → (http:\/\/[^\s]+)/.exec(stdout);
    if (m) launchUrl = m[1]!;
  }
  // Keep draining stdout in the background so the process never blocks on a full pipe.
  const drain = (async (): Promise<void> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      stdout += decoder.decode(value, { stream: true });
    }
  })();

  const probes: Probe[] = [];
  const base = `http://localhost:${port}`;
  let sessionToken = "";
  const call = async (name: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth = true): Promise<unknown> => {
    const h: Record<string, string> = { ...headers };
    if (auth && sessionToken) h["x-hx-ui-token"] = sessionToken;
    if (body !== undefined) h["content-type"] = "application/json";
    let status = 0;
    let parsed: unknown;
    try {
      const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      status = res.status;
      const text = await res.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text.slice(0, 500);
      }
    } catch (err) {
      parsed = { $error: (err as Error).message };
    }
    probes.push({ name, method, path, status, body: parsed });
    return parsed;
  };

  try {
    if (!launchUrl) throw new Error(`hx ui printed no launch URL within 30 s: ${stdout}`);
    const token = /#k=([A-Za-z0-9_-]+)/.exec(launchUrl)?.[1] ?? "";
    await call("instance", "GET", "/api/instance", undefined, {}, false);
    await call("snapshot-unauthenticated", "GET", "/api/snapshot", undefined, {}, false);
    const auth = (await call("auth", "POST", "/api/auth", { token }, {}, false)) as { sessionToken?: string } | null;
    sessionToken = auth?.sessionToken ?? "";
    await call("auth-bad-token", "POST", "/api/auth", { token: "nope" }, {}, false);
    await call("ping", "GET", "/api/ping");
    const snapshot = (await call("snapshot", "GET", "/api/snapshot")) as { folders?: Array<{ id: string }> } | null;
    const folders = [...(snapshot?.folders ?? [])].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3);
    let previewPath: string | null = null;
    for (const f of folders) {
      const sessions = (await call(`sessions ${f.id}`, "GET", `/api/sessions?folder=${encodeURIComponent(f.id)}`)) as Array<{ id: string; path: string }> | null;
      // The list is ordered by last upload, a millisecond tie: pick by id.
      const first = Array.isArray(sessions) ? [...sessions].sort((x, y) => x.id.localeCompare(y.id))[0] : undefined;
      if (!previewPath && first) previewPath = first.path;
    }
    await call("sessions-missing-folder", "GET", "/api/sessions");
    if (previewPath) await call("session-preview", "GET", `/api/session-preview?path=${encodeURIComponent(previewPath)}`);
    await call("session-preview-outside", "GET", `/api/session-preview?path=${encodeURIComponent(join(c.home, ".let", "hx", "config.json"))}`);
    await call("settings", "GET", "/api/settings");
    await call("settings-patch", "POST", "/api/settings", { personalSync: false });
    await call("settings-unknown-key", "POST", "/api/settings", { bogus: true });
    await call("settings-restore", "POST", "/api/settings", { personalSync: true });
    await call("settings-bad-origin", "POST", "/api/settings", { personalSync: true }, { origin: "http://evil.example.test" });
    await call("update-check", "GET", "/api/update-check");
    await call("probe", "GET", "/api/probe");
    await call("whoami", "GET", "/api/whoami");
    await call("activity", "GET", "/api/activity?hours=24");
    await call("logs", "GET", "/api/logs?lines=100");
    await call("not-found", "GET", "/api/no-such-route");
    await call("method-not-allowed", "DELETE", "/api/settings");
    await call("index", "GET", "/", undefined, {}, false);
  } finally {
    proc.kill("SIGTERM");
    const exit = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), 10_000))]);
    if (exit === -1) proc.kill("SIGKILL");
    await proc.exited;
    await drain;
    const stderr = await errText;
    // The index probe returns the whole HTML shell; keep its length only.
    const normalized = probes.map((p) => (p.name === "index" && typeof p.body === "string" ? { ...p, body: `<html ${p.body.length} chars>` } : p));
    writeFileSync(`${c.stepFile}.json`, JSON.stringify({ launchUrl, probes: normalized }, null, 2));
    writeFileSync(`${c.stepFile}.stdout`, stdout);
    writeFileSync(`${c.stepFile}.stderr`, stderr);
    c.rec.exitCode = proc.signalCode ? null : proc.exitCode;
    c.rec.signal = proc.signalCode ?? null;
  }
}

// CLI entry: bun harness/run/run-scenario.ts --binary <hx> --scenario <name> --out <dir> [--name hx2] [--home <dir>]
if (import.meta.main) {
  const arg = (name: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const { selectScenarios } = await import("./scenarios.js");
  const binary = arg("binary");
  const scenarioName = arg("scenario", "baseline") ?? "baseline";
  const out = arg("out");
  if (!binary || !out) {
    console.error("usage: run-scenario.ts --binary <path> --scenario <name> --out <dir> [--name hx|hx2] [--home <dir>]");
    process.exit(64);
  }
  const workDir = arg("work", join(process.cwd(), ".harness-work")) ?? "";
  const home = arg("home", join(workDir, "home")) ?? "";
  mkdirSync(workDir, { recursive: true });
  const scenario = selectScenarios(scenarioName)[0]!;
  const meta = await runScenario({ binary, name: (arg("name", "hx") as BinaryName) ?? "hx", scenario, outDir: out, home, workDir });
  console.log(JSON.stringify({ scenario: meta.scenario, steps: meta.steps.length, failures: meta.failures }, null, 2));
  process.exit(meta.failures.length === 0 ? 0 : 1);
}
