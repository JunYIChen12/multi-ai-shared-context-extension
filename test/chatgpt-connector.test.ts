import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createChatGptAdapter,
  discussionPath,
  isChatGptUrl,
  readChatGptTabId,
  type ChatGptTransport,
} from "../src/extension/chatgpt-connector.js";
import type { ProviderRequest } from "../src/core/types.js";

const request: ProviderRequest = {
  sessionId: "session-1",
  round: 1,
  phase: "independent",
  userPrompt: "只回复 CHATGPT_LIVE_OK",
  injection: [],
};

function transport(result: unknown): ChatGptTransport {
  return {
    async send() {
      return result;
    },
  };
}

describe("ChatGPT 连接器协议", () => {
  it("只接受 chatgpt.com HTTPS 页面和正整数 tab ID", () => {
    assert.equal(isChatGptUrl("https://chatgpt.com/"), true);
    assert.equal(isChatGptUrl("https://chatgpt.com/c/abc"), true);
    assert.equal(isChatGptUrl("http://chatgpt.com/"), false);
    assert.equal(isChatGptUrl("https://evil.example/?next=https://chatgpt.com/"), false);
    assert.equal(isChatGptUrl(undefined), false);

    assert.equal(discussionPath(42), "discussion.html?chatgptTab=42");
    assert.equal(readChatGptTabId("?chatgptTab=42"), 42);
    assert.equal(readChatGptTabId("?chatgptTab=0"), null);
    assert.equal(readChatGptTabId("?chatgptTab=4.2"), null);
    assert.equal(readChatGptTabId("?chatgptTab=not-a-number"), null);
  });

  it("把结构合法的页面结果映射成 live 响应", async () => {
    const success = await createChatGptAdapter(
      transport({ ok: true, body: "CHATGPT_LIVE_OK" }),
    ).respond(request);
    assert.deepEqual(success, {
      mode: "live",
      status: "complete",
      body: "CHATGPT_LIVE_OK",
    });

    const failed = await createChatGptAdapter(
      transport({ ok: false, code: "completion_timeout", message: "等待 ChatGPT 完成超时" }),
    ).respond(request);
    assert.deepEqual(failed, {
      mode: "live",
      status: "failed",
      body: "",
      error: { code: "completion_timeout", message: "等待 ChatGPT 完成超时" },
    });
  });

  it("拒绝畸形响应，并把消息通道断开记录为失败", async () => {
    const malformed = await createChatGptAdapter(
      transport({ ok: true, body: "" }),
    ).respond(request);
    assert.equal(malformed.status, "failed");
    assert.equal(malformed.error?.code, "invalid_response");

    const disconnected = await createChatGptAdapter({
      async send() {
        throw new Error("Receiving end does not exist");
      },
    }).respond(request);
    assert.equal(disconnected.status, "failed");
    assert.equal(disconnected.error?.code, "connection_lost");
    assert.equal(disconnected.body, "");
  });

  it("本轮不允许 live 适配器执行第二轮交叉讨论", async () => {
    const response = await createChatGptAdapter(
      transport({ ok: true, body: "不应作为第二轮结果" }),
    ).respond({ ...request, phase: "cross_review", round: 2 });
    assert.equal(response.status, "failed");
    assert.equal(response.error?.code, "unsupported_phase");
  });
});
