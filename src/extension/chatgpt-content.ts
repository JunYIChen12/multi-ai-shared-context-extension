import { CHATGPT_CHANNEL, type ChatGptAskRequest, type ChatGptAskResult } from "./chatgpt-connector.js";
import {
  CHATGPT_PROMPT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  CHATGPT_STOP_SELECTOR,
  lastVisible,
} from "./chatgpt-dom.js";
import { runChatGptTurn, type ChatGptPagePort } from "./chatgpt-turn.js";

const scope = globalThis as typeof globalThis & { __multiAiChatGptListenerInstalled?: boolean };

if (!scope.__multiAiChatGptListenerInstalled) {
  scope.__multiAiChatGptListenerInstalled = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isAskRequest(message)) {
      return;
    }
    void runChatGptTurn(chatGptPage, message.prompt)
      .then(sendResponse)
      .catch(() => sendResponse(failed("ChatGPT 页面执行失败")));
    return true;
  });
}

const chatGptPage: ChatGptPagePort = {
  status() {
    return {
      assistantCount: document.querySelectorAll('[data-message-author-role="assistant"]').length,
      isGenerating: lastVisible(document.querySelectorAll<HTMLElement>(CHATGPT_STOP_SELECTOR)) !== null,
    };
  },
  writePrompt(prompt) {
    const input = lastVisible(document.querySelectorAll<HTMLElement>(CHATGPT_PROMPT_SELECTOR));
    if (!input) {
      return false;
    }
    if (input instanceof HTMLTextAreaElement) {
      input.value = prompt;
    } else {
      input.textContent = prompt;
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));
    return true;
  },
  submit() {
    const button = lastVisible(document.querySelectorAll<HTMLButtonElement>(CHATGPT_SEND_SELECTOR));
    if (!button || button.disabled) {
      return false;
    }
    button.click();
    return true;
  },
  latestAssistantText() {
    const replies = document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]');
    return replies.item(replies.length - 1)?.textContent ?? "";
  },
};

function isAskRequest(value: unknown): value is ChatGptAskRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Record<string, unknown>;
  return request.channel === CHATGPT_CHANNEL && request.type === "ask" && typeof request.prompt === "string";
}

function failed(message: string): ChatGptAskResult {
  return { ok: false, code: "invalid_response", message };
}
