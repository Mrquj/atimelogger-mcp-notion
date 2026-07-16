import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

// Validate ATimeLogger config at boot so misconfiguration fails fast.
loadConfig();

const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = process.env.MCP_PATH || "/mcp";
// Optional shared-secret gate for the public endpoint. When set, every /mcp
// request must present it (Authorization: Bearer, x-mcp-token, or ?token=).
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || undefined;

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: allow the MCP session header to be read/sent by browser-based clients.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, x-mcp-token, last-event-id"
  );
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

/** Constant-time-ish comparison of the presented secret against MCP_AUTH_TOKEN. */
function presentedToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const xToken = req.headers["x-mcp-token"];
  if (typeof xToken === "string" && xToken.trim()) return xToken.trim();
  const q = req.query.token;
  if (typeof q === "string" && q.trim()) return q.trim();
  return undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next(); // auth disabled
  if (presentedToken(req) === AUTH_TOKEN) return next();
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid MCP access token." },
    id: null,
  });
}

// Health check (no auth) — handy for uptime probes and platform health checks.
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, transport: "streamable-http", mcpPath: MCP_PATH });
});

// Friendly root page so a browser hitting the URL sees something useful.
app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send(
    `${SERVER_NAME} MCP server (v${SERVER_VERSION})\n` +
      `Streamable HTTP endpoint: ${MCP_PATH}\n` +
      (AUTH_TOKEN ? "Access token: required\n" : "Access token: disabled\n") +
      "Connect this URL from a remote-MCP client (e.g. a Notion custom agent).\n"
  );
});

// One transport per initialized MCP session, keyed by session id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Main MCP endpoint: POST carries JSON-RPC (initialize + subsequent calls).
app.post(MCP_PATH, requireAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." },
        id: null,
      });
      return;
    }

    // New session: create a transport + a fresh server instance and connect them.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport as StreamableHTTPServerTransport;
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) delete transports[transport.sessionId];
    };

    const server = buildServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// GET opens the server->client SSE stream; DELETE terminates a session.
async function replaySessionRequest(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get(MCP_PATH, requireAuth, replaySessionRequest);
app.delete(MCP_PATH, requireAuth, replaySessionRequest);

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${SERVER_NAME}] Streamable HTTP MCP server listening on :${PORT}`);
  console.log(`[${SERVER_NAME}] MCP endpoint: ${MCP_PATH}   health: /health`);
  console.log(`[${SERVER_NAME}] Access token: ${AUTH_TOKEN ? "required" : "disabled (set MCP_AUTH_TOKEN to protect it)"}`);
});

function shutdown(signal: string) {
  console.log(`[${SERVER_NAME}] ${signal} received, shutting down…`);
  for (const [id, t] of Object.entries(transports)) {
    try {
      t.close();
    } catch {
      /* ignore */
    }
    delete transports[id];
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
