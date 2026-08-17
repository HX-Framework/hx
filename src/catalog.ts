// Tiered discovery catalog (LETAIR-144 WS1).
//
// The watch loop's discovery used to re-walk the entire windowed tree — every
// project dir readdir'd, every candidate file statted, twice (parents +
// children) — every 1.5 s tick, forever. That cost scales with history size,
// not activity, and measured as ~80 % system time on an idle daemon.
//
// The catalog keeps the COMPLETE windowed inventory in memory and lets a tier
// scheduler decide which entries get re-STATTED each tick:
//
//   hot   — own mtime moved ≤5 min ago, or the session is LIVE (tracker with
//           an alive pid) → statted every tick (≤1.5 s latency, as today);
//   warm  — mtime ≤48 h → every ~5 s;
//   cold  — rest of the 30-day window → every ~60 s, stagger-hashed so the
//           stats spread across ticks instead of spiking together.
//
// Creations / deletions / renames bump the parent DIRECTORY's mtime, so a
// per-tick dir pass (1 readdir of <root>/projects + 1 stat per known dir)
// catches them within one tick — only a dir whose mtime moved is re-readdir'd
// and diffed. Appends do NOT bump dir mtimes; they are caught by the tier
// stats, which is exactly the declared M1 latency bound.
//
// Age-out has two distinct triggers with different rules (D-A):
//   • file-mtime age-out re-stats FIRST — never acts on cached stats (a file
//     appended inside its stat gap right at the window edge must survive);
//   • dir-mtime age-out acts on THIS tick's fresh dir stat and drops all
//     member entries regardless of member-file mtimes — exactly today's
//     dir-level prune (sources.ts), the pre-existing hole replicated
//     deliberately (a member's recent mtime must NOT rescue it).
//
// The catalog's list() output is a drop-in for the discover* results: every
// downstream consumer (election, filters, backfill merge, snapshotFrom, the
// ingest loop) sees the same shape it always did, and the inventory is never
// forgotten between stats — totals cannot shrink or flicker.
//
// One instance per StateScope (the --local tee runs a second watch loop).
// computeSyncSnapshot / computeSyncReport / the canonical audit / the hourly
// backfill / hx tick keep their own fresh discovery — the catalog serves ONLY
// the long-running loop's cadence.

import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  RECENT_WINDOW_MS,
  STAT_CONCURRENCY,
  mapPool,
  readdirSafe,
  scanSessionArtifacts,
  statSafe,
  type DiscoveredChildFile,
  type DiscoveredFile,
  type DiscoveredWorkflowRun,
} from "./sources.js";
import {
  claudeProjectsDir,
  codexArchivedDir,
  codexSessionsDir,
  rootsSignature,
  type ResolvedRoots,
} from "./roots.js";
import type { StateScope } from "./state.js";

// Tier thresholds + cadences. Hot promotion also comes from liveness and from
// observed child movement (a parent idling through a long subagent run).
const HOT_AGE_MS = 5 * 60_000;
const WARM_AGE_MS = 48 * 60 * 60_000;
const WARM_STAT_INTERVAL_MS = 5_000;
const COLD_STAT_INTERVAL_MS = 60_000;
// Live-session trackers: <claudeRoot>/sessions/<pid>.json. A tracker counts
// only while its startedAt is ≤ this old (recycled-pid guard) — unless the
// transcript itself is warm, in which case the mtime tier already covers it.
const TRACKER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const TRACKER_PARSE_CACHE = 512;

interface FileEntry {
  file: DiscoveredFile;
  /** Last re-stat time — back-dated by a per-path stagger at insert so cold
   *  stats spread across ticks instead of spiking together. */
  lastStatMs: number;
}

/** A Claude path seen on disk but not currently admissible (size 0, or its
 *  own mtime beyond the window). The base swept every candidate every tick,
 *  so these self-healed within 1.5 s; the catalog must not FORGET them —
 *  appends never bump the dir mtime, so a forgotten path would stay
 *  invisible until unrelated dir churn or a restart. Re-statted at the cold
 *  cadence: size-0 files that grow and aged-out files that get re-appended
 *  re-admit within ≤60 s (M1's cold bound). Dir-level age-out drops are NOT
 *  routed here — D-A replicates the dir prune exactly, and dir re-admission
 *  happens through the dir's own mtime, as today. Codex needs no such lane:
 *  its walk re-stats every not-yet-admitted rollout file every tick. */
interface ExcludedEntry {
  rootDir: string;
  lastStatMs: number;
}

interface ChildEntry {
  child: DiscoveredChildFile;
  lastSeenMs: number;
}

interface SessionDirEntry {
  sessionDir: string;
  sessionId: string;
  rootDir: string;
  lastWalkMs: number;
}

interface TrackerRecord {
  mtimeMs: number;
  pid: number | null;
  sessionId: string | null;
  startedAt: number | null;
}

/** Deterministic per-path stagger in [0, interval) — no Math.random, so the
 *  property tests stay reproducible. */
function staggerFor(p: string, interval: number): number {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
  return Math.abs(h) % interval;
}

/** Alive-pid probe: ESRCH ⇒ dead; EPERM or any other error ⇒ treat alive
 *  (fail-hot, cost-only — a live pid owned by another user, or a platform
 *  quirk, must never demote a genuinely live session). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}

export class DiscoveryCatalog {
  private rootsSig = "";
  private parents = new Map<string, FileEntry>();
  private excluded = new Map<string, ExcludedEntry>();
  private children = new Map<string, ChildEntry>();
  /** Per-session-dir UNMERGED workflow runs; listChildren() merges on demand
   *  with the same fill-missing rules the full walk applies, so a run split
   *  across project dirs (or roots) still folds into one entry even when the
   *  two halves were walked on different ticks. */
  private runsByDir = new Map<string, DiscoveredWorkflowRun[]>();
  /** Claude project dirs + codex date dirs we know, with their last dir mtime. */
  private dirs = new Map<string, { mtimeMs: number }>();
  private sessionDirs = new Map<string, SessionDirEntry>();
  private trackerCache = new Map<string, TrackerRecord>();
  private liveSessionIds = new Set<string>();

  /** Sessions promoted hot by observed child movement, until their walked
   *  subtree goes quiet again. */
  private childHotSessions = new Set<string>();

  reset(): void {
    this.rootsSig = "";
    this.parents.clear();
    this.excluded.clear();
    this.children.clear();
    this.runsByDir.clear();
    this.dirs.clear();
    this.sessionDirs.clear();
    this.liveSessionIds.clear();
    this.childHotSessions.clear();
  }

  /** The complete windowed parent inventory — a drop-in for
   *  [...discoverClaudeFiles(), ...discoverCodexFiles()]. */
  listFiles(): DiscoveredFile[] {
    return [...this.parents.values()].map((e) => e.file);
  }

  /** The child-lane inventory — a drop-in for discoverClaudeChildren(). */
  listChildren(): { children: DiscoveredChildFile[]; runs: DiscoveredWorkflowRun[] } {
    const runs: DiscoveredWorkflowRun[] = [];
    for (const dirRuns of this.runsByDir.values()) {
      for (const r of dirRuns) {
        const existing = runs.find(
          (m) => m.parentSessionId === r.parentSessionId && m.runId === r.runId,
        );
        if (!existing) {
          runs.push({ ...r });
          continue;
        }
        // Same fill-missing merge the full walk applies across dirs/roots.
        if (r.journalPath && !existing.journalPath) existing.journalPath = r.journalPath;
        if (r.scriptPath) {
          existing.scriptPath = r.scriptPath;
          existing.scriptName = r.scriptName;
        }
        existing.mtimeMs = Math.max(existing.mtimeMs, r.mtimeMs);
      }
    }
    return {
      children: [...this.children.values()].map((e) => e.child),
      runs,
    };
  }

  async sweep(roots: ResolvedRoots, nowMs: number): Promise<void> {
    const sig = rootsSignature(roots);
    if (sig !== this.rootsSig) {
      // Roots changed (settings edit, env) — full resweep within this tick,
      // preserving "Watched Locations apply within one poll".
      this.reset();
      this.rootsSig = sig;
    }
    await this.trackerPass(roots, nowMs);
    await this.claudeDirPass(roots, nowMs);
    await this.codexDirPass(roots, nowMs);
    await this.fileStatPass(nowMs);
    await this.excludedStatPass(nowMs);
    await this.childPass(nowMs);
  }

  // ── Liveness ──────────────────────────────────────────────────────────────

  private isLive(sessionId: string): boolean {
    return this.liveSessionIds.has(sessionId);
  }

  private async trackerPass(roots: ResolvedRoots, nowMs: number): Promise<void> {
    this.liveSessionIds.clear();
    for (const root of roots.claude) {
      const dir = path.join(root.configDir, "sessions");
      for (const f of await readdirSafe(dir)) {
        if (!f.endsWith(".json")) continue; // skips *.key siblings too
        const p = path.join(dir, f);
        const st = await statSafe(p);
        if (!st || st.isDir) continue;
        let rec = this.trackerCache.get(p);
        if (!rec || rec.mtimeMs !== st.mtimeMs) {
          rec = { mtimeMs: st.mtimeMs, pid: null, sessionId: null, startedAt: null };
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path under a watched config root
            const parsed = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
            rec.pid = typeof parsed["pid"] === "number" ? parsed["pid"] : null;
            rec.sessionId = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : null;
            rec.startedAt = typeof parsed["startedAt"] === "number" ? parsed["startedAt"] : null;
          } catch {
            // torn/garbage tracker — carries no session, promotes nothing
          }
          if (this.trackerCache.size >= TRACKER_PARSE_CACHE) {
            // Evict the oldest half (Map preserves insertion order) instead of
            // clearing wholesale — a machine with >512 stale tracker files
            // would otherwise re-parse every tracker every tick.
            let toDrop = Math.floor(this.trackerCache.size / 2);
            for (const key of this.trackerCache.keys()) {
              if (toDrop-- <= 0) break;
              this.trackerCache.delete(key);
            }
          }
          this.trackerCache.set(p, rec);
        }
        if (!rec.sessionId || rec.pid === null) continue;
        // startedAt guard: a tracker older than the max age is ignored unless
        // the session's transcript is warm anyway (recycled-pid bound). A
        // MISSING/unparseable startedAt ⇒ treat live (fail-hot, cost-only).
        if (rec.startedAt !== null && nowMs - rec.startedAt > TRACKER_MAX_AGE_MS) continue;
        if (pidAlive(rec.pid)) this.liveSessionIds.add(rec.sessionId);
      }
    }
  }

  // ── Dir passes (creations / deletions / renames land here, ≤1 tick) ──────

  private async claudeDirPass(roots: ResolvedRoots, nowMs: number): Promise<void> {
    for (const root of roots.claude) {
      const projects = claudeProjectsDir(root.configDir);
      const seen = new Set<string>();
      for (const name of await readdirSafe(projects)) {
        if (name.startsWith(".") || name === "memory") continue;
        const dirPath = path.join(projects, name);
        seen.add(dirPath);
        const st = await statSafe(dirPath);
        if (!st?.isDir) continue;
        const known = this.dirs.get(dirPath);
        if (nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
          // Dir-mtime age-out (D-A): acts on THIS tick's fresh dir stat and
          // drops every member regardless of member-file mtimes — exactly
          // today's dir-level prune. The dir stays statted each tick, so a
          // future mtime move re-admits it, as today.
          if (known) this.dropDirMembers(dirPath);
          this.dirs.set(dirPath, { mtimeMs: st.mtimeMs });
          continue;
        }
        if (!known || known.mtimeMs !== st.mtimeMs) {
          this.dirs.set(dirPath, { mtimeMs: st.mtimeMs });
          await this.readdirClaudeDir(dirPath, root.configDir, nowMs);
        }
      }
      // A project dir deleted outright: its entries (and session dirs) vanish.
      for (const dirPath of [...this.dirs.keys()]) {
        if (dirPath.startsWith(projects + path.sep) && !seen.has(dirPath)) {
          this.dropDirMembers(dirPath);
          this.dirs.delete(dirPath);
        }
      }
    }
  }

  private dropDirMembers(dirPath: string): void {
    const prefix = dirPath + path.sep;
    for (const p of [...this.parents.keys()]) {
      if (p.startsWith(prefix)) this.parents.delete(p);
    }
    for (const p of [...this.excluded.keys()]) {
      if (p.startsWith(prefix)) this.excluded.delete(p);
    }
    for (const p of [...this.children.keys()]) {
      if (p.startsWith(prefix)) this.children.delete(p);
    }
    for (const p of [...this.runsByDir.keys()]) {
      if (p === dirPath || p.startsWith(prefix)) this.runsByDir.delete(p);
    }
    for (const [p, sd] of [...this.sessionDirs.entries()]) {
      if (p === dirPath || p.startsWith(prefix)) {
        this.sessionDirs.delete(p);
        // A vanished session dir must also release its hot promotion, or the
        // still-present parent would be statted every tick forever.
        this.childHotSessions.delete(sd.sessionId);
      }
    }
  }

  private async readdirClaudeDir(dirPath: string, rootDir: string, nowMs: number): Promise<void> {
    const names = await readdirSafe(dirPath);
    const present = new Set<string>();
    for (const name of names) {
      const p = path.join(dirPath, name);
      present.add(p);
      if (name.endsWith(".jsonl")) {
        if (!this.parents.has(p) && !this.excluded.has(p)) {
          const st = await statSafe(p);
          if (!st || st.isDir) continue;
          if (st.size > 0 && nowMs - st.mtimeMs <= RECENT_WINDOW_MS) {
            this.insertParent(p, st.size, st.mtimeMs, "claude", rootDir, nowMs);
          } else {
            // Exists but not admissible (size 0 — freshly created, unwritten;
            // or its own mtime beyond the window). Track it in the excluded
            // lane: appends bump no dir mtime, so forgetting it here would
            // make later growth invisible until unrelated dir churn.
            this.excluded.set(p, {
              rootDir,
              lastStatMs: nowMs - staggerFor(p, COLD_STAT_INTERVAL_MS),
            });
          }
        }
        continue;
      }
      if (name.startsWith(".")) continue;
      if (!this.sessionDirs.has(p)) {
        const st = await statSafe(p);
        if (st?.isDir) {
          this.sessionDirs.set(p, { sessionDir: p, sessionId: name, rootDir, lastWalkMs: 0 });
        }
      }
    }
    // Deletions/renames inside this dir: entries no longer present drop now —
    // the same ≤1-tick removal latency fresh discovery gave the snapshot.
    for (const p of [...this.parents.keys()]) {
      if (path.dirname(p) === dirPath && !present.has(p)) this.parents.delete(p);
    }
    for (const p of [...this.excluded.keys()]) {
      if (path.dirname(p) === dirPath && !present.has(p)) this.excluded.delete(p);
    }
    for (const [p, sd] of [...this.sessionDirs.entries()]) {
      if (path.dirname(p) === dirPath && !present.has(p)) {
        this.sessionDirs.delete(p);
        this.childHotSessions.delete(sd.sessionId);
        this.dropDirMembers(p);
      }
    }
  }

  private async codexDirPass(roots: ResolvedRoots, nowMs: number): Promise<void> {
    for (const root of roots.codex) {
      for (const base of [codexSessionsDir(root.configDir), codexArchivedDir(root.configDir)]) {
        await this.codexWalk(base, root.configDir, nowMs);
      }
    }
  }

  /** Mirror of discoverCodexFiles' pruned recursion, with per-file stats
   *  replaced by catalog admission (new files) — known files ride tiers.
   *  Deletions surface ≤1 tick, matching the base and the Claude lane: each
   *  walked dir presence-diffs its direct member files, and known SUBDIRS
   *  that vanished from the listing drop with their members. */
  private async codexWalk(dir: string, rootDir: string, nowMs: number): Promise<void> {
    const entries = await readdirSafe(dir);
    const subdirs: string[] = [];
    const presentFiles = new Set<string>();
    const presentDirs = new Set<string>();
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        presentFiles.add(full);
        if (!this.parents.has(full)) {
          const st = await statSafe(full);
          if (st && !st.isDir && st.size > 0 && nowMs - st.mtimeMs <= RECENT_WINDOW_MS) {
            this.insertParent(full, st.size, st.mtimeMs, "codex", rootDir, nowMs);
          }
        }
      } else {
        presentDirs.add(full);
        subdirs.push(full);
      }
    }
    // Direct member files deleted since the last walk drop now (≤1 tick).
    for (const p of [...this.parents.keys()]) {
      if (path.dirname(p) === dir && !presentFiles.has(p)) this.parents.delete(p);
    }
    // Known subdirs no longer listed (a date dir deleted outright) drop with
    // their members — the staleness branch below only covers AGED dirs.
    for (const d of [...this.dirs.keys()]) {
      if (path.dirname(d) === dir && !presentDirs.has(d)) {
        this.dropDirMembers(d);
        this.dirs.delete(d);
      }
    }
    await mapPool(subdirs, STAT_CONCURRENCY, async (d) => {
      const st = await statSafe(d);
      if (!st?.isDir) return;
      if (nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
        // Date-dir prune — the codex analog of the D-A dir age-out.
        const known = this.dirs.get(d);
        if (known) {
          this.dropDirMembers(d);
          this.dirs.delete(d);
        }
        return;
      }
      this.dirs.set(d, { mtimeMs: st.mtimeMs });
      await this.codexWalk(d, rootDir, nowMs);
    });
  }

  private insertParent(
    p: string,
    size: number,
    mtimeMs: number,
    source: "claude" | "codex",
    rootDir: string,
    nowMs: number,
  ): void {
    // The stagger back-dates lastStatMs ONCE, phase-shifting this entry's
    // re-stat schedule so cold stats spread across ticks — the interval
    // itself stays full-length for every entry (adding the stagger to the
    // ELAPSED time at check-time would instead shorten some entries'
    // effective interval toward zero).
    this.parents.set(p, {
      file: { path: p, size, mtimeMs, source, rootDir },
      lastStatMs: nowMs - staggerFor(p, COLD_STAT_INTERVAL_MS),
    });
  }

  // ── File stat pass (tiers) ────────────────────────────────────────────────

  private tierInterval(e: FileEntry, sessionId: string, nowMs: number): number {
    const age = nowMs - e.file.mtimeMs;
    if (age <= HOT_AGE_MS || this.isLive(sessionId) || this.childHotSessions.has(sessionId)) return 0;
    if (age <= WARM_AGE_MS) return WARM_STAT_INTERVAL_MS;
    return COLD_STAT_INTERVAL_MS;
  }

  private async fileStatPass(nowMs: number): Promise<void> {
    const due: FileEntry[] = [];
    for (const e of this.parents.values()) {
      // Claude session id ≙ the jsonl basename; codex uses the rollout stem.
      // Liveness promotion only needs the claude shape (codex has no tracker).
      const sessionId =
        e.file.source === "claude" ? path.basename(e.file.path, ".jsonl") : "";
      const interval = this.tierInterval(e, sessionId, nowMs);
      if (interval === 0 || nowMs - e.lastStatMs >= interval) due.push(e);
    }
    await mapPool(due, STAT_CONCURRENCY, async (e) => {
      const st = await statSafe(e.file.path);
      e.lastStatMs = nowMs;
      if (!st || st.isDir) {
        // Vanished — a recreation bumps the dir mtime and re-admits ≤1 tick.
        this.parents.delete(e.file.path);
        return;
      }
      if (st.size === 0) {
        // Truncated to empty (excluded by discovery today too) — keep it in
        // the excluded lane so regrowth re-admits within the cold cadence.
        this.parents.delete(e.file.path);
        this.excluded.set(e.file.path, { rootDir: e.file.rootDir, lastStatMs: nowMs });
        return;
      }
      if (nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
        // File-mtime age-out: this IS the fresh stat — only it may drop. The
        // excluded lane keeps watching, so a later resume-append re-admits
        // within the cold cadence even when the dir mtime never moves.
        this.parents.delete(e.file.path);
        this.excluded.set(e.file.path, { rootDir: e.file.rootDir, lastStatMs: nowMs });
        return;
      }
      e.file = { ...e.file, size: st.size, mtimeMs: st.mtimeMs };
    });
  }

  /** Cold-cadence recovery lane for tracked-but-not-admissible Claude paths
   *  (size 0 / own-mtime beyond the window). Promotion inserts as HOT. */
  private async excludedStatPass(nowMs: number): Promise<void> {
    const due: Array<[string, ExcludedEntry]> = [];
    for (const [p, e] of this.excluded) {
      if (nowMs - e.lastStatMs >= COLD_STAT_INTERVAL_MS) due.push([p, e]);
    }
    await mapPool(due, STAT_CONCURRENCY, async ([p, e]) => {
      const st = await statSafe(p);
      if (!st || st.isDir) {
        this.excluded.delete(p);
        return;
      }
      e.lastStatMs = nowMs;
      if (st.size > 0 && nowMs - st.mtimeMs <= RECENT_WINDOW_MS) {
        this.excluded.delete(p);
        this.insertParent(p, st.size, st.mtimeMs, "claude", e.rootDir, nowMs);
        // Fresh movement — make it hot immediately, not stagger-backdated.
        const entry = this.parents.get(p);
        if (entry) entry.lastStatMs = nowMs;
      }
    });
  }

  // ── Children (walk cadence by parent heat) ────────────────────────────────

  private async childPass(nowMs: number): Promise<void> {
    // One hot-parent index per pass — sessionId → newest claude-parent mtime.
    const parentMtime = new Map<string, number>();
    for (const e of this.parents.values()) {
      if (e.file.source !== "claude") continue;
      const sid = path.basename(e.file.path, ".jsonl");
      const prev = parentMtime.get(sid);
      if (prev === undefined || e.file.mtimeMs > prev) parentMtime.set(sid, e.file.mtimeMs);
    }
    const parentIsHot = (sid: string): boolean =>
      nowMs - (parentMtime.get(sid) ?? 0) <= HOT_AGE_MS;

    for (const sd of this.sessionDirs.values()) {
      const hot =
        this.isLive(sd.sessionId) ||
        parentIsHot(sd.sessionId) ||
        this.childHotSessions.has(sd.sessionId);
      const dueAt = hot ? 0 : WARM_STAT_INTERVAL_MS;
      if (nowMs - sd.lastWalkMs < dueAt) continue;
      sd.lastWalkMs = nowMs;
      // Fresh arrays per DIR: scanSessionArtifacts' in-array merge only ever
      // applies within one call here; the cross-dir merge happens centrally in
      // listChildren() over runsByDir, so halves walked on different ticks
      // still fold into one entry.
      const walkChildren: DiscoveredChildFile[] = [];
      const walkRuns: DiscoveredWorkflowRun[] = [];
      await scanSessionArtifacts(sd.sessionDir, sd.sessionId, sd.rootDir, nowMs, walkChildren, walkRuns);

      // Child movement promotes the parent to hot; a walked-and-quiet subtree
      // ends the promotion (the walk IS the freshness proof either way).
      // Movement covers agent jsonls AND run artifacts (journal.jsonl, meta,
      // scripts — their mtimes fold into the run entries).
      let movement = false;
      for (const c of walkChildren) {
        const prev = this.children.get(c.path);
        if (!prev || prev.child.mtimeMs !== c.mtimeMs || prev.child.size !== c.size) {
          movement = true;
          break;
        }
      }
      if (!movement) {
        const prevRuns = this.runsByDir.get(sd.sessionDir) ?? [];
        const runFp = (rs: DiscoveredWorkflowRun[]): string =>
          rs.map((r) => `${r.runId}:${r.mtimeMs}:${r.journalPath ?? ""}:${r.scriptPath ?? ""}`).sort().join("|");
        if (runFp(prevRuns) !== runFp(walkRuns)) movement = true;
      }
      if (movement) this.childHotSessions.add(sd.sessionId);
      else this.childHotSessions.delete(sd.sessionId);

      // The walk is authoritative for its own subtree: replace it wholesale.
      const prefix = sd.sessionDir + path.sep;
      const walked = new Set(walkChildren.map((c) => c.path));
      for (const p of [...this.children.keys()]) {
        if (p.startsWith(prefix) && !walked.has(p)) this.children.delete(p);
      }
      for (const c of walkChildren) this.children.set(c.path, { child: c, lastSeenMs: nowMs });
      if (walkRuns.length > 0) this.runsByDir.set(sd.sessionDir, walkRuns);
      else this.runsByDir.delete(sd.sessionDir);
    }
  }
}

const catalogs = new Map<StateScope, DiscoveryCatalog>();

export function catalogFor(scope: StateScope): DiscoveryCatalog {
  let c = catalogs.get(scope);
  if (!c) {
    c = new DiscoveryCatalog();
    catalogs.set(scope, c);
  }
  return c;
}

/** Test seam — fresh catalogs. */
export function resetCatalogsForTests(): void {
  catalogs.clear();
}
