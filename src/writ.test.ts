import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FORMAT_PRESETS } from "./format-presets.js";
import {
  addExpertAnswer, applyAlignmentFixes, getCheckInput, getAnalysisInput, getOutlineCheckInput, getReviewInput, markFindings, saveAnalysis,
  saveFinalChecks, saveOutlineChecks, saveSectionChecks,
  addFormats, addResearch, completeResearch, confirmOutline, confirmScope, createCompany, getContextDocuments, getResearch, getSetup, reviewResearch,
  saveContextDocument, saveOutline, saveScope, saveSectionDraft, saveSectionPoints, startPiece, useResearch, workflowOf, WritError,
} from "./writ.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** A stand-in for the Supabase client: tables return the given rows, and updates are recorded. */
function fake(section: Record<string, unknown>, recipe: unknown = { writing: { ai_draft: true } }, opts: { conflict?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain,
        maybeSingle: async () => ({ data: table === "piece_sections" ? section : { recipe }, error: null }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          const first = updates.length === 1;
          const u: Record<string, unknown> = { eq: () => u, select: async () => ({ data: opts.conflict && first ? [] : [{ id: ID }], error: null }) };
          return u;
        },
      });
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, updates };
}

const base = { id: ID, piece_id: "p", heading: "Why it matters", status: "writing", content: "" };

describe("saveSectionDraft", () => {
  it("saves as text and AI draft when the writer has written nothing", async () => {
    const { db, updates } = fake(base);
    const r = await saveSectionDraft(db, ID, "### Part\nText");
    expect(r.became_section_text).toBe(true);
    expect(updates).toEqual([{ ai_draft: "### Part\nText", content: "### Part\nText" }]);
  });
  it("never overwrites the writer's text", async () => {
    const { db, updates } = fake({ ...base, content: "My own words" });
    const r = await saveSectionDraft(db, ID, "Draft");
    expect(r.became_section_text).toBe(false);
    expect(updates).toEqual([{ ai_draft: "Draft" }]);
  });
  it("refuses written, unprepared, empty, # headings and recipes without AI drafts", async () => {
    await expect(saveSectionDraft(fake({ ...base, status: "written" }).db, ID, "x")).rejects.toThrow(WritError);
    await expect(saveSectionDraft(fake({ ...base, status: "research" }).db, ID, "x")).rejects.toThrow(/prepared/);
    await expect(saveSectionDraft(fake(base).db, ID, "  ")).rejects.toThrow(/empty/);
    await expect(saveSectionDraft(fake(base).db, ID, "## Own heading\nx")).rejects.toThrow(/###/);
    await expect(saveSectionDraft(fake(base, { writing: { ai_draft: false } }).db, ID, "x")).rejects.toThrow(/switched off/);
  });
});

/** A stand-in with several tables, a recorded rpc, and recorded updates, for the start/scope flow. */
function fakeFlow(opts: { piece?: Record<string, unknown>; companies?: unknown[]; formats?: unknown[]; rpcError?: string } = {}) {
  const updates: { table: string; patch: unknown }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const rows: Record<string, unknown[]> = {
    companies: opts.companies ?? [{ id: "c1", name: "Acme" }],
    formats: opts.formats ?? [{ id: "f1", company_id: "c1", name: "Blog post", description: "" }],
  };
  const piece = { id: ID, code: "SI-0099", title: "T", stage: "contract", company_id: "c1", recipe: { contract: { mode: "full" } }, ...opts.piece };
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain, ilike: chain, order: chain,
        maybeSingle: async () => ({ data: table === "pieces" ? piece : null, error: null }),
        then: (res: (v: unknown) => void) => res({ data: rows[table] ?? [], error: null }),
        update: (patch: unknown) => { updates.push({ table, patch }); return { eq: () => ({ select: async () => ({ data: [{ piece_id: ID }], error: null }) }) }; },
      });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "confirm_contract" && !opts.rpcError) piece.stage = "research";
      return opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: ID, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, updates, rpcs };
}

describe("startPiece", () => {
  it("creates the piece through create_piece with the single company and a named format", async () => {
    const { db, rpcs } = fakeFlow();
    const r = await startPiece(db, { title: " My piece ", topic: "Topic", format: "blog post" });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].fn).toBe("create_piece");
    expect(rpcs[0].args).toMatchObject({ target_company: "c1", piece_title: "My piece", piece_topic: "Topic", format: "f1" });
    expect(r).toMatchObject({ code: "SI-0099", stage: "contract", scope_step_open: true, max_scope_points: 7 });
  });
  it("asks which company when there are several, and rejects an unknown format or empty fields", async () => {
    const two = fakeFlow({ companies: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }] }).db;
    await expect(startPiece(two, { title: "T", topic: "x" })).rejects.toThrow(/which company/i);
    await expect(startPiece(fakeFlow().db, { title: "T", topic: "x", format: "nope" })).rejects.toThrow(/format/i);
    await expect(startPiece(fakeFlow().db, { title: "  ", topic: "x" })).rejects.toThrow(WritError);
    await expect(startPiece(fakeFlow().db, { title: "T", topic: " " })).rejects.toThrow(/topic/i);
  });
  it("reports a clear error when Writ refuses", async () => {
    await expect(startPiece(fakeFlow({ rpcError: "not a member of this company" }).db, { title: "T", topic: "x" })).rejects.toThrow(/not a member/);
  });
});

describe("saveScope and confirmScope", () => {
  it("saves the question and points with generated ids", async () => {
    const { db, updates } = fakeFlow();
    const r = await saveScope(db, "SI-0099", " Why? ", ["One", " Two ", ""]);
    expect(r.points).toEqual(["One", "Two"]);
    const patch = updates[0].patch as { core_question: string; expectations: { id: string; text: string }[] };
    expect(patch.core_question).toBe("Why?");
    expect(patch.expectations.map((e) => e.text)).toEqual(["One", "Two"]);
    expect(new Set(patch.expectations.map((e) => e.id)).size).toBe(2);
  });
  it("enforces the point limit for the format, and only while the scope is open", async () => {
    const lite = fakeFlow({ piece: { recipe: { contract: { mode: "lite" } } } }).db;
    await expect(saveScope(lite, "SI-0099", "Q?", ["a", "b", "c"])).rejects.toThrow(/1 to 2/);
    await expect(saveScope(fakeFlow().db, "SI-0099", "Q?", Array(8).fill("p"))).rejects.toThrow(/1 to 7/);
    await expect(saveScope(fakeFlow().db, "SI-0099", " ", ["a"])).rejects.toThrow(/question/);
    await expect(saveScope(fakeFlow().db, "SI-0099", "Q?", [])).rejects.toThrow(/points/);
    await expect(saveScope(fakeFlow({ piece: { stage: "research" } }).db, "SI-0099", "Q?", ["a"])).rejects.toThrow(/not open/);
  });
  it("confirms through confirm_contract and reports the new stage, or Writ's own refusal", async () => {
    const ok = fakeFlow();
    const r = await confirmScope(ok.db, "SI-0099");
    expect(ok.rpcs[0]).toEqual({ fn: "confirm_contract", args: { target_piece: ID } });
    expect(r).toMatchObject({ confirmed: true, stage: "research" });
    await expect(confirmScope(fakeFlow({ rpcError: "add the core question first" }).db, "SI-0099")).rejects.toThrow(/core question/);
  });
  it("refuses to confirm when the scope step is not open, without calling Writ", async () => {
    const past = fakeFlow({ piece: { stage: "outline" } });
    await expect(confirmScope(past.db, "SI-0099")).rejects.toThrow(/not open/);
    expect(past.rpcs).toHaveLength(0);
  });
});

describe("startPiece details", () => {
  it("sends empty strings, not nulls, for the optional text fields, and null for no format", async () => {
    const { db, rpcs } = fakeFlow();
    await startPiece(db, { title: "T", topic: "x" });
    expect(rpcs[0].args).toMatchObject({ keyword: "", piece_goal: "", audience: "", timing: "", format: null });
  });
  it("finds the company by name or id, and reports a scope step that the format skips", async () => {
    const two = [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }];
    const byName = fakeFlow({ companies: two, formats: [] });
    await startPiece(byName.db, { title: "T", topic: "x", company: "beta" });
    expect(byName.rpcs[0].args.target_company).toBe("c2");
    const byId = fakeFlow({ companies: two, formats: [] });
    await startPiece(byId.db, { title: "T", topic: "x", company: "c1" });
    expect(byId.rpcs[0].args.target_company).toBe("c1");
    const skipped = await startPiece(fakeFlow({ piece: { stage: "research" } }).db, { title: "T", topic: "x" });
    expect(skipped.scope_step_open).toBe(false);
  });
  it("refuses a blank format, an ambiguous format name, and a format from another company", async () => {
    await expect(startPiece(fakeFlow().db, { title: "T", topic: "x", format: "  " })).rejects.toThrow(/blank/);
    const dup = fakeFlow({ formats: [
      { id: "f1", company_id: "c1", name: "Blog", description: "" },
      { id: "f2", company_id: "c1", name: "blog", description: "" },
    ] });
    await expect(startPiece(dup.db, { title: "T", topic: "x", format: "Blog" })).rejects.toThrow(/More than one/);
    const other = fakeFlow({ formats: [{ id: "f9", company_id: "c2", name: "Elsewhere", description: "" }] });
    await expect(startPiece(other.db, { title: "T", topic: "x", format: "f9" })).rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Research, outline and section preparation
// ---------------------------------------------------------------------------------------------------------------------

const SEC = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const R2 = "55555555-5555-4555-8555-555555555555";

interface WriteOpts {
  piece?: Record<string, unknown>;
  contract?: unknown;
  section?: Record<string, unknown>;
  sections?: unknown[];
  research?: unknown[];
  rpc?: (fn: string, args: Record<string, unknown>, state: { section: Record<string, unknown>; piece: Record<string, unknown> }) => { data?: unknown; error?: { message: string; code?: string } } | undefined;
  updateMiss?: boolean;
}

/** A stand-in with the tables the research, outline and preparation functions read, and a scriptable rpc. */
function fakeWrite(opts: WriteOpts = {}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const piece: Record<string, unknown> = { id: ID, code: "SI-0099", title: "T", stage: "writing", company_id: "c1", recipe: {}, ...opts.piece };
  const section: Record<string, unknown> = { id: SEC, piece_id: ID, heading: "Why it matters", status: "research", ...opts.section };
  const state = { piece, section };
  const research = opts.research ?? [{ id: R1, statement: "s1", source_type: "web", sources: { title: "T1", url: "https://a.example" } }, { id: R2, statement: "s2", source_type: "data", sources: { title: "T2", url: "https://b.example" } }];
  const contract = opts.contract ?? { expectations: [{ id: "e1", text: "First" }, { id: "e2", text: "Second" }] };
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain, ilike: chain, order: chain, in: chain,
        maybeSingle: async () => ({ data: table === "pieces" ? piece : table === "piece_contracts" ? contract : table === "piece_sections" ? section : null, error: null }),
        then: (res: (v: unknown) => void) => res({ data: table === "piece_sections" ? (opts.sections ?? [{ id: SEC, position: 1, heading: "H", purpose: "" }]) : research, error: null }),
        update: (patch: Record<string, unknown>) => {
          updates.push({ table, patch });
          const u: Record<string, unknown> = { eq: () => u, select: async () => ({ data: opts.updateMiss ? [] : [{ id: SEC }], error: null }) };
          return u;
        },
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "card1" }, error: null }) }) };
        },
      });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return opts.rpc?.(fn, args, state) ?? { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  } as unknown as SupabaseClient;
  return { db, updates, inserts, rpcs, state };
}

const finding = { url: "https://a.example/x", statement: "A fact", source_type: "web" };

describe("addResearch", () => {
  it("passes the findings to add_research_findings and notes that quotes are unchecked", async () => {
    const { db, rpcs } = fakeWrite({ piece: { stage: "research" }, rpc: () => ({ data: { added: 1, new_sources: 1, item_ids: [R1] } }) });
    const r = await addResearch(db, "SI-0099", [finding], undefined, false);
    expect(rpcs[0]).toEqual({ fn: "add_research_findings", args: { target_piece: ID, findings: [finding], target_section: null, auto: false, gap_search: false } });
    expect(r).toMatchObject({ added: 1 });
    expect(String((r as { note: string }).note)).toMatch(/not checked/);
  });
  it("explains that the database change is missing when the function does not exist", async () => {
    const { db } = fakeWrite({ rpc: () => ({ error: { code: "PGRST202", message: "Could not find the function public.add_research_findings" } }) });
    await expect(addResearch(db, "SI-0099", [finding])).rejects.toThrow(/20261127000000_add_research_findings/);
  });
  it("passes on Writ's own refusal", async () => {
    const { db } = fakeWrite({ rpc: () => ({ error: { message: "confirm the reader contract before researching" } }) });
    await expect(addResearch(db, "SI-0099", [finding])).rejects.toThrow(/reader contract/);
  });
});

describe("reviewResearch, completeResearch and useResearch", () => {
  it("records each decision through review_item and stops at the first refusal", async () => {
    const ok = fakeWrite();
    const r = await reviewResearch(ok.db, [{ item: R1, decision: "approved" }, { item: R2, decision: "rejected", statement: " Better " }]);
    expect(r).toEqual({ decided: 2 });
    expect(ok.rpcs[1]).toEqual({ fn: "review_item", args: { item: R2, decision: "rejected", new_statement: "Better" } });
    const stop = fakeWrite({ rpc: (_fn, a) => (a.item === R2 ? { error: { message: "item not found" } } : undefined) });
    await expect(reviewResearch(stop.db, [{ item: R1, decision: "approved" }, { item: R2, decision: "approved" }])).rejects.toThrow(/1 earlier decisions were saved/);
    await expect(reviewResearch(fakeWrite().db, [{ item: "nope", decision: "approved" }])).rejects.toThrow(/not a research item id/);
  });
  it("finishes research only while it is open, through complete_piece_research", async () => {
    const ok = fakeWrite({ piece: { stage: "research" }, rpc: (fn, _a, s) => { if (fn === "complete_piece_research") s.piece.stage = "outline"; return undefined; } });
    expect(await completeResearch(ok.db, "SI-0099")).toMatchObject({ completed: true, stage: "outline" });
    const late = fakeWrite({ piece: { stage: "outline" } });
    await expect(completeResearch(late.db, "SI-0099")).rejects.toThrow(/not open/);
    expect(late.rpcs).toHaveLength(0);
  });
  it("copies each approved item into the section with use_piece_item", async () => {
    const { db, rpcs } = fakeWrite();
    expect(await useResearch(db, SEC, [R1, R2])).toEqual({ added: 2 });
    expect(rpcs.map((r) => r.fn)).toEqual(["use_piece_item", "use_piece_item"]);
    await expect(useResearch(db, "bad", [R1])).rejects.toThrow(/section_id/);
  });
});

describe("saveOutline and confirmOutline", () => {
  it("maps the scope point numbers to the scope's ids and reports points no section serves", async () => {
    const { db, rpcs } = fakeWrite({ piece: { stage: "outline" } });
    const r = await saveOutline(db, "SI-0099", [{ heading: " One ", purpose: "p", covers: [1] }, { heading: "Two", id: SEC }]);
    expect(rpcs[0].fn).toBe("save_outline");
    expect(rpcs[0].args.sections).toEqual([
      { heading: "One", purpose: "p", expectation_ids: ["e1"] },
      { id: SEC, heading: "Two", purpose: "", expectation_ids: [] },
    ]);
    expect(r.scope_points_not_covered).toEqual([{ n: 2, text: "Second" }]);
    expect(r.confirmed).toBe(false);
  });
  it("refuses a bad point number, too many or no sections, and an outline that is not open", async () => {
    const open = fakeWrite({ piece: { stage: "outline" } }).db;
    await expect(saveOutline(open, "SI-0099", [{ heading: "A", covers: [3] }])).rejects.toThrow(/1 to 2/);
    await expect(saveOutline(open, "SI-0099", [])).rejects.toThrow(/1 to 12/);
    await expect(saveOutline(open, "SI-0099", Array.from({ length: 13 }, (_, i) => ({ heading: `S${i}` })))).rejects.toThrow(/1 to 12/);
    await expect(saveOutline(open, "SI-0099", [{ heading: " " }])).rejects.toThrow(/heading/);
    await expect(saveOutline(fakeWrite({ piece: { stage: "writing" } }).db, "SI-0099", [{ heading: "A" }])).rejects.toThrow(/not open/);
  });
  it("confirms through confirm_outline only while the outline is open", async () => {
    const ok = fakeWrite({ piece: { stage: "outline" }, rpc: (fn, _a, s) => { if (fn === "confirm_outline") s.piece.stage = "writing"; return undefined; } });
    expect(await confirmOutline(ok.db, "SI-0099")).toMatchObject({ confirmed: true, stage: "writing" });
    const late = fakeWrite({ piece: { stage: "writing" } });
    await expect(confirmOutline(late.db, "SI-0099")).rejects.toThrow(/not open/);
    expect(late.rpcs).toHaveLength(0);
    await expect(confirmOutline(fakeWrite({ piece: { stage: "outline" }, rpc: () => ({ error: { message: "add at least one section" } }) }).db, "SI-0099")).rejects.toThrow(/at least one section/);
  });
});

describe("saveSectionPoints", () => {
  const pts = [{ point: "Make the case", direction: "Use the data", evidence: "Figure from T2", refs: [2] }, { point: "Own view" }];
  it("saves points with research ids, finishes the section's research, confirms the brief and reports it ready", async () => {
    const { db, updates, rpcs } = fakeWrite({
      rpc: (fn, _a, s) => { if (fn === "complete_section_research") s.section.status = "brief"; return undefined; },
    });
    const r = await saveSectionPoints(db, SEC, pts);
    const saved = (updates[0].patch.points as { points: { point: string; refs: string[] }[] }).points;
    expect(saved.map((p) => p.refs)).toEqual([[R2], []]);
    expect(rpcs.map((x) => x.fn)).toEqual(["complete_section_research", "confirm_brief"]);
    expect(rpcs[1].args.bullets).toEqual([{ text: "Make the case: Use the data", refs: [R2] }, { text: "Own view", refs: [] }]);
    expect(r).toMatchObject({ saved: true, points: 2, status: "writing", ready_to_draft: true });
  });
  it("refreshes the brief when points are re-saved on a section already in writing, without a research call", async () => {
    const { db, rpcs } = fakeWrite({ section: { status: "writing" } });
    expect(await saveSectionPoints(db, SEC, pts)).toMatchObject({ ready_to_draft: true });
    expect(rpcs.map((x) => x.fn)).toEqual(["confirm_brief"]);
  });
  it("sets the brief too when the format skips the brief step (research finishes straight into writing)", async () => {
    const { db, rpcs } = fakeWrite({ rpc: (fn, _a, st) => { if (fn === "complete_section_research") st.section.status = "writing"; return undefined; } });
    await saveSectionPoints(db, SEC, pts);
    expect(rpcs.map((x) => x.fn)).toEqual(["complete_section_research", "confirm_brief"]);
  });
  it("refuses unknown research numbers, written sections, an unconfirmed outline, and bad input", async () => {
    await expect(saveSectionPoints(fakeWrite().db, SEC, [{ point: "x", refs: [9] }])).rejects.toThrow(/\[9\]/);
    await expect(saveSectionPoints(fakeWrite({ section: { status: "written" } }).db, SEC, pts)).rejects.toThrow(/already marked as written/);
    await expect(saveSectionPoints(fakeWrite({ piece: { stage: "outline" } }).db, SEC, pts)).rejects.toThrow(/outline must be confirmed/);
    await expect(saveSectionPoints(fakeWrite().db, SEC, [])).rejects.toThrow(/1 to 12/);
    await expect(saveSectionPoints(fakeWrite().db, SEC, [{ point: "  " }])).rejects.toThrow(/needs text/);
    await expect(saveSectionPoints(fakeWrite().db, "bad", pts)).rejects.toThrow(/section_id/);
  });
  it("tells the writer when the points are saved but the section's research is not finished", async () => {
    const { db } = fakeWrite({ rpc: (fn) => (fn === "complete_section_research" ? { error: { message: "2 items still need a decision" } } : undefined) });
    await expect(saveSectionPoints(db, SEC, pts)).rejects.toThrow(/Points saved, but .* 2 items still need a decision/);
  });
});

describe("getResearch", () => {
  it("numbers the items and flattens the source", async () => {
    const { db } = fakeWrite();
    const r = await getResearch(db, "SI-0099");
    expect(r.items.map((i) => [i.n, i.id, i.url])).toEqual([[1, R1, "https://a.example"], [2, R2, "https://b.example"]]);
  });
});

describe("review-driven fixes", () => {
  it("keeps a kept section's planned structure when the outline is saved again", async () => {
    const structure = [{ type: "answer" }];
    const { db, rpcs } = fakeWrite({ piece: { stage: "outline" }, sections: [{ id: SEC, position: 1, heading: "H", purpose: "", structure }] });
    await saveOutline(db, "SI-0099", [{ heading: "Kept", id: SEC }, { heading: "New" }]);
    const sent = rpcs[0].args.sections as Record<string, unknown>[];
    expect(sent[0]).toMatchObject({ id: SEC, structure });
    expect(sent[1]).not.toHaveProperty("structure");
  });
  it("saves an outline even if the scope row is missing", async () => {
    const { db } = fakeWrite({ piece: { stage: "outline" }, contract: null });
    const r = await saveOutline(db, "SI-0099", [{ heading: "A" }]);
    expect(r.saved).toBe(true);
  });
  it("reports how many research items Writ approved by itself, and says so", async () => {
    const auto = fakeWrite({ research: [{ id: R1, status: "approved" }, { id: R2, status: "approved" }], rpc: () => ({ data: { added: 2, item_ids: [R1, R2] } }) });
    const r = await addResearch(auto.db, "SI-0099", [finding, finding]);
    expect(r).toMatchObject({ auto_approved: 2 });
    expect(String((r as { note: string }).note)).toMatch(/approved automatically/);
    const manual = fakeWrite({ research: [{ id: R1, status: "unreviewed" }], rpc: () => ({ data: { added: 1, item_ids: [R1] } }) });
    expect(await addResearch(manual.db, "SI-0099", [finding])).toMatchObject({ auto_approved: 0 });
  });
  it("rejects a section id that is not an id, and explains a missing scope when research is refused", async () => {
    await expect(addResearch(fakeWrite().db, "SI-0099", [finding], "nope")).rejects.toThrow(/section_id/);
    const refused = fakeWrite({ rpc: () => ({ error: { message: "confirm the reader contract before researching" } }) });
    await expect(addResearch(refused.db, "SI-0099", [finding])).rejects.toThrow(/skips the scope step/);
  });
  it("gives each approved section item the cite number writ_get_section would show", async () => {
    const { db } = fakeWrite({ research: [
      { id: R1, status: "rejected", statement: "a", sources: null },
      { id: R2, status: "approved", statement: "b", sources: null },
      { id: SEC, status: "approved", statement: "c", sources: null },
    ] });
    const r = await getResearch(db, "SI-0099", SEC);
    expect(r.items.map((i) => i.cite)).toEqual([null, 1, 2]);
    expect((await getResearch(db, "SI-0099")).items.every((i) => i.cite === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// First-user onboarding: setup status, company creation, house-file documents
// ---------------------------------------------------------------------------------------------------------------------

interface SetupOpts {
  companies?: unknown[];
  formats?: unknown[];
  docs?: unknown[];
  pieces?: unknown[];
  docRow?: unknown;
  proposals?: unknown[];
  stale?: boolean;
  insertError?: string;
  rpcError?: string;
}

/** A stand-in for the setup tables, recording updates and rpc calls, with a signed-in user. */
function fakeSetup(opts: SetupOpts = {}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const rows: Record<string, unknown[]> = {
    companies: opts.companies ?? [{ id: "c1", name: "Acme" }],
    formats: opts.formats ?? [],
    context_documents: opts.docs ?? [],
    pieces: opts.pieces ?? [],
    document_proposals: opts.proposals ?? [],
  };
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain, is: chain, order: chain,
        maybeSingle: async () => ({ data: table === "context_documents" ? (opts.docRow ?? null) : null, error: null }),
        then: (res: (v: unknown) => void) => res({ data: rows[table] ?? [], error: null }),
        update: (patch: Record<string, unknown>) => {
          updates.push({ table, patch });
          const u: Record<string, unknown> = { eq: () => u, select: async () => ({ data: opts.stale ? [] : [{ id: "d1" }], error: null }) };
          return u;
        },
        insert: (newRows: Record<string, unknown>[]) => {
          inserts.push({ table, rows: newRows });
          return { select: async () => (opts.insertError ? { data: null, error: { message: opts.insertError } } : { data: newRows.map((_, i) => ({ id: "n" + i })), error: null }) };
        },
      });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: "new-company-id", error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  } as unknown as SupabaseClient;
  return { db, updates, inserts, rpcs };
}

describe("getSetup", () => {
  it("is empty for a brand-new writer", async () => {
    expect(await getSetup(fakeSetup({ companies: [] }).db)).toEqual([]);
  });
  it("reports which house-file documents are filled, readiness, piece count and format profiles", async () => {
    const { db } = fakeSetup({
      formats: [{ id: "f1", company_id: "c1", name: "Blog", description: "d" }],
      docs: [
        { company_id: "c1", kind: "icp", format_id: null, content: "Who we sell to\n- CFOs" },
        { company_id: "c1", kind: "core_voice", format_id: null, content: "   " },
        { company_id: "c1", kind: "positioning", format_id: null, content: "" },
        { company_id: "c1", kind: "format_profile", format_id: "f1", content: "Short openings" },
        { company_id: "c2", kind: "core_voice", format_id: null, content: "someone else's" },
      ],
      pieces: [{ company_id: "c1" }, { company_id: "c1" }, { company_id: "c2" }],
    });
    const [co] = await getSetup(db);
    expect(co.house_file.icp).toEqual({ exists: true, filled: true, words: 6 });
    expect(co.house_file.core_voice).toMatchObject({ exists: true, filled: false, words: 0 });
    expect(co.house_file.strategy_notes).toEqual({ exists: false, filled: false, words: 0 });
    expect(co.house_file_ready).toBe(false);
    expect(co.pieces).toBe(2);
    expect(co.formats).toHaveLength(1);
    expect(co.formats[0]).toMatchObject({ id: "f1", name: "Blog", description: "d", template_key: null, style_profile_filled: true });
    expect(co.formats[0].workflow).toMatchObject({ scope: "full", outline: "free", ai_drafts: true });
  });
  it("is ready once ICP, core voice and positioning are filled, whatever strategy notes hold", async () => {
    const docs = ["icp", "core_voice", "positioning"].map((kind) => ({ company_id: "c1", kind, format_id: null, content: "text" }));
    const [co] = await getSetup(fakeSetup({ docs }).db);
    expect(co.house_file_ready).toBe(true);
  });
});

describe("createCompany", () => {
  it("creates through create_company with the trimmed name", async () => {
    const { db, rpcs } = fakeSetup({ companies: [] });
    expect(await createCompany(db, "  Northwind Logistics ")).toMatchObject({ created: true, company: "Northwind Logistics", company_id: "new-company-id" });
    expect(rpcs).toEqual([{ fn: "create_company", args: { company_name: "Northwind Logistics" } }]);
  });
  it("refuses a duplicate name, a too-short or too-long name, and passes on Writ's refusal", async () => {
    const dup = fakeSetup();
    await expect(createCompany(dup.db, "acme")).rejects.toThrow(/already have a company/);
    expect(dup.rpcs).toHaveLength(0);
    await expect(createCompany(fakeSetup({ companies: [] }).db, "A")).rejects.toThrow(/2 to 120/);
    await expect(createCompany(fakeSetup({ companies: [] }).db, "x".repeat(121))).rejects.toThrow(/2 to 120/);
    await expect(createCompany(fakeSetup({ companies: [], rpcError: "not signed in" }).db, "Acme Two")).rejects.toThrow(/not signed in/);
  });
});

describe("saveContextDocument and getContextDocuments", () => {
  it("saves into an empty document, recording who updated it", async () => {
    const { db, updates } = fakeSetup({ docRow: { id: "d1", content: "", version: 1 } });
    const r = await saveContextDocument(db, { kind: "icp", content: " ## Who we sell to\n- CFOs " });
    expect(r).toMatchObject({ saved: true, company: "Acme", kind: "icp", replaced: false, words: 7 });
    expect(updates[0]).toEqual({ table: "context_documents", patch: { content: "## Who we sell to\n- CFOs", updated_by: "u1" } });
  });
  it("never replaces existing text unless told to, and says how much is there", async () => {
    const { db, updates } = fakeSetup({ docRow: { id: "d1", content: "one two three", version: 1 } });
    await expect(saveContextDocument(db, { kind: "core_voice", content: "new" })).rejects.toThrow(/already has 3 words/);
    expect(updates).toHaveLength(0);
    const r = await saveContextDocument(db, { kind: "core_voice", content: "new", replace: true });
    expect(r).toMatchObject({ saved: true, replaced: true });
    expect(updates).toHaveLength(1);
  });
  it("refuses a bad kind (format profiles are set in the web app), empty or oversized text, and a missing row", async () => {
    const ok = fakeSetup({ docRow: { id: "d1", content: "", version: 1 } }).db;
    await expect(saveContextDocument(ok, { kind: "format_profile", content: "x" })).rejects.toThrow(/kind must be/);
    await expect(saveContextDocument(ok, { kind: "icp", content: "  " })).rejects.toThrow(/empty/);
    await expect(saveContextDocument(ok, { kind: "icp", content: "x".repeat(60001) })).rejects.toThrow(/too long/);
    await expect(saveContextDocument(fakeSetup().db, { kind: "icp", content: "x" })).rejects.toThrow(/not found/);
  });
  it("asks which company when there are several, and works with a named one", async () => {
    const two = { companies: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }], docRow: { id: "d1", content: "", version: 1 } };
    await expect(saveContextDocument(fakeSetup(two).db, { kind: "icp", content: "x" })).rejects.toThrow(/which company/i);
    const r = await saveContextDocument(fakeSetup(two).db, { kind: "icp", content: "x", company: "beta" });
    expect(r.company).toBe("Beta");
  });
  it("lists all four documents with their state", async () => {
    const { db } = fakeSetup({ docs: [{ company_id: "c1", kind: "icp", format_id: null, content: "text here" }] });
    const r = await getContextDocuments(db);
    expect(r.documents.map((d) => d.kind)).toEqual(["icp", "core_voice", "positioning", "strategy_notes"]);
  });
});

describe("saveContextDocument safeguards", () => {
  it("leaves a document alone while the writer has changes waiting for review in the web app", async () => {
    const { db, updates } = fakeSetup({ docRow: { id: "d1", content: "", version: 1 }, proposals: [{ id: "p1" }] });
    await expect(saveContextDocument(db, { kind: "icp", content: "x" })).rejects.toThrow(/waiting for the writer's review/);
    expect(updates).toHaveLength(0);
  });
  it("does not overwrite an edit made after the document was read", async () => {
    const { db } = fakeSetup({ docRow: { id: "d1", content: "", version: 3 }, stale: true });
    await expect(saveContextDocument(db, { kind: "icp", content: "x" })).rejects.toThrow(/changed while you were working/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Standard formats, workflow summaries, draft revisions, extra brief fields
// ---------------------------------------------------------------------------------------------------------------------

describe("FORMAT_PRESETS (generated from the app)", () => {
  type Flat = Record<string, unknown>;
  const flat = (o: Flat, p = ""): [string, unknown][] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v as Flat, p + k + ".") : [[p + k, v] as [string, unknown]]));
  const blog = FORMAT_PRESETS.find((p) => p.key === "longform_blog")!;
  // Settings that make a format itself, not a step of the workflow.
  const FORMAT_OWN = /^(base|brief\.customer|brief\.offer|checks\.customer_approval|signoff\..*|outline\.mode|outline\.template)$/;

  it("has the standard formats with unique keys", () => {
    expect(FORMAT_PRESETS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(FORMAT_PRESETS.map((p) => p.key)).size).toBe(FORMAT_PRESETS.length);
    for (const p of FORMAT_PRESETS) expect(p.name.length, p.key).toBeGreaterThan(0);
  });
  it("gives every format the full blog workflow: every step the blog has on is on", () => {
    const blogOn = flat(blog.recipe).filter(([k, v]) => v === true && !FORMAT_OWN.test(k)).map(([k]) => k);
    expect(blogOn).toEqual(expect.arrayContaining(["research.web_search", "research.serp", "analysis.enabled", "analysis.gaps", "outline.seo_geo_check", "sections.research", "checks.grammar", "checks.fact", "checks.contract", "checks.seo", "checks.geo"]));
    for (const p of FORMAT_PRESETS) {
      const mine = Object.fromEntries(flat(p.recipe));
      const fixed = (p.recipe as { outline: { mode: string } }).outline.mode === "fixed";
      // the app's own rule: outline suggestions need a free outline, so a fixed outline cannot have them
      const off = blogOn.filter((k) => mine[k] !== true && !(fixed && k === "outline.ai_thread"));
      expect(off, p.key + " has blog steps switched off").toEqual([]);
      expect((p.recipe as { contract: { mode: string } }).contract.mode, p.key + " scope").toBe("full");
    }
  });
  it("keeps a fixed outline's sections for the formats that have them, and a free outline for the rest", () => {
    for (const p of FORMAT_PRESETS) {
      const o = (p.recipe as { outline: { mode: string; template: string[]; ai_thread: boolean } }).outline;
      expect(["fixed", "free"], p.key).toContain(o.mode);
      if (o.mode === "fixed") { expect(o.template.length, p.key).toBeGreaterThan(0); expect(o.ai_thread, p.key).toBe(false); }
      else expect(o.template, p.key).toEqual([]);
    }
    expect(FORMAT_PRESETS.filter((p) => (p.recipe as { outline: { mode: string } }).outline.mode === "fixed").map((p) => p.key).sort())
      .toEqual(["case_study", "instagram_carousel", "linkedin_carousel", "short_video_script", "video_script", "webinar_outline", "x_thread"]);
  });
});

describe("workflowOf", () => {
  it("summarises scope size, outline kind, research and what the brief asks for", () => {
    expect(workflowOf(null)).toMatchObject({ scope: "full", research: { web_search: true, review: true, serp: false }, outline: "free", brief_asks_for: [], ai_drafts: true, gap_analysis: { on: false }, checks: { grammar: false } });
    const w = workflowOf({
      brief: { goal: true, customer: true, offer: false }, contract: { mode: "lite" }, research: { web_search: false, review: false },
      outline: { mode: "fixed", template: ["Hook", "Point"] }, writing: { ai_draft: false },
    });
    expect(w).toMatchObject({ scope: "lite", research: { web_search: false, review: false }, outline: "fixed", fixed_sections: ["Hook", "Point"], brief_asks_for: ["goal", "customer"], ai_drafts: false });
  });
});

describe("addFormats", () => {
  it("adds every standard format to a company that has none, with its recipe", async () => {
    const { db, inserts } = fakeSetup({ formats: [] });
    const r = await addFormats(db, {});
    expect(r.added).toHaveLength(FORMAT_PRESETS.length);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("formats");
    expect(inserts[0].rows[0]).toMatchObject({ company_id: "c1", template_key: FORMAT_PRESETS[0].key, name: FORMAT_PRESETS[0].name });
    expect(inserts[0].rows[0].recipe).toEqual(FORMAT_PRESETS[0].recipe);
  });
  it("leaves formats the company already has alone (same template or same name) and adds nothing if all exist", async () => {
    const have = [
      { id: "f1", company_id: "c1", name: "Custom name", description: "", template_key: FORMAT_PRESETS[0].key },
      { id: "f2", company_id: "c1", name: FORMAT_PRESETS[1].name.toUpperCase(), description: "", template_key: null },
    ];
    const some = fakeSetup({ formats: have });
    const r = await addFormats(some.db, {});
    expect(r.already_there).toEqual([FORMAT_PRESETS[0].name, FORMAT_PRESETS[1].name]);
    expect(r.added).toHaveLength(FORMAT_PRESETS.length - 2);
    const all = fakeSetup({ formats: FORMAT_PRESETS.map((p, i) => ({ id: "f" + i, company_id: "c1", name: p.name, description: "", template_key: p.key })) });
    const none = await addFormats(all.db, {});
    expect(none.added).toEqual([]);
    expect(all.inserts).toHaveLength(0);
  });
  it("adds only the named templates, rejects unknown ones, needs a company name when there are several, and passes on errors", async () => {
    const one = fakeSetup();
    const r = await addFormats(one.db, { templates: [FORMAT_PRESETS[2].key] });
    expect(r.added).toEqual([FORMAT_PRESETS[2].name]);
    await expect(addFormats(fakeSetup().db, { templates: ["nope"] })).rejects.toThrow(/Unknown formats: nope/);
    const two = { companies: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }] };
    await expect(addFormats(fakeSetup(two).db, {})).rejects.toThrow(/which company/i);
    await expect(addFormats(fakeSetup({ insertError: "permission denied" }).db, {})).rejects.toThrow(/permission denied/);
  });
});

describe("draft revisions", () => {
  it("replaces the section text with a revision while the text is still the last AI draft", async () => {
    const { db, updates } = fake({ ...base, content: "First draft\n", ai_draft: "First draft" });
    const r = await saveSectionDraft(db, ID, "Second draft");
    expect(r.became_section_text).toBe(true);
    expect(updates).toEqual([{ ai_draft: "Second draft", content: "Second draft" }]);
  });
  it("keeps text the writer has edited, saving the revision beside it as the AI draft", async () => {
    const { db, updates } = fake({ ...base, content: "First draft, edited by me", ai_draft: "First draft" });
    const r = await saveSectionDraft(db, ID, "Second draft");
    expect(r.became_section_text).toBe(false);
    expect(updates).toEqual([{ ai_draft: "Second draft" }]);
  });
});

describe("startPiece extra brief fields", () => {
  it("sends only the extra fields that were given", async () => {
    const { db, rpcs } = fakeFlow();
    await startPiece(db, { title: "T", topic: "x", customer: " Globex ", approval_contact: "", offer: "  ", cta: "Book a demo" });
    expect(rpcs[0].args.extra).toEqual({ customer: "Globex", cta: "Book a demo" });
    const none = fakeFlow();
    await startPiece(none.db, { title: "T", topic: "x" });
    expect(none.rpcs[0].args.extra).toEqual({});
  });
  it("returns the format's workflow so the conversation can adapt", async () => {
    const r = await startPiece(fakeFlow({ piece: { recipe: { contract: { mode: "lite" }, outline: { mode: "fixed", template: ["A"] } } } }).db, { title: "T", topic: "x" });
    expect(r.workflow).toMatchObject({ scope: "lite", outline: "fixed", fixed_sections: ["A"] });
    expect(r.max_scope_points).toBe(2);
  });
});

describe("review fixes", () => {
  it("keeps the writer's text when it changes between the read and the write, and still saves the AI draft", async () => {
    const { db, updates } = fake({ ...base, content: "First draft", ai_draft: "First draft" }, undefined, { conflict: true });
    const r = await saveSectionDraft(db, ID, "Second draft");
    expect(r.became_section_text).toBe(false);
    expect(updates).toEqual([{ ai_draft: "Second draft", content: "Second draft" }, { ai_draft: "Second draft" }]);
  });
  it("treats empty text with an old AI draft as empty, and text reverted to the AI draft as untouched", async () => {
    const empty = fake({ ...base, content: "  ", ai_draft: "Old" });
    expect((await saveSectionDraft(empty.db, ID, "New")).became_section_text).toBe(true);
    const reverted = fake({ ...base, content: "Old", ai_draft: "Old" });
    expect((await saveSectionDraft(reverted.db, ID, "New")).became_section_text).toBe(true);
    const unrelated = fake({ ...base, content: "Something else", ai_draft: "" });
    expect((await saveSectionDraft(unrelated.db, ID, "New")).became_section_text).toBe(false);
  });
  it("ignores covers when the format has no scope points", async () => {
    const { db, rpcs } = fakeWrite({ piece: { stage: "outline" }, contract: { expectations: [] } });
    const r = await saveOutline(db, "SI-0099", [{ heading: "A", covers: [1] }]);
    expect(r.saved).toBe(true);
    expect((rpcs[0].args.sections as { expectation_ids: string[] }[])[0].expectation_ids).toEqual([]);
  });
  it("says when a fixed outline's sections were changed, and not when they were kept", async () => {
    const recipe = { outline: { mode: "fixed", template: ["Hook", "Point"] } };
    const kept = fakeWrite({ piece: { stage: "outline", recipe } });
    expect(await saveOutline(kept.db, "SI-0099", [{ heading: "Hook" }, { heading: "Point" }])).not.toHaveProperty("differs_from_fixed_outline");
    const changed = fakeWrite({ piece: { stage: "outline", recipe } });
    expect(await saveOutline(changed.db, "SI-0099", [{ heading: "Hook" }])).toMatchObject({ differs_from_fixed_outline: true, fixed_outline: ["Hook", "Point"] });
    const free = fakeWrite({ piece: { stage: "outline", recipe: { outline: { mode: "free", template: [] } } } });
    expect(await saveOutline(free.db, "SI-0099", [{ heading: "Anything" }])).not.toHaveProperty("differs_from_fixed_outline");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Gap analysis, expert answers, outline check, section and final checks
// ---------------------------------------------------------------------------------------------------------------------

const FULL = FORMAT_PRESETS.find((p) => p.key === "longform_blog")!.recipe;
const OFF = { ...FULL, analysis: { enabled: false, gaps: false, contract_suggestions: false }, checks: { grammar: false, fact: false, contract: false, seo: false, geo: false }, outline: { ...(FULL as { outline: object }).outline, seo_geo_check: false } };
const CONTRACT = { core_question: "Why?", expectations: [{ id: "e1", text: "First" }, { id: "e2", text: "Second" }] };
const ITEMS = [
  { id: R1, statement: "Fact one", source_type: "web", sources: { title: "T1", url: "https://a.example" } },
  { id: R2, statement: "Fact two", source_type: "data", sources: { title: "T2", url: "https://b.example" } },
];

describe("gap analysis", () => {
  it("reads the scope points and approved research, numbered, and says what the format uses", async () => {
    const { db } = fakeWrite({ piece: { stage: "outline", recipe: FULL, goal: "g" }, contract: CONTRACT, research: ITEMS });
    const r = await getAnalysisInput(db, "SI-0099");
    expect(r.scope_points).toEqual([{ n: 1, text: "First" }, { n: 2, text: "Second" }]);
    expect(r.approved_research).toEqual([{ n: 1, statement: "Fact one" }, { n: 2, statement: "Fact two" }]);
    expect(r.this_format_uses).toEqual({ gaps: true, scope_suggestions: true });
  });
  it("is refused when the format does not use it or the research is not finished", async () => {
    await expect(getAnalysisInput(fakeWrite({ piece: { stage: "outline", recipe: OFF } }).db, "SI-0099")).rejects.toThrow(/switched off/);
    await expect(getAnalysisInput(fakeWrite({ piece: { stage: "research", recipe: FULL } }).db, "SI-0099")).rejects.toThrow(/once the research is finished/);
  });
  it("saves the analysis with the ids it was run on, and drops what the format does not use", async () => {
    const { db, updates } = fakeWrite({ piece: { stage: "outline", recipe: FULL }, contract: CONTRACT, research: ITEMS });
    const r = await saveAnalysis(db, "SI-0099", {
      verdict: "partly", summary: " Drifted a little. ", drift: [{ text: "Moved to X", items: [2], points: [1] }],
      gaps: [{ text: "No data on Y", expert_question: "What did you see?", points: [2] }], contract_suggestions: [{ change: "Narrow it", why: "Too broad" }],
    });
    expect(r).toMatchObject({ saved: true, verdict: "partly", drift: 1, gaps: 1, scope_suggestions: 1 });
    const a = updates[0].patch.analysis as Record<string, unknown>;
    expect(a).toMatchObject({ alignment: { verdict: "partly", summary: "Drifted a little." }, item_ids: [R1, R2], point_ids: ["e1", "e2"] });
    const noGaps = fakeWrite({ piece: { stage: "outline", recipe: { ...FULL, analysis: { enabled: true, gaps: false, contract_suggestions: false } } }, contract: CONTRACT, research: ITEMS });
    await saveAnalysis(noGaps.db, "SI-0099", { verdict: "aligned", summary: "ok", gaps: [{ text: "g", expert_question: "q" }], contract_suggestions: [{ change: "c", why: "w" }] });
    expect(noGaps.updates[0].patch.analysis).toMatchObject({ gaps: [], contract_suggestions: [] });
  });
  it("rejects more than 4 gaps, numbers out of range, an empty summary and gaps without a question", async () => {
    const mk = () => fakeWrite({ piece: { stage: "outline", recipe: FULL }, contract: CONTRACT, research: ITEMS }).db;
    const g = { text: "g", expert_question: "q" };
    await expect(saveAnalysis(mk(), "SI-0099", { verdict: "partly", summary: "s", gaps: [g, g, g, g, g] })).rejects.toThrow(/at most 4/);
    await expect(saveAnalysis(mk(), "SI-0099", { verdict: "partly", summary: "s", drift: [{ text: "d", items: [3] }] })).rejects.toThrow(/between 1 and 2/);
    await expect(saveAnalysis(mk(), "SI-0099", { verdict: "partly", summary: "  " })).rejects.toThrow(/summary/);
    await expect(saveAnalysis(mk(), "SI-0099", { verdict: "partly", summary: "s", gaps: [{ text: "g", expert_question: " " }] })).rejects.toThrow(/expert could answer/);
  });
  it("records ignore and resolve decisions on findings, and reopens them", async () => {
    const analysis = { alignment: { verdict: "partly", summary: "s" }, drift: [{ text: "d", items: [], points: [] }], gaps: [{ text: "g", expert_question: "q", resolved: true }], contract_suggestions: [{ change: "c", why: "w" }] };
    const { db, updates } = fakeWrite({ piece: { analysis } });
    await markFindings(db, "SI-0099", [{ finding: "gap-0", state: "open" }, { finding: "drift-0", state: "ignored" }, { finding: "suggestion-0", state: "resolved" }]);
    const a = updates[0].patch.analysis as { gaps: Record<string, unknown>[]; drift: Record<string, unknown>[]; contract_suggestions: Record<string, unknown>[] };
    expect(a.gaps[0]).not.toHaveProperty("resolved");
    expect(a.drift[0].ignored).toBe(true);
    expect(a.contract_suggestions[0].resolved).toBe(true);
    await expect(markFindings(fakeWrite({ piece: { analysis } }).db, "SI-0099", [{ finding: "gap-5", state: "ignored" }])).rejects.toThrow(/no gap-5/);
    await expect(markFindings(fakeWrite({ piece: { analysis } }).db, "SI-0099", [{ finding: "nope", state: "ignored" }])).rejects.toThrow(/not a finding id/);
    await expect(markFindings(fakeWrite({ piece: { analysis: null } }).db, "SI-0099", [{ finding: "gap-0", state: "ignored" }])).rejects.toThrow(/no gap analysis/);
  });
  it("applies fixes through apply_alignment_fixes with ids, and marks the findings they close", async () => {
    const analysis = { alignment: { verdict: "partly", summary: "s" }, drift: [], gaps: [{ text: "g", expert_question: "q" }], contract_suggestions: [] };
    const { db, rpcs, updates } = fakeWrite({ piece: { stage: "outline", analysis }, contract: CONTRACT, research: ITEMS });
    const r = await applyAlignmentFixes(db, "SI-0099", {
      reject_items: [2], edit_points: [{ point: 1, text: " Better " }], remove_points: [2], add_points: [" New point "], add_sections: [{ heading: "Extra", covers: [1] }],
    }, ["gap-0"]);
    expect(rpcs[0].fn).toBe("apply_alignment_fixes");
    const f = rpcs[0].args.fixes as Record<string, unknown[]>;
    expect(f.reject_items).toEqual([R2]);
    expect(f.edit_points).toEqual([{ id: "e1", text: "Better" }]);
    expect(f.remove_points).toEqual(["e2"]);
    expect((f.add_points[0] as { text: string }).text).toBe("New point");
    expect(f.add_sections).toEqual([{ heading: "Extra", purpose: "", expectation_ids: ["e1"] }]);
    expect(r.applied).toMatchObject({ rejected_research: 1, added_points: 1, added_sections: 1 });
    const saved = updates[0].patch.analysis as { gaps: Record<string, unknown>[]; fixes_applied: boolean };
    expect(saved.gaps[0].resolved).toBe(true);
    expect(saved.fixes_applied).toBe(true);
  });
  it("refuses fixes outside the outline step, with nothing to apply, with unknown numbers, and passes on Writ's refusal", async () => {
    await expect(applyAlignmentFixes(fakeWrite({ piece: { stage: "writing" }, contract: CONTRACT, research: ITEMS }).db, "SI-0099", { remove_points: [1] })).rejects.toThrow(/outline is open/);
    const ok = () => fakeWrite({ piece: { stage: "outline" }, contract: CONTRACT, research: ITEMS });
    await expect(applyAlignmentFixes(ok().db, "SI-0099", {})).rejects.toThrow(/no fixes/);
    await expect(applyAlignmentFixes(ok().db, "SI-0099", { remove_points: [9] })).rejects.toThrow(/does not exist/);
    await expect(applyAlignmentFixes(ok().db, "SI-0099", { reject_items: [9] })).rejects.toThrow(/does not exist/);
    const refused = fakeWrite({ piece: { stage: "outline" }, contract: CONTRACT, research: ITEMS, rpc: () => ({ error: { message: "the outline is confirmed" } }) });
    await expect(applyAlignmentFixes(refused.db, "SI-0099", { remove_points: [1] })).rejects.toThrow(/outline is confirmed/);
  });
});

describe("addExpertAnswer", () => {
  it("saves the writer's answer as a card and adds it to the research through Writ", async () => {
    const { db, inserts, rpcs } = fakeWrite();
    const r = await addExpertAnswer(db, "SI-0099", "  We saw a 30% drop after switching.  ");
    expect(inserts[0].table).toBe("cards");
    expect(inserts[0].row).toMatchObject({ company_id: "c1", type: "opinion", claim: "We saw a 30% drop after switching.", citation: "internal", origin: "manual", created_by: "u1" });
    expect(rpcs[0]).toEqual({ fn: "add_answer_to_research", args: { target_piece: ID, card: "card1", item_quote: "" } });
    expect(r.added).toBe(true);
    await expect(addExpertAnswer(fakeWrite().db, "SI-0099", "  ")).rejects.toThrow(/empty/);
  });
  it("keeps a long answer whole in the card's detail", async () => {
    const long = "x".repeat(500);
    const { db, inserts } = fakeWrite();
    await addExpertAnswer(db, "SI-0099", long);
    expect((inserts[0].row.claim as string).length).toBe(400);
    expect(inserts[0].row.detail).toBe(long);
  });
});

describe("gap research and the benchmark flag", () => {
  it("passes gap_search to Writ and counts the added items toward the gap", async () => {
    const analysis = { alignment: { verdict: "partly", summary: "s" }, drift: [], gaps: [{ text: "g", expert_question: "q" }], contract_suggestions: [] };
    const { db, rpcs, updates } = fakeWrite({ piece: { stage: "outline", analysis }, rpc: () => ({ data: { added: 2, item_ids: [R1, R2] } }) });
    await addResearch(db, "SI-0099", [finding, finding], undefined, false, "gap-0");
    expect(rpcs[0].args).toMatchObject({ gap_search: true, target_section: null });
    expect((updates[0].patch.analysis as { gaps: { researched: number }[] }).gaps[0].researched).toBe(2);
    const plain = fakeWrite({ rpc: () => ({ data: { added: 1, item_ids: [R1] } }) });
    await addResearch(plain.db, "SI-0099", [finding]);
    expect(plain.rpcs[0].args.gap_search).toBe(false);
    await expect(addResearch(fakeWrite().db, "SI-0099", [finding], undefined, false, "gap-x")).rejects.toThrow(/not a gap id/);
    await expect(addResearch(fakeWrite().db, "SI-0099", [finding], SEC, false, "gap-0")).rejects.toThrow(/leave out section_id/);
  });
  it("marks the benchmark done when an outline is saved after an analysis, as the web app does", async () => {
    const analysis = { alignment: { verdict: "aligned", summary: "s" }, drift: [], gaps: [], contract_suggestions: [] };
    const { db, updates } = fakeWrite({ piece: { stage: "outline", analysis } });
    await saveOutline(db, "SI-0099", [{ heading: "A" }]);
    expect((updates.find((u) => u.patch.analysis)!.patch.analysis as { benchmark_done: boolean }).benchmark_done).toBe(true);
    const none = fakeWrite({ piece: { stage: "outline" } });
    await saveOutline(none.db, "SI-0099", [{ heading: "A" }]);
    expect(none.updates.some((u) => u.patch.analysis)).toBe(false);
  });
});

describe("outline SEO and GEO check", () => {
  it("reads the outline as plain lines with the check keys", async () => {
    const { db } = fakeWrite({ piece: { stage: "outline", recipe: FULL, primary_keyword: "kw" }, contract: CONTRACT, sections: [{ id: SEC, position: 1, heading: "Why X", purpose: "p" }], research: [{ statement: "serp fact" }] });
    const r = await getOutlineCheckInput(db, "SI-0099");
    expect(r.outline).toEqual(["1. Why X (p)"]);
    expect(r.checks.seo).toContain("coverage_gap");
    expect(r.search_landscape).toEqual(["serp fact"]);
    await expect(getOutlineCheckInput(fakeWrite({ piece: { recipe: OFF } }).db, "SI-0099")).rejects.toThrow(/switched off/);
    await expect(getOutlineCheckInput(fakeWrite({ piece: { recipe: FULL }, sections: [] }).db, "SI-0099")).rejects.toThrow(/Save an outline/);
  });
  it("saves the check in the app's shape, and only with outline check keys", async () => {
    const { db, updates } = fakeWrite({ piece: { recipe: FULL } });
    const r = await saveOutlineChecks(db, "SI-0099", [
      { area: "seo", check: "answer_first", status: "improve", evidence: "Starts with history", fix: " Lead with the answer " },
      { area: "geo", check: "structure", status: "fine", evidence: "ok", fix: "ignored when fine" },
    ]);
    expect(r).toMatchObject({ saved: true, checks: 2, to_improve: 1 });
    const saved = updates[0].patch.seo_geo_outline as { checked_at: string; checks: Record<string, unknown>[] };
    expect(saved.checks[0]).toMatchObject({ area: "seo", check: "answer_first", label: "Answer first", status: "improve", fix: "Lead with the answer" });
    expect(saved.checks[1].fix).toBe("");
    await expect(saveOutlineChecks(db, "SI-0099", [{ area: "seo", check: "internal_links", status: "fine" }])).rejects.toThrow(/not an outline SEO check/);
    await expect(saveOutlineChecks(db, "SI-0099", [])).rejects.toThrow(/at least one/);
  });
});

describe("section checks", () => {
  const SECTION = { id: SEC, piece_id: ID, heading: "Why", purpose: "p", status: "writing", content: "Teh text says 40% grew.", content_rev: 3, expectation_ids: ["e2"] };
  const mk = (extra: Partial<WriteOpts> = {}) => fakeWrite({ piece: { recipe: FULL }, section: SECTION, contract: CONTRACT, research: ITEMS, ...extra });

  it("gives Claude the saved text, its version, the numbered research and only the scope points the section owes", async () => {
    const r = (await getCheckInput(mk().db, "SI-0099", SEC)) as { section: { content_rev: number; text: string }; research: { n: number }[]; scope_points_owed: unknown[]; enabled: Record<string, boolean> };
    expect(r.section).toMatchObject({ content_rev: 3, text: SECTION.content });
    expect(r.research.map((x) => x.n)).toEqual([1, 2]);
    expect(r.scope_points_owed).toEqual([{ n: 1, text: "Second" }]);
    expect(r.enabled).toEqual({ grammar: true, fact: true, contract: true });
    await expect(getCheckInput(mk({ section: { ...SECTION, content: "  " } }).db, "SI-0099", SEC)).rejects.toThrow(/no saved text/);
    expect((await getReviewInput(mk().db, "SI-0099", "section", SEC) as { scope: string }).scope).toBe("section");
    await expect(getReviewInput(mk().db, "SI-0099", "section")).rejects.toThrow(/section_id/);
  });
  it("saves grammar, fact and scope results in the app's shape, stamped with the text version", async () => {
    const { db, updates } = mk();
    const r = await saveSectionChecks(db, SEC, 3, {
      grammar: { suggestions: [{ original: "Teh text", replacement: "The text", reason: "spelling" }, { original: "not in the text", replacement: "x" }, { original: "same", replacement: "same" }] },
      fact: { flags: [{ sentence: "The text says 40% grew.", kind: "mismatch", issue: "Item says 30%", item: 2 }, { sentence: "Another claim.", kind: "unsupported", issue: "No source" }] },
      contract: { results: [{ expectation: 1, status: "partly", evidence: "says 40%", gap: "no cause given" }] },
    });
    expect(r).toMatchObject({ saved: true, grammar: { found: 1, dropped: 2 }, fact: { flags: 2 }, contract: { met: 0, partly: 1, missing: 0 } });
    const p = updates[0].patch as { grammar_check: Record<string, unknown>; fact_check: { flags: Record<string, unknown>[]; rev: number }; contract_check: { results: Record<string, unknown>[] } };
    expect(p.grammar_check).toMatchObject({ rev: 3, found: 1 });
    expect(p.fact_check.rev).toBe(3);
    expect(p.fact_check.flags).toEqual([
      { sentence: "The text says 40% grew.", kind: "mismatch", issue: "Item says 30%", item: 2, item_id: R2 },
      { sentence: "Another claim.", kind: "unsupported", issue: "No source", item: 0, item_id: null },
    ]);
    expect(p.contract_check.results).toEqual([{ expectation_id: "e2", text: "Second", status: "partly", evidence: "says 40%", gap: "no cause given" }]);
  });
  it("marks a scope point the model skipped as missing and not assessed", async () => {
    const { db, updates } = mk({ section: { ...SECTION, expectation_ids: ["e1", "e2"] } });
    await saveSectionChecks(db, SEC, 3, { contract: { results: [{ expectation: 2, status: "met", evidence: "e" }] } });
    const res = (updates[0].patch.contract_check as { results: Record<string, unknown>[] }).results;
    expect(res[0]).toMatchObject({ expectation_id: "e1", status: "missing", gap: "Not assessed." });
    expect(res[1]).toMatchObject({ expectation_id: "e2", status: "met", gap: "" });
  });
  it("refuses stale text, checks the format does not use, a mismatch with no item, and a save that lost the race", async () => {
    await expect(saveSectionChecks(mk().db, SEC, 2, { grammar: { suggestions: [] } })).rejects.toThrow(/text changed after it was read/);
    await expect(saveSectionChecks(mk({ piece: { recipe: OFF } }).db, SEC, 3, { grammar: { suggestions: [] } })).rejects.toThrow(/switched off/);
    await expect(saveSectionChecks(mk({ piece: { recipe: OFF } }).db, SEC, 3, { fact: { flags: [] } })).rejects.toThrow(/switched off/);
    await expect(saveSectionChecks(mk().db, SEC, 3, { fact: { flags: [{ sentence: "s", kind: "mismatch", issue: "i" }] } })).rejects.toThrow(/must name the research item/);
    await expect(saveSectionChecks(mk().db, SEC, 3, {})).rejects.toThrow(/at least one/);
    await expect(saveSectionChecks(mk({ section: { ...SECTION, expectation_ids: [] } }).db, SEC, 3, { contract: { results: [] } })).rejects.toThrow(/owes no scope points/);
    await expect(saveSectionChecks(mk({ updateMiss: true }).db, SEC, 3, { grammar: { suggestions: [] } })).rejects.toThrow(/changed while the checks were being saved/);
  });
});

describe("final checks", () => {
  const SECS = [{ id: SEC, position: 1, heading: "One", purpose: "", content: "Body one" }, { id: R1, position: 2, heading: "Two", purpose: "", content: "Body two" }];
  it("gives the whole piece as text with the scope points and the search landscape", async () => {
    const { db } = fakeWrite({ piece: { recipe: FULL, title: "My piece" }, contract: CONTRACT, sections: SECS, research: [{ statement: "landscape" }] });
    const r = (await getCheckInput(db, "SI-0099")) as { piece_text: string; scope_points: unknown[]; search_landscape: string[]; enabled: Record<string, boolean> };
    expect(r.piece_text).toBe("# My piece\n\n## One\n\nBody one\n\n## Two\n\nBody two");
    expect(r.scope_points).toHaveLength(2);
    expect(r.search_landscape).toEqual(["landscape"]);
    expect(r.enabled).toEqual({ contract: true, seo: true, geo: true });
    await expect(getCheckInput(fakeWrite({ piece: { recipe: FULL }, contract: CONTRACT, sections: [{ id: SEC, position: 1, heading: "H", purpose: "", content: " " }] }).db, "SI-0099")).rejects.toThrow(/Nothing is written/);
  });
  it("saves the final scope check for every scope point and the SEO/GEO check with its meta fields", async () => {
    const { db, updates } = fakeWrite({ piece: { stage: "writing", recipe: FULL }, contract: CONTRACT });
    const r = await saveFinalChecks(db, "SI-0099", {
      contract: { results: [{ expectation: 1, status: "met", evidence: "e" }] },
      seo_geo: { checks: [{ area: "seo", check: "intent", status: "fine", evidence: "ok" }, { area: "geo", check: "freshness", status: "improve", evidence: "no dates", fix: "Add dates" }], meta_title: " Title ", meta_description: "Desc" },
    });
    expect(r).toMatchObject({ saved: true, contract: { met: 1, missing: 1 }, seo_geo: { checks: 2, to_improve: 1 } });
    const p = updates[0].patch as { final_check: { rev: null; results: Record<string, unknown>[] }; seo_geo_final: { checks: Record<string, unknown>[]; meta_title: string; meta_description: string } };
    expect(p.final_check.rev).toBeNull();
    expect(p.final_check.results.map((x) => x.status)).toEqual(["met", "missing"]);
    expect(p.seo_geo_final).toMatchObject({ meta_title: "Title", meta_description: "Desc" });
    expect(p.seo_geo_final.checks[1]).toMatchObject({ area: "geo", check: "freshness", label: "Freshness", fix: "Add dates" });
  });
  it("keeps to the areas the format uses, refuses unknown check keys, wrong stage, or nothing to save", async () => {
    const seoOnly = { ...FULL, checks: { ...(FULL as { checks: object }).checks, geo: false } };
    const { db, updates } = fakeWrite({ piece: { stage: "writing", recipe: seoOnly }, contract: CONTRACT });
    await saveFinalChecks(db, "SI-0099", { seo_geo: { checks: [{ area: "seo", check: "title", status: "fine" }, { area: "geo", check: "freshness", status: "fine" }] } });
    expect((updates[0].patch.seo_geo_final as { checks: unknown[] }).checks).toHaveLength(1);
    await expect(saveFinalChecks(fakeWrite({ piece: { stage: "writing", recipe: FULL } }).db, "SI-0099", { seo_geo: { checks: [{ area: "seo", check: "coverage_gap", status: "fine" }] } })).rejects.toThrow(/not a SEO check/);
    await expect(saveFinalChecks(fakeWrite({ piece: { stage: "outline", recipe: FULL } }).db, "SI-0099", { seo_geo: { checks: [] } })).rejects.toThrow(/once the piece is being written/);
    await expect(saveFinalChecks(fakeWrite({ piece: { stage: "writing", recipe: OFF } }).db, "SI-0099", { seo_geo: { checks: [] } })).rejects.toThrow(/switched off/);
    await expect(saveFinalChecks(fakeWrite({ piece: { stage: "writing", recipe: FULL } }).db, "SI-0099", {})).rejects.toThrow(/Give the contract/);
  });
});

describe("second review fixes", () => {
  const ANALYSIS = { alignment: { verdict: "partly", summary: "s" }, drift: [], gaps: [{ text: "g", expert_question: "q" }], contract_suggestions: [] };

  it("flags the analysis as acted on after any apply, even when no finding is closed", async () => {
    const { db, updates } = fakeWrite({ piece: { stage: "outline", analysis: ANALYSIS }, contract: CONTRACT, research: ITEMS });
    await applyAlignmentFixes(db, "SI-0099", { remove_points: [1] });
    expect((updates[0].patch.analysis as { fixes_applied: boolean }).fixes_applied).toBe(true);
  });
  it("marks a gap that got its own section, and checks the findings before anything is applied", async () => {
    const { db, updates } = fakeWrite({ piece: { stage: "outline", analysis: ANALYSIS }, contract: CONTRACT, research: ITEMS });
    await applyAlignmentFixes(db, "SI-0099", { add_sections: [{ heading: "New" }] }, ["gap-0"]);
    expect((updates[0].patch.analysis as { gaps: Record<string, unknown>[] }).gaps[0]).toMatchObject({ resolved: true, sectioned: true });
    const noAnalysis = fakeWrite({ piece: { stage: "outline" }, contract: CONTRACT, research: ITEMS });
    await expect(applyAlignmentFixes(noAnalysis.db, "SI-0099", { remove_points: [1] }, ["gap-0"])).rejects.toThrow(/no gap analysis/);
    expect(noAnalysis.rpcs).toHaveLength(0);
    const badId = fakeWrite({ piece: { stage: "outline", analysis: ANALYSIS }, contract: CONTRACT, research: ITEMS });
    await expect(applyAlignmentFixes(badId.db, "SI-0099", { remove_points: [1] }, ["gap-9"])).rejects.toThrow(/no gap-9/);
    expect(badId.rpcs).toHaveLength(0);
  });
  it("saves no research for a gap search the analysis cannot record", async () => {
    const none = fakeWrite({ piece: { stage: "outline" }, rpc: () => ({ data: { added: 1, item_ids: [R1] } }) });
    await expect(addResearch(none.db, "SI-0099", [finding], undefined, false, "gap-0")).rejects.toThrow(/no gap analysis/);
    expect(none.rpcs).toHaveLength(0);
    const wrongGap = fakeWrite({ piece: { stage: "outline", analysis: ANALYSIS } });
    await expect(addResearch(wrongGap.db, "SI-0099", [finding], undefined, false, "gap-3")).rejects.toThrow(/no gap-3/);
    expect(wrongGap.rpcs).toHaveLength(0);
  });
  it("keeps the whole of a long expert answer in the research item", async () => {
    const long = "y".repeat(450);
    const { db, rpcs } = fakeWrite();
    await addExpertAnswer(db, "SI-0099", long);
    expect(rpcs[0].args.item_quote).toBe(long);
  });
  it("never stores a blank gap for a scope point that is partly or not delivered", async () => {
    const SECTION = { id: SEC, piece_id: ID, heading: "H", status: "writing", content: "Some text", content_rev: 1, expectation_ids: ["e1", "e2"] };
    const { db, updates } = fakeWrite({ piece: { recipe: FULL }, section: SECTION, contract: CONTRACT });
    await saveSectionChecks(db, SEC, 1, { contract: { results: [{ expectation: 1, status: "partly" }, { expectation: 2, status: "missing", gap: "  " }] } });
    const res = (updates[0].patch.contract_check as { results: { gap: string }[] }).results;
    expect(res.map((r) => r.gap)).toEqual(["Only partly delivered.", "Not delivered."]);
  });
  it("numbers the research for the fact check from the piece when sections have no research of their own", async () => {
    const piece = { recipe: { ...FULL, outline: { ...(FULL as { outline: object }).outline, mode: "off" } } };
    const SECTION = { id: SEC, piece_id: ID, heading: "H", purpose: "", status: "writing", content: "Some text", content_rev: 1, expectation_ids: [] };
    const r = (await getCheckInput(fakeWrite({ piece, section: SECTION, contract: CONTRACT, research: ITEMS }).db, "SI-0099", SEC)) as { research: { n: number }[] };
    expect(r.research.map((x) => x.n)).toEqual([1, 2]);
  });
  it("gives every format except the case study the long-form base", () => {
    const bases = Object.fromEntries(FORMAT_PRESETS.map((p) => [p.key, (p.recipe as { base: string }).base]));
    expect(bases.case_study).toBe("case_study");
    expect(Object.entries(bases).filter(([k]) => k !== "case_study").every(([, b]) => b === "long_form")).toBe(true);
  });
});
