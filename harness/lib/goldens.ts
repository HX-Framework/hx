// Goldens: committed, normalized CLI outputs per scenario step. They are
// written from a reference run and checked against every candidate run, so a
// change in what `hx status`, `hx doctor sync`, `hx connect` or `hx update`
// prints shows up even when reference and candidate agree with each other.
//
// Golden mode normalizes harder than a diff between two runs of the same day:
// calendar dates become `<date>`, and run-relative timestamps become `<t>`
// without an offset, because a golden may be months older than the run it is
// checked against.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonOrNull, type RunDir } from "./compare.js";
import { DEFAULT_WINDOW_AFTER_MS, DEFAULT_WINDOW_BEFORE_MS, normalizeJson, normalizeText, type NormalizeContext } from "./normalize.js";
import type { BinaryName, CheckResult, Scenario } from "./types.js";

export function goldenContext(run: RunDir, candidateName: BinaryName, versions: string[]): NormalizeContext {
  return {
    candidateName,
    versions,
    home: run.meta.home,
    workDir: run.meta.workDir,
    gatewayUrl: run.meta.gatewayUrl,
    fortressUrl: run.meta.fortressUrl,
    anchorMs: run.meta.startedAtMs,
    windowBeforeMs: DEFAULT_WINDOW_BEFORE_MS,
    windowAfterMs: DEFAULT_WINDOW_AFTER_MS,
    mode: "golden",
  };
}

/**
 * The golden rendering of one CLI step: exit status, stdout, stderr. Stdout
 * that parses as JSON is rendered from its normalized value — keys sorted,
 * lists of objects sorted, timestamps masked — because text normalization
 * alone leaves epoch-millisecond numbers in place, and those move with every
 * fixture generation.
 */
export function goldenText(run: RunDir, stepName: string, candidateName: BinaryName, versions: string[]): string | null {
  const step = run.meta.steps.find((s) => s.name === stepName);
  if (!step) return null;
  const base = join(run.dir, "steps", `${String(step.index).padStart(2, "0")}-${step.name}`);
  const ctx = goldenContext(run, candidateName, versions);
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const stdout = read(`${base}.stdout`);
  const json = parseJsonOrNull(stdout);
  const body = json === null ? normalizeText(stdout, ctx) : `${JSON.stringify(normalizeJson(json, ctx, { sortObjectArrays: true }), null, 2)}\n`;
  return [`exit ${step.exitCode ?? `signal ${step.signal}`}`, "--- stdout", body, "--- stderr", normalizeText(read(`${base}.stderr`), ctx)].join("\n");
}

/** Compare a candidate run's golden steps with the files committed under `goldensDir/<scenario>/`. */
export function goldenChecks(scenario: Scenario, cand: RunDir, candidateName: BinaryName, versions: string[], goldensDir: string | undefined): CheckResult[] {
  if (!goldensDir || !scenario.goldens) return [];
  const dir = join(goldensDir, scenario.name);
  if (!existsSync(dir)) return [{ name: "goldens", ok: true, details: `no goldens committed for ${scenario.name} on this platform yet` }];
  const checks: CheckResult[] = [];
  for (const stepName of scenario.goldens) {
    const p = join(dir, `${stepName}.txt`);
    const got = goldenText(cand, stepName, candidateName, versions);
    if (!existsSync(p) || got === null) {
      checks.push({ name: `golden ${stepName}`, ok: !existsSync(p) && got === null, details: existsSync(p) ? "step missing from the run" : "no golden file" });
      continue;
    }
    const want = readFileSync(p, "utf8");
    if (want === got) {
      checks.push({ name: `golden ${stepName}`, ok: true, details: "matches the committed output" });
      continue;
    }
    const la = want.split("\n");
    const lb = got.split("\n");
    const lines: string[] = [];
    for (let i = 0; i < Math.max(la.length, lb.length) && lines.length < 30; i++) {
      if (la[i] !== lb[i]) lines.push(`@${i + 1}`, `- ${la[i] ?? ""}`, `+ ${lb[i] ?? ""}`);
    }
    checks.push({ name: `golden ${stepName}`, ok: false, details: lines.join("\n") });
  }
  return checks;
}

/** Write a run's golden steps under `dir/<scenario>/`; returns the step names written. */
export function writeGoldens(scenario: Scenario, run: RunDir, candidateName: BinaryName, versions: string[], dir: string): string[] {
  if (!scenario.goldens) return [];
  const target = join(dir, scenario.name);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const stepName of scenario.goldens) {
    const text = goldenText(run, stepName, candidateName, versions);
    if (text === null) continue;
    writeFileSync(join(target, `${stepName}.txt`), text);
    written.push(stepName);
  }
  return written;
}
