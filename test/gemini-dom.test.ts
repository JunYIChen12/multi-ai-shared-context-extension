import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEMINI_PROMPT_SELECTOR,
  parseGeminiRoute,
  createGeminiDomPort,
  readGeminiPage,
  type GeminiDomElement,
  type GeminiDomRoot,
  type GeminiPageBaseline,
  type GeminiPageSnapshot,
} from "../src/extension/gemini-dom.js";

describe("Gemini DOM evidence boundary", () => {
  it("reads the current visible composer text for pre-send validation", () => {
    const input = new OfflineNode("div", { contenteditable: "true" }, "first prompt");
    const root: GeminiDomRoot = {
      querySelector: () => null,
      querySelectorAll: (selector) => selector === GEMINI_PROMPT_SELECTOR ? [input] : [],
    };
    const port = createGeminiDomPort(() => root, () => "https://gemini.google.com/app");
    assert.equal(port.readPrompt(), "first prompt");
    input.textContent = "changed prompt";
    assert.equal(port.readPrompt(), "changed prompt");

    const emptyRoot: GeminiDomRoot = { querySelector: () => null, querySelectorAll: () => [] };
    const empty = createGeminiDomPort(() => emptyRoot, () => "https://gemini.google.com/app");
    assert.equal(empty.readPrompt(), null);
  });

  it("accepts only Gemini app routes and distinguishes draft from conversation", () => {
    assert.deepEqual(parseGeminiRoute("https://gemini.google.com/app"), { kind: "draft" });
    assert.deepEqual(parseGeminiRoute("https://gemini.google.com/u/0/app/abc123"), {
      kind: "conversation", id: "abc123",
    });
    assert.deepEqual(parseGeminiRoute("https://gemini.google.com.attacker.test/app"), { kind: "invalid" });
    assert.deepEqual(parseGeminiRoute("https://gemini.google.com/settings"), { kind: "invalid" });
    assert.deepEqual(parseGeminiRoute("http://gemini.google.com/app"), { kind: "invalid" });
  });

  it("does not read old user or model bodies and reads only the differential user and model turn", () => {
    const old = conversation("older prompt", "OLD_PRIVATE_REPLY");
    old.user.throwOnTextRead = true;
    const root = new OfflineNode("main");
    root.append(old.container);
    const baseline = readGeminiPage(root, "https://gemini.google.com/app/old", "target prompt");
    assert.equal(baseline.conversations[0]?.promptMatches, 0);
    assert.equal(baseline.conversations[0]?.modelResponseCount, 1);
    assert.deepEqual(baseline.conversations[0]?.modelResponses, []);
    assert.equal(old.body.textReads, 0);

    const current = conversation("target prompt", "GEMINI_LIVE_OK");
    root.append(current.container);
    const observed = readGeminiPage(
      root,
      "https://gemini.google.com/app/new",
      "target prompt",
      pageBaseline(baseline),
    );
    assert.equal(current.body.textReads, 1);
    assert.equal(old.body.textReads, 0);
    assert.equal(observed.conversations[1]?.promptMatches, 1);
    assert.deepEqual(observed.conversations[1]?.modelResponses, [{
      body: "GEMINI_LIVE_OK",
      completeFooter: true,
      messageActions: true,
      responseInfo: false,
      ariaBusy: false,
    }]);
  });

  it("未在草稿页确认 pending 前，正式路由中的同文旧回复正文不读取", () => {
    const root = new OfflineNode("main");
    const baseline = readGeminiPage(root, "https://gemini.google.com/app", "target prompt");
    const old = conversation("target prompt", "OLD_SAME_PROMPT_REPLY");
    root.append(old.container);

    const baselineWithRoute = pageBaseline(baseline);
    const current = readGeminiPage(
      root,
      "https://gemini.google.com/u/0/app/old-conversation",
      "target prompt",
      baselineWithRoute,
    );

    assert.equal(current.conversations[0]?.promptMatches, 1);
    assert.equal(current.conversations[0]?.modelResponseCount, 1);
    assert.deepEqual(current.conversations[0]?.modelResponses, []);
    assert.equal(old.body.textReads, 0);
  });

  it("只读取同一会话基线后的新回复，历史正文和完成标记不冒充本轮证据", () => {
    const old = conversation("repeatable prompt", "OLD_PRIVATE_REPLY");
    const root = new OfflineNode("main");
    root.append(old.container);
    const pageUrl = "https://gemini.google.com/u/0/app/chat-1";
    const baseline = readGeminiPage(root, pageUrl, "repeatable prompt");
    assert.equal(old.body.textReads, 0);

    old.container.append(new OfflineNode("user-query", {}, "repeatable prompt"));
    const response = new OfflineNode("model-response");
    const newBody = new OfflineNode("div", { class: "model-response-content" }, "PARTIAL_REPLY");
    response.append(newBody);
    old.container.append(response);

    const current = readGeminiPage(root, pageUrl, "repeatable prompt", pageBaseline(baseline));
    const evidence = current.conversations[0];
    assert.equal(old.body.textReads, 0);
    assert.equal(evidence?.modelResponseCount, 2);
    assert.deepEqual(evidence?.modelResponses, [{
      body: "PARTIAL_REPLY",
      completeFooter: false,
      messageActions: false,
      responseInfo: false,
      ariaBusy: false,
    }]);
  });
});

function conversation(prompt: string, body: string): { container: OfflineNode; user: OfflineNode; body: OfflineNode } {
  const container = new OfflineNode("div", { class: "conversation-container" });
  const user = new OfflineNode("user-query", {}, prompt);
  container.append(user);
  const response = new OfflineNode("model-response");
  const text = new OfflineNode("div", { class: "model-response-content" }, body);
  response.append(text);
  response.append(new OfflineNode("div", { class: "response-footer complete" }));
  response.append(new OfflineNode("div", { class: "message-actions" }));
  container.append(response);
  return { container, user, body: text };
}

function pageBaseline(snapshot: GeminiPageSnapshot): GeminiPageBaseline {
  return {
    route: snapshot.route,
    userQueryCounts: snapshot.conversations.map((item) => item.userQueryCount),
    modelResponseCounts: snapshot.conversations.map((item) => item.modelResponseCount),
    completeFooterCounts: snapshot.conversations.map((item) => item.completeFooterCount),
    messageActionsCounts: snapshot.conversations.map((item) => item.messageActionsCount),
  };
}

class OfflineNode implements GeminiDomRoot, GeminiDomElement {
  readonly children: OfflineNode[] = [];
  parent: OfflineNode | null = null;
  textReads = 0;
  throwOnTextRead = false;

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string> = {},
    private text = "",
  ) {}

  get textContent(): string {
    if (this.throwOnTextRead) throw new Error("old user-query body was read");
    this.textReads += 1;
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string | null) {
    this.text = value ?? "";
    this.children.splice(0);
  }

  append(child: OfflineNode): void {
    child.parent = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  getClientRects(): ArrayLike<unknown> { return [{}]; }
  querySelectorAll(selector: string): OfflineNode[] { return query(this, selector); }
  querySelector(selector: string): OfflineNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): OfflineNode | null {
    let current: OfflineNode | null = this;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function query(start: OfflineNode, selector: string): OfflineNode[] {
  const result: OfflineNode[] = [];
  const visit = (node: OfflineNode) => {
    if (matches(node, selector)) result.push(node);
    for (const child of node.children) {
      child.parent = node;
      visit(child);
    }
  };
  for (const child of start.children) visit(child);
  return result;
}

function matches(node: OfflineNode, selector: string): boolean {
  return selector.split(",").some((part) => {
    const value = part.trim();
    const tag = /^([a-z][a-z\d-]*)/i.exec(value)?.[1];
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const classTokens = [...value.matchAll(/\.([\w-]+)/g)]
      .map((match) => match[1])
      .filter((token): token is string => token !== undefined);
    const nodeClasses = new Set((node.getAttribute("class") ?? "").split(/\s+/));
    if (classTokens.some((token) => !nodeClasses.has(token))) return false;
    const attributes = [...value.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    return attributes.every((match) => match[2] === undefined
      ? node.getAttribute(match[1] ?? "") !== null
      : node.getAttribute(match[1] ?? "") === match[2]);
  });
}
