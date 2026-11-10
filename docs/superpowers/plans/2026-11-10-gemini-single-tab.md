# Gemini Single-Tab Implementation Plan

> For agentic workers: execute one task at a time with a failing test before production changes. This plan implements approved Issue #10; it does not authorize merge or release.

**Goal:** In a user-selected, logged-in Gemini tab, record one first-round real reply or a distinct non-success result and export the resulting session locally.

**Architecture:** Reuse the existing `ProviderAdapter`, session, and export contracts. Add a Gemini-specific on-demand content script and evidence reader; route the popup and discussion page to exactly one live provider per connection. Do not generalize ChatGPT's page-specific evidence machinery or add a persistent browser service.

**Tech Stack:** MV3, TypeScript, esbuild, Node test runner. **Spec:** [Issue #10](https://github.com/JunYIChen12/multi-ai-shared-context-extension/issues/10) and technical review comment 6757979756.

## Global constraints

- Start from `codex/chatgpt-attribution-followup` at `de99930f637c412bb2dd4596d2753c8f78232f92`; PR #8 is separate.
- Manifest remains `activeTab` + `scripting`, with empty `host_permissions` and no declarative content scripts.
- Gemini only: one dedicated tab, first independent round, no other sender in that chat, no automatic retry, maximum six-minute outer wait. ChatGPT retains its 30-second limit.
- No Cookie, token, private API, CDP/Playwright product connector, Grok, concurrency, or second-round work.
- `npm ci` and `npm run check` must pass after code changes. One real browser success, one recognizable failure, and local Markdown/JSONL files are delivery evidence; offline tests alone are insufficient.

## Task 1: Provider routing and safe connection

**Files:** `src/extension/popup.ts`, `src/extension/discussion.ts`, `src/extension/provider-selection.ts`, `extension/popup.html`, `extension/discussion.html`, `test/provider-selection.test.ts`, `test/gemini-connector.test.ts`.

**Interface:** `isGeminiUrl(raw)`, `connectActiveGeminiTab(port)`, `readGeminiTabId(search)`, and `createGeminiAdapter(transport)` parallel the existing ChatGPT connection boundary without changing `ProviderAdapter`.

- [ ] Add failing tests: HTTPS `gemini.google.com` is accepted, other hosts are rejected; a Gemini connection selects only Gemini for live mode; MOCK remains all three; malformed tab IDs cannot connect.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement the smallest routing change: popup chooses site by exact hostname, injects only that site's local content script, and opens a provider-tagged discussion page. The connected discussion page disables other live providers; unconnected state remains unimplemented.
- [ ] Run focused tests and `npm run check`, then inspect the diff for scope and permission drift.

## Task 2: Gemini page evidence and one-turn state machine

**Files:** `src/extension/gemini-dom.ts`, `src/extension/gemini-turn.ts`, `test/gemini-dom.test.ts`, `test/gemini-turn.test.ts`.

**Interface:** a read-only page snapshot supplies route class, fresh user/pending/model turn relationships, exact reply body, completion flags, error/stop state, and ambiguity flags to `runGeminiTurn(port, prompt, signal)`. Page reads do not collect old transcript text.

- [ ] Write failing tests from the observed sequence: empty `/app` → one new `user-query` plus `pending-request/pending-response` → a rebuilt user node and one `model-response` in the same `.conversation-container` → nonempty body plus `.response-footer.complete` and `message-actions`, without `response-info-line` or `aria-busy=true`.
- [ ] Add failure tests for competing turns, route isolation, missing or conflicting completion evidence, page error, manual stop, timeout/cancel, and late reply after cancellation. Assert no retry and no successful body in any non-success state.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement the minimum page reader and state machine. Treat pending as waiting, not failure; allow normal node recreation, but fail closed if the completed container cannot be tied to the one new turn. Never infer completion from URL, text stability, or stop disappearance alone.
- [ ] Run focused tests and `npm run check`, then review the page-data boundary and diff.

## Task 3: Bundle, session, and export integration

**Files:** `src/extension/gemini-content.ts`, `src/extension/gemini-connector.ts`, `src/extension/discussion.ts`, `scripts/build.ts`, `extension/manifest.json`, `test/extension-flow.test.ts`, `test/manifest.test.ts`.

**Interface:** Gemini uses a distinct message channel with request ID and cancel; `createGeminiAdapter` maps success to `live/complete`, page failure to `failed`, outer expiry to `timeout`, and cancellation to `cancelled` through existing core types.

- [ ] Write failing integration tests for a Gemini result becoming `sourceKind=provider`, exact Markdown/JSONL body, no tab ID or credential leakage, cancellation ignoring late success, and a six-minute Gemini timeout that does not alter ChatGPT's 30 seconds.
- [ ] Run focused tests and confirm expected failures.
- [ ] Add the Gemini content-script build entry and required artifact; connect the discussion page to Gemini only when its tab ID is valid. Keep Grok unimplemented and MOCK clearly marked. Update manifest and visible copy only where the newly connected Gemini state requires it.
- [ ] Run `npm ci` and `npm run check`; inspect `git diff --check`, manifest, generated artifacts, and full diff for secrets or unrelated edits.

## Task 4: Real-browser acceptance and handoff

- [ ] In a fresh non-sensitive logged-in Gemini tab, reload the built unpacked extension and send one fixed prompt through the extension; compare page-visible reply and discussion record byte-for-byte. Stop on ambiguity or a changed permission requirement.
- [ ] Verify one recognizable failure without a second send, and export Markdown plus JSONL to actual local files; check requirement ID, provider, status, exact body, and absence of private content/credentials.
- [ ] Record what passed and what did not in #10. Open a PR from this branch to `codex/chatgpt-attribution-followup` with evidence and risks; leave PR and Issue open for independent technical and user acceptance. Do not merge or publish.
