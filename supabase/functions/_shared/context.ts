// Load the context blocks a stage is wired to. Each stage asks only for the
// blocks it needs; nothing else is sent.

import { admin } from "./supabase.ts";
import { UserError } from "./cors.ts";

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
  heading: string;
  purpose: string;
  expectation_ids: string[];
  status: string;
  brief: { text: string; refs: string[] }[] | null;
  content: string;
  ai_draft: string | null;
  content_rev: number;
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
      source_type: r.source_type as string, source: (src?.title as string) || (src?.url as string) || "" };
  });
}

function itemsText(items: Awaited<ReturnType<typeof approvedItems>>): string {
  return items.map((i) => `[${i.n}] (${i.source_type}${i.source ? `; ${i.source}` : ""}) ${i.statement}`).join("\n");
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
    if (data?.analysis) parts.push(`<analysis>\n${JSON.stringify(data.analysis, null, 1)}\n</analysis>`);
  }
  if (blocks.includes("outline")) {
    const { data } = await admin.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id)
      .order("position");
    if (data?.length) {
      parts.push(`<outline>\n${data.map((s) => `${s.position}. ${s.heading}${s.purpose ? ` (${s.purpose})` : ""}`).join("\n")}\n</outline>`);
    }
  }
  if (blocks.includes("piece_items")) {
    const items = await approvedItems(piece.id);
    parts.push(`<approved_research>\n${itemsText(items) || "(none)"}\n</approved_research>`);
  }
  if (blocks.includes("section_items") && section) {
    const items = await approvedItems(piece.id, section.id);
    parts.push(`<section_research>\n${itemsText(items) || "(none)"}\n</section_research>`);
  }
  if (section) {
    const { data: c } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).single();
    const owed = ((c?.expectations ?? []) as { id: string; text: string }[]).filter((e) => section.expectation_ids.includes(e.id));
    parts.push(`<section>
Heading: ${section.heading}
Purpose: ${section.purpose || "(not given)"}
Contract expectations this section owes:
${owed.map((e) => `- ${e.text}`).join("\n") || "(none assigned)"}
</section>`);
  }
  return parts.join("\n\n");
}

export async function logEvent(piece: Piece, actor: string, action: string, detail: Record<string, unknown> = {}) {
  const { error } = await admin.from("piece_events").insert({ company_id: piece.company_id, piece_id: piece.id, actor, action, detail });
  if (error) console.error("event insert failed", error);
}
