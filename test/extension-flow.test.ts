import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import { createSession, runIndependentRound } from "../src/core/orchestrate.js";
import { exportSession } from "../src/core/persist.js";
import {
  CHATGPT_CHANNEL,
  createChatGptAdapter,
  createChatGptTabTransport,
  type ChatGptAskRequest,
} from "../src/extension/chatgpt-connector.js";
import {
  GEMINI_CHANNEL,
  createGeminiAdapter,
  createGeminiTabTransport,
  type GeminiTabMessage,
} from "../src/extension/gemini-connector.js";
import type { ProviderRequest } from "../src/core/types.js";

describe("扩展单标签页链路", () => {
  it("把 ChatGPT 当前标签页结果写入本地导出且不泄露 tab ID", async () => {
    const sent: Array<{ tabId: number; request: ChatGptAskRequest }> = [];
    const adapter = createChatGptAdapter(
      createChatGptTabTransport(42, {
        async sendToTab(tabId, request) {
          if (request.type === "ask") {
            sent.push({ tabId, request });
          }
          return { ok: true, body: "CHATGPT_LIVE_OK" };
        },
      }),
    );
    const options = { clock: createTestClock(), adapters: [adapter], timeoutMs: 1000, maxRounds: 2 };
    const created = createSession("只回复 CHATGPT_LIVE_OK", options);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const ran = await runIndependentRound(created.session, options);
    assert.equal(ran.ok, true);
    if (!ran.ok) return;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.tabId, 42);
    assert.equal(sent[0]?.request.channel, CHATGPT_CHANNEL);
    assert.equal(sent[0]?.request.type, "ask");
    assert.equal(sent[0]?.request.prompt, "只回复 CHATGPT_LIVE_OK");
    assert.equal(typeof sent[0]?.request.requestId, "string");
    assert.equal((sent[0]?.request.requestId.length ?? 0) > 0, true);
    assert.equal(ran.session.messages.at(-1)?.sourceKind, "provider");
    assert.equal(ran.session.messages.at(-1)?.body, "CHATGPT_LIVE_OK");

    const exported = exportSession(ran.session);
    assert.match(exported.markdown, /CHATGPT_LIVE_OK/);
    assert.match(exported.jsonl, /CHATGPT_LIVE_OK/);
    assert.doesNotMatch(exported.markdown, /chatgptTab|tabId/);
    assert.doesNotMatch(exported.jsonl, /chatgptTab|tabId/);
  });

  it("把 Gemini 回复写入统一 provider 会话并原样导出，不泄露标签页标识", async () => {
    const reply = "GEMINI_LIVE_OK\n原样保留";
    const sent: Array<{ tabId: number; request: GeminiTabMessage }> = [];
    const adapter = createGeminiAdapter(createGeminiTabTransport(73, {
      async sendToTab(tabId, request) {
        sent.push({ tabId, request });
        return { ok: true, body: reply };
      },
    }));
    const options = { clock: createTestClock(), adapters: [adapter], timeoutMs: 360_000, maxRounds: 2 };
    const created = createSession("只回复 GEMINI_LIVE_OK", options);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const ran = await runIndependentRound(created.session, options);
    assert.equal(ran.ok, true);
    if (!ran.ok) return;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.tabId, 73);
    assert.equal(sent[0]?.request.channel, GEMINI_CHANNEL);
    assert.equal(ran.session.messages.at(-1)?.sourceKind, "provider");
    assert.equal(ran.session.messages.at(-1)?.providerId, "gemini");
    assert.equal(ran.session.messages.at(-1)?.body, reply);

    const exported = exportSession(ran.session);
    assert.ok(exported.markdown.includes(reply));
    assert.ok(exported.jsonl.includes(JSON.stringify(reply)));
    assert.doesNotMatch(exported.markdown, /geminiTab|tabId|cookie|token/i);
    assert.doesNotMatch(exported.jsonl, /geminiTab|tabId|cookie|token/i);
  });

  it("取消后忽略迟到的 Gemini 成功回复", async () => {
    const controller = new AbortController();
    let resolveAsk: ((value: unknown) => void) | undefined;
    const sent: GeminiTabMessage[] = [];
    const adapter = createGeminiAdapter(createGeminiTabTransport(74, {
      sendToTab(_tabId, request) {
        sent.push(request);
        if (request.type === "cancel") return Promise.resolve({ ok: false, code: "cancelled", message: "cancelled" });
        return new Promise((resolve) => { resolveAsk = resolve; });
      },
    }));
    const pending = adapter.respond(providerRequest(), { signal: controller.signal });
    controller.abort();
    resolveAsk?.({ ok: true, body: "LATE_GEMINI_REPLY" });

    assert.deepEqual(await pending, {
      mode: "live", status: "cancelled", body: "",
      error: { code: "cancelled", message: "采集已取消，不会再发送或提交结果" },
    });
    assert.deepEqual(sent.map((request) => request.type), ["ask", "cancel"]);
  });
});

function providerRequest(): ProviderRequest {
  return {
    sessionId: "session-1",
    round: 1,
    phase: "independent",
    userPrompt: "只回复 GEMINI_LIVE_OK",
    injection: [],
  };
}
