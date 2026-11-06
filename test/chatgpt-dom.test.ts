import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHATGPT_PROMPT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  lastVisible,
} from "../src/extension/chatgpt-dom.js";

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
