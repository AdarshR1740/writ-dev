import { describe, expect, it } from "vitest";
import { MCP_REFERENCE } from "./mcpTools.generated";

// The reference is generated from the MCP server. These checks make sure what the "Writ in Claude" page shows is whole.
describe("the Writ in Claude reference", () => {
  const tools = MCP_REFERENCE.groups.flatMap((g) => g.tools);

  it("lists every tool once, each with a summary and when it is used", () => {
    expect(tools.length).toBeGreaterThan(25);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^writ_/);
      expect(t.summary.length).toBeGreaterThan(20);
      expect(t.when.length).toBeGreaterThan(8);
    }
  });

  it("has no empty group, and the prompts a writer starts from", () => {
    for (const g of MCP_REFERENCE.groups) expect(g.tools.length, g.name).toBeGreaterThan(0);
    expect(MCP_REFERENCE.prompts.map((p) => p.command).sort()).toEqual(["/writ:new_piece", "/writ:onboarding", "/writ:write_section"]);
  });

  it("shows the health check and the approval marker where tools need the writer's go-ahead", () => {
    expect(tools.find((t) => t.name === "writ_check_piece")?.effect).toBe("reads");
    expect(tools.find((t) => t.name === "writ_confirm_outline")).toMatchObject({ effect: "moves the piece on", needsApproval: true });
    expect(tools.filter((t) => t.effect === "reads").every((t) => !t.needsApproval)).toBe(true);
  });
});
