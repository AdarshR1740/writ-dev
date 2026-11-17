import type { SupabaseClient } from "@supabase/supabase-js";
import { FORMAT_PRESETS } from "./format-presets.js";
import { describePiece, type PieceFacts } from "./step-views.js";
import { CLIENT_ID } from "./client-id.js";

/**
 * Everything the MCP tools do against Writ, as plain functions over a signed-in Supabase client. The client carries the
 * writer's own login, so Writ's row-level security decides what they can see and change, exactly as in the web app.
 */

export class WritError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new WritError(`${what}: ${r.error.message}`);
  if (r.data === null) throw new WritError(`${what}: not found (or you don't have access).`);
  return r.data;
}

interface PieceRow {
  id: string;
  code: string;
  title: string;
  topic: string;
  primary_keyword: string;
  goal: string;
  audience_notes: string;
  stage: string;
  company_id: string;
  format_id: string | null;
  outline_confirmed_at: string | null;
  recipe: Recipe | null;
  updated_at: string;
}

interface SectionRow {
  id: string;
  piece_id: string;
  position: number;
  /** 2 for a main heading (H2), 3 for a sub-heading (H3) under the main heading above it. Missing on a Writ database that predates sub-headings. */
  level?: number;
  depth?: string;
  heading: string;
  purpose: string;
  status: "research" | "brief" | "writing" | "written";
  brief: { text: string; refs: string[] }[] | null;
  content: string;
  ai_draft: string | null;
  structure: { type?: string; kind?: string; text?: string }[] | null;
  points: { points?: { point: string; direction: string; evidence: string; refs: string[]; sub_section: string }[] } | null;
  expectation_ids: string[];
}

export async function listPieces(db: SupabaseClient, opts: { stage?: string; limit?: number }) {
  let q = db.from("pieces").select("code, title, stage, primary_keyword, updated_at").order("updated_at", { ascending: false }).limit(Math.min(opts.limit ?? 20, 50));
  if (opts.stage) q = q.eq("stage", opts.stage);
  return must(await q, "Could not list pieces");
}

/** A piece is named by its code (like SI-0012) or by its id. */
export async function findPiece(db: SupabaseClient, ref: string): Promise<PieceRow> {
  const key = ref.trim();
  if (!key) throw new WritError("Name the piece by its code (for example SI-0012).");
  const base = db.from("pieces").select("id, code, title, topic, primary_keyword, goal, audience_notes, stage, company_id, format_id, outline_confirmed_at, recipe, updated_at");
  const r = UUID.test(key) ? await base.eq("id", key).maybeSingle() : await base.ilike("code", key.replace(/[\\%_]/g, "\\$&")).maybeSingle();
  return must(r as { data: PieceRow | null; error: { message: string } | null }, `Piece ${key}`);
}

/**
 * A piece's sections with their heading level and depth. A Writ database that predates sub-headings has no such columns;
 * its sections are all main headings, so the read is repeated without them.
 */
async function sectionRows(db: SupabaseClient, pieceId: string, columns: string) {
  const r = await db.from("piece_sections").select(`${columns}, level, depth`).eq("piece_id", pieceId).order("position");
  if (r.error && /\b(level|depth)\b/i.test(r.error.message)) return db.from("piece_sections").select(columns).eq("piece_id", pieceId).order("position");
  return r;
}

/** The main heading a row sits under: the nearest level 2 row before it. Empty for a main heading. */
function parentOf<T extends { level?: number; heading: string }>(rows: T[], index: number): string {
  if (rows[index].level !== 3) return "";
  for (let i = index - 1; i >= 0; i -= 1) if (rows[i].level !== 3) return rows[i].heading;
  return "";
}

export async function getPiece(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  const [contract, sections] = await Promise.all([
    db.from("piece_contracts").select("core_question, expectations, confirmed_at").eq("piece_id", piece.id).maybeSingle(),
    sectionRows(db, piece.id, "id, position, heading, purpose, status, expectation_ids, content, ai_draft, points"),
  ]);
  const rows = must(sections as { data: unknown; error: { message: string } | null }, "Could not read the outline") as unknown as Pick<SectionRow, "id" | "position" | "level" | "depth" | "heading" | "purpose" | "status" | "expectation_ids" | "content" | "ai_draft" | "points">[];
  return {
    code: piece.code,
    title: piece.title,
    stage: piece.stage,
    topic: piece.topic,
    primary_keyword: piece.primary_keyword,
    goal: piece.goal,
    audience_notes: piece.audience_notes,
    outline_confirmed: Boolean(piece.outline_confirmed_at),
    ai_drafts_allowed: piece.recipe?.writing?.ai_draft === true,
    workflow: workflowOf(piece.recipe),
    reader_contract: contract.data ?? null,
    sections: rows.map((s, i) => ({
      id: s.id,
      position: s.position,
      level: s.level === 3 ? 3 : 2,
      depth: s.depth ?? "standard",
      parent: parentOf(rows, i) || undefined,
      heading: s.heading,
      purpose: s.purpose,
      status: s.status,
      prepared: Boolean(s.points?.points?.length),
      words: s.content.trim() ? s.content.trim().split(/\s+/).length : 0,
      has_ai_draft: Boolean(s.ai_draft),
    })),
  };
}

/** The same numbered, linkable research the web app hands its own drafting step. */
async function sectionResearch(db: SupabaseClient, pieceId: string, sectionId: string) {
  const r = await db.from("research_items").select("id, statement, source_type, sources(title, url)")
    .eq("piece_id", pieceId).eq("status", "approved").eq("scope", "section").eq("section_key", sectionId).order("created_at").order("id");
  return must(r, "Could not read the research").map((row, i) => {
    const src = Array.isArray(row.sources) ? row.sources[0] : row.sources;
    return { n: i + 1, id: row.id as string, statement: row.statement as string, type: row.source_type as string,
      source: (src?.title as string) || (src?.url as string) || "", url: (src?.url as string) || "" };
  });
}

/** Brand context the writer's company keeps in Writ: how it writes, and the rules learned from past edits. */
export async function getVoice(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  const [docs, memory, format] = await Promise.all([
    db.from("context_documents").select("kind, format_id, content").eq("company_id", piece.company_id).in("kind", ["core_voice", "format_profile", "icp", "positioning"]),
    db.from("voice_memory").select("rule").eq("company_id", piece.company_id).order("created_at"),
    piece.format_id ? db.from("formats").select("name, description").eq("id", piece.format_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  const rows = must(docs, "Could not read the company's voice") as { kind: string; format_id: string | null; content: string }[];
  const text = (kind: string, formatId?: string | null) => rows.find((d) => d.kind === kind && (formatId === undefined || d.format_id === formatId))?.content.trim() ?? "";
  return {
    core_voice: text("core_voice"),
    format: format.data ?? null,
    format_profile: piece.format_id ? text("format_profile", piece.format_id) : "",
    audience_icp: text("icp"),
    positioning: text("positioning"),
    voice_rules: (must(memory, "Could not read the voice rules") as { rule: string }[]).map((m) => m.rule),
  };
}

export async function getSection(db: SupabaseClient, sectionId: string) {
  if (!UUID.test(sectionId.trim())) throw new WritError("section_id must be the id shown by writ_get_piece.");
  const s = must(await db.from("piece_sections").select("*").eq("id", sectionId.trim()).maybeSingle(), "Section") as SectionRow;
  const pieceRow = must(await db.from("pieces").select("code, title, topic, primary_keyword, goal, audience_notes, company_id, format_id, recipe").eq("id", s.piece_id).maybeSingle(), "Piece") as
    Pick<PieceRow, "code" | "title" | "topic" | "primary_keyword" | "goal" | "audience_notes" | "company_id" | "format_id" | "recipe">;
  const [outline, research, contract] = await Promise.all([
    sectionRows(db, s.piece_id, "id, position, heading, purpose"),
    sectionResearch(db, s.piece_id, s.id),
    db.from("piece_contracts").select("core_question, expectations").eq("piece_id", s.piece_id).maybeSingle(),
  ]);
  const cite = (id: string) => research.find((r) => r.id === id)?.n;
  const points = s.points?.points ?? [];
  const outlineRows = must(outline as { data: unknown; error: { message: string } | null }, "Could not read the outline") as unknown as { id: string; position: number; level?: number; heading: string; purpose: string }[];
  const at = outlineRows.findIndex((r) => r.id === s.id);
  return {
    piece: { code: pieceRow.code, title: pieceRow.title, topic: pieceRow.topic, primary_keyword: pieceRow.primary_keyword, goal: pieceRow.goal, audience_notes: pieceRow.audience_notes },
    reader_question: contract.data?.core_question ?? "",
    outline: outlineRows.map((r) => ({ position: r.position, level: r.level === 3 ? 3 : 2, heading: r.heading, purpose: r.purpose })),
    section: { id: s.id, position: s.position, level: s.level === 3 ? 3 : 2, depth: s.depth ?? "standard", parent: (at >= 0 ? parentOf(outlineRows, at) : "") || undefined, heading: s.heading, purpose: s.purpose, status: s.status, planned_structure: s.structure ?? [] },
    talking_points: points.length
      ? points.map((p, i) => ({
        n: i + 1, point: p.point, direction: p.direction || undefined, for: p.sub_section || undefined,
        evidence: p.evidence ? p.evidence : "no evidence: the writer's own view, add no facts",
        cite: p.refs.map(cite).filter((n): n is number => n !== undefined),
      }))
      : (s.brief ?? []).map((b, i) => ({ n: i + 1, point: b.text, evidence: b.refs.length ? "see research" : "no evidence: the writer's own view, add no facts", cite: b.refs.map(cite).filter((n): n is number => n !== undefined) })),
    approved_research: research.map(({ id: _id, ...rest }) => rest),
    current_text: s.content,
    existing_ai_draft: s.ai_draft,
    ai_drafts_allowed: pieceRow.recipe?.writing?.ai_draft === true,
  };
}

/**
 * Save a draft the way Writ's own AI drafting does: as the section's AI draft, and as its text when the writer hasn't
 * written any yet. The writer then reviews and edits it in Writ. The section is marked as started from an AI draft, which
 * is what the sign-off record uses to say so. Nothing is saved over text the writer has already written.
 */
export async function saveSectionDraft(db: SupabaseClient, sectionId: string, text: string) {
  const body = text.trim();
  if (!body) throw new WritError("The draft is empty.");
  if (body.length > 60000) throw new WritError("The draft is too long for one section.");
  if (/^#{1,2}\s/m.test(body)) throw new WritError("Remove any # or ## headings: the section's own heading is added separately. Use ### and ####.");
  const s = must(await db.from("piece_sections").select("*").eq("id", sectionId.trim()).maybeSingle(), "Section") as
    Pick<SectionRow, "id" | "piece_id" | "level" | "status" | "content" | "heading" | "ai_draft">;
  // A sub-heading's own heading is added when the piece is put together, and anything inside it is #### at most.
  if (s.level === 3 && /^#{1,3}\s/m.test(body)) throw new WritError("This section is a sub-heading (H3): its own heading is added separately, so use #### for anything inside it.");
  if (s.status === "written") throw new WritError("This section is already marked as written. Reopen it in Writ first.");
  if (s.status === "research") throw new WritError("This section isn't prepared yet. Prepare it in Writ (research, then talking points or a brief) first.");
  const piece = must(await db.from("pieces").select("recipe").eq("id", s.piece_id).maybeSingle(), "Piece") as Pick<PieceRow, "recipe">;
  if (piece.recipe?.writing?.ai_draft !== true) throw new WritError("AI drafts are switched off for this piece's recipe in Writ.");
  // The section text is replaced when it is empty, or when it is still exactly the last AI draft (the writer has not touched
  // it), so a revision made in chat lands in the editor. Anything the writer has changed is never overwritten.
  const untouched = Boolean(s.ai_draft?.trim()) && s.content.trim() === s.ai_draft!.trim();
  let replaced = !s.content.trim() || untouched;
  // Replacing the text is conditional on it still being what was read, so text the writer types in Writ in the meantime is never lost.
  let r = replaced
    ? await db.from("piece_sections").update({ ai_draft: body, content: body }).eq("id", s.id).eq("content", s.content).select("id")
    : await db.from("piece_sections").update({ ai_draft: body }).eq("id", s.id).select("id");
  must(r, "Could not save the draft");
  if (replaced && !r.data?.length) {
    replaced = false;
    r = await db.from("piece_sections").update({ ai_draft: body }).eq("id", s.id).select("id");
    must(r, "Could not save the draft");
  }
  if (!r.data?.length) throw new WritError("Could not save the draft: no access to this section.");
  return {
    saved: true,
    section: s.heading,
    became_section_text: replaced,
    note: replaced
      ? "Saved as the section's text and its AI draft. The writer reviews and edits it in Writ."
      : "The writer already has text here, so it was kept. Your draft is saved as the AI draft beside it for the writer to compare.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting a piece and setting its scope (the "contract" stage). Pieces are created and confirmed through Writ's own
// functions (create_piece, confirm_contract), which check membership, write the editorial record and move the stage.
// Clients cannot insert pieces directly, and must not write the stage themselves.
// ---------------------------------------------------------------------------------------------------------------------

/** The parts of a workflow recipe that the chat flow needs to know about. */
type Recipe = {
  brief?: Record<string, boolean>;
  contract?: { mode?: string };
  research?: { web_search?: boolean; review?: boolean; serp?: boolean };
  analysis?: { enabled?: boolean; gaps?: boolean; contract_suggestions?: boolean };
  outline?: { mode?: string; template?: string[]; seo_geo_check?: boolean };
  sections?: { timing?: string; research?: boolean };
  writing?: { ai_draft?: boolean };
  checks?: { grammar?: boolean; fact?: boolean; contract?: boolean; seo?: boolean; geo?: boolean };
};

/**
 * What a format's recipe means for the conversation. Every step is offered for every format; this says how heavy each is
 * and what the format has already settled (a fixed outline's sections exist before anything is written).
 */
export function workflowOf(recipe: Recipe | null | undefined) {
  const r = recipe ?? {};
  const askFor = Object.entries(r.brief ?? {}).filter(([, on]) => on).map(([k]) => k);
  return {
    scope: r.contract?.mode ?? "full",
    research: { web_search: r.research?.web_search ?? true, review: r.research?.review ?? true, serp: r.research?.serp === true },
    gap_analysis: { on: r.analysis?.enabled === true, gaps: r.analysis?.gaps === true, scope_suggestions: r.analysis?.contract_suggestions === true },
    outline: r.outline?.mode ?? "free",
    outline_seo_geo_check: r.outline?.seo_geo_check === true,
    section_research: r.sections?.research === true,
    checks: {
      grammar: r.checks?.grammar === true, fact: r.checks?.fact === true,
      contract: r.checks?.contract === true && r.contract?.mode !== "off", seo: r.checks?.seo === true, geo: r.checks?.geo === true,
    },
    ...(r.outline?.mode === "fixed" && r.outline.template?.length ? { fixed_sections: r.outline.template } : {}),
    brief_asks_for: askFor,
    ai_drafts: r.writing?.ai_draft !== false,
  };
}

/** The company-level documents Writ writes every piece against (the "house file"). Format style profiles are set in the web app. */
export const HOUSE_KINDS = ["icp", "core_voice", "positioning", "strategy_notes"] as const;
export type HouseKind = (typeof HOUSE_KINDS)[number];
/** The first three are needed for good drafts; strategy notes are optional (as in the web app). */
export const REQUIRED_HOUSE_KINDS: HouseKind[] = ["icp", "core_voice", "positioning"];

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * Where the writer stands: the companies they belong to, each with its formats, how much of the house file is filled,
 * and how many pieces it has. With no companies, the writer is new and needs to create one.
 */
export async function getSetup(db: SupabaseClient) {
  const companies = must(await db.from("companies").select("id, name").order("name"), "Could not read your companies") as { id: string; name: string }[];
  const formats = must(await db.from("formats").select("id, company_id, name, description, template_key, recipe").order("name"), "Could not read the formats") as
    { id: string; company_id: string; name: string; description: string; template_key?: string | null; recipe?: Recipe | null }[];
  const docs = must(await db.from("context_documents").select("company_id, kind, format_id, content"), "Could not read the company documents") as
    { company_id: string; kind: string; format_id: string | null; content: string }[];
  const pieces = must(await db.from("pieces").select("company_id"), "Could not count the pieces") as { company_id: string }[];
  return companies.map((c) => {
    const mine = docs.filter((d) => d.company_id === c.id);
    const house = Object.fromEntries(HOUSE_KINDS.map((k) => {
      const d = mine.find((x) => x.kind === k && !x.format_id);
      return [k, { exists: Boolean(d), filled: Boolean(d?.content.trim()), words: words(d?.content ?? "") }];
    }));
    return {
      company: c.name,
      company_id: c.id,
      house_file: house,
      house_file_ready: REQUIRED_HOUSE_KINDS.every((k) => house[k].filled),
      pieces: pieces.filter((p) => p.company_id === c.id).length,
      formats: formats.filter((f) => f.company_id === c.id).map((f) => ({
        id: f.id, name: f.name, description: f.description, template_key: f.template_key ?? null,
        style_profile_filled: Boolean(mine.find((d) => d.format_id === f.id)?.content.trim()),
        workflow: workflowOf(f.recipe),
      })),
    };
  });
}

type Setup = Awaited<ReturnType<typeof getSetup>>;

/** The company a request is about: the one named (by name or id), or the only one the writer has. */
function pickCompany(setup: Setup, want?: string) {
  if (!setup.length) throw new WritError("You are not a member of any company in Writ yet. Create one first.");
  const w = want?.trim().toLowerCase();
  const co = w ? setup.find((c) => c.company_id === w || c.company.toLowerCase() === w) : setup.length === 1 ? setup[0] : undefined;
  if (!co) throw new WritError(`Say which company this is for: ${setup.map((c) => c.company).join(", ")}.`);
  return co;
}

/** Creates the writer's company through Writ's create_company (they become its editor, and its empty house-file documents are made). */
export async function createCompany(db: SupabaseClient, name: string) {
  const n = name.trim();
  if (n.length < 2 || n.length > 120) throw new WritError("The company name must be 2 to 120 characters.");
  const existing = await getSetup(db);
  if (existing.some((c) => c.company.toLowerCase() === n.toLowerCase())) throw new WritError(`You already have a company called "${n}".`);
  const r = await db.rpc("create_company", { company_name: n });
  if (r.error) throw new WritError(`Could not create the company: ${r.error.message}`);
  return { created: true, company: n, company_id: String(r.data), next: "Fill in the house file: ICP, core voice and positioning." };
}

/**
 * Switches on the standard formats for a company: every template Writ offers (or just the named ones), each with its
 * workflow recipe. Formats the company already has (same template or same name) are left alone. A new format's style
 * profile starts empty: examples are added in Writ afterwards.
 */
export async function addFormats(db: SupabaseClient, a: { company?: string; templates?: string[] }) {
  const co = pickCompany(await getSetup(db), a.company);
  let chosen = FORMAT_PRESETS;
  if (a.templates?.length) {
    const want = new Set(a.templates.map((t) => t.trim().toLowerCase()));
    chosen = FORMAT_PRESETS.filter((p) => want.has(p.key) || want.has(p.name.toLowerCase()));
    const found = new Set(chosen.flatMap((p) => [p.key, p.name.toLowerCase()]));
    const unknown = [...want].filter((w) => !found.has(w));
    if (unknown.length) throw new WritError(`Unknown formats: ${unknown.join(", ")}. Available: ${FORMAT_PRESETS.map((p) => p.key).join(", ")}.`);
  }
  const have = (p: { key: string; name: string }) =>
    co.formats.some((f) => f.template_key === p.key || f.name.toLowerCase() === p.name.toLowerCase());
  const toAdd = chosen.filter((p) => !have(p));
  const skipped = chosen.filter(have).map((p) => p.name);
  if (toAdd.length) {
    const rows = toAdd.map((p) => ({ company_id: co.company_id, name: p.name, description: p.description, template_key: p.key, recipe: p.recipe }));
    const r = await db.from("formats").insert(rows).select("id");
    if (r.error) throw new WritError(`Could not add the formats: ${r.error.message}`);
  }
  return {
    company: co.company, added: toAdd.map((p) => p.name), already_there: skipped,
    note: toAdd.length ? "Each new format's style profile is empty until examples are added in Writ. Pieces work without one." : "Nothing to add: the company already has these formats.",
  };
}

/** The company's house-file documents with their text, so they can be shown, improved or replaced. */
export async function getContextDocuments(db: SupabaseClient, company?: string) {
  const co = pickCompany(await getSetup(db), company);
  const rows = must(await db.from("context_documents").select("kind, content, version, updated_at").eq("company_id", co.company_id).is("format_id", null), "Could not read the documents") as
    { kind: string; content: string; version: number; updated_at: string }[];
  return {
    company: co.company,
    documents: HOUSE_KINDS.map((k) => {
      const d = rows.find((r) => r.kind === k);
      return { kind: k, exists: Boolean(d), filled: Boolean(d?.content.trim()), words: words(d?.content ?? ""), version: d?.version ?? null, content: d?.content ?? "" };
    }),
  };
}

/**
 * Saves one house-file document as Markdown. The rows are made when the company is created, so this only updates one.
 * It never replaces text that is already there unless told to: the writer decides that.
 */
export async function saveContextDocument(db: SupabaseClient, a: { kind: string; content: string; company?: string; replace?: boolean }) {
  if (!(HOUSE_KINDS as readonly string[]).includes(a.kind)) throw new WritError(`kind must be one of ${HOUSE_KINDS.join(", ")}.`);
  const text = a.content.trim();
  if (!text) throw new WritError("The document is empty.");
  if (text.length > 60000) throw new WritError("The document is too long (60,000 characters at most).");
  const co = pickCompany(await getSetup(db), a.company);
  const row = must(await db.from("context_documents").select("id, content, version").eq("company_id", co.company_id).eq("kind", a.kind).is("format_id", null).maybeSingle(),
    `The ${a.kind} document of ${co.company}`) as { id: string; content: string; version: number };
  if (row.content.trim() && !a.replace) {
    throw new WritError(`This document already has ${words(row.content)} words. Show the writer what is there and ask whether to replace it; only then save with replace set to true.`);
  }
  // The web app lets AI propose changes to a document for the writer to review. Saving here raises the document's version,
  // which would make such a proposal impossible to accept, so leave the document alone while one is waiting.
  const pending = await db.from("document_proposals").select("id").eq("document_id", row.id).eq("status", "pending");
  if (pending.error) throw new WritError(`Could not check for changes waiting for review: ${pending.error.message}`);
  if (pending.data?.length) throw new WritError("This document has changes waiting for the writer's review in Writ. Ask them to accept or reject those in Writ first, then try again.");
  const who = await db.auth.getUser();
  const patch: Record<string, unknown> = { content: text };
  if (who.data.user?.id) patch.updated_by = who.data.user.id;
  // Keyed on the version that was read, so an edit made in between is never overwritten.
  const r = await db.from("context_documents").update(patch).eq("id", row.id).eq("version", row.version).select("id");
  must(r, "Could not save the document");
  if (!r.data?.length) throw new WritError("The document changed while you were working on it, or you no longer have access. Read it again with writ_get_context_documents and check with the writer before saving.");
  return { saved: true, company: co.company, kind: a.kind, words: words(text), replaced: Boolean(row.content.trim()) };
}

/** A short format (recipe contract mode "lite") allows two points in the scope; every other format allows seven. */
const maxScopePoints = (piece: Pick<PieceRow, "recipe">) => (piece.recipe?.contract?.mode === "lite" ? 2 : 7);

export async function startPiece(db: SupabaseClient, a: {
  title: string; topic: string; keyword?: string; goal?: string; audience?: string;
  format?: string; company?: string; timing?: "just_in_time" | "up_front";
  customer?: string; approval_contact?: string; offer?: string; cta?: string;
}) {
  const title = a.title.trim();
  if (!title || title.length > 200) throw new WritError("The title must be 1 to 200 characters.");
  if (!a.topic.trim()) throw new WritError("Add the topic: what the piece is about.");
  const co = pickCompany(await getSetup(db), a.company);
  // Extra brief fields some formats ask for (a case study's customer, a promotion's offer); only the ones given are sent.
  const extra: Record<string, string> = {};
  for (const k of ["customer", "approval_contact", "offer", "cta"] as const) {
    const v = a[k]?.trim();
    if (v) extra[k] = v.slice(0, 500);
  }
  let formatId: string | null = null;
  if (a.format !== undefined) {
    const f = a.format.trim().toLowerCase();
    if (!f) throw new WritError("The format is blank. Name one, or leave it out to use the default workflow.");
    const hits = co.formats.filter((x) => x.id === f || x.name.toLowerCase() === f);
    if (!hits.length) throw new WritError(`That format does not exist for ${co.company}. Formats: ${co.formats.map((x) => x.name).join(", ") || "none"}.`);
    if (hits.length > 1) throw new WritError(`More than one format is called "${a.format.trim()}" for ${co.company}. Use the id from writ_list_formats.`);
    formatId = hits[0].id;
  }
  const r = await db.rpc("create_piece", {
    target_company: co.company_id, piece_title: title, piece_topic: a.topic.trim(), keyword: a.keyword?.trim() ?? "",
    format: formatId, piece_goal: a.goal?.trim() ?? "", audience: a.audience?.trim() ?? "", timing: a.timing ?? "", extra,
  });
  if (r.error) throw new WritError(`Could not create the piece: ${r.error.message}`);
  const piece = await findPiece(db, String(r.data));
  return {
    code: piece.code, title: piece.title, stage: piece.stage, company: co.company,
    scope_step_open: piece.stage === "contract",
    max_scope_points: maxScopePoints(piece),
    workflow: workflowOf(piece.recipe),
    house_file_ready: co.house_file_ready,
  };
}

/** Saves the scope draft: one reader question and the points the piece should include. Allowed only while the scope is open. */
export async function saveScope(db: SupabaseClient, ref: string, coreQuestion: string, points: string[]) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "contract") throw new WritError(`The scope is not open (this piece is at ${piece.stage}). Reopen it in Writ to change it.`);
  const question = coreQuestion.trim();
  if (!question || question.length > 500) throw new WritError("The core question must be 1 to 500 characters.");
  const clean = points.map((p) => p.trim()).filter(Boolean);
  const max = maxScopePoints(piece);
  if (clean.length < 1 || clean.length > max) throw new WritError(`Give 1 to ${max} points for this format.`);
  if (clean.some((p) => p.length > 300)) throw new WritError("Each point must be 300 characters or fewer.");
  const used = new Set<string>();
  const expectations = clean.map((text) => {
    let id = Math.random().toString(36).slice(2, 9);
    while (used.has(id)) id = Math.random().toString(36).slice(2, 9);
    used.add(id);
    return { id, text };
  });
  const r = await db.from("piece_contracts").update({ core_question: question, expectations }).eq("piece_id", piece.id).select("piece_id");
  must(r, "Could not save the scope");
  if (!r.data?.length) throw new WritError("Could not save the scope: no access to this piece.");
  return { saved: true, code: piece.code, core_question: question, points: clean, confirmed: false, note: "Saved as a draft. It is not confirmed until the writer approves it." };
}

/** Confirms the scope through Writ's own function, which checks it and moves the piece on to research. */
export async function confirmScope(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "contract") throw new WritError(`The scope is not open (this piece is at ${piece.stage}), so there is nothing to confirm.`);
  const r = await db.rpc("confirm_contract", { target_piece: piece.id });
  if (r.error) throw new WritError(`Could not confirm the scope: ${r.error.message}`);
  const after = await findPiece(db, piece.id);
  return { confirmed: true, code: after.code, stage: after.stage };
}

// ---------------------------------------------------------------------------------------------------------------------
// Research, outline and section preparation. As with the scope, the stage changes go through Writ's own functions
// (complete_piece_research, confirm_outline, complete_section_research, confirm_brief); nothing here writes a stage.
// ---------------------------------------------------------------------------------------------------------------------

const MIGRATION_HINT = "Saving research from Claude needs one database change in Writ that is not applied yet (migration 20261127000000_add_research_findings.sql). Ask whoever runs Writ's database to apply it.";

/** Research items of a piece (or of one section), with their sources, so they can be shown, reviewed and cited. */
export async function getResearch(db: SupabaseClient, ref: string, sectionId?: string) {
  const piece = await findPiece(db, ref);
  let q = db.from("research_items").select("id, scope, section_key, statement, quote, source_type, secondary, status, quote_status, sources(title, url)")
    .eq("piece_id", piece.id).order("created_at").order("id");
  q = sectionId ? q.eq("scope", "section").eq("section_key", sectionId.trim()) : q.eq("scope", "piece");
  const rows = must(await q, "Could not read the research") as unknown as {
    id: string; statement: string; quote: string; source_type: string; secondary: boolean; status: string; quote_status: string;
    sources: { title: string; url: string } | { title: string; url: string }[] | null;
  }[];
  return {
    code: piece.code, stage: piece.stage, scope: sectionId ? "section" : "piece",
    // "n" is the position in this list. "cite" is the number writ_get_section gives an approved section item, and is what
    // writ_save_section_points needs in "refs"; it is only set for approved items of a section.
    items: rows.map((r, i) => {
      const src = Array.isArray(r.sources) ? r.sources[0] : r.sources;
      const cite = sectionId && r.status === "approved" ? rows.slice(0, i + 1).filter((x) => x.status === "approved").length : null;
      return { n: i + 1, cite, id: r.id, status: r.status, statement: r.statement, quote: r.quote, type: r.source_type, secondary: r.secondary,
        quote_status: r.quote_status, source: src?.title ?? "", url: src?.url ?? "" };
    }),
  };
}

export interface Finding { url: string; title?: string; statement: string; quote?: string; source_type: string; secondary?: boolean; published?: string }

/** Stores what Claude found, as unreviewed items with unchecked quotes, through Writ's add_research_findings function. */
export async function addResearch(db: SupabaseClient, ref: string, findings: Finding[], sectionId?: string, auto = false, gap?: string) {
  const piece = await findPiece(db, ref);
  if (sectionId && !UUID.test(sectionId.trim())) throw new WritError("section_id must be the id shown by writ_get_piece.");
  if (gap && !/^gap-\d+$/.test(gap)) throw new WritError(`"${gap}" is not a gap id. Use gap-0, gap-1 (the position in the saved analysis).`);
  if (gap && sectionId) throw new WritError("A gap search is piece-level research: leave out section_id.");
  // Check the analysis first, so a search for a gap that cannot be recorded never saves items it cannot count.
  if (gap) {
    const analysis = await readAnalysis(db, piece.id);
    if (!analysis.gaps?.[Number(gap.slice(4))]) throw new WritError(`There is no ${gap} in the saved analysis.`);
  }
  const r = await db.rpc("add_research_findings", { target_piece: piece.id, findings, target_section: sectionId?.trim() || null, auto, gap_search: Boolean(gap) });
  if (r.error) {
    if (r.error.code === "PGRST202" || /could not find the function/i.test(r.error.message)) throw new WritError(MIGRATION_HINT);
    if (/reader contract/i.test(r.error.message)) throw new WritError(`Could not save the research: ${r.error.message}. If this format skips the scope step, research has to be added in Writ.`);
    throw new WritError(`Could not save the research: ${r.error.message}`);
  }
  const out = r.data as { item_ids?: string[]; added?: number } & Record<string, unknown>;
  // A search aimed at one gap counts toward that gap, as in the web app.
  if (gap && out.added) {
    const analysis = await readAnalysis(db, piece.id);
    const entry = analysis.gaps?.[Number(gap.slice(4))];
    if (entry) {
      entry.researched = Number(entry.researched ?? 0) + out.added;
      await writeAnalysis(db, piece.id, analysis);
    }
  }
  // When the format has research review off, Writ approves new items as they are saved. Say so instead of claiming otherwise.
  let autoApproved = 0;
  if (out.item_ids?.length) {
    const rows = await db.from("research_items").select("id, status").in("id", out.item_ids);
    autoApproved = ((rows.data ?? []) as { status: string }[]).filter((x) => x.status === "approved").length;
  }
  return {
    ...out, auto_approved: autoApproved,
    note: autoApproved
      ? `${autoApproved} item(s) were approved automatically because this format does not review research. Quotes are not checked against the pages: show the writer what was added.`
      : "Saved as unreviewed. Quotes are not checked against the pages. The writer decides which items to approve.",
  };
}

/** Records the writer's decisions on research items, one Writ call each (review_item), stopping at the first refusal. */
export async function reviewResearch(db: SupabaseClient, decisions: { item: string; decision: "approved" | "rejected" | "unreviewed"; statement?: string }[]) {
  const done: string[] = [];
  for (const d of decisions) {
    if (!UUID.test(d.item.trim())) throw new WritError(`"${d.item}" is not a research item id (use the ids from writ_get_research).`);
    const r = await db.rpc("review_item", { item: d.item.trim(), decision: d.decision, new_statement: d.statement?.trim() || null });
    if (r.error) throw new WritError(`Stopped at item ${d.item}: ${r.error.message}${done.length ? ` (${done.length} earlier decisions were saved.)` : ""}`);
    done.push(d.item);
  }
  return { decided: done.length };
}

/** Closes piece-level research through Writ's function, which checks it and moves the piece to the outline. */
export async function completeResearch(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "research") throw new WritError(`Piece research is not open (this piece is at ${piece.stage}).`);
  const r = await db.rpc("complete_piece_research", { target_piece: piece.id });
  if (r.error) throw new WritError(`Could not finish the research: ${r.error.message}`);
  const after = await findPiece(db, piece.id);
  return { completed: true, code: after.code, stage: after.stage };
}

const MAX_OUTLINE_SECTIONS = 12;

/** Saves the outline draft. "covers" lists the numbers (1-based) of the scope points a section serves. Open outlines only. */
const DEPTHS = ["short", "standard", "deep"];

export async function saveOutline(db: SupabaseClient, ref: string, sections: { heading: string; purpose?: string; covers?: number[]; id?: string; level?: number; depth?: string }[]) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "outline") throw new WritError(`The outline is not open (this piece is at ${piece.stage}).`);
  if (!sections.length) throw new WritError(`Give 1 to ${MAX_OUTLINE_SECTIONS} sections.`);
  if (sections.some((s) => s.level !== undefined && s.level !== 2 && s.level !== 3)) throw new WritError("A level is 2 (main heading) or 3 (sub-heading).");
  if (sections.some((s) => s.depth !== undefined && !DEPTHS.includes(s.depth))) throw new WritError("A depth is short, standard or deep.");
  if (sections[0].level === 3) throw new WritError("The outline has to start with a main heading (level 2).");
  const contract = await db.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
  if (contract.error) throw new WritError(`Could not read the scope: ${contract.error.message}`);
  const exp = ((contract.data as { expectations?: { id: string; text: string }[] } | null)?.expectations) ?? [];
  // Writ's save_outline clears a kept section's planned structure unless it is sent back, so send back what is there.
  const existing = must(await sectionRows(db, piece.id, "id, structure, expectation_ids") as { data: unknown; error: { message: string } | null }, "Could not read the outline") as unknown as
    { id: string; structure: unknown; level?: number; expectation_ids?: string[] }[];
  const structureOf = new Map(existing.map((e) => [e.id, e.structure]));
  const coversOf = new Map(existing.map((e) => [e.id, e.expectation_ids ?? []]));
  const levelOf = new Map(existing.map((e) => [e.id, e.level === 3 ? 3 : 2]));
  // Sub-headings (level 3) count too, so a section with several leaves room: up to 40 rows in all. An outline that already has
  // sub-headings keeps that room when an older caller sends it back without levels.
  const cap = sections.some((s) => s.level === 3) || existing.some((e) => e.level === 3) ? 40 : MAX_OUTLINE_SECTIONS;
  if (sections.length > cap) throw new WritError(`Give 1 to ${cap} sections${cap > MAX_OUTLINE_SECTIONS ? " and sub-headings" : ""}.`);
  const covered = new Set<number>();
  const payload = sections.map((s) => {
    const heading = s.heading.trim();
    if (!heading || heading.length > 300) throw new WritError("Each section needs a heading of 1 to 300 characters.");
    // A format with no scope step has no scope points to cover: "covers" is then ignored rather than refused.
    // A sub-heading owes no scope points: its main heading does. A section sent without a level is the level it has now.
    const keepId = s.id && UUID.test(s.id.trim()) ? s.id.trim() : undefined;
    const effective = s.level ?? (keepId ? levelOf.get(keepId) : undefined) ?? 2;
    // "covers" left out on a section that is kept means: leave what it covers as it is. Send [] to clear it.
    const kept = keepId && s.covers === undefined && effective !== 3 ? (coversOf.get(keepId) ?? []).filter((id) => exp.some((e) => e.id === id)) : undefined;
    if (kept) for (const id of kept) covered.add(exp.findIndex((e) => e.id === id) + 1);
    const ids = kept ?? (exp.length && effective !== 3 ? (s.covers ?? []) : []).map((n) => {
      if (!Number.isInteger(n) || n < 1 || n > exp.length) throw new WritError(`"covers" must use scope point numbers 1 to ${exp.length}.`);
      covered.add(n);
      return exp[n - 1].id;
    });
    const keep = s.id && UUID.test(s.id.trim()) ? s.id.trim() : undefined;
    const structure = keep ? structureOf.get(keep) : undefined;
    // A section sent without a level keeps the one it has (a new one is a main heading), so older callers are unchanged.
    return {
      ...(keep ? { id: keep } : {}), heading, purpose: (s.purpose ?? "").trim(), expectation_ids: ids, ...(Array.isArray(structure) ? { structure } : {}),
      ...(s.level === 2 || s.level === 3 ? { level: s.level } : {}), ...(s.depth ? { depth: s.depth } : {}),
    };
  });
  const r = await db.rpc("save_outline", { target_piece: piece.id, sections: payload });
  if (r.error) throw new WritError(`Could not save the outline: ${r.error.message}`);
  // The web app hides the benchmark and shows the outline editor once an outline has been made from it; do the same.
  const prior = await db.from("pieces").select("analysis").eq("id", piece.id).maybeSingle();
  const analysis = (prior.data as { analysis?: Analysis | null } | null)?.analysis;
  if (analysis && typeof analysis === "object" && "alignment" in analysis && analysis.benchmark_done !== true) {
    await db.from("pieces").update({ analysis: { ...analysis, benchmark_done: true } }).eq("id", piece.id);
  }
  const saved = must(await db.from("piece_sections").select("id, position, heading, purpose").eq("piece_id", piece.id).order("position"), "Could not read the outline");
  const uncovered = exp.map((e, i) => ({ n: i + 1, text: e.text })).filter((e) => !covered.has(e.n));
  // A fixed outline is the format's own list of sections. Saving different ones is allowed (the writer may want that), but say so.
  const fixed = piece.recipe?.outline?.mode === "fixed" ? piece.recipe.outline.template ?? [] : [];
  const changed = fixed.length > 0 && (fixed.length !== payload.length || fixed.some((h, i) => h !== payload[i].heading));
  return {
    saved: true, code: piece.code, sections: saved, scope_points_not_covered: uncovered, confirmed: false,
    ...(changed ? { differs_from_fixed_outline: true, fixed_outline: fixed, note: "This format has a fixed outline, and these sections differ from it. Check that the writer wants that." } : {}),
  };
}

// ---------------------------------------------------------------------------
// Edit locks: one person or one Claude at a time on the outline, and on each section's text
// ---------------------------------------------------------------------------

export type LockScope = "scope" | "research" | "outline" | "section" | "final";
type LockResult = { ok: true; token?: string } | { ok: false; holder_label: string; holder_kind: string; since: string; expires_at: string };

const LOCK_WORDS: Record<LockScope, string> = {
  scope: "the scope", research: "the research", outline: "the outline", section: "the section", final: "the final checks and sign-off",
};

/** The message Claude gets when the writer (or another Claude) holds the lock. It says what happened and what to do. */
export function lockedMessage(r: { holder_label: string; since: string }, scope: LockScope): string {
  const t = new Date(r.since);
  const at = Number.isNaN(t.getTime()) ? "" : ` (since ${t.toISOString().slice(11, 16)} UTC)`;
  return `${r.holder_label} is editing ${LOCK_WORDS[scope]} in Writ${at}. Nothing was saved. Tell the writer, and ask them to finish or to take over from the banner in Writ; then try again. Do not retry in a loop.`;
}

/** How long Claude keeps a lock after its last write on that step. */
export const AI_LEASE_SECONDS = 60;

const lockFunctionsMissing = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || /acquire_lock/.test(e.message ?? "");

// ---------------------------------------------------------------------------
// Step versions: Claude must not save over a step that changed after it read it
// ---------------------------------------------------------------------------

const NIL_SECTION = "00000000-0000-0000-0000-000000000000";

/** What each connection last read of each step: the version (a timestamp the database keeps) it saw. In memory, per connection. */
const seenVersions = new Map<string, string>();
const versionKey = (clientId: string, pieceId: string, scope: LockScope, sectionId: string | null) =>
  `${clientId}|${pieceId}|${scope}|${scope === "section" ? sectionId ?? "" : ""}`;

type Version = { ok: true; version: string; by: string } | { ok: false };
const versionsMissing = (e: { code?: string; message?: string }) =>
  e.code === "42P01" || e.code === "PGRST205" || (/step_versions/.test(e.message ?? "") && /does not exist|schema cache|Could not find/i.test(e.message ?? ""));

async function readVersion(db: SupabaseClient, pieceId: string, scope: LockScope, sectionId: string | null): Promise<Version> {
  const r = await db.from("step_versions").select("version, changed_by_label").eq("piece_id", pieceId).eq("scope", scope)
    .eq("section_id", scope === "section" && sectionId ? sectionId : NIL_SECTION).maybeSingle();
  // A database without step versions yet behaves as before: nothing is checked.
  if (r.error) {
    if (versionsMissing(r.error)) return { ok: false };
    throw new WritError(`Could not check whether ${LOCK_WORDS[scope]} has changed: ${r.error.message}`);
  }
  const row = r.data as { version?: string; changed_by_label?: string } | null;
  return { ok: true, version: row?.version ?? "none", by: row?.changed_by_label ?? "Someone" };
}

/** Remembers that this connection has read these steps, at the version they are at now. Call it before returning the content. */
export async function noteRead(db: SupabaseClient, clientId: string, pieceId: string, steps: { scope: LockScope; sectionId?: string | null }[]): Promise<void> {
  for (const s of steps) {
    try {
      const v = await readVersion(db, pieceId, s.scope, s.sectionId ?? null);
      if (v.ok) seenVersions.set(versionKey(clientId, pieceId, s.scope, s.sectionId ?? null), v.version);
    } catch {
      // A read must never fail because the version could not be noted; a later save will ask for a re-read.
    }
  }
}

/** noteRead for a piece's four piece-wide steps, by piece code or id. */
export async function noteReadPiece(db: SupabaseClient, clientId: string, ref: string, scopes: ("scope" | "research" | "outline" | "final")[] = ["scope", "research", "outline", "final"]): Promise<void> {
  try {
    const piece = await findPiece(db, ref);
    await noteRead(db, clientId, piece.id, scopes.map((scope) => ({ scope })));
  } catch {
    // The read itself reports a missing piece.
  }
}

/** noteRead for one section (and the piece it belongs to). */
export async function noteReadSection(db: SupabaseClient, clientId: string, sectionId: string): Promise<void> {
  try {
    const id = sectionId.trim();
    if (!UUID.test(id)) return;
    const s = (await db.from("piece_sections").select("piece_id").eq("id", id).maybeSingle()).data as { piece_id: string } | null;
    if (s) await noteRead(db, clientId, s.piece_id, [{ scope: "section", sectionId: id }]);
  } catch {
    // As above.
  }
}

const atUtc = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : ` at ${t.toISOString().slice(11, 16)} UTC`;
};

export function changedMessage(by: string, scope: LockScope, version: string): string {
  return `${by} changed ${LOCK_WORDS[scope]}${atUtc(version)}, after you last read it. Nothing was saved. Do not merge it or save over it yourself: read it again, tell the writer what changed, and ask how they want the two versions combined before you save anything.`;
}

export function notReadMessage(scope: LockScope): string {
  return `You have not read ${LOCK_WORDS[scope]} in this conversation, so Writ cannot tell whether it has changed since. Nothing was saved. Read it first (writ_get_piece, writ_get_section, writ_get_research or writ_get_check_input), then save.`;
}

/**
 * Runs a write while holding the lock on a step, and keeps holding it for the lease afterwards. If someone else holds it, nothing is
 * written and Claude is told who and what to do. The write also needs Claude to have read the step first, and refuses when the step
 * changed since (even if the other writer's lock has long expired). An append (new research) needs neither the read nor the match.
 * A Writ database without the lock functions, or without step versions, behaves as before.
 */
export async function withLock<T>(db: SupabaseClient, pieceId: string, scope: LockScope, sectionId: string | null, fn: () => Promise<T>, clientId: string = CLIENT_ID, opts: { append?: boolean } = {}): Promise<T> {
  const args = { target_piece: pieceId, lock_scope: scope, target_section: sectionId, client: clientId };
  const r = await db.rpc("acquire_lock", { ...args, kind: "ai", take_over: false, lease_seconds: AI_LEASE_SECONDS });
  if (r.error) {
    if (lockFunctionsMissing(r.error)) return fn();
    throw new WritError(`Could not check the edit lock: ${r.error.message}`);
  }
  const res = r.data as LockResult;
  if (res && res.ok === false) throw new WritError(lockedMessage(res, scope));
  // The lock is not released after the write. Claude keeps it for the lease (AI_LEASE_SECONDS), renewed by each further write,
  // so a person cannot start typing in the middle of Claude's work; it expires on its own once Claude stops.
  const letGo = () => Promise.resolve(db.rpc("release_lock", { ...args, lock_token: (res as { token?: string }).token ?? null })).then(() => undefined, () => undefined);

  let before: Version;
  try {
    before = await readVersion(db, pieceId, scope, sectionId);
  } catch (e) {
    await letGo();
    throw e;
  }
  const key = versionKey(clientId, pieceId, scope, sectionId);
  let current = false;
  if (before.ok) {
    const seen = seenVersions.get(key);
    if (!opts.append) {
      if (seen === undefined) { await letGo(); throw new WritError(notReadMessage(scope)); }
      if (seen !== before.version) { await letGo(); throw new WritError(changedMessage(before.by, scope, before.version)); }
    }
    current = seen !== undefined && seen === before.version;
  }
  // Some writes also move other steps on (saving an outline can change a section's heading; a section's points can copy research).
  // Note those steps' versions first, so that Claude's own effect on them is not taken for someone else's change afterwards.
  const alsoTouched = before.ok ? await versionsOfRelated(db, clientId, pieceId, scope) : new Map<string, Version>();
  const result = await fn();
  // Claude's own write moves the version on. Keep its picture current, but only if nothing else had changed before it wrote.
  if (before.ok && current) {
    const after = await readVersion(db, pieceId, scope, sectionId).catch((): Version => ({ ok: false }));
    if (after.ok) seenVersions.set(key, after.version);
  }
  for (const [k, was] of alsoTouched) {
    if (!was.ok || seenVersions.get(k) !== was.version) continue; // Claude had not read it, or it was already stale
    const [, , rScope, rSection] = k.split("|");
    const now = await readVersion(db, pieceId, rScope as LockScope, rSection || null).catch((): Version => ({ ok: false }));
    // Only a change made by Claude itself is taken over; a writer's change stays a change Claude has not seen.
    if (now.ok && now.version !== was.version && now.by.startsWith("Claude (for ")) seenVersions.set(k, now.version);
  }
  return result;
}

/** The versions, right now, of the other steps this connection has read that a write on `scope` may also move. */
async function versionsOfRelated(db: SupabaseClient, clientId: string, pieceId: string, scope: LockScope): Promise<Map<string, Version>> {
  const out = new Map<string, Version>();
  const prefix = (s: LockScope) => `${clientId}|${pieceId}|${s}|`;
  const watch = scope === "outline" ? prefix("section") : scope === "section" ? prefix("research") : null;
  if (!watch) return out;
  for (const k of seenVersions.keys()) {
    if (!k.startsWith(watch)) continue;
    const [, , rScope, rSection] = k.split("|");
    out.set(k, await readVersion(db, pieceId, rScope as LockScope, rSection || null).catch((): Version => ({ ok: false })));
  }
  return out;
}

/**
 * Called by the tools Claude reads a step with before it writes (a section, a check's input). Takes the lock for a short while, so
 * the writer cannot start typing while Claude drafts, and reports back when someone else already holds it, so Claude can stop
 * before it spends time drafting. Returns the notice to show Claude, or null.
 */
export const AI_READ_LEASE_SECONDS = 120;
export async function claimForRead(db: SupabaseClient, clientId: string, pieceId: string, scope: LockScope, sectionId: string | null): Promise<string | null> {
  try {
    const r = await db.rpc("acquire_lock", { target_piece: pieceId, lock_scope: scope, target_section: sectionId, client: clientId, kind: "ai", take_over: false, lease_seconds: AI_READ_LEASE_SECONDS });
    if (r.error) return null;
    const res = r.data as LockResult;
    if (res && res.ok === false) {
      return `${res.holder_label} is editing ${LOCK_WORDS[scope]} in Writ right now${atUtc(res.since)}. Do not start drafting from this until they finish: a save would be refused. Tell the writer, and try again later.`;
    }
  } catch {
    // Reading never fails because of a lock.
  }
  return null;
}

/** claimForRead for a read that names a section, or a piece's step, by id or code. Never throws. */
export async function readNotice(db: SupabaseClient, clientId: string, target: { section: string } | { piece: string; scope: "outline" | "final" }): Promise<string | null> {
  try {
    if ("section" in target) {
      const id = target.section.trim();
      if (!UUID.test(id)) return null;
      const s = (await db.from("piece_sections").select("piece_id").eq("id", id).maybeSingle()).data as { piece_id: string } | null;
      return s ? await claimForRead(db, clientId, s.piece_id, "section", id) : null;
    }
    const piece = await findPiece(db, target.piece);
    return await claimForRead(db, clientId, piece.id, target.scope, null);
  } catch {
    return null;
  }
}

export async function lockedOutline<T>(db: SupabaseClient, ref: string, fn: () => Promise<T>, clientId: string = CLIENT_ID): Promise<T> {
  const piece = await findPiece(db, ref);
  return withLock(db, piece.id, "outline", null, fn, clientId);
}

/** A write on one of the piece-wide steps (scope, research, final checks), by piece code or id. */
export async function lockedPiece<T>(db: SupabaseClient, ref: string, scope: "scope" | "research" | "final", fn: () => Promise<T>, clientId: string = CLIENT_ID, opts: { append?: boolean } = {}): Promise<T> {
  const piece = await findPiece(db, ref);
  return withLock(db, piece.id, scope, null, fn, clientId, opts);
}

/** The research lock for a write that names research items or a section, not a piece: finds the piece they belong to. */
export async function lockedResearchOf<T>(db: SupabaseClient, by: { item?: string; items?: string[]; section?: string }, fn: () => Promise<T>, clientId: string = CLIENT_ID, opts: { append?: boolean } = {}): Promise<T> {
  const ids = by.items ?? [by.item ?? by.section ?? ""];
  const table = by.section !== undefined ? "piece_sections" : "research_items";
  const pieces = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!UUID.test(id)) throw new WritError(table === "research_items" ? `"${raw}" is not a research item id (use the ids from writ_get_research).` : "section_id must be the id shown by writ_get_piece.");
    const row = must(await db.from(table).select("piece_id").eq("id", id).maybeSingle(), table === "research_items" ? "Research item" : "Section") as { piece_id: string };
    pieces.add(row.piece_id);
  }
  if (pieces.size !== 1) throw new WritError("These research items belong to different pieces. Review one piece's research at a time.");
  return withLock(db, [...pieces][0], "research", null, fn, clientId, opts);
}

export async function lockedSection<T>(db: SupabaseClient, sectionId: string, fn: () => Promise<T>, clientId: string = CLIENT_ID): Promise<T> {
  if (!UUID.test(sectionId.trim())) throw new WritError("section_id must be the id shown by writ_get_piece.");
  const s = must(await db.from("piece_sections").select("piece_id").eq("id", sectionId.trim()).maybeSingle(), "Section") as { piece_id: string };
  return withLock(db, s.piece_id, "section", sectionId.trim(), fn, clientId);
}

/**
 * What the writer will see on each step of this piece right now, and anything that looks wrong. It uses the same rules the
 * app's screens use (step-views.ts is generated from the app), so a piece made here shows what it should in the app.
 * Read-only. Run it after saving an outline, reopening something, or finishing a step.
 */
export async function checkPiece(db: SupabaseClient, ref: string, clientId: string = CLIENT_ID) {
  const piece = await findPiece(db, ref);
  const [extra, contract, items, rows, held] = await Promise.all([
    db.from("pieces").select("analysis, signed_off_at").eq("id", piece.id).maybeSingle(),
    db.from("piece_contracts").select("expectations, confirmed_at").eq("piece_id", piece.id).maybeSingle(),
    db.from("research_items").select("status").eq("piece_id", piece.id).eq("scope", "piece"),
    sectionRows(db, piece.id, "id, position, heading, status, content, points, brief, ai_draft"),
    // Who is editing right now. A database without locks has no such table: then nobody is.
    db.from("edit_locks").select("scope, section_id, holder_client, holder_label, holder_kind, acquired_at").eq("piece_id", piece.id).gt("expires_at", new Date().toISOString()),
  ]);
  // A read that failed must not look like an empty piece: it would produce concerns that are not true.
  for (const [what, res] of [["the piece", extra], ["the scope", contract], ["the research", items]] as const) {
    if (res.error) throw new WritError(`Could not read ${what}: ${res.error.message}`);
  }
  const more = (extra.data ?? {}) as { analysis?: Record<string, unknown> | null; signed_off_at?: string | null };
  const sections = must(rows as { data: unknown; error: { message: string } | null }, "Could not read the sections") as unknown as
    { position: number; level?: number; heading: string; status: string; content: string; points: { points?: unknown[] } | null; brief: unknown[] | null; ai_draft: string | null }[];
  const r = (piece.recipe ?? {}) as Recipe;
  const counts = ((items.data ?? []) as { status: string }[]).reduce((n, i) => ({ ...n, [i.status]: (n[i.status] ?? 0) + 1 }), {} as Record<string, number>);
  const c = contract.data as { expectations?: unknown[]; confirmed_at?: string | null } | null;
  const analysis = more.analysis && typeof more.analysis === "object" ? more.analysis : null;
  const facts: PieceFacts = {
    stage: piece.stage as PieceFacts["stage"],
    outlineConfirmed: Boolean(piece.outline_confirmed_at),
    signedOff: Boolean(more.signed_off_at),
    recipe: {
      // As in the app, a recipe with no base is the long-form one: the benchmark is on unless it says otherwise.
      analysisEnabled: r.analysis?.enabled !== false,
      outlineMode: (r.outline?.mode ?? "free") as PieceFacts["recipe"]["outlineMode"],
      contractMode: (r.contract?.mode ?? "full") as PieceFacts["recipe"]["contractMode"],
      researchEnabled: (r.research as { enabled?: boolean } | undefined)?.enabled !== false,
      aiDrafts: r.writing?.ai_draft !== false,
    },
    analysis: { exists: Boolean(analysis && Object.keys(analysis).some((k) => k !== "benchmark_done")), benchmarkDone: analysis?.benchmark_done === true },
    contract: c ? { confirmed: Boolean(c.confirmed_at), points: (c.expectations ?? []).length } : null,
    research: { approved: counts.approved ?? 0, unreviewed: counts.unreviewed ?? 0 },
    locks: ((held.error ? [] : held.data ?? []) as { scope: LockScope; section_id: string; holder_client: string; holder_label: string; holder_kind: "person" | "ai"; acquired_at: string }[])
      // This connection's own lock is not news.
      .filter((l) => l.holder_client !== clientId)
      .map((l) => ({
        scope: l.scope, holder: l.holder_label, kind: l.holder_kind, since: `${new Date(l.acquired_at).toISOString().slice(11, 16)} UTC`,
        ...(l.scope === "section" ? { section: (sections as unknown as { id?: string; heading: string }[]).find((s) => s.id === l.section_id)?.heading } : {}),
      })),
    sections: sections.map((s) => ({
      position: s.position, level: s.level === 3 ? 3 : 2, heading: s.heading, status: s.status, words: words(s.content ?? ""),
      hasPoints: Boolean(s.points?.points?.length), hasBrief: Boolean(s.brief?.length), hasAiDraft: Boolean(s.ai_draft),
    })),
  };
  const d = describePiece(facts);
  return {
    code: piece.code,
    stage: piece.stage,
    what_the_writer_sees: d.sees,
    concerns: d.concerns,
    healthy: !d.concerns.some((x) => x.severity === "problem"),
    how_to_use: "Compare what_the_writer_sees with what you expect for this piece. Tell the writer about every concern marked problem, in plain words, and what you did or what they should do. Fix what your own tools can fix (a concern's suggestion says which). Never change the writer's text to make a check pass, and never hide a problem. A note is only worth mentioning when it helps the writer.",
  };
}

/** Confirms the outline through Writ's function, which moves the piece on to writing. */
export async function confirmOutline(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "outline") throw new WritError(`The outline is not open (this piece is at ${piece.stage}).`);
  const r = await db.rpc("confirm_outline", { target_piece: piece.id });
  if (r.error) throw new WritError(`Could not confirm the outline: ${r.error.message}`);
  const after = await findPiece(db, piece.id);
  return { confirmed: true, code: after.code, stage: after.stage };
}

/** Copies approved piece-level research items into a section, so its talking points can cite them. */
export async function useResearch(db: SupabaseClient, sectionId: string, itemIds: string[]) {
  if (!UUID.test(sectionId.trim())) throw new WritError("section_id must be the id shown by writ_get_piece.");
  for (const id of itemIds) {
    if (!UUID.test(id.trim())) throw new WritError(`"${id}" is not a research item id.`);
    const r = await db.rpc("use_piece_item", { item: id.trim(), target_section: sectionId.trim() });
    if (r.error) throw new WritError(`Could not add item ${id} to the section: ${r.error.message}`);
  }
  return { added: itemIds.length };
}

/**
 * Saves a section's talking points and gets the section ready to draft. "refs" are the numbers shown for the section's
 * approved research in writ_get_section. Then it asks Writ to finish the section's research and confirm its brief, which
 * is what moves a section on to writing.
 */
export async function saveSectionPoints(db: SupabaseClient, sectionId: string, points: { point: string; direction?: string; evidence?: string; refs?: number[]; sub_section?: string }[]) {
  const id = sectionId.trim();
  if (!UUID.test(id)) throw new WritError("section_id must be the id shown by writ_get_piece.");
  const s = must(await db.from("piece_sections").select("id, piece_id, heading, status").eq("id", id).maybeSingle(), "Section") as
    Pick<SectionRow, "id" | "piece_id" | "heading" | "status">;
  if (s.status === "written") throw new WritError("This section is already marked as written.");
  const piece = must(await db.from("pieces").select("stage").eq("id", s.piece_id).maybeSingle(), "Piece") as { stage: string };
  if (piece.stage !== "writing") throw new WritError(`The outline must be confirmed first (this piece is at ${piece.stage}).`);
  if (!points.length || points.length > 12) throw new WritError("Give 1 to 12 points.");
  const research = await sectionResearch(db, s.piece_id, s.id);
  const rows = points.map((p) => {
    const text = p.point.trim();
    if (!text) throw new WritError("Each point needs text.");
    const refs = (p.refs ?? []).map((n) => {
      const hit = research.find((r) => r.n === n);
      if (!hit) throw new WritError(`Point "${text.slice(0, 40)}" cites research [${n}], which this section does not have. Add it with writ_use_research first.`);
      return hit.id;
    });
    return { point: text, direction: (p.direction ?? "").trim(), evidence: (p.evidence ?? "").trim(), refs, sub_section: (p.sub_section ?? "").trim() };
  });
  const up = await db.from("piece_sections").update({ points: { titles: [], points: rows, extra_sub_sections: [], thin: [], prepared_at: new Date().toISOString() } }).eq("id", s.id).select("id");
  must(up, "Could not save the talking points");
  if (!up.data?.length) throw new WritError("Could not save the talking points: no access to this section.");
  let status = s.status;
  if (status === "research") {
    const r = await db.rpc("complete_section_research", { target_section: s.id });
    if (r.error) throw new WritError(`Points saved, but the section's research is not finished: ${r.error.message}`);
    const now = must(await db.from("piece_sections").select("status").eq("id", s.id).maybeSingle(), "Section") as { status: typeof status };
    status = now.status;
  }
  // The brief follows the points, as in the web app (its text is "point: direction"). confirm_brief moves a section from
  // brief to writing and leaves a section already in writing where it is, so it is also how a re-save refreshes the brief.
  if (status === "brief" || status === "writing") {
    const bullets = rows.map((p) => ({ text: (p.direction ? `${p.point}: ${p.direction}` : p.point).slice(0, 400), refs: p.refs }));
    const r = await db.rpc("confirm_brief", { target_section: s.id, bullets });
    if (r.error) throw new WritError(`Points saved, but the brief could not be confirmed: ${r.error.message}`);
    status = "writing";
  }
  return { saved: true, section: s.heading, points: rows.length, status, ready_to_draft: status === "writing" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks. The web app runs these on the server and saves the results in the piece's own fields; here Claude runs them
// (the prompts are in prompts.ts, mirrored from the app) and the results are saved in the same fields, in the same
// shapes, so the web app shows them. They are advisory: nothing here moves a stage. A section check is stamped with the
// section's content_rev, so the app shows it as current only while the text has not changed since.
// ---------------------------------------------------------------------------------------------------------------------

const GEO_KEYS = ["answer_capsules", "self_contained_claims", "named_entities", "attribution", "structure", "first_party", "freshness"] as const;
const SEO_KEYS = ["intent", "title", "headings", "answer_first", "questions", "internal_links", "scannability"] as const;
const SEO_GEO_KEYS_FINAL: Record<"seo" | "geo", readonly string[]> = { seo: SEO_KEYS, geo: GEO_KEYS };

const flagOn = (r: Recipe | null | undefined, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r) === true;
const CHECK_LABEL = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Approved research as the fact check sees it: a section's own items, or the piece's when sections have no research of their own. */
async function researchForChecks(db: SupabaseClient, piece: Pick<PieceRow, "id" | "recipe">, sectionId: string) {
  const sectionScoped = piece.recipe?.outline?.mode !== "off" && flagOn(piece.recipe, "sections.research");
  if (sectionScoped) return sectionResearch(db, piece.id, sectionId);
  const r = await db.from("research_items").select("id, statement, source_type, sources(title, url)").eq("piece_id", piece.id).eq("scope", "piece").eq("status", "approved").order("created_at").order("id");
  return must(r, "Could not read the research").map((row, i) => {
    const src = Array.isArray(row.sources) ? row.sources[0] : row.sources;
    return { n: i + 1, id: row.id as string, statement: row.statement as string, type: row.source_type as string, source: (src?.title as string) || (src?.url as string) || "", url: (src?.url as string) || "" };
  });
}

async function loadPieceForChecks(db: SupabaseClient, pieceId: string) {
  return must(await db.from("pieces").select("id, code, title, topic, primary_keyword, stage, recipe").eq("id", pieceId).maybeSingle(), "Piece") as
    Pick<PieceRow, "id" | "code" | "title" | "topic" | "primary_keyword" | "stage" | "recipe">;
}

/** Which checks the piece's format switches on. The contract check also needs a scope step (contract mode not off). */
function enabledChecks(recipe: Recipe | null | undefined) {
  return {
    grammar: flagOn(recipe, "checks.grammar"),
    fact: flagOn(recipe, "checks.fact"),
    contract: flagOn(recipe, "checks.contract") && recipe?.contract?.mode !== "off",
    seo: flagOn(recipe, "checks.seo"),
    geo: flagOn(recipe, "checks.geo"),
  };
}

/**
 * Everything Claude needs to run the checks on one section, or on the whole piece when no section is given: the saved text,
 * the research items numbered as the fact check expects, and the scope points the text owes, numbered as the contract
 * check expects. The checks run on the text saved in Writ (not on a draft held only in chat).
 */
export async function getCheckInput(db: SupabaseClient, ref: string, sectionId?: string) {
  const piece = await findPiece(db, ref);
  const enabled = enabledChecks(piece.recipe);
  const contract = await db.from("piece_contracts").select("core_question, expectations").eq("piece_id", piece.id).maybeSingle();
  if (contract.error) throw new WritError(`Could not read the scope: ${contract.error.message}`);
  const c = (contract.data as { core_question?: string; expectations?: { id: string; text: string }[] } | null) ?? {};
  const all = c.expectations ?? [];
  if (sectionId) {
    if (!UUID.test(sectionId.trim())) throw new WritError("section_id must be the id shown by writ_get_piece.");
    const s = must(await db.from("piece_sections").select("id, piece_id, heading, purpose, status, content, content_rev, expectation_ids").eq("id", sectionId.trim()).maybeSingle(), "Section") as
      Pick<SectionRow, "id" | "piece_id" | "heading" | "purpose" | "status" | "content" | "expectation_ids"> & { content_rev: number };
    if (s.piece_id !== piece.id) throw new WritError("That section belongs to a different piece.");
    if (!s.content.trim()) throw new WritError("This section has no saved text yet, so there is nothing to check.");
    const owed = all.filter((e) => (s.expectation_ids ?? []).includes(e.id));
    return {
      code: piece.code, scope: "section", enabled: { grammar: enabled.grammar, fact: enabled.fact, contract: enabled.contract && owed.length > 0 },
      section: { id: s.id, heading: s.heading, purpose: s.purpose, text: s.content, content_rev: s.content_rev },
      research: enabled.fact ? (await researchForChecks(db, piece, s.id)).map(({ n, type, source, statement, url }) => ({ n, type, source, statement, url })) : [],
      reader_question: c.core_question ?? "",
      scope_points_owed: owed.map((e) => ({ n: all.findIndex((x) => x.id === e.id) + 1, text: e.text })).map((e, i) => ({ n: i + 1, text: e.text })),
    };
  }
  const secs = must(await sectionRows(db, piece.id, "heading, content") as { data: unknown; error: { message: string } | null }, "Could not read the sections") as unknown as { heading: string; content: string; level?: number }[];
  const text = secs.map((x) => `${x.level === 3 ? "###" : "##"} ${x.heading}\n\n${x.content}`).join("\n\n");
  if (!secs.some((x) => x.content.trim())) throw new WritError("Nothing is written yet, so there is nothing to check.");
  const serp = must(await db.from("research_items").select("statement").eq("piece_id", piece.id).eq("source_type", "serp").eq("status", "approved"), "Could not read the research") as { statement: string }[];
  return {
    code: piece.code, scope: "piece", enabled: { contract: enabled.contract && all.length > 0, seo: enabled.seo, geo: enabled.geo },
    title: piece.title, primary_keyword: piece.primary_keyword, reader_question: c.core_question ?? "",
    scope_points: all.map((e, i) => ({ n: i + 1, text: e.text })),
    search_landscape: serp.map((r) => r.statement),
    piece_text: `# ${piece.title}\n\n${text}`,
  };
}

type ContractResult = { expectation: number; status: "met" | "partly" | "missing"; evidence?: string; gap?: string };

/** One stored result per expectation, in the app's shape; an expectation the model skipped is stored as "missing". */
function contractResults(exp: { id: string; text: string }[], results: ContractResult[]) {
  return exp.map((e, i) => {
    const r = results.find((x) => x.expectation === i + 1);
    // A result that is not "met" always says what is missing, so the web app never shows a blank gap line.
    const gap = !r ? "Not assessed." : r.status === "met" ? "" : (r.gap ?? "").trim() || (r.status === "partly" ? "Only partly delivered." : "Not delivered.");
    return { expectation_id: e.id, text: e.text, status: r?.status ?? "missing", evidence: r?.evidence ?? "", gap };
  });
}

/** Saves the grammar, fact and contract check results for one section, stamped with the text version they were run on. */
export async function saveSectionChecks(db: SupabaseClient, sectionId: string, contentRev: number, a: {
  grammar?: { suggestions: { original: string; replacement: string; reason?: string }[] };
  fact?: { flags: { sentence: string; kind: "unsupported" | "mismatch"; issue: string; item?: number }[] };
  contract?: { results: ContractResult[] };
}) {
  const id = sectionId.trim();
  if (!UUID.test(id)) throw new WritError("section_id must be the id shown by writ_get_piece.");
  if (!a.grammar && !a.fact && !a.contract) throw new WritError("Give at least one of grammar, fact or contract.");
  const s = must(await db.from("piece_sections").select("id, piece_id, content, content_rev, expectation_ids").eq("id", id).maybeSingle(), "Section") as
    Pick<SectionRow, "id" | "piece_id" | "content" | "expectation_ids"> & { content_rev: number };
  if (!s.content.trim()) throw new WritError("This section has no saved text yet, so there is nothing to check.");
  if (s.content_rev !== contentRev) throw new WritError("The section's text changed after it was read for checking. Read it again with writ_get_check_input and re-run the checks.");
  const piece = await loadPieceForChecks(db, s.piece_id);
  const on = enabledChecks(piece.recipe);
  const patch: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};
  const checked_at = new Date().toISOString();
  if (a.grammar) {
    if (!on.grammar) throw new WritError("The grammar check is switched off for this piece's format.");
    // The app drops suggestions whose text is not in the section; so does this.
    const kept = a.grammar.suggestions.filter((x) => x.original.trim() && x.original !== x.replacement && s.content.includes(x.original));
    patch.grammar_check = { checked_at, rev: s.content_rev, found: kept.length };
    out.grammar = { found: kept.length, suggestions: kept, dropped: a.grammar.suggestions.length - kept.length };
  }
  if (a.fact) {
    if (!on.fact) throw new WritError("The fact check is switched off for this piece's format.");
    const items = await researchForChecks(db, piece, s.id);
    const flags = a.fact.flags.map((f) => {
      if (!f.sentence.trim() || !f.issue.trim()) throw new WritError("Each fact flag needs the sentence and what is wrong with it.");
      const n = f.kind === "unsupported" ? 0 : (f.item ?? 0);
      if (f.kind === "mismatch" && !items.some((r) => r.n === n)) throw new WritError(`A mismatch must name the research item it conflicts with (1 to ${items.length}).`);
      return { sentence: f.sentence.trim(), kind: f.kind, issue: f.issue.trim(), item: n, item_id: items.find((r) => r.n === n)?.id ?? null };
    });
    patch.fact_check = { checked_at, rev: s.content_rev, flags };
    out.fact = { flags: flags.length };
  }
  if (a.contract) {
    const ct = await db.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
    const all = ((ct.data as { expectations?: { id: string; text: string }[] } | null)?.expectations) ?? [];
    const owed = all.filter((e) => (s.expectation_ids ?? []).includes(e.id));
    if (!on.contract || !owed.length) throw new WritError("The contract check is off for this format, or this section owes no scope points.");
    const results = contractResults(owed, a.contract.results);
    patch.contract_check = { checked_at, rev: s.content_rev, results };
    out.contract = { met: results.filter((r) => r.status === "met").length, partly: results.filter((r) => r.status === "partly").length, missing: results.filter((r) => r.status === "missing").length };
  }
  // Conditional on the text version, so a result never lands on text that has since changed.
  const up = await db.from("piece_sections").update(patch).eq("id", s.id).eq("content_rev", s.content_rev).select("id");
  must(up, "Could not save the check results");
  if (!up.data?.length) throw new WritError("The section's text changed while the checks were being saved. Re-run them on the new text.");
  return { saved: true, ...out, note: "These are advisory. If the writer changes the text, the checks show as out of date in Writ until they are run again." };
}

type SeoGeoItem = { area: "seo" | "geo"; check: string; label?: string; status: "fine" | "improve" | "n/a"; evidence?: string; fix?: string };

/** Saves the final contract check and/or the final SEO/GEO check for the whole piece. */
export async function saveFinalChecks(db: SupabaseClient, ref: string, a: {
  contract?: { results: ContractResult[] };
  seo_geo?: { checks: SeoGeoItem[]; meta_title?: string; meta_description?: string };
}) {
  if (!a.contract && !a.seo_geo) throw new WritError("Give the contract results or the SEO/GEO checks.");
  const piece = await findPiece(db, ref);
  if (piece.stage !== "writing" && piece.stage !== "done") throw new WritError(`The final checks run once the piece is being written (this piece is at ${piece.stage}).`);
  const on = enabledChecks(piece.recipe);
  const patch: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};
  const checked_at = new Date().toISOString();
  if (a.contract) {
    const ct = await db.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
    const all = ((ct.data as { expectations?: { id: string; text: string }[] } | null)?.expectations) ?? [];
    if (!on.contract || !all.length) throw new WritError("The contract check is off for this format, or the piece has no scope points.");
    const results = contractResults(all, a.contract.results);
    patch.final_check = { checked_at, rev: null, results };
    out.contract = { met: results.filter((r) => r.status === "met").length, partly: results.filter((r) => r.status === "partly").length, missing: results.filter((r) => r.status === "missing").length };
  }
  if (a.seo_geo) {
    const areas = (["seo", "geo"] as const).filter((x) => on[x]);
    if (!areas.length) throw new WritError("The SEO and GEO checks are switched off for this piece's format.");
    const checks = a.seo_geo.checks.filter((c) => areas.includes(c.area)).map((c) => {
      if (!SEO_GEO_KEYS_FINAL[c.area].includes(c.check)) throw new WritError(`"${c.check}" is not a ${c.area.toUpperCase()} check. Use: ${SEO_GEO_KEYS_FINAL[c.area].join(", ")}.`);
      return { area: c.area, check: c.check, label: c.label?.trim() || CHECK_LABEL(c.check), status: c.status, evidence: (c.evidence ?? "").trim(), fix: c.status === "improve" ? (c.fix ?? "").trim() : "" };
    });
    const meta_title = (a.seo_geo.meta_title ?? "").trim();
    const meta_description = (a.seo_geo.meta_description ?? "").trim();
    patch.seo_geo_final = { checked_at, checks, meta_title, meta_description };
    out.seo_geo = { checks: checks.length, to_improve: checks.filter((c) => c.status === "improve").length, meta_title_length: meta_title.length, meta_description_length: meta_description.length };
  }
  const up = await db.from("pieces").update(patch).eq("id", piece.id).select("id");
  must(up, "Could not save the check results");
  if (!up.data?.length) throw new WritError("Could not save the check results: no access to this piece.");
  return { saved: true, ...out };
}

// ---------------------------------------------------------------------------------------------------------------------
// The gap analysis ("alignment check") and the outline SEO/GEO check. As in the web app, the result is saved in the piece's
// own fields (pieces.analysis, pieces.seo_geo_outline), here written by the client with a plain update, as the web app does
// for its own flags. The analysis records the ids of the research and scope points it was run on, which is how the web app
// notices that it has gone out of date.
// ---------------------------------------------------------------------------------------------------------------------

const OUTLINE_SEO_KEYS = ["intent", "title", "headings", "answer_first", "questions", "coverage_gap"] as const;
const OUTLINE_GEO_KEYS = ["extractable_sections", "structure", "first_party"] as const;
const SEO_GEO_KEYS_OUTLINE: Record<"seo" | "geo", readonly string[]> = { seo: OUTLINE_SEO_KEYS, geo: OUTLINE_GEO_KEYS };

type Contract = { core_question: string; expectations: { id: string; text: string }[] };

async function readContract(db: SupabaseClient, pieceId: string): Promise<Contract> {
  const r = await db.from("piece_contracts").select("core_question, expectations").eq("piece_id", pieceId).maybeSingle();
  if (r.error) throw new WritError(`Could not read the scope: ${r.error.message}`);
  const d = r.data as Partial<Contract> | null;
  return { core_question: d?.core_question ?? "", expectations: d?.expectations ?? [] };
}

/** The approved piece-level research, numbered as the analysis numbers it (oldest first). */
async function approvedPieceItems(db: SupabaseClient, pieceId: string) {
  const r = await db.from("research_items").select("id, statement").eq("piece_id", pieceId).eq("scope", "piece").eq("status", "approved").order("created_at").order("id");
  return must(r, "Could not read the research").map((row, i) => ({ n: i + 1, id: row.id as string, statement: row.statement as string }));
}

async function loadPieceForAnalysis(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  if (!flagOn(piece.recipe, "analysis.enabled")) throw new WritError("The gap analysis is switched off for this piece's format.");
  if (!["outline", "writing", "done"].includes(piece.stage)) throw new WritError(`The gap analysis runs once the research is finished (this piece is at ${piece.stage}).`);
  return piece;
}

/** What Claude needs for the gap analysis: the brief, the scope points and the approved research, numbered. */
export async function getAnalysisInput(db: SupabaseClient, ref: string) {
  const piece = await loadPieceForAnalysis(db, ref);
  const c = await readContract(db, piece.id);
  const items = await approvedPieceItems(db, piece.id);
  return {
    code: piece.code, scope: "analysis", title: piece.title, topic: piece.topic, primary_keyword: piece.primary_keyword, goal: piece.goal,
    reader_question: c.core_question, scope_points: c.expectations.map((e, i) => ({ n: i + 1, text: e.text })),
    approved_research: items.map(({ n, statement }) => ({ n, statement })),
    this_format_uses: { gaps: flagOn(piece.recipe, "analysis.gaps"), scope_suggestions: flagOn(piece.recipe, "analysis.contract_suggestions") },
  };
}

type Drift = { text: string; items?: number[]; points?: number[] };
type Gap = { text: string; expert_question: string; points?: number[] };
type Suggestion = { change: string; why: string };

const inRange = (nums: number[] | undefined, max: number, what: string) => {
  for (const n of nums ?? []) if (!Number.isInteger(n) || n < 1 || n > max) throw new WritError(`${what} numbers must be between 1 and ${max}.`);
  return nums ?? [];
};

/** Saves the gap analysis in pieces.analysis, with the ids of the research and scope points it was run on. */
export async function saveAnalysis(db: SupabaseClient, ref: string, a: { verdict: "aligned" | "partly" | "drifted"; summary: string; drift?: Drift[]; gaps?: Gap[]; contract_suggestions?: Suggestion[] }) {
  const piece = await loadPieceForAnalysis(db, ref);
  const c = await readContract(db, piece.id);
  const items = await approvedPieceItems(db, piece.id);
  if (!a.summary.trim()) throw new WritError("Give a one or two sentence summary.");
  const useGaps = flagOn(piece.recipe, "analysis.gaps");
  const useSuggestions = flagOn(piece.recipe, "analysis.contract_suggestions");
  const gaps = useGaps ? (a.gaps ?? []) : [];
  if (gaps.length > 4) throw new WritError("Report at most 4 gaps: merge the ones that share a cause.");
  const analysis = {
    alignment: { verdict: a.verdict, summary: a.summary.trim() },
    drift: (a.drift ?? []).map((d) => ({ text: d.text.trim(), items: inRange(d.items, items.length, "Research"), points: inRange(d.points, c.expectations.length, "Scope point") })),
    gaps: gaps.map((g) => {
      if (!g.text.trim() || !g.expert_question.trim()) throw new WritError("Each gap needs its text and one question the company's expert could answer.");
      return { text: g.text.trim(), expert_question: g.expert_question.trim(), points: inRange(g.points, c.expectations.length, "Scope point") };
    }),
    contract_suggestions: useSuggestions ? (a.contract_suggestions ?? []).map((s) => ({ change: s.change.trim(), why: s.why.trim() })) : [],
    item_ids: items.map((i) => i.id),
    point_ids: c.expectations.map((e) => e.id),
  };
  const up = await db.from("pieces").update({ analysis }).eq("id", piece.id).select("id");
  must(up, "Could not save the analysis");
  if (!up.data?.length) throw new WritError("Could not save the analysis: no access to this piece.");
  return { saved: true, verdict: a.verdict, drift: analysis.drift.length, gaps: analysis.gaps.length, scope_suggestions: analysis.contract_suggestions.length };
}

type Analysis = Record<string, unknown> & { gaps?: Record<string, unknown>[]; drift?: Record<string, unknown>[]; contract_suggestions?: Record<string, unknown>[] };

async function readAnalysis(db: SupabaseClient, pieceId: string): Promise<Analysis> {
  const r = must(await db.from("pieces").select("analysis").eq("id", pieceId).maybeSingle(), "Piece") as { analysis: Analysis | null };
  if (!r.analysis || typeof r.analysis !== "object" || !("alignment" in r.analysis)) throw new WritError("There is no gap analysis for this piece yet. Run it first.");
  return r.analysis;
}

async function writeAnalysis(db: SupabaseClient, pieceId: string, analysis: Analysis) {
  const up = await db.from("pieces").update({ analysis }).eq("id", pieceId).select("id");
  must(up, "Could not update the analysis");
  if (!up.data?.length) throw new WritError("Could not update the analysis: no access to this piece.");
}

const FINDING = /^(gap|drift|suggestion)-(\d+)$/;
const LIST_OF: Record<string, "gaps" | "drift" | "contract_suggestions"> = { gap: "gaps", drift: "drift", suggestion: "contract_suggestions" };

function setMark(analysis: Analysis, finding: string, state: "ignored" | "resolved" | "open") {
  const m = FINDING.exec(finding);
  if (!m) throw new WritError(`"${finding}" is not a finding id. Use gap-0, drift-1 or suggestion-0 (the position in the saved analysis).`);
  const list = analysis[LIST_OF[m[1]]] as Record<string, unknown>[] | undefined;
  const entry = list?.[Number(m[2])];
  if (!entry) throw new WritError(`There is no ${finding} in the saved analysis.`);
  delete entry.ignored;
  delete entry.resolved;
  if (state === "ignored") entry.ignored = true;
  if (state === "resolved") entry.resolved = true;
}

/** Records the writer's decision on findings of the gap analysis: ignore one, mark it resolved, or reopen it. */
export async function markFindings(db: SupabaseClient, ref: string, marks: { finding: string; state: "ignored" | "resolved" | "open" }[]) {
  const piece = await findPiece(db, ref);
  const analysis = await readAnalysis(db, piece.id);
  for (const m of marks) setMark(analysis, m.finding, m.state);
  await writeAnalysis(db, piece.id, analysis);
  return { updated: marks.length };
}

type Fixes = {
  reject_items?: number[]; edit_points?: { point: number; text: string }[]; remove_points?: number[]; add_points?: string[];
  add_sections?: { heading: string; purpose?: string; covers?: number[] }[];
};

/**
 * Applies fixes from the gap analysis through Writ's own apply_alignment_fixes: rejecting research items, editing, removing
 * or adding scope points, and adding sections. Numbers are the ones writ_get_check_input shows. Only while the outline is open.
 */
export async function applyAlignmentFixes(db: SupabaseClient, ref: string, fixes: Fixes, resolves: string[] = []) {
  const piece = await findPiece(db, ref);
  if (piece.stage !== "outline") throw new WritError(`Fixes can be applied while the outline is open (this piece is at ${piece.stage}).`);
  const c = await readContract(db, piece.id);
  const items = await approvedPieceItems(db, piece.id);
  const pointId = (n: number) => {
    const e = c.expectations[n - 1];
    if (!Number.isInteger(n) || !e) throw new WritError(`Scope point ${n} does not exist (1 to ${c.expectations.length}).`);
    return e.id;
  };
  const itemId = (n: number) => {
    const it = items[n - 1];
    if (!Number.isInteger(n) || !it) throw new WritError(`Research item ${n} does not exist (1 to ${items.length}).`);
    return it.id;
  };
  const used = new Set(c.expectations.map((e) => e.id));
  const newId = () => { let id = Math.random().toString(36).slice(2, 9); while (used.has(id)) id = Math.random().toString(36).slice(2, 9); used.add(id); return id; };
  const payload = {
    reject_items: (fixes.reject_items ?? []).map(itemId),
    edit_points: (fixes.edit_points ?? []).map((p) => {
      if (!p.text.trim()) throw new WritError("An edited scope point needs text.");
      return { id: pointId(p.point), text: p.text.trim() };
    }),
    remove_points: (fixes.remove_points ?? []).map(pointId),
    add_points: (fixes.add_points ?? []).map((t) => {
      if (!t.trim()) throw new WritError("A new scope point needs text.");
      return { id: newId(), text: t.trim() };
    }),
    add_sections: (fixes.add_sections ?? []).map((s) => {
      if (!s.heading.trim()) throw new WritError("A new section needs a heading.");
      return { heading: s.heading.trim(), purpose: (s.purpose ?? "").trim(), expectation_ids: (s.covers ?? []).map(pointId) };
    }),
  };
  const total = Object.values(payload).reduce((n, l) => n + l.length, 0);
  if (!total) throw new WritError("There are no fixes to apply.");
  // Check the findings to close before anything changes, so a bad id never leaves fixes applied and the analysis behind.
  const prior = must(await db.from("pieces").select("analysis").eq("id", piece.id).maybeSingle(), "Piece") as { analysis: Analysis | null };
  const hasAnalysis = Boolean(prior.analysis && typeof prior.analysis === "object" && "alignment" in prior.analysis);
  if (resolves.length && !hasAnalysis) throw new WritError("There is no gap analysis to mark findings in. Leave resolves out, or run the analysis first.");
  const staged: Analysis | null = hasAnalysis ? JSON.parse(JSON.stringify(prior.analysis)) : null;
  for (const f of resolves) {
    setMark(staged!, f, "resolved");
    const m = FINDING.exec(f);
    // A gap that got a section of its own is flagged so, as in the web app.
    if (m && m[1] === "gap" && payload.add_sections.length) {
      const g = staged!.gaps?.[Number(m[2])];
      if (g) g.sectioned = true;
    }
  }
  const r = await db.rpc("apply_alignment_fixes", { target_piece: piece.id, fixes: payload });
  if (r.error) throw new WritError(`Could not apply the fixes: ${r.error.message}`);
  // As the web app does after any apply: the research and scope points have changed, so the analysis is flagged. This happens
  // whether or not findings are closed.
  if (staged) {
    staged.fixes_applied = true;
    await writeAnalysis(db, piece.id, staged);
  }
  return {
    applied: { rejected_research: payload.reject_items.length, edited_points: payload.edit_points.length, removed_points: payload.remove_points.length, added_points: payload.add_points.length, added_sections: payload.add_sections.length },
    note: "Scope points and research numbers have changed: run writ_get_check_input again before relying on the old numbers. The gap analysis shows as out of date in Writ until it is re-run.",
  };
}

/**
 * Records the writer's own answer to a gap's expert question as a piece of research: a card in the company's insights, added
 * to the piece's approved research through Writ's add_answer_to_research. This is the writer's own knowledge, so it is approved.
 */
export async function addExpertAnswer(db: SupabaseClient, ref: string, answer: string) {
  const text = answer.trim();
  if (!text) throw new WritError("The answer is empty.");
  const piece = await findPiece(db, ref);
  const who = await db.auth.getUser();
  const uid = who.data.user?.id;
  if (!uid) throw new WritError("Could not tell who is signed in.");
  const card = await db.from("cards").insert({
    company_id: piece.company_id, type: "opinion", claim: text.slice(0, 400), detail: text.length > 400 ? text : "", citation: "internal", origin: "manual", created_by: uid,
  }).select("id").maybeSingle();
  must(card, "Could not save the answer");
  const r = await db.rpc("add_answer_to_research", { target_piece: piece.id, card: (card.data as { id: string }).id, item_quote: text.length > 400 ? text : "" });
  if (r.error) throw new WritError(`Saved the answer as an insight, but could not add it to the research: ${r.error.message}`);
  return { added: true, note: "Added to the piece's approved research as the writer's own answer. The gap analysis shows as out of date until it is re-run." };
}

/** What Claude needs for the outline's SEO/GEO check: the outline as plain lines, the scope and the search landscape. */
export async function getOutlineCheckInput(db: SupabaseClient, ref: string) {
  const piece = await findPiece(db, ref);
  if (!flagOn(piece.recipe, "outline.seo_geo_check")) throw new WritError("The outline SEO and GEO check is switched off for this piece's format.");
  const secs = must(await db.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id).order("position"), "Could not read the outline") as { position: number; heading: string; purpose: string }[];
  if (!secs.length) throw new WritError("Save an outline first.");
  const serp = must(await db.from("research_items").select("statement").eq("piece_id", piece.id).eq("source_type", "serp").eq("status", "approved"), "Could not read the research") as { statement: string }[];
  const c = await readContract(db, piece.id);
  return {
    code: piece.code, scope: "outline", title: piece.title, primary_keyword: piece.primary_keyword, reader_question: c.core_question,
    scope_points: c.expectations.map((e, i) => ({ n: i + 1, text: e.text })), search_landscape: serp.map((r) => r.statement),
    outline: secs.map((s) => `${s.position}. ${s.heading} (${s.purpose})`),
    checks: { seo: [...OUTLINE_SEO_KEYS], geo: [...OUTLINE_GEO_KEYS] },
  };
}

/** Saves the outline's SEO/GEO check in pieces.seo_geo_outline. */
export async function saveOutlineChecks(db: SupabaseClient, ref: string, checks: SeoGeoItem[]) {
  const piece = await findPiece(db, ref);
  if (!flagOn(piece.recipe, "outline.seo_geo_check")) throw new WritError("The outline SEO and GEO check is switched off for this piece's format.");
  const n = must(await db.from("piece_sections").select("id").eq("piece_id", piece.id), "Could not read the outline") as { id: string }[];
  if (!n.length) throw new WritError("Save an outline first.");
  const clean = checks.map((c) => {
    if (!SEO_GEO_KEYS_OUTLINE[c.area]?.includes(c.check)) throw new WritError(`"${c.check}" is not an outline ${String(c.area).toUpperCase()} check. Use: SEO ${OUTLINE_SEO_KEYS.join(", ")}; GEO ${OUTLINE_GEO_KEYS.join(", ")}.`);
    return { area: c.area, check: c.check, label: c.label?.trim() || CHECK_LABEL(c.check), status: c.status, evidence: (c.evidence ?? "").trim(), fix: c.status === "improve" ? (c.fix ?? "").trim() : "" };
  });
  if (!clean.length) throw new WritError("Give at least one check result.");
  const up = await db.from("pieces").update({ seo_geo_outline: { checked_at: new Date().toISOString(), checks: clean } }).eq("id", piece.id).select("id");
  must(up, "Could not save the check");
  if (!up.data?.length) throw new WritError("Could not save the check: no access to this piece.");
  return { saved: true, checks: clean.length, to_improve: clean.filter((c) => c.status === "improve").length };
}

/** One entry point for everything Claude reads before running a check. */
export async function getReviewInput(db: SupabaseClient, ref: string, scope: "analysis" | "outline" | "section" | "piece", sectionId?: string) {
  if (scope === "analysis") return getAnalysisInput(db, ref);
  if (scope === "outline") return getOutlineCheckInput(db, ref);
  if (scope === "section") {
    if (!sectionId) throw new WritError("Give the section_id for a section check.");
    return getCheckInput(db, ref, sectionId);
  }
  return getCheckInput(db, ref);
}
