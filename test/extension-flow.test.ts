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

describe("扩展单标签页链路", () => {
  it("把 ChatGPT 当前标签页结果写入本地导出且不泄露 tab ID", async () => {
    const sent: Array<{ tabId: number; request: ChatGptAskRequest }> = [];
    const adapter = createChatGptAdapter(
      createChatGptTabTransport(42, {
        async sendToTab(tabId, request) {
          sent.push({ tabId, request });
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
    assert.deepEqual(sent, [
      {
        tabId: 42,
        request: { channel: CHATGPT_CHANNEL, type: "ask", prompt: "只回复 CHATGPT_LIVE_OK" },
      },
    ]);
    assert.equal(ran.session.messages.at(-1)?.sourceKind, "provider");
    assert.equal(ran.session.messages.at(-1)?.body, "CHATGPT_LIVE_OK");

    const exported = exportSession(ran.session);
    assert.match(exported.markdown, /CHATGPT_LIVE_OK/);
    assert.match(exported.jsonl, /CHATGPT_LIVE_OK/);
    assert.doesNotMatch(exported.markdown, /chatgptTab|tabId/);
    assert.doesNotMatch(exported.jsonl, /chatgptTab|tabId/);
  });
});
