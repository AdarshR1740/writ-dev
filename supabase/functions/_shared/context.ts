// Load the context blocks a stage is wired to. Each stage asks only for the
// blocks it needs; nothing else is sent.

import { admin } from "./supabase.ts";
import { UserError } from "./cors.ts";
import { OUTLINE_LEGEND, outlinePrefix } from "./assemble.ts";
import { familyNote, sectionFamily, type FamilyRow } from "./outline.ts";

export type Block =
  | "brief"
  | "contract"
  | "icp"
  | "positioning"
  | "strategy_notes"
  | "core_voice"
  | "format_profile"
  | "analysis"
  | "outline"
  | "piece_items"
  /** Approved research as numbered statements only: no source type or source name, for checks that must not weigh sources. */
  | "piece_items_plain"
  | "section_items"
  | "voice_memory";

export interface Piece {
  id: string;
  company_id: string;
  title: string;
  code: string;
  topic: string;
  primary_keyword: string;
  goal: string;
  audience_notes: string;
  stage: string;
  format_id: string | null;
  recipe: Record<string, Record<string, unknown>>;
  brief_extra: Record<string, string>;
  origin_notes?: string;
}

/** Read a recipe switch, e.g. on(piece, "checks.fact"). */
export function on(piece: Piece, path: string): boolean {
  const [group, key] = path.split(".");
  return Boolean(piece.recipe?.[group]?.[key]);
}

export function setting<T>(piece: Piece, path: string): T {
  const [group, key] = path.split(".");
  return piece.recipe?.[group]?.[key] as T;
}

/** Refuse a step this piece's workflow switches off. */
export function requireStep(piece: Piece, ok: boolean, what: string): void {
  if (!ok) throw new UserError(`${what} is switched off in this format's workflow.`);
}

export async function loadPiece(pieceId: string): Promise<Piece> {
  const { data, error } = await admin.from("pieces").select("*").eq("id", pieceId).maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError("Piece not found.", 404);
  return data as Piece;
}

export interface SectionRow {
  id: string;
  piece_id: string;
  company_id: string;
  position: number;
  /** 2 for a main heading (H2), 3 for a sub-heading (H3) under the main heading above it. */
  level?: number;
  /** How much the writer wants this to say: short, standard or deep. */
  depth?: string;
  heading: string;
  purpose: string;
  expectation_ids: string[];
  status: string;
  brief: { text: string; refs: string[] }[] | null;
  content: string;
  ai_draft: string | null;
  content_rev: number;
  structure: { type: string; note: string }[] | null;
  /** What the Writing step's prepare run worked out for the section (talking points with their evidence). */
  points?: { points: { point: string; direction: string; evidence: string; refs: string[]; sub_section: string }[] } | null;
}

/**
 * A piece's sections in order, with each one's heading level, for putting the text back together. A database that has not
 * had the sub-headings migration yet has no level column: its sections are all main headings, so the read is repeated without it.
 */
export interface SectionText { heading: string; content: string; level?: number | null; ai_draft?: string | null }

/** The columns of a section row the outline work reads. Which of them are present depends on the columns asked for. */
export interface OutlineRowDb {
  position: number;
  heading: string;
  purpose: string;
  level?: number | null;
  depth?: string | null;
  expectation_ids?: string[];
  structure?: unknown;
}

export async function sectionTexts<T extends object = SectionText>(pieceId: string, columns: string): Promise<{ data: T[] | null; error: { message: string } | null }> {
  // The column list is built at run time, so the client can't work out the row type: it is stated here.
  const read = (cols: string) => admin.from("piece_sections").select(cols).eq("piece_id", pieceId).order("position") as unknown as
    PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  const r = await read(`${columns}, level`);
  if (r.error && /\blevel\b/i.test(r.error.message)) return await read(columns);
  return r;
}

export async function loadSection(sectionId: string): Promise<SectionRow> {
  const { data, error } = await admin.from("piece_sections").select("*").eq("id", sectionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError("Section not found.", 404);
  return data as SectionRow;
}

/** Approved items, numbered so the model can refer to them as [n]. */
export async function approvedItems(pieceId: string, sectionId?: string) {
  let q = admin.from("research_items").select("id, statement, quote, source_type, secondary, sources(title, url)")
    .eq("piece_id", pieceId).eq("status", "approved").order("created_at");
  q = sectionId ? q.eq("scope", "section").eq("section_key", sectionId) : q.eq("scope", "piece");
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r, i) => {
    const src = Array.isArray(r.sources) ? r.sources[0] : r.sources;
    return { n: i + 1, id: r.id as string, statement: r.statement as string, quote: r.quote as string,
      source_type: r.source_type as string, source: (src?.title as string) || (src?.url as string) || "",
      url: (src?.url as string) || "" };
  });
}

function itemsText(items: Awaited<ReturnType<typeof approvedItems>>): string {
  return items.map((i) => `[${i.n}] (${i.source_type}${i.source ? `; ${i.source}` : ""}) ${i.statement}${i.url ? `\n    url: ${i.url}` : ""}`).join("\n");
}

export async function contextFor(piece: Piece, blocks: Block[], section?: SectionRow): Promise<string> {
  const parts: string[] = [];
  if (blocks.includes("brief")) {
    let format = "";
    if (piece.format_id) {
      const { data } = await admin.from("formats").select("name, description").eq("id", piece.format_id).maybeSingle();
      if (data) format = `${data.name}${data.description ? ` (${data.description})` : ""}`;
    }
    parts.push(`<brief>
Working title: ${piece.title}
Topic: ${piece.topic || "(same as title)"}
Primary keyword: ${piece.primary_keyword || "(none given)"}
Format: ${format || "(not set)"}
Goal: ${piece.goal || "(not given)"}
Audience notes: ${piece.audience_notes || "(none)"}${
      piece.brief_extra?.customer ? `\nCustomer: ${piece.brief_extra.customer}` : ""}${
      piece.brief_extra?.offer ? `\nOffer: ${piece.brief_extra.offer}` : ""}${
      piece.brief_extra?.cta ? `\nCall to action: ${piece.brief_extra.cta}` : ""}${
      piece.origin_notes ? `\nNotes from the plan this piece came from:\n${piece.origin_notes}` : ""}
</brief>`);
  }
  if (blocks.includes("contract")) {
    const { data } = await admin.from("piece_contracts").select("core_question, expectations").eq("piece_id", piece.id)
      .maybeSingle();
    const exps = ((data?.expectations ?? []) as { text: string }[]).map((e, i) => `${i + 1}. ${e.text}`).join("\n");
    parts.push(`<reader_contract>\nCore question: ${data?.core_question || "(not set)"}\nExpectations:\n${exps || "(none yet)"}\n</reader_contract>`);
  }
  const docKinds = blocks.filter((b) => b === "icp" || b === "positioning" || b === "strategy_notes");
  if (docKinds.length) {
    const { data } = await admin.from("context_documents").select("kind, content").eq("company_id", piece.company_id)
      .in("kind", docKinds);
    for (const kind of docKinds) {
      const content = data?.find((d) => d.kind === kind)?.content?.trim();
      if (content) parts.push(`<${kind}>\n${content}\n</${kind}>`);
    }
  }
  if (blocks.includes("core_voice")) {
    const { data } = await admin.from("context_documents").select("content").eq("company_id", piece.company_id)
      .eq("kind", "core_voice").maybeSingle();
    if (data?.content?.trim()) parts.push(`<core_voice>\n${data.content.trim()}\n</core_voice>`);
  }
  if (blocks.includes("voice_memory")) {
    const { data } = await admin.from("voice_memory").select("rule").eq("company_id", piece.company_id).order("created_at");
    if (data?.length) parts.push(`<voice_memory>\n${data.map((m) => `- ${m.rule}`).join("\n")}\n</voice_memory>`);
  }
  if (blocks.includes("format_profile") && piece.format_id) {
    const { data } = await admin.from("context_documents").select("content").eq("format_id", piece.format_id)
      .maybeSingle();
    if (data?.content?.trim()) parts.push(`<format_profile>\n${data.content.trim()}\n</format_profile>`);
  }
  if (blocks.includes("analysis")) {
    const { data } = await admin.from("pieces").select("analysis").eq("id", piece.id).single();
    if (data?.analysis) {
      // Findings the writer ignored, or that a fix already settled, are not shown to the AI. Each one left gets a
      // "ref" so a fix can say which finding it answers.
      const shown = { ...data.analysis } as Record<string, unknown>;
      const prefix: Record<string, string> = { gaps: "gap", drift: "drift", contract_suggestions: "suggestion" };
      for (const k of ["gaps", "drift", "contract_suggestions"]) {
        if (Array.isArray(shown[k])) {
          shown[k] = (shown[k] as { ignored?: boolean; resolved?: boolean }[])
            .map((x, i) => ({ ref: `${prefix[k]}-${i}`, ...x }))
            .filter((x) => !x.ignored && !x.resolved);
        }
      }
      parts.push(`<analysis>\n${JSON.stringify(shown, null, 1)}\n</analysis>`);
    }
  }
  if (blocks.includes("outline")) {
    const { data } = await sectionTexts<OutlineRowDb>(piece.id, "position, heading, purpose");
    if (data?.length) {
      const legend = data.some((s) => s.level === 3) ? `${OUTLINE_LEGEND}\n` : "";
      parts.push(`<outline>\n${legend}${data.map((s) => `${outlinePrefix(s, s.position)}${s.heading}${s.purpose ? ` (${s.purpose})` : ""}`).join("\n")}\n</outline>`);
    }
  }
  if (blocks.includes("piece_items")) {
    const items = await approvedItems(piece.id);
    parts.push(`<approved_research>\n${itemsText(items) || "(none)"}\n</approved_research>`);
  }
  if (blocks.includes("piece_items_plain")) {
    const items = await approvedItems(piece.id);
    parts.push(`<approved_research>\n${items.map((i) => `[${i.n}] ${i.statement}`).join("\n") || "(none)"}\n</approved_research>`);
  }
  if (blocks.includes("section_items") && section) {
    const items = await approvedItems(piece.id, section.id);
    parts.push(`<section_research>\n${itemsText(items) || "(none)"}\n</section_research>`);
  }
  if (section) {
    const { data: c } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).single();
    const owed = ((c?.expectations ?? []) as { id: string; text: string }[]).filter((e) => section.expectation_ids.includes(e.id));
    // Where the section sits: a main heading with sub-headings (it writes only its opening) or one of those sub-headings.
    const { data: rows } = await sectionTexts<FamilyRow>(piece.id, "position, heading, purpose");
    const kin = sectionFamily(rows ?? [], section.position);
    const family = familyNote(kin);
    parts.push(`<section>
Heading: ${section.heading}
Purpose: ${section.purpose || "(not given)"}
Contract expectations this section owes:
${owed.map((e) => `- ${e.text}`).join("\n") || "(none assigned)"}${
      section.structure?.length && !kin.children.length ? `\nPlanned structure, in order:\n${section.structure.map((b) => `- ${b.type}: ${b.note}`).join("\n")}` : ""}${
      family ? `\n${family}` : ""}
</section>`);
  }
  return parts.join("\n\n");
}

export async function logEvent(piece: Piece, actor: string, action: string, detail: Record<string, unknown> = {}) {
  const { error } = await admin.from("piece_events").insert({ company_id: piece.company_id, piece_id: piece.id, actor, action, detail });
  if (error) console.error("event insert failed", error);
}
