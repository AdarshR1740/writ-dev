/**
 * What each step of a piece shows, decided from the piece's real data, never from flags the app sets as a side effect of
 * its own buttons. A piece made somewhere else (the MCP server) has the same data and so gets the same screens.
 *
 * Pure and self-contained (no imports), so the MCP server can carry a generated copy of this file
 * (scripts/export-step-views.mjs in writ-mcp-server) and describe the screens the same way. Keep it free of imports.
 *
 * The rule for a screen: if it shows or hides something, that must be a function of the data underneath, and a piece with
 * the data but without a UI-only flag must still show the data. `describePiece` below lists the states that break this.
 */

export type StageName = "contract" | "research" | "outline" | "writing" | "done";

/** Which of the benchmark and the outline editor the Outline step shows. */
export function outlineView(s: { analysisEnabled: boolean; confirmed: boolean; benchmarkDone: boolean; hasOutline: boolean; benchmarkOpen: boolean }) {
  const showBenchmark = s.analysisEnabled && !s.confirmed && !s.benchmarkDone && (!s.hasOutline || s.benchmarkOpen);
  const showOutline = !s.analysisEnabled || s.confirmed || s.benchmarkDone || (s.hasOutline && !s.benchmarkOpen);
  // The benchmark was never finished for an outline that exists: offer to run it, or to go back to the outline.
  const offerBenchmark = s.analysisEnabled && !s.confirmed && !s.benchmarkDone && s.hasOutline && !s.benchmarkOpen;
  const offerBack = s.analysisEnabled && !s.confirmed && !s.benchmarkDone && s.hasOutline && s.benchmarkOpen;
  return { showBenchmark, showOutline, offerBenchmark, offerBack };
}

/** What the Writing step starts from: nothing to write, sections to prepare, the choice of how to write, or the sections. */
export function writingState(sections: { status: string; content?: string; words?: number }[], autoPrepare: boolean) {
  const empty = sections.length === 0;
  const unprepared = sections.filter((s) => s.status === "research" || s.status === "brief").length;
  const started = sections.some((s) => (s.content ?? "").trim() !== "" || (s.words ?? 0) > 0 || s.status === "written");
  return { empty, unprepared, started, startable: autoPrepare && !empty && unprepared === 0 && !started };
}

/** A step's research is locked once the stage has moved on (or, for a section, once it left the research status). */
export const researchLocked = (stage: StageName) => stage !== "research";

// ---------------------------------------------------------------------------
// Describing a piece: what the writer will see at each step, and what looks wrong
// ---------------------------------------------------------------------------

export interface SectionFacts {
  position: number;
  /** 2 for a main heading, 3 for a sub-heading. */
  level: number;
  heading: string;
  status: string;
  words: number;
  hasPoints: boolean;
  hasBrief: boolean;
  hasAiDraft: boolean;
}

export interface PieceFacts {
  stage: StageName;
  outlineConfirmed: boolean;
  signedOff: boolean;
  recipe: { analysisEnabled: boolean; outlineMode: "off" | "fixed" | "free"; contractMode: "off" | "lite" | "full"; researchEnabled: boolean; aiDrafts: boolean };
  /** Whether the gap analysis has ever been run and whether the benchmark was marked finished. */
  analysis: { exists: boolean; benchmarkDone: boolean };
  contract: { confirmed: boolean; points: number } | null;
  research: { approved: number; unreviewed: number };
  sections: SectionFacts[];
}

export interface Concern {
  id: string;
  /** "problem": the writer would see something wrong or be stuck. "note": worth knowing, nothing is broken. */
  severity: "problem" | "note";
  step: "scope" | "research" | "outline" | "writing" | "signoff";
  message: string;
  suggestion: string;
}

export interface PieceDescription {
  /** In words, what the writer will see on each step right now. */
  sees: Record<Concern["step"], string>;
  concerns: Concern[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describePiece(f: PieceFacts): PieceDescription {
  const concerns: Concern[] = [];
  const add = (c: Concern) => concerns.push(c);
  const hasOutline = f.sections.length > 0;
  const subs = f.sections.filter((s) => s.level === 3).length;
  const mains = f.sections.length - subs;
  const outline = outlineView({ analysisEnabled: f.recipe.analysisEnabled, confirmed: f.outlineConfirmed, benchmarkDone: f.analysis.benchmarkDone, hasOutline, benchmarkOpen: false });
  const writing = writingState(f.sections, f.recipe.outlineMode !== "off");
  const afterScope = f.stage !== "contract";
  const afterOutline = f.stage === "writing" || f.stage === "done";

  // --- what the writer sees
  const sees: PieceDescription["sees"] = {
    scope: f.recipe.contractMode === "off" ? "No scope step for this format." : f.contract ? (f.contract.confirmed ? `The scope, confirmed, with ${plural(f.contract.points, "point")}.` : `The scope, open for editing, with ${plural(f.contract.points, "point")}.`) : "The scope editor, with nothing written yet.",
    research: researchLocked(f.stage)
      ? `The research, locked: ${f.research.approved} approved.`
      : `The research, open: ${f.research.approved} approved, ${f.research.unreviewed} waiting for review.`,
    outline: f.recipe.outlineMode === "off"
      ? "No outline for this format: the piece is one section."
      : outline.showOutline
        ? `The outline editor with ${plural(mains, "section")}${subs ? ` and ${plural(subs, "sub-heading")}` : ""}${f.outlineConfirmed ? ", confirmed" : ", open for editing"}.`
        : "The benchmark of the scope and research, with no outline yet.",
    writing: writing.empty
      ? "Nothing: the piece has no sections."
      : writing.unprepared > 0 && f.recipe.outlineMode !== "off"
        ? `The prepare screen: ${plural(writing.unprepared, "section")} still to prepare.`
        : writing.startable
          ? "The choice of writing by hand or with AI."
          : `The sections, ${f.sections.filter((s) => s.status === "written").length} of ${f.sections.length} marked written.`,
    signoff: f.signedOff ? "Signed off." : f.stage === "done" ? "Done." : "Not reached yet.",
  };

  // --- what looks wrong
  if (afterScope && f.contract && !f.contract.confirmed && f.recipe.contractMode !== "off") {
    add({ id: "scope-unconfirmed", severity: "problem", step: "scope", message: `The piece is at the ${f.stage} stage but its scope is not confirmed.`, suggestion: "Confirm the scope with writ_confirm_scope, or reopen the piece to the scope step." });
  }
  if (f.recipe.outlineMode !== "off" && (f.stage === "outline" || afterOutline) && !hasOutline) {
    add({ id: "no-sections", severity: "problem", step: "outline", message: "The piece has reached the outline step or beyond, but has no sections.", suggestion: "Save an outline with writ_save_outline." });
  }
  if (f.stage === "outline" && f.outlineConfirmed) {
    add({ id: "outline-confirmed-in-outline-stage", severity: "problem", step: "outline", message: "The outline is marked confirmed but the piece is still at the outline stage.", suggestion: "Reopen the outline in Writ and confirm it again." });
  }
  if (f.stage === "writing" && !f.outlineConfirmed && f.recipe.outlineMode !== "off") {
    add({ id: "writing-without-confirmed-outline", severity: "problem", step: "writing", message: "The piece is at the writing stage but its outline is not confirmed.", suggestion: "Confirm the outline with writ_confirm_outline." });
  }
  if (f.sections[0]?.level === 3) {
    add({ id: "first-is-subheading", severity: "problem", step: "outline", message: "The first section is a sub-heading, so it has no main heading above it.", suggestion: "Save the outline again with a main heading first." });
  }
  if (subs > 0 && f.recipe.outlineMode !== "free") {
    add({ id: "subheadings-not-free", severity: "problem", step: "outline", message: "The outline has sub-headings but this format's outline is not free.", suggestion: "Remove the sub-headings, or change the format's workflow in Writ." });
  }
  if (afterOutline && writing.unprepared > 0 && f.recipe.outlineMode !== "off") {
    add({ id: "unprepared-sections", severity: "note", step: "writing", message: `${plural(writing.unprepared, "section")} not prepared yet: the Writing step will show the prepare screen.`, suggestion: "Prepare each with its research and talking points (writ_use_research, writ_save_section_points)." });
  }
  for (const s of f.sections) {
    if (s.status === "writing" && !s.hasPoints && !s.hasBrief && f.recipe.outlineMode !== "off") {
      add({ id: `no-guide-${s.position}`, severity: "note", step: "writing", message: `"${s.heading}" is ready to write but has no talking points and no brief.`, suggestion: "Save its talking points with writ_save_section_points." });
    }
    if (s.status === "written" && s.words === 0) {
      const next = f.sections.find((x) => x.position > s.position);
      // A main heading whose content is its sub-headings may be written with an empty opening.
      if (!(s.level === 2 && next?.level === 3)) {
        add({ id: `written-empty-${s.position}`, severity: "problem", step: "writing", message: `"${s.heading}" is marked written but has no text.`, suggestion: "Reopen the section in Writ and write it." });
      }
    }
  }
  if (f.stage === "writing" && hasOutline && f.sections.every((s) => s.status === "written")) {
    add({ id: "ready-to-sign-off", severity: "note", step: "signoff", message: "Every section is written. The piece is ready to sign off.", suggestion: "Review the draft in Writ and sign off." });
  }
  if (f.recipe.analysisEnabled && hasOutline && !f.analysis.exists && f.stage === "outline") {
    add({ id: "benchmark-not-run", severity: "note", step: "outline", message: "The outline exists but the benchmark of the scope and research was never run. The writer will see the outline, with a button to run the benchmark.", suggestion: "Optional: run the gap analysis and save it with writ_save_analysis." });
  }
  if (afterScope && f.recipe.researchEnabled && f.research.approved === 0 && f.stage !== "research") {
    add({ id: "no-approved-research", severity: "note", step: "research", message: "The piece has moved past research with no approved research.", suggestion: "Add and approve research, or continue knowingly without it." });
  }
  return { sees, concerns };
}
