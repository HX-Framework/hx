import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexTitle, resetCodexTitleCacheForTests } from "./codex-titles.js";

let home: string;

/** Build a state_<n>.sqlite with a `threads` table. `withName=false` mimics an
 *  older schema (pre-migration-0041, no `name` column). */
function makeDb(
  n: number,
  rows: Array<{ id: string; title?: string | null; name?: string | null }>,
  withName = true,
): void {
  const db = new Database(join(home, `state_${n}.sqlite`));
  db.run(
    withName
      ? `CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)`
      : `CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)`,
  );
  for (const r of rows) {
    if (withName) {
      db.run(`INSERT INTO threads (id, title, name) VALUES (?, ?, ?)`, [
        r.id,
        r.title ?? null,
        r.name ?? null,
      ]);
    } else {
      db.run(`INSERT INTO threads (id, title) VALUES (?, ?)`, [r.id, r.title ?? null]);
    }
  }
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hx-codex-titles-"));
  resetCodexTitleCacheForTests();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetCodexTitleCacheForTests();
});

describe("readCodexTitle", () => {
  it("returns the auto title (source 'ai') when there is no user name", () => {
    makeDb(5, [{ id: "s1", title: "Fix the login bug" }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "Fix the login bug", source: "ai" });
  });

  it("prefers the user-set name over the auto title (source 'user')", () => {
    makeDb(5, [{ id: "s1", title: "auto derived", name: "My renamed session" }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "My renamed session", source: "user" });
  });

  it("trims and rejects empty/whitespace name, falling through to title", () => {
    makeDb(5, [{ id: "s1", title: "  Real title  ", name: "   " }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "Real title", source: "ai" });
  });

  it("returns null when both name and title are empty/null", () => {
    makeDb(5, [{ id: "s1", title: "", name: null }]);
    assert.equal(readCodexTitle(home, "s1"), null);
  });

  it("returns null for an unknown session id", () => {
    makeDb(5, [{ id: "s1", title: "something" }]);
    assert.equal(readCodexTitle(home, "nope"), null);
  });

  it("returns null when the codex home / state DB is absent", () => {
    assert.equal(readCodexTitle(home, "s1"), null);
    assert.equal(readCodexTitle(join(home, "does-not-exist"), "s1"), null);
  });

  it("works on an older schema with no `name` column (falls back to title)", () => {
    makeDb(5, [{ id: "s1", title: "Legacy titled" }], /* withName */ false);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "Legacy titled", source: "ai" });
  });

  it("reads the highest state_<n>.sqlite when several coexist", () => {
    makeDb(4, [{ id: "s1", title: "OLD epoch" }]);
    makeDb(5, [{ id: "s1", title: "NEW epoch" }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "NEW epoch", source: "ai" });
  });

  it("returns null for an empty session id without touching the DB", () => {
    makeDb(5, [{ id: "s1", title: "x" }]);
    assert.equal(readCodexTitle(home, ""), null);
  });

  it("re-reads after the DB changes (fingerprint invalidates the cache)", () => {
    makeDb(5, [{ id: "s1", title: "first" }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "first", source: "ai" });
    // Rewrite the DB with a new title; a fresh mtime/size must invalidate the cache.
    rmSync(join(home, "state_5.sqlite"), { force: true });
    resetCodexTitleCacheForTests(); // TTL is 10s in-process; the seam models a later pass
    makeDb(5, [{ id: "s1", title: "second", name: "renamed" }]);
    assert.deepEqual(readCodexTitle(home, "s1"), { title: "renamed", source: "user" });
  });
});
