// The service commands of hx and hx2, side by side through a real service
// manager. The harness's scenarios never install the background service, so
// this is where `start`, `restart`, `stop`, `logs` and `uninstall` are held
// to "identical apart from the name": each client runs the same sequence from
// the same starting state (the `hot-small` fixture, a fresh fake gateway, no
// service installed), and every step's exit code and output are compared
// after the harness's normalization (the name, pids, paths), together with
// how many `watch` processes run after it.
//
//   bun harness/run/service-commands.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>
//
// `status` is compared on its Daemon row alone: the other rows follow how far
// the daemon got with the fixture. `logs` follows the logs until Ctrl+C, so it
// is compared on how it ends: SIGINT after 2 s, then its exit code.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FakeGateway } from "../gateway/gateway.js";
import { DEFAULT_WINDOW_AFTER_MS, DEFAULT_WINDOW_BEFORE_MS, normalizeText } from "../lib/normalize.js";
import { CLOUD_PORT } from "./run-scenario.js";
import { type Client, killWatchProcesses, type Manager, MANAGERS, prepareServiceHome, run, versionOf, watchProcesses } from "./service-home.js";

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
  console.error("usage: service-commands.ts --hx <bin> --hx2 <bin> --manager launchd|systemd|shell-hook --out <dir> --work <dir>");
  process.exit(64);
}
const bins: Record<Client, string> = { hx: resolve(hxArg), hx2: resolve(hx2Arg) };
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Step {
  name: string;
  args: string[];
  /** Compare the Daemon row of the output, nothing else. */
  daemonRow?: boolean;
  /** Send SIGINT this long after the start and compare how it ends. */
  sigintAfterMs?: number;
}

const STEPS: Step[] = [
  { name: "start", args: ["start"] },
  { name: "status, running", args: ["status"], daemonRow: true },
  { name: "restart", args: ["restart"] },
  { name: "status, restarted", args: ["status"], daemonRow: true },
  { name: "stop", args: ["stop"] },
  { name: "stop, not running", args: ["stop"] },
  { name: "status, stopped", args: ["status"], daemonRow: true },
  { name: "start again", args: ["start"] },
  { name: "logs, Ctrl+C", args: ["logs", "--lines", "0"], sigintAfterMs: 2_000 },
  { name: "uninstall", args: ["uninstall"] },
  { name: "status, uninstalled", args: ["status"], daemonRow: true },
];

interface StepResult {
  step: string;
  exit: number | null;
  stdout: string;
  stderr: string;
  /** `watch` processes after the step: the client's own, and the other's. */
  own: number;
  other: number;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const svc = prepareServiceHome({ manager, work, name: "service-home", shape: "hot-small", seed: "service-commands" });
const versions = [await versionOf(bins.hx, svc.env), await versionOf(bins.hx2, svc.env)];
log(`hx ${versions[0]}, hx2 ${versions[1]}; ${manager}; home ${svc.home}`);

async function runStep(client: Client, step: Step): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  if (step.sigintAfterMs === undefined) {
    const r = await run([bins[client], ...step.args], svc.env);
    return { exit: r.code, stdout: r.stdout, stderr: r.stderr };
  }
  const proc = Bun.spawn([bins[client], ...step.args], { env: svc.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  await sleep(step.sigintAfterMs);
  proc.kill("SIGINT");
  const ended = await Promise.race([proc.exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!ended) proc.kill("SIGKILL");
  await proc.exited;
  // The lines the daemon happened to write while it followed are not compared.
  await Promise.all([stdout, stderr]);
  return { exit: ended ? proc.exitCode : null, stdout: ended ? "(ended on SIGINT)" : "(still running 10 s after SIGINT)", stderr: "" };
}

const results: Record<Client, StepResult[]> = { hx: [], hx2: [] };
for (const client of ["hx", "hx2"] as const) {
  const cloud = new FakeGateway({ version: "0.0.0", recordPath: join(out, `gateway-${client}.jsonl`), label: "cloud" });
  const gatewayUrl = cloud.start(CLOUD_PORT);
  svc.connect(cloud, gatewayUrl);
  const ctx = {
    candidateName: client,
    versions,
    home: svc.home,
    workDir: resolve(work),
    gatewayUrl,
    fortressUrl: null,
    anchorMs: Date.now(),
    windowBeforeMs: DEFAULT_WINDOW_BEFORE_MS,
    windowAfterMs: DEFAULT_WINDOW_AFTER_MS,
    mode: "diff" as const,
  };
  try {
    for (const step of STEPS) {
      const r = await runStep(client, step);
      let stdout = normalizeText(r.stdout, ctx);
      if (step.daemonRow) stdout = /^Daemon:.*$/m.exec(stdout)?.[0] ?? "(no Daemon row)";
      // The shell hook's supervisor starts `watch` a moment after `start`
      // returns; count once that moment has passed.
      await sleep(1_500);
      const procs = await watchProcesses();
      const res: StepResult = { step: step.name, exit: r.exit, stdout: stdout.trimEnd(), stderr: normalizeText(r.stderr, ctx).trimEnd(), own: procs[client].length, other: procs[client === "hx" ? "hx2" : "hx"].length };
      results[client].push(res);
      log(`[${client}] ${step.name}: exit ${res.exit}, ${res.own} own watch, ${res.other} other\n${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`);
    }
  } finally {
    const cleanup = await run([bins[client], "uninstall", "--purge"], svc.env);
    writeFileSync(join(out, `cleanup-${client}.txt`), `exit ${cleanup.code}\n${cleanup.stdout}${cleanup.stderr}`);
    await killWatchProcesses();
    cloud.stop();
  }
}
svc.release();

// ── The comparison ──────────────────────────────────────────────────────────

const rows: string[] = [];
let differing = 0;
STEPS.forEach((step, i) => {
  const a = results.hx[i];
  const b = results.hx2[i];
  const same = !!a && !!b && a.exit === b.exit && a.stdout === b.stdout && a.stderr === b.stderr && a.own === b.own && a.other === b.other;
  if (!same) differing += 1;
  const cell = (r: StepResult | undefined): string =>
    r ? `exit ${r.exit} · ${r.own} watch<br>${[r.stdout, r.stderr].filter(Boolean).join("\n").replace(/\|/g, "\\|").replace(/\n/g, "<br>")}` : "(not run)";
  rows.push(`| \`${step.args.join(" ")}\` (${step.name}) | ${same ? "identical" : "**DIFFERENT**"} | ${cell(a)} | ${same ? "" : cell(b)} |`);
});
const ok = differing === 0;
const md = [
  `## Service commands, hx and hx2 (${manager}): ${ok ? "identical apart from the name" : `${differing} step(s) differ`}`,
  "",
  `${process.platform}-${process.arch} · hx ${versions[0]} · hx2 ${versions[1]} · outputs normalized (name, pids, paths); \`status\` on its Daemon row`,
  "",
  "| Step | Result | hx (normalized) | hx2, where it differs |",
  "| --- | --- | --- | --- |",
  ...rows,
  "",
].join("\n");
writeFileSync(join(out, "report.md"), md);
writeFileSync(join(out, "report.json"), JSON.stringify({ ok, manager, versions, results }, null, 2));
log(md);
process.exit(ok ? 0 : 1);
