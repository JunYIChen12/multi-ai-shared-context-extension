import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerForTabUrl, providerIdsForMode, timeoutMsForRound } from "../src/extension/provider-selection.js";

describe("讨论页来源选择", () => {
  it("正式连接最多选择 ChatGPT，且尊重用户取消勾选", () => {
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "grok", "gemini"], ["chatgpt"]), ["chatgpt"]);
    assert.deepEqual(providerIdsForMode("live", ["grok", "gemini"], ["chatgpt"]), []);
  });

  it("Gemini 连接只选择 Gemini，不把 ChatGPT 或 Grok 混入本次正式发送", () => {
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "grok", "gemini"], ["gemini"]), ["gemini"]);
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "grok"], ["gemini"]), []);
  });

  it("允许单选或同时选择已连接的 ChatGPT 与 Gemini", () => {
    assert.deepEqual(providerIdsForMode("live", ["chatgpt"], ["chatgpt", "gemini"]), ["chatgpt"]);
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "gemini"], ["chatgpt", "gemini"]), ["chatgpt", "gemini"]);
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "gemini"], ["chatgpt"]), ["chatgpt"]);
  });

  it("MOCK 与正式勾选无关，未连接记录保持原选择", () => {
    assert.deepEqual(providerIdsForMode("mock", []), ["chatgpt", "grok", "gemini"]);
    assert.deepEqual(providerIdsForMode("unimplemented", ["grok"]), ["grok"]);
  });

  it("popup 只将已支持的 ChatGPT 与 Gemini HTTPS 页面路由到连接器", () => {
    assert.equal(providerForTabUrl("https://chatgpt.com/"), "chatgpt");
    assert.equal(providerForTabUrl("https://gemini.google.com/u/0/app"), "gemini");
    assert.equal(providerForTabUrl("http://gemini.google.com/app"), null);
    assert.equal(providerForTabUrl("https://gemini.google.com.evil.test/app"), null);
    assert.equal(providerForTabUrl("https://grok.com/"), null);
  });

  it("只有 Gemini 正式第一轮使用六分钟上限，ChatGPT 和演示仍是三十秒", () => {
    assert.equal(timeoutMsForRound("live", "gemini"), 360_000);
    assert.equal(timeoutMsForRound("live", "chatgpt"), 30_000);
    assert.equal(timeoutMsForRound("mock", "gemini"), 30_000);
  });
});
