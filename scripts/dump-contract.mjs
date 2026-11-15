// Prints the server's public contract (tools with their input schemas, prompts with their arguments) as stable JSON.
// Used by the compatibility test and to refresh the snapshot: node scripts/dump-contract.mjs > contract/mcp-contract.json
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { PATH: process.env.PATH ?? "" } });
const client = new Client({ name: "contract", version: "0" });
await client.connect(transport);
const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
const tools = (await client.listTools()).tools
  .map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint ?? null, input: sort(t.inputSchema) }))
  .sort((a, b) => a.name.localeCompare(b.name));
const prompts = (await client.listPrompts()).prompts
  .map((p) => ({ name: p.name, arguments: (p.arguments ?? []).map((a) => ({ name: a.name, required: a.required ?? false })).sort((a, b) => a.name.localeCompare(b.name)) }))
  .sort((a, b) => a.name.localeCompare(b.name));
await client.close();
process.stdout.write(`${JSON.stringify({ tools, prompts }, null, 2)}\n`);
