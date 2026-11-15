import { describe, expect, it } from "vitest";
import { assemble, headingLine } from "./assemble";

describe("assemble", () => {
  it("writes main headings as ## and sub-headings as ###", () => {
    expect(headingLine({ heading: "Tools", level: 2 })).toBe("## Tools");
    expect(headingLine({ heading: "Tool A", level: 3 })).toBe("### Tool A");
  });
  it("treats a row without a level as a main heading, so older rows come out as before", () => {
    expect(assemble([{ heading: "One", content: "a" }, { heading: "Two", content: "b", level: null }])).toBe("## One\n\na\n\n## Two\n\nb");
  });
  it("keeps the order and nests sub-headings under their main heading", () => {
    const text = assemble([
      { heading: "Emerging technologies", content: "Opening", level: 2 },
      { heading: "Quantum", content: "Deep dive", level: 3 },
      { heading: "Next", content: "More", level: 2 },
    ]);
    expect(text).toBe("## Emerging technologies\n\nOpening\n\n### Quantum\n\nDeep dive\n\n## Next\n\nMore");
  });
  it("can trim each text", () => {
    expect(assemble([{ heading: "A", content: "  x \n" }], { trim: true })).toBe("## A\n\nx");
  });
  it("keeps a heading with no text, as before", () => {
    expect(assemble([{ heading: "A", content: "", level: 2 }])).toBe("## A\n\n");
  });
});
