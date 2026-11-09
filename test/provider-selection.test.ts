import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerIdsForMode } from "../src/extension/provider-selection.js";

describe("讨论页来源选择", () => {
  it("正式连接最多选择 ChatGPT，且尊重用户取消勾选", () => {
    assert.deepEqual(providerIdsForMode("live", ["chatgpt", "grok", "gemini"]), ["chatgpt"]);
    assert.deepEqual(providerIdsForMode("live", ["grok", "gemini"]), []);
  });

  it("MOCK 与正式勾选无关，未连接记录保持原选择", () => {
    assert.deepEqual(providerIdsForMode("mock", []), ["chatgpt", "grok", "gemini"]);
    assert.deepEqual(providerIdsForMode("unimplemented", ["grok"]), ["grok"]);
  });
});
