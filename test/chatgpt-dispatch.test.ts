import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatGptAskResult } from "../src/extension/chatgpt-connector.js";
import { createCollectionGate } from "../src/extension/chatgpt-dispatch.js";
import { abortableDelay, runChatGptTurn } from "../src/extension/chatgpt-turn.js";
import type { ChatGptEvidencePort, PageEvidence, StructuralTurn } from "../src/extension/chatgpt-evidence.js";
import { parseSessionUrl } from "../src/extension/chatgpt-evidence.js";

function done(text: string, ids: { user: string; assistant: string }): PageEvidence {
  const assistant: StructuralTurn = {
    id: ids.assistant,
    role: "assistant",
    order: 1,
    text,
    endControl: { state: "ready", value: true },
  };
  return {
    session: parseSessionUrl("https://chatgpt.com/"),
    turns: {
      state: "ready",
      value: [{ id: ids.user, role: "user", order: 0, endControl: { state: "unreadable" } }, assistant],
    },
    composerStop: { state: "ready", value: false },
    pageError: { state: "ready", value: "none" },
  };
}

describe("同一标签页的采集锁（离线，不是真实页面）", () => {
  it("两个入口同时请求时只发送一次，重复请求不会再发送", async () => {
    let runs = 0;
    let release = () => undefined as void;
    const gate = createCollectionGate(
      () =>
        new Promise<ChatGptAskResult>((resolve) => {
          runs += 1;
          release = () => resolve({ ok: true, body: "held" });
        }),
      { ok: false, code: "in_flight", message: "同一请求正在处理或已经结束，不会再次发送" },
      { ok: false, code: "in_flight", message: "这个标签页已有进行中的采集，不会再次发送" },
    );
    const first = gate.ask("request-a", "one");
    const second = await gate.ask("request-b", "two");
    const duplicate = await gate.ask("request-a", "one-again");
    assert.deepEqual(second, {
      ok: false, code: "in_flight", message: "这个标签页已有进行中的采集，不会再次发送",
    });
    assert.deepEqual(duplicate, {
      ok: false, code: "in_flight", message: "同一请求正在处理或已经结束，不会再次发送",
    });
    assert.equal(runs, 1);
    release();
    assert.deepEqual(await first, { ok: true, body: "held" });
    const replay = await gate.ask("request-a", "after");
    assert.deepEqual(replay, {
      ok: false, code: "in_flight", message: "同一请求正在处理或已经结束，不会再次发送",
    });
    assert.equal(runs, 1);
  });

  it("取消后清理锁，下一轮只接收自己的新回复", async () => {
    const empty: PageEvidence = {
      session: parseSessionUrl("https://chatgpt.com/"),
      turns: { state: "ready", value: [] },
      composerStop: { state: "ready", value: false },
      pageError: { state: "ready", value: "none" },
    };
    const late = done("LATE", { user: "u1", assistant: "a1" });
    const secondShape = done("SECOND", { user: "u2", assistant: "a2" });
    secondShape.turns = {
      state: "ready",
      value: [
        { id: "u1", role: "user", order: 0, endControl: { state: "unreadable" } },
        { id: "a1", role: "assistant", order: 1, text: "LATE", endControl: { state: "ready", value: true } },
        ...(secondShape.turns.state === "ready" ? secondShape.turns.value.map((turn) => ({ ...turn, order: turn.order + 2 })) : []),
      ],
    };
    let phase: "empty" | "late" | "second" = "empty";
    let secondReads = 0;
    let submits = 0;
    let started = () => undefined as void;
    const ready = new Promise<void>((resolve) => {
      started = () => resolve();
    });
    const page: ChatGptEvidencePort = {
      read(request) {
        if (phase === "empty") return empty;
        if (phase === "late") return late;
        secondReads += 1;
        if (secondReads <= 2) return late;
        return secondShape;
      },
      writePrompt() {
        return true;
      },
      submit() {
        submits += 1;
        return true;
      },
      watchStop() {
        return () => undefined;
      },
    };
    const gate = createCollectionGate((prompt, signal) =>
      runChatGptTurn(
        page,
        prompt,
        {
          polls: 4,
          stableChecks: 1,
          wait(signal) {
            if (prompt === "第一问") {
              started();
              return abortableDelay(5_000, signal);
            }
            return Promise.resolve();
          },
        },
        signal,
      ),
      { ok: false, code: "in_flight", message: "同一请求正在处理或已经结束，不会再次发送" },
      { ok: false, code: "in_flight", message: "这个标签页已有进行中的采集，不会再次发送" },
    );
    const firstPromise = gate.ask("round-1", "第一问");
    await ready;
    phase = "late";
    gate.cancel("round-1");
    const first = await firstPromise;
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.code, "cancelled");
    assert.equal(JSON.stringify(first).includes("LATE"), false);
    assert.equal(submits, 0);

    phase = "second";
    const second = await gate.ask("round-2", "第二问");
    assert.deepEqual(second, { ok: true, body: "SECOND" });
    assert.equal(submits, 1);
    assert.equal(JSON.stringify(second).includes("LATE"), false);
  });
});
