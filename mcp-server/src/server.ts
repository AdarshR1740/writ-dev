import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DRAFT_RULES, NEW_PIECE_FINISH, NEW_PIECE_RULES, ONBOARDING } from "./prompts.js";
import {
  WritError, addExpertAnswer, checkPiece as checkPieceFor, lockedOutline as lockedOutlineFor, lockedSection as lockedSectionFor,
  lockedPiece as lockedPieceFor, lockedResearchOf as lockedResearchOfFor, addFormats, addResearch, applyAlignmentFixes, completeResearch, confirmOutline, confirmScope, createCompany,
  getContextDocuments, getPiece, getResearch, getReviewInput, getSection, getSetup, getVoice, listPieces, markFindings, reviewResearch,
  saveAnalysis, saveContextDocument, saveFinalChecks, saveOutline, saveOutlineChecks, saveScope, saveSectionChecks, saveSectionDraft,
  saveSectionPoints, startPiece, useResearch, noteReadPiece, noteReadSection, readNotice,
} from "./writ.js";

// stdout carries the protocol, so anything for a human goes to stderr.
export const log = (m: string) => process.stderr.write(`[writ-mcp] ${m}
`);

/** Who is calling: a way to reach Writ's database as that person, and the id this connection uses for edit locks. */
export type Ctx = { db: () => Promise<SupabaseClient>; clientId: string };

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (e: unknown): Result => ({
  isError: true,
  content: [{ type: "text", text: e instanceof WritError || e instanceof Error ? e.message : "Something went wrong." }],
});

/** One server per connection: stdio has one, the hosted endpoint makes one for each Claude chat. */
export function buildServer(ctx: Ctx): McpServer {
async function run(fn: (c: SupabaseClient) => Promise<unknown>): Promise<Result> {
  try { return ok(await fn(await ctx.db())); } catch (e) { return fail(e); }
}
const lockedOutline = <T,>(c: SupabaseClient, ref: string, fn: () => Promise<T>) => lockedOutlineFor(c, ref, fn, ctx.clientId);
const lockedSection = <T,>(c: SupabaseClient, id: string, fn: () => Promise<T>) => lockedSectionFor(c, id, fn, ctx.clientId);
const lockedPiece = <T,>(c: SupabaseClient, ref: string, scope: "scope" | "research" | "final", fn: () => Promise<T>, opts?: { append?: boolean }) => lockedPieceFor(c, ref, scope, fn, ctx.clientId, opts);
const lockedResearchOf = <T,>(c: SupabaseClient, by: { item?: string; items?: string[]; section?: string }, fn: () => Promise<T>, opts?: { append?: boolean }) => lockedResearchOfFor(c, by, fn, ctx.clientId, opts);
/** Adds Claude's notice (someone is editing this) to what a read returns, when there is one. */
const withNotice = (value: unknown, notice: string | null) =>
  notice && value && typeof value === "object" && !Array.isArray(value) ? { notice, ...(value as Record<string, unknown>) } : value;
const checkPiece = (c: SupabaseClient, ref: string) => checkPieceFor(c, ref, ctx.clientId);

const server = new McpServer({ name: "writ", version: "0.2.0" });

/** Tools that change something in Writ take this: a prompt for the model to set it only after the writer's yes. */
const approved = (what: string) => z.literal(true).describe(`Must be true, and only after the writer has said yes to ${what} in this conversation`);

server.registerTool("writ_list_pieces", {
  title: "List Writ pieces",
  description: "Lists the writer's pieces in Writ (code, title, stage), most recently updated first.",
  inputSchema: { stage: z.enum(["contract", "research", "outline", "writing", "done"]).optional().describe("Only pieces at this stage"), limit: z.number().int().min(1).max(50).optional() },
  annotations: { readOnlyHint: true },
}, ({ stage, limit }) => run((c) => listPieces(c, { stage, limit })));

server.registerTool("writ_get_piece", {
  title: "Get a Writ piece",
  description: "A piece's brief, the reader's question and expectations, and its outline with each section's id, status and whether it is prepared. Name the piece by its code, for example SI-0012.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id") },
  annotations: { readOnlyHint: true },
}, ({ piece }) => run(async (c) => { await noteReadPiece(c, ctx.clientId, piece); return getPiece(c, piece); }));

server.registerTool("writ_get_section", {
  title: "Get everything needed to write a section",
  description: "One section's brief: its heading and purpose, the outline around it, the reader's question, the talking points with their evidence, the approved research (numbered, with URLs to link), the planned structure and the current text. Use the section id from writ_get_piece.",
  inputSchema: { section_id: z.string().describe("The section id") },
  annotations: { readOnlyHint: true },
}, ({ section_id }) => run(async (c) => {
  await noteReadSection(c, ctx.clientId, section_id);
  const section = await getSection(c, section_id);
  // Reading a section to write it: hold it for a short while, or say that the writer is already in it.
  return withNotice(section, await readNotice(c, ctx.clientId, { section: section_id }));
}));

server.registerTool("writ_check_piece", {
  title: "Check what the writer will see",
  description: "A read-only health check of a piece. It says, step by step, what the writer will see in Writ right now (scope, research, outline, writing, sign-off), and lists anything that looks wrong or stuck, each with what to do. Run it after saving an outline, reopening something, or finishing a step, and tell the writer about every problem it reports.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id") },
  annotations: { readOnlyHint: true },
}, ({ piece }) => run((c) => checkPiece(c, piece)));

server.registerTool("writ_get_voice", {
  title: "Get the company's voice",
  description: "How the piece's company writes: core voice, the format profile for this piece's format, audience and positioning, and the voice rules learned from past edits. Read it before drafting.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id") },
  annotations: { readOnlyHint: true },
}, ({ piece }) => run((c) => getVoice(c, piece)));

server.registerTool("writ_save_section_draft", {
  title: "Save a section draft to Writ",
  description: "Saves a drafted section into Writ for the writer to review and edit. It becomes the section's text only if the writer has not written any yet, and is always kept as the AI draft (so the record shows it was AI-drafted). Never overwrites the writer's text. Markdown only: ### and #### headings, no # or ##.",
  inputSchema: { section_id: z.string(), text: z.string().describe("The section text as Markdown") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ section_id, text }) => run((c) => lockedSection(c, section_id, () => saveSectionDraft(c, section_id, text))));

server.registerTool("writ_get_setup", {
  title: "Where the writer stands in Writ",
  description: "The companies the writer belongs to, each with its formats (a format sets how a piece is worked), how much of the house file (ICP, core voice, positioning, strategy notes) is filled in, whether it is ready for good drafts, and how many pieces it has. An empty list means the writer is new and has no company yet. Use it at the start of onboarding and before starting a new piece.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => run((c) => getSetup(c)));

server.registerTool("writ_create_company", {
  title: "Create the writer's company",
  description: "Creates a company in Writ and makes the writer its editor, with empty house-file documents. A company cannot be deleted from here, so confirm the exact name with the writer first.",
  inputSchema: { name: z.string().describe("The company name, 2 to 120 characters"), writer_approved: approved("creating a company with exactly this name") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ name }) => run((c) => createCompany(c, name)));

server.registerTool("writ_add_formats", {
  title: "Switch on the standard formats",
  description: "Adds Writ's standard formats to the company (blog posts, LinkedIn posts, case studies, carousels, scripts, newsletters and more; all of them unless some are named), each with its workflow. Formats the company already has are left alone. Each new format's style profile starts empty until examples are added in Writ.",
  inputSchema: {
    company: z.string().optional().describe("Company name or id, needed only when the writer belongs to more than one"),
    templates: z.array(z.string()).optional().describe("Template keys or names to add; leave out for all of them"),
    writer_approved: approved("adding the standard formats"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ company, templates }) => run((c) => addFormats(c, { company, templates })));

server.registerTool("writ_get_context_documents", {
  title: "Read the company's house file",
  description: "The text of the company's house-file documents (ICP, core voice, positioning, strategy notes), with whether each is filled in. Read them before improving or replacing one.",
  inputSchema: { company: z.string().optional().describe("Company name or id, needed only when the writer belongs to more than one") },
  annotations: { readOnlyHint: true },
}, ({ company }) => run((c) => getContextDocuments(c, company)));

server.registerTool("writ_save_context_document", {
  title: "Save a house-file document",
  description: "Saves one house-file document (icp, core_voice, positioning or strategy_notes) as Markdown. Every piece the company writes is planned and drafted against these, so save only what the writer has approved. It refuses to replace text that is already there unless replace is true, and replace is only for when the writer has seen the existing text and said to replace it.",
  inputSchema: {
    kind: z.enum(["icp", "core_voice", "positioning", "strategy_notes"]),
    content: z.string().describe("The document as Markdown"),
    company: z.string().optional().describe("Company name or id, needed only when the writer belongs to more than one"),
    replace: z.boolean().optional().describe("True only after the writer agreed to replace the existing text"),
    writer_approved: approved("saving this document"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ kind, content, company, replace }) => run((c) => saveContextDocument(c, { kind, content, company, replace })));

server.registerTool("writ_start_piece", {
  title: "Start a new piece in Writ",
  description: "Creates a new piece through Writ (the piece code is assigned by Writ). It starts at the scope step. This is a real change: only call it after the writer has confirmed the brief. Returns the code, the stage and how many scope points the format allows.",
  inputSchema: {
    title: z.string().describe("The piece title, 1 to 200 characters"),
    topic: z.string().describe("What the piece is about"),
    keyword: z.string().optional().describe("The primary keyword"),
    goal: z.string().optional().describe("What the piece should achieve"),
    audience: z.string().optional().describe("Who it is for, if different from the company's usual reader"),
    format: z.string().optional().describe("A format name or id from writ_get_setup"),
    company: z.string().optional().describe("Company name or id, needed only when the writer belongs to more than one"),
    timing: z.enum(["just_in_time", "up_front"]).optional().describe("Leave out to use the format's default"),
    customer: z.string().optional().describe("The customer, for formats that ask for one (see brief_asks_for in writ_get_setup)"),
    approval_contact: z.string().optional().describe("Who approves the piece at the customer, for formats that ask for it"),
    offer: z.string().optional().describe("The offer, for formats that ask for one"),
    cta: z.string().optional().describe("The call to action, for formats that ask for one"),
    writer_approved: z.literal(true).describe("Must be true, and only after the writer has said yes to creating this piece in this conversation"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ writer_approved: _approved, ...a }) => run(async (c) => {
  const started = await startPiece(c, a);
  // Claude made this piece, so it knows what is in it: no need to read it before the first saves.
  const code = (started as { code?: string } | null)?.code;
  if (code) await noteReadPiece(c, ctx.clientId, code);
  return started;
}));

server.registerTool("writ_save_scope", {
  title: "Save a piece's scope draft",
  description: "Saves the scope draft: the one question the piece answers and the points it should include. Works only while the scope step is open. It does not confirm the scope.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    core_question: z.string().describe("One question, one sentence"),
    points: z.array(z.string()).describe("The full list of points, one short line each (at most 7, or 2 for a short format)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, core_question, points }) => run((c) => lockedPiece(c, piece, "scope", () => saveScope(c, piece, core_question, points))));

server.registerTool("writ_confirm_scope", {
  title: "Confirm a piece's scope",
  description: "Confirms the saved scope through Writ and moves the piece on to research. Only call it after the writer has clearly approved the scope.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    writer_approved: z.literal(true).describe("Must be true, and only after the writer has said yes to this exact scope in this conversation"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece }) => run((c) => lockedPiece(c, piece, "scope", () => confirmScope(c, piece))));

server.registerTool("writ_get_research", {
  title: "List a piece's research",
  description: "The research items of a piece (or of one section when section_id is given): numbered, with statement, quote, source title and URL, type, status (unreviewed, approved, rejected) and whether the quote was checked. Item ids are what writ_review_research and writ_use_research need.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id"), section_id: z.string().optional().describe("Give it to list that section's own research") },
  annotations: { readOnlyHint: true },
}, ({ piece, section_id }) => run(async (c) => { await noteReadPiece(c, ctx.clientId, piece, ["research"]); return getResearch(c, piece, section_id); }));

server.registerTool("writ_add_research", {
  title: "Save research Claude found",
  description: "Saves findings (each one fact with its source) as unreviewed research items, up to 20 at a time. Works only after the scope is confirmed and while the research step is open (or, with section_id, while that section is not being written). Quotes are NOT checked against the pages, so they must be copied exactly from the source. The writer decides which items to approve.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    findings: z.array(z.object({
      url: z.string().describe("The page the fact comes from (http or https)"),
      title: z.string().optional().describe("The page title"),
      statement: z.string().describe("The finding in one plain sentence, with the figure, date and name it concerns (at most 1200 characters)"),
      quote: z.string().optional().describe("A short passage copied word for word from the page that supports the statement"),
      source_type: z.enum(["original_research", "official", "practitioner", "critical", "data", "web", "serp"]),
      secondary: z.boolean().optional().describe("True if the page reports someone else's figure or claim"),
      published: z.string().optional().describe("The publication date, if known"),
    })).describe("1 to 20 findings"),
    section_id: z.string().optional().describe("Add the findings to this section's research instead of the piece's"),
    auto: z.boolean().optional().describe("True when preparing a section whose brief step is open"),
    gap: z.string().optional().describe("The gap this search is aimed at (gap-0, gap-1), for research that answers a gap found by the gap analysis; allowed while the outline is open"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ piece, findings, section_id, auto, gap }) => run((c) => lockedPiece(c, piece, "research", () => addResearch(c, piece, findings, section_id, auto, gap), { append: true })));

server.registerTool("writ_review_research", {
  title: "Record the writer's decisions on research items",
  description: "Approves or rejects research items, one decision each. These are the writer's decisions: only record what the writer has said. An approved item can be cited in the draft.",
  inputSchema: {
    decisions: z.array(z.object({
      item: z.string().describe("The research item id from writ_get_research"),
      decision: z.enum(["approved", "rejected", "unreviewed"]),
      statement: z.string().optional().describe("The statement reworded by the writer, if they edited it"),
    })),
    writer_approved: approved("these decisions"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ decisions }) => run((c) => (decisions.length ? lockedResearchOf(c, { items: decisions.map((d) => d.item) }, () => reviewResearch(c, decisions)) : reviewResearch(c, decisions))));

server.registerTool("writ_complete_research", {
  title: "Finish a piece's research step",
  description: "Closes the piece-level research through Writ and moves the piece to the outline. Writ refuses while items still need a decision (when the format reviews research). Only call it after the writer says the research is done.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id"), writer_approved: approved("finishing the research") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece }) => run((c) => lockedPiece(c, piece, "research", () => completeResearch(c, piece))));

server.registerTool("writ_save_outline", {
  title: "Save a piece's outline draft",
  description: "Saves the outline: the sections in order, each with a specific heading, a one-line purpose, and the numbers of the scope points it serves. Replaces the sections already saved (keep a section's id to keep its work). Works only while the outline step is open. It does not confirm the outline, and it reports any scope point no section serves.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    sections: z.array(z.object({
      heading: z.string().describe("A specific heading, never Introduction, Overview or Conclusion"),
      purpose: z.string().optional().describe("One line: what this section tells the reader"),
      covers: z.array(z.number().int()).optional().describe("Numbers of the scope points (1, 2, ...) this section serves. Omit it on a section you keep (id) to leave what it covers as it is; send [] to clear it"),
      id: z.string().optional().describe("The section id, when keeping an existing section"),
      level: z.number().int().min(2).max(3).optional().describe("2 for a main heading (H2), 3 for a sub-heading (H3) under the main heading above it. Omit to keep a section's level (a new one is a main heading). Sub-headings are only for formats with a free outline, and a sub-heading has no scope points"),
      depth: z.enum(["short", "standard", "deep"]).optional().describe("How much a sub-heading should say. Omit to keep it"),
    })).describe("1 to 12 sections, usually 4 to 8 (up to 40 rows when sub-headings are included)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, sections }) => run((c) => lockedOutline(c, piece, () => saveOutline(c, piece, sections))));

server.registerTool("writ_confirm_outline", {
  title: "Confirm a piece's outline",
  description: "Confirms the saved outline through Writ and moves the piece to writing. Only call it after the writer has clearly approved this outline.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id"), writer_approved: approved("this outline") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece }) => run((c) => lockedOutline(c, piece, () => confirmOutline(c, piece))));

server.registerTool("writ_use_research", {
  title: "Use approved research in a section",
  description: "Copies approved piece-level research items into a section, so the section's talking points can cite them. Use the item ids from writ_get_research. Only approved items can be copied.",
  inputSchema: { section_id: z.string().describe("The section id from writ_get_piece"), item_ids: z.array(z.string()).describe("Research item ids") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ section_id, item_ids }) => run((c) => lockedResearchOf(c, { section: section_id }, () => useResearch(c, section_id, item_ids), { append: true })));

server.registerTool("writ_save_section_points", {
  title: "Save a section's talking points",
  description: "Saves the points a section should make, with direction and evidence, and gets the section ready to draft (Writ finishes the section's research step and confirms its brief). Works only once the outline is confirmed. Cite research by the numbers writ_get_section shows for this section.",
  inputSchema: {
    section_id: z.string().describe("The section id from writ_get_piece"),
    points: z.array(z.object({
      point: z.string().describe("The idea or claim, one short sentence"),
      direction: z.string().optional().describe("How to treat it: the angle, an example to use, what to avoid. Not finished sentences"),
      evidence: z.string().optional().describe("The fact or figure to use and where it comes from; empty when no research supports the point"),
      refs: z.array(z.number().int()).optional().describe("Numbers of the section's research items it uses"),
      sub_section: z.string().optional().describe("The planned sub-section it belongs to, if any"),
    })).describe("1 to 12 points, usually 4 to 10"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ section_id, points }) => run((c) => lockedSection(c, section_id, () => saveSectionPoints(c, section_id, points))));

const contractResult = z.object({
  expectation: z.number().int().describe("The scope point's number from writ_get_check_input"),
  status: z.enum(["met", "partly", "missing"]),
  evidence: z.string().optional().describe("For met and partly: the shortest passage from the text that shows it, copied exactly"),
  gap: z.string().optional().describe("For partly and missing: one plain sentence on what is missing"),
});
const seoGeoCheck = z.object({
  area: z.enum(["seo", "geo"]),
  check: z.string().describe("The check's key, such as answer_first"),
  label: z.string().optional().describe("A short plain-English name for the check"),
  status: z.enum(["fine", "improve", "n/a"]),
  evidence: z.string().optional().describe("What you saw, quoted from the text when you can"),
  fix: z.string().optional().describe("For improve: one concrete fix"),
});

server.registerTool("writ_get_check_input", {
  title: "Read what a check needs",
  description: "Everything needed to run one of the checks, with the numbering the save tools expect. scope \"analysis\": the gap analysis (brief, scope points, approved research). scope \"outline\": the outline's SEO and GEO check. scope \"section\" (with section_id): the grammar, fact and contract checks on one section's saved text, with its content_rev. scope \"piece\": the final contract and SEO/GEO checks on the whole piece. It also says which checks this piece's format uses.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    scope: z.enum(["analysis", "outline", "section", "piece"]),
    section_id: z.string().optional().describe("Needed for scope section"),
  },
  annotations: { readOnlyHint: true },
}, ({ piece, scope, section_id }) => run(async (c) => {
  // The input a check works from, and the steps its save tool will write: remember what was read, and hold the step briefly.
  if (scope === "section" && section_id) await noteReadSection(c, ctx.clientId, section_id);
  else await noteReadPiece(c, ctx.clientId, piece, scope === "analysis" ? ["scope", "research", "outline"] : scope === "outline" ? ["outline"] : ["final"]);
  const input = await getReviewInput(c, piece, scope, section_id);
  const notice = scope === "section" && section_id ? await readNotice(c, ctx.clientId, { section: section_id })
    : await readNotice(c, ctx.clientId, { piece, scope: scope === "piece" ? "final" : "outline" });
  return withNotice(input, notice);
}));

server.registerTool("writ_save_analysis", {
  title: "Save the gap analysis",
  description: "Saves the gap analysis (does the scope and research still answer the original topic?) in the piece's own field, so Writ shows it. Use the numbers from writ_get_check_input. At most 4 gaps, each with one question the company's expert could answer. Replaces an earlier analysis.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    verdict: z.enum(["aligned", "partly", "drifted"]),
    summary: z.string().describe("One or two sentences"),
    drift: z.array(z.object({ text: z.string(), items: z.array(z.number().int()).optional(), points: z.array(z.number().int()).optional() })).optional()
      .describe("What has moved away from the topic, by theme; items are research numbers, points are scope point numbers"),
    gaps: z.array(z.object({ text: z.string(), expert_question: z.string(), points: z.array(z.number().int()).optional() })).max(4).optional(),
    contract_suggestions: z.array(z.object({ change: z.string(), why: z.string() })).optional().describe("Suggested changes to the scope; the writer decides"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, ...a }) => run((c) => lockedOutline(c, piece, () => saveAnalysis(c, piece, a))));

server.registerTool("writ_mark_findings", {
  title: "Record decisions on analysis findings",
  description: "Marks findings of the saved gap analysis as ignored, resolved, or open again, as the writer decides. Findings are addressed by position: gap-0, drift-1, suggestion-0.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    marks: z.array(z.object({ finding: z.string(), state: z.enum(["ignored", "resolved", "open"]) })),
    writer_approved: approved("these decisions"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, marks }) => run((c) => lockedOutline(c, piece, () => markFindings(c, piece, marks))));

server.registerTool("writ_apply_alignment_fixes", {
  title: "Apply fixes from the gap analysis",
  description: "Applies the writer's chosen fixes through Writ: reject research items, edit, remove or add scope points, and add sections. Numbers are the ones from writ_get_check_input. Works only while the outline is open. Numbers change afterwards, so read the input again. Reversing a fix is done in Writ.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    fixes: z.object({
      reject_items: z.array(z.number().int()).optional().describe("Research numbers to reject"),
      edit_points: z.array(z.object({ point: z.number().int(), text: z.string() })).optional(),
      remove_points: z.array(z.number().int()).optional(),
      add_points: z.array(z.string()).optional(),
      add_sections: z.array(z.object({ heading: z.string(), purpose: z.string().optional(), covers: z.array(z.number().int()).optional().describe("Existing scope point numbers only; to cover a new point, add the point in one call and the section in the next") })).optional(),
    }),
    resolves: z.array(z.string()).optional().describe("Findings these fixes close (gap-0, drift-1, suggestion-0)"),
    writer_approved: approved("these fixes"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ piece, fixes, resolves }) => run((c) => lockedOutline(c, piece, () => lockedPiece(c, piece, "scope", () => lockedPiece(c, piece, "research", () => applyAlignmentFixes(c, piece, fixes, resolves))))));

server.registerTool("writ_add_expert_answer", {
  title: "Add the writer's own answer to the research",
  description: "Records the writer's own answer to a gap's expert question as an insight card and adds it to the piece's approved research, through Writ. Use the writer's words, not a paraphrase.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    answer: z.string().describe("The writer's answer, in their own words"),
    writer_approved: approved("adding this answer to the research"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, ({ piece, answer }) => run((c) => lockedOutline(c, piece, () => lockedPiece(c, piece, "research", () => addExpertAnswer(c, piece, answer), { append: true }))));

server.registerTool("writ_save_outline_checks", {
  title: "Save the outline's SEO and GEO check",
  description: "Saves the outline's SEO and GEO check results in the piece's own field, so Writ shows them. One entry per check; use the check keys from writ_get_check_input.",
  inputSchema: { piece: z.string().describe("The piece code (SI-0012) or id"), checks: z.array(seoGeoCheck) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, checks }) => run((c) => lockedOutline(c, piece, () => saveOutlineChecks(c, piece, checks))));

server.registerTool("writ_save_section_checks", {
  title: "Save a section's check results",
  description: "Saves the grammar, fact and contract check results for one section, stamped with the text version they were run on (content_rev from writ_get_check_input). Refuses if the text has changed since. These are advisory.",
  inputSchema: {
    section_id: z.string().describe("The section id"),
    content_rev: z.number().int().describe("The content_rev from writ_get_check_input"),
    grammar: z.object({ suggestions: z.array(z.object({ original: z.string(), replacement: z.string(), reason: z.string().optional() })) }).optional(),
    fact: z.object({ flags: z.array(z.object({ sentence: z.string(), kind: z.enum(["unsupported", "mismatch"]), issue: z.string(), item: z.number().int().optional() })) }).optional()
      .describe("item is the research number for a mismatch; leave it out or use 0 for unsupported"),
    contract: z.object({ results: z.array(contractResult) }).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ section_id, content_rev, grammar, fact, contract }) => run((c) => lockedSection(c, section_id, () => saveSectionChecks(c, section_id, content_rev, { grammar, fact, contract }))));

server.registerTool("writ_save_final_checks", {
  title: "Save the final checks",
  description: "Saves the final contract check (does the whole piece deliver every scope point?) and/or the final SEO and GEO check, with the meta title and description, in the piece's own fields so Writ shows them. These are advisory.",
  inputSchema: {
    piece: z.string().describe("The piece code (SI-0012) or id"),
    contract: z.object({ results: z.array(contractResult) }).optional(),
    seo_geo: z.object({ checks: z.array(seoGeoCheck), meta_title: z.string().optional(), meta_description: z.string().optional() }).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, ({ piece, contract, seo_geo }) => run((c) => lockedPiece(c, piece, "final", () => saveFinalChecks(c, piece, { contract, seo_geo }))));

server.registerPrompt("onboarding", {
  title: "Get started with Writ",
  description: "A step-by-step guide to what you can do with Writ in Claude and how to do it.",
}, () => ({
  messages: [{ role: "user", content: { type: "text", text: ONBOARDING } }],
}));

server.registerPrompt("new_piece", {
  title: "Start a new piece",
  description: "Takes you from idea to a first draft: the brief, scope, research, outline, then each section's talking points and draft, asking for your feedback at every step. The piece stays in Writ for your review.",
  argsSchema: { idea: z.string().optional().describe("Your idea for the piece, in a few words") },
}, ({ idea }) => {
  const rules = `${NEW_PIECE_RULES}${DRAFT_RULES}\n${NEW_PIECE_FINISH}`;
  return { messages: [{ role: "user", content: { type: "text", text: idea ? `${rules}\n\nThe writer's idea: ${idea}` : rules } }] };
});

server.registerPrompt("write_section", {
  title: "Write a section the Writ way",
  description: "Drafts one prepared section from its talking points and approved research, in the company's voice, and saves it to Writ.",
  argsSchema: { section_id: z.string().describe("The section id from writ_get_piece"), piece: z.string().describe("The piece code, for example SI-0012") },
}, ({ section_id, piece }) => ({
  messages: [{ role: "user", content: { type: "text", text: `${DRAFT_RULES}\n\nSection id: ${section_id}\nPiece: ${piece}` } }],
}));

return server;
}
