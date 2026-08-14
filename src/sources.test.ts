import { describe, it, beforeAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverAll,
  discoverClaudeChildren,
  discoverClaudeFiles,
  discoverCodexFiles,
} from "./sources.js";
import type { DataRoot } from "./roots.js";

// Two synthetic Claude roots + one Codex root, built once. Every file gets a
// fresh mtime (now), so the 30-day discovery window keeps all of them.
let rootA: string;
let rootB: string;
let codexRoot: string;
const asRoot = (dir: string): DataRoot => ({ configDir: dir, origin: "settings", exists: true });

function put(filePath: string, content = `{"sessionId":"x"}\n`): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

const SID = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "hx-sources-"));
  rootA = join(base, "rootA");
  rootB = join(base, "rootB");
  codexRoot = join(base, "codex");

  // Parent transcripts, one per root.
  put(join(rootA, "projects", "-proj-a", "aaaa1111.jsonl"));
  put(join(rootB, "projects", "-proj-b", "bbbb2222.jsonl"));
  // Hidden/memory dirs must stay ignored.
  put(join(rootA, "projects", "memory", "notes.jsonl"));

  // Child lanes: interactive subagent under root A…
  put(join(rootA, "projects", "-proj-a", SID, "subagents", "agent-child1.jsonl"));
  // …and a workflow run SPLIT across roots: journal under A, script under B.
  put(join(rootA, "projects", "-proj-a", SID, "subagents", "workflows", "wf_run1", "journal.jsonl"));
  put(join(rootB, "projects", "-proj-b", SID, "workflows", "scripts", "myflow-wf_run1.js"), "// s\n");

  // Codex: one live rollout + one archived.
  put(join(codexRoot, "sessions", "2026", "07", "27", "rollout-2026-07-27T10-00-00-abc.jsonl"));
  put(join(codexRoot, "archived_sessions", "2026", "07", "20", "rollout-2026-07-20T09-00-00-def.jsonl"));
});

// Asserts POSIX path semantics with POSIX literals ("/a", "relative/path"),
// so it cannot hold on Windows, where those are not absolute and normalize
// with backslashes. Not a gap in Windows support — the behavior under test
// is the platform's, and the Windows-specific paths have their own tests.
describe.skipIf(process.platform === "win32")("discoverClaudeFiles", () => {
  it("unions parents across roots and tags each with its rootDir", async () => {
    const files = await discoverClaudeFiles([asRoot(rootA), asRoot(rootB)]);
    const byName = new Map(files.map((f) => [f.path.split("/").pop(), f]));
    assert.equal(files.length, 2);
    assert.equal(byName.get("aaaa1111.jsonl")?.rootDir, rootA);
    assert.equal(byName.get("bbbb2222.jsonl")?.rootDir, rootB);
  });

  it("returns nothing for a root with no projects dir", async () => {
    const files = await discoverClaudeFiles([asRoot(join(rootA, "nope"))]);
    assert.deepEqual(files, []);
  });
});

describe("discoverClaudeChildren", () => {
  it("finds children in every root and merges split workflow runs across roots", async () => {
    const { children, runs } = await discoverClaudeChildren([asRoot(rootA), asRoot(rootB)]);
    assert.deepEqual(
      children.map((c) => [c.agentId, c.parentSessionId, c.rootDir]),
      [["child1", SID, rootA]],
    );
    // ONE run entry for wf_run1 — journal from root A, script from root B.
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.runId, "wf_run1");
    assert.equal(run.parentSessionId, SID);
    assert.ok(run.journalPath?.startsWith(rootA));
    assert.ok(run.scriptPath?.startsWith(rootB));
    assert.equal(run.scriptName, "myflow");
  });
});

describe.skipIf(process.platform === "win32")("discoverCodexFiles", () => {
  it("walks sessions + archived per root with rootDir tags", async () => {
    const files = await discoverCodexFiles([asRoot(codexRoot)]);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.rootDir === codexRoot && f.source === "codex"));
  });

  it("honors includeArchived: false", async () => {
    const files = await discoverCodexFiles([asRoot(codexRoot)], { includeArchived: false });
    assert.equal(files.length, 1);
    assert.ok(files[0]!.path.includes("/sessions/"));
  });
});

describe("discoverAll", () => {
  it("unions both families over the resolved root sets", async () => {
    const all = await discoverAll({
      claude: [asRoot(rootA), asRoot(rootB)],
      codex: [asRoot(codexRoot)],
    });
    assert.equal(all.filter((f) => f.source === "claude").length, 2);
    assert.equal(all.filter((f) => f.source === "codex").length, 2);
  });
});
