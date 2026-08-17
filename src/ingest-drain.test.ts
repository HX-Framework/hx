// ingestOne drain semantics (LETAIR-144 WS3, verification items 4 + 12):
// byte-budget pacing (numerically today's 16 × 4 MB), growth staying DARK by
// default, the growth ladder when enabled, and the side-effect-free probe —
// a failure at a grown size must retry in place at the base size with NO
// [error] line, NO destination-error latch, NO file backoff, and a persisted
// learned cap.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HxConfig } from "./config.js";
import {
  getChunkCap,
  loadState,
  resetStateCache,
  setStateDirForTests,
  upsertFileState,
  type FileState,
} from "./state.js";
import { ingestOne, resetChunkGrowthForTests } from "./watch.js";
import type { DiscoveredFile } from "./sources.js";

const MB = 1024 * 1024;
const realFetch = globalThis.fetch;
let dir: string;

afterEach(() => {
  globalThis.fetch = realFetch;
  setStateDirForTests(null);
  resetStateCache("main");
  resetChunkGrowthForTests();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

interface StubOptions {
  /** PUT bodies strictly larger than this fail with 413. */
  putMaxBytes?: number;
}

interface StubLedger {
  appendUrls: number;
  putBodies: number[];
  commits: number;
  totalBytes: number;
}

function stubGateway(opts: StubOptions = {}): StubLedger {
  const ledger: StubLedger = { appendUrls: 0, putBodies: [], commits: 0, totalBytes: 0 };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/sessions/append-url")) {
      ledger.appendUrls += 1;
      return new Response(
        JSON.stringify({
          chunkId: `c${ledger.appendUrls}`,
          uploadUrl: "https://blob.test/staging",
          objectName: "o",
          expiresAt: "2027-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.startsWith("https://blob.test/staging")) {
      const body = init?.body as Buffer | Uint8Array;
      const len = body ? (body as Uint8Array).byteLength : 0;
      if (opts.putMaxBytes !== undefined && len > opts.putMaxBytes) {
        return new Response("<Error><Code>EntityTooLarge</Code></Error>", { status: 413 });
      }
      ledger.putBodies.push(len);
      return new Response(null, { status: 200 });
    }
    if (u.endsWith("/sessions/commit")) {
      ledger.commits += 1;
      ledger.totalBytes = ledger.putBodies.reduce((a, b) => a + b, 0);
      return new Response(
        JSON.stringify({ ok: true, totalBytes: ledger.totalBytes, componentCount: ledger.commits }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  return ledger;
}

const cfg: HxConfig = { gatewayBaseUrl: "https://gw.test", accessToken: "tok" };

/** A session file of newline-terminated lines, pre-seeded in state (so
 *  ingestOne's head read and seeding stay off the hot path under test) with
 *  all offsets at zero. `lineLen` defaults to 1024 (chunk-aligned, for exact
 *  budget math); pass an UNALIGNED length to prove trim-shortfall paths —
 *  real jsonl never lands chunk boundaries on newlines. */
async function seedFile(totalBytes: number, lineLen = 1024): Promise<DiscoveredFile> {
  dir = mkdtempSync(join(tmpdir(), "hx-drain-"));
  setStateDirForTests(dir);
  resetStateCache("main");
  const p = join(dir, "session.jsonl");
  const line = `${"x".repeat(lineLen - 1)}\n`;
  writeFileSync(p, line.repeat(Math.ceil(totalBytes / lineLen)));
  const fs: FileState = {
    path: p,
    family: "claude-cli",
    sessionId: "sess-1",
    cwd: "~/w",
    repoSlug: null,
    offsets: {},
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
    lastKnownSize: totalBytes,
  };
  await upsertFileState(fs);
  const size = Math.ceil(totalBytes / lineLen) * lineLen;
  return { path: p, size, mtimeMs: Date.now(), source: "claude", rootDir: dir };
}

const silentLog = (): void => {};

describe("ingestOne drain", () => {
  it("keeps chunks at 4 MB with growth dark and paces to the 64 MB budget", async () => {
    const f = await seedFile(68 * MB);
    const ledger = stubGateway();
    const logs: string[] = [];
    const did = await ingestOne(cfg, f, {}, (m) => logs.push(m));
    assert.equal(did, true);
    assert.ok(ledger.putBodies.every((b) => b <= 4 * MB), "no body exceeded 4 MB");
    const sent = ledger.putBodies.reduce((a, b) => a + b, 0);
    assert.equal(sent, 64 * MB, "exactly the historical 16×4 MB per pass");
    const state = await loadState();
    assert.equal(state.files[f.path]!.offsets["letai"], 64 * MB, "offset advanced to the budget");

    // Second pass drains the remainder.
    const did2 = await ingestOne(cfg, f, {}, silentLog);
    assert.equal(did2, true);
    const state2 = await loadState();
    assert.equal(state2.files[f.path]!.offsets["letai"], 68 * MB, "fully delivered next pass");
  });

  it("grows the ladder 4→8→16 MB when enabled — with UNALIGNED lines", async () => {
    // 998-byte lines: no chunk boundary ever lands on a newline, so every
    // chunk trims short of its request. The ladder must advance on FULL-SIZE
    // REQUESTS, not on exact trimmed lengths (the defect class this pins).
    const f = await seedFile(28 * MB, 998);
    const ledger = stubGateway();
    const did = await ingestOne(cfg, f, { chunkGrowth: true }, silentLog);
    assert.equal(did, true);
    assert.deepEqual(
      ledger.putBodies.slice(0, 3).map((b) => Math.round(b / MB)),
      [4, 8, 16],
      "doubling per clean full-size round despite trim shortfalls",
    );
    const sent = ledger.putBodies.reduce((a, b) => a + b, 0);
    const state = await loadState();
    assert.equal(state.files[f.path]!.offsets["letai"], sent, "offsets track trimmed bytes");
    assert.equal(sent, f.size, "fully delivered (tail chunks included)");
  });

  it("probe: a grown-size failure retries in place with zero side effects and persists the cap", async () => {
    const f = await seedFile(28 * MB, 998); // unaligned — real-world trim shortfalls
    const ledger = stubGateway({ putMaxBytes: 8 * MB }); // 16 MB attempt 413s
    const logs: string[] = [];
    const did = await ingestOne(cfg, f, { chunkGrowth: true }, (m) => logs.push(m));
    assert.equal(did, true);

    // The 16 MB attempt failed invisibly (never recorded — the stub logs only
    // successful PUTs); the retry ran at LAST-GOOD (8 MB — proven by its own
    // clean commit), which becomes the persisted cap. A 413 must not forfeit
    // the proven rung down to base.
    assert.deepEqual(
      ledger.putBodies.slice(0, 2).map((b) => Math.round(b / MB)),
      [4, 8],
      "ladder up to the failure",
    );
    assert.ok(
      ledger.putBodies.slice(2).every((b) => b <= 8 * MB),
      "every body after the probe is at most the last-good rung",
    );
    assert.ok(
      ledger.putBodies.slice(2).some((b) => Math.round(b / MB) === 8),
      "the retry itself ran at the last-good 8 MB",
    );
    assert.equal(await getChunkCap("letai"), 8 * MB, "learned cap persisted at last-good");

    const state = await loadState();
    assert.equal(state.files[f.path]!.offsets["letai"], f.size, "file fully delivered regardless");
    assert.equal(state.files[f.path]!.consecutiveFailures, undefined, "no file backoff");
    assert.equal(state.destinations?.["letai"]?.consecutiveErrors, undefined, "no registry latch");
    assert.ok(!logs.some((l) => l.includes("[error]")), "no [error] line");
    assert.ok(
      logs.some((l) => l.includes("chunk size settled at 8 MB")),
      "one informational cap line at the last-good rung",
    );

    // Restart-equivalent: a fresh drain honors the persisted cap, no re-probe.
    const f2 = await (async () => {
      const line = `${"y".repeat(1023)}\n`;
      const p2 = join(dir, "session2.jsonl");
      writeFileSync(p2, line.repeat((10 * MB) / 1024));
      await upsertFileState({
        path: p2,
        family: "claude-cli",
        sessionId: "sess-2",
        cwd: "~/w",
        repoSlug: null,
        offsets: {},
        lastMtimeMs: 0,
        lastUploadAtMs: 0,
        lastKnownSize: 10 * MB,
      });
      return { path: p2, size: 10 * MB, mtimeMs: Date.now(), source: "claude" as const, rootDir: dir };
    })();
    const ledger2 = stubGateway({ putMaxBytes: 8 * MB });
    await ingestOne(cfg, f2, { chunkGrowth: true }, silentLog);
    assert.ok(
      ledger2.putBodies.every((b) => b <= 8 * MB),
      "persisted cap bounds every chunk — nothing above the learned rung, so no re-probe",
    );
  });

  it("a transient 5xx at a grown size steps the ladder back WITHOUT persisting a cap", async () => {
    const f = await seedFile(28 * MB, 998);
    // Fail exactly one PUT (the first 16 MB attempt) with a 500, then heal.
    let failed = false;
    const ledger = stubGateway();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!failed && u.startsWith("https://blob.test/staging")) {
        const body = init?.body as Uint8Array;
        if (body && body.byteLength > 8 * MB) {
          failed = true;
          return new Response("transient", { status: 500 });
        }
      }
      return (inner as typeof fetch)(url as string, init);
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const did = await ingestOne(cfg, f, { chunkGrowth: true }, (m) => logs.push(m));
    assert.equal(did, true);
    assert.equal(failed, true, "the injected 500 fired");
    assert.equal(await getChunkCap("letai"), undefined, "no durable cap from a transient error");
    assert.ok(!logs.some((l) => l.includes("settled")), "no cap line either");
    assert.ok(
      ledger.putBodies.some((b) => Math.round(b / MB) === 8),
      "the in-place retry ran at the last-good rung",
    );
    const state = await loadState();
    assert.equal(state.files[f.path]!.offsets["letai"], f.size, "delivered despite the blip");
    assert.equal(state.files[f.path]!.consecutiveFailures, undefined, "no file backoff");
  });

  it("chunkLimitBytes stays an absolute override even under growth", async () => {
    const f = await seedFile(2 * MB);
    const ledger = stubGateway();
    await ingestOne(cfg, f, { chunkGrowth: true, chunkLimitBytes: 256 * 1024 }, silentLog);
    assert.ok(ledger.putBodies.every((b) => b <= 256 * 1024), "override respected");
    const state = await loadState();
    assert.equal(state.files[f.path]!.offsets["letai"], 2 * MB);
  });
});
