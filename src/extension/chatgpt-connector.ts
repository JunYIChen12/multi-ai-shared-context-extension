import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../core/types.js";
import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";

export const CHATGPT_CHANNEL = "multi-ai-chatgpt-v1" as const;

export type ChatGptErrorCode =
  | "busy"
  | "prompt_missing"
  | "send_missing"
  | "start_timeout"
  | "completion_timeout"
  | "empty_response"
  | "response_too_large"
  | "invalid_request"
  | "invalid_response"
  | "connection_lost"
  | "unsupported_phase";

export interface ChatGptAskRequest {
  channel: typeof CHATGPT_CHANNEL;
  type: "ask";
  prompt: string;
}

export type ChatGptAskResult =
  | { ok: true; body: string }
  | { ok: false; code: ChatGptErrorCode; message: string };

export interface ChatGptTransport {
  send(request: ChatGptAskRequest): Promise<unknown>;
}

export interface ChatGptTabMessagePort {
  sendToTab(tabId: number, request: ChatGptAskRequest): Promise<unknown>;
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
  "send_missing",
  "start_timeout",
  "completion_timeout",
  "empty_response",
  "response_too_large",
  "invalid_request",
  "invalid_response",
  "connection_lost",
  "unsupported_phase",
]);

export function createChatGptAdapter(transport: ChatGptTransport): ProviderAdapter {
  return {
    id: "chatgpt",
    mode: "live",
    async respond(request): Promise<ProviderResponse> {
      if (request.phase !== "independent") {
        return failed("unsupported_phase", "本轮只允许 ChatGPT 第一轮独立回答");
      }
      try {
        const result = parseResult(await transport.send(toAskRequest(request)));
        if (!result.ok) {
          return failed(result.code, result.message);
        }
        return { mode: "live", status: "complete", body: result.body };
      } catch {
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
    send(request) {
      return port.sendToTab(tabId, request);
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
    prompt: request.userPrompt,
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

function failed(code: ChatGptErrorCode, message: string): ProviderResponse {
  return { mode: "live", status: "failed", body: "", error: { code, message } };
}
