import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import type { ChatGptAskResult } from "./chatgpt-connector.js";
import {
  assessBaseline,
  assessPoll,
  deadlineResult,
  memoryFromBaseline,
  relateSession,
  type ChatGptEvidencePort,
  type TerminalCode,
} from "./chatgpt-evidence.js";

export interface ChatGptTurnTiming {
  polls: number;
  stableChecks: number;
  wait(signal: AbortSignal): Promise<void>;
}

export const DEFAULT_CHATGPT_TIMING: ChatGptTurnTiming = {
  polls: 240,
  stableChecks: 3,
  wait: (signal) => abortableDelay(250, signal),
};

/** 同一标签页上尚未对上新用户轮次的发送次数。不是页面身份，只用来拒绝含糊归属。 */
export interface SendLedger {
  unmatched: number;
  pendingConversationId: string | null;
}

export function createSendLedger(): SendLedger {
  return { unmatched: 0, pendingConversationId: null };
}

export async function runChatGptTurn(
  page: ChatGptEvidencePort,
  prompt: string,
  timing: ChatGptTurnTiming = DEFAULT_CHATGPT_TIMING,
  signal: AbortSignal = new AbortController().signal,
  ledger: SendLedger = createSendLedger(),
  roundtablePrompt = false,
): Promise<ChatGptAskResult> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    return failure("invalid_request", "问题为空或超过长度上限");
  }
  if (signal.aborted) {
    return failure("cancelled", "采集已取消，不会再发送或提交结果");
  }

  let stopClicked = false;
  let disarm = () => undefined as void;
  try {
    const baseline = page.read({ textTurnIds: [] });
    const blocked = assessBaseline(baseline);
    if (blocked) {
      return failure(blocked.code, blocked.message);
    }
    if (ledger.unmatched > 0) {
      const movedAway = ledger.pendingConversationId
        && baseline.session.state === "ready"
        && baseline.session.kind === "conversation"
        && baseline.session.id !== ledger.pendingConversationId;
      if (!movedAway) {
        return failure("unknown", "上一轮发送尚未对上回复，已阻止再次发送");
      }
      ledger.unmatched = 0;
      ledger.pendingConversationId = null;
    }
    if (!page.writePrompt(trimmed)) {
      return failure("prompt_missing", "未找到 ChatGPT 输入框");
    }
    await timing.wait(signal);
    if (signal.aborted) {
      return failure("cancelled", "采集已取消，不会再发送或提交结果");
    }
    const draft = page.readPrompt();
    if (draft !== trimmed && !(roundtablePrompt && matchesRoundtableLineBreakNormalization(trimmed, draft))) {
      return failure("prompt_changed", "ChatGPT 草稿在发送前发生变化，未发送问题");
    }
    const committed = page.read({ textTurnIds: [] });
    const blockedAgain = assessBaseline(committed);
    if (blockedAgain) {
      return failure(blockedAgain.code, blockedAgain.message);
    }
    const continuity = relateSession(baseline.session, committed.session, null, []);
    if (continuity !== "same") {
      return failure(continuity === "switched" ? "navigation" : "unknown", "输入后会话身份变化，未发送问题");
    }
    if (!page.submit()) {
      return failure("send_missing", "未找到可用的 ChatGPT 发送按钮");
    }
    ledger.unmatched += 1;
    ledger.pendingConversationId = committed.session.state === "ready" && committed.session.kind === "conversation"
      ? committed.session.id
      : null;
    const canAttribute = ledger.unmatched === 1;
    disarm = page.watchStop(() => {
      stopClicked = true;
    });

    let memory = memoryFromBaseline(committed, timing.stableChecks);
    let textTurnIds: string[] = [];
    for (let poll = 0; poll < timing.polls; poll += 1) {
      await timing.wait(signal);
      if (signal.aborted) {
        return failure("cancelled", "采集已取消，不会再发送或提交结果");
      }
      const evidence = page.read({ textTurnIds });
      const assessment = assessPoll(memory, evidence, stopClicked, textTurnIds, canAttribute);
      if (assessment.kind === "success") {
        ledger.unmatched = Math.max(0, ledger.unmatched - 1);
        ledger.pendingConversationId = null;
        return { ok: true, body: assessment.body };
      }
      if (assessment.kind === "terminal") {
        return failure(assessment.code, assessment.message);
      }
      memory = assessment.memory;
      textTurnIds = memory.attributedAssistantId ? [memory.attributedAssistantId] : [];
    }
    const deadline = deadlineResult(memory);
    return failure(deadline.code, deadline.message);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("cancelled", "采集已取消，不会再发送或提交结果");
    }
    return failure("unknown", "页面证据读取失败");
  } finally {
    disarm();
  }
}

function matchesRoundtableLineBreakNormalization(expected: string, actual: string | null): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let normalizedLineBreak = false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === actual[index]) continue;
    if (expected[index] === "\n" && actual[index] === " ") {
      normalizedLineBreak = true;
      continue;
    }
    return false;
  }
  return normalizedLineBreak;
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function failure(code: TerminalCode | "invalid_request" | "prompt_missing" | "prompt_changed" | "send_missing" | "cancelled", message: string): ChatGptAskResult {
  return { ok: false, code, message };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
