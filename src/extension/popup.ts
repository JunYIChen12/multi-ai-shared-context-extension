/// <reference types="chrome" />

import { connectActiveChatGptTab } from "./chatgpt-connector.js";
import { connectActiveGeminiTab } from "./gemini-connector.js";
import {
  connectionAckMatches,
  createConnectionRequest,
  findDiscussionDestination,
  sameDiscussionDestination,
  type DiscussionDestination,
} from "./discussion-routing.js";
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
    } else if (typeof chrome.runtime.getContexts !== "function") {
      result = { ok: false, message: "当前 Chrome 不支持安全定位讨论页，请升级浏览器；现有连接未改变。" };
    } else {
      const discussionUrl = chrome.runtime.getURL("discussion.html");
      const destination = await findDestination(discussionUrl, tab?.incognito ?? false);
      if (destination.kind === "ambiguous") {
        result = { ok: false, message: "请先只保留一个讨论页再连接；为避免接错，现有连接没有改变。" };
        if (errorBox) errorBox.textContent = result.message;
        if (openButton instanceof HTMLButtonElement) openButton.disabled = false;
        return;
      }
      let routeError: string | null = null;
      const port = {
        async getActiveTab() {
          return tab ? { id: tab.id, url: tab.url } : null;
        },
        async injectScript(tabId: number, filename: string) {
          await chrome.scripting.executeScript({ target: { tabId }, files: [filename] });
        },
        async openDiscussion(path: string) {
          const latest = await findDestination(discussionUrl, tab?.incognito ?? false);
          if (!sameDiscussionDestination(destination, latest)) {
            routeError = "讨论页状态已变化，请确认只打开一个讨论页后重新连接；现有连接没有改变。";
            throw new Error(routeError);
          }
          if (latest.kind === "none") {
            await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
            return;
          }
          if (latest.kind !== "unique") {
            routeError = "请先只保留一个讨论页再连接；为避免接错，现有连接没有改变。";
            throw new Error(routeError);
          }
          if (!tab?.id || !Number.isSafeInteger(tab.id)) {
            routeError = "当前网页标签页 ID 无效；现有连接没有改变。";
            throw new Error(routeError);
          }
          const response = await chrome.runtime.sendMessage(
            createConnectionRequest(latest.tabId, provider, tab.id),
          );
          if (!connectionAckMatches(response, latest.tabId)) {
            routeError = "目标讨论页未接受连接；现有连接没有改变。";
            throw new Error(routeError);
          }
        },
      };
      result = provider === "gemini"
        ? await connectActiveGeminiTab(port)
        : await connectActiveChatGptTab(port);
      if (!result.ok && routeError) result = { ok: false, message: routeError };
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

async function findDestination(discussionUrl: string, incognito: boolean): Promise<DiscussionDestination> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["TAB"],
    documentOrigins: [new URL(discussionUrl).origin],
  });
  return findDiscussionDestination(contexts, discussionUrl, incognito);
}
