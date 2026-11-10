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

  it("按已观察到的 unit 身份和共享 turn wrapper 读取，并只在 composer 锚定后报告空闲和无可见错误", () => {
    assert.match(CHATGPT_TURN_SELECTOR, /data-chatgpt-search-unit-key/);
    assert.doesNotMatch(CHATGPT_TURN_SELECTOR, /data-message-author-role/);
    assert.match(CHATGPT_STOP_SELECTOR, /aria-label="停止"/);

    const { root, assistantId } = observedPage();
    const read = readPageEvidence(root, "https://chatgpt.com/", [assistantId]);
    assert.equal(read.turns.state, "ready");
    if (read.turns.state === "ready") {
      assert.deepEqual(read.turns.value.map(({ id, role }) => ({ id, role })), [
        { id: "user-message-1", role: "user" },
        { id: assistantId, role: "assistant" },
      ]);
      assert.deepEqual(read.turns.value[1]?.endControl, { state: "ready", value: true });
      assert.equal(read.turns.value[1]?.text, "ANSWER");
    }
    assert.deepEqual(read.composerStop, { state: "ready", value: false });
    assert.deepEqual(read.pageError, { state: "ready", value: "none" });

    const unanchored = readPageEvidence(new OfflineNode("div"), "https://chatgpt.com/", []);
    assert.deepEqual(unanchored.composerStop, { state: "unreadable" });
    assert.deepEqual(unanchored.pageError, { state: "unreadable" });

    const generating = offlinePage();
    generating.send.rects = 0;
    generating.root.children.push(new OfflineNode("button", { "aria-label": "停止" }));
    assert.deepEqual(
      readPageEvidence(generating.root, "https://chatgpt.com/", []).composerStop,
      { state: "ready", value: true },
    );
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
  parent: OfflineNode | null = null;
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
    this.children = [];
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

  closest(selector: string): OfflineNode | null {
    let current: OfflineNode | null = this;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }

  cloneNode(deep = false): OfflineNode {
    const clone = new OfflineNode(this.tag, { ...this.attrs }, this.body);
    clone.children = deep ? this.children.map((child) => child.cloneNode(true)) : [];
    return clone;
  }

  click(): void {
    this.clicks += 1;
  }
}

function query(start: OfflineNode, selector: string): OfflineNode[] {
  const found: OfflineNode[] = [];
  const visit = (node: OfflineNode, includeSelf: boolean, parent: OfflineNode | null) => {
    node.parent = parent;
    if (includeSelf && matches(node, selector)) found.push(node);
    for (const child of node.children) visit(child, true, node);
  };
  visit(start, false, null);
  return found;
}

function matches(node: OfflineNode, selector: string): boolean {
  return selector.split(",").some((part) => matchesSimple(node, part.trim()));
}

function matchesSimple(node: OfflineNode, selector: string): boolean {
  if (selector.startsWith("#")) {
    return node.attrs.id === selector.slice(1);
  }
  const tag = /^[a-z][a-z0-9]*/i.exec(selector);
  let rest = selector;
  if (tag) {
    if (node.tag !== tag[0]) return false;
    rest = selector.slice(tag[0].length);
  }
  const attrs = [...rest.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
  if (!tag && attrs.length === 0) return false;
  return attrs.every((match) => match[2] === undefined
    ? match[1] !== undefined && match[1] in node.attrs
    : node.attrs[match[1] ?? ""] === match[2]);
}

function offlinePage(): { root: OfflineNode; prompt: OfflineNode; send: OfflineNode } {
  const root = new OfflineNode("div");
  const prompt = new OfflineNode("textarea", { id: "prompt-textarea" });
  const send = new OfflineNode("button", { "data-testid": "send-button", "aria-label": "发送" });
  root.children.push(prompt, send);
  return { root, prompt, send };
}

function observedPage(): { root: OfflineNode; assistantId: string } {
  const { root } = offlinePage();
  return { root, assistantId: appendObservedTurn(root) };
}

function appendObservedTurn(root: OfflineNode, text = "ANSWER", withCopy = true): string {
  const assistantId = `assistant-message-${root.children.length}`;
  const wrapper = new OfflineNode("div", { "data-turn-key": "turn-1" });
  wrapper.children.push(
    new OfflineNode("div", {
      "data-chatgpt-search-unit-key": "unit-1:user",
      "data-chatgpt-search-message-ids": "user-message-1",
    }),
    new OfflineNode("div", {
      "data-chatgpt-search-unit-key": "unit-1:assistant",
      "data-chatgpt-search-message-ids": assistantId,
    }, text),
  );
  if (withCopy) wrapper.children.push(new OfflineNode("button", { "aria-label": "复制" }, "Copy"));
  root.children.push(wrapper);
  return assistantId;
}

function appendUserOnlyTurn(root: OfflineNode): OfflineNode {
  const wrapper = new OfflineNode("div", { "data-turn-key": "streaming-turn" });
  wrapper.children.push(new OfflineNode("div", {
    "data-chatgpt-search-unit-key": "streaming-unit:user",
    "data-chatgpt-search-message-ids": "user-stream",
  }));
  root.children.push(wrapper);
  return wrapper;
}

function appendAssistantTo(wrapper: OfflineNode, id: string, text: string): void {
  wrapper.children.push(new OfflineNode("div", {
    "data-chatgpt-search-unit-key": "streaming-unit:assistant",
    "data-chatgpt-search-message-ids": id,
  }, text));
  wrapper.children.push(new OfflineNode("button", { "aria-label": "Copy" }, "Copy"));
}

describe("离线 DOM 模拟（不是 ChatGPT 页面）", () => {
  it("隐藏的角色标题不进入回复正文，正文中的 ChatGPT 原样保留", () => {
    const { root, assistantId } = observedPage();
    const wrapper = root.children.find((child) => child.attrs["data-turn-key"] === "turn-1");
    const assistant = wrapper?.children.find((child) => child.attrs["data-chatgpt-search-unit-key"]?.endsWith(":assistant"));
    if (!assistant) throw new Error("assistant fixture missing");
    assistant.textContent = "";
    assistant.children.push(
      new OfflineNode("h4", { class: "sr-only" }, "ChatGPT 说：ChatGPT"),
      new OfflineNode("div", {}, "CHATGPT_LIVE_OK ChatGPT"),
    );

    const read = readPageEvidence(root, "https://chatgpt.com/", [assistantId]);
    assert.equal(read.turns.state, "ready");
    if (read.turns.state === "ready") {
      assert.equal(read.turns.value[1]?.text, "CHATGPT_LIVE_OK ChatGPT");
    }
  });

  it("正文里与按钮相同的 Copy 和复制文案不会被删掉", () => {
    const body = "正文包含 Copy 和复制";
    const { root, assistantId } = observedPage();
    const wrapper = root.children.find((child) => child.attrs["data-turn-key"] === "turn-1");
    const assistant = wrapper?.children.find((child) => child.attrs["data-chatgpt-search-unit-key"]?.endsWith(":assistant"));
    if (!assistant) throw new Error("assistant fixture missing");
    assistant.textContent = body;

    const read = readPageEvidence(root, "https://chatgpt.com/", [assistantId]);
    assert.equal(read.turns.state, "ready");
    if (read.turns.state === "ready") assert.equal(read.turns.value[1]?.text, body);
  });

  it("发送之后才出现的结构也不会被失配的 Stop 或错误选择器判成成功", async () => {
    const { root, send } = offlinePage();
    const old = new OfflineNode("div", { "data-message-author-role": "assistant", "data-message-id": "old" }, "OLD_SECRET");
    root.children.push(old);
    const port = createDomEvidencePort(() => root, () => "https://chatgpt.com/");
    let installed = false;
    const result = await runChatGptTurn(port, "问题", {
      polls: 4,
      stableChecks: 2,
      async wait() {
        if (send.clicks < 1 || installed) return;
        installed = true;
        appendObservedTurn(root, "OK", false);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(send.clicks, 1);
    assert.equal(old.textReads, 0);
    assert.equal(JSON.stringify(result).includes("Copy"), false);
    assert.equal(JSON.stringify(result).includes("OK"), false);
  });

  it("单独出现的 user 单元保持可读，等待 assistant 到达后才能成功", async () => {
    const intermediateRoot = offlinePage().root;
    appendUserOnlyTurn(intermediateRoot);
    const intermediate = readPageEvidence(intermediateRoot, "https://chatgpt.com/", []);
    assert.equal(intermediate.turns.state, "ready");
    if (intermediate.turns.state === "ready") {
      assert.deepEqual(intermediate.turns.value.map(({ id, role }) => ({ id, role })), [
        { id: "user-stream", role: "user" },
      ]);
    }

    const { root, send } = offlinePage();
    let waitsAfterSubmit = 0;
    let wrapper: OfflineNode | undefined;
    const result = await runChatGptTurn(
      createDomEvidencePort(() => root, () => "https://chatgpt.com/"),
      "问题",
      {
        polls: 4,
        stableChecks: 1,
        async wait() {
          if (send.clicks === 0) return;
          waitsAfterSubmit += 1;
          if (waitsAfterSubmit === 1) {
            wrapper = appendUserOnlyTurn(root);
          } else if (waitsAfterSubmit === 2 && wrapper) {
            appendAssistantTo(wrapper, "assistant-stream", "ANSWER");
          }
        },
      },
    );

    assert.deepEqual(result, { ok: true, body: "ANSWER" });
    assert.ok(waitsAfterSubmit >= 3);
    assert.equal(send.clicks, 1);
  });

  it("只含 assistant 或重复同角色单元的 wrapper 保持不可读", () => {
    for (const roles of [["assistant"], ["user", "user"], ["assistant", "assistant"]]) {
      const { root } = offlinePage();
      const wrapper = new OfflineNode("div", { "data-turn-key": "malformed-turn" });
      for (const [index, role] of roles.entries()) {
        wrapper.children.push(new OfflineNode("div", {
          "data-chatgpt-search-unit-key": `unit-${index}:${role}`,
          "data-chatgpt-search-message-ids": `message-${index}`,
        }));
      }
      root.children.push(wrapper);

      assert.deepEqual(readPageEvidence(root, "https://chatgpt.com/", []).turns, { state: "unreadable" });
    }
  });

  it("在已观察到的 DOM 结构上读取到归属、结束控件、空闲和无可见错误后才成功", async () => {
    const { root, send } = offlinePage();
    let installed = false;
    const result = await runChatGptTurn(
      createDomEvidencePort(() => root, () => "https://chatgpt.com/"),
      "问题",
      {
        polls: 4,
        stableChecks: 1,
        async wait() {
          if (send.clicks > 0 && !installed) {
            installed = true;
            appendObservedTurn(root, "ANSWER");
          }
        },
      },
    );

    assert.deepEqual(result, { ok: true, body: "ANSWER" });
    assert.equal(send.clicks, 1);
  });

  it("多个可见 composer 时无法判断页面按钮属于哪个输入区，必须停止在提交前", async () => {
    const { root, send } = offlinePage();
    root.children.push(new OfflineNode("div", { contenteditable: "true", role: "textbox" }));
    const read = readPageEvidence(root, "https://chatgpt.com/", []);
    assert.deepEqual(read.composerStop, { state: "unreadable" });
    assert.deepEqual(read.pageError, { state: "unreadable" });

    const result = await runChatGptTurn(
      createDomEvidencePort(() => root, () => "https://chatgpt.com/"),
      "问题",
      { polls: 1, stableChecks: 1, async wait() {} },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown");
    assert.equal(send.clicks, 0);
  });

  it("共享 wrapper 身份重复时不把轮次结构当成可读", () => {
    const { root } = observedPage();
    const ambiguous = new OfflineNode("div", { "data-turn-key": "turn-1" });
    ambiguous.children.push(
      new OfflineNode("div", {
        "data-chatgpt-search-unit-key": "unit-2:user",
        "data-chatgpt-search-message-ids": "user-message-2",
      }),
      new OfflineNode("div", {
        "data-chatgpt-search-unit-key": "unit-2:assistant",
        "data-chatgpt-search-message-ids": "assistant-message-2",
      }, "AMBIGUOUS"),
    );
    root.children.push(ambiguous);

    assert.deepEqual(readPageEvidence(root, "https://chatgpt.com/", []).turns, { state: "unreadable" });
  });

  it("正文不包含 wrapper 按钮文字；隐藏 alert 不挡可见错误；零命中只有在 composer 锚定后才可读", () => {
    const { root, assistantId } = observedPage();
    const read = readPageEvidence(root, "https://chatgpt.com/", [assistantId]);
    assert.equal(read.turns.state, "ready");
    if (read.turns.state === "ready") {
      assert.equal(read.turns.value[1]?.text?.includes("Copy"), false);
      assert.match(read.turns.value[1]?.text ?? "", /ANSWER/);
    }
    assert.deepEqual(read.composerStop, { state: "ready", value: false });
    assert.deepEqual(read.pageError, { state: "ready", value: "none" });

    const hidden = new OfflineNode("div", { role: "alert" }, "隐藏");
    hidden.rects = 0;
    const onlyHiddenPage = offlinePage();
    onlyHiddenPage.root.children.push(hidden);
    assert.deepEqual(
      readPageEvidence(onlyHiddenPage.root, "https://chatgpt.com/", []).pageError,
      { state: "ready", value: "none" },
    );
    const visible = new OfflineNode("div", { role: "alert" }, "可见错误");
    const alerts = new OfflineNode("div");
    alerts.children.push(hidden, visible);
    const alertRead = readPageEvidence(alerts, "https://chatgpt.com/", []);
    assert.equal(alertRead.pageError.state, "ready");
    if (alertRead.pageError.state === "ready") assert.equal(alertRead.pageError.value, "present");
  });

  it("没有稳定身份、没有结束控件或出现错误标记时不成功，也不读取那份正文", async () => {
    const missingId = offlinePage();
    const wrapper = new OfflineNode("div", { "data-turn-key": "malformed" });
    const secret = new OfflineNode("div", { "data-chatgpt-search-unit-key": "unit:user" }, "SECRET");
    wrapper.children.push(secret);
    missingId.root.children.push(wrapper);
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
        appendObservedTurn(root, "NO_END", false);
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
