import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canAttachProvider,
  connectionAckMatches,
  createConnectionRequest,
  findDiscussionDestination,
  isConnectionRequest,
  providerForTabId,
  readConnectedTabIds,
  sameDiscussionDestination,
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
