import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHATGPT_END_SELECTOR,
  CHATGPT_ERROR_SELECTOR,
  CHATGPT_PROMPT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  CHATGPT_STOP_SELECTOR,
  CHATGPT_TURN_SELECTOR,
  createDomEvidencePort,
  lastVisible,
  readPageEvidence,
  watchStopClicks,
  type EvidenceQueryElement,
  type EvidenceQueryRoot,
} from "../src/extension/chatgpt-dom.js";
import { runChatGptTurn } from "../src/extension/chatgpt-turn.js";

describe("ChatGPT DOM 边界", () => {
  it("兼容当前 contenteditable 输入框和无 data-testid 的发送按钮", () => {
    assert.match(CHATGPT_PROMPT_SELECTOR, /contenteditable/);
    assert.match(CHATGPT_SEND_SELECTOR, /aria-label/);

    const hidden = { getClientRects: () => [] };
    const visible = { getClientRects: () => [{}] };
    assert.equal(lastVisible([hidden, visible]), visible);
    assert.equal(lastVisible([hidden]), null);
  });
});

class OfflineNode implements EvidenceQueryRoot, EvidenceQueryElement {
  tag: string;
  attrs: Record<string, string>;
  children: OfflineNode[] = [];
  rects: number;
  disabled = false;
  value = "";
  clicks = 0;
  textReads = 0;
  private body: string;

  constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
    this.tag = tag;
    this.attrs = attrs;
    this.body = text;
    this.rects = 1;
  }

  get textContent(): string {
    this.textReads += 1;
    return this.body + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string | null) {
    this.body = value ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getClientRects(): ArrayLike<unknown> {
    return this.rects > 0 ? [{}] : [];
  }

  querySelector(selector: string): OfflineNode | null {
    return query(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): OfflineNode[] {
    return query(this, selector);
  }

  click(): void {
    this.clicks += 1;
  }
}

function query(start: OfflineNode, selector: string): OfflineNode[] {
  const found: OfflineNode[] = [];
  const visit = (node: OfflineNode, includeSelf: boolean) => {
    if (includeSelf && matches(node, selector)) found.push(node);
    for (const child of node.children) visit(child, true);
  };
  visit(start, false);
  return found;
}

function matches(node: OfflineNode, selector: string): boolean {
  return selector.split(",").some((part) => matchesSimple(node, part.trim()));
}

function matchesSimple(node: OfflineNode, selector: string): boolean {
  if (selector.startsWith("#")) {
    return node.attrs.id === selector.slice(1);
  }
  const tag = /^[a-z]+/i.exec(selector);
  let rest = selector;
  if (tag) {
    if (node.tag !== tag[0]) return false;
    rest = selector.slice(tag[0].length);
  }
  const attrs = [...rest.matchAll(/\[([^\]=]+)="([^"]*)"\]/g)];
  if (!tag && attrs.length === 0) return false;
  return attrs.every((match) => node.attrs[match[1] ?? ""] === match[2]);
}

function offlinePage(): { root: OfflineNode; prompt: OfflineNode; send: OfflineNode } {
  const root = new OfflineNode("div");
  const prompt = new OfflineNode("textarea", { id: "prompt-textarea" });
  const send = new OfflineNode("button", { "data-testid": "send-button" });
  root.children.push(prompt, send);
  return { root, prompt, send };
}

describe("离线 DOM 模拟（不是 ChatGPT 页面）", () => {
  it("发送之后才出现的结构也不会被失配的 Stop 或错误选择器判成成功", async () => {
    const { root, send } = offlinePage();
    const old = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "old" }, "OLD_SECRET");
    root.children.push(old);
    const port = createDomEvidencePort(() => root, () => "https://chatgpt.com/");
    const result = await runChatGptTurn(port, "问题", {
      polls: 4,
      stableChecks: 2,
      async wait() {
        if (send.clicks < 1 || root.children.some((child) => child.attrs["data-message-id"] === "u1")) return;
        const user = new OfflineNode("div", { "data-message-author-role": "user", "data-message-id": "u1" });
        const assistant = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "a1" }, "OK");
        assistant.children.push(new OfflineNode("button", { "aria-label": "Copy" }, "Copy"));
        root.children.push(user, assistant);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(send.clicks, 1);
    assert.equal(old.textReads, 0);
    assert.equal(JSON.stringify(result).includes("Copy"), false);
    assert.equal(JSON.stringify(result).includes("OK"), false);
  });

  it("正文不包含按钮文字；隐藏 alert 不能挡住后面的可见 alert；Stop 零命中不是已证实空闲", () => {
    const { root } = offlinePage();
    const assistant = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "a1" }, "OK");
    assistant.children.push(new OfflineNode("button", { "aria-label": "Copy" }, "Copy"));
    root.children.push(assistant);
    const read = readPageEvidence(root, "https://chatgpt.com/", ["a1"]);
    assert.equal(read.turns.state, "ready");
    if (read.turns.state === "ready") {
      assert.equal(read.turns.value[0]?.text?.includes("Copy"), false);
      assert.match(read.turns.value[0]?.text ?? "", /OK/);
    }
    assert.equal(read.composerStop.state, "unreadable");
    assert.equal(read.pageError.state, "unreadable");

    const onlyControl = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "a2" }, "");
    onlyControl.children.push(new OfflineNode("button", {}, "Copy"));
    const bare = new OfflineNode("div");
    bare.children.push(onlyControl);
    const bareRead = readPageEvidence(bare, "https://chatgpt.com/", ["a2"]);
    if (bareRead.turns.state === "ready") {
      assert.equal((bareRead.turns.value[0]?.text ?? "").trim(), "");
    }

    const hidden = new OfflineNode("div", { role: "alert" }, "隐藏");
    hidden.rects = 0;
    const visible = new OfflineNode("div", { role: "alert" }, "可见错误");
    const alerts = new OfflineNode("div");
    alerts.children.push(hidden, visible);
    const alertRead = readPageEvidence(alerts, "https://chatgpt.com/", []);
    assert.equal(alertRead.pageError.state, "ready");
    if (alertRead.pageError.state === "ready") assert.equal(alertRead.pageError.value, "present");
  });

  it("没有稳定身份、没有结束控件或出现错误标记时不成功，也不读取那份正文", async () => {
    const missingId = offlinePage();
    const secret = new OfflineNode("div", { "data-message-author-role": "assistant" }, "SECRET");
    missingId.root.children.push(secret);
    const unreadable = readPageEvidence(missingId.root, "https://chatgpt.com/", ["whatever"]);
    assert.equal(unreadable.turns.state, "unreadable");
    assert.equal(secret.textReads, 0);

    const { root, send } = offlinePage();
    let installed = false;
    const port = createDomEvidencePort(() => root, () => "https://chatgpt.com/");
    const result = await runChatGptTurn(port, "问题", {
      polls: 3,
      stableChecks: 1,
      async wait() {
        if (installed) return;
        installed = true;
        const user = new OfflineNode("div", { "data-message-author-role": "user", "data-message-id": "u1" });
        const assistant = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "a1" }, "NO_END");
        root.children.push(user, assistant);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(send.clicks, 1);
    assert.equal(JSON.stringify(result).includes("NO_END"), false);

    const errored = offlinePage();
    errored.root.children.push(new OfflineNode("div", { role: "alert" }, "配额"));
    const errorPort = createDomEvidencePort(() => errored.root, () => "https://chatgpt.com/");
    const errorResult = await runChatGptTurn(errorPort, "问题", { polls: 1, stableChecks: 1, async wait() {} });
    assert.equal(errorResult.ok, false);
    if (!errorResult.ok) assert.equal(errorResult.code, "page_error");
    assert.equal(errored.send.clicks, 0);
    assert.match(CHATGPT_ERROR_SELECTOR, /alert/);
  });

  it("只有点在停止控件上才记手停", () => {
    let clicks = 0;
    let listener: ((event: { target: unknown }) => void) | undefined;
    const root: EvidenceQueryRoot = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(_type, callback) {
        listener = callback;
      },
      removeEventListener() {
        listener = undefined;
      },
    };
    const disarm = watchStopClicks(root, () => {
      clicks += 1;
    });
    listener?.({
      target: {
        closest: (selector: string) => (selector === CHATGPT_STOP_SELECTOR ? { getClientRects: () => [{}] } : null),
      },
    });
    listener?.({
      target: {
        closest: (selector: string) => (selector === CHATGPT_STOP_SELECTOR ? { getClientRects: () => [] } : null),
      },
    });
    listener?.({ target: { closest: () => null } });
    assert.equal(clicks, 1);
    disarm();
    listener?.({ target: { closest: () => ({}) } });
    assert.equal(clicks, 1);
  });
});
