import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import {
  appendGroupChatMessage,
  beginGroupChatProviderQueue,
  cancelQueuedGroupChatRequests,
  createGroupChatSession,
  mergeGroupChatExecution,
  resumeGroupChatProvider,
  runGroupChatProviderQueue,
  runGroupChatQueues,
} from "../src/core/groupchat.js";
import { outcomeHeadline } from "../src/core/labels.js";
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
  it("两家队列可以独立完成，不互相等待", async () => {
    let releaseChatGpt!: () => void;
    let chatGptStarted!: () => void;
    const chatGptGate = new Promise<void>((resolve) => { releaseChatGpt = resolve; });
    const chatGptReady = new Promise<void>((resolve) => { chatGptStarted = resolve; });
    const chatGptCalls: ProviderRequest[] = [];
    const geminiCalls: ProviderRequest[] = [];
    const chatgpt = adapter("chatgpt", chatGptCalls, async () => {
      chatGptStarted();
      await chatGptGate;
      return { mode: "live", status: "complete", body: "CHATGPT_SLOW" };
    });
    const gemini = adapter("gemini", geminiCalls, async () => ({ mode: "live", status: "complete", body: "GEMINI_FAST" }));
    let session = createGroupChatSession("独立队列", createTestClock());
    session = append(session, "同时点名两家", ["chatgpt", "gemini"]);
    const chatPrepared = beginGroupChatProviderQueue(session, "chatgpt", createTestClock());
    const gemPrepared = beginGroupChatProviderQueue(session, "gemini", createTestClock());
    assert.equal(chatPrepared.ok, true);
    assert.equal(gemPrepared.ok, true);
    if (!chatPrepared.ok || !gemPrepared.ok) return;

    const chatRun = runGroupChatProviderQueue(chatPrepared.session, "chatgpt", {
      clock: createTestClock(), adapters: [chatgpt], timeoutMs: 1000,
    });
    await chatGptReady;
    const gemRun = await runGroupChatProviderQueue(gemPrepared.session, "gemini", {
      clock: createTestClock(), adapters: [gemini], timeoutMs: 1000,
    });
    assert.equal(gemRun.ok, true);
    if (gemRun.ok) assert.equal(gemRun.session.messages.at(-1)?.body, "GEMINI_FAST");
    assert.equal(chatGptCalls.length, 1);
    assert.equal(geminiCalls.length, 1);

    releaseChatGpt();
    const finishedChat = await chatRun;
    assert.equal(finishedChat.ok, true);
    if (finishedChat.ok) {
      assert.equal(finishedChat.session.messages.at(-1)?.body, "CHATGPT_SLOW");
      if (gemRun.ok) {
        const afterChat = mergeGroupChatExecution(session, [finishedChat.session], ["chatgpt"]);
        const afterGemini = mergeGroupChatExecution(afterChat, [gemRun.session], ["gemini"]);
        assert.equal(afterGemini.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.status, "complete");
        assert.equal(afterGemini.groupChatRequests?.find((request) => request.providerId === "gemini")?.status, "complete");
      }
    }
  });

  it("运行一家时可以取消同家尚未提交的后续请求，旧运行结果不能改回完成", async () => {
    let releaseFirst!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const calls: ProviderRequest[] = [];
    const chatgpt = adapter("chatgpt", calls, async () => {
      started();
      await gate;
      return { mode: "live", status: "complete", body: "FIRST_OK" };
    });
    let session = createGroupChatSession("取消队列", createTestClock());
    session = append(session, "第一条", ["chatgpt"]);
    session = append(session, "第二条", ["chatgpt"]);
    const prepared = beginGroupChatProviderQueue(session, "chatgpt", createTestClock());
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const run = runGroupChatProviderQueue(prepared.session, "chatgpt", {
      clock: createTestClock(), adapters: [chatgpt], timeoutMs: 1000,
    });
    await ready;
    const cancelled = cancelQueuedGroupChatRequests(prepared.session, "chatgpt");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.session.groupChatRequests?.find((request) => request.round === 2)?.status, "cancelled");
    releaseFirst();
    const finished = await run;
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    const merged = mergeGroupChatExecution(cancelled.session, [finished.session]);
    assert.equal(calls.length, 1);
    assert.equal(merged.groupChatRequests?.find((request) => request.round === 2)?.status, "cancelled");
    assert.equal(merged.messages.some((message) => message.body === "第二条" && message.requestId), false);
  });

  it("取消双目标消息中一家的排队请求，保留另一家的成功回执且后续不重复补发", async () => {
    let releaseGemini!: () => void;
    let geminiStarted!: () => void;
    const geminiGate = new Promise<void>((resolve) => { releaseGemini = resolve; });
    const geminiReady = new Promise<void>((resolve) => { geminiStarted = resolve; });
    const geminiCalls: ProviderRequest[] = [];
    const gemini = adapter("gemini", geminiCalls, async (request) => {
      if (request.userPrompt === "双目标原文") {
        geminiStarted();
        await geminiGate;
        return { mode: "live", status: "complete", body: "GEMINI_FIRST_OK" };
      }
      return { mode: "live", status: "complete", body: "GEMINI_NEXT_OK" };
    });
    let session = createGroupChatSession("双目标取消回执", createTestClock());
    session = append(session, "双目标原文", ["chatgpt", "gemini"]);
    const originalMessageId = session.messages.find((message) => message.body === "双目标原文")?.id;
    assert.ok(originalMessageId);

    const geminiPrepared = beginGroupChatProviderQueue(session, "gemini", createTestClock());
    assert.equal(geminiPrepared.ok, true);
    if (!geminiPrepared.ok) return;
    assert.equal(geminiPrepared.session.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.status, "queued");

    const geminiRun = runGroupChatProviderQueue(geminiPrepared.session, "gemini", {
      clock: createTestClock(), adapters: [gemini], timeoutMs: 1000,
    });
    await geminiReady;
    const cancelled = cancelQueuedGroupChatRequests(geminiPrepared.session, "chatgpt");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.session.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.status, "cancelled");

    releaseGemini();
    const finishedGemini = await geminiRun;
    assert.equal(finishedGemini.ok, true);
    if (!finishedGemini.ok) return;
    const merged = mergeGroupChatExecution(cancelled.session, [finishedGemini.session], ["gemini"]);

    assert.equal(merged.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.status, "cancelled");
    assert.equal(merged.groupChatRequests?.find((request) => request.providerId === "gemini")?.status, "complete");
    assert.equal(merged.messages.find((message) => message.requestId === finishedGemini.session.groupChatRequests?.find((request) => request.providerId === "gemini")?.id)?.body, "GEMINI_FIRST_OK");
    assert.ok(merged.deliveryReceipts?.some((receipt) => receipt.messageId === originalMessageId && receipt.providerId === "gemini" && (receipt.state ?? "confirmed") === "confirmed"));
    assert.equal(merged.messages.some((message) => message.requestId === cancelled.session.groupChatRequests?.find((request) => request.providerId === "chatgpt")?.id), false);

    const followup = appendGroupChatMessage(merged, "Gemini 后续问题", ["gemini"], createTestClock());
    assert.equal(followup.ok, true);
    if (!followup.ok) return;
    const followupRequest = followup.session.groupChatRequests?.find((request) => request.providerId === "gemini" && request.status === "queued");
    assert.ok(followupRequest);
    assert.equal(followupRequest?.contextMessageIds.includes(originalMessageId), false);
    const followupRun = await runGroupChatProviderQueue(followup.session, "gemini", {
      clock: createTestClock(), adapters: [gemini], timeoutMs: 1000,
    });
    assert.equal(followupRun.ok, true);
    assert.equal(geminiCalls.length, 2);
    assert.equal(geminiCalls[1]?.meetingContext?.some((item) => item.messageId === originalMessageId || item.body === "双目标原文"), false);
  });

  it("群聊未知结果在记录、界面标题和导出中都保持未知，真正失败仍是失败", async () => {
    const unknown = adapter("chatgpt", [], async () => ({
      mode: "live", status: "failed", body: "", error: { code: "connection_lost", message: "连接已断开" },
    }));
    let session = createGroupChatSession("未知与失败", createTestClock());
    session = append(session, "未知探针", ["chatgpt"]);
    const unknownRun = await runGroupChatProviderQueue(session, "chatgpt", {
      clock: createTestClock(), adapters: [unknown], timeoutMs: 1000,
    });
    assert.equal(unknownRun.ok, true);
    if (!unknownRun.ok) return;
    const unknownMessage = unknownRun.session.messages.find((message) => message.requestId);
    assert.equal(unknownMessage?.status, "unknown");
    assert.equal(unknownMessage ? outcomeHeadline(unknownMessage) : "", "未知");
    assert.equal(unknownRun.session.groupChatRequests?.[0]?.status, "unknown");
    const unknownExport = exportSession(unknownRun.session);
    assert.match(unknownExport.markdown, /未知/);
    const unknownParsed = parseSessionJsonl(unknownExport.jsonl);
    assert.equal(unknownParsed.ok, true);
    if (unknownParsed.ok) assert.equal(unknownParsed.session.messages.find((message) => message.requestId)?.status, "unknown");

    const failed = adapter("gemini", [], async () => ({
      mode: "live", status: "failed", body: "", error: { code: "adapter_error", message: "页面失败" },
    }));
    let failedSession = createGroupChatSession("真正失败", createTestClock());
    failedSession = append(failedSession, "失败探针", ["gemini"]);
    const failedRun = await runGroupChatProviderQueue(failedSession, "gemini", {
      clock: createTestClock(), adapters: [failed], timeoutMs: 1000,
    });
    assert.equal(failedRun.ok, true);
    if (failedRun.ok) {
      const failedMessage = failedRun.session.messages.find((message) => message.requestId);
      assert.equal(failedMessage?.status, "failed");
      assert.equal(failedMessage ? outcomeHeadline(failedMessage) : "", "失败");
    }
  });

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
