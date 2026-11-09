import { describe, expect, it } from "vitest";
import { MarkdownManager } from "@tiptap/markdown";
import { richExtensions } from "./richExtensions";

// The editor stores Markdown. What it writes back must stay within what the export and the checks understand.
describe("section editor markdown", () => {
  const manager = new MarkdownManager({ extensions: richExtensions() });
  const trip = (md: string) => manager.serialize(manager.parse(md));

  it("keeps headings, lists, emphasis and links", () => {
    const md = [
      "Intro with **bold**, *italic* and a [link](https://example.com/a).",
      "### A heading",
      "- one\n- two",
      "1. first\n2. second",
      "#### Smaller",
      "Closing.",
    ].join("\n\n");
    const out = trip(md);
    expect(out).toContain("### A heading");
    expect(out).toContain("#### Smaller");
    expect(out).toContain("- one");
    expect(out).toContain("1. first");
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
    expect(out).toContain("[link](https://example.com/a)");
  });

  it("round-trips a table", () => {
    const out = trip("| Tool | Cost |\n| --- | --- |\n| A | 10 |\n| B | 20 |");
    expect(out).toMatch(/\| Tool\s+\| Cost\s+\|/);
    expect(out).toMatch(/\| A\s+\| 10\s+\|/);
  });

  it("keeps text with underscores, asterisks and pipes readable", () => {
    const out = trip("Use snake_case names, 2*3 = 6, and a | pipe. Cost: $5 (about 10%).");
    // The words must survive, whatever escaping the editor adds around them.
    expect(out.replace(/\\/g, "")).toContain("snake_case names, 2*3 = 6, and a | pipe. Cost: $5 (about 10%).");
  });

  it("leaves plain paragraphs alone", () => {
    expect(trip("One paragraph.\n\nAnother one.").trim()).toBe("One paragraph.\n\nAnother one.");
  });
});
