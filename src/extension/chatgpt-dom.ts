export const CHATGPT_PROMPT_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
export const CHATGPT_SEND_SELECTOR =
  '[data-testid="send-button"], button[aria-label="发送"], button[aria-label="Send prompt"]';
export const CHATGPT_STOP_SELECTOR =
  '[data-testid="stop-button"], button[aria-label="停止生成"], button[aria-label="Stop generating"]';

export function lastVisible<T extends { getClientRects(): ArrayLike<unknown> }>(elements: ArrayLike<T>): T | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element && element.getClientRects().length > 0) {
      return element;
    }
  }
  return null;
}
