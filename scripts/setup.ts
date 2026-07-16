/**
 * Register the MCP server with a Personal Access Token.
 * Generate the token in the ATimeLogger web app first:
 *   Settings -> API Tokens -> Generate token  (the value is shown only once)
 * Usage: npm run setup  (or: tsx scripts/setup.ts [--url http://host:port])
 */
import * as readline from "node:readline";
import { stdin, stdout, argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const PAT_PREFIX = "atl_pat_";

function ask(question: string, mask = false): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  if (mask) {
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
    anyRl._writeToOutput = (s: string) => {
      // Echo the prompt itself, mask typed characters.
      stdout.write(s.includes(question) ? s : "*");
    };
  }
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      if (mask) stdout.write("\n");
      res(answer.trim());
    });
  });
}

const PROD_URL = "https://app.atimelogger.pro";

// Production by default; override implicitly via --url or the ATL_BASE_URL env var.
const urlFlag = argv.indexOf("--url");
const baseUrl = (urlFlag > -1 ? argv[urlFlag + 1] : env.ATL_BASE_URL ?? PROD_URL).replace(/\/+$/, "");
const isDefaultUrl = baseUrl === PROD_URL;

if (!isDefaultUrl) {
  console.log(`Server: ${baseUrl}`);
}
console.log("Generate a Personal Access Token in the ATime