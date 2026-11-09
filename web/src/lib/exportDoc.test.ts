import { describe, expect, it } from "vitest";
import { bodyHtml, documentHtml, fileName, inlineHtml, markdown, toBlocks, type ExportPiece } from "./exportDoc";

const piece: ExportPiece = {
  title: "Why twins stall",
  sections: [
    { heading: "The data problem", content: "Most teams stall on **data**, not tools.\n\n- Clean the SKU master\n- Then pick a tool\n\n### What to do first\n\nSee [the survey](https://example.org/s)." },
    { heading: "What it costs", content: "Less than you *think*." },
  ],
};

describe("export", () => {
  it("turns sections into headings, paragraphs and lists", () => {
    expect(toBlocks(piece).map((b) => b.kind)).toEqual(["h2", "p", "ul", "h3", "p", "h2", "p"]);
  });

  it("reads numbered lists, #### subheads and tables", () => {
    const rich: ExportPiece = {
      title: "T",
      sections: [{ heading: "H", content: "1. First\n2. Second\n\n#### Small\n\n| Tool | Cost |\n| --- | --- |\n| A | 10 |" }],
    };
    expect(toBlocks(rich).map((b) => b.kind)).toEqual(["h2", "ol", "h4", "table"]);
    const html = bodyHtml(rich);
    expect(html).toContain("<ol>");
    expect(html).toContain("<h4>Small</h4>");
    expect(html).toContain("<th>Tool</th>");
    expect(html).toContain("<td>10</td>");
    const md = markdown(rich);
    expect(md).toContain("1. First");
    expect(md).toContain("#### Small");
    expect(md).toContain("| Tool | Cost |");
    expect(md).toContain("| --- | --- |");
  });

  it("doesn't repeat the title for a single section headed like the piece", () => {
    const one = { title: "Why twins stall", sections: [{ heading: "Why twins stall", content: "Text." }] };
    expect(toBlocks(one)).toEqual([{ kind: "p", text: "Text." }]);
  });

  it("escapes HTML and links only http(s) addresses", () => {
    expect(inlineHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(inlineHtml("[x](javascript:alert(1))")).not.toContain("<a");
    expect(inlineHtml("[x](https://a.b/c)")).toBe('<a href="https://a.b/c">x</a>');
    expect(inlineHtml("**bold** and *it*")).toBe("<strong>bold</strong> and <em>it</em>");
  });

  it("reads the editor's backslash escapes, link addresses with brackets, and escaped pipes", () => {
    expect(inlineHtml("Use snake\\_case and 2\\*3 and 4\\*5.")).toBe("Use snake_case and 2*3 and 4*5.");
    expect(inlineHtml("See [the page](https://en.wikipedia.org/wiki/Foo_(bar)) now.")).toBe('See <a href="https://en.wikipedia.org/wiki/Foo_(bar)">the page</a> now.');
    const piece2: ExportPiece = { title: "T", sections: [{ heading: "H", content: "| A | b \\| c |\n| --- | --- |\n| 1 | 2 |" }] };
    expect(toBlocks(piece2)[1]).toEqual({ kind: "table", rows: [["A", "b | c"], ["1", "2"]] });
  });

  it("builds body HTML with sources and the disclosure line", () => {
    const html = bodyHtml({ ...piece, sources: [{ title: "Survey", url: "https://example.org/s", published: "2025" }], disclosure: "Written by our team." });
    expect(html).toContain("<h2>The data problem</h2>");
    expect(html).toContain("<li>Clean the SKU master</li>");
    expect(html).toContain('<h2>Sources</h2>');
    expect(html).toContain('<a href="https://example.org/s">Survey</a>, 2025');
    expect(html.trim().endsWith("<p><em>Written by our team.</em></p>")).toBe(true);
    expect(html).not.toContain("<h1>");
  });

  it("puts the meta title and description in the document head", () => {
    const doc = documentHtml({ ...piece, metaTitle: "Twins <stall>", metaDescription: 'Say "why"' });
    expect(doc).toContain("<title>Twins &lt;stall&gt;</title>");
    expect(doc).toContain('content="Say &quot;why&quot;"');
  });

  it("writes Markdown and safe file names", () => {
    expect(markdown(piece)).toMatch(/^# Why twins stall\n\n## The data problem\n\nMost teams/);
    expect(fileName("Why twins stall: a 2026 view!", "docx")).toBe("why-twins-stall-a-2026-view.docx");
  });
});
