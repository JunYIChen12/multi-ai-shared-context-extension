import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runChatGptTurn,
  type ChatGptPagePort,
  type ChatGptPageStatus,
  type ChatGptTurnTiming,
} from "../src/extension/chatgpt-turn.js";
import { MAX_MESSAGE_BODY_CHARS } from "../src/core/types.js";

const timing: ChatGptTurnTiming = {
  startChecks: 2,
  completionChecks: 4,
  stableChecks: 2,
  async wait() {},
};

function page(options: {
  statuses: ChatGptPageStatus[];
  text?: string;
  writes?: boolean;
  submits?: boolean;
}): ChatGptPagePort {
  let index = 0;
  return {
    status() {
      const status = options.statuses[Math.min(index, options.statuses.length - 1)];
      index += 1;
      return status ?? { assistantCount: 0, isGenerating: false };
    },
    writePrompt() {
      return options.writes ?? true;
    },
    submit() {
      return options.submits ?? true;
    },
    latestAssistantText() {
      return options.text ?? "";
    },
  };
}

describe("ChatGPT 单轮状态机", () => {
  it("只在新增回复停止生成且正文稳定后返回成功", async () => {
    const result = await runChatGptTurn(
      page({
        statuses: [
          { assistantCount: 0, isGenerating: false },
          { assistantCount: 0, isGenerating: true },
          { assistantCount: 1, isGenerating: false },
          { assistantCount: 1, isGenerating: false },
        ],
        text: "CHATGPT_LIVE_OK",
      }),
      "只回复 CHATGPT_LIVE_OK",
      timing,
    );
    assert.deepEqual(result, { ok: true, body: "CHATGPT_LIVE_OK" });
  });

  it("等待发送按钮在输入状态更新后可用再提交", async () => {
    let sendReady = false;
    let statusIndex = 0;
    const events: string[] = [];
    const statuses: ChatGptPageStatus[] = [
      { assistantCount: 0, isGenerating: false },
      { assistantCount: 0, isGenerating: true },
      { assistantCount: 1, isGenerating: false },
      { assistantCount: 1, isGenerating: false },
    ];
    const result = await runChatGptTurn(
      {
        status() {
          const status = statuses[Math.min(statusIndex, statuses.length - 1)];
          statusIndex += 1;
          return status ?? { assistantCount: 0, isGenerating: false };
        },
        writePrompt() {
          events.push("write");
          return true;
        },
        submit() {
          events.push("submit");
          return sendReady;
        },
        latestAssistantText() {
          return "REPLY";
        },
      },
      "问题",
      {
        ...timing,
        async wait() {
          events.push("wait");
          sendReady = true;
        },
      },
    );

    assert.deepEqual(result, { ok: true, body: "REPLY" });
    assert.deepEqual(events.slice(0, 3), ["write", "wait", "submit"]);
  });

  it("拒绝忙碌页面、空问题和缺失控件", async () => {
    const busy = await runChatGptTurn(
      page({ statuses: [{ assistantCount: 0, isGenerating: true }] }),
      "问题",
      timing,
    );
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.code, "busy");

    const empty = await runChatGptTurn(
      page({ statuses: [{ assistantCount: 0, isGenerating: false }] }),
      "   ",
      timing,
    );
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "invalid_request");

    const missingPrompt = await runChatGptTurn(
      page({ statuses: [{ assistantCount: 0, isGenerating: false }], writes: false }),
      "问题",
      timing,
    );
    assert.equal(missingPrompt.ok, false);
    if (!missingPrompt.ok) assert.equal(missingPrompt.code, "prompt_missing");

    const missingSend = await runChatGptTurn(
      page({ statuses: [{ assistantCount: 0, isGenerating: false }], submits: false }),
      "问题",
      timing,
    );
    assert.equal(missingSend.ok, false);
    if (!missingSend.ok) assert.equal(missingSend.code, "send_missing");
  });

  it("区分生成未开始、完成超时和空回复", async () => {
    const notStarted = await runChatGptTurn(
      page({
        statuses: [
          { assistantCount: 2, isGenerating: false },
          { assistantCount: 2, isGenerating: false },
          { assistantCount: 2, isGenerating: false },
        ],
      }),
      "问题",
      timing,
    );
    assert.equal(notStarted.ok, false);
    if (!notStarted.ok) assert.equal(notStarted.code, "start_timeout");

    const neverDone = await runChatGptTurn(
      page({
        statuses: [
          { assistantCount: 0, isGenerating: false },
          { assistantCount: 0, isGenerating: true },
          { assistantCount: 1, isGenerating: true },
        ],
      }),
      "问题",
      timing,
    );
    assert.equal(neverDone.ok, false);
    if (!neverDone.ok) assert.equal(neverDone.code, "completion_timeout");

    const emptyReply = await runChatGptTurn(
      page({
        statuses: [
          { assistantCount: 0, isGenerating: false },
          { assistantCount: 1, isGenerating: false },
        ],
      }),
      "问题",
      timing,
    );
    assert.equal(emptyReply.ok, false);
    if (!emptyReply.ok) assert.equal(emptyReply.code, "empty_response");
  });

  it("拒绝超过记录上限的真实回复", async () => {
    const result = await runChatGptTurn(
      page({
        statuses: [
          { assistantCount: 0, isGenerating: false },
          { assistantCount: 1, isGenerating: false },
        ],
        text: "x".repeat(MAX_MESSAGE_BODY_CHARS + 1),
      }),
      "问题",
      timing,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "response_too_large");
  });
});
