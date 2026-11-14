import type { MessageStatus, ProviderAdapter, ProviderRequest, ProviderResponse } from "../core/types.js";
import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import { formatRoundtablePrompt } from "../core/context.js";

export const CHATGPT_CHANNEL = "multi-ai-chatgpt-v1" as const;

export type ChatGptErrorCode =
  | "busy"
  | "prompt_missing"
  | "prompt_changed"
  | "send_missing"
  | "start_timeout"
  | "completion_timeout"
  | "empty_response"
  | "response_too_large"
  | "invalid_request"
  | "invalid_response"
  | "connection_lost"
  | "unsupported_phase"
  | "unknown"
  | "stopped"
  | "navigation"
  | "page_error"
  | "cancelled"
  | "in_flight"
  | "prompt_too_large";

export interface ChatGptAskRequest {
  channel: typeof CHATGPT_CHANNEL;
  type: "ask";
  prompt: string;
  requestId: string;
}

export interface ChatGptCancelRequest {
  channel: typeof CHATGPT_CHANNEL;
  type: "cancel";
  requestId: string;
}

export type ChatGptAskResult =
  | { ok: true; body: string }
  | { ok: false; code: ChatGptErrorCode; message: string };

export interface ChatGptTransport {
  send(request: ChatGptAskRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface ChatGptTabMessagePort {
  sendToTab(tabId: number, request: ChatGptAskRequest | ChatGptCancelRequest): Promise<unknown>;
}

export interface ChatGptConnectionPort {
  getActiveTab(): Promise<{ id?: number; url?: string } | null>;
  injectScript(tabId: number, filename: string): Promise<void>;
  openDiscussion(path: string): Promise<void>;
}

export type ChatGptConnectionResult =
  | { ok: true }
  | { ok: false; code: "no_active_tab" | "not_chatgpt" | "connection_failed"; message: string };

const ERROR_CODES = new Set<ChatGptErrorCode>([
  "busy",
  "prompt_missing",
  "prompt_changed",
  "send_missing",
  "start_timeout",
  "completion_timeout",
  "empty_response",
  "response_too_large",
  "invalid_request",
  "invalid_response",
  "connection_lost",
  "unsupported_phase",
  "unknown",
  "stopped",
  "navigation",
  "page_error",
  "cancelled",
  "in_flight",
  "prompt_too_large",
]);

export function createChatGptAdapter(transport: ChatGptTransport): ProviderAdapter {
  return {
    id: "chatgpt",
    mode: "live",
    async respond(request, context): Promise<ProviderResponse> {
      if (request.phase !== "independent" && request.phase !== "roundtable") {
        return failed("unsupported_phase", "ChatGPT 仅支持独立回答或已批准的圆桌讨论");
      }
      const signal = context?.signal;
      if (signal?.aborted) {
        return failed("cancelled", "采集已取消，不会再发送或提交结果", "cancelled");
      }
      try {
        const askRequest = toAskRequest(request);
        if (askRequest.prompt.length > MAX_MESSAGE_BODY_CHARS) {
          return failed("prompt_too_large", "署名原文与本轮发言拼接后超过长度上限，未发送");
        }
        const result = parseResult(await transport.send(askRequest, signal));
        if (signal?.aborted) {
          return failed("cancelled", "采集已取消，不会再发送或提交结果", "cancelled");
        }
        if (!result.ok) {
          return failed(result.code, result.message, statusFor(result.code));
        }
        return { mode: "live", status: "complete", body: result.body };
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return failed("cancelled", "采集已取消，不会再发送或提交结果", "cancelled");
        }
        return failed("connection_lost", "ChatGPT 标签页连接已失效，请重新点击扩展连接");
      }
    },
  };
}

export function createChatGptTabTransport(tabId: number, port: ChatGptTabMessagePort): ChatGptTransport {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error("ChatGPT tab ID 无效");
  }
  return {
    send(request, signal) {
      if (signal?.aborted) {
        return Promise.reject(abortError());
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          settle();
        };
        const onAbort = () => {
          void port
            .sendToTab(tabId, { channel: CHATGPT_CHANNEL, type: "cancel", requestId: request.requestId })
            .catch(() => undefined);
          finish(() => reject(abortError()));
        };
        signal?.addEventListener("abort", onAbort);
        void port.sendToTab(tabId, request).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    },
  };
}

export function isChatGptUrl(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

export function discussionPath(tabId: number): string {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error("ChatGPT tab ID 无效");
  }
  return `discussion.html?chatgptTab=${tabId}`;
}

export function readChatGptTabId(search: string): number | null {
  const raw = new URLSearchParams(search).get("chatgptTab");
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const tabId = Number(raw);
  return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
}

export async function connectActiveChatGptTab(port: ChatGptConnectionPort): Promise<ChatGptConnectionResult> {
  try {
    const tab = await port.getActiveTab();
    if (!tab || !Number.isSafeInteger(tab.id) || (tab.id ?? 0) <= 0) {
      return { ok: false, code: "no_active_tab", message: "没有可连接的当前标签页" };
    }
    if (!isChatGptUrl(tab.url)) {
      return { ok: false, code: "not_chatgpt", message: "请先打开并登录 https://chatgpt.com/" };
    }
    const tabId = tab.id as number;
    await port.injectScript(tabId, "chatgpt-content.js");
    await port.openDiscussion(discussionPath(tabId));
    return { ok: true };
  } catch {
    return { ok: false, code: "connection_failed", message: "无法临时连接 ChatGPT 标签页，请重试" };
  }
}

function toAskRequest(request: ProviderRequest): ChatGptAskRequest {
  return {
    channel: CHATGPT_CHANNEL,
    type: "ask",
    prompt: request.phase === "roundtable"
      ? formatRoundtablePrompt(request.userPrompt, request.round, request.meetingContext ?? [])
      : request.userPrompt,
    requestId: crypto.randomUUID(),
  };
}

function parseResult(value: unknown): ChatGptAskResult {
  if (!value || typeof value !== "object") {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (
      typeof record.body !== "string" ||
      !record.body.trim() ||
      record.body.length > MAX_MESSAGE_BODY_CHARS
    ) {
      return invalidResponse();
    }
    return { ok: true, body: record.body };
  }
  if (
    record.ok === false &&
    typeof record.code === "string" &&
    ERROR_CODES.has(record.code as ChatGptErrorCode) &&
    typeof record.message === "string" &&
    record.message.length > 0 &&
    record.message.length <= 300
  ) {
    return {
      ok: false,
      code: record.code as ChatGptErrorCode,
      message: record.message,
    };
  }
  return invalidResponse();
}

function invalidResponse(): ChatGptAskResult {
  return { ok: false, code: "invalid_response", message: "ChatGPT 页面返回了无效结果" };
}

function failed(code: ChatGptErrorCode, message: string, status: MessageStatus = "failed"): ProviderResponse {
  return { mode: "live", status, body: "", error: { code, message } };
}

function statusFor(code: ChatGptErrorCode): MessageStatus {
  if (code === "stopped" || code === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
