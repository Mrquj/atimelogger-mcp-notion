#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";

loadConfig(); // fail fast with setup instructions if ATL_TOKEN is missing

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
