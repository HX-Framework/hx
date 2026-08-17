// Catalog equivalence property tests (LETAIR-144 WS1, verification item 2).
//
// The contract: catalog.listFiles() / listChildren() are drop-ins for fresh
// discover*() — set-equal after a settle sweep (every tier due), with
// creations/deletions/renames visible ≤1 tick and appends ≤ their tier
// interval. Both age-out edge shapes are pinned: the file window-edge append
// SURVIVES (re-stat-first), and the D-A dir-edge file DROPS (a member's
// recent mtime must not rescue it — today's hole, replicated deliberately).
//
// Clock discipline: discover*() uses the real Date.now() internally, so the
// harness keeps fixture mtimes relative to real now and drives the CATALOG's
// clock forward explicitly (sweep(roots, at(...))). Window-edge margins are
// hours wide, so seconds of real-clock skew cannot flip an assertion.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryCatalog } from "./catalog.js";
import {
  discoverClaudeChildren,
  discoverClaudeFiles,
  discoverCodexFiles,
  type DiscoveredFile,
} from "./sources.js";
import type { DataRoot, ResolvedRoots } from "./roots.js";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

let base: string;

function mkRoots(): ResolvedRoots {
  base = mkdtempSync(join(tmpdir(), "hx-catalog-"));
  mkdirSync(join(base, "claude", "projects"), { recursive: true });
  mkdirSync(join(base, "claude", "sessions"), { recursive: true });
  mkdirSync(join(base, "codex", "sessions"), { recursive: true });
  const root = (configDir: string): DataRoot => ({ configDir, origin: "default", exists: true });
  return { claude: [root(join(base, "claude"))], codex: [root(join(base, "codex"))] };
}

const T0 = Date.now();
const at = (deltaMs: number): number => T0 + deltaMs;

function touch(p: string, mtimeMs: number): void {
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

/** Write a session jsonl with a controlled mtime; dir mtime optionally pinned
 *  afterwards (creations naturally bump it — pass dirMtime to simulate an old
 *  dir whose mtime the test controls). */
function mkFile(project: string, name: string, bytes: number, mtimeMs: number, dirMtime?: number): string {
  const dir = join(base, "claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "x".repeat(bytes));
  touch(p, mtimeMs);
  touch(dir, dirMtime ?? mtimeMs);
  return p;
}

function mkCodex(day: string, name: string, bytes: number, mtimeMs: number): string {
  const dir = join(base, "codex", "sessions", "2026", "08", day);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "y".repeat(bytes));
  touch(p, mtimeMs);
  touch(dir, mtimeMs);
  return p;
}

function mkChild(project: string, sid: string, agentId: string, bytes: number, mtimeMs: number): string {
  const dir = join(base, "claude", "projects", project, sid, "subagents");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(p, "z".repeat(bytes));
  touch(p, mtimeMs);
  return p;
}

function mkTracker(pid: number, sessionId: string, startedAt: number): void {
  const p = join(base, "claude", "sessions", `${pid}.json`);
  writeFileSync(p, JSON.stringify({ pid, sessionId, cwd: "/w", startedAt }));
}

const key = (f: DiscoveredFile): string => `${f.path}|${f.size}|${f.mtimeMs}`;

async function groundTruth(roots: ResolvedRoots): Promise<Set<string>> {
  const [c, x] = await Promise.all([
    discoverClaudeFiles(roots.claude),
    discoverCodexFiles(roots.codex),
  ]);
  return new Set([...c, ...x].map(key));
}

function catalogSet(cat: DiscoveryCatalog): Set<string> {
  return new Set(cat.listFiles().map(key));
}

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("catalog equivalence", () => {
  it("first sweep equals full discovery (parents, children, runs)", async () => {
    const roots = mkRoots();
    mkFile("pa", "s1.jsonl", 100, at(-1 * H));
    mkFile("pa", "s2.jsonl", 200, at(-2 * DAY));
    mkFile("pb", "s3.jsonl", 300, at(-10 * DAY));
    mkCodex("15", "rollout-2026-08-15T10-00-00-aaaa.jsonl", 50, at(-2 * DAY));
    mkChild("pa", "s1", "ag1", 40, at(-30 * MIN));

    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));

    const truthChildren = await discoverClaudeChildren(roots.claude);
    const got = cat.listChildren();
    assert.deepEqual(
      got.children.map((c) => c.path).sort(),
      truthChildren.children.map((c) => c.path).sort(),
    );
  });

  it("creations and deletions land within one tick", async () => {
    const roots = mkRoots();
    mkFile("pa", "s1.jsonl", 100, at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    const p2 = mkFile("pa", "s2.jsonl", 150, at(0)); // dir mtime bumps
    await cat.sweep(roots, at(1_500));
    assert.ok(catalogSet(cat).has(`${p2}|150|${at(0)}`), "creation visible next tick");

    rmSync(p2);
    touch(join(base, "claude", "projects", "pa"), at(2_000));
    await cat.sweep(roots, at(3_000));
    assert.ok(!cat.listFiles().some((f) => f.path === p2), "deletion visible next tick");
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));
  });

  it("renames land within one tick", async () => {
    const roots = mkRoots();
    const p1 = mkFile("pa", "s1.jsonl", 100, at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    const p2 = p1.replace("s1.jsonl", "s1b.jsonl");
    renameSync(p1, p2);
    touch(join(base, "claude", "projects", "pa"), at(1_000));
    touch(p2, at(-1 * H));
    await cat.sweep(roots, at(1_500));
    const set = catalogSet(cat);
    assert.ok(!cat.listFiles().some((f) => f.path === p1));
    assert.ok(set.has(`${p2}|100|${at(-1 * H)}`));
  });

  it("appends surface at the tier cadence: invisible mid-interval, visible after (M1)", async () => {
    const roots = mkRoots();
    const p = mkFile("pa", "warm.jsonl", 100, at(-3 * H)); // warm: >5min, <48h
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    appendFileSync(p, "more!");
    touch(p, at(1_000));
    touch(join(base, "claude", "projects", "pa"), at(-3 * H)); // appends don't bump dir mtimes

    await cat.sweep(roots, at(1_500)); // inside the 5s warm interval
    assert.ok(catalogSet(cat).has(`${p}|100|${at(-3 * H)}`), "append invisible mid-interval");

    await cat.sweep(roots, at(5_600)); // warm cadence elapsed
    assert.ok(catalogSet(cat).has(`${p}|105|${at(1_000)}`), "append visible after ≤5s");

    // Promoted hot by movement: the very next tick sees the following append.
    appendFileSync(p, "!!");
    touch(p, at(6_000));
    await cat.sweep(roots, at(7_100));
    assert.ok(catalogSet(cat).has(`${p}|107|${at(6_000)}`), "hot after movement");
  });

  it("a live tracker (alive pid) pins an idle session hot", async () => {
    const roots = mkRoots();
    const p = mkFile("pa", "idle-live.jsonl", 100, at(-6 * H)); // warm by mtime
    mkTracker(process.pid, "idle-live", at(-1 * DAY)); // alive pid, startedAt fresh enough
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    appendFileSync(p, "abc");
    touch(p, at(500));
    touch(join(base, "claude", "projects", "pa"), at(-6 * H));
    await cat.sweep(roots, at(1_500)); // hot: statted every tick despite warm mtime
    assert.ok(catalogSet(cat).has(`${p}|103|${at(500)}`), "live session sees appends next tick");
  });

  it("a dead pid or an over-age startedAt does not promote", async () => {
    const roots = mkRoots();
    const p = mkFile("pa", "idle-dead.jsonl", 100, at(-6 * H));
    const dead = Bun.spawnSync({ cmd: ["true"] });
    mkTracker(dead.pid ?? 99_999_99, "idle-dead", at(-1 * DAY)); // pid exited
    mkTracker(process.pid, "idle-dead-2", at(-8 * DAY)); // alive but startedAt over-age
    mkFile("pa", "idle-dead-2.jsonl", 100, at(-6 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    for (const f of ["idle-dead", "idle-dead-2"]) {
      const fp = join(base, "claude", "projects", "pa", `${f}.jsonl`);
      appendFileSync(fp, "x");
      touch(fp, at(500));
    }
    touch(join(base, "claude", "projects", "pa"), at(-6 * H));
    await cat.sweep(roots, at(1_500)); // warm cadence not yet due
    assert.ok(catalogSet(cat).has(`${p}|100|${at(-6 * H)}`), "no hot promotion from a dead pid");
  });

  it("file window-edge append SURVIVES via the age-out re-stat", async () => {
    const roots = mkRoots();
    // Cold, cached mtime just inside the window; its dir stays recent.
    const p = mkFile("pa", "edge.jsonl", 100, at(-30 * DAY + 2 * H), at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    // Appended fresh — but the catalog's CACHED mtime crosses the 30d line
    // before the cold cadence would have re-statted it.
    appendFileSync(p, "fresh");
    touch(p, at(0));
    await cat.sweep(roots, at(3 * H)); // cached age now > 30d ⇒ age-out due ⇒ re-stat first
    assert.ok(
      catalogSet(cat).has(`${p}|105|${at(0)}`),
      "age-out re-statted and KEPT the freshly-appended file",
    );
  });

  it("dir-edge: a recent file inside a >30d-stale dir DROPS (the D-A hole, replicated)", async () => {
    const roots = mkRoots();
    // Fresh file, but its project dir's mtime is pinned 31 days old.
    mkFile("pstale", "fresh-in-stale.jsonl", 100, at(-1 * H), at(-31 * DAY));
    mkFile("pa", "normal.jsonl", 100, at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    const truth = await groundTruth(roots);
    assert.deepEqual(catalogSet(cat), truth, "catalog replicates the dir-level prune exactly");
    assert.ok(
      !cat.listFiles().some((f) => f.path.includes("fresh-in-stale")),
      "a member's recent mtime must NOT rescue it from a dir-level drop",
    );
  });

  it("a roots change resets and resweeps within the same tick", async () => {
    const roots = mkRoots();
    mkFile("pa", "s1.jsonl", 100, at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    const extra = join(base, "claude2");
    mkdirSync(join(extra, "projects", "px"), { recursive: true });
    const p2 = join(extra, "projects", "px", "other.jsonl");
    writeFileSync(p2, "k".repeat(60));
    touch(p2, at(-2 * H));
    touch(join(extra, "projects", "px"), at(-2 * H));
    const roots2: ResolvedRoots = {
      claude: [...roots.claude, { configDir: extra, origin: "settings", exists: true }],
      codex: roots.codex,
    };
    await cat.sweep(roots2, at(1_500));
    assert.ok(catalogSet(cat).has(`${p2}|60|${at(-2 * H)}`), "new root swept within one tick");
  });

  it("a file created EMPTY is admitted once it grows — the excluded lane", async () => {
    const roots = mkRoots();
    mkFile("pa", "other.jsonl", 100, at(-1 * H)); // keeps the dir in-window
    const p = mkFile("pa", "born-empty.jsonl", 0, at(0));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.ok(!cat.listFiles().some((f) => f.path === p), "size-0 not admitted (discovery parity)");

    appendFileSync(p, "grown now!");
    touch(p, at(1_000));
    touch(join(base, "claude", "projects", "pa"), at(0)); // appends bump no dir mtime
    await cat.sweep(roots, at(61_500)); // ≤ cold cadence later
    assert.ok(
      catalogSet(cat).has(`${p}|10|${at(1_000)}`),
      "excluded lane re-admitted the grown file without any dir churn",
    );
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));
  });

  it("truncate-to-zero then regrow re-admits within the cold cadence", async () => {
    const roots = mkRoots();
    const p = mkFile("pa", "trunc.jsonl", 100, at(0)); // hot
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.ok(cat.listFiles().some((f) => f.path === p));

    writeFileSync(p, ""); // truncated
    touch(p, at(1_000));
    touch(join(base, "claude", "projects", "pa"), at(0));
    await cat.sweep(roots, at(1_500)); // hot stat sees size 0 → excluded lane
    assert.ok(!cat.listFiles().some((f) => f.path === p), "empty file leaves the inventory");

    writeFileSync(p, "back!");
    touch(p, at(2_000));
    touch(join(base, "claude", "projects", "pa"), at(0));
    await cat.sweep(roots, at(63_000));
    assert.ok(catalogSet(cat).has(`${p}|5|${at(2_000)}`), "regrowth re-admitted");
  });

  it("a genuinely aged-out file re-admits after a fresh append with the dir mtime unmoved", async () => {
    const roots = mkRoots();
    mkFile("pa", "fresh.jsonl", 50, at(-1 * H)); // keeps the dir recent
    const p = mkFile("pa", "ancient.jsonl", 100, at(-31 * DAY), at(-1 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.ok(!cat.listFiles().some((f) => f.path === p), "beyond-window file not admitted");

    appendFileSync(p, "resumed");
    touch(p, at(0)); // fresh append — but the dir mtime never moves
    touch(join(base, "claude", "projects", "pa"), at(-1 * H));
    await cat.sweep(roots, at(61_500));
    assert.ok(
      cat.listFiles().some((f) => f.path === p && f.size === 107),
      "resume-append re-admitted via the excluded lane",
    );
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));
  });

  it("a LIVE session caught by the size-0 admission race admits at tick cadence, not cold", async () => {
    const roots = mkRoots();
    mkFile("pa", "other.jsonl", 100, at(-1 * H)); // keeps the dir in-window
    const p = mkFile("pa", "live-born-empty.jsonl", 0, at(0));
    mkTracker(process.pid, "live-born-empty", at(-60_000)); // session just started, pid alive
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.ok(!cat.listFiles().some((f) => f.path === p), "size-0 not yet admitted");

    appendFileSync(p, "first write");
    touch(p, at(1_000));
    touch(join(base, "claude", "projects", "pa"), at(0));
    await cat.sweep(roots, at(1_500)); // ONE tick later — live overrides the cold cadence
    assert.ok(
      catalogSet(cat).has(`${p}|11|${at(1_000)}`),
      "live session's excluded entry re-statted every tick (M1: live ⇒ hot)",
    );
  });

  it("split-dir sessions keep their child-movement promotion despite a quiet twin dir", async () => {
    const roots = mkRoots();
    const sid = "split-sess";
    const p = mkFile("pa", `${sid}.jsonl`, 100, at(-3 * H)); // warm parent
    mkChild("pa", sid, "active", 40, at(0));
    mkChild("pc", sid, "idle", 40, at(-2 * H)); // twin artifact dir, quiet
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));

    // Movement in the ACTIVE dir promotes; the quiet twin's walk (same tick,
    // later in iteration order) must not erase it — the parent's next append
    // must be seen at TICK cadence, not the 5s warm cadence.
    const cp = join(base, "claude", "projects", "pa", sid, "subagents", "agent-active.jsonl");
    appendFileSync(cp, "x");
    touch(cp, at(1_000));
    await cat.sweep(roots, at(1_500)); // observes child movement in pa; pc quiet

    appendFileSync(p, "parent-line");
    touch(p, at(2_000));
    touch(join(base, "claude", "projects", "pa"), at(-3 * H));
    await cat.sweep(roots, at(3_000)); // one tick — promotion must hold
    assert.ok(
      catalogSet(cat).has(`${p}|111|${at(2_000)}`),
      "childHot promotion survived the quiet twin dir's walk",
    );
  });

  it("codex deletions land within one tick (file and whole date dir)", async () => {
    const roots = mkRoots();
    const p1 = mkCodex("15", "rollout-2026-08-15T10-00-00-aaaa.jsonl", 50, at(-2 * H));
    const p2 = mkCodex("16", "rollout-2026-08-16T10-00-00-bbbb.jsonl", 60, at(-2 * H));
    const cat = new DiscoveryCatalog();
    await cat.sweep(roots, at(0));
    assert.ok(cat.listFiles().some((f) => f.path === p1));

    rmSync(p1);
    await cat.sweep(roots, at(1_500));
    assert.ok(!cat.listFiles().some((f) => f.path === p1), "deleted rollout gone next tick");

    rmSync(join(base, "codex", "sessions", "2026", "08", "16"), { recursive: true });
    await cat.sweep(roots, at(3_000));
    assert.ok(!cat.listFiles().some((f) => f.path === p2), "wholesale date-dir removal gone next tick");
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));
  });

  it("randomized op sequences settle to exact discovery equivalence", async () => {
    const roots = mkRoots();
    let seed = 0x5eed;
    const rnd = (): number => {
      // xorshift32 — deterministic, no Math.random (reproducible failures).
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const cat = new DiscoveryCatalog();
    const live: string[] = [];
    const codexLive: string[] = [];
    let clock = 0;
    for (let i = 0; i < 60; i++) {
      const op = rnd();
      const proj = `p${Math.floor(rnd() * 4)}`;
      if (op < 0.35 || live.length === 0) {
        const name = `s${i}.jsonl`;
        const ageH = rnd() * 100; // spans hot/warm/cold
        live.push(mkFile(proj, name, 50 + Math.floor(rnd() * 500), at(-ageH * H)));
      } else if (op < 0.55) {
        const p = live[Math.floor(rnd() * live.length)]!;
        appendFileSync(p, ".".repeat(1 + Math.floor(rnd() * 40)));
        touch(p, at(clock));
      } else if (op < 0.7) {
        const idx = Math.floor(rnd() * live.length);
        const p = live.splice(idx, 1)[0]!;
        rmSync(p, { force: true });
        touch(join(p, ".."), at(clock));
      } else if (op < 0.85) {
        const sid = `s${i}`;
        mkChild(proj, sid, `a${i}`, 30, at(clock - 10 * MIN));
      } else if (op < 0.93 || codexLive.length === 0) {
        codexLive.push(
          mkCodex(String(10 + (i % 18)).padStart(2, "0"), `rollout-2026-08-${String(10 + (i % 18)).padStart(2, "0")}T00-00-00-${i}aaa.jsonl`, 40, at(-rnd() * 20 * DAY)),
        );
      } else {
        const idx = Math.floor(rnd() * codexLive.length);
        rmSync(codexLive.splice(idx, 1)[0]!, { force: true });
      }
      clock += 1_500;
      await cat.sweep(roots, at(clock));
    }
    // Settle: advance past every tier interval so all stats are fresh.
    clock += 61_000;
    await cat.sweep(roots, at(clock));
    assert.deepEqual(catalogSet(cat), await groundTruth(roots));

    const truthChildren = await discoverClaudeChildren(roots.claude);
    assert.deepEqual(
      cat.listChildren().children.map((c) => `${c.path}|${c.size}`).sort(),
      truthChildren.children.map((c) => `${c.path}|${c.size}`).sort(),
    );
  });
});
