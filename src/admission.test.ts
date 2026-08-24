// Admission coverage: anything owed must be reachable by SOME sweep.
//
// The invariant, stated over owed-ness rather than over what the ledger would
// bill:
//
//     size > 0  ∧  on disk  ∧  minOffset(state) < size   ⇒   admitted
//
// where "admitted" means the file appears in the union of what the hot loop
// sees (catalog.listFiles / listChildren) and what the hourly sweep selects
// (discoverBackfill / discoverChildBackfill). Owed-ness is the right predicate
// because billing routes through classifyFile and the destination registry,
// which adds fixture weight without adding coverage — billed ⊂ owed, so
// pinning owed pins billing too.
//
// This exists because the two sweeps used to key on DIFFERENT things and the
// gap between them was invisible. The hot loop prunes by project-DIRECTORY
// mtime; appending to a transcript never bumps its directory. The sweep used
// to mirror that window from the other side, skipping anything modified within
// 30 days. So a file appended minutes ago inside a directory untouched for a
// year belonged to neither — while the status report, which scans unwindowed,
// went on billing it as owed. Forever, since an aged dir is never re-readdir'd
// and the catalog is rebuilt from empty on every restart.
//
// The matrix below is the full cross-product of the three things that decide
// admission (dir age × file age × delivery state), for parents and for child
// lanes. Any future windowing added to either sweep fails here.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryCatalog } from "./catalog.js";
import { discoverBackfill, discoverChildBackfill } from "./backfill.js";
import { minOffset, type FileState, type HxState } from "./state.js";
import type { DataRoot, ResolvedRoots } from "./roots.js";

const DAY = 86_400_000;
const NOW = Date.now();
const FRESH = NOW - 5 * 60_000;      // minutes old
const AGED = NOW - 400 * DAY;        // far outside any 30-day window

let base: string;

function mkRoots(): ResolvedRoots {
  base = mkdtempSync(join(tmpdir(), "hx-admission-"));
  mkdirSync(join(base, "claude", "projects"), { recursive: true });
  mkdirSync(join(base, "claude", "sessions"), { recursive: true });
  mkdirSync(join(base, "codex", "sessions"), { recursive: true });
  const root = (configDir: string): DataRoot => ({ configDir, origin: "default", exists: true });
  return { claude: [root(join(base, "claude"))], codex: [root(join(base, "codex"))] };
}

const touch = (p: string, ms: number): void => utimesSync(p, new Date(ms), new Date(ms));

const entry = (path: string, offsets: Record<string, number>): FileState => ({
  path,
  family: "claude-cli",
  sessionId: path,
  offsets,
  lastMtimeMs: NOW,
  lastUploadAtMs: NOW,
});

/** One cell of the matrix. `delivery` is what state claims about the file. */
interface Cell {
  name: string;
  dirAged: boolean;
  fileAged: boolean;
  delivery: "none" | "partial" | "complete";
}

const SIZE = 1_000;

const CELLS: Cell[] = [];
for (const dirAged of [false, true]) {
  for (const fileAged of [false, true]) {
    for (const delivery of ["none", "partial", "complete"] as const) {
      CELLS.push({
        name: `dir-${dirAged ? "aged" : "fresh"}_file-${fileAged ? "aged" : "fresh"}_${delivery}`,
        dirAged,
        fileAged,
        delivery,
      });
    }
  }
}

const owed = (c: Cell): boolean => c.delivery !== "complete";

function stateFor(paths: Map<string, Cell>): HxState {
  const files: Record<string, FileState> = {};
  for (const [p, c] of paths) {
    if (c.delivery === "partial") files[p] = entry(p, { letai: SIZE / 2 });
    if (c.delivery === "complete") files[p] = entry(p, { letai: SIZE });
  }
  return { files };
}

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("admission coverage — parents", () => {
  it("every owed file is reachable by the catalog or the sweep", async () => {
    const roots = mkRoots();
    // One project dir per cell so dir mtime is controlled independently.
    const paths = new Map<string, Cell>();
    for (const c of CELLS) {
      const dir = join(base, "claude", "projects", `p-${c.name}`);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${c.name}.jsonl`);
      writeFileSync(p, "x".repeat(SIZE));
      touch(p, c.fileAged ? AGED : FRESH);
      // Dir mtime LAST: creating the file bumped it, and the whole point is
      // that a dir's mtime can lag its members arbitrarily.
      touch(dir, c.dirAged ? AGED : FRESH);
      paths.set(p, c);
    }
    const state = stateFor(paths);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    const admitted = new Set(cat.listFiles().map((f) => f.path));
    for (const f of await discoverBackfill(roots, state, NOW)) admitted.add(f.path);

    const missed: string[] = [];
    for (const [p, c] of paths) {
      const fs = state.files[p];
      const isOwed = !fs || minOffset(fs) < SIZE;
      assert.equal(isOwed, owed(c), `${c.name}: fixture and predicate must agree`);
      if (isOwed && !admitted.has(p)) missed.push(c.name);
    }
    assert.deepEqual(missed, [], "owed but reachable by no sweep");
  });

  it("names the exact cell that used to be unreachable", async () => {
    // Regression pin, kept separate so a failure reads as the specific hole
    // rather than a matrix diff: recent file, dormant directory, never
    // ingested. The catalog cannot see it (dir pruned) and the old sweep
    // skipped it (file too new).
    const roots = mkRoots();
    const dir = join(base, "claude", "projects", "dormant-worktree");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "resumed.jsonl");
    writeFileSync(p, "x".repeat(SIZE));
    touch(p, FRESH);
    touch(dir, AGED);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    assert.equal(
      cat.listFiles().some((f) => f.path === p),
      false,
      "the hot loop still cannot see it — that behaviour is deliberate and unchanged",
    );

    const swept = await discoverBackfill(roots, { files: {} }, NOW);
    assert.equal(swept.some((f) => f.path === p), true, "the sweep must reach it");
  });
});

describe("admission coverage — child lanes", () => {
  it("every owed lane is reachable by the catalog or the child sweep", async () => {
    const roots = mkRoots();
    const paths = new Map<string, Cell>();
    for (const c of CELLS) {
      const projectDir = join(base, "claude", "projects", `p-${c.name}`);
      const sid = `s-${c.name}`;
      const subagents = join(projectDir, sid, "subagents");
      mkdirSync(subagents, { recursive: true });
      // A parent transcript beside it: a lane whose parent is fully delivered
      // is the shape the lane-pause and vault-bench paths manufacture, and it
      // is covered by construction here since parent delivery is independent.
      const parent = join(projectDir, `${sid}.jsonl`);
      writeFileSync(parent, "x".repeat(SIZE));
      touch(parent, c.fileAged ? AGED : FRESH);

      const lane = join(subagents, "agent-a1.jsonl");
      writeFileSync(lane, "z".repeat(SIZE));
      touch(lane, c.fileAged ? AGED : FRESH);
      touch(subagents, c.fileAged ? AGED : FRESH);
      touch(join(projectDir, sid), c.dirAged ? AGED : FRESH);
      touch(projectDir, c.dirAged ? AGED : FRESH);
      paths.set(lane, c);
    }
    const state = stateFor(paths);

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, NOW);
    const admitted = new Set(cat.listChildren().children.map((c) => c.path));
    for (const c of (await discoverChildBackfill(roots, state)).children) admitted.add(c.path);

    const missed: string[] = [];
    for (const [p, c] of paths) {
      const fs = state.files[p];
      if ((!fs || minOffset(fs) < SIZE) && !admitted.has(p)) missed.push(c.name);
    }
    assert.deepEqual(missed, [], "lane owed but reachable by no sweep");
  });

  it("reaches a lane that has been quiet for a year — the paused-lane shape", async () => {
    // A lane frozen by the parent-lane latch or benched by an offline vault
    // goes quiet without being delivered. Quiet used to mean gone: the child
    // walk windowed each transcript by mtime, so 30 days later the lane left
    // discovery while the ledger kept billing it.
    const roots = mkRoots();
    const projectDir = join(base, "claude", "projects", "proj");
    const sid = "sess";
    const subagents = join(projectDir, sid, "subagents");
    mkdirSync(subagents, { recursive: true });
    const lane = join(subagents, "agent-frozen.jsonl");
    writeFileSync(lane, "z".repeat(SIZE));
    touch(lane, AGED);
    touch(subagents, AGED);
    touch(join(projectDir, sid), FRESH);
    touch(projectDir, FRESH);

    const swept = await discoverChildBackfill(roots, { files: {} });
    assert.equal(swept.children.some((c) => c.path === lane), true);
  });
});
