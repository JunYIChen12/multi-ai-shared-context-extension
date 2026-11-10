export const GEMINI_CONVERSATION_SELECTOR = ".conversation-container";
export const GEMINI_USER_SELECTOR = "user-query, .user-query";
export const GEMINI_PENDING_REQUEST_SELECTOR = "pending-request, .pending-request";
export const GEMINI_PENDING_RESPONSE_SELECTOR = "pending-response, .pending-response";
export const GEMINI_MODEL_SELECTOR = "model-response, .model-response";
export const GEMINI_MODEL_BODY_SELECTOR = ".model-response-content";
export const GEMINI_COMPLETE_SELECTOR = ".response-footer.complete";
export const GEMINI_ACTIONS_SELECTOR = "message-actions, .message-actions";
export const GEMINI_RESPONSE_INFO_SELECTOR = "response-info-line, .response-info-line";
export const GEMINI_PROMPT_SELECTOR = "rich-textarea [contenteditable=\"true\"]";
export const GEMINI_SEND_SELECTOR = [
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label="发送消息"]',
  'button[aria-label="发送"]',
].join(", ");
export const GEMINI_STOP_SELECTOR = [
  '[data-test-id="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop"]',
  'button[aria-label="停止生成"]',
  'button[aria-label="停止回复"]',
  'button[aria-label="停止"]',
].join(", ");

// shortcut: only the one measured Gemini app route and DOM shape are supported; recheck after a fresh probe.

export type GeminiRoute =
  | { kind: "draft" }
  | { kind: "conversation"; id: string }
  | { kind: "invalid" };

export interface GeminiModelEvidence {
  body: string;
  completeFooter: boolean;
  messageActions: boolean;
  responseInfo: boolean;
  ariaBusy: boolean;
}

export interface GeminiConversationEvidence {
  userQueryCount: number;
  promptMatches: number;
  pendingRequests: number;
  pendingResponses: number;
  modelResponseCount: number;
  completeFooterCount: number;
  messageActionsCount: number;
  modelResponses: GeminiModelEvidence[];
}

export interface GeminiPageBaseline {
  route: GeminiRoute;
  userQueryCounts: readonly number[];
  modelResponseCounts: readonly number[];
  completeFooterCounts: readonly number[];
  messageActionsCounts: readonly number[];
  draftContinuityCandidateIndex?: number;
}

export interface GeminiPageSnapshot {
  route: GeminiRoute;
  conversations: GeminiConversationEvidence[];
  pageError: boolean;
  stopVisible: boolean;
}

export interface GeminiPagePort {
  read(prompt: string, baseline?: GeminiPageBaseline): GeminiPageSnapshot;
  readPrompt(): string | null;
  writePrompt(prompt: string): boolean;
  submit(): boolean;
  watchStop(onStop: () => void): () => void;
}

export interface GeminiDomRoot {
  querySelector(selector: string): GeminiDomElement | null;
  querySelectorAll(selector: string): ArrayLike<GeminiDomElement>;
  addEventListener?(type: string, listener: (event: { target: unknown }) => void, capture?: boolean): void;
  removeEventListener?(type: string, listener: (event: { target: unknown }) => void, capture?: boolean): void;
}

export interface GeminiDomElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): GeminiDomElement | null;
  querySelectorAll(selector: string): ArrayLike<GeminiDomElement>;
  textContent: string | null;
  getClientRects(): ArrayLike<unknown>;
  closest?(selector: string): GeminiDomElement | null;
}

export function parseGeminiRoute(rawUrl: string): GeminiRoute {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "gemini.google.com") return { kind: "invalid" };
    const match = /^\/(?:u\/\d+\/)?app(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/.exec(url.pathname);
    if (!match) return { kind: "invalid" };
    return match[1] ? { kind: "conversation", id: match[1] } : { kind: "draft" };
  } catch {
    return { kind: "invalid" };
  }
}

export function readGeminiPage(
  root: GeminiDomRoot,
  pageUrl: string,
  prompt: string,
  baseline?: GeminiPageBaseline,
): GeminiPageSnapshot {
  const route = parseGeminiRoute(pageUrl);
  const containers = asArray(root.querySelectorAll(GEMINI_CONVERSATION_SELECTOR));
  const userQueries = containers.map((container) => asArray(container.querySelectorAll(GEMINI_USER_SELECTOR)));
  const newUserQueries = userQueries.map((nodes, index) => baseline ? nodes.slice(baseline.userQueryCounts[index] ?? 0) : []);
  const candidateCount = newUserQueries.reduce((count, nodes) => count + nodes.length, 0);
  const candidateIndex = newUserQueries.findIndex((nodes) => nodes.length > 0);
  const canReadCandidate = baseline !== undefined && route.kind !== "invalid" && candidateCount === 1 &&
    !(baseline.route.kind === "draft" && route.kind === "conversation" &&
      baseline.draftContinuityCandidateIndex !== candidateIndex);
  const conversations = containers.map((container, index) => {
    const promptMatches = canReadCandidate && candidateIndex === index &&
      (newUserQueries[index]?.[0]?.textContent ?? "").trim() === prompt.trim() ? 1 : 0;
    const pendingRequests = asArray(container.querySelectorAll(GEMINI_PENDING_REQUEST_SELECTOR)).length;
    const pendingResponses = asArray(container.querySelectorAll(GEMINI_PENDING_RESPONSE_SELECTOR)).length;
    const modelNodes = asArray(container.querySelectorAll(GEMINI_MODEL_SELECTOR));
    const completeFooterCount = asArray(container.querySelectorAll(GEMINI_COMPLETE_SELECTOR)).length;
    const messageActionsCount = asArray(container.querySelectorAll(GEMINI_ACTIONS_SELECTOR)).length;
    const isFresh = baseline !== undefined && promptMatches > 0;
    const unprovenDraftNavigation = baseline?.route.kind === "draft" && route.kind === "conversation" &&
      baseline.draftContinuityCandidateIndex !== index;
    const newModelNodes = isFresh && !unprovenDraftNavigation &&
      modelNodes.length === (baseline?.modelResponseCounts[index] ?? 0) + 1
      ? modelNodes.slice(baseline?.modelResponseCounts[index] ?? 0)
      : [];
    const completeFooter = completeFooterCount > (baseline?.completeFooterCounts[index] ?? 0);
    const messageActions = messageActionsCount > (baseline?.messageActionsCounts[index] ?? 0);
    const modelResponses = newModelNodes.map((model): GeminiModelEvidence => ({
      body: model.querySelector(GEMINI_MODEL_BODY_SELECTOR)?.textContent ?? "",
      completeFooter,
      messageActions,
      responseInfo: container.querySelector(GEMINI_RESPONSE_INFO_SELECTOR) !== null,
      ariaBusy: hasBusyState(container) || hasBusyState(model),
    }));
    return {
      userQueryCount: userQueries[index]?.length ?? 0,
      promptMatches,
      pendingRequests,
      pendingResponses,
      modelResponseCount: modelNodes.length,
      completeFooterCount,
      messageActionsCount,
      modelResponses,
    };
  });
  const alerts = asArray(root.querySelectorAll('[role="alert"]'));
  const stops = asArray(root.querySelectorAll(GEMINI_STOP_SELECTOR));
  return {
    route,
    conversations,
    pageError: alerts.some(isVisible),
    stopVisible: stops.some(isVisible),
  };
}

export function watchGeminiStopClicks(root: GeminiDomRoot, onStop: () => void): () => void {
  if (!root.addEventListener || !root.removeEventListener) return () => undefined;
  const listener = (event: { target: unknown }) => {
    const target = event.target;
    if (!target || typeof target !== "object" || !("closest" in target)) return;
    const closest = (target as { closest?: (selector: string) => GeminiDomElement | null }).closest;
    const matched = typeof closest === "function" ? closest.call(target, GEMINI_STOP_SELECTOR) : null;
    if (matched && isVisible(matched)) onStop();
  };
  root.addEventListener("click", listener, true);
  return () => root.removeEventListener?.("click", listener, true);
}

export function createGeminiDomPort(getRoot: () => GeminiDomRoot, getUrl: () => string): GeminiPagePort {
  return {
    read(prompt, baseline) {
      return readGeminiPage(getRoot(), getUrl(), prompt, baseline);
    },
    readPrompt() {
      return composerInput(getRoot())?.textContent ?? null;
    },
    writePrompt(prompt) {
      const input = composerInput(getRoot());
      if (!input || !("textContent" in input)) return false;
      input.textContent = prompt;
      const dispatch = (input as unknown as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
      if (typeof dispatch === "function" && typeof InputEvent === "function") {
        dispatch.call(input, new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));
      }
      return (input.textContent ?? "").trim() === prompt.trim();
    },
    submit() {
      const buttons = asArray(getRoot().querySelectorAll(GEMINI_SEND_SELECTOR)).filter(isVisible);
      const button = buttons.at(-1);
      if (!button || isDisabled(button)) return false;
      const click = (button as unknown as { click?: unknown }).click;
      if (typeof click !== "function") return false;
      click.call(button);
      return true;
    },
    watchStop(onStop) {
      return watchGeminiStopClicks(getRoot(), onStop);
    },
  };
}

function composerInput(root: GeminiDomRoot): GeminiDomElement | null {
  const visible = asArray(root.querySelectorAll(GEMINI_PROMPT_SELECTOR))
    .filter((node) => isVisible(node) && !hasClass(node, "ql-clipboard"));
  const textboxes = visible.filter((node) => node.getAttribute("role") === "textbox");
  const candidates = textboxes.length > 0 ? textboxes : visible;
  const chosen = candidates[0];
  return candidates.length === 1 && chosen ? chosen : null;
}

function hasClass(node: GeminiDomElement, name: string): boolean {
  return (node.getAttribute("class") ?? "").split(/\s+/).includes(name);
}

function hasBusyState(node: GeminiDomElement): boolean {
  return node.getAttribute("aria-busy") === "true" || node.querySelector('[aria-busy="true"]') !== null;
}

function isVisible(node: GeminiDomElement): boolean {
  return node.getClientRects().length > 0;
}

function isDisabled(node: GeminiDomElement): boolean {
  return node.getAttribute("disabled") !== null ||
    ("disabled" in node && Boolean((node as unknown as { disabled?: boolean }).disabled));
}

function asArray<T>(value: ArrayLike<T>): T[] {
  return Array.prototype.slice.call(value) as T[];
}
