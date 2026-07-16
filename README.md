# ATimeLogger MCP Server

A standalone MCP (Model Context Protocol) server that exposes the ATimeLogger REST API to Claude Desktop / Claude Code over stdio. Scope: activities (start/stop/pause/log), reports/history, and activity types.

## Setup

Requires Node 20+.

1. Generate a **Personal Access Token** in the ATimeLogger web app: **Settings → API Tokens → Generate token**. The value (starting with `atl_pat_`) is shown **only once** — copy it right away. You can revoke the token from the same page at any time.

2. Build the server and register it:

```bash
npm install
npm run build
npm run setup        # paste the token, verifies it, prints the registration command
```

The setup script prints ready-to-use registration snippets for both clients:

**Claude Code** — a one-liner:

```bash
claude mcp add atimelogger \
  -e ATL_TOKEN=atl_pat_... \
  -- node /absolute/path/to/atimelogger-mcp/dist/index.js
```

**Claude Desktop** — a JSON block to merge into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "atimelogger": {
      "command": "node",
      "args": ["/absolute/path/to/atimelogger-mcp/dist/index.js"],
      "env": {
        "ATL_TOKEN": "atl_pat_..."
      }
    }
  }
}
```

The server targets production (`https://app.atimelogger.pro`) by default — no URL configuration needed. To work against a different backend, set `ATL_BASE_URL` explicitly: pass `--url <base-url>` to the setup script (or set the env var), and it will include `ATL_BASE_URL` in the printed snippets. Generate the token in the web UI of the **same** server you point the MCP at.

Troubleshooting: a 401 from any tool means the token is invalid, expired, or was revoked — generate a new one in **Settings → API Tokens** and update `ATL_TOKEN` in the MCP config.

## Remote server (for Notion custom agents & other remote-MCP clients)

The same tools can be served over the network via the **Streamable HTTP** MCP transport, so a hosted client such as a **Notion custom agent** can connect by URL instead of spawning a local process.

```bash
npm install
npm run build
ATL_TOKEN=atl_pat_... MCP_AUTH_TOKEN=some-long-secret npm start
# → Streamable HTTP MCP endpoint on http://0.0.0.0:3000/mcp   (health: /health)
```

Environment variables (see `.env.example`):

| Var | Required | Purpose |
|---|---|---|
| `ATL_TOKEN` | yes | ATimeLogger Personal Access Token the server acts as |
| `MCP_AUTH_TOKEN` | recommended | shared secret required to call `/mcp` (sent as `Authorization: Bearer …`, `x-mcp-token`, or `?token=`). If unset, the endpoint is open |
| `ATL_BASE_URL` | no | non-production backend (defaults to `https://app.atimelogger.pro`) |
| `PORT` | no | listen port (default `3000`; most hosts inject it) |
| `MCP_PATH` | no | endpoint path (default `/mcp`) |

> One deployment = one ATimeLogger account (the server acts as the single `ATL_TOKEN`). Because the URL is internet-facing, set `MCP_AUTH_TOKEN` and serve it over HTTPS.

### Getting a public URL

**One-click (Render)** — after this repo is on your GitHub, click the button (or replace the URL with your fork):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_GITHUB_USERNAME/atimelogger-mcp)

Render reads the bundled `render.yaml`, then prompts you for the two secrets `ATL_TOKEN` and `MCP_AUTH_TOKEN`. When it finishes, your endpoint is `https://<service>.onrender.com/mcp`.

Other options:

- **Docker / VPS** — `docker compose up -d --build` (fill `.env` first), then put HTTPS in front (Caddy/Nginx/Cloudflare Tunnel).
- Any Node 20+ host works: `npm ci && npm run build && npm start`.

Detailed, step-by-step deploy + config (Chinese): [`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md).

### Connect it to Notion

Open your Notion **custom agent → Tools and access → add an MCP server**, paste the `…/mcp` URL, and provide the `MCP_AUTH_TOKEN` as the bearer/access token. Full step-by-step (Chinese): [`NOTION_MCP_GUIDE.zh-CN.md`](./NOTION_MCP_GUIDE.zh-CN.md). Design/rationale: [`docs/REMOTE_MCP_DESIGN.zh-CN.md`](./docs/REMOTE_MCP_DESIGN.zh-CN.md).

## Tools

| Tool | Purpose |
|---|---|
| `get_current_status` | Running/paused activities with elapsed time |
| `list_activity_types` | Activity type names as a group tree (source of names for other tools) |
| `start_activity` | Start by type name; optional backdating (`at` wall-clock time or `started_minutes_ago`) |
| `stop_activity` | Stop the active activity (name optional if only one is active); same backdating options |
| `pause_resume_activity` | Pause or resume |
| `log_interval` | Retroactively log a completed entry (wall-clock times, optional comment/tags) |
| `time_report` | Aggregated per-type statistics for a period (`today`, `this_week`, `last_month`, … or explicit dates) |
| `list_intervals` | Raw history grouped by day, paged, max 100-day range |

Tools accept human-readable type names (fuzzy matched); internal ids also flow through tool outputs and parameters for exact targeting, but are never shown to the user. Durations are returned as `"2h 15m"` strings; times are shown in the user's ATimeLogger timezone unless a `timezone` parameter is given.

## Usage examples

Things you can say to your assistant once the server is registered:

**Timers**

> "Start tracking work" · "Stop the timer" · "Pause reading, I'll be back in 10" · "What am I tracking right now?"

**Backdating** — forgot to press start or stop:

> "Start Development — I actually began at 11:30" · "Stop work, I finished 20 minutes ago" · "I've been in a meeting since 14:00, track it"

**Logging past activities**

> "Log 2 hours of Reading yesterday from 9 to 11pm" · "Add a gym session for last Saturday morning, 90 minutes, tag it 'legs'" · "I slept from 23:30 to 7:15, log it"

**Reports & history**

> "Where did my week go?" · "How much did I work in June, broken down by week?" · "Compare my sleep this month vs last month" · "Show everything I tracked today" · "Which day last week had the most Development time?"

**Combinations** — the assistant chains tools on its own:

> "Stop whatever is running and start Work" · "Continue from where the last entry ended — start Development from that time" · "Fill yesterday's gap between lunch and the meeting with Reading"

Activity names are fuzzy-matched against your own type list, so "start dev" finds "Development"; the assistant asks when a name is ambiguous.

## Limitations

- `start_activity` cannot attach a comment (the underlying start endpoint takes only a type and time); use `log_interval` for entries with comments/tags.
- No editing of existing entries (the server-side update API is incomplete).
- History requests are capped at 100 days by the backend.
