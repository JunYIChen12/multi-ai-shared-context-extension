import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestClock } from "../src/core/clock.js";
import { outcomeHeadline } from "../src/core/labels.js";
import { createSession, runIndependentRound } from "../src/core/orchestrate.js";
import { exportSession, parseSessionFile, parseSessionJsonl, sessionToMarkdown } from "../src/core/persist.js";
import { mockAdapter, unimplementedAdapter } from "../src/core/providers.js";
import type { ProviderAdapter, Session } from "../src/core/types.js";
import { MAX_IMPORT_CHARS } from "../src/core/types.js";

async function sample(): Promise<Session> {
  const options = {
    clock: createTestClock(),
    adapters: [mockAdapter("chatgpt"), mockAdapter("grok"), unimplementedAdapter("gemini")],
    timeoutMs: 1000,
    maxRounds: 2,
  };
  const created = createSession("原文要保留，包括 constructor 这个词", options);
  if (!created.ok) {
    assert.fail(created.detail);
  }
  const ran = await runIndependentRound(created.session, options);
  if (!ran.ok) {
    assert.fail(ran.detail);
  }
  return ran.session;
}

describe("本地导出与恢复", () => {
  it("live 记录可导出并以未验证属性恢复", async () => {
    const live: ProviderAdapter = {
      id: "chatgpt",
      mode: "live",
      async respond() {
        return { mode: "live", status: "complete", body: "CHATGPT_LIVE_OK" };
      },
    };
    const options = { clock: createTestClock(), adapters: [live], timeoutMs: 1000, maxRounds: 2 };
    const created = createSession("真实留痕", options);
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const ran = await runIndependentRound(created.session, options);
    assert.equal(ran.ok, true);
    if (!ran.ok) {
      return;
    }
    const parsed = parseSessionJsonl(exportSession(ran.session).jsonl);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    const reply = parsed.session.messages.find((message) => message.providerId === "chatgpt");
    assert.equal(reply?.adapterMode, "live");
    assert.equal(reply?.sourceKind, "provider");
    assert.equal(reply?.trust, "local_unverified_import");
  });

  it("超大文件在读取正文前就被拒绝", async () => {
    let reads = 0;
    const parsed = await parseSessionFile({
      size: MAX_IMPORT_CHARS * 4 + 1,
      async text() {
        reads += 1;
        return "不应读取";
      },
    });
    assert.equal(parsed.ok, false);
    assert.equal(reads, 0);
    assert.match(parsed.errors?.join("\n") ?? "", /文件大小超过/);
  });

  it("Markdown 保留原文、MOCK 和未接入，JSONL 可恢复但降级信任", async () => {
    const session = await sample();
    const exported = exportSession(session);
    assert.match(exported.basename, /^AI-REQ-20261105-001-/);
    assert.match(exported.markdown, /原文要保留，包括 constructor 这个词/);
    assert.match(exported.markdown, /\[MOCK\]/);
    assert.match(exported.markdown, /未接入/);
    assert.match(exported.markdown, /AI-REQ-20261105-001/);
    const parsed = parseSessionJsonl(exported.jsonl);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.session.messages[0]?.body, session.messages[0]?.body);
    assert.equal(parsed.session.messages[0]?.trust, "local_unverified_import");
    assert.equal(parsed.session.requirementId, "AI-REQ-20261105-001");
    const mock = parsed.session.messages.find((message) => message.sourceKind === "mock");
    const gap = parsed.session.messages.find((message) => message.status === "not_connected");
    assert.equal(mock?.body, session.messages.find((message) => message.sourceKind === "mock")?.body);
    assert.equal(gap?.providerId, "gemini");
    assert.match(sessionToMarkdown(parsed.session), /未验证导入|MOCK 演示|未接入/);
  });

  it("拒绝损坏、伪造信任、错误需求和伪装完成的导入", async () => {
    const session = await sample();
    const exported = exportSession(session);
    assert.equal(parseSessionJsonl("").ok, false);
    assert.equal(parseSessionJsonl("{").ok, false);
    assert.equal(parseSessionJsonl("[]\n").ok, false);

    const trusted = exported.jsonl.replace(
      '"type":"message"',
      '"type":"message","trust":"created_by_core","authenticated":true',
    );
    const downgraded = parseSessionJsonl(trusted);
    assert.equal(downgraded.ok, true);
    if (downgraded.ok) {
      assert.equal(JSON.stringify(downgraded.session).includes("authenticated"), false);
      assert.equal(JSON.stringify(downgraded.session).includes("created_by_core"), false);
    }

    const wrongRequirement = exported.jsonl.replace("AI-REQ-20261105-001", "AI-REQ-OTHER");
    const rejected = parseSessionJsonl(wrongRequirement);
    assert.equal(rejected.ok, false);

    const lines = exported.jsonl.trim().split("\n");
    const header = lines[0] ?? "";
    const duplicate = parseSessionJsonl(`${exported.jsonl}${lines[1] ?? ""}\n`);
    assert.equal(duplicate.ok, false);

    const polluted = parseSessionJsonl(header.replace("{", '{"__proto__":{"polluted":true},'));
    assert.equal(polluted.ok, false);
    assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);

    const imported = parseSessionJsonl(
      `${header}\n${JSON.stringify({
        type: "message",
        schemaVersion: 1,
        id: "imported-provider",
        sessionId: session.id,
        providerId: "grok",
        role: "assistant",
        round: 1,
        phase: "independent",
        body: "这是一份未验证的导入记录",
        createdAt: session.createdAt,
        status: "complete",
        sourceKind: "provider",
        adapterMode: "none",
        provenance: [],
        errorCode: null,
        errorMessage: null,
        trust: "created_by_core",
      })}\n`,
    );
    assert.equal(imported.ok, true);
    if (imported.ok) {
      const message = imported.session.messages[0];
      assert.equal(message?.trust, "local_unverified_import");
      assert.equal(message ? outcomeHeadline(message) : "", "未验证导入");
    }

    const fake = parseSessionJsonl(
      `${header}\n${JSON.stringify({
        type: "message",
        schemaVersion: 1,
        id: "fake",
        sessionId: session.id,
        providerId: "chatgpt",
        role: "assistant",
        round: 1,
        phase: "independent",
        body: "我是真实的 ChatGPT",
        createdAt: session.createdAt,
        status: "complete",
        sourceKind: "mock",
        adapterMode: "mock",
        provenance: [],
        errorCode: null,
        errorMessage: null,
      })}\n`,
    );
    assert.equal(fake.ok, false);

    const oversized = parseSessionJsonl("x".repeat(MAX_IMPORT_CHARS + 1));
    assert.equal(oversized.ok, false);
  });
});
