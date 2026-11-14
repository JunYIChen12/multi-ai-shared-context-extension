import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import { allowsNewIndependentSession, canSelectNextRoundTarget, createRoundtableSession, appendRoundtableUserInput, runRoundtableRound } from "../src/core/roundtable.js";
import { formatRoundtablePrompt } from "../src/core/context.js";
import { createSession, type OrchestratorOptions } from "../src/core/orchestrate.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../src/core/types.js";

type Call = { provider: string; request: ProviderRequest };

function adapter(
  provider: "chatgpt" | "gemini",
  calls: Call[],
  respond: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
): ProviderAdapter {
  return {
    id: provider,
    mode: "live",
    async respond(request) {
      calls.push({ provider, request });
      return respond(request);
    },
  };
}

function options(adapters: ProviderAdapter[]): OrchestratorOptions {
  return { clock: createTestClock(), adapters, timeoutMs: 100, maxRounds: 4 };
}

async function started(opts: OrchestratorOptions) {
  const session = createRoundtableSession("首个问题", opts);
  if (!session.ok) assert.fail(session.detail);
  return session.session;
}

describe("圆桌会议编排", () => {
  it("按署名原文增量拼接上次未发送内容和本轮用户发言，不摘要或截断", () => {
    const prompt = formatRoundtablePrompt("请核对边界", 2, [
      { messageId: "c1", speakerId: "chatgpt", round: 1, phase: "roundtable", body: "ChatGPT 的完整原话\n第二行" },
      { messageId: "u2", speakerId: "user", round: 2, phase: "roundtable", body: "用户较早补充" },
    ]);
    assert.equal(prompt, [
      "【ChatGPT · 第 1 轮完整原话】\nChatGPT 的完整原话\n第二行",
      "【用户 · 第 2 轮完整原话】\n用户较早补充",
      "【用户 · 第 2 轮新发言】\n请核对边界",
    ].join("\n\n"));
    assert.equal(prompt.includes("第 1 轮完整原话"), true);
    assert.equal(prompt.includes("第二行"), true);
  });

  it("先 ChatGPT 后 Gemini；每家只补本家尚未收到的完整新内容", async () => {
    const calls: Call[] = [];
    const adapters = [
      adapter("gemini", calls, (request) => ({ mode: "live", status: "complete", body: `GEMINI_R${request.round}` })),
      adapter("chatgpt", calls, (request) => ({ mode: "live", status: "complete", body: `CHATGPT_R${request.round}` })),
    ];
    const opts = options(adapters);
    const first = await runRoundtableRound(await started(opts), opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(calls.map((call) => call.provider), ["chatgpt", "gemini"]);
    assert.equal(calls[0]?.request.userPrompt, "首个问题");
    assert.deepEqual(calls[0]?.request.meetingContext, []);
    assert.equal(calls[1]?.request.userPrompt, "首个问题");
    assert.deepEqual(calls[1]?.request.meetingContext?.map((item) => [item.speakerId, item.body]), [
      ["chatgpt", "CHATGPT_R1"],
    ]);

    const recorded = appendRoundtableUserInput(first.session, "补充：关注隐私边界");
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    const beforeCalls = calls.length;
    assert.equal(beforeCalls, 2, "记录补充不能自动发送");
    const second = await runRoundtableRound(recorded.session, opts);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(calls.slice(2).map((call) => call.provider), ["chatgpt", "gemini"]);
    assert.equal(calls[2]?.request.userPrompt, "补充：关注隐私边界");
    assert.deepEqual(calls[2]?.request.meetingContext?.map((item) => [item.speakerId, item.body]), [
      ["gemini", "GEMINI_R1"],
    ]);
    assert.deepEqual(calls[3]?.request.meetingContext?.map((item) => [item.speakerId, item.body]), [
      ["chatgpt", "CHATGPT_R2"],
    ]);
    assert.equal(calls[2]?.request.meetingContext?.some((item) => item.body === "CHATGPT_R1"), false);
    assert.equal(calls[3]?.request.meetingContext?.some((item) => item.body === "GEMINI_R1"), false);
    assert.equal(second.session.deliveryReceipts?.length, 7);
  });

  it("只有一轮完整结束后才允许选择下一轮的单家目标", async () => {
    const calls: Call[] = [];
    const opts = options([
      adapter("chatgpt", calls, () => ({ mode: "live", status: "complete", body: "C_OK" })),
      adapter("gemini", calls, () => ({ mode: "live", status: "complete", body: "G_OK" })),
    ]);
    const initial = await started(opts);
    assert.equal(canSelectNextRoundTarget(initial), false);

    const first = await runRoundtableRound(initial, opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(canSelectNextRoundTarget(first.session), true);

    const recorded = appendRoundtableUserInput(first.session, "插话");
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    assert.equal(canSelectNextRoundTarget(recorded.session), false);
  });

  it("不允许普通提问覆盖当前圆桌记录", async () => {
    assert.equal(allowsNewIndependentSession(null), true);
    const independent = createSession("独立问题", options([]));
    assert.equal(independent.ok, true);
    if (independent.ok) assert.equal(allowsNewIndependentSession(independent.session), true);
    assert.equal(allowsNewIndependentSession(await started(options([]))), false);
  });

  it("@某一家只调用被点名的模型，并把本轮计入总轮数", async () => {
    const calls: Call[] = [];
    const opts = options([
      adapter("chatgpt", calls, () => ({ mode: "live", status: "complete", body: "C_OK" })),
      adapter("gemini", calls, () => ({ mode: "live", status: "complete", body: "G_OK" })),
    ]);
    const first = await runRoundtableRound(await started(opts), opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const recorded = appendRoundtableUserInput(first.session, "请核对这个点", "gemini");
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    const next = await runRoundtableRound(recorded.session, opts);
    assert.equal(next.ok, true);
    assert.deepEqual(calls.map((call) => call.provider), ["chatgpt", "gemini", "gemini"]);
    assert.equal(calls[2]?.request.round, 2);
  });

  it("任一家失败即停止后续发送，失败正文留空且不能继续", async () => {
    const calls: Call[] = [];
    const opts = options([
      adapter("chatgpt", calls, () => ({ mode: "live", status: "failed", body: "不采信", error: { code: "page_error", message: "页面错误" } })),
      adapter("gemini", calls, () => ({ mode: "live", status: "complete", body: "不应发送" })),
    ]);
    const first = await runRoundtableRound(await started(opts), opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(calls.map((call) => call.provider), ["chatgpt"]);
    const failure = first.session.messages.find((message) => message.providerId === "chatgpt");
    assert.equal(failure?.status, "failed");
    assert.equal(failure?.body, "");
    assert.equal(failure?.sourceKind, "system");
    const added = appendRoundtableUserInput(first.session, "再问一次");
    assert.equal(added.ok, false);
    if (!added.ok) assert.equal(added.reason, "meeting_stopped");
  });

  it("没有输入时继续动作记录一条新的继续提示，不会重复旧历史", async () => {
    const calls: Call[] = [];
    const opts = options([
      adapter("chatgpt", calls, (request) => ({ mode: "live", status: "complete", body: `C${request.round}` })),
      adapter("gemini", calls, (request) => ({ mode: "live", status: "complete", body: `G${request.round}` })),
    ]);
    const first = await runRoundtableRound(await started(opts), opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const added = appendRoundtableUserInput(first.session, "继续");
    assert.equal(added.ok, true);
    if (!added.ok) return;
    const second = await runRoundtableRound(added.session, opts);
    assert.equal(second.ok, true);
    assert.equal(calls[2]?.request.userPrompt, "继续");
    assert.deepEqual(calls[2]?.request.meetingContext?.map((item) => item.body), ["G1"]);
  });

  it("最多四轮；超过上限拒绝记录下一条用户输入", async () => {
    const calls: Call[] = [];
    const opts = options([
      adapter("chatgpt", calls, (request) => ({ mode: "live", status: "complete", body: `C${request.round}` })),
      adapter("gemini", calls, (request) => ({ mode: "live", status: "complete", body: `G${request.round}` })),
    ]);
    let current = await started(opts);
    for (let round = 1; round <= 4; round += 1) {
      if (round > 1) {
        const added = appendRoundtableUserInput(current, `第${round}轮`);
        assert.equal(added.ok, true);
        if (!added.ok) return;
        current = added.session;
      }
      const result = await runRoundtableRound(current, opts);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      current = result.session;
    }
    const fifth = appendRoundtableUserInput(current, "不应有第五轮");
    assert.equal(fifth.ok, false);
    if (!fifth.ok) assert.equal(fifth.reason, "stop_max_rounds");
  });

  it("用户停止当前发送后留空，不调用下一家", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const opts = options([
      adapter("chatgpt", calls, async (_request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        return { mode: "live", status: "complete", body: "迟到结果" };
      }),
      adapter("gemini", calls, () => ({ mode: "live", status: "complete", body: "不应发送" })),
    ]);
    const first = await runRoundtableRound(await started(opts), { ...opts, signal: controller.signal });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(calls.map((call) => call.provider), ["chatgpt"]);
    assert.equal(first.session.messages.at(-1)?.status, "cancelled");
    assert.equal(first.session.messages.at(-1)?.body, "");
  });
});
