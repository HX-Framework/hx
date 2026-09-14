// The codex title backfill sweep (LETAIR-481) — the retro half of "hx update
// gives codex sessions their real name".
//
// Codex writes no title into the rollout the daemon ingests, so every codex
// session lands with the first-message fallback floor. The daemon reads codex's
// OWN name from ~/.codex/state_*.sqlite and, for a LIVE session, it rides the
// next content commit (watch.ts deriveTitleMeta). But a DORMANT, fully-uploaded
// session never re-commits — so this sweep pushes the name once per file, on
// daemon start, via POST /sessions/retitle: a bytes-free, CAS-guarded metadata
// refresh (no content moves, nothing is re-indexed).
//
// Discovery is UNWINDOWED (maxAgeMs: Infinity): the whole point is to reach the
// dormant sessions still on disk, which are exactly the ones live ingest's
// cadence window has aged out. Files with no upload state are skipped — they have
// no server row to title (live ingest owns them).
//
// We NEVER generate a name: the value is codex's own (a user `codex rename`, or
// codex's auto title), passed through verbatim. Failure model mirrors the
// attribution sweep: a batch that fails (network, or a gateway predating the
// route) aborts WITHOUT stamping the remaining files, so the next daemon start
// simply retries. Stamping is per-file and follows the successful batch.

import { discoverCodexFiles } from "./sources.js";
import { getFileState, upsertFileState, type StateScope } from "./state.js";
import { retitleSessions, type RetitleItem } from "./uploader.js";
import { readCodexTitle } from "./codex-titles.js";
import { readSettings } from "./settings.js";
import { resolveDataRoots } from "./roots.js";
import type { HxConfig } from "./config.js";

/** Bump to re-sweep every codex file — e.g. after teaching the reader a NEW
 *  codex client's name location, or to re-push titles wholesale. */
export const TITLE_SYNC_VERSION = 1;

const BATCH_SIZE = 100;

/** Matches the /sessions/retitle Zod `title` cap — the daemon truncates to it so
 *  a pathologically long codex title can never 400 (and stall) the whole batch. */
const TITLE_MAX_LEN = 1024;

/** The destinations this file's bytes were actually uploaded to — the
 *  AUTHORITATIVE content homes (state.json offset keys with a non-zero offset),
 *  so the title lands where the content really is (a session reattributed since
 *  upload is not misrouted). "letai" ⇒ the let.ai default fortress (null). */
export function codexDestinations(offsets: Record<string, number> | undefined): (string | null)[] {
  if (!offsets) return [];
  return Object.entries(offsets)
    .filter(([, v]) => v > 0)
    .map(([k]) => (k === "letai" ? null : k));
}

export interface TitleSweepSummary {
  scanned: number;
  sent: number;
  queued: number;
  noTitle: number;
  skipped: number;
}

export async function runTitleSyncSweep(
  cfg: HxConfig,
  scope: StateScope,
  log: (msg: string) => void,
  opts: { force?: boolean } = {},
): Promise<TitleSweepSummary> {
  const summary: TitleSweepSummary = { scanned: 0, sent: 0, queued: 0, noTitle: 0, skipped: 0 };
  const roots = resolveDataRoots(await readSettings());
  // Codex-only: this is the family that lands without a client title. Unwindowed
  // so a dormant session that aged out of live ingest is still reached.
  const files = await discoverCodexFiles(roots.codex, { maxAgeMs: Infinity });

  type Pending = { item: RetitleItem; stamp: () => Promise<void> };
  const pending: Pending[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const { results } = await retitleSessions(
      cfg,
      batch.map((p) => p.item),
    );
    const byKey = new Map(results.map((r) => [`${r.family}:${r.sessionId}`, r]));
    for (const p of batch) {
      const r = byKey.get(`${p.item.family}:${p.item.sessionId}`);
      if (r?.status === "queued") summary.queued += 1;
      summary.sent += 1;
      // Both "queued" and "deleted" are terminal for this file — stamp so it is
      // not re-read on the next start. A failed batch throws before this loop.
      await p.stamp();
    }
  };

  for (const file of files) {
    const fState = await getFileState(file.path, scope);
    const destinations = codexDestinations(fState?.offsets);
    // No upload state / nothing uploaded ⇒ no server row to title; live ingest owns it.
    if (!fState || destinations.length === 0) continue;
    if (!opts.force && (fState.titleSyncVersion ?? 0) >= TITLE_SYNC_VERSION) {
      summary.skipped += 1;
      continue;
    }
    summary.scanned += 1;
    const title = readCodexTitle(file.rootDir, fState.sessionId);
    if (!title) {
      // Codex has no name for this session — stamp so we don't re-read it every
      // start; a TITLE_SYNC_VERSION bump revisits it.
      fState.titleSyncVersion = TITLE_SYNC_VERSION;
      await upsertFileState(fState, scope);
      summary.noTitle += 1;
      continue;
    }
    pending.push({
      item: {
        family: fState.family as RetitleItem["family"],
        sessionId: fState.sessionId,
        // Cap at the /sessions/retitle length limit: a pathologically long codex
        // auto-title (derived from a long first message) must not 400 the batch —
        // that would abort the whole sweep and re-fail it on every restart.
        title: title.title.slice(0, TITLE_MAX_LEN),
        titleSource: title.source,
        destinations,
      },
      stamp: async () => {
        fState.titleSyncVersion = TITLE_SYNC_VERSION;
        await upsertFileState(fState, scope);
      },
    });
    if (pending.length >= BATCH_SIZE) await flush();
  }
  await flush();

  if (summary.sent > 0 || summary.scanned > 0) {
    log(
      `[retitle] v${TITLE_SYNC_VERSION}: ${summary.sent} reported ` +
        `(${summary.queued} queued), ${summary.noTitle} no-name, ${summary.skipped} already current`,
    );
  }
  return summary;
}
