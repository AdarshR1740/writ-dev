// Regenerates the reference of what each MCP tool and prompt does:
//   docs/TOOLS.md                                  (in this repo)
//   <app>/web/src/lib/mcpTools.generated.ts       (the "Writ in Claude" page in the Writ app, if the app repo is found)
//
//   npm run docs:update            (builds first; the app repo is taken from WRIT_APP_DIR or ../writ-dev)
//
// It starts the built server to see which tools and prompts exist and what their parameters are, and combines that with the
// plain-language entries in src/tool-docs.ts. It stops with a clear message if a tool or prompt has no entry.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.resolve(process.argv[2] ?? process.env.WRIT_APP_DIR ?? path.join(root, "..", "writ-dev"));
const { buildReference, toMarkdown, toAppModule } = await import(pathToFileURL(path.join(root, "dist", "docs-build.js")).href);

const client = new Client({ name: "docs", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(root, "dist", "index.js")], env: { PATH: process.env.PATH ?? "" } }));
const tools = (await client.listTools()).tools;
const prompts = (await client.listPrompts()).prompts;
await client.close();

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const ref = buildReference(tools, prompts, version);

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "TOOLS.md"), toMarkdown(ref));
console.log(`docs/TOOLS.md written (${tools.length} tools, ${prompts.length} prompts)`);

const appDir = path.join(appRoot, "web", "src", "lib");
if (fs.existsSync(appDir)) {
  fs.writeFileSync(path.join(appDir, "mcpTools.generated.ts"), toAppModule(ref));
  console.log(`${path.join(appDir, "mcpTools.generated.ts")} written`);
} else {
  console.log(`The Writ app was not found at ${appRoot}: its page was not updated. Pass the path, or set WRIT_APP_DIR.`);
}
