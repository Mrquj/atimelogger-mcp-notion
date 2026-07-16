# 部署与配置详解（拿到网址 → 接入 Notion）

本教程手把手带你把这个 MCP 服务器部署到公网，拿到一个 `https://…/mcp` 地址，并连接到 Notion 自定义代理。三种部署方式任选其一：

- **方式一：Render 一键部署**（最省事，免费档即可，推荐先用它跑通）
- **方式二：Railway**（一键，额度用完需付费）
- **方式三：自有 VPS + Docker + Cloudflare Tunnel**（国内访问最稳、长期自控）

> 无论哪种方式，最终要填进 Notion 的地址都是 **`https://<你的域名>/mcp`**（注意结尾 `/mcp`）。

---

## 0. 先准备两样东西

### 0.1 `ATL_TOKEN`（ATimeLogger 个人访问令牌）
ATimeLogger 网页版 → **Settings → API Tokens → Generate token**。令牌以 `atl_pat_` 开头，**只显示一次**，立刻复制。它代表你的账号，服务器以它的身份读写你的时间记录。

### 0.2 `MCP_AUTH_TOKEN`（你自定义的访问口令）
因为地址是公网可达的，用一个随机口令挡住陌生人。随便生成一串长随机字符串，例如：

```bash
openssl rand -hex 24
# 或者
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

把这两个值记好，后面每种部署方式都要用到。

---

## 方式一：Render 一键部署

Render 免费档就能给你一个 `https://xxx.onrender.com` 的 HTTPS 地址，且本仓库自带 `render.yaml` 蓝图，全程点点点即可。

1. **把本仓库推到你自己的 GitHub**（若还没推，见文末「附录 A」）。
2. 打开 <https://dashboard.render.com> 注册/登录，用 GitHub 授权。
3. 点 **New +** → **Blueprint**。
4. 选中你的 `atimelogger-mcp` 仓库 → **Connect**。Render 会自动读取 `render.yaml`，识别出一个名为 `atimelogger-mcp` 的 Docker Web 服务。
5. 在弹出的环境变量表单里填：
   - `ATL_TOKEN` = 你的 `atl_pat_...`
   - `MCP_AUTH_TOKEN` = 你在 0.2 生成的随机串
   （`render.yaml` 已把这两个标为 `sync: false`，所以只会在这里让你手填，不会写进仓库。）
6. 点 **Apply / Create** 开始构建（首次构建 Docker 镜像约几分钟）。
7. 构建完成后，页面顶部会显示服务地址，形如 `https://atimelogger-mcp-xxxx.onrender.com`。
   - 浏览器打开 `https://atimelogger-mcp-xxxx.onrender.com/health`，看到 `{"status":"ok",...}` 即成功。
   - **要填给 Notion 的是：** `https://atimelogger-mcp-xxxx.onrender.com/mcp`

> ⚠️ 免费档实例闲置约 15 分钟后会休眠，下次调用有几秒冷启动，属正常。介意的话升级到 Render 付费档，或改用方式三。

想用「Deploy to Render」按钮的话，把 README 里按钮链接中的 `YOUR_GITHUB_USERNAME` 换成你的用户名即可。

---

## 方式二：Railway

1. 把仓库推到 GitHub。
2. 打开 <https://railway.app> → **New Project** → **Deploy from GitHub repo** → 选择仓库。
3. Railway 会自动识别本仓库根目录的 `Dockerfile` 并构建。
4. 在 **Variables** 里加：`ATL_TOKEN`、`MCP_AUTH_TOKEN`（`PORT` 由 Railway 注入，无需手填）。
5. 在 **Settings → Networking → Generate Domain** 生成公网域名，形如 `https://xxx.up.railway.app`。
6. 端点即 `https://xxx.up.railway.app/mcp`，`/health` 自检同上。

---

## 方式三：自有 VPS + Docker + Cloudflare Tunnel

适合长期自控、国内访问更稳。前提：一台能装 Docker 的 VPS。

### 3.1 起服务
```bash
git clone https://github.com/<你的用户名>/atimelogger-mcp.git
cd atimelogger-mcp
cp .env.example .env
# 编辑 .env，填入 ATL_TOKEN 和 MCP_AUTH_TOKEN
docker compose up -d --build
curl localhost:3000/health          # → {"status":"ok",...}
```

此时服务在本机 `:3000`，还没有公网 HTTPS。用 Cloudflare Tunnel 暴露（免公网 IP、自动 HTTPS）：

### 3.2 用 Cloudflare Tunnel 暴露
临时快速验证：
```bash
cloudflared tunnel --url http://localhost:3000
# 输出一个 https://xxxx.trycloudflare.com，端点即 https://xxxx.trycloudflare.com/mcp
```

长期稳定（绑自己的域名）：
```bash
cloudflared tunnel login
cloudflared tunnel create atimelogger-mcp
cloudflared tunnel route dns atimelogger-mcp mcp.你的域名.com
# 配置 ingress 指向 http://localhost:3000，然后：
cloudflared tunnel run atimelogger-mcp
# 端点：https://mcp.你的域名.com/mcp
```

也可以用 Caddy/Nginx 反代 + Let's Encrypt，把 `:3000` 挂到 `https://mcp.你的域名.com`。

---

## 配置项速查（环境变量）

| 变量 | 必填 | 说明 |
|---|---|---|
| `ATL_TOKEN` | 是 | ATimeLogger 个人访问令牌（`atl_pat_...`），服务器以它的身份操作 |
| `MCP_AUTH_TOKEN` | 强烈建议 | 保护 `/mcp` 的访问口令；客户端用 `Authorization: Bearer …`、`x-mcp-token` 头或 `?token=` 携带。不设则端点开放 |
| `ATL_BASE_URL` | 否 | 非生产后端地址，默认 `https://app.atimelogger.pro` |
| `PORT` | 否 | 监听端口，默认 `3000`（多数平台会自动注入） |
| `MCP_PATH` | 否 | 端点路径，默认 `/mcp` |

---

## 部署后自测

| 检查 | 命令 / 操作 | 期望 |
|---|---|---|
| 健康检查 | 浏览器打开 `https://你的域名/health` | `{"status":"ok",...}` |
| 鉴权生效 | `curl -X POST https://你的域名/mcp -H 'content-type: application/json' -d '{}'` | HTTP 401 |
| 工具可见 | 在 Notion 添加连接器后 | 列出 8 个工具 |

---

## 接入 Notion 自定义代理

1. 打开你的 Notion 自定义代理设置 → **工具和访问（Tools and access）**。
2. 添加一个 **MCP 服务器 / 自定义连接器**。
3. **服务器 URL** 填 `https://你的域名/mcp`。
4. **访问令牌 / Bearer Token** 填你的 `MCP_AUTH_TOKEN`。
   - 若 Notion 表单不支持单独填 Token，可把它放进 URL：`https://你的域名/mcp?token=你的MCP_AUTH_TOKEN`，服务器同样接受。
5. 保存并连接，应能看到 8 个工具：`get_current_status`、`list_activity_types`、`start_activity`、`stop_activity`、`pause_resume_activity`、`log_interval`、`time_report`、`list_intervals`。

连接后可以对代理说：「我现在在追踪什么？」「开始记录 Work」「记录昨晚 9 点到 11 点读书」「这周时间都花哪了？」

---

## 常见问题

- **工具调用返回 401**：`ATL_TOKEN` 失效/被吊销 → 网页版重新生成，更新环境变量后重启服务。
- **Notion 连不上**：确认 URL 结尾是 `/mcp`、是 HTTPS、`/health` 可访问、`MCP_AUTH_TOKEN` 两边一致。
- **Render 首次调用很慢**：免费档冷启动，属正常；升级付费档或用方式三可避免。
- **换后端**：设置 `ATL_BASE_URL`，令牌需在同一后端生成。
- **安全**：务必设 `MCP_AUTH_TOKEN`、只走 HTTPS；不要把 `.env` 或真实令牌提交进仓库。

---

## 附录 A：把本项目推到你自己的 GitHub

```bash
# 在本项目根目录（已是一个 git 仓库）
gh repo create atimelogger-mcp --public --source=. --remote=origin --push
# 没装 gh 的话：先在 github.com 手动建空仓库 atimelogger-mcp，再：
git remote add origin https://github.com/<你的用户名>/atimelogger-mcp.git
git push -u origin main
```
