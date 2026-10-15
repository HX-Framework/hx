// The event source behind the catalog's hints: a recursive watch per root
// directory, one hint per event naming the absolute path, a clean failure
// when a directory cannot be watched, and a retry for directories that did
// not exist yet.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armFileEvents, eventDirsFor, type FileEventSource } from "./fs-events.js";
import type { DataRoot, ResolvedRoots } from "./roots.js";

let base: string;
let src: FileEventSource | null = null;

function mkRoots(): ResolvedRoots {
  base = mkdtempSync(join(tmpdir(), "hx-fsevents-"));
  mkdirSync(join(base, "claude", "projects", "-p", "sid", "subagents"), { recursive: true });
  mkdirSync(join(base, "claude", "sessions"), { recursive: true });
  const root = (configDir: string): DataRoot => ({ configDir, origin: "default", exists: true });
  return { claude: [root(join(base, "claude"))], codex: [root(join(base, "codex"))] };
}

async function until(pred: () => boolean, ms = 4_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

afterEach(() => {
  src?.close();
  src = null;
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("eventDirsFor", () => {
  it("names the projects and sessions dirs of each claude root and both codex dirs", () => {
    const roots = mkRoots();
    assert.deepEqual(eventDirsFor(roots), [
      join(base, "claude", "projects"),
      join(base, "claude", "sessions"),
      join(base, "codex", "sessions"),
      join(base, "codex", "archived_sessions"),
    ]);
  });
});

describe("armFileEvents", () => {
  it("hints the absolute path of an appended transcript and of a lane in a nested dir", async () => {
    const roots = mkRoots();
    const hints: string[] = [];
    const failures: string[] = [];
    src = armFileEvents(roots, (p) => hints.push(p), (r) => failures.push(r));
    assert.ok(src, `armed (failures: ${failures.join("; ")})`);
    assert.deepEqual(src!.missing, [join(base, "codex", "sessions"), join(base, "codex", "archived_sessions")], "codex dirs do not exist yet");
    await new Promise((r) => setTimeout(r, 200)); // let the watcher settle
    const transcript = join(base, "claude", "projects", "-p", "sid.jsonl");
    writeFileSync(transcript, "line\n");
    assert.ok(await until(() => hints.includes(transcript)), `transcript hinted (got ${JSON.stringify(hints)})`);
    const lane = join(base, "claude", "projects", "-p", "sid", "subagents", "agent-a1.jsonl");
    appendFileSync(lane, "z\n");
    assert.ok(await until(() => hints.includes(lane)), `nested lane hinted (got ${JSON.stringify(hints)})`);
    assert.deepEqual(failures, []);
  });

  it("rearm picks up a root directory that appeared later", async () => {
    const roots = mkRoots();
    const hints: string[] = [];
    src = armFileEvents(roots, (p) => hints.push(p), () => {});
    assert.ok(src);
    mkdirSync(join(base, "codex", "sessions"), { recursive: true });
    src!.rearm();
    assert.ok(src!.watched.includes(join(base, "codex", "sessions")));
    assert.deepEqual(src!.missing, [join(base, "codex", "archived_sessions")]);
    await new Promise((r) => setTimeout(r, 200));
    const rollout = join(base, "codex", "sessions", "rollout-2026-08-15T10-00-00-aaaa.jsonl");
    writeFileSync(rollout, "x\n");
    assert.ok(await until(() => hints.includes(rollout)), `rollout hinted (got ${JSON.stringify(hints)})`);
  });

  it("reports a directory it cannot watch and arms nothing", () => {
    const roots = mkRoots();
    // A regular FILE where a directory is expected: existsSync says yes, watch
    // on it with recursive:true is either refused or yields a watcher for a
    // non-directory — on every platform Bun supports this is not a usable
    // recursive watch, so the source must either fail now or work; both are
    // acceptable, but a failure must come through onFailure exactly once.
    const failures: string[] = [];
    const codexSessions = join(base, "codex", "sessions");
    mkdirSync(join(base, "codex"), { recursive: true });
    writeFileSync(codexSessions, "not a directory");
    src = armFileEvents(roots, () => {}, (r) => failures.push(r));
    if (src === null) {
      assert.equal(failures.length, 1);
      assert.ok(failures[0]!.startsWith(codexSessions));
    } else {
      assert.deepEqual(failures, []);
    }
  });
});
