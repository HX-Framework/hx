// CCD read gating (LETAIR-144 WS4): the 20 s mirror cycle must cost stats,
// not scans, when nothing changed — and must still see every real change.
// The proof of "no scan on unchanged fingerprint" swaps the .log's CONTENT
// while keeping its size and mtime identical: a cache hit then returns the
// OLD groups (content was never re-read), while any size/mtime movement
// makes the new content visible.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGroupMirror, setCcdLeveldbDirForTests } from "./ccd-prefs.js";
import { readCcdRecentsCached, setCcdSessionsDirForTests } from "./ccd.js";

let root: string;

function frameStoreLog(groupName: string): string {
  const state = {
    groupByByMode: { code: "custom" },
    customGroups: [{ id: "g1", name: groupName }],
    customGroupOrder: { g1: ["code:local_aaa"] },
    customGroupAssignments: {},
    collapsedGroups: [],
  };
  return `_file://frame-store\x00{"state":${JSON.stringify(state)}}\n"unreadIds":["code:local_aaa"]\n`;
}

function setup(groupName: string): { ldb: string; sessions: string; logPath: string } {
  root = mkdtempSync(join(tmpdir(), "hx-ccd-"));
  const ldb = join(root, "leveldb");
  const sessions = join(root, "claude-code-sessions");
  mkdirSync(ldb, { recursive: true });
  mkdirSync(join(sessions, "acct", "org"), { recursive: true });
  const logPath = join(ldb, "000003.log");
  writeFileSync(logPath, frameStoreLog(groupName));
  writeFileSync(
    join(sessions, "acct", "org", "local_aaa.json"),
    JSON.stringify({
      sessionId: "local_aaa",
      cliSessionId: "cli-1",
      title: "T",
      titleSource: "user",
      isArchived: false,
      lastActivityAt: 1,
    }),
  );
  setCcdLeveldbDirForTests(ldb);
  setCcdSessionsDirForTests(sessions);
  return { ldb, sessions, logPath };
}

afterEach(() => {
  setCcdLeveldbDirForTests(null);
  setCcdSessionsDirForTests(null);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("buildGroupMirror fingerprint gate", () => {
  it("scans on first build and resolves groups + unread ids to cli ids", async () => {
    setup("Alpha");
    const blob = await buildGroupMirror(1000);
    assert.equal(blob.groupingEnabled, true);
    assert.equal(blob.groups[0]!.name, "Alpha");
    assert.deepEqual(blob.groups[0]!.sessionIds, ["cli-1"]);
    assert.deepEqual(blob.unreadIds, ["cli-1"]);
    assert.equal(blob.syncedAtMs, 1000);
  });

  it("returns the cached blob (no re-read) while both fingerprints are unchanged", async () => {
    const { logPath } = setup("Alpha");
    const first = await buildGroupMirror(1000);
    assert.equal(first.groups[0]!.name, "Alpha");

    // Same-size, same-mtime content swap: only an actual re-read could see
    // "Bravo". Pad to identical byte length, restore mtime exactly.
    const old = frameStoreLog("Alpha");
    const swapped = frameStoreLog("Bravo");
    assert.equal(old.length, swapped.length, "fixture names must be same length");
    writeFileSync(logPath, swapped);
    utimesSync(logPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const fpPin = await buildGroupMirror(2000); // mtime changed by the swap-write? we pinned it above
    // The pinned mtime DIFFERS from the original write's mtime, so this build
    // legitimately re-scans and sees Bravo. Now pin a second, identical stat
    // state and verify the NEXT build is served from cache.
    assert.equal(fpPin.groups[0]!.name, "Bravo");
    writeFileSync(logPath, frameStoreLog("Alpha"));
    utimesSync(logPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const cached = await buildGroupMirror(3000);
    assert.equal(cached.groups[0]!.name, "Bravo", "unchanged fingerprint served the cached blob");
    assert.equal(cached.syncedAtMs, 3000, "syncedAtMs restamped on the cached blob");
  });

  it("a session-file rewrite (dir mtime unchanged) re-resolves the cli mapping", async () => {
    const { sessions } = setup("Alpha");
    await buildGroupMirror(1000);
    writeFileSync(
      join(sessions, "acct", "org", "local_aaa.json"),
      JSON.stringify({
        sessionId: "local_aaa",
        cliSessionId: "cli-2",
        title: "T2",
        titleSource: "user",
        isArchived: false,
        lastActivityAt: 2,
      }),
    );
    // Session fingerprint stats FILES, so the rewrite is visible even though
    // the org dir's mtime did not move. TTL is 10 s — pass a nowMs beyond it.
    const blob = await buildGroupMirror(20_000);
    assert.deepEqual(blob.groups[0]!.sessionIds, ["cli-2"]);
  });

  it("no custom grouping caches the disabled-empty blob too", async () => {
    const { logPath } = setup("Alpha");
    writeFileSync(logPath, `nothing interesting "unreadIds":["code:local_aaa"]`);
    const first = await buildGroupMirror(1000);
    assert.equal(first.groupingEnabled, false);
    assert.deepEqual(first.unreadIds, ["local_aaa"], "disabled path strips but does not cli-map");
    const second = await buildGroupMirror(2000);
    assert.equal(second.groupingEnabled, false);
    assert.equal(second.syncedAtMs, 2000);
  });
});

describe("readCcdRecentsCached", () => {
  it("shares one read across concurrent callers and honors the fingerprint", async () => {
    setup("Alpha");
    const [a, b] = await Promise.all([readCcdRecentsCached(50_000), readCcdRecentsCached(50_000)]);
    assert.equal(a, b, "single-flight: both callers got the same records array");
    assert.equal(a[0]!.cliSessionId, "cli-1");
    const later = await readCcdRecentsCached(70_000); // TTL expired, store unchanged
    assert.equal(later, a, "unchanged fingerprint kept the cached records identity");
  });
});

describe("mirror rebuild inside the records TTL", () => {
  it("a rebuild triggered by a session-file change sees the NEW mapping even when the records cache is TTL-fresh", async () => {
    const { sessions } = setup("Alpha");
    // Prime the records cache (the ingest path does this constantly).
    const primed = await readCcdRecentsCached(1_000);
    assert.equal(primed[0]!.cliSessionId, "cli-1");

    // CCD rewrites the metadata 1s later — cliSessionId changes on disk.
    writeFileSync(
      join(sessions, "acct", "org", "local_aaa.json"),
      JSON.stringify({
        sessionId: "local_aaa",
        cliSessionId: "cli-CHANGED",
        title: "T",
        titleSource: "user",
        isArchived: false,
        lastActivityAt: 2,
      }),
    );

    // Mirror cycle 3s later — WITHIN the 10s records TTL of the prime. The
    // session fingerprint moved, so the rebuild must NOT accept the stale
    // TTL-cached records (it would otherwise cache the stale blob under the
    // FRESH fingerprint — permanently wrong until the store changes again).
    const blob = await buildGroupMirror(4_000);
    assert.deepEqual(blob.groups[0]!.sessionIds, ["cli-CHANGED"], "fresh mapping despite TTL-fresh cache");

    const again = await buildGroupMirror(6_000);
    assert.deepEqual(again.groups[0]!.sessionIds, ["cli-CHANGED"], "and it stays correct");
  });
});
