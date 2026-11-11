import { systemClock } from "../core/clock.js";
import { outcomeHeadline, summarizeSession } from "../core/labels.js";
import { createSession, runCrossReview, runIndependentRound } from "../core/orchestrate.js";
import { exportSession, parseSessionFile } from "../core/persist.js";
import { mockAdapter, unimplementedAdapter } from "../core/providers.js";
import type { ProviderAdapter, ProviderId, Session } from "../core/types.js";
import { PROVIDER_IDS } from "../core/types.js";
import { createChatGptAdapter, createChatGptTabTransport, readChatGptTabId } from "./chatgpt-connector.js";
import { createGeminiAdapter, createGeminiTabTransport, readGeminiTabId } from "./gemini-connector.js";
import { providerIdsForMode, timeoutMsForRound, type ConnectedProviderId } from "./provider-selection.js";

let session: Session | null = null;
const chatGptTabId = readChatGptTabId(window.location.search);
const geminiTabId = readGeminiTabId(window.location.search);
const connectedProvider: ConnectedProviderId | null = chatGptTabId !== null && geminiTabId === null
  ? "chatgpt"
  : geminiTabId !== null && chatGptTabId === null
    ? "gemini"
    : null;
const liveChatGptAdapter = connectedProvider !== "chatgpt" || chatGptTabId === null
  ? null
  : createChatGptAdapter(
      createChatGptTabTransport(chatGptTabId, {
        sendToTab(tabId, request) {
          return chrome.tabs.sendMessage(tabId, request);
        },
      }),
    );
const liveGeminiAdapter = connectedProvider !== "gemini" || geminiTabId === null
  ? null
  : createGeminiAdapter(
      createGeminiTabTransport(geminiTabId, {
        sendToTab(tabId, request) {
          return chrome.tabs.sendMessage(tabId, request);
        },
      }),
    );

const promptInput = document.querySelector("#prompt");
const summary = document.querySelector("#summary");
const errorBox = document.querySelector("#error");
const transcript = document.querySelector("#transcript");
const form = document.querySelector("#ask");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void runRound(connectedProvider === null ? "unimplemented" : "live");
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

showConnectionState();

async function runRound(mode: "mock" | "unimplemented" | "live"): Promise<void> {
  clearError();
  const prompt = promptInput instanceof HTMLTextAreaElement ? promptInput.value : "";
  const adapters = selectedAdapters(mode);
  const options = {
    clock: systemClock(),
    adapters,
    timeoutMs: timeoutMsForRound(mode, connectedProvider ?? "chatgpt"),
    maxRounds: 2,
  };
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
  if (!session) {
    showError("还没有第一轮记录。");
    return;
  }
  const ids = selectedProviderIds();
  const mode = adapterModeForSession(session);
  const ran = await runCrossReview(
    session,
    { sourceProviderIds: ids, targetProviderIds: ids },
    {
      clock: systemClock(),
      adapters: selectedAdapters(mode),
      timeoutMs: timeoutMsForRound(mode, connectedProvider ?? "chatgpt"),
    },
  );
  if (!ran.ok) {
    showError(ran.detail);
    return;
  }
  session = ran.session;
  render();
}

function selectedAdapters(mode: "mock" | "unimplemented" | "live"): ProviderAdapter[] {
  return providerIdsForMode(mode, selectedProviderIds(), connectedProvider ?? "chatgpt").map((id) => {
    if (mode === "mock") {
      return mockAdapter(id);
    }
    if (mode === "live" && id === "chatgpt" && liveChatGptAdapter) {
      return liveChatGptAdapter;
    }
    if (mode === "live" && id === "gemini" && liveGeminiAdapter) {
      return liveGeminiAdapter;
    }
    return unimplementedAdapter(id);
  });
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
  if (connectedProvider === null) {
    return;
  }
  const status = document.querySelector("#connection-status");
  const detail = document.querySelector("#connection-detail");
  const providerName = connectedProvider === "gemini" ? "Gemini" : "ChatGPT";
  const label = document.querySelector(`#${connectedProvider}-label`);
  const submit = document.querySelector("#record-gap");
  const cross = document.querySelector("#cross");
  if (status) status.textContent = `已临时连接 ${providerName}`;
  if (detail) detail.textContent = connectedProvider === "gemini"
    ? "本轮只发送到当前 Gemini 标签页。实际提问会附一次性校验标记；讨论记录和导出保留你输入的原文。刷新或关闭标签页后需要重新连接。"
    : `本轮只发送到当前 ${providerName} 标签页，不会发送到其他模型。刷新或关闭标签页后需要重新连接。`;
  if (label) label.textContent = ` ${providerName}（已临时连接）`;
  if (submit instanceof HTMLButtonElement) submit.textContent = "发送第一轮并记录";
  if (cross instanceof HTMLButtonElement) {
    cross.disabled = true;
    cross.title = `本轮仅批准 ${providerName} 第一轮连接`;
  }
  for (const id of ["chatgpt", "grok", "gemini"]) {
    if (id === connectedProvider) continue;
    const checkbox = document.querySelector<HTMLInputElement>(`input[value="${id}"]`);
    if (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = true;
    }
  }
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
