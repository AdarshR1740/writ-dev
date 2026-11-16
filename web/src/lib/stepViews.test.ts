import { describe, expect, it } from "vitest";
import { describePiece, outlineView, researchLocked, writingState, type PieceFacts, type SectionFacts } from "./stepViews";

const section = (position: number, heading: string, extra: Partial<SectionFacts> = {}): SectionFacts => ({
  position, level: 2, heading, status: "writing", words: 300, hasPoints: true, hasBrief: false, hasAiDraft: true, ...extra,
});

/** A piece the way the MCP server leaves it: scope and research done, an outline saved, no gap analysis, no UI-only flags. */
const mcpPiece = (over: Partial<PieceFacts> = {}): PieceFacts => ({
  stage: "outline",
  outlineConfirmed: false,
  signedOff: false,
  recipe: { analysisEnabled: true, outlineMode: "free", contractMode: "full", researchEnabled: true, aiDrafts: true },
  analysis: { exists: false, benchmarkDone: false },
  contract: { confirmed: true, points: 6 },
  research: { approved: 9, unreviewed: 0 },
  sections: [section(1, "A"), section(2, "B"), section(3, "C"), section(4, "D")],
  ...over,
});
const ids = (f: PieceFacts) => describePiece(f).concerns.map((c) => c.id);

describe("which panel the Outline step shows", () => {
  const base = { analysisEnabled: true, confirmed: false, benchmarkDone: false, hasOutline: false, benchmarkOpen: false };
  it("shows the benchmark first when there is no outline yet", () => {
    expect(outlineView(base)).toMatchObject({ showBenchmark: true, showOutline: false, offerBenchmark: false });
  });
  it("shows an outline that already exists, even when the benchmark was never marked finished (reopened, or made elsewhere)", () => {
    expect(outlineView({ ...base, hasOutline: true })).toEqual({ showBenchmark: false, showOutline: true, offerBenchmark: true, offerBack: false });
  });
  it("lets the writer open the benchmark over an existing outline, and go back", () => {
    expect(outlineView({ ...base, hasOutline: true, benchmarkOpen: true })).toEqual({ showBenchmark: true, showOutline: false, offerBenchmark: false, offerBack: true });
  });
  it("shows the editor once the benchmark is finished, a confirmed outline, or a format with no benchmark", () => {
    expect(outlineView({ ...base, benchmarkDone: true, hasOutline: true }).showOutline).toBe(true);
    expect(outlineView({ ...base, confirmed: true, hasOutline: true })).toMatchObject({ showOutline: true, showBenchmark: false, offerBenchmark: false });
    expect(outlineView({ ...base, analysisEnabled: false })).toMatchObject({ showOutline: true, showBenchmark: false });
  });
});

describe("the Writing step's starting state", () => {
  it("is empty with no sections, and needs preparing while any is in research or brief", () => {
    expect(writingState([], true)).toMatchObject({ empty: true, startable: false });
    expect(writingState([{ status: "research", content: "" }, { status: "writing", content: "" }], true)).toMatchObject({ unprepared: 1, startable: false });
  });
  it("offers the choice of how to write only when everything is prepared and nothing is started", () => {
    expect(writingState([{ status: "writing", content: "" }], true).startable).toBe(true);
    expect(writingState([{ status: "writing", content: " text " }], true).startable).toBe(false);
    expect(writingState([{ status: "writing", words: 12 }], true).startable).toBe(false);
    expect(writingState([{ status: "writing", content: "" }], false).startable).toBe(false);
  });
});

describe("research is locked once the stage has moved on", () => {
  it("only the research stage is open", () => {
    expect(researchLocked("research")).toBe(false);
    for (const s of ["contract", "outline", "writing", "done"] as const) expect(researchLocked(s)).toBe(true);
  });
});

describe("a piece built the way the MCP server builds it still has something sensible on every step", () => {
  it("an outline saved with no gap analysis shows the outline, and notes that the benchmark was not run", () => {
    const d = describePiece(mcpPiece());
    expect(d.sees.outline).toMatch(/outline editor with 4 sections, open for editing/);
    expect(d.concerns.map((c) => [c.id, c.severity])).toEqual([["benchmark-not-run", "note"]]);
  });

  it("the same piece reopened after being confirmed still shows its outline (the SI-0013 case)", () => {
    // Reopening takes the piece back to the outline stage, unconfirmed, with the benchmark flag still unset.
    const d = describePiece(mcpPiece({ stage: "outline", outlineConfirmed: false }));
    expect(d.sees.outline).not.toMatch(/benchmark of the scope/);
  });

  it("a confirmed outline in the writing stage shows the sections and nothing is flagged", () => {
    const f = mcpPiece({ stage: "writing", outlineConfirmed: true });
    const d = describePiece(f);
    expect(d.sees.writing).toMatch(/sections, 0 of 4 marked written/);
    expect(d.concerns).toEqual([]);
  });

  it("describes sub-headings, and does not flag an empty opening on a main heading that has them", () => {
    const f = mcpPiece({
      stage: "writing", outlineConfirmed: true,
      sections: [section(1, "A"), section(2, "B", { status: "written", words: 0 }), section(3, "b1", { level: 3, status: "written", words: 200 }), section(4, "C", { status: "written", words: 90 })],
    });
    const d = describePiece(f);
    expect(d.sees.outline).toMatch(/3 sections and 1 sub-heading/);
    expect(ids(f)).not.toContain("written-empty-2");
  });

  it("every step has a description for any stage", () => {
    for (const stage of ["contract", "research", "outline", "writing", "done"] as const) {
      const d = describePiece(mcpPiece({ stage, outlineConfirmed: stage === "writing" || stage === "done" }));
      for (const text of Object.values(d.sees)) expect(text.trim().length).toBeGreaterThan(3);
    }
  });
});

describe("states that should be flagged", () => {
  it("no sections at or after the outline step", () => {
    expect(ids(mcpPiece({ sections: [] }))).toContain("no-sections");
    expect(describePiece(mcpPiece({ sections: [] })).sees.outline).toMatch(/benchmark/);
    expect(ids(mcpPiece({ stage: "writing", outlineConfirmed: true, sections: [] }))).toContain("no-sections");
  });
  it("writing without a confirmed outline, and a confirmed outline stuck at the outline stage", () => {
    expect(ids(mcpPiece({ stage: "writing", outlineConfirmed: false }))).toContain("writing-without-confirmed-outline");
    expect(ids(mcpPiece({ stage: "outline", outlineConfirmed: true }))).toContain("outline-confirmed-in-outline-stage");
  });
  it("a first sub-heading, and sub-headings in a format whose outline is not free", () => {
    const subs = [section(1, "x", { level: 3 }), section(2, "B")];
    expect(ids(mcpPiece({ sections: subs }))).toContain("first-is-subheading");
    const fixed = mcpPiece({ recipe: { ...mcpPiece().recipe, outlineMode: "fixed" }, sections: [section(1, "A"), section(2, "a1", { level: 3 })] });
    expect(ids(fixed)).toContain("subheadings-not-free");
  });
  it("sections not prepared once writing has started, and a section ready to write with no guide", () => {
    const f = mcpPiece({ stage: "writing", outlineConfirmed: true, sections: [section(1, "A", { status: "research", hasPoints: false }), section(2, "B", { hasPoints: false, hasBrief: false })] });
    expect(ids(f)).toEqual(expect.arrayContaining(["unprepared-sections", "no-guide-2"]));
    expect(describePiece(f).sees.writing).toMatch(/prepare screen/);
  });
  it("a section marked written with no text, and a scope that was never confirmed", () => {
    const f = mcpPiece({ stage: "writing", outlineConfirmed: true, contract: { confirmed: false, points: 3 }, sections: [section(1, "A", { status: "written", words: 0 })] });
    expect(ids(f)).toEqual(expect.arrayContaining(["written-empty-1", "scope-unconfirmed", "ready-to-sign-off"]));
  });
  it("does not flag the scope for a format with no scope step, and says there is none", () => {
    const f = mcpPiece({ recipe: { ...mcpPiece().recipe, contractMode: "off" }, contract: { confirmed: false, points: 0 } });
    expect(ids(f)).not.toContain("scope-unconfirmed");
    expect(describePiece(f).sees.scope).toBe("No scope step for this format.");
  });
  it("a one-section format with no outline has no sections concern", () => {
    const f = mcpPiece({ recipe: { ...mcpPiece().recipe, outlineMode: "off", analysisEnabled: false }, stage: "writing", outlineConfirmed: true, sections: [section(1, "T")] });
    expect(ids(f)).toEqual([]);
    expect(describePiece(f).sees.outline).toMatch(/one section/);
  });
});
