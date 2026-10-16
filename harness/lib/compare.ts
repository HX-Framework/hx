// Comparators: given two run directories, what must be identical and how
// each difference is reported.
//
//   stored bytes      the gateway store manifest (every canonical object's
//                     size and sha256, agent lanes and sidecars included)
//   requests          per step, per session: the sequence of requests
//                     (method, path, query, headers, body); per step, per
//                     endpoint for requests that belong to no session; batch
//                     endpoints as multisets of their items
//   state.json        normalized, timestamps run-relative with a tolerance
//   activity.jsonl    multiset of entries, timestamps dropped, count kept
//   CLI steps         exit code, normalized stdout and stderr (sorted lines
//                     where the step says so; the DISTINCT lines for a
//                     long-running daemon step, whose repetition counts are
//                     cadence)
//   hx ui             each probe's status and normalized JSON body
//   ccd-index.json    the saved Claude Desktop index, normalized, when the
//                     reference writes one (a candidate may not drop it)
//   state journal     empty or absent at the end of every run
//   expectations      facts the fixture manifest promises (the group mirror)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { RecordedRequest } from "../gateway/gateway.js";
import type { Manifest } from "../fixtures/gen-home.js";
import { isRelTime, normalizeJson, normalizeText, type NormalizeContext, DEFAULT_WINDOW_AFTER_MS, DEFAULT_WINDOW_BEFORE_MS } from "./normalize.js";
import type { BinaryName, CheckResult, RunMeta, Scenario, StepRecord } from "./types.js";

export interface RunDir {
  dir: string;
  meta: RunMeta;
}

export function loadRun(dir: string): RunDir {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RunMeta;
  return { dir, meta };
}

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function contextFor(run: RunDir, candidateName: BinaryName, versions: string[], toleranceMs: number, mode: "diff" | "golden"): NormalizeContext {
  void toleranceMs;
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
    mode,
  };
}

// ── Deep comparison with run-relative time tolerance ───────────────────────

export interface Difference {
  path: string;
  left: string;
  right: string;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export function deepDiff(a: unknown, b: unknown, toleranceSeconds: number, path = "$", out: Difference[] = [], limit = 50): Difference[] {
  if (out.length >= limit) return out;
  if (isRelTime(a) && isRelTime(b)) {
    if (Math.abs(a.$t - b.$t) > toleranceSeconds) out.push({ path, left: `<t${a.$t}s>`, right: `<t${b.$t}s>` });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, left: String(a.length), right: String(b.length) });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n && out.length < limit; i++) deepDiff(a[i], b[i], toleranceSeconds, `${path}[${i}]`, out, limit);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) {
      if (out.length >= limit) break;
      if (!(k in (a as object))) out.push({ path: `${path}.${k}`, left: "<absent>", right: show((b as Record<string, unknown>)[k]) });
      else if (!(k in (b as object))) out.push({ path: `${path}.${k}`, left: show((a as Record<string, unknown>)[k]), right: "<absent>" });
      else deepDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], toleranceSeconds, `${path}.${k}`, out, limit);
    }
    return out;
  }
  if (a !== b) out.push({ path, left: show(a), right: show(b) });
  return out;
}

function diffText(a: string, b: string, limit = 40): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out: string[] = [];
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (la[i] !== lb[i]) {
      out.push(`@${i + 1}`);
      if (la[i] !== undefined) out.push(`- ${la[i]}`);
      if (lb[i] !== undefined) out.push(`+ ${lb[i]}`);
    }
  }
  return out;
}

function check(name: string, diffs: Difference[] | string[], okDetails: string): CheckResult {
  if (diffs.length === 0) return { name, ok: true, details: okDetails };
  const lines = diffs.map((d) => (typeof d === "string" ? d : `${d.path}: ${d.left} ≠ ${d.right}`));
  return { name, ok: false, details: lines.slice(0, 40).join("\n") };
}

// ── The comparisons ────────────────────────────────────────────────────────

export interface CompareOptions {
  scenario: Scenario;
  candidateName: BinaryName;
}

export function compareRuns(ref: RunDir, cand: RunDir, opts: CompareOptions): CheckResult[] {
  const versions = [ref.meta.version, cand.meta.version].filter(Boolean);
  const tol = opts.scenario.compare.tsToleranceMs;
  const tolS = tol / 1000;
  const ctxRef = contextFor(ref, opts.candidateName, versions, tol, "diff");
  const ctxCand = contextFor(cand, opts.candidateName, versions, tol, "diff");
  const checks: CheckResult[] = [];

  // Driver-level failures first: a step that did not run as expected.
  for (const run of [ref, cand]) {
    const who = run === ref ? "reference" : "candidate";
    if (run.meta.failures.length > 0) {
      checks.push({ name: `${who} steps`, ok: false, details: run.meta.failures.join("\n") });
    }
  }

  // Stored bytes: every object's size and sha256. How many chunks composed
  // an object is a request-level fact, checked apart (and not after a kill,
  // where a self-heal may recompose a file from zero).
  const endState = opts.scenario.compare.requests === "end-state";
  const storeFiles: Array<[string, string]> = [["store.json", "stored bytes"], ...(ref.meta.fortressUrl ? [["fortress-store.json", "fortress stored bytes"] as [string, string]] : [])];
  for (const [file, label] of storeFiles) {
    const a = readStore(join(ref.dir, file));
    const b = readStore(join(cand.dir, file));
    const bytesOnly = (m: StoreManifest): Record<string, { bytes: number; sha256: string }> =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { bytes: v.bytes, sha256: v.sha256 }]));
    checks.push(check(label, deepDiff(bytesOnly(a), bytesOnly(b), 0), `${Object.keys(a).length} objects identical`));
    if (!endState) {
      const chunks = (m: StoreManifest): Record<string, number> =>
        Object.fromEntries(Object.entries(m).filter(([, v]) => v.components !== undefined).map(([k, v]) => [k, v.components as number]));
      checks.push(check(`${label}: composed chunks`, deepDiff(chunks(a), chunks(b), 0), "every object composed from the same number of chunks"));
    }
  }

  // Requests.
  const daemonSteps = new Set(opts.scenario.steps.filter((s) => s.kind === "watch-for").map((s) => s.name));
  if (opts.scenario.compare.requests === "per-session") {
    checks.push(...compareRequests(ref, cand, ctxRef, ctxCand, tolS, "gateway.jsonl", "requests", daemonSteps));
    if (ref.meta.fortressUrl) checks.push(...compareRequests(ref, cand, ctxRef, ctxCand, tolS, "fortress.jsonl", "fortress requests", daemonSteps));
  } else {
    checks.push({ name: "requests", ok: true, details: "end-state scenario: request sequences not compared" });
  }

  // state.json. After a SIGKILL, which file was mid-ingest is a race: a
  // chunk committed on the gateway but not yet recorded locally self-heals
  // and leaves a heal counter, and a file killed before its route echo never
  // gets its `attributed` flag until it grows. End-state scenarios drop
  // those fields; everything else in the state must still agree.
  {
    const a = readJsonFile(join(ref.dir, "state.json"));
    const b = readJsonFile(join(cand.dir, "state.json"));
    const prep = (v: unknown, ctx: NormalizeContext): unknown => normalizeJson(endState ? dropRaceFields(v) : v, ctx);
    checks.push(check("state.json", deepDiff(prep(a, ctxRef), prep(b, ctxCand), tolS), endState ? "identical after normalization (heal counters and attribution flags dropped: end-state scenario)" : "identical after normalization"));
    // Key order is not compared: the client adds a top-level key (`artifacts`,
    // `deletedSessions`) when it first records that kind of fact, so the
    // order follows which session it ingested first, and discovery order is
    // a race between pooled stats.
  }

  // activity.jsonl. A killed run appends for whatever it committed before the
  // kill, so the count is timing there.
  if (endState) {
    checks.push({ name: "activity.jsonl", ok: true, details: "end-state scenario: the killed run's entries are timing" });
  } else {
    const strip = (run: RunDir, ctx: NormalizeContext): string[] =>
      readJsonl<Record<string, unknown>>(join(run.dir, "activity.jsonl"))
        .map((e) => {
          const { at: _at, ...rest } = e;
          return JSON.stringify(normalizeJson(rest, ctx));
        })
        .sort();
    const a = strip(ref, ctxRef);
    const b = strip(cand, ctxCand);
    checks.push(check("activity.jsonl", diffText(a.join("\n"), b.join("\n")), `${a.length} entries identical`));
  }

  // Other state files: org-names.json, settings.json, config.json.
  for (const f of ["org-names.json", "settings.json", "config.json"]) {
    const a = readJsonFile(join(ref.dir, f));
    const b = readJsonFile(join(cand.dir, f));
    checks.push(check(f, deepDiff(normalizeJson(a, ctxRef), normalizeJson(b, ctxCand), tolS), "identical"));
  }

  // The saved Claude Desktop index (ccd-index.json, since 77.12). A client
  // that predates it writes none; a client that has it must write what the
  // reference writes. So: both absent is fine, a reference without one says
  // nothing about the candidate, a candidate without one while the reference
  // wrote it is a dropped file.
  {
    const a = readJsonFile(join(ref.dir, "ccd-index.json"));
    const b = readJsonFile(join(cand.dir, "ccd-index.json"));
    if (a === null && b === null) checks.push({ name: "ccd-index.json", ok: true, details: "neither run wrote one (no Claude Desktop store on this platform, or a client that predates the saved index)" });
    else if (a === null) checks.push({ name: "ccd-index.json", ok: true, details: "the reference predates the saved index; the candidate's is not compared" });
    else if (b === null) checks.push({ name: "ccd-index.json", ok: false, details: "the reference wrote ccd-index.json and the candidate did not" });
    else checks.push(check("ccd-index.json", deepDiff(normalizeJson(a, ctxRef), normalizeJson(b, ctxCand), tolS), "identical after normalization"));
  }

  // The offsets journal (state.journal.jsonl, since 77.12) is folded into
  // state.json at every exit that is not a kill, so a run must end with it
  // empty or absent — otherwise the compared state.json is stale, and so is
  // every reader that does not replay it.
  for (const run of [ref, cand]) {
    const who = run === ref ? "reference" : "candidate";
    const lines: string[] = [];
    for (const f of ["state.journal.jsonl", "state.local.journal.jsonl"]) {
      const p = join(run.dir, f);
      if (!existsSync(p)) continue;
      const n = readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
      if (n > 0) lines.push(`${f}: ${n} line${n === 1 ? "" : "s"} left unfolded`);
    }
    checks.push(check(`${who} state journal folded`, lines, "empty or absent at the end of the run"));
  }

  // CLI steps and UI probes.
  for (const step of opts.scenario.steps) {
    const rs = ref.meta.steps.find((s) => s.name === step.name);
    const cs = cand.meta.steps.find((s) => s.name === step.name);
    if (!rs || !cs) {
      checks.push({ name: `step ${step.name}`, ok: false, details: `missing in ${!rs ? "reference" : "candidate"}` });
      continue;
    }
    if (step.kind === "run" || step.kind === "watch-kill" || step.kind === "watch-for") {
      const codeOk = rs.exitCode === cs.exitCode && rs.signal === cs.signal;
      const sortLines = step.kind === "run" ? step.sortLines === true : true;
      // A long-running daemon logs on its own clock: how many ticks it ran,
      // how many times a backoff line or a refused retry repeated, is cadence.
      // Its output is compared as the SET of distinct lines, with the per-tick
      // counters summed over the run (which tick a session's retry lands in
      // follows the clock; the totals are the behavior) and the pass-level
      // backoff's length masked (it doubles once per failing tick in a row,
      // so it follows the same split).
      const distinct = step.kind === "watch-for";
      const a = normalizeText(readText(join(ref.dir, "steps", `${stepFile(rs)}.stdout`)), ctxRef);
      const b = normalizeText(readText(join(cand.dir, "steps", `${stepFile(cs)}.stdout`)), ctxCand);
      const ea = normalizeText(readText(join(ref.dir, "steps", `${stepFile(rs)}.stderr`)), ctxRef);
      const eb = normalizeText(readText(join(cand.dir, "steps", `${stepFile(cs)}.stderr`)), ctxCand);
      const prep = (s: string): string =>
        distinct ? [...new Set(foldDaemonTicks(s.split("\n").filter((l) => l.trim())))].sort().join("\n") : sortLines ? s.split("\n").sort().join("\n") : s;
      // JSON output (hx doctor sync --json) compares structurally, with the
      // timestamp tolerance and tie-prone lists sorted. A killed run's output
      // is timing, and so is what the passes after it have left to send, so
      // end-state scenarios compare only the exit of their watch steps.
      const ja = parseJsonOrNull(readText(join(ref.dir, "steps", `${stepFile(rs)}.stdout`)));
      const jb = parseJsonOrNull(readText(join(cand.dir, "steps", `${stepFile(cs)}.stdout`)));
      const timingOnly = step.kind === "watch-kill" || (endState && step.kind === "run" && step.args[0] === "watch");
      const outDiff = timingOnly
        ? []
        : ja !== null && jb !== null
          ? [...deepDiff(normalizeJson(ja, ctxRef, { sortObjectArrays: true }), normalizeJson(jb, ctxCand, { sortObjectArrays: true }), tolS).map((d) => `${d.path}: ${d.left} ≠ ${d.right}`), ...diffText(prep(ea), prep(eb)).map((l) => `stderr ${l}`)]
          : [...diffText(prep(a), prep(b)), ...diffText(prep(ea), prep(eb)).map((l) => `stderr ${l}`)];
      const lines = [...(codeOk ? [] : [`exit: ${rs.exitCode ?? rs.signal} ≠ ${cs.exitCode ?? cs.signal}`]), ...outDiff];
      checks.push(check(`step ${step.name}`, lines, `exit ${rs.exitCode ?? rs.signal}, output identical`));
    } else if (step.kind === "ui") {
      // The probe list keeps the driver's order; only the tie-prone lists
      // inside each probe's body are compared as sets.
      const a = normalizeProbes(readJsonFile(join(ref.dir, "steps", `${stepFile(rs)}.json`)), ctxRef);
      const b = normalizeProbes(readJsonFile(join(cand.dir, "steps", `${stepFile(cs)}.json`)), ctxCand);
      checks.push(check(`step ${step.name}`, deepDiff(a, b, tolS), "every probe identical"));
    }
  }

  return checks;
}

/** Daemon-step log lines: the `[hx] tick uploaded=N failed=M` lines become
 *  one `[hx] ticks: uploaded=ΣN failed=ΣM` line, and the pass-level backoff
 *  loses its length. Exported for the tests. */
export function foldDaemonTicks(lines: string[]): string[] {
  let uploaded = 0;
  let failed = 0;
  let ticks = 0;
  const out: string[] = [];
  for (const l of lines) {
    const m = /\[hx\] tick uploaded=(\d+) failed=(\d+)$/.exec(l);
    if (m) {
      uploaded += Number(m[1]);
      failed += Number(m[2]);
      ticks += 1;
      continue;
    }
    out.push(l.replace(/\[hx\] uploads not progressing; backing off \d+s$/, "[hx] uploads not progressing; backing off <n>s"));
  }
  if (ticks > 0) out.push(`[hx] ticks: uploaded=${uploaded} failed=${failed}`);
  return out;
}

function stepFile(s: StepRecord): string {
  return `${String(s.index).padStart(2, "0")}-${s.name}`;
}

function readText(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

interface ProbeFile {
  launchUrl?: string;
  probes?: Array<{ name: string; method: string; path: string; status: number; body: unknown }>;
}

function normalizeProbes(v: unknown, ctx: NormalizeContext): unknown {
  const file = (v ?? {}) as ProbeFile;
  return {
    launchUrl: typeof file.launchUrl === "string" ? normalizeText(file.launchUrl, ctx) : null,
    probes: (file.probes ?? []).map((p) => ({
      name: p.name,
      method: p.method,
      path: normalizeText(p.path, ctx),
      status: p.status,
      body: normalizeJson(p.body, ctx, { sortObjectArrays: true }),
    })),
  };
}

export function parseJsonOrNull(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function dropRaceFields(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const state = v as { files?: Record<string, Record<string, unknown>> };
  if (!state.files) return v;
  const files: Record<string, Record<string, unknown>> = {};
  for (const [k, f] of Object.entries(state.files)) {
    const { healCount: _h, healPausedUntilMs: _p, attributed: _a, ...rest } = f;
    files[k] = rest;
  }
  return { ...state, files };
}

type StoreManifest = Record<string, { bytes: number; sha256: string; components?: number }>;

function readStore(p: string): StoreManifest {
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as StoreManifest) : {};
}

function readJsonFile(p: string): unknown {
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { $unparseable: raw.slice(0, 200) };
  }
}

// ── Requests ───────────────────────────────────────────────────────────────

/** Endpoints whose batch item order follows discovery (pool completion)
 *  order: compared as sorted multisets of items across the step. */
const BATCH_PATHS: Record<string, string> = {
  "/sessions/verify": "sessions",
  "/sessions/reattribute": "items",
  "/sessions/retitle": "items",
};

const HEADER_SKIP = new Set(["host"]);

interface NormalizedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyBytes: number;
  bodySha256?: string;
  status: number;
}

function normalizeRequest(r: RecordedRequest, ctx: NormalizeContext): NormalizedRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    if (HEADER_SKIP.has(k)) continue;
    headers[k] = normalizeText(v, ctx);
  }
  return {
    method: r.method,
    path: normalizeText(r.path, ctx),
    query: normalizeText(r.query, ctx),
    headers,
    ...(r.body !== undefined ? { body: normalizeJson(r.body, ctx) } : {}),
    bodyBytes: r.bodyBytes,
    ...(r.bodySha256 ? { bodySha256: r.bodySha256 } : {}),
    status: r.status,
  };
}

function compareRequests(ref: RunDir, cand: RunDir, ctxRef: NormalizeContext, ctxCand: NormalizeContext, tolS: number, file: string, label: string, daemonSteps: Set<string> = new Set()): CheckResult[] {
  const ra = readJsonl<RecordedRequest>(join(ref.dir, file));
  const rb = readJsonl<RecordedRequest>(join(cand.dir, file));
  const fortress = file === "fortress.jsonl";
  const checks: CheckResult[] = [];
  const stepsA = ref.meta.steps;
  for (const sa of stepsA) {
    const sb = cand.meta.steps.find((s) => s.name === sa.name);
    if (!sb) continue;
    const slice = (all: RecordedRequest[], s: StepRecord): RecordedRequest[] =>
      all.filter((r) => (fortress ? r.seq >= s.fortressSeqFrom && r.seq < s.fortressSeqTo : r.seq >= s.seqFrom && r.seq < s.seqTo));
    const a = slice(ra, sa);
    const b = slice(rb, sb);
    const diffs: string[] = [];
    const daemon = daemonSteps.has(sa.name);

    // Per-session sequences. In a long-running daemon step a REFUSED workflow
    // upload (5xx) leaves the sequence: since 77.12 the client retries it on
    // a backoff, so how many attempts a run has time for is timing. The first
    // refusal is the fact, compared as presence per run below.
    const refusedWorkflow = (r: RecordedRequest): boolean => daemon && r.path === "/sessions/workflow" && r.status >= 500;
    const bySession = (rs: RecordedRequest[], ctx: NormalizeContext): Map<string, NormalizedRequest[]> => {
      const m = new Map<string, NormalizedRequest[]>();
      for (const r of rs) {
        if (!r.sessionKey || refusedWorkflow(r)) continue;
        const key = r.lane ? `${r.sessionKey}/${r.lane}` : r.sessionKey;
        const list = m.get(key) ?? [];
        list.push(normalizeRequest(r, ctx));
        m.set(key, list);
      }
      return m;
    };
    const sa2 = bySession(a, ctxRef);
    const sb2 = bySession(b, ctxCand);
    for (const key of new Set([...sa2.keys(), ...sb2.keys()])) {
      const la = sa2.get(key) ?? [];
      const lb = sb2.get(key) ?? [];
      const d = deepDiff(la, lb, tolS, key, [], 8);
      for (const x of d) diffs.push(`${x.path}: ${x.left} ≠ ${x.right}`);
      if (diffs.length > 40) break;
    }
    if (daemon) {
      const refusedRuns = (rs: RecordedRequest[]): Set<string> =>
        new Set(rs.filter(refusedWorkflow).map((r) => `${r.sessionKey}:wf:${String((r.body as { runId?: unknown } | undefined)?.runId ?? "?")} (refused ${r.status})`));
      const fa = refusedRuns(a);
      const fb = refusedRuns(b);
      for (const k of new Set([...fa, ...fb])) {
        if (fa.has(k) !== fb.has(k)) diffs.push(`${k}: refused in ${fa.has(k) ? "reference" : "candidate"} only`);
      }
    }

    // Requests that belong to no session, per endpoint. During an outage the
    // gateway refuses before it can tell which session a request names, and
    // which files the client tried before pausing follows discovery order:
    // refused calls are counted per endpoint, not compared one by one.
    const byPath = (rs: RecordedRequest[], ctx: NormalizeContext): Map<string, NormalizedRequest[]> => {
      const m = new Map<string, NormalizedRequest[]>();
      for (const r of rs) {
        if (r.sessionKey) continue;
        const refused = r.status >= 500;
        const key = `${r.method} ${normalizeText(r.path, ctx)}${r.query && !refused ? `?${normalizeText(r.query, ctx)}` : ""}${refused ? ` (refused ${r.status})` : ""}`;
        const list = m.get(key) ?? [];
        list.push(normalizeRequest(r, ctx));
        m.set(key, list);
      }
      return m;
    };
    const pa = byPath(a, ctxRef);
    const pb = byPath(b, ctxCand);
    for (const key of new Set([...pa.keys(), ...pb.keys()])) {
      const la = pa.get(key) ?? [];
      const lb = pb.get(key) ?? [];
      const path = key.split(" ")[1]!.split("?")[0]!;
      if (key.includes(" (refused ")) {
        if (la.length !== lb.length) diffs.push(`${key}: ${la.length} ≠ ${lb.length} attempts`);
        continue;
      }
      if (path === "/devices/heartbeat") {
        // Sent only when nothing reached the gateway for 60 s: a timing fact.
        if ((la.length > 0) !== (lb.length > 0)) diffs.push(`${key}: present in ${la.length > 0 ? "reference" : "candidate"} only`);
        continue;
      }
      if (path === "/route") {
        // Route discovery is single-flight per repo: pooled workers that
        // overlap share one fetch, so the count follows timing. Presence is
        // the fact, and the sequence of distinct repos asked about.
        if ((la.length > 0) !== (lb.length > 0)) diffs.push(`${key}: present in ${la.length > 0 ? "reference" : "candidate"} only`);
        continue;
      }
      if (path === "/devices/sync-status") {
        // Progress reports are throttled to 1.5 s and sent without waiting:
        // which snapshots go out is timing. Presence is the fact.
        if ((la.length > 0) !== (lb.length > 0)) diffs.push(`${key}: present in ${la.length > 0 ? "reference" : "candidate"} only`);
        continue;
      }
      const itemsKey = BATCH_PATHS[path];
      if (itemsKey) {
        const flat = (l: NormalizedRequest[]): string[] =>
          l
            .flatMap((r) => ((r.body as Record<string, unknown>)?.[itemsKey] as unknown[]) ?? [])
            .map((it) => JSON.stringify(it))
            .sort();
        const fa = flat(la);
        const fb = flat(lb);
        for (const line of diffText(fa.join("\n"), fb.join("\n"), 8)) diffs.push(`${key} items ${line}`);
        const statuses = (l: NormalizedRequest[]): string => l.map((r) => r.status).join(",");
        if (statuses(la) !== statuses(lb)) diffs.push(`${key} statuses: ${statuses(la)} ≠ ${statuses(lb)}`);
        // Headers apart from content-length, which follows the items' order.
        const headers = (l: NormalizedRequest[]): string => (l[0] ? JSON.stringify({ ...l[0].headers, "content-length": undefined }) : "");
        if (headers(la) !== headers(lb)) diffs.push(`${key} headers: ${headers(la)} ≠ ${headers(lb)}`);
        continue;
      }
      for (const x of deepDiff(la, lb, tolS, key, [], 8)) diffs.push(`${x.path}: ${x.left} ≠ ${x.right}`);
    }
    checks.push(check(`${label}: ${sa.name}`, diffs, `${a.length} requests, ${sa2.size} sessions`));
  }
  return checks;
}

// ── Fixture expectations and coverage ──────────────────────────────────────

export function fixtureExpectationChecks(run: RunDir, scenario: Scenario): CheckResult[] {
  const manifestPath = join(run.dir, "fixture.manifest.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const requests = readJsonl<RecordedRequest>(join(run.dir, "gateway.jsonl"));
  const checks: CheckResult[] = [];

  // The group mirror: on macOS (where Claude Desktop lives) the uploaded
  // mirror must be exactly what the leveldb fixture encodes; elsewhere the
  // client uploads the disabled-empty mirror.
  const mirrors = requests.filter((r) => r.path === "/sessions/group-mirror" && r.status === 200);
  const first = mirrors[0]?.body as { mirror?: Record<string, unknown> } | undefined;
  if (!first?.mirror) {
    checks.push({ name: "fixture: group mirror uploaded", ok: false, details: "no successful /sessions/group-mirror request" });
  } else {
    const got = { groupingEnabled: first.mirror.groupingEnabled, groups: first.mirror.groups, unreadIds: first.mirror.unreadIds };
    const want = run.meta.platform === "darwin" ? manifest.expectations.groupMirror : { groupingEnabled: false, groups: [], unreadIds: [] };
    checks.push(check("fixture: group mirror matches the leveldb", deepDiff(got, want, 0), run.meta.platform === "darwin" ? `${manifest.expectations.groupMirror.groups.length} groups read from the Snappy .ldb` : "no Claude Desktop on this platform: empty mirror"));
  }

  // Codex titles: every rollout with a title in state_5.sqlite must have
  // been committed with that title (first chunk) — the SQLite read path.
  const commits = requests.filter((r) => r.path === "/sessions/commit" && r.status === 200);
  const missing: string[] = [];
  for (const [id, t] of Object.entries(manifest.expectations.codexTitles)) {
    const c = commits.find((r) => r.sessionKey?.endsWith(`:${id}`));
    const meta = (c?.body as { meta?: { title?: string; titleSource?: string } } | undefined)?.meta;
    if (!c) continue; // an archived or out-of-window rollout may not upload
    if (meta?.title !== t.title || meta?.titleSource !== t.source) missing.push(`${id}: got ${JSON.stringify(meta?.title)}/${meta?.titleSource}, want ${JSON.stringify(t.title)}/${t.source}`);
  }
  checks.push(check("fixture: codex titles from state_5.sqlite", missing, `${Object.keys(manifest.expectations.codexTitles).length} titles`));

  // Every in-window session reached a store (the cloud one or the fortress),
  // unless the scenario keeps sessions back on purpose.
  if (scenario.storeComplete !== false) {
    const stored = { ...readStore(join(run.dir, "store.json")), ...readStore(join(run.dir, "fortress-store.json")) };
    const notStored = manifest.sessions
      .filter((s) => !Object.keys(stored).some((k) => k.startsWith(`${s.family}:${s.sessionId}:`)))
      .map((s) => `${s.family}:${s.sessionId} (${s.note ?? ""})`);
    // Twins share a session: one store object covers both manifest rows.
    checks.push(check("fixture: every discovered session is in the store", notStored, `${manifest.sessions.length} manifest sessions`));
  }
  return checks;
}

/** The 24 calls the client makes, as path patterns. */
export const PROTOCOL_CALLS: Array<{ name: string; method: string; path: RegExp }> = [
  { name: "devices/code", method: "POST", path: /^\/devices\/code$/ },
  { name: "devices/poll", method: "POST", path: /^\/devices\/poll$/ },
  { name: "whoami", method: "GET", path: /^\/whoami$/ },
  { name: "devices/disconnect", method: "POST", path: /^\/devices\/disconnect$/ },
  { name: "ping", method: "GET", path: /^\/ping$/ },
  { name: "devices/inventory", method: "GET", path: /^\/devices\/inventory$/ },
  { name: "devices/heartbeat", method: "POST", path: /^\/devices\/heartbeat$/ },
  { name: "devices/sync-status", method: "POST", path: /^\/devices\/sync-status$/ },
  { name: "route", method: "GET", path: /^\/route$/ },
  { name: "sessions/append-url", method: "POST", path: /^\/sessions\/append-url$/ },
  { name: "signed PUT", method: "PUT", path: /^\/_put\// },
  { name: "sessions/commit", method: "POST", path: /^\/sessions\/commit$/ },
  { name: "sessions/agent-append-url", method: "POST", path: /^\/sessions\/agent-append-url$/ },
  { name: "sessions/agent-commit", method: "POST", path: /^\/sessions\/agent-commit$/ },
  { name: "sessions/verify", method: "POST", path: /^\/sessions\/verify$/ },
  { name: "sessions/reattribute", method: "POST", path: /^\/sessions\/reattribute$/ },
  { name: "sessions/retitle", method: "POST", path: /^\/sessions\/retitle$/ },
  { name: "sessions/tasks", method: "POST", path: /^\/sessions\/tasks$/ },
  { name: "sessions/plan", method: "POST", path: /^\/sessions\/plan$/ },
  { name: "sessions/workflow", method: "POST", path: /^\/sessions\/workflow$/ },
  { name: "sessions/team-mirror", method: "POST", path: /^\/sessions\/team-mirror$/ },
  { name: "sessions/group-mirror", method: "POST", path: /^\/sessions\/group-mirror$/ },
  { name: "download/hx-version", method: "GET", path: /^\/download\/hx2?-version$/ },
  { name: "download/hx-<os>-<arch>.gz + .sha256", method: "GET", path: /^\/download\/hx2?-[a-z]+-[a-z0-9]+\.(gz|sha256)$/ },
];

export function coverageCheck(runDirs: string[], required = true): CheckResult {
  const seen = new Map<string, number>();
  for (const dir of runDirs) {
    for (const file of ["gateway.jsonl", "fortress.jsonl"]) {
      for (const r of readJsonl<RecordedRequest>(join(dir, file))) {
        for (const c of PROTOCOL_CALLS) {
          if (r.method === c.method && c.path.test(r.path)) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
        }
      }
    }
  }
  const missing = PROTOCOL_CALLS.filter((c) => !seen.has(c.name)).map((c) => c.name);
  const lines = PROTOCOL_CALLS.map((c) => `${seen.has(c.name) ? "✓" : "✗"} ${c.name}: ${seen.get(c.name) ?? 0}`);
  if (!required) lines.push("(advisory: not every scenario ran)");
  return { name: "coverage: all 24 calls recorded", ok: missing.length === 0 || !required, details: lines.join("\n") };
}

/** Every step output file in a run dir, for the golden writer. */
export function listStepOutputs(dir: string): string[] {
  const p = join(dir, "steps");
  return existsSync(p) ? readdirSync(p).sort() : [];
}
