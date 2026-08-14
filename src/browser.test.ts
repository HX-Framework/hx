import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { browserCommandFor } from "./browser.js";

const has = (available: string[]) => (cmd: string) => available.includes(cmd);

describe("browserCommandFor", () => {
  it("uses open on macOS", () => {
    assert.deepEqual(browserCommandFor("darwin", false, has([])), ["open", []]);
  });

  it("uses explorer on Windows", () => {
    assert.deepEqual(browserCommandFor("win32", false, has([])), ["explorer", []]);
  });

  it("uses xdg-open on plain Linux", () => {
    assert.deepEqual(browserCommandFor("linux", false, has([])), ["xdg-open", []]);
  });

  it("prefers wslview under WSL when installed", () => {
    assert.deepEqual(browserCommandFor("linux", true, has(["wslview"])), ["wslview", []]);
  });

  it("falls back to explorer.exe under WSL without wslview", () => {
    assert.deepEqual(browserCommandFor("linux", true, has([])), ["explorer.exe", []]);
  });
});
