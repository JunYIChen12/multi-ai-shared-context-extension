import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectActiveChatGptTab,
  createChatGptAdapter,
  createChatGptTabTransport,
  discussionPath,
  isChatGptUrl,
  readChatGptTabId,
  type ChatGptAskRequest,
  type ChatGptConnectionPort,
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

function connectionPort(tab: { id?: number; url?: string } | null, injects: string[], opens: string[]): ChatGptConnectionPort {
  return {
    async getActiveTab() {
      return tab;
    },
    async injectScript(tabId, filename) {
      injects.push(`${tabId}:${filename}`);
    },
    async openDiscussion(path) {
      opens.push(path);
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

    const changedPrompt = await createChatGptAdapter(
      transport({ ok: false, code: "prompt_changed", message: "ChatGPT 草稿在发送前发生变化，未发送问题" }),
    ).respond(request);
    assert.equal(changedPrompt.status, "failed");
    assert.equal(changedPrompt.body, "");
    assert.equal(changedPrompt.error?.code, "prompt_changed");
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

  it("圆桌请求只把未投递的署名原话和本轮用户发言放进 ChatGPT 输入", async () => {
    let sentPrompt = "";
    let sentRoundtablePrompt: boolean | undefined;
    const response = await createChatGptAdapter({
      async send(message) {
        sentPrompt = message.prompt;
        sentRoundtablePrompt = message.roundtablePrompt;
        return { ok: true, body: "CHATGPT_ROUND_2_OK" };
      },
    }).respond({
      ...request,
      phase: "roundtable",
      round: 2,
      userPrompt: "请核对边界",
      meetingContext: [
        { messageId: "g1", speakerId: "gemini", round: 1, phase: "roundtable", body: "Gemini 完整原话" },
      ],
    });
    assert.equal(response.status, "complete");
    assert.equal(sentRoundtablePrompt, true);
    assert.equal(sentPrompt, "【Gemini · 第 1 轮完整原话】\nGemini 完整原话\n\n【用户 · 第 2 轮新发言】\n请核对边界");
  });

  it("只把格式器生成的圆桌请求标记为圆桌提示", async () => {
    const asks: ChatGptAskRequest[] = [];
    const adapter = createChatGptAdapter({
      async send(message) {
        asks.push(message);
        return { ok: true, body: "OK" };
      },
    });

    await adapter.respond(request);
    await adapter.respond({ ...request, phase: "roundtable", round: 2, userPrompt: "下一轮" });

    assert.deepEqual(asks.map((ask) => ask.roundtablePrompt), [false, true]);
    assert.equal(asks[0]?.prompt, request.userPrompt);
    assert.equal(asks[1]?.prompt.startsWith("【用户 · 第 2 轮新发言】\n"), true);
  });

  it("完整圆桌内容超限时在发送到标签页前失败，不截断", async () => {
    let sends = 0;
    const response = await createChatGptAdapter({
      async send() {
        sends += 1;
        return { ok: true, body: "不应发送" };
      },
    }).respond({
      ...request,
      phase: "roundtable",
      userPrompt: "U".repeat(20_000),
      meetingContext: [
        { messageId: "g1", speakerId: "gemini", round: 1, phase: "roundtable", body: "Gemini 完整原话" },
      ],
    });
    assert.equal(response.status, "failed");
    assert.equal(response.body, "");
    assert.equal(response.error?.code, "prompt_too_large");
    assert.equal(sends, 0);
  });

  it("只把当前 ChatGPT 标签页临时连接到讨论页", async () => {
    const injects: string[] = [];
    const opens: string[] = [];
    const connected = await connectActiveChatGptTab(
      connectionPort({ id: 42, url: "https://chatgpt.com/c/new" }, injects, opens),
    );
    assert.deepEqual(connected, { ok: true });
    assert.deepEqual(injects, ["42:chatgpt-content.js"]);
    assert.deepEqual(opens, ["discussion.html?chatgptTab=42"]);

    const missing = await connectActiveChatGptTab(connectionPort(null, [], []));
    assert.deepEqual(missing, {
      ok: false,
      code: "no_active_tab",
      message: "没有可连接的当前标签页",
    });

    const wrongSite = await connectActiveChatGptTab(
      connectionPort({ id: 7, url: "https://example.com/" }, [], []),
    );
    assert.deepEqual(wrongSite, {
      ok: false,
      code: "not_chatgpt",
      message: "请先打开并登录 https://chatgpt.com/",
    });
  });

  it("脚本注入失败时不伪装成已连接", async () => {
    const opened: string[] = [];
    const result = await connectActiveChatGptTab({
      async getActiveTab() {
        return { id: 9, url: "https://chatgpt.com/" };
      },
      async injectScript() {
        throw new Error("blocked");
      },
      async openDiscussion(path) {
        opened.push(path);
      },
    });
    assert.deepEqual(result, {
      ok: false,
      code: "connection_failed",
      message: "无法临时连接 ChatGPT 标签页，请重试",
    });
    assert.deepEqual(opened, []);
  });

  it("外层取消只发一次取消，并忽略晚到的成功正文", async () => {
    const sent: Array<{ type: string; requestId?: string }> = [];
    let resolveAsk: (value: unknown) => void = () => undefined;
    let markAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const adapter = createChatGptAdapter(
      createChatGptTabTransport(7, {
        async sendToTab(_tabId, message) {
          sent.push(message);
          if (message.type === "ask") {
            markAsked();
            return new Promise((resolve) => {
              resolveAsk = resolve;
            });
          }
          return { ok: true };
        },
      }),
    );
    const controller = new AbortController();
    const pending = adapter.respond(request, { signal: controller.signal });
    await asked;
    controller.abort();
    const response = await pending;
    resolveAsk({ ok: true, body: "LATE" });
    await Promise.resolve();
    assert.equal(response.status, "cancelled");
    assert.equal(response.body, "");
    assert.equal(sent.filter((item) => item.type === "ask").length, 1);
    assert.equal(sent.filter((item) => item.type === "cancel").length, 1);
    assert.equal(sent[0]?.requestId, sent[1]?.requestId);
  });
});
