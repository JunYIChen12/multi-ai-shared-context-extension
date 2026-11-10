import { MAX_MESSAGE_BODY_CHARS } from "../core/types.js";
import type { MessageStatus, ProviderAdapter, ProviderRequest, ProviderResponse } from "../core/types.js";

export const GEMINI_CHANNEL = "multi-ai-gemini-v1" as const;
export const GEMINI_OUTER_TIMEOUT_MS = 6 * 60_000;

export type GeminiErrorCode =
  | "busy"
  | "prompt_missing"
  | "prompt_changed"
  | "send_missing"
  | "timeout"
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
  | "ambiguous_turn";

export interface GeminiAskRequest {
  channel: typeof GEMINI_CHANNEL;
  type: "ask";
  prompt: string;
  requestId: string;
}

export interface GeminiCancelRequest {
  channel: typeof GEMINI_CHANNEL;
  type: "cancel";
  requestId: string;
}

export type GeminiTabMessage = GeminiAskRequest | GeminiCancelRequest;

export type GeminiAskResult =
  | { ok: true; body: string }
  | { ok: false; code: GeminiErrorCode; message: string };

export interface GeminiTransport {
  send(request: GeminiAskRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface GeminiTabMessagePort {
  sendToTab(tabId: number, message: GeminiTabMessage): Promise<unknown>;
}

export interface GeminiConnectionPort {
  getActiveTab(): Promise<{ id?: number; url?: string } | null>;
  injectScript(tabId: number, filename: string): Promise<void>;
  openDiscussion(path: string): Promise<void>;
}

export type GeminiConnectionResult =
  | { ok: true }
  | { ok: false; code: "no_active_tab" | "not_gemini" | "connection_failed"; message: string };

const ERROR_CODES = new Set<GeminiErrorCode>([
  "busy",
  "prompt_missing",
  "prompt_changed",
  "send_missing",
  "timeout",
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
  "ambiguous_turn",
]);

export function createGeminiAdapter(transport: GeminiTransport): ProviderAdapter {
  return {
    id: "gemini",
    mode: "live",
    async respond(request, context): Promise<ProviderResponse> {
      if (request.phase !== "independent") {
        return failed("unsupported_phase", "本轮只允许 Gemini 第一轮独立回答");
      }
      const signal = context?.signal;
      if (signal?.aborted) {
        return failed("cancelled", "采集已取消，不会再发送或提交结果", "cancelled");
      }
      try {
        const result = parseResult(await transport.send(toAskRequest(request), signal));
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
        return failed("connection_lost", "Gemini 标签页连接已失效，请重新点击扩展连接");
      }
    },
  };
}

export function createGeminiTabTransport(tabId: number, port: GeminiTabMessagePort): GeminiTransport {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error("Gemini tab ID 无效");
  }
  return {
    send(request, signal) {
      if (signal?.aborted) {
        return Promise.reject(abortError());
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          settle();
        };
        const onAbort = () => {
          void Promise.resolve()
            .then(() => port.sendToTab(tabId, { channel: GEMINI_CHANNEL, type: "cancel", requestId: request.requestId }))
            .catch(() => undefined);
          finish(() => reject(abortError()));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        let pending: Promise<unknown>;
        try {
          pending = port.sendToTab(tabId, request);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        void pending.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    },
  };
}

export function isGeminiUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "gemini.google.com" &&
      (url.pathname === "/app" || /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?$/.test(url.pathname));
  } catch {
    return false;
  }
}

export function readGeminiTabId(search: string): number | null {
  const values = new URLSearchParams(search).getAll("geminiTab");
  if (values.length !== 1) return null;
  const raw = values[0];
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function connectActiveGeminiTab(port: GeminiConnectionPort): Promise<GeminiConnectionResult> {
  try {
    const tab = await port.getActiveTab();
    if (!tab || typeof tab.id !== "number" || !Number.isSafeInteger(tab.id) || tab.id <= 0) {
      return { ok: false, code: "no_active_tab", message: "没有可连接的当前标签页" };
    }
    if (!isGeminiUrl(tab.url)) {
      return { ok: false, code: "not_gemini", message: "请先打开并登录 https://gemini.google.com/app" };
    }
    await port.injectScript(tab.id, "gemini-content.js");
    await port.openDiscussion(`discussion.html?geminiTab=${tab.id}`);
    return { ok: true };
  } catch {
    return { ok: false, code: "connection_failed", message: "无法临时连接 Gemini 标签页，请重试" };
  }
}

function toAskRequest(request: ProviderRequest): GeminiAskRequest {
  return {
    channel: GEMINI_CHANNEL,
    type: "ask",
    prompt: request.userPrompt,
    requestId: crypto.randomUUID(),
  };
}

function parseResult(value: unknown): GeminiAskResult {
  if (!value || typeof value !== "object") return invalidResponse();
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
    ERROR_CODES.has(record.code as GeminiErrorCode) &&
    typeof record.message === "string" &&
    record.message.length > 0 &&
    record.message.length <= 300
  ) {
    return { ok: false, code: record.code as GeminiErrorCode, message: record.message };
  }
  return invalidResponse();
}

function invalidResponse(): GeminiAskResult {
  return { ok: false, code: "invalid_response", message: "Gemini 页面返回了无效结果" };
}

function failed(code: GeminiErrorCode, message: string, status: MessageStatus = "failed"): ProviderResponse {
  return { mode: "live", status, body: "", error: { code, message } };
}

function statusFor(code: GeminiErrorCode): MessageStatus {
  if (code === "stopped" || code === "cancelled") return "cancelled";
  if (code === "timeout") return "timeout";
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
