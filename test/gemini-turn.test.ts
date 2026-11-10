import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runGeminiTurn, type GeminiTurnTiming } from "../src/extension/gemini-turn.js";
import type { GeminiPagePort, GeminiPageSnapshot } from "../src/extension/gemini-dom.js";

const PROMPT = "只回复 GEMINI_LIVE_OK";

function fast(page: FakePage, polls = 3): GeminiTurnTiming {
  return { polls, wait: async () => page.wait() };
}

describe("Gemini 第一轮证据状态机", () => {
  it("允许 pending 过渡和节点重建，只在同一新轮次有完整结束证据后返回原文", async () => {
    const page = new FakePage([
      emptyDraft(),
      emptyDraft(),
      snapshot("draft", [{ userQueryCount: 1, promptMatches: 1, pendingRequests: 1, pendingResponses: 1 }]),
      snapshot("conversation", [{
        userQueryCount: 1, promptMatches: 1, modelResponses: [model("GEMINI_LIVE_OK")],
      }]),
    ]);
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page));
    assert.deepEqual(result, { ok: true, body: "GEMINI_LIVE_OK" });
    assert.equal(page.submits, 1);
    assert.equal(page.reads, 4);
  });

  it("竞争的新增轮次失败且不重发", async () => {
    const page = new FakePage([
      emptyDraft(), emptyDraft(),
      snapshot("conversation", [
        { userQueryCount: 1, promptMatches: 1 },
        { userQueryCount: 1, promptMatches: 0 },
      ]),
    ]);
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "ambiguous_turn");
    assert.equal(page.submits, 1);
  });

  it("页面错误返回失败且正文为空", async () => {
    const page = new FakePage([emptyDraft(), emptyDraft(), { ...emptyDraft(), pageError: true }]);
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page));
    assert.deepEqual(result, { ok: false, code: "page_error", message: "Gemini 页面报告错误" });
    assert.equal(page.submits, 1);
  });

  it("缺少完成标记到限后返回 timeout，不把部分正文写成成功", async () => {
    const page = new FakePage([
      emptyDraft(), emptyDraft(),
      snapshot("conversation", [{ userQueryCount: 1, promptMatches: 1, modelResponses: [model("partial", false)] }]),
    ]);
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page, 1));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "timeout");
    assert.equal(page.submits, 1);
  });

  it("草稿在发送前被改动时停止，不发送改后的内容", async () => {
    let page: FakePage;
    page = new FakePage([emptyDraft()], () => { page.draft = `${PROMPT} `; });
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page, 1));
    assert.equal(result.ok, false);
    assert.equal(page.submits, 0);
    if (!result.ok) assert.equal(result.code, "prompt_changed");
  });

  it("response-info-line 等冲突标记不能被当成自然完成", async () => {
    const conflicting = { ...model("GEMINI_LIVE_OK"), responseInfo: true };
    const page = new FakePage([
      emptyDraft(), emptyDraft(),
      snapshot("conversation", [{ userQueryCount: 1, promptMatches: 1, modelResponses: [conflicting] }]),
    ]);
    const result = await runGeminiTurn(page, PROMPT, new AbortController().signal, fast(page));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "page_error");
    assert.equal(page.submits, 1);
  });

  it("切到另一会话或用户手停都不会产生成功正文", async () => {
    const navigated = new FakePage([
      emptyDraft(), emptyDraft(), emptyDraft("first-conversation"), emptyDraft("other-conversation"),
    ]);
    const navigationResult = await runGeminiTurn(navigated, PROMPT, new AbortController().signal, fast(navigated));
    assert.equal(navigationResult.ok, false);
    if (!navigationResult.ok) assert.equal(navigationResult.code, "navigation");

    const stopped = new FakePage([emptyDraft(), emptyDraft(), emptyDraft()], (stop) => stop());
    const stopResult = await runGeminiTurn(stopped, PROMPT, new AbortController().signal, fast(stopped));
    assert.equal(stopResult.ok, false);
    if (!stopResult.ok) assert.equal(stopResult.code, "stopped");
    assert.equal(stopped.submits, 1);
  });

  it("在发送前取消不会点击发送，发送后取消不会返回晚到回复", async () => {
    const beforeController = new AbortController();
    const before = new FakePage([emptyDraft()], () => beforeController.abort());
    const beforeResult = await runGeminiTurn(before, PROMPT, beforeController.signal, fast(before));
    assert.equal(beforeResult.ok, false);
    if (!beforeResult.ok) assert.equal(beforeResult.code, "cancelled");
    assert.equal(before.submits, 0);

    const afterController = new AbortController();
    let waits = 0;
    const after = new FakePage([emptyDraft(), emptyDraft(), emptyDraft()], () => {
      waits += 1;
      if (waits === 2) afterController.abort();
    });
    const afterResult = await runGeminiTurn(after, PROMPT, afterController.signal, fast(after));
    assert.equal(afterResult.ok, false);
    if (!afterResult.ok) assert.equal(afterResult.code, "cancelled");
    assert.equal(after.submits, 1);
  });
});

class FakePage implements GeminiPagePort {
  reads = 0;
  submits = 0;
  draft = "";
  private index = 0;
  private stop: () => void = () => undefined;

  constructor(
    private readonly snapshots: GeminiPageSnapshot[],
    private readonly onWait?: (stop: () => void) => void,
  ) {}

  read(): GeminiPageSnapshot {
    const current = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index += 1;
    this.reads += 1;
    if (!current) throw new Error("missing Gemini snapshot");
    return current;
  }

  writePrompt(prompt: string): boolean { this.draft = prompt; return true; }
  readPrompt(): string { return this.draft; }
  submit(): boolean { this.submits += 1; return true; }
  watchStop(onStop: () => void): () => void {
    this.stop = onStop;
    return () => { this.stop = () => undefined; };
  }
  wait(): void { this.onWait?.(this.stop); }
}

function emptyDraft(id?: string): GeminiPageSnapshot {
  return snapshot(id ? "conversation" : "draft", [], false, false, id);
}

function snapshot(
  route: "draft" | "conversation",
  conversations: Array<Partial<GeminiPageSnapshot["conversations"][number]> &
    Pick<GeminiPageSnapshot["conversations"][number], "userQueryCount" | "promptMatches">>,
  pageError = false,
  stopVisible = false,
  routeId?: string,
): GeminiPageSnapshot {
  return {
    route: route === "draft" ? { kind: "draft" } : { kind: "conversation", id: routeId ?? "conversation-1" },
    conversations: conversations.map((turn) => ({
      userQueryCount: turn.userQueryCount,
      promptMatches: turn.promptMatches,
      pendingRequests: turn.pendingRequests ?? 0,
      pendingResponses: turn.pendingResponses ?? 0,
      modelResponseCount: turn.modelResponseCount ?? turn.modelResponses?.length ?? 0,
      completeFooterCount: turn.modelResponses?.filter((response) => response.completeFooter).length ?? 0,
      messageActionsCount: turn.modelResponses?.filter((response) => response.messageActions).length ?? 0,
      modelResponses: turn.modelResponses ?? [],
    })),
    pageError,
    stopVisible,
  };
}

function model(body: string, complete = true): GeminiPageSnapshot["conversations"][number]["modelResponses"][number] {
  return {
    body,
    completeFooter: complete,
    messageActions: complete,
    responseInfo: false,
    ariaBusy: !complete,
  };
}
