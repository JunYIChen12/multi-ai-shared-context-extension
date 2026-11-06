import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import { formatInjection } from "../src/core/context.js";
import { MOCK_PREFIX, isInjectableOpinion, outcomeHeadline, summarizeSession } from "../src/core/labels.js";
import {
  contractViolation,
  createSession,
  runCrossReview,
  runIndependentRound,
  type OrchestratorOptions,
} from "../src/core/orchestrate.js";
import { defaultAdapters, mockAdapter, mockAdapters } from "../src/core/providers.js";
import type { ProviderAdapter, ProviderResponse, Session } from "../src/core/types.js";

function options(adapters: ProviderAdapter[], timeoutMs = 1000): OrchestratorOptions {
  return { clock: createTestClock(), adapters, timeoutMs, maxRounds: 2 };
}

async function started(prompt: string, opts: OrchestratorOptions): Promise<Session> {
  const created = createSession(prompt, opts);
  if (!created.ok) {
    assert.fail(created.detail);
  }
  return created.session;
}

describe("独立回答", () => {
  it("live 完成回复保存为可追踪的 provider 观点", async () => {
    const live: ProviderAdapter = {
      id: "chatgpt",
      mode: "live",
      async respond() {
        return { mode: "live", status: "complete", body: "CHATGPT_LIVE_OK" };
      },
    };
    const opts = options([live]);
    const ran = await runIndependentRound(await started("真实链路", opts), opts);
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    const reply = ran.session.messages.find((message) => message.providerId === "chatgpt");
    assert.ok(reply);
    assert.equal(reply.status, "complete");
    assert.equal(reply.sourceKind, "provider");
    assert.equal(reply.adapterMode, "live");
    assert.equal(reply.body, "CHATGPT_LIVE_OK");
    assert.equal(isInjectableOpinion(reply), true);
    assert.equal(outcomeHeadline(reply), "页面结束");
    assert.match(contractViolation({ mode: "live", status: "complete", body: "" }) ?? "", /正文/);
  });

  it("手停和未知不会留下可注入正文", async () => {
    const stopped: ProviderAdapter = {
      id: "chatgpt",
      mode: "live",
      async respond() {
        return { mode: "live", status: "cancelled", body: "残文", error: { code: "stopped", message: "已手停" } };
      },
    };
    const opts = options([stopped]);
    const ran = await runIndependentRound(await started("手停", opts), opts);
    assert.equal(ran.ok, true);
    if (!ran.ok) return;
    const reply = ran.session.messages.find((message) => message.providerId === "chatgpt");
    assert.equal(reply?.status, "cancelled");
    assert.equal(reply?.body, "");
    assert.equal(reply?.sourceKind, "system");
    assert.equal(reply ? outcomeHeadline(reply) : "", "已手停");
    assert.equal(reply ? isInjectableOpinion(reply) : true, false);
  });

  it("外层超时后不接收晚到的完成正文，下一轮不被污染", async () => {
    let round = 0;
    const live: ProviderAdapter = {
      id: "chatgpt",
      mode: "live",
      async respond(_request, context) {
        round += 1;
        if (round === 1) {
          return await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ mode: "live", status: "complete", body: "LATE" }), 200);
            context?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve({ mode: "live", status: "complete", body: "LATE" });
            });
          });
        }
        return { mode: "live", status: "complete", body: "SECOND" };
      },
    };
    const slow = options([live], 20);
    const first = await runIndependentRound(await started("超时", slow), slow);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const late = first.session.messages.find((message) => message.providerId === "chatgpt");
    assert.equal(late?.status, "timeout");
    assert.equal(late?.body, "");
    assert.equal(late ? isInjectableOpinion(late) : true, false);

    const second = await runIndependentRound(await started("下一轮", options([live], 1000)), options([live], 1000));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const reply = second.session.messages.find((message) => message.providerId === "chatgpt");
    assert.equal(reply?.body, "SECOND");
    assert.equal(reply?.status, "complete");
  });

  it("默认适配器全部未接入，且不会变成可注入观点", async () => {
    const opts = options(defaultAdapters());
    const session = await started("同一个问题", opts);
    const ran = await runIndependentRound(session, opts);
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    assert.equal(ran.session.messages[0]?.role, "user");
    assert.equal(ran.session.messages[0]?.body, "同一个问题");
    assert.equal(ran.session.messages[0]?.round, 1);
    const replies = ran.session.messages.filter((message) => message.role !== "user");
    assert.deepEqual(
      replies.map((message) => message.providerId),
      ["chatgpt", "grok", "gemini"],
    );
    for (const message of replies) {
      assert.equal(message.status, "not_connected");
      assert.equal(message.role, "system");
      assert.equal(message.body, "");
      assert.equal(outcomeHeadline(message), "未接入");
      assert.equal(isInjectableOpinion(message), false);
    }
    assert.match(summarizeSession(ran.session), /可注入观点 0 条/);
    assert.match(summarizeSession(ran.session), /未接入 3 条/);
    const second = await runCrossReview(
      ran.session,
      { sourceProviderIds: ["chatgpt", "grok", "gemini"], targetProviderIds: ["chatgpt"] },
      opts,
    );
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "no_injectable_opinions");
    }
  });

  it("一路失败或超时时，其他路仍留下记录", async () => {
    const failing: ProviderAdapter = {
      id: "grok",
      mode: "mock",
      async respond() {
        throw new Error("boom");
      },
    };
    const slow: ProviderAdapter = {
      id: "gemini",
      mode: "mock",
      async respond() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { mode: "mock", status: "complete", body: `${MOCK_PREFIX} 太慢` };
      },
    };
    const opts = options([mockAdapter("chatgpt"), failing, slow], 30);
    const ran = await runIndependentRound(await started("并行", opts), opts);
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    const byId = new Map(ran.session.messages.map((message) => [message.providerId ?? "user", message]));
    assert.equal(byId.get("chatgpt")?.status, "complete");
    assert.equal(byId.get("chatgpt")?.sourceKind, "mock");
    assert.equal(byId.get("grok")?.status, "failed");
    assert.equal(byId.get("grok")?.errorCode, "adapter_error");
    assert.equal(byId.get("gemini")?.status, "timeout");
    assert.equal(byId.get("gemini")?.role, "system");
    assert.equal(isInjectableOpinion(byId.get("grok")!), false);
    assert.equal(isInjectableOpinion(byId.get("gemini")!), false);
  });

  it("未实现适配器若谎称完成，会被记成契约错误而不是回答", async () => {
    const lying: ProviderAdapter = {
      id: "chatgpt",
      mode: "unimplemented",
      async respond(): Promise<ProviderResponse> {
        return { mode: "unimplemented", status: "complete", body: "我是 ChatGPT" };
      },
    };
    const opts = options([lying]);
    const ran = await runIndependentRound(await started("探测", opts), opts);
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    const reply = ran.session.messages.find((message) => message.providerId === "chatgpt");
    assert.ok(reply);
    assert.equal(reply.status, "failed");
    assert.equal(reply.body, "");
    assert.equal(reply.errorCode, "adapter_contract_violation");
    assert.equal(outcomeHeadline(reply), "契约错误");
    assert.equal(isInjectableOpinion(reply), false);
  });

  it("拒绝空问题、超限轮次、空适配器和重复执行", async () => {
    const opts = options(mockAdapters());
    const empty = createSession("   ", opts);
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.reason, "invalid_prompt");
      assert.equal(empty.session, null);
    }
    const tooMany = createSession("问题", { ...opts, maxRounds: 9 });
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) {
      assert.equal(tooMany.reason, "invalid_max_rounds");
    }
    const session = await started("只跑一次", opts);
    const none = await runIndependentRound(session, options([]));
    assert.equal(none.ok, false);
    if (!none.ok) {
      assert.equal(none.reason, "no_providers");
      assert.equal(none.session?.messages.length, 1);
    }
    const first = await runIndependentRound(session, opts);
    assert.equal(first.ok, true);
    const again = await runIndependentRound(first.ok ? first.session : session, opts);
    assert.equal(again.ok, false);
    if (!again.ok) {
      assert.equal(again.reason, "duplicate_prompt");
      assert.equal(again.session?.messages.length, first.ok ? first.session.messages.length : 0);
    }
    const duplicated = await runIndependentRound(session, options([mockAdapter("chatgpt"), mockAdapter("chatgpt")]));
    assert.equal(duplicated.ok, false);
    if (!duplicated.ok) {
      assert.match(duplicated.detail, /重复/);
    }
  });
});

describe("交叉讨论", () => {
  it("只注入被选中的其他来源，并在记录上留下轮次和消息指针", async () => {
    const opts = options(mockAdapters());
    const first = await runIndependentRound(await started("交叉", opts), opts);
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const ran = await runCrossReview(
      first.session,
      { sourceProviderIds: ["chatgpt", "grok"], targetProviderIds: ["gemini", "chatgpt"] },
      opts,
    );
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    const gemini = ran.session.messages.find(
      (message) => message.phase === "cross_review" && message.providerId === "gemini",
    );
    const chatgpt = ran.session.messages.find(
      (message) => message.phase === "cross_review" && message.providerId === "chatgpt",
    );
    assert.ok(gemini && chatgpt);
    assert.equal(gemini.round, 2);
    assert.equal(gemini.sourceKind, "mock");
    assert.equal(gemini.body.startsWith(MOCK_PREFIX), true);
    assert.match(gemini.body, /注入条数=2/);
    assert.match(chatgpt.body, /注入条数=1/);
    assert.deepEqual(
      gemini.provenance.map((item) => item.providerId),
      ["chatgpt", "grok"],
    );
    assert.equal(chatgpt.provenance.length, 1);
    assert.equal(chatgpt.provenance[0]?.providerId, "grok");
    assert.equal(ran.session.messages.some((message) => message.phase === "cross_review" && message.providerId === "grok"), false);
    const text = formatInjection([
      {
        providerId: "chatgpt",
        round: 1,
        phase: "independent",
        messageId: gemini.provenance[0]?.messageId ?? "missing",
        sourceKind: "mock",
        body: "<script>alert(1)</script>",
      },
    ]);
    assert.match(text, /<script>alert\(1\)<\/script>/);
    assert.equal(text.includes("innerHTML"), false);
    const again = await runCrossReview(
      ran.session,
      { sourceProviderIds: ["chatgpt", "grok"], targetProviderIds: ["gemini"] },
      opts,
    );
    assert.equal(again.ok, false);
    if (!again.ok) {
      assert.equal(again.reason, "duplicate_prompt");
    }
  });

  it("没有其他来源时不编造评论，并遵守轮次上限", async () => {
    const only = options([mockAdapter("chatgpt")]);
    const first = await runIndependentRound(await started("单家", only), only);
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const alone = await runCrossReview(
      first.session,
      { sourceProviderIds: ["chatgpt"], targetProviderIds: ["chatgpt"] },
      only,
    );
    assert.equal(alone.ok, true);
    if (!alone.ok) {
      return;
    }
    const note = alone.session.messages.find((message) => message.phase === "cross_review");
    assert.equal(note?.status, "failed");
    assert.equal(note?.errorCode, "no_other_sources");
    assert.equal(isInjectableOpinion(note!), false);

    const limited = options(mockAdapters());
    const created = createSession("停止", { ...limited, maxRounds: 1 });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const round = await runIndependentRound(created.session, { ...limited, maxRounds: 1 });
    assert.equal(round.ok, true);
    if (!round.ok) {
      return;
    }
    const stopped = await runCrossReview(
      round.session,
      { sourceProviderIds: ["chatgpt", "grok", "gemini"], targetProviderIds: ["chatgpt"] },
      limited,
    );
    assert.equal(stopped.ok, false);
    if (!stopped.ok) {
      assert.equal(stopped.reason, "stop_max_rounds");
      assert.equal(stopped.session?.messages.some((message) => message.phase === "cross_review"), false);
    }
  });

  it("还没有第一轮时不能交叉讨论，MOCK 正文也必须带前缀", async () => {
    const opts = options(mockAdapters());
    const created = await started("尚未开始", opts);
    const early = await runCrossReview(
      created,
      { sourceProviderIds: ["chatgpt"], targetProviderIds: ["grok"] },
      opts,
    );
    assert.equal(early.ok, false);
    if (!early.ok) {
      assert.equal(early.reason, "independent_round_missing");
    }
    assert.match(contractViolation({ mode: "mock", status: "complete", body: "像真的一样" }) ?? "", /MOCK/);
    assert.equal(contractViolation({ mode: "mock", status: "failed", body: "" }), null);
  });
});
