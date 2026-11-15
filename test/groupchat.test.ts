import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import {
  appendGroupChatMessage,
  cancelQueuedGroupChatRequests,
  createGroupChatSession,
  resumeGroupChatProvider,
  runGroupChatQueues,
} from "../src/core/groupchat.js";
import { exportSession, parseSessionJsonl } from "../src/core/persist.js";
import type { ProviderAdapter, ProviderRequest } from "../src/core/types.js";

function adapter(
  id: "chatgpt" | "gemini",
  calls: ProviderRequest[],
  respond: (request: ProviderRequest) => Promise<{ mode: "live"; status: "complete" | "failed"; body: string; error?: { code: string; message: string } }>,
): ProviderAdapter {
  return {
    id,
    mode: "live",
    async respond(request) {
      calls.push(request);
      return respond(request);
    },
  };
}

const testClock = createTestClock();

function append(session: Parameters<typeof appendGroupChatMessage>[0], body: string, targets: ("chatgpt" | "gemini")[]) {
  const result = appendGroupChatMessage(session, body, targets, testClock);
  if (result.ok !== true) throw new Error("append failed");
  return result.session;
}

describe("群聊核心调度", () => {
  it("没有点名只留本地，双点名使用同一发送快照且不互相注入本轮新答", async () => {
    const calls: ProviderRequest[] = [];
    const chatgpt = adapter("chatgpt", calls, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { mode: "live", status: "complete", body: "CHATGPT_REPLY" };
    });
    const gemini = adapter("gemini", calls, async () => ({ mode: "live", status: "complete", body: "GEMINI_REPLY" }));
    let session = createGroupChatSession("群聊测试", createTestClock());
    session = append(session, "只记本地", []);
    session = append(session, "同时请两家回答", ["chatgpt", "gemini"]);

    const result = await runGroupChatQueues(session, {
      clock: createTestClock(),
      adapters: [chatgpt, gemini],
      timeoutMs: 1000,
      timeoutMsByProvider: { chatgpt: 1000, gemini: 1000 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.meetingContext), [[], []]);
    assert.equal(result.session.messages.find((message) => message.body === "只记本地")?.shared, false);
    assert.equal(result.session.messages.filter((message) => message.role === "assistant").length, 2);
  });

  it("每家按序运行，失败只暂停该家；显式恢复不重发失败条目", async () => {
    const chatCalls: ProviderRequest[] = [];
    const geminiCalls: ProviderRequest[] = [];
    let chatRound = 0;
    const chatgpt = adapter("chatgpt", chatCalls, async () => {
      chatRound += 1;
      return chatRound === 1
        ? { mode: "live", status: "failed", body: "", error: { code: "unknown", message: "结果未知" } }
        : { mode: "live", status: "complete", body: "CHATGPT_SECOND" };
    });
    const gemini = adapter("gemini", geminiCalls, async (request) => ({
      mode: "live",
      status: "complete",
      body: `GEMINI_${request.round}`,
    }));
    let session = createGroupChatSession("群聊队列", createTestClock());
    session = append(session, "第一条", ["chatgpt", "gemini"]);
    session = append(session, "第二条", ["chatgpt", "gemini"]);
    const options = { clock: createTestClock(), adapters: [chatgpt, gemini], timeoutMs: 1000 };

    const first = await runGroupChatQueues(session, options);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    session = first.session;
    assert.equal(chatCalls.length, 1);
    assert.equal(geminiCalls.length, 2);
    assert.deepEqual(session.groupChatPausedProviders, ["chatgpt"]);
    assert.equal(session.groupChatRequests?.filter((request) => request.providerId === "chatgpt" && request.status === "queued").length, 1);

    const resumed = resumeGroupChatProvider(session, "chatgpt");
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    const second = await runGroupChatQueues(resumed.session, options);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(chatCalls.length, 2);
    assert.equal(chatCalls[1]?.userPrompt, "第二条");
    assert.equal(chatCalls[1]?.meetingContext?.some((item) => item.body === "第一条"), false);
    assert.equal(second.session.groupChatRequests?.filter((request) => request.providerId === "chatgpt" && request.status === "complete").length, 1);
    assert.equal(second.session.groupChatRequests?.some((request) => request.providerId === "chatgpt" && request.status === "unknown"), true);
  });

  it("导出保留点名、共享范围和请求结果，导入记录不能续发", async () => {
    const chatCalls: ProviderRequest[] = [];
    const chatgpt = adapter("chatgpt", chatCalls, async () => ({ mode: "live", status: "complete", body: "CHATGPT_OK" }));
    let session = createGroupChatSession("导出", createTestClock());
    session = append(session, "只留本地", []);
    session = append(session, "只给 ChatGPT", ["chatgpt"]);
    const ran = await runGroupChatQueues(session, { clock: createTestClock(), adapters: [chatgpt], timeoutMs: 1000 });
    assert.equal(ran.ok, true);
    if (!ran.ok) return;
    const exported = exportSession(ran.session);
    assert.match(exported.markdown, /AI 群聊/);
    assert.match(exported.markdown, /只给 ChatGPT/);
    assert.match(exported.markdown, /群聊请求结果/);
    const parsed = parseSessionJsonl(exported.jsonl);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.session.messages.find((message) => message.body === "只留本地")?.shared, false);
    assert.deepEqual(parsed.session.messages.find((message) => message.body === "只给 ChatGPT")?.targetProviders, ["chatgpt"]);
    assert.equal(parsed.session.groupChatRequests?.[0]?.status, "complete");
    const blocked = await runGroupChatQueues(parsed.session, { clock: createTestClock(), adapters: [chatgpt], timeoutMs: 1000 });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "unverified_session");
    assert.equal(chatCalls.length, 1);
  });

  it("取消只标记尚未执行请求，失败和未知不会被重发", async () => {
    let session = createGroupChatSession("取消", createTestClock());
    session = append(session, "待取消", ["chatgpt", "gemini"]);
    const cancelled = cancelQueuedGroupChatRequests(session, "gemini");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.session.groupChatRequests?.find((request) => request.providerId === "gemini")?.status, "cancelled");
    assert.equal(cancelled.session.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.status, "queued");
  });
});
