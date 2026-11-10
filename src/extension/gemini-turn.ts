import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import { GEMINI_OUTER_TIMEOUT_MS, type GeminiAskResult, type GeminiErrorCode } from "./gemini-connector.js";
import type { GeminiPageBaseline, GeminiPagePort, GeminiPageSnapshot, GeminiRoute } from "./gemini-dom.js";

export interface GeminiTurnTiming {
  polls: number;
  wait(signal: AbortSignal): Promise<void>;
}

export const DEFAULT_GEMINI_TIMING: GeminiTurnTiming = {
  polls: Math.floor(GEMINI_OUTER_TIMEOUT_MS / 250),
  wait: (signal) => abortableDelay(250, signal),
};

export async function runGeminiTurn(
  page: GeminiPagePort,
  prompt: string,
  signal: AbortSignal = new AbortController().signal,
  timing: GeminiTurnTiming = DEFAULT_GEMINI_TIMING,
): Promise<GeminiAskResult> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    return failure("invalid_request", "问题为空或超过长度上限");
  }
  if (signal.aborted) return cancelled();

  let disarm = () => undefined as void;
  let stopClicked = false;
  let conversationId: string | null = null;
  try {
    const baseline = page.read(trimmed);
    if (baseline.route.kind === "invalid") return failure("navigation", "当前不是可识别的 Gemini 对话页");
    conversationId = baseline.route.kind === "conversation" ? baseline.route.id : null;
    if (baseline.pageError) return failure("page_error", "Gemini 页面报告错误");
    if (baseline.stopVisible || hasPending(baseline)) return failure("busy", "Gemini 当前已有进行中的请求");
    if (!page.writePrompt(trimmed)) return failure("prompt_missing", "未找到可用的 Gemini 输入框");

    await timing.wait(signal);
    if (signal.aborted) return cancelled();
    if (page.readPrompt() !== trimmed) {
      return failure("prompt_changed", "Gemini 草稿在发送前发生变化，未发送问题");
    }
    const beforeSend = page.read(trimmed, pageBaseline(baseline));
    if (beforeSend.pageError) return failure("page_error", "Gemini 页面报告错误");
    if (!sameRoute(baseline.route, beforeSend.route)) {
      return failure("navigation", "发送前 Gemini 会话身份变化，未发送问题");
    }
    if (!sameStructure(baseline, beforeSend)) {
      return failure("ambiguous_turn", "发送前 Gemini 页面结构发生变化，未发送问题");
    }
    if (!page.submit()) return failure("send_missing", "未找到可用的 Gemini 发送按钮");

    disarm = page.watchStop(() => { stopClicked = true; });
    for (let poll = 0; poll < timing.polls; poll += 1) {
      await timing.wait(signal);
      if (signal.aborted) return cancelled();
      if (stopClicked) return failure("stopped", "Gemini 回复已手动停止");
      const current = page.read(trimmed, pageBaseline(baseline));
      if (current.route.kind === "invalid") {
        return failure("navigation", "Gemini 会话已切换，未采信页面内容");
      }
      if (current.route.kind === "conversation") {
        if (conversationId !== null && conversationId !== current.route.id) {
          return failure("navigation", "Gemini 会话已切换，未采信页面内容");
        }
        conversationId = current.route.id;
      } else if (conversationId !== null) {
        return failure("navigation", "Gemini 会话已切换，未采信页面内容");
      }
      if (current.pageError) return failure("page_error", "Gemini 页面报告错误");
      const result = assessProgress(baseline, current);
      if (result.kind === "failure") return failure(result.code, result.message);
      if (result.kind === "success") return { ok: true, body: result.body };
    }
    return failure("timeout", "Gemini 六分钟内未出现完整结束证据");
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return cancelled();
    return failure("unknown", "Gemini 页面证据读取失败");
  } finally {
    disarm();
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
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

function assessProgress(
  baseline: GeminiPageSnapshot,
  current: GeminiPageSnapshot,
): { kind: "waiting" } | { kind: "success"; body: string } | { kind: "failure"; code: GeminiErrorCode; message: string } {
  if (current.conversations.length < baseline.conversations.length) {
    return { kind: "failure", code: "ambiguous_turn", message: "Gemini 页面移除了本次归属所需的轮次结构" };
  }

  let newUsers = 0;
  let newPromptMatches = 0;
  let candidateIndex = -1;
  for (let index = 0; index < current.conversations.length; index += 1) {
    const currentTurn = current.conversations[index];
    if (!currentTurn) continue;
    const oldTurn = baseline.conversations[index];
    const oldUsers = oldTurn?.userQueryCount ?? 0;
    const oldMatches = oldTurn?.promptMatches ?? 0;
    const oldPendingRequests = oldTurn?.pendingRequests ?? 0;
    const oldPendingResponses = oldTurn?.pendingResponses ?? 0;
    const oldModels = oldTurn?.modelResponseCount ?? 0;
    const userDelta = currentTurn.userQueryCount - oldUsers;
    const promptDelta = currentTurn.promptMatches - oldMatches;
    const requestDelta = currentTurn.pendingRequests - oldPendingRequests;
    const pendingDelta = currentTurn.pendingResponses - oldPendingResponses;
    const modelDelta = currentTurn.modelResponseCount - oldModels;
    if (userDelta < 0 || promptDelta < 0 || requestDelta < 0 || pendingDelta < 0 || modelDelta < 0) {
      return { kind: "failure", code: "ambiguous_turn", message: "Gemini 轮次结构与发送前基线冲突" };
    }
    if (userDelta !== promptDelta || promptDelta > 1) {
      return { kind: "failure", code: "ambiguous_turn", message: "发现无法归属到本次问题的新用户轮次" };
    }
    newUsers += userDelta;
    newPromptMatches += promptDelta;
    if (promptDelta === 1) {
      if (candidateIndex !== -1) {
        return { kind: "failure", code: "ambiguous_turn", message: "发现多个符合本次问题的 Gemini 轮次" };
      }
      candidateIndex = index;
    } else if (modelDelta > 0) {
      return { kind: "failure", code: "ambiguous_turn", message: "Gemini 回复没有对应的新用户问题" };
    }
    if ((requestDelta > 0 || pendingDelta > 0) && promptDelta === 0) {
      return { kind: "failure", code: "ambiguous_turn", message: "发现与本次问题无关的 Gemini 请求" };
    }
    if (modelDelta > 1) {
      return { kind: "failure", code: "ambiguous_turn", message: "本次 Gemini 轮次出现多个模型回复" };
    }
    if (requestDelta > 1 || pendingDelta > 1 || ((requestDelta > 0 || pendingDelta > 0) && modelDelta > 0)) {
      return { kind: "failure", code: "ambiguous_turn", message: "本次 Gemini 轮次的等待与回复证据冲突" };
    }
  }

  if (newUsers > 1 || newPromptMatches > 1) {
    return { kind: "failure", code: "ambiguous_turn", message: "本次发送期间出现多个新用户轮次" };
  }
  if (candidateIndex === -1) return { kind: "waiting" };

  const candidate = current.conversations[candidateIndex];
  const oldCandidate = baseline.conversations[candidateIndex];
  if (!candidate) return { kind: "waiting" };
  if (candidate.pendingRequests > (oldCandidate?.pendingRequests ?? 0) ||
      candidate.pendingResponses > (oldCandidate?.pendingResponses ?? 0)) {
    return { kind: "waiting" };
  }
  if (candidate.modelResponseCount === (oldCandidate?.modelResponseCount ?? 0)) return { kind: "waiting" };
  if (candidate.modelResponseCount !== (oldCandidate?.modelResponseCount ?? 0) + 1 || candidate.modelResponses.length !== 1) {
    return { kind: "failure", code: "ambiguous_turn", message: "本次新用户问题无法对应到唯一模型回复" };
  }

  const response = candidate.modelResponses[0];
  if (!response) return { kind: "waiting" };
  if (response.responseInfo) {
    return { kind: "failure", code: "page_error", message: "Gemini 回复包含页面状态信息，不能确认为完成" };
  }
  if (response.body.length > MAX_MESSAGE_BODY_CHARS) {
    return { kind: "failure", code: "response_too_large", message: "Gemini 回复超过长度上限" };
  }
  if (!response.body.trim() || !response.completeFooter || !response.messageActions || response.ariaBusy || current.stopVisible) {
    return { kind: "waiting" };
  }
  return { kind: "success", body: response.body };
}

function pageBaseline(snapshot: GeminiPageSnapshot): GeminiPageBaseline {
  return {
    promptMatches: snapshot.conversations.map((conversation) => conversation.promptMatches),
    modelResponseCounts: snapshot.conversations.map((conversation) => conversation.modelResponseCount),
    completeFooterCounts: snapshot.conversations.map((conversation) => conversation.completeFooterCount),
    messageActionsCounts: snapshot.conversations.map((conversation) => conversation.messageActionsCount),
  };
}

function sameStructure(before: GeminiPageSnapshot, after: GeminiPageSnapshot): boolean {
  return before.conversations.length === after.conversations.length && before.conversations.every((turn, index) => {
    const next = after.conversations[index];
    return Boolean(next) && turn.userQueryCount === next?.userQueryCount &&
      turn.promptMatches === next.promptMatches &&
      turn.pendingRequests === next.pendingRequests &&
      turn.pendingResponses === next.pendingResponses &&
      turn.modelResponseCount === next.modelResponseCount &&
      turn.completeFooterCount === next.completeFooterCount &&
      turn.messageActionsCount === next.messageActionsCount;
  });
}

function sameRoute(before: GeminiRoute, after: GeminiRoute): boolean {
  if (before.kind === "draft" || after.kind === "draft") return before.kind === after.kind;
  return before.kind === "conversation" && after.kind === "conversation" && before.id === after.id;
}

function hasPending(snapshot: GeminiPageSnapshot): boolean {
  return snapshot.conversations.some((turn) => turn.pendingRequests > 0 || turn.pendingResponses > 0);
}

function failure(code: GeminiErrorCode, message: string): GeminiAskResult {
  return { ok: false, code, message };
}

function cancelled(): GeminiAskResult {
  return failure("cancelled", "采集已取消，不会再发送或提交结果");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
