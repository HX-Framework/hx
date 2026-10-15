// File events as hints for the discovery catalog.
//
// The watch loop polled: every 1.5 s it statted every project directory,
// every hot transcript and every subagent lane — about 3,200 system calls per
// tick on a laptop with 727 project dirs (2,140 a second at idle), and about
// 4% of a core before anything uploaded. The operating system already knows
// which paths changed: FSEvents on macOS, inotify on Linux,
// ReadDirectoryChangesW on Windows, all behind fs.watch with
// `recursive: true`. The catalog now takes those events as HINTS — "look here
// on the next tick" — and keeps its full polling sweep as a SAFETY NET every
// SAFETY_SWEEP_MS (catalog.ts), so a missed or coalesced event costs at most a
// minute of latency, never a file.
//
// Hints, not truth: an event names a path; the catalog still stats it, so
// nothing an event says is believed without the same system call the poll
// made. Events also arrive for paths the catalog does not track (a tool's
// temp file); the catalog drops those after one in-memory lookup.
//
// When watching fails — the platform refuses recursive watches, the inotify
// watch limit is hit, a watcher dies — the catalog polls exactly as before
// and the daemon logs one line saying so. One-shot runs (`hx tick`,
// `watch --once`) never arm events: their one pass is a full sweep anyway.

import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  claudeProjectsDir,
  codexArchivedDir,
  codexSessionsDir,
  type ResolvedRoots,
} from "./roots.js";

export interface FileEventSource {
  /** Directories under watch right now (absolute). */
  readonly watched: string[];
  /** Directories of the roots that did not exist when armed. */
  readonly missing: string[];
  /** Retry the directories that were missing — a root that appeared since. */
  rearm(): void;
  close(): void;
}

/** The directories the client reads transcripts, lanes and trackers from. */
export function eventDirsFor(roots: ResolvedRoots): string[] {
  const out: string[] = [];
  for (const r of roots.claude) {
    out.push(claudeProjectsDir(r.configDir), path.join(r.configDir, "sessions"));
  }
  for (const r of roots.codex) {
    out.push(codexSessionsDir(r.configDir), codexArchivedDir(r.configDir));
  }
  return out;
}

/**
 * Watch every directory of the roots, recursively. Each event becomes one
 * hint: the absolute path the event named (the directory itself when the
 * platform gives no name). Returns null — and reports why — when any
 * directory cannot be watched; a watcher that fails LATER closes the whole
 * source and reports the same way, so the caller falls back to polling
 * either way.
 */
export function armFileEvents(
  roots: ResolvedRoots,
  onHint: (absPath: string) => void,
  onFailure: (reason: string) => void,
): FileEventSource | null {
  const watchers = new Map<string, FSWatcher>();
  const missing = new Set<string>();
  let failed = false;
  const closeAll = (): void => {
    for (const w of watchers.values()) {
      try {
        w.close();
      } catch {
        // closing is best-effort
      }
    }
    watchers.clear();
  };
  const fail = (dir: string, err: unknown): void => {
    if (failed) return;
    failed = true;
    closeAll();
    onFailure(`${dir}: ${(err as Error).message}`);
  };
  const armOne = (dir: string): boolean => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a watched config root
    if (!existsSync(dir)) {
      missing.add(dir);
      return true;
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a watched config root
      const w = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        onHint(filename ? path.join(dir, String(filename)) : dir);
      });
      w.on("error", (err) => fail(dir, err));
      watchers.set(dir, w);
      missing.delete(dir);
      return true;
    } catch (err) {
      fail(dir, err);
      return false;
    }
  };
  for (const dir of eventDirsFor(roots)) {
    if (!armOne(dir)) return null;
  }
  return {
    get watched(): string[] {
      return [...watchers.keys()];
    },
    get missing(): string[] {
      return [...missing];
    },
    rearm(): void {
      if (failed) return;
      for (const dir of [...missing]) armOne(dir);
    },
    close: closeAll,
  };
}
