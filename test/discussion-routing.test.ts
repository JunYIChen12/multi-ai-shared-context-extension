import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canAttachProvider,
  connectionAckMatches,
  connectionAckRejectionCode,
  connectionRejectionCode,
  createConnectionRequest,
  findDiscussionDestination,
  isConnectionRequest,
  providerForTabId,
  readConnectedTabIds,
  sameDiscussionDestination,
  shouldDisconnectOnTabUpdate,
} from "../src/extension/discussion-routing.js";

const discussionUrl = "chrome-extension://abcdefghijklmnop/discussion.html";

describe("讨论页连接路由", () => {
  it("无目标页时可创建首个讨论页，唯一目标时按 tab ID 寻址", () => {
    assert.deepEqual(findDiscussionDestination([], discussionUrl, false), { kind: "none" });
    assert.deepEqual(
      findDiscussionDestination([context(17)], discussionUrl, false),
      { kind: "unique", tabId: 17 },
    );
  });

  it("只统计同扩展、同隐私分区的讨论页，并按标签页去重", () => {
    const contexts = [
      context(17),
      { ...context(17), frameId: 1 },
      { ...context(18), incognito: true },
      { ...context(19), documentUrl: "chrome-extension://abcdefghijklmnop/popup.html" },
      { ...context(20), documentUrl: "chrome-extension://otherextensionid/discussion.html" },
      { ...context(21), documentUrl: "https://chatgpt.com/c/redacted" },
    ];
    assert.deepEqual(findDiscussionDestination(contexts, discussionUrl, false), { kind: "unique", tabId: 17 });
    assert.deepEqual(findDiscussionDestination(contexts, discussionUrl, true), { kind: "unique", tabId: 18 });
  });

  it("有多个讨论页时拒绝猜测目标", () => {
    const destination = findDiscussionDestination([context(17), context(18)], discussionUrl, false);
    assert.deepEqual(destination, { kind: "ambiguous" });
    assert.equal(sameDiscussionDestination(destination, destination), false);
  });

  it("只接受发往指定讨论页、来自 ChatGPT 或 Gemini 正整数标签页的连接消息", () => {
    const request = createConnectionRequest(17, "gemini", 73);
    assert.equal(isConnectionRequest(request), true);
    assert.equal(isConnectionRequest({ ...request, providerTabId: 0 }), false);
    assert.equal(isConnectionRequest({ ...request, providerId: "grok" }), false);
    assert.equal(isConnectionRequest({ ...request, targetDiscussionTabId: 17.5 }), false);
    assert.equal(isConnectionRequest({ ...request, prompt: "do not route page content" }), false);
    assert.equal(connectionAckMatches({ ok: true, targetDiscussionTabId: 17 }, 17), true);
    assert.equal(connectionAckMatches({ ok: true, targetDiscussionTabId: 18 }, 17), false);
  });

  it("连接拒绝只暴露固定原因代码，不把任意响应数据当作原因", () => {
    assert.equal(connectionAckRejectionCode({ ok: false, code: "PROVIDER_TAB_NOT_READY", targetDiscussionTabId: 17 }, 17), "PROVIDER_TAB_NOT_READY");
    assert.equal(connectionAckRejectionCode({ ok: false, code: "private chat text", targetDiscussionTabId: 17 }, 17), "ACK_INVALID");
    assert.equal(connectionAckRejectionCode({ ok: false, code: "PROVIDER_TAB_NOT_READY", targetDiscussionTabId: 18 }, 17), "ACK_INVALID");
    assert.equal(connectionAckRejectionCode(undefined, 17), "ACK_INVALID");
  });

  it("两种连接顺序都能接入唯一讨论页；拒绝时返回具体且不覆盖旧连接", () => {
    const chatgptFirst = { chatgpt: 42 };
    const geminiFirst = { gemini: 73 };
    const request = createConnectionRequest(17, "gemini", 73);
    const unique = { kind: "unique" as const, tabId: 17 };
    const discussionTab = { id: 17, incognito: false };
    const readyTab = { status: "complete", incognito: false };
    assert.equal(connectionRejectionCode(request, discussionTab, unique, readyTab, chatgptFirst), null);
    assert.equal(connectionRejectionCode(createConnectionRequest(17, "chatgpt", 42), discussionTab, unique, readyTab, geminiFirst), null);
    assert.equal(connectionRejectionCode(request, discussionTab, unique, { ...readyTab, status: "loading" }, chatgptFirst), "PROVIDER_TAB_NOT_READY");
    assert.deepEqual(chatgptFirst, { chatgpt: 42 });
    assert.equal(connectionRejectionCode(request, { id: 18, incognito: false }, unique, readyTab, chatgptFirst), "TARGET_TAB_MISMATCH");
    assert.equal(connectionRejectionCode(request, discussionTab, { kind: "ambiguous" }, readyTab, chatgptFirst), "TARGET_NOT_UNIQUE");
    assert.equal(connectionRejectionCode(request, discussionTab, unique, { ...readyTab, incognito: true }, chatgptFirst), "INCOGNITO_MISMATCH");
    assert.equal(connectionRejectionCode(request, discussionTab, unique, readyTab, { chatgpt: 42, gemini: 74 }), "PROVIDER_ALREADY_CONNECTED");
    assert.equal(connectionRejectionCode(request, discussionTab, unique, readyTab, { chatgpt: 73 }), "TAB_ALREADY_CONNECTED");
  });

  it("连接地址只接受一个有效 provider 标签页，拒绝重复、非法或双 provider 参数", () => {
    assert.deepEqual(readConnectedTabIds("?chatgptTab=17&chatgptTab=18&geminiTab=0"), {});
    assert.deepEqual(readConnectedTabIds("?chatgptTab=17&geminiTab=73"), {});
    assert.deepEqual(readConnectedTabIds("?chatgptTab=17&chatgptTab=18&geminiTab=73"), {});
    assert.deepEqual(readConnectedTabIds("?chatgptTab=17"), { chatgpt: 17 });
    assert.deepEqual(readConnectedTabIds("?geminiTab=73"), { gemini: 73 });
  });

  it("不允许覆盖已连接的同一家，也不允许一标签页冒充两家", () => {
    const connected = { chatgpt: 17 };
    assert.equal(canAttachProvider(connected, "chatgpt", 18), false);
    assert.equal(canAttachProvider(connected, "gemini", 17), false);
    assert.equal(canAttachProvider(connected, "gemini", 73), true);
    assert.equal(providerForTabId({ chatgpt: 17, gemini: 73 }, 73), "gemini");
    assert.equal(providerForTabId({ chatgpt: 17, gemini: 17 }, 17), null);
  });

  it("站内地址变化不应断开，刷新或离开站点仍应断开", () => {
    assert.equal(
      shouldDisconnectOnTabUpdate("chatgpt", { status: "loading", url: "https://chatgpt.com/c/new" }),
      false,
    );
    assert.equal(
      shouldDisconnectOnTabUpdate("gemini", { status: "loading", url: "https://gemini.google.com/app/new" }),
      false,
    );
    assert.equal(shouldDisconnectOnTabUpdate("chatgpt", { status: "loading" }), true);
    assert.equal(
      shouldDisconnectOnTabUpdate("gemini", { status: "loading", url: "https://example.com/" }),
      true,
    );
    assert.equal(
      shouldDisconnectOnTabUpdate("chatgpt", { url: "https://example.com/" }),
      true,
    );
    assert.equal(
      shouldDisconnectOnTabUpdate("gemini", { url: "https://gemini.google.com/app/new" }),
      false,
    );
    assert.equal(
      shouldDisconnectOnTabUpdate("chatgpt", { status: "complete", url: "https://chatgpt.com/c/new" }),
      false,
    );
  });
});

function context(tabId: number) {
  return {
    contextType: "TAB",
    documentUrl: `${discussionUrl}?chatgptTab=${tabId}`,
    tabId,
    incognito: false,
    frameId: 0,
  };
}
