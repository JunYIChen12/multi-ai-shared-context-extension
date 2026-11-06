import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import type { ChatGptAskResult } from "./chatgpt-connector.js";

export interface ChatGptPageStatus {
  assistantCount: number;
  isGenerating: boolean;
}

export interface ChatGptPagePort {
  status(): ChatGptPageStatus;
  writePrompt(prompt: string): boolean;
  submit(): boolean;
  latestAssistantText(): string;
}

export interface ChatGptTurnTiming {
  startChecks: number;
  completionChecks: number;
  stableChecks: number;
  wait(): Promise<void>;
}

export const DEFAULT_CHATGPT_TIMING: ChatGptTurnTiming = {
  startChecks: 40,
  completionChecks: 240,
  stableChecks: 3,
  wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
};

export async function runChatGptTurn(
  page: ChatGptPagePort,
  prompt: string,
  timing: ChatGptTurnTiming = DEFAULT_CHATGPT_TIMING,
): Promise<ChatGptAskResult> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    return failure("invalid_request", "问题为空或超过长度上限");
  }

  const baseline = page.status();
  if (baseline.isGenerating) {
    return failure("busy", "ChatGPT 页面仍在生成，请等待完成后重试");
  }
  if (!page.writePrompt(trimmed)) {
    return failure("prompt_missing", "未找到 ChatGPT 输入框");
  }
  await timing.wait();
  if (!page.submit()) {
    return failure("send_missing", "未找到可用的 ChatGPT 发送按钮");
  }

  let started = false;
  for (let check = 0; check < timing.startChecks; check += 1) {
    await timing.wait();
    const status = page.status();
    if (status.isGenerating || status.assistantCount > baseline.assistantCount) {
      started = true;
      break;
    }
  }
  if (!started) {
    return failure("start_timeout", "ChatGPT 未在限定时间内开始生成");
  }

  let lastText = "";
  let stableReads = 0;
  let sawCompleted = false;
  let sawNonEmpty = false;
  for (let check = 0; check < timing.completionChecks; check += 1) {
    await timing.wait();
    const status = page.status();
    if (status.isGenerating || status.assistantCount <= baseline.assistantCount) {
      stableReads = 0;
      continue;
    }

    sawCompleted = true;
    const text = page.latestAssistantText().trim();
    if (!text) {
      stableReads = 0;
      continue;
    }
    sawNonEmpty = true;
    if (text.length > MAX_MESSAGE_BODY_CHARS) {
      return failure("response_too_large", "ChatGPT 回复超过本地记录上限");
    }
    if (text === lastText) {
      stableReads += 1;
    } else {
      lastText = text;
      stableReads = 1;
    }
    if (stableReads >= timing.stableChecks) {
      return { ok: true, body: text };
    }
  }

  return sawCompleted && !sawNonEmpty
    ? failure("empty_response", "ChatGPT 已完成但回复为空")
    : failure("completion_timeout", "等待 ChatGPT 完成超时");
}

function failure(code: Exclude<ChatGptAskResult, { ok: true }>["code"], message: string): ChatGptAskResult {
  return { ok: false, code, message };
}
