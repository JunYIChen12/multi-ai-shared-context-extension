# 三家统一框架最小补齐 Implementation Plan

> **For agentic workers:** 按本仓库 `AGENTS.md`，代码由一个执行者顺序修改并自测；不得把同一文件或互相依赖的步骤并行派给子代理。以下复选框用于跟踪。

**Goal:** ChatGPT 临时连接后 Grok/Gemini 不能参与正式发送，MOCK 按钮仍独立演示三家，保留所有已有状态与导出行为。

**Architecture:** 复用 `ProviderAdapter` 和既有编排器，只在讨论页选择边界增加一个纯函数，并在现有连接状态函数中禁用两家复选框。纯函数可离线断言；浏览器内确认实际禁用状态。没有新的网页连接器。

**Tech Stack:** TypeScript、Chrome Manifest V3、Node.js >=22、`node:test`/`assert`、现有 esbuild 构建。

**Spec:** `docs/superpowers/specs/2026-11-09-three-provider-framework-design.md`

## Global Constraints

- 基线：`codex/chatgpt-attribution-followup` @ `35cfcb668b535ccf2b9e485d0b12b1f17e50aec1`；本工作分支为 `codex/three-provider-framework`。
- 权限仍只有 `activeTab`、`scripting`；`host_permissions` 为空。不读 Cookie、令牌、私人会话。
- Grok/Gemini 继续“未接入”，不向网页发送；不新增连接管理层、依赖或真实第二轮。
- 保留当前未连接状态的“记录未接入尝试”、现有 ChatGPT 连接器、`[MOCK]` 标识、Markdown/JSONL 数据契约。
- 技术验收不能替代 #2 的 ChatGPT 真实链路验收或 #5 的正文准确性修复；不得据此合并或发布。

## 文件边界

- 新建 `src/extension/provider-selection.ts`：仅放讨论页三种模式的来源选择纯函数，不管理连接生命周期。
- 修改 `src/extension/discussion.ts`：调用该函数；在现有 `showConnectionState()` 中禁用 Grok/Gemini 复选框。
- 新建 `test/provider-selection.test.ts`：断言正式、未接入记录和 MOCK 的选择差异。
- 不改 `extension/discussion.html`、`src/core`、ChatGPT 页面脚本、`extension/manifest.json`、导出器或依赖清单。

---

### Task 1: 收紧讨论页来源选择

**Files:**
- Create: `src/extension/provider-selection.ts`
- Modify: `src/extension/discussion.ts`
- Test: `test/provider-selection.test.ts`

**Interfaces:**
- Consumes: `ProviderId` 和 `PROVIDER_IDS`，均来自 `src/core/types.ts`。
- Produces: `providerIdsForMode(mode: "mock" | "unimplemented" | "live", checked: readonly ProviderId[]): ProviderId[]`。MOCK 返回三家；live 只保留用户勾选的 ChatGPT；unimplemented 保持原勾选集。

- [ ] **Step 1: 先写失败断言**

在 `test/provider-selection.test.ts` 写入：

```ts
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
```

- [ ] **Step 2: 运行新测试，确认因模块尚不存在而失败**

运行 `node --import tsx --test test/provider-selection.test.ts`。预期失败为无法解析 `provider-selection.js`，不是已有测试偶发失败。

- [ ] **Step 3: 最小实现选择函数**

在 `src/extension/provider-selection.ts` 写入：

```ts
import { PROVIDER_IDS, type ProviderId } from "../core/types.js";

export function providerIdsForMode(
  mode: "mock" | "unimplemented" | "live",
  checked: readonly ProviderId[],
): ProviderId[] {
  if (mode === "mock") return [...PROVIDER_IDS];
  if (mode === "live") return checked.includes("chatgpt") ? ["chatgpt"] : [];
  return [...checked];
}
```

在 `src/extension/discussion.ts` 导入 `providerIdsForMode`，将 `selectedAdapters()` 中的 `selectedProviderIds().map(...)` 改为 `providerIdsForMode(mode, selectedProviderIds()).map(...)`。保持 `runSecondRound()` 的现有选择来源与其他分支不变。

- [ ] **Step 4: 禁用已连接页面的两家复选框**

在 `showConnectionState()` 已有 Grok/Gemini 循环里，将 `if (checkbox) checkbox.checked = false;` 改为：

```ts
if (checkbox) {
  checkbox.checked = false;
  checkbox.disabled = true;
}
```

不更改未连接页面的复选框、不更改 HTML 文案或第二轮现有禁用逻辑。

- [ ] **Step 5: 跑直接回归与项目检查**

先运行 `node --import tsx --test test/provider-selection.test.ts`，预期 2/2 通过。再运行 `npm ci` 与 `npm run check`；`npm run check` 必须分别通过类型检查、全部有断言测试和构建。若 `npm ci` 再次因本机 npm 自身缺文件而失败，单独记录环境阻塞，不写成依赖安装成功，也不以 `npm run check` 代替它。

- [ ] **Step 6: 浏览器内检查可见行为，不进行真实网页发送**

重新加载本分支构建的 `dist/extension`。未连接时确认三家仍可见且“记录未接入尝试”可记录未接入；从用户已登录的 ChatGPT 标签页主动连接后，确认 Grok/Gemini 未勾选且不可再勾选，ChatGPT 仍可勾选/取消，真实第二轮仍禁用。点击 MOCK（使用无敏感问题）时确认三家都有 `[MOCK]` 记录，且没有向 Grok/Gemini 网页发送。若浏览器/登录环境不可用，明确标为“浏览器检查未执行”，不以离线测试充当通过。

- [ ] **Step 7: 审查和提交**

运行 `git diff --check`，检查差异只含上述三个文件且无凭据、私人会话和构建产物。提交前记录测试结果和未执行项；随后提交本任务，不合并、不关闭 #2/#5/#6、不发布。架构评审再独立复核差异与验收证据。
