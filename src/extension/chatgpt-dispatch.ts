import type { ChatGptAskResult } from "./chatgpt-connector.js";

/**
 * 同一个标签页里的单飞锁。多个讨论页发到这个内容脚本时共用这一把锁。
 * 重复的 requestId，或锁被占用时的另一请求，都不会再次进入发送。
 */
export function createCollectionGate(
  run: (prompt: string, signal: AbortSignal) => Promise<ChatGptAskResult>,
): {
  ask(requestId: string, prompt: string): Promise<ChatGptAskResult>;
  cancel(requestId: string): void;
} {
  let active: { requestId: string; abort: () => void } | null = null;
  const finished = new Set<string>();

  return {
    async ask(requestId, prompt) {
      if (!requestId || finished.has(requestId) || active?.requestId === requestId) {
        return {
          ok: false,
          code: "in_flight",
          message: "同一请求正在处理或已经结束，不会再次发送",
        };
      }
      if (active) {
        return {
          ok: false,
          code: "in_flight",
          message: "这个标签页已有进行中的采集，不会再次发送",
        };
      }
      const controller = new AbortController();
      active = { requestId, abort: () => controller.abort() };
      try {
        return await run(prompt, controller.signal);
      } finally {
        if (active?.requestId === requestId) {
          active = null;
        }
        finished.add(requestId);
      }
    },
    cancel(requestId) {
      if (active?.requestId === requestId) {
        active.abort();
      }
    },
  };
}
