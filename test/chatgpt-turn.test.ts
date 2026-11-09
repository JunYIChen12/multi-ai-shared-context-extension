import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MESSAGE_BODY_CHARS } from "../src/core/types.js";
import type { ChatGptEvidencePort, PageEvidence, StructuralTurn } from "../src/extension/chatgpt-evidence.js";
import { parseSessionUrl, relateSession } from "../src/extension/chatgpt-evidence.js";
import { abortableDelay, createSendLedger, runChatGptTurn, type ChatGptTurnTiming } from "../src/extension/chatgpt-turn.js";

const timing: ChatGptTurnTiming = {
  polls: 6,
  stableChecks: 2,
  async wait(signal) {
    if (signal.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
  },
};

function turn(partial: Partial<StructuralTurn> & Pick<StructuralTurn, "id" | "role" | "order">): StructuralTurn {
  return {
    endControl: { state: "unreadable" },
    ...partial,
  };
}

function evidence(options: {
  url?: string;
  turns?: StructuralTurn[];
  turnsUnreadable?: boolean;
  stop?: boolean;
  stopUnreadable?: boolean;
  error?: "none" | "present";
  errorUnreadable?: boolean;
}): PageEvidence {
  const session = parseSessionUrl(options.url ?? "https://chatgpt.com/");
  return {
    session,
    turns: options.turnsUnreadable
      ? { state: "unreadable" }
      : { state: "ready", value: options.turns ?? [] },
    composerStop: options.stopUnreadable
      ? { state: "unreadable" }
      : { state: "ready", value: options.stop ?? false },
    pageError: options.errorUnreadable
      ? { state: "unreadable" }
      : { state: "ready", value: options.error ?? "none" },
  };
}

function scripted(
  reads: PageEvidence[],
  hooks?: { writes?: boolean; submits?: boolean; wait?: (info: { submitted: boolean; fireStop: () => void }) => void },
): {
  page: ChatGptEvidencePort;
  submits: () => number;
  writes: () => number;
  requested: string[][];
  disarmed: () => number;
  timing: ChatGptTurnTiming;
} {
  let submitCount = 0;
  let writeCount = 0;
  let disarmCount = 0;
  let submitted = false;
  let fireStop = () => undefined as void;
  const requested: string[][] = [];
  let index = 0;
  const page: ChatGptEvidencePort = {
    read(request) {
      requested.push([...request.textTurnIds]);
      const item = reads[Math.min(index, reads.length - 1)] ?? evidence({});
      index += 1;
      return item;
    },
    writePrompt() {
      writeCount += 1;
      return hooks?.writes ?? true;
    },
    submit() {
      submitCount += 1;
      submitted = true;
      return hooks?.submits ?? true;
    },
    watchStop(onStop) {
      fireStop = onStop;
      return () => {
        disarmCount += 1;
      };
    },
  };
  return {
    page,
    submits: () => submitCount,
    writes: () => writeCount,
    requested,
    disarmed: () => disarmCount,
    timing: {
      ...timing,
      async wait(signal) {
        hooks?.wait?.({ submitted, fireStop });
        if (signal.aborted) {
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        }
      },
    },
  };
}

const readyEnd = { state: "ready" as const, value: true as const };

describe("ChatGPT 轮次归属（离线证据契约，不是真实页面）", () => {
  it("Stop 或错误证据不可读时，发送前必须 fail closed", async () => {
    const unreadable = evidence({ stopUnreadable: true, errorUnreadable: true });
    const script = scripted([unreadable, unreadable]);
    const result = await runChatGptTurn(script.page, "问题", script.timing);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(script.writes(), 0);
    assert.equal(script.submits(), 0);
  });

  it("归属和自然结束组合齐全时成功，包括曾经看见生成", async () => {
    const generating = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "CHATGPT_LIVE_OK", endControl: readyEnd }),
      ],
      stop: true,
    });
    const done = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "CHATGPT_LIVE_OK", endControl: readyEnd }),
      ],
      stop: false,
    });
    const script = scripted([evidence({}), evidence({}), generating, done, done, done]);
    const result = await runChatGptTurn(script.page, "只回复 CHATGPT_LIVE_OK", script.timing);
    assert.deepEqual(result, { ok: true, body: "CHATGPT_LIVE_OK" });
    assert.equal(script.submits(), 1);
  });

  it("极短回复没见过 Stop 开始，只要归属和其他结束组合齐全就成功", async () => {
    const done = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "OK", endControl: readyEnd }),
      ],
      stop: false,
    });
    const script = scripted([evidence({}), evidence({}), done, done, done]);
    const result = await runChatGptTurn(script.page, "短", script.timing);
    assert.deepEqual(result, { ok: true, body: "OK" });
    assert.equal(script.requested.some((ids) => ids.includes("a1")), true);
    assert.equal(script.requested[0]?.length, 0);
  });

  it("只有 Copy、稳定文本或 Stop 消失，缺归属或缺结束判据时不成功", async () => {
    const oldOnly = evidence({
      turns: [turn({ id: "a0", role: "assistant", order: 0, text: "OLD", endControl: readyEnd })],
      stop: false,
    });
    const missingEnd = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "MAYBE" }),
      ],
      stop: false,
    });
    const unreadableError = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "MAYBE", endControl: readyEnd }),
      ],
      stop: false,
      errorUnreadable: true,
    });
    for (const reads of [
      [evidence({ turns: [turn({ id: "a0", role: "assistant", order: 0, text: "OLD", endControl: readyEnd })] }), oldOnly, oldOnly],
      [evidence({}), evidence({}), missingEnd, missingEnd, missingEnd, missingEnd, missingEnd, missingEnd],
      [evidence({}), unreadableError],
    ]) {
      const script = scripted(reads);
      const result = await runChatGptTurn(script.page, "问题", script.timing);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.notEqual(result.code, "stopped");
        assert.equal("body" in result, false);
      }
    }
  });

  it("未确认新用户轮次时，不收旧回复、重挂载或最后节点", async () => {
    const baseline = evidence({
      turns: [
        turn({ id: "u0", role: "user", order: 0 }),
        turn({ id: "a0", role: "assistant", order: 1, text: "OLD_SECRET" }),
      ],
    });
    const remount = evidence({
      turns: [
        turn({ id: "a0", role: "assistant", order: 0, text: "OLD_SECRET", endControl: readyEnd }),
        turn({ id: "u0", role: "user", order: 1 }),
      ],
    });
    const script = scripted([baseline, remount, remount, remount]);
    const result = await runChatGptTurn(script.page, "问题", { ...script.timing, polls: 3 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(script.requested.some((ids) => ids.includes("a0")), false);
    assert.equal(JSON.stringify(result).includes("OLD_SECRET"), false);
  });

  it("同文问题或其他轮次的新回复不能靠文本绑定", async () => {
    const baseline = evidence({
      turns: [turn({ id: "u0", role: "user", order: 0 }), turn({ id: "a0", role: "assistant", order: 1, text: "SAME" })],
    });
    const twoUsers = evidence({
      turns: [
        turn({ id: "u0", role: "user", order: 0 }),
        turn({ id: "u1", role: "user", order: 1 }),
        turn({ id: "u2", role: "user", order: 2 }),
        turn({ id: "a9", role: "assistant", order: 3, text: "SAME", endControl: readyEnd }),
      ],
    });
    const script = scripted([baseline, baseline, twoUsers]);
    const result = await runChatGptTurn(script.page, "SAME", script.timing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(JSON.stringify(result).includes("SAME"), false);
  });

  it("明确的停止点击之后，残文稳定也不算正常结束", async () => {
    const done = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "残文", endControl: readyEnd }),
      ],
    });
    const script = scripted([evidence({}), done, done], {
      wait({ submitted, fireStop }) {
        if (submitted) fireStop();
      },
    });
    const result = await runChatGptTurn(script.page, "问题", script.timing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "stopped");
    assert.equal(JSON.stringify(result).includes("残文"), false);
  });

  it("没观察到停止动作时，结束信号消失不会被猜成手停或成功", async () => {
    const fading = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "含糊" }),
      ],
      stop: false,
    });
    const script = scripted([
      evidence({}),
      evidence({}),
      evidence({
        stop: true,
        turns: [
          turn({ id: "u1", role: "user", order: 0 }),
          turn({ id: "a1", role: "assistant", order: 1, text: "含糊" }),
        ],
      }),
      fading,
      fading,
      fading,
      fading,
    ]);
    const result = await runChatGptTurn(script.page, "问题", { ...script.timing, polls: 4 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unknown");
    }
    assert.equal(JSON.stringify(result).includes("含糊"), false);
  });

  it("新聊天地址能用同一新用户轮次证明连续，证明不了则未知，换会话则隔离", async () => {
    const born = evidence({
      turns: [turn({ id: "u1", role: "user", order: 0 })],
    });
    const extended = evidence({
      url: "https://chatgpt.com/c/new-chat",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "连续", endControl: readyEnd }),
      ],
    });
    const continued = scripted([evidence({}), evidence({}), born, extended, extended, extended]);
    const continuedResult = await runChatGptTurn(continued.page, "问题", continued.timing);
    assert.deepEqual(continuedResult, { ok: true, body: "连续" });

    const unproven = scripted([
      evidence({}),
      evidence({}),
      evidence({
        url: "https://chatgpt.com/c/old-chat",
        turns: [
          turn({ id: "u-old", role: "user", order: 0 }),
          turn({ id: "a-old", role: "assistant", order: 1, text: "旧会话", endControl: readyEnd }),
        ],
      }),
    ]);
    const unprovenResult = await runChatGptTurn(unproven.page, "问题", unproven.timing);
    assert.equal(unprovenResult.ok, false);
    if (!unprovenResult.ok) assert.equal(unprovenResult.code, "unknown");
    assert.equal(JSON.stringify(unprovenResult).includes("旧会话"), false);

    const switched = scripted([
      evidence({ url: "https://chatgpt.com/c/aaa" }),
      evidence({ url: "https://chatgpt.com/c/aaa" }),
      evidence({
        url: "https://chatgpt.com/c/bbb",
        turns: [turn({ id: "u9", role: "user", order: 0 }), turn({ id: "a9", role: "assistant", order: 1, text: "LEAK", endControl: readyEnd })],
      }),
    ]);
    const switchedResult = await runChatGptTurn(switched.page, "问题", switched.timing);
    assert.equal(switchedResult.ok, false);
    if (!switchedResult.ok) assert.equal(switchedResult.code, "navigation");
    assert.equal(JSON.stringify(switchedResult).includes("LEAK"), false);
  });

  it("已识别临时地址只等待，已有草稿轮次延续到正式地址后仍可完成", async () => {
    const born = evidence({ turns: [turn({ id: "u1", role: "user", order: 0 })] });
    const provisional = evidence({
      url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1",
      turns: [turn({ id: "u1", role: "user", order: 0 })],
    });
    const formal = evidence({
      url: "https://chatgpt.com/c/final_1",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "OK", endControl: readyEnd }),
      ],
    });
    const script = scripted([evidence({}), evidence({}), born, provisional, formal, formal, formal]);
    const result = await runChatGptTurn(script.page, "问题", script.timing);
    assert.deepEqual(result, { ok: true, body: "OK" });
    assert.equal(script.submits(), 1);
  });

  it("临时地址未结束时到期为未知，切到另一临时 token 也不得成功", async () => {
    const first = evidence({ url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1" });
    const forever = scripted([evidence({}), evidence({}), first]);
    const timedOut = await runChatGptTurn(forever.page, "问题", { ...forever.timing, polls: 2 });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) {
      assert.equal(timedOut.code, "unknown");
      assert.notEqual(timedOut.message, "会话地址无法套用连续性规则");
    }

    const changed = evidence({ url: "https://chatgpt.com/c/local-chatgpt%3Atemp_2" });
    const conflict = scripted([evidence({}), evidence({}), first, changed]);
    const conflicted = await runChatGptTurn(conflict.page, "问题", conflict.timing);
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) {
      assert.equal(conflicted.code, "unknown");
      assert.equal(conflicted.message, "临时会话地址发生冲突，不能确定连续性");
    }
    assert.equal(conflict.submits(), 1);
  });

  it("临时地址上出现多个新用户轮次后，即使正式页只剩一个也不得成功", async () => {
    const born = evidence({ turns: [turn({ id: "u1", role: "user", order: 0 })] });
    const conflicted = evidence({
      url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1",
      turns: [turn({ id: "u1", role: "user", order: 0 }), turn({ id: "u2", role: "user", order: 1 })],
    });
    const formal = evidence({
      url: "https://chatgpt.com/c/final_1",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "OK", endControl: readyEnd }),
      ],
    });
    const script = scripted([evidence({}), evidence({}), born, conflicted, formal, formal, formal]);
    const result = await runChatGptTurn(script.page, "问题", script.timing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
  });

  it("临时地址上的用户或回复身份冲突不得在正式页消失后变成成功", async () => {
    const born = evidence({ turns: [turn({ id: "u1", role: "user", order: 0 })] });
    const formal = evidence({
      url: "https://chatgpt.com/c/final_1",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "OK", endControl: readyEnd }),
      ],
    });
    const otherUser = evidence({
      url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1",
      turns: [turn({ id: "u2", role: "user", order: 0 })],
    });
    const otherAssistant = evidence({
      url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a2", role: "assistant", order: 1, text: "OTHER", endControl: readyEnd }),
      ],
    });
    for (const reads of [
      [born, otherUser, formal, formal, formal],
      [born, evidence({ turns: formal.turns.state === "ready" ? formal.turns.value : [] }), otherAssistant, formal, formal, formal],
    ]) {
      const script = scripted([evidence({}), evidence({}), ...reads]);
      const result = await runChatGptTurn(script.page, "问题", script.timing);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "unknown");
    }
  });

  it("经过临时地址后，正式页不能沿用草稿页的正文稳定计数", async () => {
    const born = evidence({ turns: [turn({ id: "u1", role: "user", order: 0 })] });
    const draftDone = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "OK", endControl: readyEnd }),
      ],
    });
    const provisional = evidence({
      url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1",
      turns: [turn({ id: "u1", role: "user", order: 0 })],
    });
    const formal = evidence({
      url: "https://chatgpt.com/c/final_1",
      turns: draftDone.turns.state === "ready" ? draftDone.turns.value : [],
    });
    const script = scripted([evidence({}), evidence({}), born, draftDone, draftDone, draftDone, provisional, formal]);
    const result = await runChatGptTurn(script.page, "问题", { ...script.timing, stableChecks: 3 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
  });

  it("临时地址不能证明新会话归属，发送前已在临时地址也不得提交", async () => {
    const provisional = evidence({ url: "https://chatgpt.com/c/local-chatgpt%3Atemp_1" });
    const formal = evidence({
      url: "https://chatgpt.com/c/final_1",
      turns: [turn({ id: "u1", role: "user", order: 0 })],
    });
    const unproven = scripted([evidence({}), evidence({}), provisional, formal]);
    const result = await runChatGptTurn(unproven.page, "问题", unproven.timing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");

    const beforeSend = scripted([provisional]);
    const blocked = await runChatGptTurn(beforeSend.page, "问题", beforeSend.timing);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "unknown");
    assert.equal(beforeSend.writes(), 0);
    assert.equal(beforeSend.submits(), 0);
  });

  it("点击了发送但没有新用户轮次时不收正文；控件缺失不会发送", async () => {
    const baseline = evidence({ turns: [turn({ id: "u0", role: "user", order: 0 })] });
    const script = scripted([baseline, baseline, baseline]);
    const result = await runChatGptTurn(script.page, "问题", { ...script.timing, polls: 2 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(script.submits(), 1);

    const missingSend = scripted([evidence({})], { submits: false });
    const sendResult = await runChatGptTurn(missingSend.page, "问题", missingSend.timing);
    assert.equal(sendResult.ok, false);
    if (!sendResult.ok) assert.equal(sendResult.code, "send_missing");

    const busy = scripted([evidence({ stop: true })]);
    const busyResult = await runChatGptTurn(busy.page, "问题", busy.timing);
    assert.equal(busyResult.ok, false);
    if (!busyResult.ok) assert.equal(busyResult.code, "busy");
    assert.equal(busy.writes(), 0);
    assert.equal(busy.submits(), 0);
  });

  it("读取失败、页面错误、身份冲突和空正文都不会变成成功", async () => {
    const exploding: ChatGptEvidencePort = {
      read() {
        throw new Error("SECRET_DOM");
      },
      writePrompt() {
        return true;
      },
      submit() {
        return true;
      },
      watchStop() {
        return () => undefined;
      },
    };
    const exploded = await runChatGptTurn(exploding, "问题", timing);
    assert.equal(exploded.ok, false);
    if (!exploded.ok) assert.equal(exploded.code, "unknown");
    assert.equal(JSON.stringify(exploded).includes("SECRET_DOM"), false);

    const errored = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "NO", endControl: readyEnd }),
      ],
      error: "present",
    });
    const errorScript = scripted([evidence({}), errored]);
    const errorResult = await runChatGptTurn(errorScript.page, "问题", errorScript.timing);
    assert.equal(errorResult.ok, false);
    if (!errorResult.ok) assert.equal(errorResult.code, "page_error");

    const empty = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "  ", endControl: readyEnd }),
      ],
    });
    const emptyScript = scripted([evidence({}), evidence({}), empty, empty, empty]);
    const emptyResult = await runChatGptTurn(emptyScript.page, "问题", { ...emptyScript.timing, polls: 3 });
    assert.equal(emptyResult.ok, false);
    if (!emptyResult.ok) assert.equal(emptyResult.code, "empty_response");

    const huge = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({
          id: "a1",
          role: "assistant",
          order: 1,
          text: "x".repeat(MAX_MESSAGE_BODY_CHARS + 1),
          endControl: readyEnd,
        }),
      ],
    });
    const hugeScript = scripted([evidence({}), evidence({}), huge, huge]);
    const hugeResult = await runChatGptTurn(hugeScript.page, "问题", { ...hugeScript.timing, stableChecks: 1 });
    assert.equal(hugeResult.ok, false);
    if (!hugeResult.ok) assert.equal(hugeResult.code, "response_too_large");
  });

  it("外层取消会停止后续采集，晚到的完成证据不会变成结果，下一轮不受污染", async () => {
    const late = evidence({
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "a1", role: "assistant", order: 1, text: "LATE", endControl: readyEnd }),
      ],
    });
    const first = scripted([evidence({}), late, late], {
      wait() {
        return undefined;
      },
    });
    const controller = new AbortController();
    first.timing.wait = (signal) => abortableDelay(5_000, signal);
    const pending = runChatGptTurn(first.page, "第一问", first.timing, controller.signal);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, "cancelled");
    assert.equal(first.disarmed(), 0);
    assert.equal(JSON.stringify(cancelled).includes("LATE"), false);

    const secondReads = [
      evidence({
        turns: [
          turn({ id: "u1", role: "user", order: 0 }),
          turn({ id: "a1", role: "assistant", order: 1, text: "LATE", endControl: readyEnd }),
        ],
      }),
      evidence({
        turns: [
          turn({ id: "u1", role: "user", order: 0 }),
          turn({ id: "a1", role: "assistant", order: 1, text: "LATE", endControl: readyEnd }),
          turn({ id: "u2", role: "user", order: 2 }),
          turn({ id: "a2", role: "assistant", order: 3, text: "SECOND", endControl: readyEnd }),
        ],
      }),
    ];
    const second = scripted([secondReads[0]!, secondReads[0]!, secondReads[1]!, secondReads[1]!, secondReads[1]!]);
    const next = await runChatGptTurn(second.page, "第二问", second.timing);
    assert.deepEqual(next, { ok: true, body: "SECOND" });
    assert.equal(second.requested.some((ids) => ids.includes("a1")), false);
  });

  it("发送前出现的外来轮次和未对上的旧发送迟到，都不能当成这次回复", async () => {
    const foreign = evidence({
      turns: [
        turn({ id: "u-foreign", role: "user", order: 0 }),
        turn({ id: "a-foreign", role: "assistant", order: 1, text: "外来", endControl: readyEnd }),
      ],
    });
    const ours = evidence({
      turns: [
        turn({ id: "u-foreign", role: "user", order: 0 }),
        turn({ id: "a-foreign", role: "assistant", order: 1, text: "外来", endControl: readyEnd }),
        turn({ id: "u-ours", role: "user", order: 2 }),
        turn({ id: "a-ours", role: "assistant", order: 3, text: "本次", endControl: readyEnd }),
      ],
    });
    const script = scripted([evidence({}), foreign, ours, ours, ours]);
    const result = await runChatGptTurn(script.page, "同一个问题", script.timing);
    assert.deepEqual(result, { ok: true, body: "本次" });
    assert.equal(script.requested.some((ids) => ids.includes("a-foreign")), false);

    const onlyForeign = scripted([evidence({}), foreign, foreign, foreign]);
    const missed = await runChatGptTurn(onlyForeign.page, "同一个问题", { ...onlyForeign.timing, polls: 2 });
    assert.equal(missed.ok, false);
    assert.equal(JSON.stringify(missed).includes("外来"), false);

    const ledger = { unmatched: 1, pendingConversationId: null };
    const late = evidence({
      turns: [
        turn({ id: "u-late", role: "user", order: 0 }),
        turn({ id: "a-late", role: "assistant", order: 1, text: "迟到", endControl: readyEnd }),
      ],
    });
    const lateScript = scripted([evidence({}), evidence({}), late, late]);
    const lateResult = await runChatGptTurn(lateScript.page, "第二问", lateScript.timing, new AbortController().signal, ledger);
    assert.equal(lateResult.ok, false);
    if (!lateResult.ok) assert.equal(lateResult.code, "unknown");
    assert.equal(lateScript.writes(), 0);
    assert.equal(lateScript.submits(), 0);
    assert.equal(JSON.stringify(lateResult).includes("迟到"), false);
  });

  it("取消后的未匹配发送不会在同一会话重发，切换到独立会话才恢复", async () => {
    const ledger = createSendLedger();
    const controller = new AbortController();
    const onA = evidence({ url: "https://chatgpt.com/c/A" });
    const first = scripted([onA, onA], {
      wait({ submitted }) {
        if (submitted) controller.abort();
      },
    });
    const cancelled = await runChatGptTurn(first.page, "第一问", first.timing, controller.signal, ledger);
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, "cancelled");
    assert.equal(first.submits(), 1);

    const late = evidence({
      url: "https://chatgpt.com/c/A",
      turns: [
        turn({ id: "u-late", role: "user", order: 0 }),
        turn({ id: "a-late", role: "assistant", order: 1, text: "LATE", endControl: readyEnd }),
      ],
    });
    const sameConversation = scripted([late, late, late]);
    const blocked = await runChatGptTurn(sameConversation.page, "第二问", sameConversation.timing, new AbortController().signal, ledger);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "unknown");
    assert.equal(sameConversation.writes(), 0);
    assert.equal(sameConversation.submits(), 0);
    assert.equal(JSON.stringify(blocked).includes("LATE"), false);

    const onB = evidence({ url: "https://chatgpt.com/c/B" });
    const done = evidence({
      url: "https://chatgpt.com/c/B",
      turns: [
        turn({ id: "u-b", role: "user", order: 0 }),
        turn({ id: "a-b", role: "assistant", order: 1, text: "B", endControl: readyEnd }),
      ],
    });
    const separateConversation = scripted([onB, onB, done, done, done]);
    const recovered = await runChatGptTurn(separateConversation.page, "新会话问题", separateConversation.timing, new AbortController().signal, ledger);
    assert.deepEqual(recovered, { ok: true, body: "B" });
    assert.equal(separateConversation.submits(), 1);
    assert.equal(ledger.unmatched, 0);
  });

  it("输入后、提交前换会话时不得把问题发送到新会话", async () => {
    const onA = evidence({ url: "https://chatgpt.com/c/A" });
    const onB = evidence({ url: "https://chatgpt.com/c/B" });
    const script = scripted([onA, onB, onB]);
    const result = await runChatGptTurn(script.page, "问题", script.timing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "navigation");
    assert.equal(script.submits(), 0);
  });

  it("钉住 /c/A 之后再进入 B 会隔离", async () => {
    const born = evidence({ turns: [turn({ id: "u1", role: "user", order: 0 })] });
    const onA = evidence({
      url: "https://chatgpt.com/c/A",
      turns: [turn({ id: "u1", role: "user", order: 0 })],
    });
    const onB = evidence({
      url: "https://chatgpt.com/c/B",
      turns: [
        turn({ id: "u1", role: "user", order: 0 }),
        turn({ id: "uB", role: "user", order: 1 }),
        turn({ id: "aB", role: "assistant", order: 2, text: "B的正文", endControl: readyEnd }),
      ],
    });
    const script = scripted([evidence({}), evidence({}), born, onA, onB]);
    const result = await runChatGptTurn(script.page, "问题", { ...script.timing, polls: 3 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "navigation");
    assert.equal(JSON.stringify(result).includes("B的正文"), false);
  });

  it("空问题、缺少输入框，以及写入后等待再提交的顺序仍然成立", async () => {
    const idle = evidence({});
    const events: string[] = [];
    const page: ChatGptEvidencePort = {
      read() {
        return idle;
      },
      writePrompt() {
        events.push("write");
        return true;
      },
      submit() {
        events.push("submit");
        return false;
      },
      watchStop() {
        return () => undefined;
      },
    };
    const timing: ChatGptTurnTiming = {
      polls: 1,
      stableChecks: 1,
      async wait() {
        events.push("wait");
      },
    };
    const empty = await runChatGptTurn(page, "   ", timing);
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "invalid_request");
    assert.deepEqual(events, []);

    const missingInput: ChatGptEvidencePort = { ...page, writePrompt: () => false };
    const missing = await runChatGptTurn(missingInput, "问题", timing);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "prompt_missing");

    const ordered = await runChatGptTurn(page, "问题", timing);
    assert.equal(ordered.ok, false);
    if (!ordered.ok) assert.equal(ordered.code, "send_missing");
    assert.deepEqual(events, ["write", "wait", "submit"]);
  });

  it("地址规则只承认根路径、正式会话和指定临时形状，不猜测其他路径", () => {
    assert.deepEqual(parseSessionUrl("https://chatgpt.com/"), { state: "ready", kind: "draft" });
    assert.deepEqual(parseSessionUrl("https://chatgpt.com/c/abc"), { state: "ready", kind: "conversation", id: "abc" });
    assert.deepEqual(parseSessionUrl("https://chatgpt.com/c/local-chatgpt%3Atemp_1"), {
      state: "ready", kind: "provisional", token: "temp_1",
    });
    assert.deepEqual(parseSessionUrl("https://chatgpt.com/c/local-chatgpt%3atemp_1"), {
      state: "ready", kind: "provisional", token: "temp_1",
    });
    for (const path of ["/c/local-chatgpt%3A", "/c/local-chatgpt%3Atemp%2Fbad", "/c/other%3Atemp", "/c/LOCAL-chatgpt%3Atemp_1"]) {
      assert.deepEqual(parseSessionUrl(`https://chatgpt.com${path}`), { state: "ready", kind: "unrecognized" });
    }
    const unrecognized = parseSessionUrl("https://chatgpt.com/gpts");
    assert.equal(unrecognized.state, "ready");
    if (unrecognized.state === "ready") {
      assert.equal(unrecognized.kind, "unrecognized");
    }
    const draft = parseSessionUrl("https://chatgpt.com/");
    const next = parseSessionUrl("https://chatgpt.com/c/abc");
    const born = [turn({ id: "u1", role: "user", order: 0 })];
    assert.equal(relateSession(draft, next, "u1", born), "extended");
    assert.equal(relateSession(draft, next, null, born), "unproven");
    assert.equal(
      relateSession(parseSessionUrl("https://chatgpt.com/c/aaa"), parseSessionUrl("https://chatgpt.com/c/bbb"), "u1", born),
      "switched",
    );
  });
});
