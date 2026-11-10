import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("Gemini 单标签页连接", () => {
  it("只接受 HTTPS Gemini 页面，并在用户连接时注入当前标签页", async () => {
    const { isGeminiUrl, connectActiveGeminiTab, readGeminiTabId } =
      await import("../src/extension/gemini-connector.js");
    assert.equal(isGeminiUrl("https://gemini.google.com/app"), true);
    assert.equal(isGeminiUrl("https://gemini.google.com/app/abc"), true);
    assert.equal(isGeminiUrl("http://gemini.google.com/app"), false);
    assert.equal(isGeminiUrl("https://evil.example/?next=https://gemini.google.com/app"), false);
    assert.equal(readGeminiTabId("?geminiTab=0"), null);
    assert.equal(readGeminiTabId("?geminiTab=42"), 42);
    const injected: string[] = [];
    const opened: string[] = [];
    const result = await connectActiveGeminiTab({
      async getActiveTab() { return { id: 42, url: "https://gemini.google.com/app" }; },
      async injectScript(id, file) { injected.push(`${id}:${file}`); },
      async openDiscussion(path) { opened.push(path); },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(injected, ["42:gemini-content.js"]);
    assert.deepEqual(opened, ["discussion.html?geminiTab=42"]);
  });
});
