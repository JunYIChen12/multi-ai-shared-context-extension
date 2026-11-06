# ChatGPT 单标签页连接设计

## 状态

已由用户在 Issue #2 复审批准开工；这不是功能验收或发布批准。

## 目标

在现有 Chrome MV3 扩展中，让用户通过一次明确的扩展点击，把当前 `https://chatgpt.com/` 标签页临时连接到讨论页。讨论页只向该标签页提交一条问题，区分完成与可识别失败，并复用现有 Markdown/JSONL 导出留下本地记录。

## 不做

- 不接入 Grok 或 Gemini。
- 不实现第二轮真实交叉讨论、后台常驻、自动重试或跨重载恢复。
- 不读取或导出 Cookie、令牌、浏览器存储、网络鉴权信息或既有私人会话正文。
- 不申请持久站点权限、`<all_urls>`、`tabs`、`cookies`、`storage`、`downloads`、`webRequest`、`debugger` 或 `nativeMessaging`。
- 不关闭 Issue #2，不合并或发布未经用户审核的结果。

## 权限与连接生命周期

Manifest 只增加 `activeTab` 和 `scripting`，`host_permissions` 与 `optional_host_permissions` 保持空数组。用户必须先激活 ChatGPT 标签页，再点击扩展图标。Popup 在这个用户手势内验证当前 URL、注入 `chatgpt-content.js`，然后打开带当前 tab ID 的内部讨论页。

连接只在该标签页当前文档生命周期内有效。标签页关闭、刷新或离开页面后，讨论页必须报告连接失效，并提示用户重新点击扩展；不得为了自动恢复扩大权限。

## 模块边界

### 协议和 live 适配器

`src/extension/chatgpt-connector.ts` 定义扩展消息协议、URL/tab ID 验证和 `ProviderAdapter`。适配器只依赖一个 `send(request)` 传输函数，因此完成、失败和断连映射可以在 Node 测试中验证，不需要伪造 Chrome DOM。

请求只允许：

```ts
{ channel: "multi-ai-chatgpt-v1", type: "ask", prompt: string }
```

响应是判别联合：

```ts
{ ok: true, body: string }
{ ok: false, code: ChatGptErrorCode, message: string }
```

### ChatGPT 页面执行器

`src/extension/chatgpt-turn.ts` 实现与 DOM 无关的单轮状态机。它通过 `ChatGptPagePort` 获取快照、写入问题和点击提交：

1. 拒绝已经生成中的页面。
2. 记录提交前 assistant 消息数量，但不读取旧消息正文。
3. 写入纯文本并点击提交。
4. 等待生成开始，然后等待新增 assistant、停止按钮消失、正文非空且短暂稳定。
5. 超时、元素缺失、空回复或超长回复都返回结构化失败，不伪装成功。

`src/extension/chatgpt-content.ts` 是薄浏览器边界：只实现 `ChatGptPagePort` 所需选择器、纯文本输入、按钮点击和 runtime message listener。所有模型正文都作为文本处理，不使用 `innerHTML` 或 `eval`。

### Popup 与讨论页

Popup 的按钮变成“连接当前 ChatGPT 标签页并打开讨论页”。非 `chatgpt.com` 页面只显示错误，不注入脚本。讨论页从自身 URL 读取 tab ID；存在有效连接时，第一轮为 ChatGPT 使用 live adapter，Grok/Gemini 继续使用未接入 adapter。没有有效 tab ID 时保持当前未接入行为。

### 持久化

复用现有 `exportSession()` 和浏览器原生下载链接。live 完成消息使用 `sourceKind: "provider"`、`adapterMode: "live"`，导入校验允许这个组合，但所有重新导入的数据仍降级为 `local_unverified_import`。

## 错误语义

至少区分：非 ChatGPT 页面、未连接/连接丢失、页面忙、输入框缺失、发送按钮缺失、生成未开始超时、完成超时、空回复、回复超长。错误记录使用 system 消息，不包含页面 HTML、选择器内容、凭据或旧会话正文。

## 安全边界

- 页面、模型回复和扩展消息均为不可信输入。
- prompt 在 core 已限制为 20,000 字符，内容脚本再次验证空值和上限。
- 只读取提交后新增的最后一条 assistant 文本。
- 消息 listener 拒绝错误 channel、type 或 payload。
- 不发起站点 API 请求，不读取 Cookie/localStorage/sessionStorage，不记录完整 DOM。
- 两次选择器修正仍不能可靠完成真实链路时停止，回到 Issue 重新评审，不扩大权限。

## 验收方法

开发完成后执行 Issue #2 的三类验收：

1. 新建无敏感信息 ChatGPT 会话，完成一次真实成功并保留原文、来源、时间、轮次和状态。
2. 验证至少一种安全失败（例如连接后刷新或未连接），确保不会产生完成记录。
3. 实际下载 Markdown 和 JSONL，在文件系统确认非空、需求编号和记录字段与页面一致。

另外运行 `npm ci && npm run check`，并确认权限清单未扩大。内部扩展页 DOM/控制台如果仍受工具策略限制，按事实保留为人工观察证据。
