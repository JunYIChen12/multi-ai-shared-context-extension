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
