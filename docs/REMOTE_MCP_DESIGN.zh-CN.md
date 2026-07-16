# 远程 MCP 服务器（面向 Notion 自定义代理）——设计说明

> 本文解释这次改造「为什么这么做、改了什么、怎么验证」，面向从没接触过 MCP 的读者也能读懂。

## 背景

### 什么是 MCP，以及本项目原本长什么样

**MCP（Model Context Protocol）** 是一套让「大模型客户端」调用「外部工具」的开放协议。它区分两个角色：

- **MCP 服务器**：把一组能力包装成「工具（tools）」暴露出来。本项目就是一个 MCP 服务器，它把 ATimeLogger（一个时间追踪应用）的 REST API 封装成 8 个工具：`get_current_status`、`list_activity_types`、`start_activity`、`stop_activity`、`pause_resume_activity`、`log_interval`、`time_report`、`list_intervals`。
- **MCP 客户端**：由大模型驱动，去发现并调用这些工具（如 Claude Desktop、Claude Code，或本次的 **Notion 自定义代理**）。

协议内容与传输方式是解耦的。MCP 定义了两种主流**传输（transport）**：

> **划重点：传输方式决定了「客户端怎么找到服务器」。**
>
> - **stdio**：客户端在本机把服务器当子进程拉起来，通过标准输入/输出的管道收发 JSON-RPC。**只能本机用**。
> - **Streamable HTTP**：服务器监听一个 HTTP 端点（约定为 `/mcp`），客户端通过 HTTP POST 发 JSON-RPC、用 SSE 接收流式响应，并用 `mcp-session-id` 响应头维持会话。**可跨网络用**。

改造前，本项目**只有 stdio 入口**（`src/index.ts` 里 `new StdioServerTransport()`）。仓库里虽有一个 `src/http-server.ts`，但它并不是 MCP 传输——它是一个自定义 REST 代理：把 stdio 服务器 `spawn` 成子进程，再用 `POST /api/tools/:toolName` 这种非标准接口转发。任何标准 MCP 客户端（包括 Notion）都无法与它握手。

### Notion 自定义代理的约束

Notion 自定义代理跑在 Notion 云端，**没有你的本机**，自然无法用 stdio。它只能连接一个**公网 HTTPS 的 Streamable HTTP MCP 端点**。所以要接入 Notion，必须补齐「标准 Streamable HTTP 传输 + 一个公网地址」这两块。这正是本次改造要解决的问题。

## 直觉

核心想法一句话：**把「构建带工具的 MCP 服务器」与「用哪种传输把它接出去」彻底分开**，然后为 Streamable HTTP 提供一个标准实现和一键部署路径。

打个比方：原来只有一台「本机专线电话」（stdio）。现在我们没有改动电话机本身（那 8 个工具、模糊匹配、时区处理都原样复用），而是：

1. 把电话机做成一个可复用的「话机工厂」`buildServer()`；
2. 既能接到原来的「本机专线」（stdio，`index.ts`）；
3. 也能接到新装的「对外总机」（Streamable HTTP，`http-server.ts`）——总机对每一路来电（每个会话）都用工厂现造一台话机接上。

具体到一次 Notion 调用的数据流：

```
Notion 自定义代理
   │  HTTPS POST https://你的域名/mcp   (JSON-RPC: initialize / tools/call)
   ▼
Express (http-server.ts)
   │  校验 MCP_AUTH_TOKEN（可选口令）→ 按 mcp-session-id 找/建会话
   ▼
StreamableHTTPServerTransport  ←→  buildServer()（含 8 个工具）
   │  工具内部用 ATL_TOKEN 调 ATimeLogger REST API
   ▼
ATimeLogger 后端 (app.atimelogger.pro)
```

举个具体例子：用户对 Notion 代理说「我这周时间都花哪了」。代理选中 `time_report` 工具并 POST 到 `/mcp`；总机校验口令、定位会话，交给会话内的服务器实例；`time_report` 用服务器环境里的 `ATL_TOKEN` 请求 `/api/statistics`，把秒数聚合成 `"2h 15m"` 这样的人类可读时长返回。**用户的 ATimeLogger 令牌只存在服务器端**，Notion 侧只需要知道「地址 + 访问口令」。

## 代码

改动围绕「拆分职责 + 新增标准 HTTP 传输 + 部署产物 + 文档」四组。

### 1. 抽出共享的服务器工厂：`src/server.ts`（新增）

把原先写死在 `index.ts` 里的服务器名、版本、`instructions`（给大模型看的跨工具约定）和三处 `registerXxxTools` 收敛成一个纯函数：

```ts
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );
  registerTypeTools(server);
  registerActivityTools(server);
  registerReportTools(server);
  return server;
}
```

它**不关心传输**，因此 stdio 和 HTTP 两个入口都能复用，避免指令/工具注册出现两份实现漂移。

### 2. stdio 入口瘦身：`src/index.ts`

改为只负责「装配 stdio 传输」，并补上路线图里一直欠的 `#!/usr/bin/env node` shebang（`bin`/npx 分发的前提）：

```ts
#!/usr/bin/env node
loadConfig();                       // 缺 ATL_TOKEN 就带引导信息快速失败
const server = buildServer();
await server.connect(new StdioServerTransport());
```

### 3. 标准 Streamable HTTP 传输：`src/http-server.ts`（整体重写）

丢弃原来的 REST 代理，改用官方 SDK 的 `StreamableHTTPServerTransport`。要点：

- **`/mcp` 端点**处理 `POST`（JSON-RPC）、`GET`（打开 SSE 流）、`DELETE`（结束会话）。
- **有状态会话**：`initialize` 请求会新建一个 transport + 一台 `buildServer()` 实例并连上；后续请求靠 `mcp-session-id` 复用；`onclose` 时清理，避免内存泄漏。
- **可选访问口令**：设了 `MCP_AUTH_TOKEN` 时，`/mcp` 需要在 `Authorization: Bearer`、`x-mcp-token` 头或 `?token=` 查询参数里带上它——兼容不同客户端只能填 URL 的情况。
- **`/health` 健康检查**（免鉴权）供平台探活，`/` 给浏览器一个友好说明页。
- **CORS**：放通并暴露 `mcp-session-id` 头。
- **优雅关闭**：`SIGTERM/SIGINT` 时关掉所有会话再退出。

关键骨架：

```ts
app.post(MCP_PATH, requireAuth, async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport = sid ? transports[sid] : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) { /* 400：先 initialize */ return; }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport!; },
    });
    transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});
```

> **设计取舍：单租户。** 服务器以单一 `ATL_TOKEN` 身份运行，即「一个部署 = 一个 ATimeLogger 账号」。这符合「个人时间追踪」的场景，也避免了把每用户令牌透传进整个客户端/工具的大改造。代价是多人使用需各自部署实例。

### 4. 部署产物与配置

- **`Dockerfile`**：多阶段构建（编译 → 仅装生产依赖运行），带 `HEALTHCHECK` 打 `/health`。
- **`docker-compose.yml`**：VPS 上 `docker compose up -d --build` 直接起。
- **`render.yaml`**：Render 蓝图，`New → Blueprint` 一键部署即得 `https://<service>.onrender.com/mcp`。
- **`.env.example`**：`ATL_TOKEN` / `MCP_AUTH_TOKEN` / `ATL_BASE_URL` / `PORT` / `MCP_PATH` 说明。
- **`.dockerignore`**：避免把 `node_modules`、`.env` 带进镜像。
- `package.json` 的 `start` 指向 `dist/http-server.js`，`dev:http` 用 tsx 直跑源码（express 已在依赖里）。

### 5. 文档

- `README.md` 新增「Remote server」章节（环境变量表、取 URL 的三种方式、连 Notion 摘要）。
- `NOTION_MCP_GUIDE.zh-CN.md`：面向用户的中文三步接入指南。
- 本设计文档。

## 验证

**已在本环境完成：**

1. `npm install && npm run build` —— TypeScript 严格模式编译通过（`tsc` 退出码 0）。
2. 用 dummy 令牌启动 HTTP 服务器并做端到端联调：
   - `GET /health` → `{"status":"ok",...}`；
   - 不带口令 `POST /mcp` → **401**（鉴权生效）；
   - 用官方 **MCP SDK 客户端**（`StreamableHTTPClientTransport`）带口令连接 → `initialize` 握手成功、`instructions` 存在、`tools/list` 列出全部 **8 个工具**。

> `tools/list` 不触达 ATimeLogger 后端，因此在无真实后端的沙箱里即可证明「传输层正确、Notion 能握手并看到工具」。真正的工具**调用**才会用 `ATL_TOKEN` 打后端。

**建议你手动做的验收（QA）：**

1. 按 `NOTION_MCP_GUIDE.zh-CN.md` 部署（Render 最快），确认 `https://你的域名/health` 可访问。
2. 在 Notion 自定义代理 **工具和访问** 里添加该 `/mcp` URL + 你的 `MCP_AUTH_TOKEN`，确认能列出 8 个工具。
3. 让代理「列出我的活动类型」（读）→ 应返回你的类型树；再试「开始记录 Work」「这周时间都花哪了」（写/报表）。
4. 故意把 `MCP_AUTH_TOKEN` 填错，确认 Notion 连接被拒（401）。

> **Docker 构建**：本沙箱拉取 `node:20-alpine` 基础镜像被网络策略拦截（registry 返回 403），未能在此跑通 `docker build`。Dockerfile 本身为标准多阶段写法、语法已解析通过；请在你自己的机器/平台上构建验证。

## 替代方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **本次：Node + 标准 Streamable HTTP（单租户、可选口令）** | 复用全部现有工具代码；改动小；任何 Node 主机/容器可跑；标准传输，Notion 等客户端通用 | 需要自己部署拿 URL；单令牌=单账号；口令鉴权比 OAuth 弱 |
| Cloudflare Workers（`agents` / `McpAgent`） | 免运维、全球边缘、天然公网 HTTPS | 运行时非 Node，`fetch` 之外的差异需适配；与现有 SDK 用法偏离，改造更大 |
| 完整 OAuth 2.1（按 MCP 授权规范） | 多用户、可撤销、企业级安全 | 实现与运维复杂度高；对「个人单账号」属过度设计；后端还需签发 API 粒度令牌 |

> OAuth 与多租户是**正交**的增强方向：若将来要对外多人分发，可在本传输之上叠加，而不必推翻现在的结构。

## 建议与之交谈的人员

- **Sergei Z（zaplitny@gmail.com）** —— MCP 服务器核心的原作者：工具设计、`instructions`、类型模糊匹配、时区/周期处理、错误包装。任何涉及「工具语义」或「与 ATimeLogger 后端契约」的问题找他最靠谱。
- **Jim uu（uuavv@qq.com）** —— 最早引入 HTTP wrapper 与 express 依赖、关注云端部署方向；对「部署/接入 Notion」的目标和取舍最有上下文。

## 小测验

<details>
<summary>1. 为什么原来的 stdio 服务器无法直接被 Notion 自定义代理使用？</summary>

- **A. 因为它是 TypeScript 写的** —— 错。语言与传输无关。
- **B. 因为 stdio 需要客户端在本机把服务器拉起来做管道通信，而 Notion 代理在云端、没有你的本机** —— ✅ 正确。跨网络必须用 HTTP 传输。
- **C. 因为工具太少** —— 错。工具数量与能否连接无关。
- **D. 因为缺少 API Token** —— 错。令牌是鉴权问题，不是传输可达性问题。
</details>

<details>
<summary>2. 仓库里原有的 <code>http-server.ts</code>（改造前）为什么不能让 Notion 连上？</summary>

- **A. 它其实是个自定义 REST 代理（<code>/api/tools/:toolName</code>），不是 MCP 标准的 Streamable HTTP 传输** —— ✅ 正确，标准 MCP 客户端无法与之握手。
- **B. 它监听的端口不对** —— 错，端口不是根因。
- **C. 它只支持 GET** —— 错。
- **D. 它没有 CORS** —— 错，CORS 不是它无法作为 MCP 端点的根因。
</details>

<details>
<summary>3. <code>buildServer()</code> 被抽出来的主要目的是？</summary>

- **A. 提升运行时性能** —— 错，主要动机不是性能。
- **B. 让 stdio 与 HTTP 两个入口复用同一套工具与 instructions，避免两份实现漂移** —— ✅ 正确。
- **C. 为了能删掉 zod** —— 错。
- **D. 为了支持多语言** —— 错。
</details>

<details>
<summary>4. 在 Streamable HTTP 里，客户端如何在多次请求间维持同一个会话？</summary>

- **A. 靠 Cookie** —— 错。
- **B. 靠查询参数 <code>?session=</code>** —— 错。
- **C. 靠 <code>initialize</code> 时服务器签发、并在后续请求携带的 <code>mcp-session-id</code> 头** —— ✅ 正确。
- **D. 靠客户端 IP** —— 错，不可靠且非协议约定。
</details>

<details>
<summary>5. 关于 <code>MCP_AUTH_TOKEN</code> 与 <code>ATL_TOKEN</code>，下面哪句对？</summary>

- **A. 两者是同一个东西** —— 错。
- **B. <code>ATL_TOKEN</code> 是服务器访问 ATimeLogger 的身份（服务器端保存）；<code>MCP_AUTH_TOKEN</code> 是保护 <code>/mcp</code> 端点的访问口令（客户端/ Notion 携带）** —— ✅ 正确，职责不同。
- **C. <code>MCP_AUTH_TOKEN</code> 必填，否则服务器无法启动** —— 错，它可选（不设则端点开放，但不推荐）。
- **D. <code>ATL_TOKEN</code> 应该填进 Notion** —— 错，且不安全；Notion 只需要地址 + 访问口令。
</details>
