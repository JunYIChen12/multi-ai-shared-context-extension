> 已过时：本文件为历史快照，非现行状态，以 GitHub Issue 为准。

# 当前任务状态

## 目标

按 Issue #2 已批准范围，实现 ChatGPT 单标签页临时连接与本地 Markdown/JSONL 留痕；真实链路和文件验收通过后才算完成。

## 基线

- 仓库：`JunYIChen12/multi-ai-shared-context-extension`
- 分支：`feature/chatgpt-single-tab`
- 实现起点：`7139779e91e1206948c898bbea220acd9dd50e0e`
- 当前状态参考：`375cce437315f024ff47393565017785ed91a1e6`
- 环境：Windows，Google Chrome 156.0.8078.81，Node >=22
- 初始基线验证：类型检查通过，12/12 单元测试通过，扩展构建通过。
- 当前提交 `375cce4` 的 `npm run check`：类型检查、28/28 测试和扩展构建通过。
- 当前环境的 `npm ci` 因系统 npm 缺少 `./cache/policy.js` 失败；这是 npm 安装问题，与网页链路失败分开记录。

## 已批准边界

- 仅 ChatGPT 单标签页连接与本地留痕。
- 权限仅 `activeTab`、`scripting`，不申请站点权限。
- 不读取 Cookie、令牌、浏览器存储或既有私人会话。
- Grok、Gemini、第二轮真实讨论、持久站点权限、后台常驻均不在本轮。
- 技术路线真实验证失败时停止并重新评审，不扩大权限。

## 设计与计划

- 设计：`docs/superpowers/specs/2026-11-06-chatgpt-single-tab-design.md`
- 计划：`docs/superpowers/plans/2026-11-06-chatgpt-single-tab.md`

## 当前进度

- [x] 复审批准开工。
- [x] 主线基线验证。
- [x] Task 1：live 契约与权限策略。
- [x] Task 2：消息适配器。
- [x] Task 3：单轮状态机。
- [x] Task 4：内容脚本边界。
- [x] Task 5：popup/讨论页集成。
- [ ] Task 6：真实浏览器和文件验收。

### Task 6 当前结果：阻塞，未完成

观察事实：

- 在 Chrome 156.0.8078.81 中，固定的无敏感测试问题已真实发送；网页显示固定回复 `CHATGPT_LIVE_OK`，但扩展返回 `ChatGPT 未在限定时间内开始生成`，没有成功的 provider 记录。
- 只读取证中，`[data-message-author-role="assistant"]` 数量为 0；该回复的祖先链没有 `data-message-author-role`、`data-message-id`、`role="article"` 或稳定 `data-testid`，主要只有生成类名。
- 第一次真实失败是发送按钮状态竞态。修正后第二次仍未通过，扩展没有检测到生成开始。
- 尚未取得真实成功记录，也未完成本地 Markdown/JSONL 文件验收。

判断与决定：

- 上述两次 DOM 路线尝试仍是当时的网页记录。Task 6 继续未完成，Issue #2 保持开放。复审评论：[Issue #2 评论 6676176718](https://github.com/JunYIChen12/multi-ai-shared-context-extension/issues/2#issuecomment-6676176718)。
- 后续离线修复批次改的是归属和终态判定，不是第三次选择器猜测，也没有做真实网页或文件验收。证据契约见 `docs/chatgpt-evidence-contract.md`。读不到字段时保持未知，不扩大权限。

## 停止条件

- 同一 DOM 路线连续两次修正仍不能可靠区分生成中与完成。
- 需要读取/导出登录态、绕过登录/验证码、重放私有 API 或扩大权限。
- 无法生成不含私人会话和凭据的验收证据。

## 2026-11-06 交接分支离线续修（部分完成）

- 分支：`codex/chatgpt-attribution-followup`；起点：`0b55011ce4d9c0f0c0f35355554559f9498caa30`，不是旧 `4bc3475`。
- 正文提取改为克隆目标回复节点后清空副本按钮文本；离线回归覆盖正文中的 `Copy`、`复制`。
- 共享发送账本的未匹配请求在同一/未知会话会于写入前拒绝下一次发送；仅已知 `/c/A` 切到不同 `/c/B` 时恢复。草稿页发送后不能凭地址证明隔离，仍拒绝自动重发。
- 写入输入框到点击发送之间若会话切换或连续性无法证明，停止提交。
- `npm run check`：类型检查、50/50 离线测试、扩展构建通过。`npm ci` 仍因本机 npm 自身缺少 `make-fetch-happen/lib/cache/policy.js` 失败，不能写成安装成功。
- **未完成**：真实 DOM 的无错误/生成结束信号未验证；未获用户单独授权做网页用例。提交后仅有一个外来新 user/assistant 的离线反例仍会被当前结构规则误判成功（临时反例测试得到 `true !== false`）；现有 `submit(): boolean` 不提供因果归属。不能宣称一般归属或真实链路验收通过，不能合并、关闭 Issue 或发布。

## 2026-11-06 单次真实页面结构探针（仅取证，未验收）

- 基线：`codex/chatgpt-attribution-followup` @ `3eed69f2fae7da229381596b7596e1e65235e700`；用户另行允许一次新增发送。在新开的 `https://chatgpt.com/` 页直接通过浏览器界面发送一次无敏感固定探针 `这是扩展结构探针，请只回复：DOM_SIGNAL_OK`。本次没有通过扩展讨论页发送，不是扩展端到端验收。
- 发送前只读结构：根路径 `/`，输入框和发送按钮各 1；旧轮次选择器、Stop、`[role="alert"]` 均 0。发送点击返回 `/c/local-chatgpt%3A<redacted>`，之后观察到 `/c/<redacted>`；本次未测量精确过渡时长。
- 正式地址上连续三次结构采样（约 3 秒）均见旧 `[data-message-author-role]` 轮次 0；另有 2 个 `[data-chatgpt-search-unit-key]` 节点，其键后缀分别为 `:user`、`:assistant`，两者的 `[data-chatgpt-search-message-ids]` 值非空且不同；另一次间隔约 1 秒的比较中两值保持不变。`[data-turn-key]` 包裹节点 1 个，复制按钮 1 个；按钮不在 assistant 单元内部，而在同时包含 user/assistant 单元的包裹节点内。Stop 和 `[role="alert"]` 均 0。
- 没有读取或记录聊天正文、旧会话、完整会话 ID、Cookie、令牌；没有自动重发。上述属性只是本次页面观察，不是 ChatGPT 的稳定接口承诺，也不证明本次提交和新轮次的因果归属。
- 静态阻塞：当前 `readPageError()` 只会返回 `present` 或 `unreadable`，从不返回成功判定必需的 `ready/none`；`readComposerStop()` 在零命中时也返回 `unreadable`。因此现有真实 DOM 端口即使越过临时网址，也无法满足 `assessPoll()` 的成功条件。轮次读取器仍只认旧属性，对本次页面返回空轮次。
- 验证边界：`node --import tsx --test test/chatgpt-dom.test.ts` 为 6/6 通过；离线成功用例自行提供 `ready/none` 等模拟证据，不能证明真实 DOM 可产生这些状态。未改生产代码、权限或 Issue；真实完成信号、一般因果归属、Markdown/JSONL 落盘及 Task 6 继续未验收。下一步先评审证据读取契约和最小修正，不单独把“等待临时网址”当成功修复。

## 2026-11-09 扩展单次发送的网址连续性取证（失败，未验收）

- 基线：`codex/chatgpt-attribution-followup` @ `98f3c6469b211b5f65b32422e9ea68647b5dc650`；用户批准一次新的无敏感发送。在新开 `https://chatgpt.com/` 标签页经扩展讨论页只发送一次固定探针 `这是网址连续性探针。请只回复：URL_TIMING_OK`，没有重试。
- 临时只读探针约每 20 ms 采样一次，只记录地址类别、匿名轮次序号、可见发送/停止/复制控件和相对时间；未读取或输出完整会话地址、轮次 ID、旧聊天正文、Cookie 或令牌。发送点击为 t=46,854 ms；t=47,153 ms 仍是草稿地址且无新轮次；t=47,444 ms 首次观察到临时地址及 user#1；t=49,092 ms 为正式地址且仍是 user#1；t=50,672 ms 出现 assistant#2；t=51,011 ms 发送控件和复制控件可见、停止控件消失。正式地址上的 assistant 单元包含固定回复标记。20 ms 采样不能排除更短的未观察瞬态。
- 扩展实际返回 `未知：无法证明新聊天地址仍是本次发送`。静态代码显示临时地址分支只等待，不登记在临时地址首次出现的 user id；草稿到正式地址的连续性却要求曾在草稿地址登记该 id。用上述脱敏结构顺序直接调用当前 `assessPoll()`，得到临时态 `pending`、正式态 `unknown` 和同一错误文案。这是对本次失败的可复现代码级解释，不是一般因果归属证明。
- 前一轮真实验收同样由扩展发送且网页回复了固定标记，扩展仍记录 `unknown`；该轮 Markdown/JSONL 均实际落盘，JSONL 可解析且 provider 失败记录正文为空。当前这次仅做时序取证，没有再做文件导出。下一步应先评审“临时地址首次出现的唯一新用户轮次，且在正式地址保持同一 id”能否作为受限连续性证据，再决定最小代码修正；不得放宽为仅凭正式地址或回复文本归属。Issue 继续开放，不合并或发布。

## 2026-11-09 临时地址连续性离线修正（待真实复测）

- 基线：`codex/chatgpt-attribution-followup` @ `98f3c6469b211b5f65b32422e9ea68647b5dc650`，Windows、Node 24.16.0、npm 11.13.0；保留本文件原有未提交记录。
- 根据上一节的脱敏时序，新增回归：临时地址首次出现唯一新 user id，正式地址保留该 id，且唯一关联 assistant 满足自然结束时允许受限完成。测试先得到原错误 `无法证明新聊天地址仍是本次发送`，随后最小修改临时地址分支，登记该 id 和已经出现的 assistant id；身份变化、多个新轮次、token 冲突、证据缺失仍不得成功。另一个先失败的回归显示临时地址退回草稿页时会绕过正式地址确认，已改为未知。`docs/chatgpt-evidence-contract.md` 同步限定此前提和边界。
- `npm run check`：类型检查、66/66 离线测试、扩展构建通过；`git diff --check` 通过。`npm ci` 因当前 npm 自身缺少 `make-fetch-happen/lib/cache/policy.js` 失败，不能算安装验证通过。
- **未完成**：未重新加载 Chrome 扩展，未获本次新网页发送授权，未做真实成功及新文件落盘验收。现有专用标签页、期间无人或程序另行发送的使用前提不是页面能独立证明的事实；Issue #2/#4 继续开放，不合并、不发布。

## 2026-11-09 用户执行的单次扩展实测（正文准确性待核）

- 用户获准后通过扩展发送固定、无敏感验收句：`这是扩展验收测试。请只回复：CHATGPT_LIVE_OK`。用户贴出的讨论页结果为 `第 1 轮 · chatgpt · 页面结束`，正文为 `ChatGPT 说：ChatGPTCHATGPT_LIVE_OK`。本轮是否重载了最新本地构建，尚未由用户确认。
- 这证明讨论页本轮不再显示此前的网址连续性错误，并记录了一个“页面结束”状态；但正文比期望标记多出 `ChatGPT 说：ChatGPT`，尚未与 ChatGPT 网页可见原文逐字对照，不能确认是页面本身输出还是 DOM 正文提取混入界面文案。当前仅是用户贴出的观察，没有代理读取扩展内部页。
- 当前 `D:\安装包` 可见的最近一份需求编号 JSONL 仍是 14:21 的既有文件；本轮尚未取得新的 Markdown/JSONL 落盘证据。不可宣布 Task 6 或技术验收完成，不重发、不合并、不发布。

## 2026-11-09 新导出文件与正文污染复核

- 用户确认 ChatGPT 网页可见原文仅为 `CHATGPT_LIVE_OK`。本轮新导出文件 `D:\安装包\AI-REQ-20261105-001-8bb370b5-d922-40bf-87ca-264f03b369f7.md`（644 字节，15:39:20 CST）和同名 `.jsonl`（1104 字节，15:39:22 CST）均实际存在；两份都将 provider 正文记为 `ChatGPT 说：ChatGPTCHATGPT_LIVE_OK`，状态 `complete`，来源 `chatgpt`。项目的 `parseSessionJsonl()` 解析 JSONL 成功，含 2 条消息，需求编号正确。
- 对本轮无敏感 ChatGPT 测试会话做只读 DOM 检查：唯一包含固定标记的 assistant 单元的第一个直属子节点是 `H4.sr-only`，文本 `ChatGPT 说：ChatGPT`；第二个直属子节点是 `DIV`，文本仅 `CHATGPT_LIVE_OK`。现有 `readTurnBody()` 克隆整个 assistant 单元，仅清空按钮文本，然后取整体 `textContent`，因而把隐藏标题并入正文。文件导出忠实保存了错误采集值，不是导出层单独改写。
- 结论：页面结束识别及本地双格式落盘已有一次真实成功路径证据，但**原文准确性未达标，Task 6/技术验收仍失败**。未在本轮修改生产代码、重发问题、合并或发布。下一轮应将这个已复现反例写成回归测试，再最小修正正文提取并重新实测。

## 2026-11-09 用户接受本次受限结果

- 用户明确认为本次正文前缀偏差可以接受，要求将当前成果推送 GitHub 并整理 Issue。该决定适用于本次 ChatGPT 单标签页固定无敏感用例，不把网页原文与导出正文不一致改写为一致，也不证明通用并发归属。
- 目前已观察到一次扩展显示“页面结束”、ChatGPT 网页回复 `CHATGPT_LIVE_OK`、Markdown 和 JSONL 均落盘且 JSONL 可解析；导出正文仍多出 `ChatGPT 说：ChatGPT`，应作为已知缺陷跟踪。未重发真实网页用例。
- 架构师负责技术证据及推送复核；用户保留业务验收、合并与发布决定。推送分支不是合并或发布；#2 的其余验收项与 `npm ci` 环境阻塞必须继续如实记录。
- 本轮重新执行 `npm ci` 失败：npm 11.13.0 自身缺少 `make-fetch-happen/lib/cache/policy.js`；未重建本机 Node/npm 环境。随后 `npm run check` 通过（类型检查、66/66 离线测试、扩展构建），待推送差异的 `git diff --check` 通过。离线通过不能替代真实页面回归；本轮未再次发送网页问题。
