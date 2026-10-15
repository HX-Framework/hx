import { describe, expect, it } from "bun:test";

import { deepDiff } from "./compare.js";
import { DEFAULT_WINDOW_AFTER_MS, DEFAULT_WINDOW_BEFORE_MS, normalizeJson, normalizeText, type NormalizeContext } from "./normalize.js";

const anchor = Date.UTC(2026, 9, 15, 19, 0, 0);
const ctx = (shift = 0): NormalizeContext => ({
  candidateName: "hx2",
  versions: ["77.11.0", "78.0.0"],
  home: "/tmp/home",
  workDir: "/tmp/work",
  gatewayUrl: "http://127.0.0.1:48621",
  fortressUrl: null,
  anchorMs: anchor + shift,
  windowBeforeMs: DEFAULT_WINDOW_BEFORE_MS,
  windowAfterMs: DEFAULT_WINDOW_AFTER_MS,
  mode: "diff",
});

describe("normalizeJson with sortObjectArrays", () => {
  it("makes tie-ordered lists compare equal, even when run-relative times drift within tolerance", () => {
    interface Folder {
      id: string;
      branch: string;
      sessions: number;
      lastUploadAtMs: number;
      attributed: boolean | null;
    }
    const folderA: Folder = { id: "claude-cli:~/work/acme-repo", branch: "main", sessions: 6, lastUploadAtMs: anchor + 5_000, attributed: null };
    const folderB: Folder = { id: "claude-cli:~/work/acme-repo/.worktrees/wt1", branch: "feature", sessions: 2, lastUploadAtMs: anchor + 7_000, attributed: false };
    const runA = { probes: [{ name: "snapshot", body: { folders: [folderA, folderB], generatedAt: new Date(anchor + 9_000).toISOString() } }] };
    // The second run saw the folders the other way round and its clock 3 s later.
    const later = (f: Folder): Folder => ({ ...f, lastUploadAtMs: f.lastUploadAtMs + 3_000 });
    const runB = { probes: [{ name: "snapshot", body: { folders: [later(folderB), later(folderA)], generatedAt: new Date(anchor + 12_000).toISOString() } }] };
    const a = normalizeJson(runA, ctx(0), { sortObjectArrays: true });
    const b = normalizeJson(runB, ctx(3_000), { sortObjectArrays: true });
    expect(deepDiff(a, b, 5)).toEqual([]);
    // Without the option the order shows up, as it should for request sequences.
    expect(deepDiff(normalizeJson(runA, ctx(0)), normalizeJson(runB, ctx(3_000)), 5).length).toBeGreaterThan(0);
  });

  it("masks per-run tokens, probe measurements and the candidate's name", () => {
    const v = normalizeJson({ sessionToken: "abc", latencyMs: 12, bytesPerSec: 1e9, quality: "Excellent", note: "hx2/78.0.0 at http://127.0.0.1:48621/x" }, ctx());
    expect(v).toEqual({ bytesPerSec: "<measured>", latencyMs: "<measured>", note: "hx/<version> at <GATEWAY>/x", quality: "<quality>", sessionToken: "<token>" });
  });
});

describe("normalizeText", () => {
  it("masks the transcript a refusing gateway was tried with, and the probe line", () => {
    const line = "2026-10-15 19:16:11   [error] /tmp/home/.claude/projects/-x/0dfb695e-88b4-4491-911b-0f2a94e71eee.jsonl: append-url failed: 503 {\"error\":\"service_unavailable\"}";
    expect(normalizeText(line, ctx())).toBe("<stamp>   [error] <a transcript>: append-url failed: 503 {\"error\":\"service_unavailable\"}");
    expect(normalizeText("Connection: up — Excellent (1 ms, 212.4 MB/s)", ctx())).toBe("Connection: up — <quality> (<latency>, <rate>)");
    // A 4xx names a real per-file fault and keeps its file.
    expect(normalizeText("[error] /tmp/home/x/a.jsonl: commit failed: 400 bad", ctx())).toContain("<HOME>/x/a.jsonl: commit failed: 400");
  });
});
