import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { summariseChunk } from "./parse.js";

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

describe("summariseChunk", () => {
  it("counts events and keeps the first/last user text and last assistant text", () => {
    const text =
      line({ type: "user", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "first question" }] } }) +
      line({ type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] } }) +
      line({ type: "user", timestamp: "t3", message: { role: "user", content: [{ type: "tool_result", content: "ignored" }] } }) +
      line({ type: "user", timestamp: "t4", message: { role: "user", content: [{ type: "text", text: "second question" }] } });
    const s = summariseChunk(text);
    assert.equal(s.eventCount, 4);
    assert.equal(s.userTextCount, 3);
    assert.equal(s.assistantCount, 1);
    assert.equal(s.firstUserText, "first question");
    assert.equal(s.lastUserText, "second question");
    assert.equal(s.lastAssistantText, "an answer");
    assert.equal(s.lastActivityAt, "t4");
  });

  it("caps excerpts at 4 KB and copies them out of a multi-MB message", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    const text = line({ type: "user", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: huge }] } });
    const s = summariseChunk(text);
    assert.ok(s.lastUserText!.length <= 4000 + 3, "excerpt bounded");
    assert.ok(s.lastUserText!.startsWith("xxxx") && s.lastUserText!.endsWith("…"));
    // The excerpt owns its storage: it survives the source being dropped and
    // is a plain string, not a view (the only observable is equality).
    assert.equal(s.lastUserText, `${huge.slice(0, 4000)}\n\n…`);
  });

  it("prefers a user-set CCD title over an AI one and skips unparsable lines", () => {
    const text =
      "not json\n" +
      line({ type: "ai-title", aiTitle: "Generated" }) +
      line({ type: "custom-title", customTitle: "  Mine  " });
    const s = summariseChunk(text);
    assert.equal(s.title, "Mine");
    assert.equal(s.titleSource, "user");
    assert.equal(s.eventCount, 2);
  });
});
