# 给后续开发代理

这个仓库还没有接入 ChatGPT、Grok 或 Gemini。默认结果是未接入。`[MOCK]` 只是测试和演示数据，不能写成真实回复或已有共享上下文。

Codex 额度不是 ChatGPT 网页版额度。不要导出 Cookie、令牌或私钥，不要申请全站权限，不要连接 MCP、Tailscale 或常驻任务。

改完代码后运行：

```bash
npm ci
npm run check
```

`npm run check` 包含类型检查、有断言的单元测试和扩展构建。三者都要通过。

真实网页探针的顺序、验收和停止条件写在 `docs/next-steps.md`。先做单家已登录链路，不要跳过它同时实现三家。
