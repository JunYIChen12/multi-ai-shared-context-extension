/// <reference types="chrome" />

import { connectActiveChatGptTab } from "./chatgpt-connector.js";
import { connectActiveGeminiTab } from "./gemini-connector.js";
import { providerForTabUrl } from "./provider-selection.js";

const openButton = document.querySelector("#open");
const errorBox = document.querySelector("#error");

openButton?.addEventListener("click", async () => {
  if (openButton instanceof HTMLButtonElement) {
    openButton.disabled = true;
  }
  if (errorBox) {
    errorBox.textContent = "";
  }
  let result: { ok: true } | { ok: false; message: string };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const provider = providerForTabUrl(tab?.url);
    if (provider === null) {
      result = { ok: false, message: "请先打开已登录的 ChatGPT 或 Gemini 网页；Grok 未接入。" };
    } else {
      const port = {
        async getActiveTab() {
          return tab ? { id: tab.id, url: tab.url } : null;
        },
        async injectScript(tabId: number, filename: string) {
          await chrome.scripting.executeScript({ target: { tabId }, files: [filename] });
        },
        async openDiscussion(path: string) {
          await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
        },
      };
      result = provider === "gemini"
        ? await connectActiveGeminiTab(port)
        : await connectActiveChatGptTab(port);
    }
  } catch {
    result = { ok: false, message: "无法读取当前网页标签页，请重试。" };
  }
  if (!result.ok && errorBox) {
    errorBox.textContent = result.message;
  }
  if (!result.ok && openButton instanceof HTMLButtonElement) {
    openButton.disabled = false;
  }
});
