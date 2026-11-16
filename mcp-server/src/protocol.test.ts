import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect() {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { PATH: process.env.PATH ?? "" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const promptText = async (client: Client, name: string, args: Record<string, string> = {}) =>
  ((await client.getPrompt({ name, arguments: args })).messages[0].content as { text: string }).text;

describe("MCP server over stdio", () => {
  it("lists its tools and prompts, and reports missing settings clearly", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "writ_add_expert_answer", "writ_add_formats", "writ_add_research", "writ_apply_alignment_fixes", "writ_check_piece", "writ_complete_research", "writ_confirm_outline",
      "writ_confirm_scope", "writ_create_company", "writ_get_check_input", "writ_get_context_documents", "writ_get_piece", "writ_get_research",
      "writ_get_section", "writ_get_setup", "writ_get_voice", "writ_list_pieces", "writ_mark_findings", "writ_review_research", "writ_save_analysis",
      "writ_save_context_document", "writ_save_final_checks", "writ_save_outline", "writ_save_outline_checks", "writ_save_scope",
      "writ_save_section_checks", "writ_save_section_draft", "writ_save_section_points", "writ_start_piece", "writ_use_research",
    ]);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(["new_piece", "onboarding", "write_section"]);
    const r = await client.callTool({ name: "writ_list_pieces", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/Missing settings/);
    await client.close();
  }, 20000);

  it("only mentions tools that exist, in every walkthrough prompt", async () => {
    const client = await connect();
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    const newPiece = await promptText(client, "new_piece", { idea: "x" });
    const onboarding = await promptText(client, "onboarding");
    for (const text of [newPiece, onboarding]) {
      const mentioned = [...new Set(text.match(/writ_[a-z_]+/g) ?? [])];
      expect(mentioned.filter((m) => !tools.has(m))).toEqual([]);
    }
    expect([...new Set(newPiece.match(/writ_[a-z_]+/g) ?? [])].length).toBeGreaterThan(10);
    expect(newPiece).toContain("The writer's idea: x");
    for (const step of ["STEP 3B. THE GAP ANALYSIS", "STEP 4. OUTLINE", "STEP 6. FINAL CHECKS, THEN REVIEW", "writ_save_analysis", "writ_save_outline_checks", "writ_save_section_checks", "writ_save_final_checks", "workflow.gap_analysis.on", "workflow.checks.fact"]) {
      expect(newPiece).toContain(step);
    }
    expect(newPiece).toContain("DRAFTING RULES");
    expect(newPiece).toContain("You are drafting ONE section");
    await client.close();
  });

  it("onboarding shows the guide first, then branches on where the writer stands", async () => {
    const client = await connect();
    const text = await promptText(client, "onboarding");
    expect(text.indexOf("# Welcome to Writ in Claude")).toBeGreaterThan(-1);
    expect(text.indexOf("# Welcome to Writ in Claude")).toBeLessThan(text.indexOf("AFTER THE GUIDE"));
    for (const must of ["writ_get_setup", "writ_create_company", "writ_save_context_document", "NO COMPANY", "house_file_ready", "Open questions", "/writ:new_piece"]) {
      expect(text).toContain(must);
    }
    // the same headings the web app uses for the four documents
    for (const heading of ["Who we sell to", "The category we compete in", "The viewpoint and philosophy behind our writing", "Content pillars or themes"]) {
      expect(text).toContain(heading);
    }
    await client.close();
  }, 20000);
});
