import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { ccdAppDir } from "./ccd.js";

describe("ccdAppDir", () => {
  it("finds Claude Desktop under Application Support on macOS", () => {
    assert.equal(
      ccdAppDir("darwin", {}, "/Users/me"),
      "/Users/me/Library/Application Support/Claude",
    );
  });

  it("finds it under %APPDATA% on Windows", () => {
    assert.equal(
      ccdAppDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"),
      "C:\\Users\\me\\AppData\\Roaming\\Claude",
    );
  });

  it("falls back to the canonical Roaming path when APPDATA is unset", () => {
    // A context that never loaded the user's environment still resolves.
    assert.equal(
      ccdAppDir("win32", {}, "C:\\Users\\me"),
      "C:\\Users\\me\\AppData\\Roaming\\Claude",
    );
  });

  it("returns null where Claude Desktop does not ship", () => {
    // Readers degrade to an empty result rather than scanning a path that
    // cannot exist — the mirror is simply absent, not broken.
    assert.equal(ccdAppDir("linux", {}, "/home/me"), null);
  });
});
