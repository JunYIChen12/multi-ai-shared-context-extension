# 当前任务状态

## 目标

按 Issue #2 已批准范围，实现 ChatGPT 单标签页临时连接与本地 Markdown/JSONL 留痕。

## 基线

- 仓库：`JunYIChen12/multi-ai-shared-context-extension`
- 分支：`feature/chatgpt-single-tab`
- 起点：`7139779e91e1206948c898bbea220acd9dd50e0e`
- 环境：Windows，Google Chrome 156.0.8078.81，Node >=22
- 基线验证：类型检查通过，12/12 单元测试通过，扩展构建通过。

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
- [ ] Task 1：live 契约与权限策略。
- [ ] Task 2：消息适配器。
- [ ] Task 3：单轮状态机。
- [ ] Task 4：内容脚本边界。
- [ ] Task 5：popup/讨论页集成。
- [ ] Task 6：真实浏览器和文件验收。

## 停止条件

- 同一 DOM 路线连续两次修正仍不能可靠区分生成中与完成。
- 需要读取/导出登录态、绕过登录/验证码、重放私有 API 或扩大权限。
- 无法生成不含私人会话和凭据的验收证据。
