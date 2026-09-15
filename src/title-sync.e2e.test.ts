import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTitleSyncSweep } from "./title-sync.js";
import { getFileState, resetStateCache, setStateDirForTests, upsertFileState } from "./state.js";
import { resetCodexTitleCacheForTests } from "./codex-titles.js";
import type { FileState } from "./state.js";
import type { RetitleItem } from "./uploader.js";
import type { HxConfig } from "./config.js";

// Daemon-side E2E for the codex title backfill (LETAIR-481), codex SIMULATED via
// a REAL `state_5.sqlite` (bun:sqlite) — no codex install required. It drives the
// real sweep end to end: discover the rollout → read the codex name from the state
// DB → derive the authoritative destinations from state.json offsets → build and
// POST the /sessions/retitle request → parse the results → stamp titleSyncVersion.
// Only the network boundary is faked (globalThis.fetch), exactly like uploader.test.ts.
//
// The cloud relay (/sessions/retitle → runTitleJob) and the fortress RPC
// (updateSessionTitle CAS) are covered by their own repos' CI suites; this pins
// the daemon half — the part with no other end-to-end coverage.

const realFetch = globalThis.fetch;
const realCodexHome = process.env.CODEX_HOME;
const cfg: HxConfig = { gatewayBaseUrl: "https://gw.test", accessToken: "tok" };
const log = (): void => {};

let base: string;
let codexHome: string;
let stateDir: string;

/** A minimal but REAL codex state DB: threads(id,title,name), one row keyed by the
 *  rollout session id — the exact shape + join key the daemon reads. */
function seedCodexDb(sessionId: string, title: string | null, name: string | null): void {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)`);
  db.run(`INSERT INTO threads (id, title, name) VALUES (?, ?, ?)`, [sessionId, title, name]);
  db.close();
}

/** A discoverable rollout jsonl at the real codex layout (must be non-empty). */
function seedRollout(sessionId: string): string {
  const dir = join(codexHome, "sessions", "2026", "09", "14");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-09-14T10-00-00-${sessionId}.jsonl`);
  writeFileSync(p, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  return p;
}

const uploaded = (path: string, sessionId: string, offsets: Record<string, number>): FileState => ({
  path,
  family: "codex-cli",
  sessionId,
  offsets,
  lastMtimeMs: Date.now(),
  lastUploadAtMs: Date.now(),
});

/** Fake the gateway's /sessions/retitle: capture the request, echo a "queued" per item. */
function captureRetitle(): { seen: Array<{ url: string; auth?: string; items: RetitleItem[] }> } {
  const seen: Array<{ url: string; auth?: string; items: RetitleItem[] }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: RetitleItem[] };
    seen.push({ url: String(url), auth: h.authorization, items: body.items });
    return new Response(
      JSON.stringify({
        ok: true,
        results: body.items.map((it) => ({ family: it.family, sessionId: it.sessionId, status: "queued" })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { seen };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hx-title-e2e-"));
  codexHome = join(base, "codex-home");
  stateDir = join(base, "state");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  setStateDirForTests(stateDir);
  resetStateCache("main");
  resetCodexTitleCacheForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setStateDirForTests(null);
  resetStateCache("main");
  resetCodexTitleCacheForTests();
  if (realCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = realCodexHome;
  rmSync(base, { recursive: true, force: true });
});

describe("title-sync sweep — daemon E2E (codex simulated via a real state_5.sqlite)", () => {
  it("reads codex's name, POSTs it with the authoritative destinations, and stamps", async () => {
    const sessionId = crypto.randomUUID();
    seedCodexDb(sessionId, "codex first-message title", "My renamed thread");
    const rollout = seedRollout(sessionId);
    // Already fully uploaded to two destinations: the let.ai default + an org vault.
    await upsertFileState(uploaded(rollout, sessionId, { letai: 1200, "org-9": 640 }), "main");

    const { seen } = captureRetitle();
    const summary = await runTitleSyncSweep(cfg, "main", log);

    assert.equal(seen.length, 1, "exactly one batch POSTed");
    assert.equal(seen[0]!.url, "https://gw.test/sessions/retitle");
    assert.equal(seen[0]!.auth, "Bearer tok");
    assert.deepEqual(seen[0]!.items[0], {
      family: "codex-cli",
      sessionId,
      title: "My renamed thread", // `name` preferred over the auto `title`
      titleSource: "user",
      destinations: [null, "org-9"], // "letai" → null; both offsets > 0
    });
    assert.equal(summary.queued, 1);
    // Stamped so a second start is a no-op.
    assert.equal((await getFileState(rollout, "main"))?.titleSyncVersion, 1);
  });

  it("falls back to the auto title (source 'ai') when there is no rename", async () => {
    const sessionId = crypto.randomUUID();
    seedCodexDb(sessionId, "Fix the login bug", null);
    const rollout = seedRollout(sessionId);
    await upsertFileState(uploaded(rollout, sessionId, { letai: 500 }), "main");

    const { seen } = captureRetitle();
    await runTitleSyncSweep(cfg, "main", log);

    assert.deepEqual(seen[0]!.items[0], {
      family: "codex-cli",
      sessionId,
      title: "Fix the login bug",
      titleSource: "ai",
      destinations: [null],
    });
  });

  it("is a no-op on the second run — already stamped, nothing re-sent", async () => {
    const sessionId = crypto.randomUUID();
    seedCodexDb(sessionId, "t", "n");
    const rollout = seedRollout(sessionId);
    await upsertFileState(uploaded(rollout, sessionId, { letai: 10 }), "main");

    const first = captureRetitle();
    await runTitleSyncSweep(cfg, "main", log);
    assert.equal(first.seen.length, 1);

    const second = captureRetitle();
    const summary = await runTitleSyncSweep(cfg, "main", log);
    assert.equal(second.seen.length, 0, "no POST on the second run");
    assert.equal(summary.skipped, 1);
  });

  it("stamps but does not POST a session codex has no name for; skips a file with no upload state", async () => {
    // (a) uploaded, but codex has neither name nor title → stamped, not sent.
    const noName = crypto.randomUUID();
    seedCodexDb(noName, null, null);
    const rNoName = seedRollout(noName);
    await upsertFileState(uploaded(rNoName, noName, { letai: 7 }), "main");

    // (b) discoverable rollout with NO upload state → skipped entirely.
    const noState = crypto.randomUUID();
    seedRollout(noState);

    const { seen } = captureRetitle();
    const summary = await runTitleSyncSweep(cfg, "main", log);

    assert.equal(seen.length, 0, "nothing POSTed");
    assert.equal(summary.noTitle, 1);
    assert.equal((await getFileState(rNoName, "main"))?.titleSyncVersion, 1);
  });
});
