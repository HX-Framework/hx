import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { collapseHome, isPathPrefix, pathKey, samePath } from "./pathnorm.js";

// Platform is a defaulted parameter throughout, so win32/darwin semantics are
// exercised here from Linux CI — no Windows runner needed for these.
const WIN = "win32";
const MAC = "darwin";
const LINUX = "linux";

describe("pathKey", () => {
  it("is the identity on linux — no behavior change on the platform we ship today", () => {
    assert.equal(pathKey("/home/me/Work", LINUX), "/home/me/Work");
    // A backslash is a legal POSIX filename character; folding it would point
    // at a different file entirely.
    assert.equal(pathKey("/home/me/a\\b", LINUX), "/home/me/a\\b");
  });

  it("folds separators and case on win32", () => {
    assert.equal(pathKey("C:\\Users\\Me\\Proj", WIN), "c:/users/me/proj");
    assert.equal(pathKey("C:/Users/Me/Proj", WIN), "c:/users/me/proj");
  });

  it("folds case but not separators on darwin", () => {
    assert.equal(pathKey("/Users/Me/Work", MAC), "/users/me/work");
    assert.equal(pathKey("/Users/Me/a\\b", MAC), "/users/me/a\\b");
  });
});

describe("samePath", () => {
  it("treats the two drive-letter casings Claude Code emits as one folder", () => {
    // Real observation: a single Windows machine produced project dirs
    // `C--Users-Mr-Fi` and `c--Users-Mr-Fi-Desktop-...` on the same volume.
    assert.equal(samePath("C:\\Users\\Me", "c:\\Users\\Me", WIN), true);
    assert.equal(samePath("C:\\Users\\Me", "C:/Users/Me/", WIN), true);
  });

  it("keeps case significant on linux", () => {
    assert.equal(samePath("/home/me/Work", "/home/me/work", LINUX), false);
  });
});

describe("isPathPrefix", () => {
  it("matches a Windows child against a Windows parent", () => {
    assert.equal(isPathPrefix("C:\\Users\\Me", "C:\\Users\\Me\\proj", WIN), true);
    assert.equal(isPathPrefix("~\\Desktop", "~\\Desktop\\app", WIN), true);
  });

  it("respects segment boundaries", () => {
    assert.equal(isPathPrefix("~/a", "~/ab", LINUX), false);
    assert.equal(isPathPrefix("C:\\Users\\Me", "C:\\Users\\Median", WIN), false);
  });

  it("matches the parent itself, with or without a trailing separator", () => {
    assert.equal(isPathPrefix("~/a", "~/a", LINUX), true);
    assert.equal(isPathPrefix("~/a/", "~/a", LINUX), true);
  });

  it("treats an empty or root-only parent as a no-op, never as match-everything", () => {
    assert.equal(isPathPrefix("", "~/anything", LINUX), false);
    assert.equal(isPathPrefix("/", "/anything", LINUX), false);
  });
});

describe("collapseHome", () => {
  it("collapses a Windows home regardless of drive-letter case", () => {
    assert.equal(collapseHome("C:\\Users\\Me\\Desktop", "C:\\Users\\Me", WIN), "~\\Desktop");
    assert.equal(collapseHome("c:\\Users\\Me\\Desktop", "C:\\Users\\Me", WIN), "~\\Desktop");
  });

  it("preserves the original spelling after the home prefix", () => {
    assert.equal(collapseHome("/home/me/MyApp", "/home/me", LINUX), "~/MyApp");
  });

  it("does not collapse a sibling home that merely shares a prefix", () => {
    // The old `startsWith` rendered this as "~by" for the user `bob`.
    assert.equal(collapseHome("/home/bobby/x", "/home/bob", LINUX), "/home/bobby/x");
  });

  it("leaves an unrelated path alone", () => {
    assert.equal(collapseHome("/opt/data", "/home/me", LINUX), "/opt/data");
  });
});
