import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildReference, toAppModule, toMarkdown, type LivePrompt, type LiveTool } from "./docs-build.js";
import { GROUPS, PROMPT_DOCS, TOOL_DOCS } from "./tool-docs.js";

/**
 * The reference of what each tool does must stay complete and current. Adding a tool or prompt without an entry in
 * src/tool-docs.ts fails here, and so does changing a tool (its parameters, its name) without running `npm run docs:update`.
 */
async function live(): Promise<{ tools: LiveTool[]; prompts: LivePrompt[] }> {
  const client = new Client({ name: "docs-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { PATH: process.env.PATH ?? "" } }));
  const tools = (await client.listTools()).tools as unknown as LiveTool[];
  const prompts = (await client.listPrompts()).prompts as unknown as LivePrompt[];
  await client.close();
  return { tools, prompts };
}
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const appFile = `${process.env.WRIT_APP_DIR ?? ".."}/web/src/lib/mcpTools.generated.ts`;
const norm = (s: string) => s.replace(/\r\n/g, "\n");

describe("the tool reference", () => {
  it("has an entry for every tool and prompt, and none for ones that are gone", async () => {
    const { tools, prompts } = await live();
    expect(() => buildReference(tools, prompts, version)).not.toThrow();
    expect(Object.keys(TOOL_DOCS).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(Object.keys(PROMPT_DOCS).sort()).toEqual(prompts.map((p) => p.name).sort());
  }, 30000);

  it("says in plain words what each tool does and when, in a known group", () => {
    for (const [name, d] of Object.entries(TOOL_DOCS)) {
      expect(d.summary.length, name).toBeGreaterThan(20);
      expect(d.when.length, name).toBeGreaterThan(8);
      expect(GROUPS as readonly string[], name).toContain(d.group);
    }
  });

  it("marks every read-only tool as reading, and every tool that writes as something else", async () => {
    const { tools } = await live();
    for (const t of tools) {
      const reads = TOOL_DOCS[t.name].effect === "reads";
      expect(reads, t.name).toBe(t.annotations?.readOnlyHint === true);
    }
  }, 30000);

  it("is up to date: docs/TOOLS.md matches the live server (run npm run docs:update if this fails)", async () => {
    const { tools, prompts } = await live();
    const ref = buildReference(tools, prompts, version);
    expect(norm(readFileSync("docs/TOOLS.md", "utf8"))).toBe(toMarkdown(ref));
  }, 30000);

  it.skipIf(!existsSync(appFile))("is up to date in the Writ app's page data too", async () => {
    const { tools, prompts } = await live();
    const ref = buildReference(tools, prompts, version);
    expect(norm(readFileSync(appFile, "utf8"))).toBe(toAppModule(ref));
  }, 30000);
});
