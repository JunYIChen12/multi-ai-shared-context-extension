/// <reference types="chrome" />

import { connectActiveChatGptTab } from "./chatgpt-connector.js";

const openButton = document.querySelector("#open");
const errorBox = document.querySelector("#error");

openButton?.addEventListener("click", async () => {
  if (openButton instanceof HTMLButtonElement) {
    openButton.disabled = true;
  }
  if (errorBox) {
    errorBox.textContent = "";
  }
  const result = await connectActiveChatGptTab({
    async getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? { id: tab.id, url: tab.url } : null;
    },
    async injectScript(tabId, filename) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [filename] });
    },
    async openDiscussion(path) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    },
  });
  if (!result.ok && errorBox) {
    errorBox.textContent = result.message;
  }
  if (!result.ok && openButton instanceof HTMLButtonElement) {
    openButton.disabled = false;
  }
});
