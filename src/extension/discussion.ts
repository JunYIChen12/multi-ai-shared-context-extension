import { systemClock } from "../core/clock.js";
import { outcomeHeadline, summarizeSession } from "../core/labels.js";
import { createSession, runCrossReview, runIndependentRound } from "../core/orchestrate.js";
import { exportSession, parseSessionFile } from "../core/persist.js";
import { mockAdapter, unimplementedAdapter } from "../core/providers.js";
import type { ProviderAdapter, ProviderId, Session } from "../core/types.js";
import { PROVIDER_IDS } from "../core/types.js";
import { createChatGptAdapter, createChatGptTabTransport } from "./chatgpt-connector.js";
import { createGeminiAdapter, createGeminiTabTransport } from "./gemini-connector.js";
import { CHATGPT_OUTER_TIMEOUT_MS, providerIdsForMode, timeoutMsForRound } from "./provider-selection.js";
import {
  connectionRejectionCode,
  findDiscussionDestination,
  isConnectionRequest,
  providerForTabId,
  readConnectedTabIds,
  shouldDisconnectOnTabUpdate,
  type ConnectionRequest,
  type ConnectionRejectionCode,
  type ConnectedProviderId,
  type ConnectedTabIds,
} from "./discussion-routing.js";

let session: Session | null = null;
const urlConnectedTabs = readConnectedTabIds(window.location.search);
const connectedTabs: ConnectedTabIds = { ...urlConnectedTabs };
const disconnectedProviders = new Set<ConnectedProviderId>();
let connectionsReady = false;

const promptInput = document.querySelector("#prompt");
const summary = document.querySelector("#summary");
const errorBox = document.querySelector("#error");
const transcript = document.querySelector("#transcript");
const form = document.querySelector("#ask");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void runRound(connectedProviderIds().length === 0 ? "unimplemented" : "live");
});

document.querySelector("#run-mock")?.addEventListener("click", () => {
  void runRound("mock");
});

document.querySelector("#cross")?.addEventListener("click", () => {
  void runSecondRound();
});

document.querySelector("#export-md")?.addEventListener("click", () => {
  downloadCurrent("markdown");
});

document.querySelector("#export-jsonl")?.addEventListener("click", () => {
  downloadCurrent("jsonl");
});

document.querySelector("#import-jsonl")?.addEventListener("change", (event) => {
  const input = event.target;
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  if (!file) {
    return;
  }
  void restoreFromFile(file);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || message.channel !== "multi-ai-discussion-connect-v1") return false;
  if (!isConnectionRequest(message)) {
    sendResponse({ ok: false, code: "INVALID_REQUEST" });
    return false;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) {
    sendResponse({ ok: false, code: "INVALID_SENDER", targetDiscussionTabId: message.targetDiscussionTabId });
    return false;
  }
  void attachConnection(message).then(
    (code) => sendResponse({ ok: code === null, code, targetDiscussionTabId: message.targetDiscussionTabId }),
    () => sendResponse({ ok: false, code: "ACK_INVALID", targetDiscussionTabId: message.targetDiscussionTabId }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(disconnectTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const providerId = providerForTabId(connectedTabs, tabId);
  if (providerId && shouldDisconnectOnTabUpdate(providerId, changeInfo)) disconnectTab(tabId);
});

showConnectionState();
void validateConnectedTabs();

async function runRound(mode: "mock" | "unimplemented" | "live"): Promise<void> {
  clearError();
  if (!connectionsReady) {
    showError("正在确认连接状态，请稍后再发送。");
    return;
  }
  const prompt = promptInput instanceof HTMLTextAreaElement ? promptInput.value : "";
  const options = orchestrationOptions(mode);
  const created = createSession(prompt, options);
  if (!created.ok) {
    showError(created.detail);
    return;
  }
  const ran = await runIndependentRound(created.session, options);
  if (!ran.ok) {
    session = created.session;
    render();
    showError(ran.detail);
    return;
  }
  session = ran.session;
  render();
}

async function runSecondRound(): Promise<void> {
  clearError();
  if (!connectionsReady) {
    showError("正在确认连接状态，请稍后再试。");
    return;
  }
  if (!session) {
    showError("还没有第一轮记录。");
    return;
  }
  const ids = selectedProviderIds();
  const mode = adapterModeForSession(session);
  const ran = await runCrossReview(
    session,
    { sourceProviderIds: ids, targetProviderIds: ids },
    orchestrationOptions(mode),
  );
  if (!ran.ok) {
    showError(ran.detail);
    return;
  }
  session = ran.session;
  render();
}

function selectedAdapters(mode: "mock" | "unimplemented" | "live"): ProviderAdapter[] {
  return providerIdsForMode(mode, selectedProviderIds(), connectedProviderIds()).map((id) => {
    if (mode === "mock") {
      return mockAdapter(id);
    }
    if (mode === "live" && id === "chatgpt" && connectedTabs.chatgpt !== undefined) {
      return createChatGptAdapter(createChatGptTabTransport(connectedTabs.chatgpt, {
        sendToTab(tabId, request) {
          return chrome.tabs.sendMessage(tabId, request);
        },
      }));
    }
    if (mode === "live" && id === "gemini" && connectedTabs.gemini !== undefined) {
      return createGeminiAdapter(createGeminiTabTransport(connectedTabs.gemini, {
        sendToTab(tabId, request) {
          return chrome.tabs.sendMessage(tabId, request);
        },
      }));
    }
    return unimplementedAdapter(id);
  });
}

function orchestrationOptions(mode: "mock" | "unimplemented" | "live") {
  const adapters = selectedAdapters(mode);
  const timeoutMsByProvider = Object.fromEntries(
    adapters.filter((adapter) => adapter.mode === "live")
      .map((adapter) => [adapter.id, timeoutMsForRound("live", adapter.id)]),
  );
  return {
    clock: systemClock(),
    adapters,
    timeoutMs: Math.max(
      CHATGPT_OUTER_TIMEOUT_MS,
      ...Object.values(timeoutMsByProvider).filter((value): value is number => typeof value === "number"),
    ),
    timeoutMsByProvider,
    maxRounds: 2,
  };
}

function connectedProviderIds(): ConnectedProviderId[] {
  return (["chatgpt", "gemini"] as const).filter((providerId) => connectedTabs[providerId] !== undefined);
}

function selectedProviderIds(): ProviderId[] {
  const boxes = document.querySelectorAll('input[name="provider"]:checked');
  const ids: ProviderId[] = [];
  boxes.forEach((node) => {
    if (!(node instanceof HTMLInputElement)) {
      return;
    }
    if (isProviderId(node.value)) {
      ids.push(node.value);
    }
  });
  return ids;
}

function adapterModeForSession(current: Session): "mock" | "unimplemented" | "live" {
  if (current.messages.some((message) => message.adapterMode === "live")) {
    return "live";
  }
  return current.messages.some((message) => message.sourceKind === "mock") ? "mock" : "unimplemented";
}

function showConnectionState(): void {
  const status = document.querySelector("#connection-status");
  const detail = document.querySelector("#connection-detail");
  const submit = document.querySelector("#record-gap");
  const cross = document.querySelector("#cross");
  const providers = connectedProviderIds();
  const disconnected = [...disconnectedProviders];
  const names = providers.map(providerName);
  if (status) {
    if (providers.length > 0) {
      const suffix = disconnected.length > 0 ? `；${disconnected.map(providerName).join("、")}已断开` : "";
      status.textContent = `已临时连接 ${names.join("、")}${suffix}`;
    } else {
      status.textContent = disconnected.length > 0 ? "连接已断开" : "未连接";
    }
  }
  let connectionDetail = "请从已登录的 ChatGPT 或 Gemini 标签页点击扩展连接。Grok 未接入。";
  if (detail) {
    if (providers.length === 1 && providers[0] === "gemini") {
      connectionDetail = "本轮只发送到当前 Gemini 标签页。实际提问会附一次性校验标记；讨论记录和导出保留你输入的原文。刷新或关闭标签页后需要重新连接。";
    } else if (providers.length === 1) {
      connectionDetail = "本轮只发送到当前 ChatGPT 标签页，不会发送到其他模型。刷新或关闭标签页后需要重新连接。";
    } else if (providers.length === 2) {
      connectionDetail = "本轮会并行发送到已连接的 ChatGPT 与 Gemini 标签页。Gemini 提问会附一次性校验标记；两家分别按自己的规则认领回复。刷新或关闭对应标签页后，该家连接会断开。";
    } else if (disconnected.length > 0) {
      connectionDetail = `${disconnected.map(providerName).join("、")}标签页已刷新或关闭，请重新点击扩展连接。`;
    }
    if (providers.length > 0 && disconnected.length > 0) {
      connectionDetail += ` ${disconnected.map(providerName).join("、")}已断开，请重新连接。`;
    }
    detail.textContent = connectionDetail;
  }
  if (submit instanceof HTMLButtonElement) {
    submit.textContent = providers.length > 0 ? "发送第一轮并记录" : "记录未接入尝试";
    submit.disabled = !connectionsReady;
  }
  if (cross instanceof HTMLButtonElement) {
    const hasLiveSession = session?.messages.some((message) => message.adapterMode === "live") ?? false;
    cross.disabled = providers.length > 0 || hasLiveSession;
    if (providers.length > 0) cross.title = "本轮仅开放已连接模型的第一轮回答";
  }

  for (const providerId of ["chatgpt", "gemini"] as const) {
    const checkbox = document.querySelector<HTMLInputElement>(`input[value="${providerId}"]`);
    const label = document.querySelector(`#${providerId}-label`);
    const isConnected = connectedTabs[providerId] !== undefined;
    if (checkbox) {
      checkbox.disabled = providers.length > 0 && !isConnected;
      if (!isConnected && providers.length > 0) checkbox.checked = false;
    }
    if (label) {
      const state = isConnected ? "已临时连接" : disconnectedProviders.has(providerId) ? "连接已断开" : "未接入";
      label.textContent = ` ${providerName(providerId)}（${state}）`;
    }
  }
  const grok = document.querySelector<HTMLInputElement>('input[value="grok"]');
  if (grok) {
    grok.disabled = providers.length > 0;
    if (providers.length > 0) grok.checked = false;
  }
}

async function attachConnection(request: ConnectionRequest): Promise<ConnectionRejectionCode | null> {
  if (typeof chrome.runtime.getContexts !== "function") return "CONTEXT_LOOKUP_FAILED";
  const discussionTab = await chrome.tabs.getCurrent();
  if (!discussionTab?.id) return "DISCUSSION_TAB_MISSING";
  if (discussionTab.id !== request.targetDiscussionTabId) return "TARGET_TAB_MISMATCH";
  const discussionUrl = chrome.runtime.getURL("discussion.html");
  let contexts: chrome.runtime.ExtensionContext[];
  try {
    contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
      documentOrigins: [new URL(discussionUrl).origin],
    });
  } catch {
    return "CONTEXT_LOOKUP_FAILED";
  }
  const destination = findDiscussionDestination(
    contexts,
    discussionUrl,
    discussionTab.incognito ?? false,
  );
  let providerTab: chrome.tabs.Tab;
  try {
    providerTab = await chrome.tabs.get(request.providerTabId);
  } catch {
    return "PROVIDER_TAB_LOOKUP_FAILED";
  }
  const code = connectionRejectionCode(request, discussionTab, destination, providerTab, connectedTabs);
  if (code) return code;
  connectedTabs[request.providerId] = request.providerTabId;
  disconnectedProviders.delete(request.providerId);
  const checkbox = document.querySelector<HTMLInputElement>(`input[value="${request.providerId}"]`);
  if (checkbox) checkbox.checked = true;
  showConnectionState();
  return null;
}

async function validateConnectedTabs(): Promise<void> {
  try {
    const discussionTab = await chrome.tabs.getCurrent();
    if (!discussionTab) {
      for (const tabId of Object.values(connectedTabs)) if (tabId !== undefined) disconnectTab(tabId);
      return;
    }
    for (const providerId of connectedProviderIds()) {
      const tabId = connectedTabs[providerId];
      if (tabId === undefined) continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== "complete" || tab.incognito !== (discussionTab.incognito ?? false)) disconnectTab(tabId);
      } catch {
        disconnectTab(tabId);
      }
    }
  } catch {
    for (const tabId of Object.values(connectedTabs)) if (tabId !== undefined) disconnectTab(tabId);
  } finally {
    connectionsReady = true;
    showConnectionState();
  }
}

function disconnectTab(tabId: number): void {
  const providerId = providerForTabId(connectedTabs, tabId);
  if (!providerId) return;
  delete connectedTabs[providerId];
  disconnectedProviders.add(providerId);
  const checkbox = document.querySelector<HTMLInputElement>(`input[value="${providerId}"]`);
  if (checkbox) checkbox.checked = false;
  if (urlConnectedTabs[providerId] === tabId) {
    delete urlConnectedTabs[providerId];
    clearConnectionUrl(providerId);
  }
  showConnectionState();
}

function clearConnectionUrl(providerId: ConnectedProviderId): void {
  const params = new URLSearchParams(window.location.search);
  params.delete(`${providerId}Tab`);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}`,
  );
}

function providerName(providerId: ConnectedProviderId): string {
  return providerId === "gemini" ? "Gemini" : "ChatGPT";
}

function render(): void {
  if (!transcript || !summary) {
    return;
  }
  transcript.replaceChildren();
  if (!session) {
    summary.textContent = "";
    return;
  }
  summary.textContent = summarizeSession(session);
  for (const message of session.messages) {
    const article = document.createElement("article");
    const headline = outcomeHeadline(message);
    article.dataset.status = message.status;
    article.dataset.kind = message.sourceKind;
    article.dataset.headline = headline;
    const title = document.createElement("h3");
    const who = message.providerId ?? "用户";
    title.textContent = `第 ${message.round} 轮 · ${who} · ${headline}`;
    const body = document.createElement("pre");
    body.textContent = message.body || message.errorMessage || "（无正文）";
    article.append(title, body);
    if (message.provenance.length > 0) {
      const list = document.createElement("ul");
      for (const item of message.provenance) {
        const line = document.createElement("li");
        line.textContent = `注入来自 ${item.providerId} 第 ${item.round} 轮 message:${item.messageId}`;
        list.append(line);
      }
      article.append(list);
    }
    transcript.append(article);
  }
}

function downloadCurrent(kind: "markdown" | "jsonl"): void {
  clearError();
  if (!session) {
    showError("没有可导出的会话。");
    return;
  }
  const exported = exportSession(session);
  if (kind === "markdown") {
    downloadFile(`${exported.basename}.md`, exported.markdown, "text/markdown");
    return;
  }
  downloadFile(`${exported.basename}.jsonl`, exported.jsonl, "application/jsonl");
}

async function restoreFromFile(file: File): Promise<void> {
  clearError();
  const parsed = await parseSessionFile(file);
  if (!parsed.ok) {
    showError(parsed.errors.join("\n"));
    return;
  }
  session = parsed.session;
  render();
}

function downloadFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function showError(message: string): void {
  if (errorBox) {
    errorBox.textContent = message;
  }
}

function clearError(): void {
  if (errorBox) {
    errorBox.textContent = "";
  }
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
