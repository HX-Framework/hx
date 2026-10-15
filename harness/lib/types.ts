// Shapes shared by the driver, the comparators and the report.

import type { GatewayConfig } from "../gateway/gateway.js";
import type { Shape } from "../fixtures/gen-home.js";

export type BinaryName = "hx" | "hx2";

/** One thing the driver does to one binary, in order. */
export type Step =
  | {
      kind: "run";
      name: string;
      args: string[];
      /** Exit code the step must end with; a different one fails the run. */
      expectExit?: number;
      timeoutMs?: number;
      /** Compare stdout as a sorted multiset of lines (pooled uploads log in
       *  completion order). */
      sortLines?: boolean;
      /** Extra environment for this step only. */
      env?: Record<string, string>;
    }
  | { kind: "gateway"; name: string; patch: Partial<GatewayConfig> }
  | { kind: "fortress"; name: string; patch: Partial<GatewayConfig> }
  /** Stop listening (connection refused) / listen again on the same port, keeping the recording and the store. */
  | { kind: "gateway-stop"; name: string }
  | { kind: "gateway-start"; name: string }
  | {
      kind: "watch-kill";
      name: string;
      /** SIGKILL the long-running `hx watch` once the gateway has composed this many chunks. */
      killAfterCommits: number;
      putDelayMs: number;
      timeoutMs?: number;
    }
  | { kind: "ui"; name: string; port: number }
  | { kind: "chmod-hx-dir"; name: string; mode: number }
  | {
      kind: "grow";
      name: string;
      /** Index into the fixture manifest's sessions. */
      sessionIndex: number;
      /** Approximate bytes of transcript lines to append. */
      bytes: number;
    }
  | { kind: "settings"; name: string; patch: Record<string, unknown> };

export interface CompareSpec {
  /** "per-session": request sequences per session must match. "end-state":
   *  only the stored bytes, the state files and the last CLI steps are
   *  compared (timing-dependent scenarios such as kill -9). */
  requests: "per-session" | "end-state";
  /** Tolerance for timestamps that are relative to the run, in ms. */
  tsToleranceMs: number;
}

export interface Scenario {
  name: string;
  description: string;
  shape: Shape;
  seed: string;
  /** Written to ~/.let/hx/settings.json before the first step. */
  settings?: Record<string, unknown>;
  /** Initial cloud gateway configuration. */
  gateway?: Partial<GatewayConfig>;
  /** Start a second gateway standing in for an hx-fortress. */
  fortress?: Partial<GatewayConfig>;
  steps: Step[];
  compare: CompareSpec;
  /** CLI steps whose normalized output is also kept as a golden file. */
  goldens?: string[];
}

export interface StepRecord {
  index: number;
  name: string;
  kind: Step["kind"];
  /** Gateway record sequence numbers this step produced (cloud), inclusive-exclusive. */
  seqFrom: number;
  seqTo: number;
  fortressSeqFrom: number;
  fortressSeqTo: number;
  startedAtMs: number;
  endedAtMs: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
}

export interface RunMeta {
  scenario: string;
  binary: string;
  name: BinaryName;
  version: string;
  platform: string;
  arch: string;
  home: string;
  workDir: string;
  gatewayUrl: string;
  fortressUrl: string | null;
  startedAtMs: number;
  endedAtMs: number;
  steps: StepRecord[];
  /** Steps whose expectExit was not met, or that errored. */
  failures: string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** A short explanation, and for a failure the first lines of the diff. */
  details: string;
}

export interface ScenarioReport {
  scenario: string;
  ok: boolean;
  checks: CheckResult[];
  referenceMs: number;
  candidateMs: number;
}

export interface HarnessReport {
  generatedAt: string;
  platform: string;
  reference: { binary: string; version: string; name: BinaryName };
  candidate: { binary: string; version: string; name: BinaryName };
  expect: "pass" | "fail";
  ok: boolean;
  scenarios: ScenarioReport[];
  coverage: CheckResult;
}
