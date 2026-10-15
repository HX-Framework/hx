// The differential harness: run every scenario with the reference binary and
// with the candidate, compare the two runs, and write a report.
//
//   bun harness/run/run-harness.ts --reference <bin> --candidate <bin> [--candidate-name hx2]
//       [--scenarios all|a,b] [--out <dir>] [--work <dir>] [--expect pass|fail]
//       [--goldens <dir>] [--write-goldens <dir>]
//
// Exit code 0 means the outcome matched --expect: with "pass" (the default),
// no difference anywhere; with "fail", at least one difference — the way the
// workflow proves that a deliberately broken candidate is caught.
//
// Nothing here runs on a laptop by design: the workflow in
// .github/workflows/differential.yml builds the binaries and runs this.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compareRuns, coverageCheck, fixtureExpectationChecks, loadRun } from "../lib/compare.js";
import { normalizeText, DEFAULT_WINDOW_AFTER_MS, DEFAULT_WINDOW_BEFORE_MS } from "../lib/normalize.js";
import type { BinaryName, CheckResult, HarnessReport, RunMeta, Scenario, ScenarioReport } from "../lib/types.js";
import { runScenario } from "./run-scenario.js";
import { selectScenarios } from "./scenarios.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const reference = arg("reference");
const candidate = arg("candidate");
if (!reference || !candidate) {
  console.error("usage: run-harness.ts --reference <bin> --candidate <bin> [--candidate-name hx2] [--scenarios all] [--out dir] [--expect pass|fail]");
  process.exit(64);
}
const candidateName = (arg("candidate-name", "hx") ?? "hx") as BinaryName;
const referenceName = (arg("reference-name", "hx") ?? "hx") as BinaryName;
const expect = (arg("expect", "pass") ?? "pass") as "pass" | "fail";
const out = arg("out", join(process.cwd(), ".harness-out")) ?? "";
const workDir = arg("work", join(process.cwd(), ".harness-work")) ?? "";
const goldensDir = arg("goldens");
const writeGoldensDir = arg("write-goldens");
const scenarios = selectScenarios(arg("scenarios", "all"));
const verbose = has("verbose");

mkdirSync(out, { recursive: true });
mkdirSync(workDir, { recursive: true });
const home = join(workDir, "home");
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const started = Date.now();
const reports: ScenarioReport[] = [];
const referenceDirs: string[] = [];
let refMeta: RunMeta | null = null;
let candMeta: RunMeta | null = null;

for (const scenario of scenarios) {
  const refDir = join(out, scenario.name, "reference");
  const candDir = join(out, scenario.name, "candidate");
  log(`\n=== ${scenario.name}: ${scenario.description}`);
  const t0 = Date.now();
  refMeta = await runScenario({ binary: reference, name: referenceName, scenario, outDir: refDir, home, workDir, log: verbose ? log : () => {} });
  const t1 = Date.now();
  candMeta = await runScenario({ binary: candidate, name: candidateName, scenario, outDir: candDir, home, workDir, log: verbose ? log : () => {} });
  const t2 = Date.now();
  referenceDirs.push(refDir);

  const ref = loadRun(refDir);
  const cand = loadRun(candDir);
  const checks: CheckResult[] = [
    ...compareRuns(ref, cand, { scenario, candidateName }),
    ...fixtureExpectationChecks(ref, scenario).map((c) => ({ ...c, name: `reference ${c.name}` })),
    ...fixtureExpectationChecks(cand, scenario).map((c) => ({ ...c, name: `candidate ${c.name}` })),
    ...goldenChecks(scenario, cand, candidateName, [ref.meta.version, cand.meta.version]),
  ];
  if (writeGoldensDir) writeGoldens(scenario, ref, candidateName, [ref.meta.version, cand.meta.version], writeGoldensDir);
  const ok = checks.every((c) => c.ok);
  reports.push({ scenario: scenario.name, ok, checks, referenceMs: t1 - t0, candidateMs: t2 - t1 });
  log(`=== ${scenario.name}: ${ok ? "identical" : "DIFFERENT"} (${checks.filter((c) => !c.ok).length} failing checks; reference ${Math.round((t1 - t0) / 1000)} s, candidate ${Math.round((t2 - t1) / 1000)} s)`);
  for (const c of checks.filter((x) => !x.ok)) log(`    ✗ ${c.name}\n${indent(c.details)}`);
}

const coverage = coverageCheck(referenceDirs, (arg("scenarios", "all") ?? "all") === "all");
const allOk = reports.every((r) => r.ok) && coverage.ok;
const report: HarnessReport = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  reference: { binary: reference, version: refMeta?.version ?? "", name: referenceName },
  candidate: { binary: candidate, version: candMeta?.version ?? "", name: candidateName },
  expect,
  ok: allOk,
  scenarios: reports,
  coverage,
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(out, "report.md"), renderMarkdown(report, Date.now() - started));
log(`\n${renderMarkdown(report, Date.now() - started)}`);

const outcomeMatches = expect === "pass" ? allOk : !reports.every((r) => r.ok);
if (expect === "fail" && outcomeMatches) log("the candidate was caught, as expected");
if (expect === "fail" && !outcomeMatches) log("the candidate was NOT caught: the harness cannot tell it from the reference");
process.exit(outcomeMatches ? 0 : 1);

// ── Goldens: committed expectations for the CLI surfaces ───────────────────

function goldenCtx(run: ReturnType<typeof loadRun>, candidateNameForCtx: BinaryName, versions: string[]) {
  return {
    candidateName: candidateNameForCtx,
    versions,
    home: run.meta.home,
    workDir: run.meta.workDir,
    gatewayUrl: run.meta.gatewayUrl,
    fortressUrl: run.meta.fortressUrl,
    anchorMs: run.meta.startedAtMs,
    windowBeforeMs: DEFAULT_WINDOW_BEFORE_MS,
    windowAfterMs: DEFAULT_WINDOW_AFTER_MS,
    mode: "golden" as const,
  };
}

function goldenText(run: ReturnType<typeof loadRun>, stepName: string, candidateNameForCtx: BinaryName, versions: string[]): string | null {
  const step = run.meta.steps.find((s) => s.name === stepName);
  if (!step) return null;
  const base = join(run.dir, "steps", `${String(step.index).padStart(2, "0")}-${step.name}`);
  const ctx = goldenCtx(run, candidateNameForCtx, versions);
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return [`exit ${step.exitCode ?? `signal ${step.signal}`}`, "--- stdout", normalizeText(read(`${base}.stdout`), ctx), "--- stderr", normalizeText(read(`${base}.stderr`), ctx)].join("\n");
}

function goldenChecks(scenario: Scenario, cand: ReturnType<typeof loadRun>, candidateNameForCtx: BinaryName, versions: string[]): CheckResult[] {
  if (!goldensDir || !scenario.goldens) return [];
  const dir = join(goldensDir, scenario.name);
  if (!existsSync(dir)) return [{ name: "goldens", ok: true, details: `no goldens committed for ${scenario.name} on this platform yet` }];
  const checks: CheckResult[] = [];
  for (const stepName of scenario.goldens) {
    const p = join(dir, `${stepName}.txt`);
    const got = goldenText(cand, stepName, candidateNameForCtx, versions);
    if (!existsSync(p) || got === null) {
      checks.push({ name: `golden ${stepName}`, ok: !existsSync(p) && got === null, details: existsSync(p) ? "step missing from the run" : "no golden file" });
      continue;
    }
    const want = readFileSync(p, "utf8");
    if (want === got) checks.push({ name: `golden ${stepName}`, ok: true, details: "matches the committed output" });
    else {
      const la = want.split("\n");
      const lb = got.split("\n");
      const lines: string[] = [];
      for (let i = 0; i < Math.max(la.length, lb.length) && lines.length < 30; i++) {
        if (la[i] !== lb[i]) lines.push(`@${i + 1}`, `- ${la[i] ?? ""}`, `+ ${lb[i] ?? ""}`);
      }
      checks.push({ name: `golden ${stepName}`, ok: false, details: lines.join("\n") });
    }
  }
  return checks;
}

function writeGoldens(scenario: Scenario, ref: ReturnType<typeof loadRun>, candidateNameForCtx: BinaryName, versions: string[], dir: string): void {
  if (!scenario.goldens) return;
  const target = join(dir, scenario.name);
  mkdirSync(target, { recursive: true });
  for (const stepName of scenario.goldens) {
    const text = goldenText(ref, stepName, candidateNameForCtx, versions);
    if (text !== null) writeFileSync(join(target, `${stepName}.txt`), text);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
}

function renderMarkdown(r: HarnessReport, elapsedMs: number): string {
  const lines: string[] = [];
  lines.push(`# Differential harness: ${r.ok ? "identical" : "different"}`);
  lines.push("");
  lines.push(`Platform ${r.platform} · reference ${r.reference.name} ${r.reference.version} · candidate ${r.candidate.name} ${r.candidate.version} · expected to ${r.expect} · ${Math.round(elapsedMs / 1000)} s`);
  lines.push("");
  lines.push("| Scenario | Result | Checks | Failing | Reference | Candidate |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const s of r.scenarios) {
    const failing = s.checks.filter((c) => !c.ok).map((c) => c.name);
    lines.push(`| ${s.scenario} | ${s.ok ? "identical" : "DIFFERENT"} | ${s.checks.length} | ${failing.length ? failing.join(", ") : "—"} | ${Math.round(s.referenceMs / 1000)} s | ${Math.round(s.candidateMs / 1000)} s |`);
  }
  lines.push("");
  lines.push(`## ${r.coverage.name}: ${r.coverage.ok ? "yes" : "NO"}`);
  lines.push("");
  lines.push("```");
  lines.push(r.coverage.details);
  lines.push("```");
  for (const s of r.scenarios) {
    const failing = s.checks.filter((c) => !c.ok);
    if (failing.length === 0) continue;
    lines.push("");
    lines.push(`## ${s.scenario}: ${failing.length} failing check${failing.length === 1 ? "" : "s"}`);
    for (const c of failing) {
      lines.push("");
      lines.push(`### ${c.name}`);
      lines.push("```");
      lines.push(c.details);
      lines.push("```");
    }
  }
  return `${lines.join("\n")}\n`;
}
