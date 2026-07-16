# 把 ATimeLogger MCP 接入 Notion 自定义代理

本指南带你把本项目部署成一个**远程 MCP 服务器**（网络地址），并在 Notion 自定义代理里连接它。全程分三步：拿到 ATimeLogger 令牌 → 部署拿到公网 URL → 在 Notion 里连接。

---

## 背景：为什么需要一个「网络地址」

Notion 自定义代理运行在 Notion 的云端，不能像 Claude Desktop 那样在你本机启动一个进程再用 stdio 管道通信。它只能通过 **HTTPS 网络地址** 连接远程 MCP 服务器（走 MCP 的 **Streamable HTTP** 传输）。

因此本项目在原有 stdio 模式之外，新增了一个 HTTP 入口 `dist/http-server.js`，它把同一套 8 个工具通过 `/mcp` 端点对外提供。你需要做的就是把它跑在一个有公网 HTTPS 的地方，然后把 `https://你的域名/mcp` 填进 Notion。

---

## 第 1 步：生成 ATimeLogger 个人访问令牌（PAT）

1. 打开 ATimeLogger 网页版 → **Settings（设置）→ API Tokens** → **Generate token**。
2. 令牌以 `atl_pat_` 开头，**只显示一次**，请立刻复制保存。
3. 随时可在同一页面吊销。

这个令牌代表「你这个账号」。远程服务器会以它的身份读写你的时间记录，所以**一个部署对应一个 ATimeLogger 账号**。

---

## 第 2 步：部署，拿到公网 URL

先给服务器准备两个密钥：

- `ATL_TOKEN`：上一步的 `atl_pat_...`。
- `MCP_AUTH_TOKEN`：**你自己随便设的一串长随机字符串**（例如 `openssl rand -hex 24` 的输出）。因为地址是公网可达的，用它当访问口令，防止别人调用你的时间记录。

任选一种方式部署：

### 方式 A：Render（最省事，免费档即可拿到 HTTPS URL）

1. 把本仓库推到你自己的 GitHub。
2. 登录 [Render](https://render.com) → **New → Blueprint** → 选择该仓库（仓库里已带 `render.yaml`）。
3. 按提示填入 `ATL_TOKEN` 和 `MCP_AUTH_TOKEN` 两个环境变量。
4. 部署完成后，服务地址形如 `https://atimelogger-mcp-xxxx.onrender.com`。
   - **要填给 Notion 的 MCP 端点是：** `https://atimelogger-mcp-xxxx.onrender.com/mcp`
5. 打开 `https://.../health` 应返回 `{"status":"ok",...}`，说明服务已就绪。

> 免费档实例会在闲置后休眠，首次调用可能有几秒冷启动，属正常现象。

### 方式 B：自己的 VPS（Docker）

```bash
cp .env.example .env      # 填入 ATL_TOKEN、MCP_AUTH_TOKEN
docker compose up -d --build
```

这样服务在 `:3000` 启动。再用 Caddy / Nginx / Cloudflare Tunnel 做 HTTPS 反代，把 `https://mcp.example.com/mcp` 对外暴露即可。最省心的是 **Cloudflare Tunnel**（无需公网 IP、自动 HTTPS）：

```bash
cloudflared tunnel --url http://localhost:3000
# 输出一个 https://xxxx.trycloudflare.com 地址，端点即 https://xxxx.trycloudflare.com/mcp
```

### 方式 C：任意 Node 20+ 主机

```bash
npm ci && npm run build
ATL_TOKEN=atl_pat_... MCP_AUTH_TOKEN=长随机串 npm start
```

---

## 第 3 步：在 Notion 自定义代理里连接

1. 打开该自定义代理的设置 → **工具和访问（Tools and access）**。
2. 添加一个 **MCP 服务器 / 自定义连接器**。
3. **服务器 URL** 填：`https://你的域名/mcp`（注意结尾的 `/mcp`）。
4. **鉴权 / 访问令牌**：填你设置的 `MCP_AUTH_TOKEN`（作为 Bearer Token）。
5. 保存并连接。连接成功后，代理应能看到 8 个工具：
   `get_current_status`、`list_activity_types`、`start_activity`、`stop_activity`、`pause_resume_activity`、`log_interval`、`time_report`、`list_intervals`。

> 具体字段名称以 Notion 当前界面为准（「服务器地址」「令牌」等）。如果 Notion 的表单不支持单独填 Bearer Token，可退而把令牌放进 URL：`https://你的域名/mcp?token=你的MCP_AUTH_TOKEN`——服务器同样接受。

连接后就能对代理说：

- 「我现在在追踪什么？」
- 「开始记录 Work / 停止计时」
- 「记录昨天晚上 9 点到 11 点读书两小时」
- 「这周时间都花哪了？按天拆开看看」

---

## 自测清单

| 检查 | 期望结果 |
|---|---|
| 浏览器打开 `https://你的域名/health` | 返回 `{"status":"ok",...}` |
| 不带令牌 POST `/mcp` | 返回 401（说明鉴权生效） |
| Notion 里添加连接器 | 能列出 8 个工具 |
| 让代理「列出我的活动类型」 | 返回你 ATimeLogger 里的类型树 |

---

## 常见问题

- **工具调用返回 401（鉴权失败）**：是 `ATL_TOKEN` 失效/被吊销。去网页版 Settings → API Tokens 重新生成，更新服务器环境变量后重启。
- **Notion 连不上 / 一直转圈**：确认 URL 结尾是 `/mcp`，且是 **HTTPS**；确认服务器 `/health` 可访问；确认 `MCP_AUTH_TOKEN` 与 Notion 里填的一致。
- **想换后端**：设置 `ATL_BASE_URL`（默认 `https://app.atimelogger.pro`），令牌要在同一后端生成。
- **安全**：务必设置 `MCP_AUTH_TOKEN` 并只走 HTTPS；不要把 `.env` 或令牌提交到仓库。
