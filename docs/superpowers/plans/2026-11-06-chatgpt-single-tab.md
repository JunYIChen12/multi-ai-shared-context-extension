# ChatGPT Single-Tab Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved ChatGPT single-tab temporary connector and preserve its result through the existing Markdown/JSONL export path.

**Architecture:** The popup uses `activeTab + scripting` to inject a content script into the current `chatgpt.com` tab and opens the discussion page with that tab ID. A tested transport adapter maps extension messages into the existing provider contract; a separate tested turn state machine drives the minimum DOM port and returns structured success or failure.

**Tech Stack:** Chrome Manifest V3, TypeScript 5.9, esbuild, Node 22 built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-06-chatgpt-single-tab-design.md`

## Global Constraints

- Only ChatGPT single-tab connection and local Markdown/JSONL records are in scope.
- Required permissions are exactly `activeTab` and `scripting`; both host-permission arrays stay empty.
- No new dependencies, background service worker, persistent storage, Cookie/token access, API replay, Grok/Gemini integration, or automatic retries.
- Every production behavior starts with a failing test and each slice returns the project to green.
- If real ChatGPT DOM control fails after two selector corrections, stop and return to Issue #2 instead of widening permissions.

---

### Task 1: Lock the live record and permission contracts

**Files:**
- Modify: `test/manifest.test.ts`
- Modify: `test/orchestrate.test.ts`
- Modify: `test/persist.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/orchestrate.ts`
- Modify: `src/core/persist.ts`
- Modify: `src/core/manifest-policy.ts`
- Modify: `extension/manifest.json`

**Interfaces:**
- Produces: `AdapterMode = "mock" | "unimplemented" | "live"`.
- Produces: a live complete response becomes `sourceKind: "provider"`, while live failures remain system records.
- Produces: manifest policy accepts only `permissions: ["activeTab", "scripting"]` and empty host arrays.

- [ ] Write failing manifest tests that accept exactly `activeTab` and `scripting`, reject missing/extra named permissions, and reject every non-empty host permission.
- [ ] Run `node --import tsx --test test/manifest.test.ts`; verify the approved manifest fails under the old empty-only policy.
- [ ] Write failing orchestration/persistence tests for a `mode: "live"` complete response and JSONL round trip.
- [ ] Run the focused tests; verify TypeScript or assertions fail because `live` is not yet supported.
- [ ] Add the minimal `live` union member, response mapping, import enum and consistency rules; update manifest and policy without changing any other permission.
- [ ] Run the three focused test files and typecheck; verify green.
- [ ] Commit as `feat: define live adapter and least-privilege manifest`.

### Task 2: Define and test the extension message adapter

**Files:**
- Create: `src/extension/chatgpt-connector.ts`
- Create: `test/chatgpt-connector.test.ts`

**Interfaces:**
- Produces: `ChatGptAskRequest`, `ChatGptAskResult`, `ChatGptErrorCode`, `ChatGptTransport`.
- Produces: `createChatGptAdapter(transport: ChatGptTransport): ProviderAdapter`.
- Produces: `isChatGptUrl(url: string | undefined): boolean`, `discussionPath(tabId: number): string`, and `readChatGptTabId(search: string): number | null`.

- [ ] Write failing tests showing valid URL/tab parsing, a successful transport response becoming a live provider response, structured failure preservation, and a rejected transport becoming `connection_lost`.
- [ ] Run only `test/chatgpt-connector.test.ts`; verify failure because the module is absent.
- [ ] Implement the smallest protocol, validation helpers and adapter required by those tests; do not import Chrome globals.
- [ ] Run the focused test and typecheck; verify green.
- [ ] Commit as `feat: add ChatGPT connector message contract`.

### Task 3: Implement the bounded single-turn state machine

**Files:**
- Create: `src/extension/chatgpt-turn.ts`
- Create: `test/chatgpt-turn.test.ts`

**Interfaces:**
- Consumes: `ChatGptAskResult` from Task 2.
- Produces: `ChatGptSnapshot { assistantCount, isGenerating, latestAssistantText }`.
- Produces: `ChatGptPagePort { snapshot(), writePrompt(), submit() }`.
- Produces: `runChatGptTurn(page, prompt, timing): Promise<ChatGptAskResult>`.

- [ ] Write failing tests for success after a new stable assistant reply, busy-page rejection, missing input/send controls, start timeout, completion timeout, empty reply and reply length overflow.
- [ ] Run the focused test; verify failure because the state machine is absent.
- [ ] Implement validation, bounded polling and stability checks with injected `wait(ms)` and literal timing limits; never read old assistant text before submission.
- [ ] Run the focused test and typecheck; verify green.
- [ ] Commit as `feat: add bounded ChatGPT turn state machine`.

### Task 4: Add the content-script browser boundary and build artifact

**Files:**
- Create: `src/extension/chatgpt-content.ts`
- Modify: `scripts/build.ts`
- Modify: `test/manifest.test.ts`

**Interfaces:**
- Consumes: Task 2 message protocol and Task 3 `ChatGptPagePort`.
- Produces: idempotent runtime message listener in `chatgpt-content.js`.
- DOM selectors: `#prompt-textarea`, `[data-testid="send-button"]`, `[data-testid="stop-button"]`, and `[data-message-author-role="assistant"]`.

- [ ] Add a failing build/manifest test requiring `chatgpt-content.js` in the built artifact while keeping declarative `content_scripts` absent.
- [ ] Run the focused test/build and verify the missing artifact failure.
- [ ] Implement a thin DOM port that writes plain text, dispatches input, clicks only the send button, reads only the newest assistant node after the baseline, and registers one listener per page.
- [ ] Add the entry point and required artifact to `scripts/build.ts`.
- [ ] Run focused tests, typecheck and build; verify green and no remote resources.
- [ ] Commit as `feat: add ChatGPT page content bridge`.

### Task 5: Connect popup and discussion page

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/discussion.html`
- Modify: `extension/discussion.css`
- Modify: `src/extension/popup.ts`
- Modify: `src/extension/discussion.ts`
- Create: `test/extension-flow.test.ts`

**Interfaces:**
- Consumes: Task 2 URL helpers and live adapter.
- Produces in `chatgpt-connector.ts`: `connectActiveChatGptTab(port: ChatGptConnectionPort)`; the injected port supplies active-tab lookup, script injection and discussion-page opening.
- Popup flow: query active tab, reject non-ChatGPT URL, inject `chatgpt-content.js`, open `discussion.html?chatgptTab=<positive integer>`.
- Discussion flow: valid tab ID selects live ChatGPT adapter; Grok/Gemini remain unimplemented; absent/invalid ID preserves the current unimplemented behavior.

- [ ] Extend `test/chatgpt-connector.test.ts` with failing popup decision tests using an injected connection port, asserting returned success/error results rather than mock call existence.
- [ ] Run the focused test and verify the missing flow failure.
- [ ] Implement the minimal injected flow helpers, then wire the thin popup/discussion DOM handlers.
- [ ] Update copy to distinguish “已临时连接 ChatGPT” from “未连接”; do not expose tab IDs in transcript or exported model text.
- [ ] Run focused tests, typecheck, full unit suite and build; verify green.
- [ ] Commit as `feat: connect one ChatGPT tab to discussion records`.

### Task 6: Real browser acceptance and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/next-steps.md`
- Modify: `TASK_STATE.md`

**Interfaces:**
- Consumes: built `dist/extension` and Issue #2 acceptance method.
- Produces: reviewable evidence for one success, one safe failure and two real local files; does not close Issue #2.

- [ ] Run `npm ci && npm run check` with the repository-supported runtime; if system npm remains broken, record the exact limitation and run the equivalent typecheck/test/build commands with the bundled Node runtime.
- [ ] Reload the unpacked extension in Chrome and record version, commit and manifest permissions.
- [ ] In a new non-sensitive ChatGPT chat, perform the fixed success probe and verify complete state in the extension.
- [ ] Trigger one safe failure by refreshing or disconnecting the ChatGPT tab; verify no complete provider record is produced.
- [ ] Download Markdown and JSONL, verify both files exist, are non-empty, include `AI-REQ-20261105-001`, and agree on prompt/response/source/time/status without exposing credentials or private conversations.
- [ ] Update README/next steps/task state with exact observed evidence and remaining unverified items.
- [ ] Inspect the final diff and secret scan; commit as `docs: record ChatGPT single-tab acceptance evidence`.
