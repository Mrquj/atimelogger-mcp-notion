import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTypeTools } from "./tools/types.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerReportTools } from "./tools/reports.js";

export const SERVER_NAME = "atimelogger";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "ATimeLogger is the user's personal time tracker. Use these tools whenever the user wants to",
  "track time, start/stop/pause a timer, log hours or a past activity, check what is being tracked",
  'right now, or see where their time went (daily/weekly/month