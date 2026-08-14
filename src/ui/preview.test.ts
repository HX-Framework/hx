import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { extractPreviewLines, extractTitleFallback } from "./preview.js";

describe("extractTitleFallback", () => {
  it("takes the first user message, clipped", () => {
    const title = extractTitleFallback([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "user", message: { content: "please fix the flaky test in ci and make it pass reliably every time" } }),
    ]);
    assert.equal(title, "please fix the flaky test in ci and make it pass reliably every…");
  });

  it("returns null when no user text exists", () => {
    assert.equal(extractTitleFallback([JSON.stringify({ type: "progress" })]), null);
  });

  it("skips harness-injected caveat/tag user events", () => {
    const title = extractTitleFallback([
      JSON.stringify({ type: "user", message: { content: "<local-command-caveat>stuff</local-command-caveat>" } }),
      JSON.stringify({ type: "user", message: { content: "Caveat: the messages below…" } }),
      JSON.stringify({ type: "user", message: { content: "real question" } }),
    ]);
    assert.equal(title, "real question");
  });
});

describe("extractPreviewLines", () => {
  it("maps Claude user/assistant/tool events", () => {
    const lines = extractPreviewLines([
      JSON.stringify({ type: "user", message: { content: "fix the bug" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Reading the file…" }, { type: "tool_use", name: "read_file" }] },
      }),
      JSON.stringify({ type: "progress", data: 1 }),
    ]);
    assert.deepEqual(lines, [
      { role: "Me", text: "fix the bug" },
      { role: "Agent", text: "Reading the file…" },
      { role: "Tool", text: "read_file" },
    ]);
  });

  it("maps Codex response items", () => {
    const lines = extractPreviewLines([
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run tests" }] },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
    ]);
    assert.deepEqual(lines, [
      { role: "Me", text: "run tests" },
      { role: "Tool", text: "shell" },
    ]);
  });

  it("survives torn/garbage lines and clips long text", () => {
    const long = "x".repeat(500);
    const lines = extractPreviewLines([
      "{not json",
      "",
      JSON.stringify({ type: "user", message: { content: long } }),
    ]);
    assert.equal(lines.length, 1);
    assert.ok((lines[0]?.text.length ?? 0) <= 220);
    assert.ok(lines[0]?.text.endsWith("…"));
  });

  it("keeps only the last 12 lines", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: `msg ${i}` } }),
    );
    const lines = extractPreviewLines(many);
    assert.equal(lines.length, 12);
    assert.equal(lines[11]?.text, "msg 29");
  });
});
