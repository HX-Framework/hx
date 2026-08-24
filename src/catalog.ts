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
// That second rule is a CADENCE bound, and it is load-bearing: re-readdir'ing
// every dormant project dir on a 1.5s loop is the cost the tiering exists to
// avoid. What it must never be is a DURABILITY bound. A file this drops is
// still owed, and until the hourly sweep stopped mirroring the same 30-day
// window from the other side, nothing else could reach it — so it was owed
// forever while the status report went on billing it. The sweep now selects on
// owed-ness alone (backfill.ts) and hands what it finds to adopt() below, so
// the drop here costs one hour of latency rather than the file. Anything added
// to this file that narrows what a sweep can see needs the same counterpart.
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
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  RECENT_WINDOW_MS,
  STAT_CONCURRENCY,
  mapPool,
  readdirSafe,
  scanSessionArtifacts,
  sessionDirOfLane,
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
  /** Claude session id (jsonl basename), cached at insert — the tier scan
   *  and the child pass consult it EVERY tick for EVERY entry; a
   *  path.basename per entry per tick measured as real per-tick cost at a
   *  10k inventory. Empty string for codex (no tracker, no children). */
  sessionId: string;
}

/** A path (Claude or codex) seen on disk but not currently admissible
 *  (size 0, or its own mtime beyond the window). The base swept every
 *  candidate every tick, so these self-healed within 1.5 s; the catalog must
 *  not FORGET them — appends never bump the dir mtime, so a forgotten path
 *  would stay invisible until unrelated dir churn or a restart. Re-statted
 *  at the cold cadence (LIVE sessions every tick — the size-0 admission race
 *  is a session-start race and M1 promises live ⇒ tick cadence): size-0
 *  files that grow and aged-out files that get re-appended re-admit within
 *  ≤60 s (M1's cold bound). Dir-level age-out drops are NOT routed here —
 *  D-A replicates the dir prune exactly, and dir re-admission happens
 *  through the dir's own mtime, as today — or, for a dir whose mtime will
 *  never move again, through the hourly sweep and adopt(). An adopted entry
 *  can be dropped again by a later D-A transition; that is not a loss, the
 *  sweep re-adopts it within the hour while it is still owed. Codex rides the
 *  same lane: its readdir is mtime-gated, so a quiet dir's not-yet-admitted
 *  rollouts are never re-statted by the walk itself. */
interface ExcludedEntry {
  source: "claude" | "codex";
  rootDir: string;
  lastStatMs: number;
  /** Cached at insert (claude: basename; codex: "" — never live-promoted),
   *  so the per-tick liveness check costs a Set lookup, not a basename. */
  sessionId: string;
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

/** readdirSafe with dirents — classification without following symlinks. */
async function readdirTypedSafe(p: string): Promise<Dirent[]> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path under a watched config root
    return await readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
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
  /** Claude PROJECT dirs we know, with their last dir mtime (codex dirs live
   *  in codexListings, not here). `aged` marks a dir already past the window —
   *  the D-A member drop runs on the TRANSITION into aged, never per tick (an
   *  aged dir with nothing left to drop must not pay a full-map prefix scan
   *  forever). */
  private dirs = new Map<string, { mtimeMs: number; aged?: boolean }>();
  /** Per-codex-dir listing + the dir mtime it was taken at. Readdirs (and
   *  the local deletion diff) run ONLY when the dir's mtime moved — file
   *  creations and deletions both bump it, so ≤1-tick visibility holds while
   *  a quiet dir costs one stat per tick, exactly like the Claude dir pass.
   *  `aged` marks past-window date dirs (drop-on-transition, D-A analog). */
  private codexListings = new Map<
    string,
    { files: Set<string>; dirs: Set<string>; mtimeMs: number; aged?: boolean }
  >();
  private sessionDirs = new Map<string, SessionDirEntry>();
  private trackerCache = new Map<string, TrackerRecord>();
  private liveSessionIds = new Set<string>();

  /** Sessions promoted hot by observed child movement, until their walked
   *  subtree goes quiet again. Derived from per-DIR movement contributions —
   *  a session split across project dirs must not lose its promotion because
   *  a quiet twin dir walked after the active one. */
  private childHotSessions = new Set<string>();
  private childMovementDirs = new Map<string, Set<string>>();

  reset(): void {
    this.rootsSig = "";
    this.parents.clear();
    this.excluded.clear();
    this.children.clear();
    this.runsByDir.clear();
    this.dirs.clear();
    this.codexListings.clear();
    this.sessionDirs.clear();
    this.liveSessionIds.clear();
    this.childHotSessions.clear();
    this.childMovementDirs.clear();
  }

  /** The complete windowed parent inventory — a drop-in for
   *  [...discoverClaudeFiles(), ...discoverCodexFiles()]. */
  listFiles(): DiscoveredFile[] {
    return [...this.parents.values()].map((e) => e.file);
  }

  /**
   * Take ownership of paths the slow sweep reached and the walk did not.
   *
   * The walk prunes by project-DIRECTORY mtime, and appending to a transcript
   * never bumps its directory. A session resumed inside a long-dormant
   * worktree is therefore invisible to every tick — and stays invisible, since
   * an already-aged dir is never re-readdir'd and the catalog is rebuilt from
   * nothing on each restart. Without adoption the hourly sweep would rescue
   * such a file and then forget it again sixty seconds later, re-finding it
   * every hour for as long as the session stays warm, and making the progress
   * snapshot breathe by the blind-spot count once an hour as it appeared and
   * vanished from the pass.
   *
   * Adoption is only an entry point; it grants no exemptions. An adopted entry
   * re-stats, tiers, demotes to the excluded lane once its OWN mtime passes the
   * window, and drops when its file or its directory disappears, exactly like
   * one the walk inserted. Paths already tracked — including ones the file pass
   * deliberately demoted — are left alone rather than re-promoted.
   */
  adopt(files: readonly DiscoveredFile[], nowMs: number): number {
    let adopted = 0;
    for (const f of files) {
      // Only files the tiers can actually hold. A file past the window would
      // enter `parents` and be demoted to `excluded` by the next stat pass —
      // and the excluded lane has no eviction, so on a fresh install with
      // years of history every one of them would become a permanent 60s stat
      // obligation, long after it delivered. That is a scaled-down version of
      // the burn the tiering was built to remove. Old files are dormant by
      // definition: the hourly sweep was already the right cadence for them.
      if (nowMs - f.mtimeMs > RECENT_WINDOW_MS) continue;
      if (this.parents.has(f.path) || this.excluded.has(f.path)) continue;
      this.insertParent(f.path, f.size, f.mtimeMs, f.source, f.rootDir, nowMs);
      // Discovery just statted it; no need to phase-shift toward an early
      // re-stat the way a cold walk insert does.
      const entry = this.parents.get(f.path);
      if (entry) entry.lastStatMs = nowMs;
      adopted++;
    }
    return adopted;
  }

  /**
   * Register a rescued lane's session-artifact dir so childPass keeps walking
   * it. Not an optimisation — it is what keeps lane election stable.
   *
   * A lane visible only on sweep ticks makes electChildUploaders oscillate
   * whenever that lane has a second on-disk candidate (a cwd-change twin, a
   * copied tree): the sweep tick elects the rescued copy, the next tick elects
   * the always-visible one, and planChildLaneResets reads each flip as an
   * uploader takeover and clears the winner's offsets. A lane larger than one
   * pass's drain would restart from zero every hour and never finish.
   * Registering the dir keeps the rescued copy in `children` between sweeps,
   * so the takeover happens once and stays put.
   *
   * Takes the lane rather than a path so the window gate cannot be forgotten
   * by a caller. Only an IN-WINDOW lane is registered, for two reasons that
   * agree: childPass's lane scan is windowed, so a dormant lane's dir would be
   * walked every cadence without ever yielding the lane it was registered for
   * — while still dragging that dir's sidecars into the per-tick run hashing
   * described below, which is cost for nothing; and only an in-window lane can
   * oscillate at all, since it must be newer than an in-window twin to
   * displace it. Dormant lanes stay on the hourly sweep, where they are
   * single-candidate and safe.
   *
   * No eviction is added for these, and none is needed: removing a session dir
   * bumps its PROJECT dir's mtime to now, which un-ages that dir, so the next
   * sweep readdirs it and the existing presence-diff drops the entry. Deleting
   * the project dir instead goes through dropDirMembers, which prunes by
   * prefix. Both paths already covered it; a hand-rolled check here would have
   * been unreachable code.
   *
   * One consequence to know: because the walk's RUN scan is unwindowed (unlike
   * its lane scan), a registered dir's workflow sidecars rejoin the per-tick
   * syncWorkflowRun hashing, which reads each journal and script in full. The
   * window gate is what keeps that population small — it is the blind spot
   * itself, sessions appended recently inside dirs untouched for thirty days.
   */
  adoptSessionDir(lane: DiscoveredChildFile, nowMs: number): void {
    if (nowMs - lane.mtimeMs > RECENT_WINDOW_MS) return;
    const sessionDir = sessionDirOfLane(lane.path);
    if (sessionDir === null || this.sessionDirs.has(sessionDir)) return;
    // lastWalkMs 0 — due on the next childPass, like a freshly listed dir.
    this.sessionDirs.set(sessionDir, {
      sessionDir,
      sessionId: lane.parentSessionId,
      rootDir: lane.rootDir,
      lastWalkMs: 0,
    });
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
      const names = (await readdirSafe(dir)).filter((f) => f.endsWith(".json")); // skips *.key too
      // POOLED, like every other stat surface: a machine with hundreds of
      // stale tracker files (the population the parse-cache eviction was
      // sized for) would pay ~100 µs of sequential syscall latency per file
      // per tick otherwise. liveSessionIds.add is order-independent.
      await mapPool(names, STAT_CONCURRENCY, async (f) => {
        const p = path.join(dir, f);
        const st = await statSafe(p);
        if (!st || st.isDir) return;
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
        if (!rec.sessionId || rec.pid === null) return;
        // startedAt guard: a tracker older than the max age is ignored unless
        // the session's transcript is warm anyway (recycled-pid bound). A
        // MISSING/unparseable startedAt ⇒ treat live (fail-hot, cost-only).
        if (rec.startedAt !== null && nowMs - rec.startedAt > TRACKER_MAX_AGE_MS) return;
        if (pidAlive(rec.pid)) this.liveSessionIds.add(rec.sessionId);
      });
    }
  }

  // ── Dir passes (creations / deletions / renames land here, ≤1 tick) ──────

  private async claudeDirPass(roots: ResolvedRoots, nowMs: number): Promise<void> {
    for (const root of roots.claude) {
      const projects = claudeProjectsDir(root.configDir);
      const seen = new Set<string>();
      const candidates: string[] = [];
      for (const name of await readdirSafe(projects)) {
        if (name.startsWith(".") || name === "memory") continue;
        const dirPath = path.join(projects, name);
        seen.add(dirPath);
        candidates.push(dirPath);
      }
      // Dir stats POOLED: a sequential await per dir costs its full syscall
      // latency (~100 µs each on WSL — 32 ms/tick at 320 dirs, measured);
      // pooling hides it the same way the file-stat pass does. Mutations stay
      // OUT of the pool — results are applied sequentially below.
      const stats = new Map<string, { mtimeMs: number } | null>();
      await mapPool(candidates, STAT_CONCURRENCY, async (dirPath) => {
        const st = await statSafe(dirPath);
        stats.set(dirPath, st && st.isDir ? { mtimeMs: st.mtimeMs } : null);
      });
      for (const dirPath of candidates) {
        const st = stats.get(dirPath);
        if (!st) continue;
        const known = this.dirs.get(dirPath);
        if (nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
          // Dir-mtime age-out (D-A): acts on THIS tick's fresh dir stat and
          // drops every member regardless of member-file mtimes — exactly
          // today's dir-level prune. The drop runs ON THE TRANSITION into
          // aged only: an already-aged dir has nothing left to drop, and
          // re-scanning five maps for it every tick is a per-tick cost that
          // grows with history. The dir stays statted each tick, so a future
          // mtime move re-admits it, as today.
          if (known && !known.aged) this.dropDirMembers(dirPath);
          this.dirs.set(dirPath, { mtimeMs: st.mtimeMs, aged: true });
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
    // DIR bookkeeping goes too, so the drop is self-contained ("this dir and
    // everything under it is forgotten"). codexListings is where it earns its
    // keep: a deleted year/month dir would otherwise leak its day-dir
    // listings forever, since their parent is never walked again. this.dirs
    // holds only flat claude project dirs today, so its prefix arm is
    // defensive; the d === dirPath arm is what an aged/deleted claude dir
    // actually exercises.
    for (const d of [...this.dirs.keys()]) {
      if (d === dirPath || d.startsWith(prefix)) this.dirs.delete(d);
    }
    for (const d of [...this.codexListings.keys()]) {
      if (d === dirPath || d.startsWith(prefix)) this.codexListings.delete(d);
    }
    for (const [p, sd] of [...this.sessionDirs.entries()]) {
      if (p === dirPath || p.startsWith(prefix)) {
        this.sessionDirs.delete(p);
        this.releaseChildMovement(sd.sessionId, p);
      }
    }
  }

  /** Remove one dir's movement contribution; the session stays promoted only
   *  while SOME of its dirs still shows movement. */
  private releaseChildMovement(sessionId: string, sessionDir: string): void {
    const dirs = this.childMovementDirs.get(sessionId);
    if (dirs) {
      dirs.delete(sessionDir);
      if (dirs.size === 0) this.childMovementDirs.delete(sessionId);
    }
    if (!this.childMovementDirs.has(sessionId)) this.childHotSessions.delete(sessionId);
  }

  private async readdirClaudeDir(dirPath: string, rootDir: string, nowMs: number): Promise<void> {
    const names = await readdirSafe(dirPath);
    const present = new Set<string>();
    const newFiles: string[] = [];
    const newDirs: Array<{ p: string; name: string }> = [];
    for (const name of names) {
      const p = path.join(dirPath, name);
      present.add(p);
      if (name.endsWith(".jsonl")) {
        if (!this.parents.has(p) && !this.excluded.has(p)) newFiles.push(p);
        continue;
      }
      if (name.startsWith(".")) continue;
      if (!this.sessionDirs.has(p)) newDirs.push({ p, name });
    }
    // Admission stats POOLED (the first sweep of a big tree is thousands of
    // them — sequential awaits measured ~100 µs each on WSL).
    await mapPool(newFiles, STAT_CONCURRENCY, async (p) => {
      const st = await statSafe(p);
      if (!st || st.isDir) return;
      if (st.size > 0 && nowMs - st.mtimeMs <= RECENT_WINDOW_MS) {
        this.insertParent(p, st.size, st.mtimeMs, "claude", rootDir, nowMs);
      } else {
        // Exists but not admissible (size 0 — freshly created, unwritten;
        // or its own mtime beyond the window). Track it in the excluded
        // lane: appends bump no dir mtime, so forgetting it here would
        // make later growth invisible until unrelated dir churn.
        this.excluded.set(p, {
          source: "claude",
          rootDir,
          lastStatMs: nowMs - staggerFor(p, COLD_STAT_INTERVAL_MS),
          sessionId: path.basename(p, ".jsonl"),
        });
      }
    });
    await mapPool(newDirs, STAT_CONCURRENCY, async ({ p, name }) => {
      const st = await statSafe(p);
      if (st?.isDir) {
        this.sessionDirs.set(p, { sessionDir: p, sessionId: name, rootDir, lastWalkMs: 0 });
      }
    });
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
        // Through releaseChildMovement, NOT a direct childHotSessions.delete:
        // the direct delete both erased a surviving twin dir's legitimate
        // promotion AND stranded this dir's own movement contribution — a
        // stale entry no later walk could release, pinning split-dir
        // sessions hot forever.
        this.releaseChildMovement(sd.sessionId, p);
        this.dropDirMembers(p);
      }
    }
  }

  private async codexDirPass(roots: ResolvedRoots, nowMs: number): Promise<void> {
    for (const root of roots.codex) {
      for (const base of [codexSessionsDir(root.configDir), codexArchivedDir(root.configDir)]) {
        await this.codexWalk(base, root.configDir, nowMs, true);
      }
    }
  }

  /** Mirror of discoverCodexFiles' pruned recursion, with per-file stats
   *  replaced by catalog admission (new files) — known files ride tiers.
   *  Deletions surface ≤1 tick, matching the base and the Claude lane: each
   *  walked dir presence-diffs its direct member files, and known SUBDIRS
   *  that vanished from the listing drop with their members. */
  private async codexWalk(dir: string, rootDir: string, nowMs: number, isRoot: boolean): Promise<void> {
    const st = await statSafe(dir);
    if (!st?.isDir) {
      // The dir itself vanished (incl. a removed root): everything under it
      // goes, ≤1 tick — the base's fresh walk saw the same emptiness.
      if (this.codexListings.has(dir)) this.dropDirMembers(dir);
      return;
    }
    if (!isRoot && nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
      // Date-dir prune — the codex analog of the D-A dir age-out, drop on
      // the TRANSITION only (roots are never pruned, matching the base's
      // unconditional walk of sessions/ + archived_sessions/).
      const known = this.codexListings.get(dir);
      if (known && !known.aged) this.dropDirMembers(dir);
      this.codexListings.set(dir, {
        files: new Set(),
        dirs: new Set(),
        mtimeMs: st.mtimeMs,
        aged: true,
      });
      return;
    }
    let listing = this.codexListings.get(dir);
    if (!listing || listing.mtimeMs !== st.mtimeMs || listing.aged) {
      // The dir CHANGED (creations and deletions both bump its mtime — that
      // is what keeps deletion visibility ≤1 tick), or it re-entered the
      // window: readdir, admit new files, and diff deletions LOCALLY against
      // the previous listing (O(members-of-dir); a global-map scan here
      // measured ~100 ms/tick at 10k entries). A quiet dir costs exactly one
      // stat per tick — the same bill as a Claude project dir.
      // withFileTypes, like the base walk: a dirent classifies WITHOUT
      // following symlinks, so a symlinked dir or rollout file stays
      // invisible exactly as it always was (name-based classification here
      // would follow links via the later stat — new behavior, plus a
      // symlink-cycle hang on the recursion).
      const entries = await readdirTypedSafe(dir);
      const presentFiles = new Set<string>();
      const presentDirs = new Set<string>();
      for (const ent of entries) {
        const name = ent.name;
        const full = path.join(dir, name);
        if (ent.isFile() && name.startsWith("rollout-") && name.endsWith(".jsonl")) {
          presentFiles.add(full);
          if (!this.parents.has(full) && !this.excluded.has(full)) {
            const fst = await statSafe(full);
            if (!fst || fst.isDir) continue;
            if (fst.size > 0 && nowMs - fst.mtimeMs <= RECENT_WINDOW_MS) {
              this.insertParent(full, fst.size, fst.mtimeMs, "codex", rootDir, nowMs);
            } else {
              // Same H-1 recovery lane as Claude: appends bump no dir mtime,
              // so a size-0/aged rollout must stay tracked or later growth
              // would be invisible until unrelated dir churn.
              this.excluded.set(full, {
                source: "codex",
                rootDir,
                lastStatMs: nowMs - staggerFor(full, COLD_STAT_INTERVAL_MS),
                sessionId: "",
              });
            }
          }
        } else if (ent.isDirectory()) {
          presentDirs.add(full);
        }
        // Neither a plain file nor a plain dir (symlink, fifo, misnamed
        // file): ignored, as the base's dirent walk ignored it.
      }
      if (listing) {
        for (const p of listing.files) {
          if (!presentFiles.has(p)) {
            this.parents.delete(p);
            this.excluded.delete(p);
          }
        }
        for (const d of listing.dirs) {
          if (!presentDirs.has(d)) this.dropDirMembers(d); // prunes listings by prefix too
        }
      }
      listing = { files: presentFiles, dirs: presentDirs, mtimeMs: st.mtimeMs };
      this.codexListings.set(dir, listing);
    }
    // Recurse into the known subdirs — each performs its own stat + gate.
    await mapPool([...listing.dirs], STAT_CONCURRENCY, (d) =>
      this.codexWalk(d, rootDir, nowMs, false),
    );
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
      sessionId: source === "claude" ? path.basename(p, ".jsonl") : "",
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
      const interval = this.tierInterval(e, e.sessionId, nowMs);
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
        this.excluded.set(e.file.path, {
          source: e.file.source,
          rootDir: e.file.rootDir,
          lastStatMs: nowMs,
          sessionId: e.sessionId,
        });
        return;
      }
      if (nowMs - st.mtimeMs > RECENT_WINDOW_MS) {
        // File-mtime age-out: this IS the fresh stat — only it may drop. The
        // excluded lane keeps watching, so a later resume-append re-admits
        // within the cold cadence even when the dir mtime never moves.
        this.parents.delete(e.file.path);
        this.excluded.set(e.file.path, {
          source: e.file.source,
          rootDir: e.file.rootDir,
          lastStatMs: nowMs,
          sessionId: e.sessionId,
        });
        return;
      }
      e.file = { ...e.file, size: st.size, mtimeMs: st.mtimeMs };
    });
  }

  /** Cold-cadence recovery lane for tracked-but-not-admissible Claude paths
   *  (size 0 / own-mtime beyond the window). Promotion inserts as HOT. A
   *  LIVE session's excluded entry is due EVERY tick — the size-0 admission
   *  race hits exactly at session start (jsonl created before its first
   *  write), and M1 promises live sessions tick-cadence, not ≤60 s. */
  private async excludedStatPass(nowMs: number): Promise<void> {
    const due: Array<[string, ExcludedEntry]> = [];
    for (const [p, e] of this.excluded) {
      const live = e.sessionId !== "" && this.isLive(e.sessionId);
      if (live || nowMs - e.lastStatMs >= COLD_STAT_INTERVAL_MS) due.push([p, e]);
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
        this.insertParent(p, st.size, st.mtimeMs, e.source, e.rootDir, nowMs);
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
      if (e.sessionId === "") continue;
      const prev = parentMtime.get(e.sessionId);
      if (prev === undefined || e.file.mtimeMs > prev) parentMtime.set(e.sessionId, e.file.mtimeMs);
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
      // Per-DIR contribution: a session split across project dirs stays
      // promoted while ANY of its dirs shows movement — a quiet twin dir
      // walking later must not erase the active dir's promotion.
      if (movement) {
        let dirsWithMovement = this.childMovementDirs.get(sd.sessionId);
        if (!dirsWithMovement) {
          dirsWithMovement = new Set();
          this.childMovementDirs.set(sd.sessionId, dirsWithMovement);
        }
        dirsWithMovement.add(sd.sessionDir);
        this.childHotSessions.add(sd.sessionId);
      } else {
        this.releaseChildMovement(sd.sessionId, sd.sessionDir);
      }

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
