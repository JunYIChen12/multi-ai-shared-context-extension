import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import type { ChatGptAskResult } from "./chatgpt-connector.js";
import {
  assessBaseline,
  assessPoll,
  deadlineResult,
  memoryFromBaseline,
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

export async function runChatGptTurn(
  page: ChatGptEvidencePort,
  prompt: string,
  timing: ChatGptTurnTiming = DEFAULT_CHATGPT_TIMING,
  signal: AbortSignal = new AbortController().signal,
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
    disarm = page.watchStop(() => {
      stopClicked = true;
    });
    const baseline = page.read({ textTurnIds: [] });
    const blocked = assessBaseline(baseline);
    if (blocked) {
      return failure(blocked.code, blocked.message);
    }
    if (!page.writePrompt(trimmed)) {
      return failure("prompt_missing", "未找到 ChatGPT 输入框");
    }
    await timing.wait(signal);
    if (signal.aborted) {
      return failure("cancelled", "采集已取消，不会再发送或提交结果");
    }
    if (stopClicked) {
      return failure("stopped", "已观察到本轮停止动作，残留文本不算正常结束");
    }
    if (!page.submit()) {
      return failure("send_missing", "未找到可用的 ChatGPT 发送按钮");
    }

    let memory = memoryFromBaseline(baseline, timing.stableChecks);
    let textTurnIds: string[] = [];
    for (let poll = 0; poll < timing.polls; poll += 1) {
      await timing.wait(signal);
      if (signal.aborted) {
        return failure("cancelled", "采集已取消，不会再发送或提交结果");
      }
      const evidence = page.read({ textTurnIds });
      const assessment = assessPoll(memory, evidence, stopClicked, textTurnIds);
      if (assessment.kind === "success") {
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

function failure(code: TerminalCode | "invalid_request" | "prompt_missing" | "send_missing" | "cancelled", message: string): ChatGptAskResult {
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
