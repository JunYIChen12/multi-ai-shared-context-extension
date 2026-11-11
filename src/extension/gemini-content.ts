import { GEMINI_CHANNEL, type GeminiAskResult, type GeminiAskRequest, type GeminiCancelRequest } from "./gemini-connector.js";
import { createGeminiDomPort } from "./gemini-dom.js";
import { createCollectionGate } from "./chatgpt-dispatch.js";
import { DEFAULT_GEMINI_TIMING, runGeminiTurn } from "./gemini-turn.js";

const scope = globalThis as typeof globalThis & { __multiAiGeminiListenerInstalled?: boolean };
const gate = createCollectionGate(
  (prompt, signal) => runGeminiTurn(
    createGeminiDomPort(() => document, () => location.href),
    prompt,
    signal,
    DEFAULT_GEMINI_TIMING,
  ),
  { ok: false, code: "busy", message: "同一请求正在处理或已经结束，不会再次发送" },
  { ok: false, code: "busy", message: "这个标签页已有进行中的采集，不会再次发送" },
);

if (!scope.__multiAiGeminiListenerInstalled) {
  scope.__multiAiGeminiListenerInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isInbound(message)) return;
    if (message.type === "cancel") {
      gate.cancel(message.requestId);
      return;
    }
    void gate.ask(message.requestId, message.prompt).then(sendResponse, () => sendResponse(failed("Gemini 页面执行失败")));
    return true;
  });
}

function isInbound(value: unknown): value is GeminiAskRequest | GeminiCancelRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (request.channel !== GEMINI_CHANNEL || typeof request.requestId !== "string") return false;
  if (request.requestId.length === 0 || request.requestId.length > 80) return false;
  if (request.type === "cancel") return true;
  return request.type === "ask" && typeof request.prompt === "string";
}

function failed(message: string): GeminiAskResult {
  return { ok: false, code: "invalid_response", message };
}
