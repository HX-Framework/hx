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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CCD_FULL_STAT_INTERVAL_MS,
  CCD_REFRESH_TTL_MS,
  ccdIndexVersion,
  getCcdRecentsByCliId,
  readCcdRecentsCached,
  refreshCcdIndex,
  saveCcdIndexIfChanged,
  setCcdIndexPathForTests,
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

const T0 = 1_000_000;
const PINNED = new Date(1_700_000_000_000);

function setup(): void {
  root = mkdtempSync(join(tmpdir(), "hx-ccd-index-"));
  const sessions = join(root, "claude-code-sessions");
  org = join(sessions, "acct", "org");
  mkdirSync(org, { recursive: true });
  writeFileSync(join(org, "local_a.json"), sessionJson("local_a", "cli-a", "A"));
  writeFileSync(join(org, "local_b.json"), sessionJson("local_b", "cli-b", "B"));
  // The org dir last changed long ago, as on a machine whose index is already
  // built, so a file the test creates, renames or deletes moves the dir's
  // mtime: that move is what the dir-mtime gate looks for. Without the pin it
  // can stay put. On the Windows CI runner a dir's mtime advances in steps up
  // to 16 ms apart, and a change made about a millisecond after the writes
  // above left it unchanged in 29% to 68% of attempts.
  utimesSync(org, PINNED, PINNED);
  setCcdSessionsDirForTests(sessions);
}

/** Write through a temp file + rename, the way CCD (and any atomic writer)
 *  does — this bumps the parent dir's mtime. */
function renameWrite(p: string, content: string): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

afterEach(() => {
  setCcdSessionsDirForTests(null);
  setCcdIndexPathForTests(null);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A "restart": drop the in-memory index, keep the files and the saved index. */
function restart(): void {
  const sessions = join(root, "claude-code-sessions");
  setCcdSessionsDirForTests(sessions);
  setCcdIndexPathForTests(join(root, "ccd-index.json"));
}

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

// Saved across restarts (~/.let/hx/ccd-index.json): a fresh process loads
// the saved index and STATS every file once instead of READING every file;
// only files that moved while it was down are re-read.
describe("CCD session index saved across restarts", () => {
  it("saves when changed, loads on the next process, and serves the same records", async () => {
    setup();
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    assert.equal(await saveCcdIndexIfChanged(T0), false, "nothing indexed yet: nothing to save");
    await refreshCcdIndex(T0);
    assert.equal(await saveCcdIndexIfChanged(T0), true, "the first build is saved");
    assert.equal(await saveCcdIndexIfChanged(T0 + 1), false, "unchanged since: not saved again");
    const saved = JSON.parse(readFileSync(join(root, "ccd-index.json"), "utf8")) as { v: number; files: Record<string, unknown>; dirs: Record<string, unknown> };
    assert.equal(saved.v, 2);
    assert.equal(Object.keys(saved.files).length, 2);
    assert.equal(Object.keys(saved.dirs).length, 1);

    restart();
    assert.equal(ccdIndexVersion(), 0, "a fresh process starts empty");
    const map = await getCcdRecentsByCliId(T0 + 1000);
    assert.deepEqual([...map.keys()].sort(), ["cli-a", "cli-b"], "served from the saved index + one stat sweep");
    assert.equal(ccdIndexVersion(), 1, "nothing moved: the loaded index is the first build");
    assert.equal(await saveCcdIndexIfChanged(T0 + 1000, { force: true }), false, "and needs no new save");
  });

  it("the first refresh after a load re-stats every file: an in-place rewrite while down is seen at once", async () => {
    setup();
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    utimesSync(org, PINNED, PINNED);
    await refreshCcdIndex(T0);
    await saveCcdIndexIfChanged(T0, { force: true });
    // "Down": the file is rewritten in place (dir mtime unmoved), bigger.
    writeFileSync(join(org, "local_b.json"), sessionJson("local_b", "cli-b2", "B2 rewritten while down"));
    utimesSync(org, PINNED, PINNED);

    restart();
    const map = await getCcdRecentsByCliId(T0 + 1000);
    assert.equal(map.get("cli-b2")?.title, "B2 rewritten while down", "re-read because its stat moved");
    assert.equal(map.has("cli-b"), false);
    assert.equal(map.get("cli-a")?.title, "A", "an unmoved file was served without a read");
    assert.equal(ccdIndexVersion(), 2, "the loaded index changed once");
    assert.equal(await saveCcdIndexIfChanged(T0 + 1000, { force: true }), true, "the change is saved");
  });

  it("respects the save interval unless forced", async () => {
    setup();
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    await refreshCcdIndex(T0);
    assert.equal(await saveCcdIndexIfChanged(T0), true);
    renameWrite(join(org, "local_c.json"), sessionJson("local_c", "cli-c", "C"));
    await refreshCcdIndex(T0 + CCD_REFRESH_TTL_MS);
    assert.equal(await saveCcdIndexIfChanged(T0 + CCD_REFRESH_TTL_MS), false, "changed, but inside the interval");
    assert.equal(await saveCcdIndexIfChanged(T0 + CCD_REFRESH_TTL_MS, { force: true }), true, "forced: the parting flush");
  });

  it("ignores a corrupt or foreign saved index and rebuilds", async () => {
    setup();
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    writeFileSync(join(root, "ccd-index.json"), "{not json");
    const map = await getCcdRecentsByCliId(T0);
    assert.deepEqual([...map.keys()].sort(), ["cli-a", "cli-b"], "built from the store");

    // A save that describes another store's files: none of its entries are ours.
    restart();
    writeFileSync(
      join(root, "ccd-index.json"),
      JSON.stringify({ v: 2, savedAtMs: 1, dirs: { "/elsewhere/acct/org": { mtimeMs: 1, files: ["/elsewhere/acct/org/local_z.json"] } }, files: { "/elsewhere/acct/org/local_z.json": { size: 1, mtimeMs: 1, record: { ccdSessionId: "local_z", cliSessionId: "cli-z", title: "Z", titleSource: "ai", isArchived: false, lastActivityAt: 0, parentId: null } } } }),
    );
    const map2 = await getCcdRecentsByCliId(T0);
    assert.equal(map2.has("cli-z"), false, "foreign entries dropped");
    assert.deepEqual([...map2.keys()].sort(), ["cli-a", "cli-b"]);
  });

  it("ignores a save in the format before records carried their parent, and rebuilds", async () => {
    setup();
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    await refreshCcdIndex(T0);
    await saveCcdIndexIfChanged(T0, { force: true });
    const file = join(root, "ccd-index.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { v: number; files: Record<string, { record: Record<string, unknown> | null }> };
    // The same save as a build before parentId wrote it, with a title the
    // store does not have: loading it would serve that title.
    saved.v = 1;
    for (const f of Object.values(saved.files)) if (f.record) { delete f.record.parentId; f.record.title = "from the old save"; }
    writeFileSync(file, JSON.stringify(saved));
    restart();
    const map = await getCcdRecentsByCliId(T0 + 1000);
    assert.equal(map.get("cli-a")?.title, "A", "read from the store, not the old save");
    assert.equal(map.get("cli-a")?.parentId, null);
  });

  it("writes nothing where Claude Desktop does not ship", async () => {
    root = mkdtempSync(join(tmpdir(), "hx-ccd-index-"));
    setCcdSessionsDirForTests(join(root, "does-not-exist"));
    setCcdIndexPathForTests(join(root, "ccd-index.json"));
    await refreshCcdIndex(T0);
    assert.equal(await saveCcdIndexIfChanged(T0, { force: true }), false);
    assert.equal(existsSync(join(root, "ccd-index.json")), false);
  });
});
