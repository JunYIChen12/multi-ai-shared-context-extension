import { systemClock } from "../core/clock.js";
import { outcomeHeadline, summarizeSession } from "../core/labels.js";
import { createSession, runCrossReview, runIndependentRound } from "../core/orchestrate.js";
import { exportSession, parseSessionJsonl } from "../core/persist.js";
import { mockAdapter, unimplementedAdapter } from "../core/providers.js";
import type { ProviderAdapter, ProviderId, Session } from "../core/types.js";
import { PROVIDER_IDS } from "../core/types.js";

let session: Session | null = null;

const promptInput = document.querySelector("#prompt");
const summary = document.querySelector("#summary");
const errorBox = document.querySelector("#error");
const transcript = document.querySelector("#transcript");
const form = document.querySelector("#ask");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void runRound("unimplemented");
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

async function runRound(mode: "mock" | "unimplemented"): Promise<void> {
  clearError();
  const prompt = promptInput instanceof HTMLTextAreaElement ? promptInput.value : "";
  const adapters = selectedAdapters(mode);
  const options = { clock: systemClock(), adapters, timeoutMs: 30_000, maxRounds: 2 };
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
  const ran = await runCrossReview(
    session,
    { sourceProviderIds: ids, targetProviderIds: ids },
    { clock: systemClock(), adapters: selectedAdapters(adapterModeForSession(session)), timeoutMs: 30_000 },
  );
  if (!ran.ok) {
    showError(ran.detail);
    return;
  }
  session = ran.session;
  render();
}

function selectedAdapters(mode: "mock" | "unimplemented"): ProviderAdapter[] {
  return selectedProviderIds().map((id) => (mode === "mock" ? mockAdapter(id) : unimplementedAdapter(id)));
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

function adapterModeForSession(current: Session): "mock" | "unimplemented" {
  return current.messages.some((message) => message.sourceKind === "mock") ? "mock" : "unimplemented";
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
  const parsed = parseSessionJsonl(await file.text());
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
