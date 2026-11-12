import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEMINI_CHANNEL,
  connectActiveGeminiTab,
  createGeminiAdapter,
  createGeminiTabTransport,
  isGeminiUrl,
  readGeminiTabId,
  type GeminiTabMessage,
} from "../src/extension/gemini-connector.js";
import type { ProviderRequest } from "../src/core/types.js";
import { runGeminiTurn } from "../src/extension/gemini-turn.js";

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

  it("拒绝错误标签页 ID 和重复的讨论页参数，不注入页面", async () => {
    assert.equal(isGeminiUrl("https://gemini.google.com.attacker.test/app"), false);
    assert.equal(readGeminiTabId("?geminiTab=42&geminiTab=43"), null);
    const injected: number[] = [];
    const result = await connectActiveGeminiTab({
      async getActiveTab() { return { id: Number.MAX_SAFE_INTEGER + 1, url: "https://gemini.google.com/app" }; },
      async injectScript(id) { injected.push(id); },
      async openDiscussion() {},
    });
    assert.deepEqual(result, { ok: false, code: "no_active_tab", message: "没有可连接的当前标签页" });
    assert.deepEqual(injected, []);
    assert.throws(() => createGeminiTabTransport(0, { async sendToTab() {} }), /tab ID/);
  });

  it("用独立消息通道单发一条第一轮请求，且失败/取消不带成功正文", async () => {
    const request = providerRequest();
    const sent: GeminiTabMessage[] = [];
    let resolveAsk: ((value: unknown) => void) | undefined;
    const adapter = createGeminiAdapter(createGeminiTabTransport(42, {
      sendToTab(_tabId, message) {
        sent.push(message);
        if (message.type === "ask") {
          return new Promise((resolve) => { resolveAsk = resolve; });
        }
        return Promise.resolve({ ok: true });
      },
    }));
    const controller = new AbortController();
    const pending = adapter.respond(request, { signal: controller.signal });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.channel, GEMINI_CHANNEL);
    assert.equal(sent[0]?.type, "ask");
    if (sent[0]?.type === "ask") {
      assert.match(sent[0].requestId, /^[0-9a-f-]{36}$/);
      assert.equal(sent[0].prompt, `只回复 GEMINI_LIVE_OK\n\n[本次校验: ${sent[0].requestId}]`);
    }
    controller.abort();
    resolveAsk?.({ ok: true, body: "GEMINI_LIVE_OK" });
    const response = await pending;
    assert.deepEqual(response, {
      mode: "live",
      status: "cancelled",
      body: "",
      error: { code: "cancelled", message: "采集已取消，不会再发送或提交结果" },
    });
    assert.deepEqual(sent.map((message) => message.type), ["ask", "cancel"]);
    assert.equal(sent.filter((message) => message.type === "ask").length, 1);
    assert.equal(sent[1]?.requestId, sent[0]?.requestId);
    assert.equal(request.userPrompt, "只回复 GEMINI_LIVE_OK");
  });

  it("附标记后超过长度上限时不触碰网页输入框", async () => {
    const request = { ...providerRequest(), userPrompt: "甲".repeat(20_000) };
    let read = false;
    const adapter = createGeminiAdapter({
      send: (message) => runGeminiTurn({
        read() { read = true; throw new Error("should not inspect page"); },
        readPrompt() { throw new Error("should not read composer"); },
        writePrompt() { throw new Error("should not write composer"); },
        submit() { throw new Error("should not send"); },
        watchStop() { return () => undefined; },
      }, message.prompt),
    });
    const result = await adapter.respond(request);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "invalid_request");
    assert.equal(read, false);
    assert.equal(request.userPrompt.length, 20_000);
  });

  it("把有效页面回复映射到 live/complete，把页面失败留作 failed", async () => {
    const success = createGeminiAdapter({ async send() { return { ok: true, body: "GEMINI_LIVE_OK" }; } });
    assert.deepEqual(await success.respond(providerRequest()), {
      mode: "live", status: "complete", body: "GEMINI_LIVE_OK",
    });
    const failure = createGeminiAdapter({ async send() {
      return { ok: false, code: "page_error", message: "Gemini 页面报告错误" };
    } });
    assert.deepEqual(await failure.respond(providerRequest()), {
      mode: "live", status: "failed", body: "",
      error: { code: "page_error", message: "Gemini 页面报告错误" },
    });
    const timeout = createGeminiAdapter({ async send() {
      return { ok: false, code: "timeout", message: "等待 Gemini 超时" };
    } });
    assert.equal((await timeout.respond(providerRequest())).status, "timeout");
  });
});

function providerRequest(phase: ProviderRequest["phase"] = "independent"): ProviderRequest {
  return { sessionId: "session-1", round: 1, phase, userPrompt: "只回复 GEMINI_LIVE_OK", injection: [] };
}
