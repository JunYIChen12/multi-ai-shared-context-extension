import { CHATGPT_CHANNEL, type ChatGptAskResult, type ChatGptCancelRequest, type ChatGptAskRequest } from "./chatgpt-connector.js";
import { createDomEvidencePort } from "./chatgpt-dom.js";
import { createCollectionGate } from "./chatgpt-dispatch.js";
import { DEFAULT_CHATGPT_TIMING, createSendLedger, runChatGptTurn } from "./chatgpt-turn.js";

const scope = globalThis as typeof globalThis & { __multiAiChatGptListenerInstalled?: boolean };
const sendLedger = createSendLedger();

const gate = createCollectionGate(
  (prompt, signal) => runChatGptTurn(
    createDomEvidencePort(() => document, () => location.href),
    prompt,
    DEFAULT_CHATGPT_TIMING,
    signal,
    sendLedger,
  ),
  { ok: false, code: "in_flight", message: "同一请求正在处理或已经结束，不会再次发送" },
  { ok: false, code: "in_flight", message: "这个标签页已有进行中的采集，不会再次发送" },
);

if (!scope.__multiAiChatGptListenerInstalled) {
  scope.__multiAiChatGptListenerInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isInbound(message)) {
      return;
    }
    if (message.type === "cancel") {
      gate.cancel(message.requestId);
      return;
    }
    void gate.ask(message.requestId, message.prompt).then(sendResponse, () => sendResponse(failed("ChatGPT 页面执行失败")));
    return true;
  });
}

function isInbound(value: unknown): value is ChatGptAskRequest | ChatGptCancelRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Record<string, unknown>;
  if (request.channel !== CHATGPT_CHANNEL || typeof request.requestId !== "string") {
    return false;
  }
  if (request.requestId.length === 0 || request.requestId.length > 80) {
    return false;
  }
  if (request.type === "cancel") {
    return true;
  }
  return request.type === "ask" && typeof request.prompt === "string";
}

function failed(message: string): ChatGptAskResult {
  return { ok: false, code: "invalid_response", message };
}
