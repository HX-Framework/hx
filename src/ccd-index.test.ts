// The incremental CCD session index (Request Pricing M13). The store on a
// long-lived machine is tens of thousands of files; the daemon must learn of
// a change without re-statting, let alone re-reading, every file on every
// refresh. These pin the three mechanisms: the dir-mtime gate (a rename-style
// write, which is how CCD writes, is seen on the next refresh), the per-file
// stat gate (a file whose stat did not move is never re-read), and the slow
// full stat sweep (an in-place rewrite that leaves the dir mtime alone is
// still seen within CCD_FULL_STAT_INTERVAL_MS).

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CCD_FULL_STAT_INTERVAL_MS,
  CCD_REFRESH_TTL_MS,
  ccdIndexVersion,
  getCcdRecentsByCliId,
  readCcdRecentsCached,
  refreshCcdIndex,
  setCcdSessionsDirForTests,
} from "./ccd.js";

let root: string;
let org: string;

function sessionJson(ccd: string, cli: string, title: string): string {
  return JSON.stringify({
    sessionId: ccd,
    cliSessionId: cli,
    title,
    titleSource: "user",
    isArchived: false,
    lastActivityAt: 1,
  });
}

function setup(): void {
  root = mkdtempSync(join(tmpdir(), "hx-ccd-index-"));
  const sessions = join(root, "claude-code-sessions");
  org = join(sessions, "acct", "org");
  mkdirSync(org, { recursive: true });
  writeFileSync(join(org, "local_a.json"), sessionJson("local_a", "cli-a", "A"));
  writeFileSync(join(org, "local_b.json"), sessionJson("local_b", "cli-b", "B"));
  setCcdSessionsDirForTests(sessions);
}

/** Write through a temp file + rename, the way CCD (and any atomic writer)
 *  does — this bumps the parent dir's mtime. */
function renameWrite(p: string, content: string): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

const T0 = 1_000_000;
const PINNED = new Date(1_700_000_000_000);

afterEach(() => {
  setCcdSessionsDirForTests(null);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("CCD session index", () => {
  it("builds once and serves the same records while nothing changed", async () => {
    setup();
    const v1 = await refreshCcdIndex(T0);
    assert.equal(v1, 1);
    const recs = await readCcdRecentsCached(T0);
    assert.deepEqual(recs.map((r) => r.cliSessionId).sort(), ["cli-a", "cli-b"]);
    // Within the TTL nothing is even statted; past it, an unchanged store keeps
    // the records' identity (so derived maps stay cached too).
    assert.equal(await readCcdRecentsCached(T0 + CCD_REFRESH_TTL_MS - 1), recs);
    assert.equal(await readCcdRecentsCached(T0 + CCD_REFRESH_TTL_MS), recs);
    assert.equal(ccdIndexVersion(), 1);
  });

  it("a rename-style write (how CCD writes) is seen on the next refresh", async () => {
    setup();
    await refreshCcdIndex(T0);
    renameWrite(join(org, "local_a.json"), sessionJson("local_a", "cli-a2", "A2"));
    renameWrite(join(org, "local_c.json"), sessionJson("local_c", "cli-c", "C"));
    const map = await getCcdRecentsByCliId(T0 + CCD_REFRESH_TTL_MS);
    assert.equal(map.get("cli-a2")?.title, "A2", "rewritten file re-read");
    assert.equal(map.get("cli-a"), undefined, "old mapping gone");
    assert.equal(map.get("cli-c")?.title, "C", "new file admitted");
    assert.equal(ccdIndexVersion(), 2);
  });

  it("a deleted file leaves the index on the next refresh", async () => {
    setup();
    await refreshCcdIndex(T0);
    unlinkSync(join(org, "local_b.json"));
    const map = await getCcdRecentsByCliId(T0 + CCD_REFRESH_TTL_MS);
    assert.equal(map.has("cli-b"), false);
    assert.equal(map.has("cli-a"), true);
  });

  it("a file whose size and mtime did not move is never re-read", async () => {
    setup();
    const a = join(org, "local_a.json");
    utimesSync(a, PINNED, PINNED);
    utimesSync(org, PINNED, PINNED);
    await refreshCcdIndex(T0);
    // Same byte length, same mtime, pinned dir mtime: only a re-read could
    // see "A!" — and the stat gate must not re-read.
    const swapped = sessionJson("local_a", "cli-a", "A!");
    assert.equal(swapped.length, sessionJson("local_a", "cli-a", "A").length + 1);
    writeFileSync(a, sessionJson("local_a", "cli-a", "A").replace('"A"', '"Z"'));
    utimesSync(a, PINNED, PINNED);
    utimesSync(org, PINNED, PINNED);
    await refreshCcdIndex(T0 + CCD_FULL_STAT_INTERVAL_MS, { force: true });
    const map = await getCcdRecentsByCliId(T0 + CCD_FULL_STAT_INTERVAL_MS);
    assert.equal(map.get("cli-a")?.title, "A", "unchanged stat served the cached record");
  });

  it("an in-place rewrite that leaves the dir mtime alone is seen by the full stat sweep", async () => {
    setup();
    utimesSync(org, PINNED, PINNED);
    await refreshCcdIndex(T0);
    writeFileSync(join(org, "local_b.json"), sessionJson("local_b", "cli-b2", "B2 rewritten"));
    utimesSync(org, PINNED, PINNED); // an in-place write never moves it anyway
    // Next refresh: dir unchanged, no full sweep due yet → not seen.
    const early = await getCcdRecentsByCliId(T0 + CCD_REFRESH_TTL_MS);
    assert.equal(early.has("cli-b2"), false);
    assert.equal(early.get("cli-b")?.title, "B");
    // Full sweep due: every file is statted, the moved one re-read.
    const late = await getCcdRecentsByCliId(T0 + CCD_FULL_STAT_INTERVAL_MS);
    assert.equal(late.get("cli-b2")?.title, "B2 rewritten");
    assert.equal(late.has("cli-b"), false);
  });

  it("concurrent refreshes share one run and force bypasses the TTL", async () => {
    setup();
    const [a, b] = await Promise.all([refreshCcdIndex(T0), refreshCcdIndex(T0)]);
    assert.equal(a, b);
    renameWrite(join(org, "local_a.json"), sessionJson("local_a", "cli-forced", "F"));
    assert.equal(await refreshCcdIndex(T0 + 1), 1, "inside the TTL: no refresh");
    assert.equal(await refreshCcdIndex(T0 + 1, { force: true }), 2, "forced: refreshed");
    assert.equal((await getCcdRecentsByCliId(T0 + 1)).get("cli-forced")?.title, "F");
  });

  it("degrades to no records when the store is absent", async () => {
    root = mkdtempSync(join(tmpdir(), "hx-ccd-index-"));
    setCcdSessionsDirForTests(join(root, "does-not-exist"));
    assert.deepEqual(await readCcdRecentsCached(T0), []);
    assert.equal((await getCcdRecentsByCliId(T0)).size, 0);
  });
});
