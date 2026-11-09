import {
  parseSessionUrl,
  type ChatGptEvidencePort,
  type PageEvidence,
  type ReadState,
  type StructuralTurn,
} from "./chatgpt-evidence.js";

export const CHATGPT_PROMPT_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
export const CHATGPT_SEND_SELECTOR =
  '[data-testid="send-button"], button[aria-label="发送"], button[aria-label="Send prompt"]';
export const CHATGPT_STOP_SELECTOR =
  '[data-testid="stop-button"], button[aria-label="停止"], button[aria-label="停止生成"], button[aria-label="Stop generating"]';
export const CHATGPT_TURN_SELECTOR = '[data-chatgpt-search-unit-key]';
const CHATGPT_TURN_WRAPPER_SELECTOR = '[data-turn-key]';

/**
 * 当前页面的复制控件位于包含 user/assistant 单元的 turn wrapper 中。
 * 这些名字来自公开界面里常见的复制按钮写法，当前 ChatGPT 页面是否使用它们尚未核验。
 * 找不到就当作不可读，不能把“没找到”解释成已经结束或尚未结束。
 */
export const CHATGPT_END_SELECTOR =
  'button[aria-label="Copy"], button[aria-label="复制"], button[aria-label="Copy response"], [data-testid="copy-turn-action-button"]';

/**
 * 可见的 role=alert 当作页面错误；没有可见 alert 只有在当前 composer 可读时才算无可见错误。
 * 当前页面是否用这个标记表达错误尚未核验。
 */
export const CHATGPT_ERROR_SELECTOR = '[role="alert"]';

export interface EvidenceQueryRoot {
  querySelector(selector: string): EvidenceQueryElement | null;
  querySelectorAll(selector: string): ArrayLike<EvidenceQueryElement>;
  addEventListener?(type: string, listener: (event: { target: unknown }) => void, capture?: boolean): void;
  removeEventListener?(type: string, listener: (event: { target: unknown }) => void, capture?: boolean): void;
}

export interface EvidenceQueryElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): EvidenceQueryElement | null;
  querySelectorAll(selector: string): ArrayLike<EvidenceQueryElement>;
  textContent: string | null;
  getClientRects(): ArrayLike<unknown>;
  closest?(selector: string): EvidenceQueryElement | null;
}

export function lastVisible<T extends { getClientRects(): ArrayLike<unknown> }>(elements: ArrayLike<T>): T | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element && element.getClientRects().length > 0) {
      return element;
    }
  }
  return null;
}

export function readPageEvidence(
  root: EvidenceQueryRoot,
  pageUrl: string,
  textTurnIds: readonly string[],
): PageEvidence {
  const requested = new Set(textTurnIds);
  const nodes = [...asArray(root.querySelectorAll(CHATGPT_TURN_SELECTOR))];
  const parsed: Array<{
    node: EvidenceQueryElement;
    wrapper: EvidenceQueryElement;
    id: string;
    role: "user" | "assistant";
    order: number;
  }> = [];
  const wrappers = new Map<string, EvidenceQueryElement>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    const unitKey = node.getAttribute("data-chatgpt-search-unit-key") ?? "";
    const role = unitKey.endsWith(":user") ? "user" : unitKey.endsWith(":assistant") ? "assistant" : null;
    const unitPrefix = role ? unitKey.slice(0, -(role.length + 1)).trim() : "";
    const id = node.getAttribute("data-chatgpt-search-message-ids")?.trim();
    const wrapper = node.closest?.(CHATGPT_TURN_WRAPPER_SELECTOR) ?? null;
    const wrapperKey = wrapper?.getAttribute("data-turn-key")?.trim();
    const priorWrapper = wrapperKey ? wrappers.get(wrapperKey) : undefined;
    if (!role || !unitPrefix || unitKey.length > 200 || !id || id.length > 200 || !wrapper || !wrapperKey
      || wrapperKey.length > 200
      || (priorWrapper && priorWrapper !== wrapper)) {
      return {
        session: parseSessionUrl(pageUrl),
        turns: { state: "unreadable" },
        composerStop: readComposerStop(root),
        pageError: readPageError(root),
      };
    }
    wrappers.set(wrapperKey, wrapper);
    parsed.push({ node, wrapper, id, role, order: index });
  }
  for (const wrapper of wrappers.values()) {
    const pair = parsed.filter((item) => item.wrapper === wrapper);
    const units = asArray(wrapper.querySelectorAll(CHATGPT_TURN_SELECTOR));
    const users = pair.filter((item) => item.role === "user").length;
    const assistants = pair.filter((item) => item.role === "assistant").length;
    const userArriving = pair.length === 1 && units.length === 1 && users === 1 && assistants === 0;
    const completeTurn = pair.length === 2 && units.length === 2 && users === 1 && assistants === 1;
    if ((!userArriving && !completeTurn)
      || units.some((unit) => !pair.some((item) => item.node === unit))) {
      return {
        session: parseSessionUrl(pageUrl),
        turns: { state: "unreadable" },
        composerStop: readComposerStop(root),
        pageError: readPageError(root),
      };
    }
  }
  const turns: StructuralTurn[] = parsed.map((item) => {
    const turn: StructuralTurn = {
      id: item.id,
      role: item.role,
      order: item.order,
      endControl: item.role === "assistant" ? readEndControl(item.wrapper) : { state: "unreadable" },
    };
    if (requested.has(item.id)) {
      turn.text = readTurnBody(item.node);
    }
    return turn;
  });
  return {
    session: parseSessionUrl(pageUrl),
    turns: { state: "ready", value: turns },
    composerStop: readComposerStop(root),
    pageError: readPageError(root),
  };
}

export function watchStopClicks(root: EvidenceQueryRoot, onStop: () => void): () => void {
  if (!root.addEventListener || !root.removeEventListener) {
    return () => undefined;
  }
  const listener = (event: { target: unknown }) => {
    const target = event.target;
    if (!target || typeof target !== "object" || !("closest" in target)) {
      return;
    }
    const closest = (target as { closest?: (selector: string) => EvidenceQueryElement | null }).closest;
    const matched = typeof closest === "function" ? closest.call(target, CHATGPT_STOP_SELECTOR) : null;
    if (matched && typeof matched.getClientRects === "function" && matched.getClientRects().length > 0) {
      onStop();
    }
  };
  root.addEventListener("click", listener, true);
  return () => root.removeEventListener?.("click", listener, true);
}

export function createDomEvidencePort(
  getRoot: () => EvidenceQueryRoot,
  getUrl: () => string,
): ChatGptEvidencePort {
  return {
    read(request) {
      return readPageEvidence(getRoot(), getUrl(), request.textTurnIds);
    },
    writePrompt(prompt) {
      const input = lastVisible(getRoot().querySelectorAll(CHATGPT_PROMPT_SELECTOR));
      if (!input || !canEdit(input)) {
        return false;
      }
      writeEditable(input, prompt);
      return true;
    },
    submit() {
      const button = lastVisible(getRoot().querySelectorAll(CHATGPT_SEND_SELECTOR));
      if (!button || isDisabled(button)) {
        return false;
      }
      const click = (button as unknown as { click?: unknown }).click;
      if (typeof click === "function") {
        click.call(button);
      }
      return true;
    },
    watchStop(onStop) {
      return watchStopClicks(getRoot(), onStop);
    },
  };
}

function readEndControl(wrapper: EvidenceQueryElement): ReadState<true> {
  const controls = asArray(wrapper.querySelectorAll(CHATGPT_END_SELECTOR))
    .filter((control) => control.getClientRects().length > 0);
  if (controls.length !== 1) {
    return { state: "unreadable" };
  }
  return { state: "ready", value: true };
}

function readComposerStop(root: EvidenceQueryRoot): ReadState<boolean> {
  const prompts = asArray(root.querySelectorAll(CHATGPT_PROMPT_SELECTOR))
    .filter((prompt) => prompt.getClientRects().length > 0);
  if (prompts.length !== 1) {
    return { state: "unreadable" };
  }
  const stops = asArray(root.querySelectorAll(CHATGPT_STOP_SELECTOR)).filter((control) => control.getClientRects().length > 0);
  const sends = asArray(root.querySelectorAll(CHATGPT_SEND_SELECTOR)).filter((control) => control.getClientRects().length > 0);
  if (stops.length === 1 && sends.length === 0) {
    return { state: "ready", value: true };
  }
  if (stops.length === 0 && sends.length === 1) {
    return { state: "ready", value: false };
  }
  return { state: "unreadable" };
}

function readPageError(root: EvidenceQueryRoot): ReadState<"none" | "present"> {
  const alerts = asArray(root.querySelectorAll(CHATGPT_ERROR_SELECTOR));
  if (alerts.some((alert) => alert.getClientRects().length > 0)) {
    return { state: "ready", value: "present" };
  }
  return readComposerStop(root).state === "ready"
    ? { state: "ready", value: "none" }
    : { state: "unreadable" };
}

function readTurnBody(node: EvidenceQueryElement): string {
  const copy = (node as unknown as Element).cloneNode(true) as Element;
  for (const button of asArray(copy.querySelectorAll("button"))) {
    button.textContent = "";
  }
  return copy.textContent ?? "";
}

function canEdit(element: EvidenceQueryElement): boolean {
  return "value" in element || "textContent" in element;
}

function writeEditable(element: EvidenceQueryElement, prompt: string): void {
  if ("value" in element) {
    (element as { value?: string }).value = prompt;
  } else {
    element.textContent = prompt;
  }
  const dispatch = (element as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  if (typeof dispatch === "function" && typeof InputEvent === "function") {
    dispatch.call(element, new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));
  }
}

function isDisabled(element: EvidenceQueryElement): boolean {
  return "disabled" in element && Boolean((element as { disabled?: boolean }).disabled);
}

function asArray<T>(value: ArrayLike<T>): T[] {
  return Array.prototype.slice.call(value) as T[];
}
