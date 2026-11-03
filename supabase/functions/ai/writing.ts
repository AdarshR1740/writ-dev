// AI tasks for the writing half of a piece: analysis, outline, section
// briefs, optional drafting, and the checks that run on the writer's text.
// Each task receives only the context blocks it is wired to.

import { UserError } from "../_shared/cors.ts";
import { admin, requireRole } from "../_shared/supabase.ts";
import { type JsonSchema, recordUsage, runModel } from "../_shared/llm.ts";
import type { TaskType } from "../_shared/models.ts";
import {
  approvedItems,
  contextFor,
  on,
  requireStep,
  setting,
  loadPiece,
  loadSection,
  logEvent,
  type Piece,
  type SectionRow,
} from "../_shared/context.ts";
import type { Prepared } from "./prepared.ts";

const str = { type: "string" };
const obj = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (items: unknown) => ({ type: "array", items });

async function pieceFor(userId: string, body: Record<string, unknown>): Promise<Piece> {
  const piece = await loadPiece(String(body.piece_id ?? ""));
  await requireRole(userId, piece.company_id, "member");
  return piece;
}

async function sectionFor(userId: string, body: Record<string, unknown>): Promise<{ piece: Piece; section: SectionRow }> {
  const section = await loadSection(String(body.section_id ?? ""));
  const piece = await loadPiece(section.piece_id);
  await requireRole(userId, piece.company_id, "member");
  return { piece, section };
}

function task<T>(
  name: string,
  taskType: TaskType,
  piece: Piece,
  userId: string,
  system: string,
  user: string,
  schema: JsonSchema,
  expectedOutputTokens: number,
  after: (data: T, cost: number | null, model: string) => Promise<unknown>,
): Prepared {
  return {
    companyId: piece.company_id,
    taskType,
    system,
    user,
    expectedOutputTokens,
    run: async () => {
      const r = await runModel<T>(piece.company_id, { taskType, system, user, schema, schemaName: name, maxTokens: 16000 });
      await recordUsage(piece.company_id, userId, name, taskType, r, piece.id);
      return after(r.data, r.costUsd, r.model);
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis (before the outline)
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM = `You analyse reviewed research for one piece of B2B content before it is
outlined. You don't write the piece. Find where the real substance is:

- tensions: where sources disagree with each other, or where evidence is mixed.
- consensus_vs_insight: where the company's own insights (items marked "card") confirm or contradict
  what other sources say. These are the strongest angles: "everyone says X; our calls say Y".
- gaps: important questions for this reader that no approved item answers. For each, write one
  specific question the company's subject-matter expert could answer from experience.
- contract_suggestions: changes the research suggests for the reader contract, e.g. an expectation
  the search landscape shows readers need, or one the evidence can't support. The writer decides;
  suggest nothing if the contract already fits.

Refer to items by their number. Be concrete and brief. Return empty lists when there is nothing real
to say; don't pad.`;

const analysisSchema = obj({
  tensions: list(obj({ text: str, items: list({ type: "integer" }) })),
  consensus_vs_insight: list(obj({ text: str, items: list({ type: "integer" }) })),
  gaps: list(obj({ text: str, expert_question: str })),
  contract_suggestions: list(obj({ change: str, why: str })),
});

async function prepareAnalysis(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "analysis.enabled"), "Analysis");
  if (!["outline", "writing", "done"].includes(piece.stage)) throw new UserError("Finish research first.");
  // Wiring: brief, contract and approved research. No voice.
  const context = await contextFor(piece, ["brief", "contract", "piece_items"]);
  const off = [
    ["tensions", "analysis.tensions"],
    ["consensus_vs_insight", "analysis.insight_vs_consensus"],
    ["gaps", "analysis.gaps"],
    ["contract_suggestions", "analysis.contract_suggestions"],
  ].filter(([, path]) => !on(piece, path)).map(([field]) => field);
  const system = off.length ? `${ANALYSIS_SYSTEM}\n\nThis format doesn't use: ${off.join(", ")}. Return empty lists for those.` : ANALYSIS_SYSTEM;
  return task<Record<string, unknown>>("analysis", "reason", piece, userId, system, context, analysisSchema, 2500,
    async (data, cost, model) => {
      const { error } = await admin.from("pieces").update({ analysis: data }).eq("id", piece.id);
      if (error) throw error;
      await logEvent(piece, userId, "analysis_run");
      return { analysis: data, cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// Outline (conversation, like the contract)
// ---------------------------------------------------------------------------

const OUTLINE_SYSTEM = `You help a writer outline one piece of B2B content. The writer owns the outline;
you suggest, they decide.

Build the outline from the reader contract, the reviewed research and the analysis. Every contract
expectation must be covered by at least one section; list which ones (by number) each section serves.
Follow the intent: "what are X" puts the list up front and then a section per item; "how to" is steps;
"should I" is a decision framework. Use the format profile only for structural habits (how pieces in
this format open and are organised). Don't plan word counts.

Each turn: answer briefly in "reply" (what you changed and why, or a question), and return the full
suggested outline with a heading and a one-line purpose per section.`;

const outlineSchema = obj({
  reply: str,
  sections: list(obj({ heading: str, purpose: str, expectations: list({ type: "integer" }) })),
});

async function threadId(piece: Piece, subject: "outline"): Promise<string> {
  const { data } = await admin.from("threads").select("id").eq("piece_id", piece.id).eq("subject", subject).maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await admin.from("threads")
    .insert({ company_id: piece.company_id, piece_id: piece.id, subject }).select("id").single();
  if (error) throw error;
  return created.id;
}

async function prepareOutline(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, setting<string>(piece, "outline.mode") === "free" && on(piece, "outline.ai_thread"), "Outline suggestions");
  if (piece.stage !== "outline") throw new UserError("The outline can be suggested once research is finished.");
  const message = String(body.message ?? "").trim();
  const thread = await threadId(piece, "outline");
  const { data: history } = await admin.from("thread_messages").select("role, content").eq("thread_id", thread)
    .order("created_at");
  const { data: current } = await admin.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id)
    .order("position");
  // Wiring: brief, contract, analysis, approved research, format profile. No core voice or memory.
  const context = await contextFor(piece, ["brief", "contract", "analysis", "piece_items", "format_profile"]);
  const convo = [...(history ?? []), ...(message ? [{ role: "writer", content: message }] : [])]
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n");
  const user = `${context}

<current_outline>
${(current ?? []).map((s) => `${s.position}. ${s.heading} (${s.purpose})`).join("\n") || "(empty)"}
</current_outline>

<conversation>
${convo || "(No messages yet. Suggest a first outline.)"}
</conversation>`;
  return task<{ reply: string; sections: { heading: string; purpose: string; expectations: number[] }[] }>(
    "outline_suggest", "reason", piece, userId, OUTLINE_SYSTEM, user, outlineSchema, 2000,
    async (data, cost, model) => {
      if (message) {
        await admin.from("thread_messages").insert({ company_id: piece.company_id, thread_id: thread, role: "writer", content: message, created_by: userId });
      }
      const { data: msg, error } = await admin.from("thread_messages").insert({
        company_id: piece.company_id, thread_id: thread, role: "ai", content: data.reply, payload: { sections: data.sections },
      }).select().single();
      if (error) throw error;
      await logEvent(piece, userId, "outline_suggested");
      return { message: msg, cost_usd: cost, model };
    },
  );
}

// ---------------------------------------------------------------------------
// Section brief: crisp bullets, never prose
// ---------------------------------------------------------------------------

const BRIEF_SYSTEM = `You write the brief for one section of a piece. The writer will write the section
by hand from your bullets, so the bullets must carry content, not style.

Rules:
- Fragments and keywords only. No full sentences, no transitions, no adjectives, nothing quotable.
  Elaborate phrasing would leak into the writer's style and make the text read as AI-written.
- One idea per bullet, in a sensible order for the section.
- Use the pattern "label: content", e.g. "adopter: Unilever, 2023" or "limit: data integration cost".
- Start with an "answer:" bullet: the section's core answer in a few words, so the writer can open
  with it (readers and AI answer engines both look for it first).
- Cover every contract expectation this section owes.
- Use only approved research. Every bullet that rests on a fact lists the item numbers it uses in refs.
  Bullets for the writer's own argument or experience have empty refs.
- Where the analysis shows a tension or a company insight that contradicts the consensus, include it.
- 4 to 10 bullets.`;

// Short, single-section formats (a LinkedIn post, a social post).
const BRIEF_SHORT = `This is a short, single-section format. Use 3 to 6 bullets in this order: "hook:" (the
opening line's idea, not its wording), "answer:" (the one point), "proof:" (one or two facts or a story,
with refs), "close:" (the takeaway or question; a call to action only if the brief has one).
Overrides the "start with answer" rule above.`;

const briefSchema = obj({ bullets: list(obj({ text: str, refs: list({ type: "integer" }) })) });

async function prepareBrief(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "sections.brief"), "The section brief");
  if (section.status === "research") throw new UserError("Finish this section's research first.");
  const single = setting<string>(piece, "outline.mode") === "off";
  // Single-section formats have no section research: brief from the piece-level research.
  const items = await approvedItems(piece.id, single ? undefined : section.id);
  // Wiring: section, outline, analysis, the approved research. No voice: bullets carry content only.
  const context = single
    ? await contextFor(piece, ["brief", "piece_items"], section)
    : await contextFor(piece, ["outline", "analysis", "section_items"], section);
  const system = single ? `${BRIEF_SYSTEM}\n\n${BRIEF_SHORT}` : BRIEF_SYSTEM;
  return task<{ bullets: { text: string; refs: number[] }[] }>("section_brief", "reason", piece, userId, system, context,
    briefSchema, 800, async (data, cost, model) => {
      const bullets = data.bullets.map((b) => ({
        text: b.text.trim(),
        refs: b.refs.map((n) => items.find((i) => i.n === n)?.id).filter((x): x is string => Boolean(x)),
      })).filter((b) => b.text);
      await logEvent(piece, userId, "brief_suggested", { section: section.id });
      return { bullets, cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// Optional AI draft (manual writing is the default)
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = `You draft one section of a piece for a company's writer, who will edit it. Follow
the brief exactly, in order, opening with its "answer:" point in one or two plain sentences. Use only
the approved research for facts and figures, and say where each figure comes from; don't add any other
numbers, names or claims. Write in the company's core voice and the habits of the format profile. No
heading, no preamble, no closing summary, no "In conclusion". Plain prose the writer can edit.`;

async function prepareDraft(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "writing.ai_draft"), "AI drafting");
  if (!section.brief?.length && on(piece, "sections.brief")) throw new UserError("Confirm the brief first.");
  // Wiring for drafting: section, outline, section research, core voice, format profile, brief.
  const single = setting<string>(piece, "outline.mode") === "off";
  const context = await contextFor(piece,
    single ? ["brief", "piece_items", "core_voice", "format_profile", "voice_memory"]
      : ["outline", "section_items", "core_voice", "format_profile", "voice_memory"], section);
  const user = `${context}\n\n<brief>\n${(section.brief ?? []).map((b) => `- ${b.text}`).join("\n") || "(no brief: write from the section and research)"}\n</brief>`;
  return task<{ text: string }>("section_draft", "write", piece, userId, DRAFT_SYSTEM, user, obj({ text: str }), 2500,
    async (data, cost, model) => {
      const patch: Record<string, unknown> = { ai_draft: data.text };
      if (!section.content.trim()) patch.content = data.text;
      const { error } = await admin.from("piece_sections").update(patch).eq("id", section.id);
      if (error) throw error;
      await logEvent(piece, userId, "section_ai_drafted", { section: section.id });
      return { text: data.text, replaced: !section.content.trim(), cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// Checks on the writer's text
// ---------------------------------------------------------------------------

const GRAMMAR_SYSTEM = `You are a grammar checker, like a conventional spelling and grammar plugin. Suggest
only corrections to spelling, grammar and punctuation. Never rephrase for style, tone, clarity or
length, and never change word choice that is correct. "original" must be an exact substring of the
text, short (the few words around the error), and appear only once if possible. Return an empty list
when the text is correct.`;

const grammarSchema = obj({ suggestions: list(obj({ original: str, replacement: str, reason: str })) });

async function prepareGrammar(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "checks.grammar"), "The grammar check");
  const text = String(body.text ?? section.content).trim();
  if (!text) throw new UserError("Write something first.");
  return task<{ suggestions: { original: string; replacement: string; reason: string }[] }>("grammar_check", "extract",
    piece, userId, GRAMMAR_SYSTEM, `<text>\n${text}\n</text>`, grammarSchema, 800, async (data, cost, model) => ({
      suggestions: data.suggestions.filter((s) => s.original && s.original !== s.replacement && text.includes(s.original)),
      cost_usd: cost,
      model,
    }));
}

const FACT_SYSTEM = `You check a section a writer wrote against the research they approved. Flag every
sentence that states a number, date, name, ranking or factual claim that either:
- "unsupported": isn't backed by any approved item, or
- "mismatch": contradicts or misstates an approved item (wrong figure, year, scope or attribution).

Opinions, arguments and the writer's own experience are fine; don't flag them. Quote the sentence
exactly. For mismatches, give the item number; for unsupported claims use 0. Return an empty list when
everything checks out.`;

const factSchema = obj({
  flags: list(obj({ sentence: str, kind: { type: "string", enum: ["unsupported", "mismatch"] }, issue: str, item: { type: "integer" } })),
});

async function prepareFacts(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "checks.fact"), "The fact check");
  if (!section.content.trim()) throw new UserError("Write the section first.");
  // Single-section formats check against piece research; others against the section's.
  const single = setting<string>(piece, "outline.mode") === "off" || !on(piece, "sections.research");
  const items = await approvedItems(piece.id, single ? undefined : section.id);
  const context = await contextFor(piece, [single ? "piece_items" : "section_items"], section);
  const user = `${context}\n\n<written_section>\n${section.content}\n</written_section>`;
  return task<{ flags: { sentence: string; kind: string; issue: string; item: number }[] }>("fact_check", "reason", piece,
    userId, FACT_SYSTEM, user, factSchema, 1000, async (data, cost, model) => {
      const result = {
        checked_at: new Date().toISOString(),
        flags: data.flags.map((f) => ({ ...f, item_id: items.find((i) => i.n === f.item)?.id ?? null })),
      };
      await admin.from("piece_sections").update({ fact_check: result }).eq("id", section.id);
      await logEvent(piece, userId, "fact_check_run", { section: section.id, flags: result.flags.length });
      return { ...result, cost_usd: cost, model };
    });
}

const CONTRACT_CHECK_SYSTEM = `You check written text against a reader contract. For each expectation,
decide whether the text delivers it: "met", "partly" or "missing". For met and partly, quote the
shortest passage from the text that shows it (exactly as written). For partly and missing, say in one
plain sentence what's missing. Judge only what the text actually says. There is no score.`;

const contractCheckSchema = obj({
  results: list(obj({ expectation: { type: "integer" }, status: { type: "string", enum: ["met", "partly", "missing"] }, evidence: str, gap: str })),
});

async function prepareContractCheck(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const sectionId = body.section_id ? String(body.section_id) : null;
  const { piece, section } = sectionId
    ? await sectionFor(userId, body)
    : { piece: await pieceFor(userId, body), section: null };
  requireStep(piece, on(piece, "checks.contract") && setting<string>(piece, "contract.mode") !== "off", "The contract check");
  const { data: c } = await admin.from("piece_contracts").select("core_question, expectations").eq("piece_id", piece.id).single();
  const all = (c?.expectations ?? []) as { id: string; text: string }[];
  const owed = section ? all.filter((e) => section.expectation_ids.includes(e.id)) : all;
  if (!owed.length) throw new UserError(section ? "This section doesn't owe any expectations. Assign some in the outline." : "The contract is empty.");

  let text: string;
  if (section) {
    if (!section.content.trim()) throw new UserError("Write the section first.");
    text = `## ${section.heading}\n\n${section.content}`;
  } else {
    const { data: secs } = await admin.from("piece_sections").select("heading, content").eq("piece_id", piece.id).order("position");
    text = (secs ?? []).map((s) => `## ${s.heading}\n\n${s.content}`).join("\n\n");
    if (!text.trim()) throw new UserError("Nothing written yet.");
  }
  const user = `<reader_contract>
Core question: ${c?.core_question}
${owed.map((e, i) => `${i + 1}. ${e.text}`).join("\n")}
</reader_contract>

<text>
${text}
</text>`;
  return task<{ results: { expectation: number; status: string; evidence: string; gap: string }[] }>("contract_check", "reason",
    piece, userId, CONTRACT_CHECK_SYSTEM, user, contractCheckSchema, 1200, async (data, cost, model) => {
      const result = {
        checked_at: new Date().toISOString(),
        results: owed.map((e, i) => {
          const r = data.results.find((x) => x.expectation === i + 1);
          return { expectation_id: e.id, text: e.text, status: r?.status ?? "missing", evidence: r?.evidence ?? "", gap: r?.gap ?? "Not assessed." };
        }),
      };
      if (section) await admin.from("piece_sections").update({ contract_check: result }).eq("id", section.id);
      else await admin.from("pieces").update({ final_check: result }).eq("id", piece.id);
      await logEvent(piece, userId, section ? "section_contract_check" : "final_contract_check", {
        section: section?.id ?? null,
        met: result.results.filter((r) => r.status === "met").length,
        total: result.results.length,
      });
      return { ...result, cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// SEO and GEO checks (outline and finished piece). Adapted from v1's SEO/GEO
// guidelines, as checklists with evidence, never a score or keyword quota.
// ---------------------------------------------------------------------------

const SEO_GEO_BASE = `You review a piece of B2B content for search (SEO) and for being cited by AI answer
engines such as Google AI Overviews, ChatGPT search and Perplexity (GEO). You give a checklist, not
a score. Never suggest keyword density, repeating the keyword, term quotas or padding; a reader-first
piece that answers the intent well beats one tuned to a tool. The search-landscape items ([serp])
show the intent, what ranking pages cover and skip, and what people ask.

For every check, return status "fine", "improve" or "n/a", the evidence you saw (quote it when you
can), and for "improve" one concrete, specific fix.`;

const SEO_GEO_CHECKS = {
  outline: `Checks for an OUTLINE (judge the plan, not prose):
SEO
- intent: the outline's shape serves the search intent of the primary keyword.
- title: the working title states the topic plainly with the primary keyword near the start, in
  about 60 characters or fewer.
- headings: every section heading is descriptive and specific to its sub-topic; no generic
  placeholders such as "Introduction", "The current landscape", "Key considerations" or "Conclusion".
- answer_first: the first section delivers the core answer instead of background.
- questions: the questions people ask (from the search landscape) are covered by a section, or
  deliberately left out for a reason that fits the contract.
- coverage_gap: the outline covers at least one thing ranking pages skip or get wrong.
GEO
- extractable_sections: sections are planned so each can open with a short, standalone answer.
- structure: comparisons are planned as tables and procedures as numbered steps where the content
  calls for it.
- first_party: at least one section is built on the company's own insight or data.`,
  final: `Checks for the FINISHED PIECE:
SEO
- intent: the piece serves the search intent of the primary keyword.
- title: the title states the topic with the primary keyword near the start, about 60 characters or
  fewer.
- headings: headings are descriptive and specific; no generic placeholders.
- answer_first: the opening (roughly the first 150 words) gives the core answer.
- questions: the questions people ask are answered where they fit.
- internal_links: name 2 to 4 topics on the company's own site the piece should link to, with
  suggested anchor text (status "improve" with the suggestions, or "n/a").
- scannability: lists and short paragraphs where readers scan; no walls of text.
GEO
- answer_capsules: key sections open with a concise, standalone answer (about 40 to 60 words) that
  an answer engine could quote as is.
- self_contained_claims: important claims name their subject and context in the same sentence, so
  they still make sense when quoted alone.
- named_entities: real companies, products, standards and frameworks are named, not described
  vaguely.
- attribution: figures and claims say where they come from, in the text.
- structure: comparisons use tables and procedures use numbered steps where it helps.
- first_party: the piece includes the company's own insight or data, which answer engines can't find
  elsewhere.
- freshness: figures carry dates.
Also write a meta title (60 characters or fewer, primary keyword near the start) and a meta
description (140 to 155 characters, plain value statement with the keyword once).`,
};

const checkItem = obj({
  area: { type: "string", enum: ["seo", "geo"] },
  check: str,
  label: str,
  status: { type: "string", enum: ["fine", "improve", "n/a"] },
  evidence: str,
  fix: str,
});

async function prepareSeoGeo(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  const scope = body.scope === "final" ? "final" : "outline";
  const areas = scope === "outline"
    ? (on(piece, "outline.seo_geo_check") ? ["seo", "geo"] : [])
    : [...(on(piece, "checks.seo") ? ["seo"] : []), ...(on(piece, "checks.geo") ? ["geo"] : [])];
  requireStep(piece, areas.length > 0, scope === "outline" ? "The outline SEO/GEO check" : "The SEO/GEO check");
  const { data: serp } = await admin.from("research_items").select("statement").eq("piece_id", piece.id)
    .eq("source_type", "serp").eq("status", "approved");
  const landscape = (serp ?? []).map((r) => `- ${r.statement}`).join("\n") || "(no search-landscape items were approved)";
  let subject: string;
  if (scope === "outline") {
    const { data: secs } = await admin.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id)
      .order("position");
    if (!secs?.length) throw new UserError("Save an outline first.");
    subject = `<outline>\n${secs.map((x) => `${x.position}. ${x.heading} (${x.purpose})`).join("\n")}\n</outline>`;
  } else {
    const { data: secs } = await admin.from("piece_sections").select("heading, content").eq("piece_id", piece.id).order("position");
    const text = (secs ?? []).map((x) => `## ${x.heading}\n\n${x.content}`).join("\n\n");
    if (!text.trim()) throw new UserError("Nothing written yet.");
    subject = `<piece>\n# ${piece.title}\n\n${text}\n</piece>`;
  }
  // Wiring: brief (keyword), contract, search landscape, and the outline or piece. No voice.
  const context = await contextFor(piece, ["brief", "contract"]);
  const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n${subject}`;
  const system = `${SEO_GEO_BASE}\n\n${SEO_GEO_CHECKS[scope]}${
    areas.length === 1 ? `\n\nThis format only uses the ${areas[0].toUpperCase()} checks: return only those.` : ""}`;
  const schema = scope === "final"
    ? obj({ checks: list(checkItem), meta_title: str, meta_description: str })
    : obj({ checks: list(checkItem) });
  return task<{ checks: Record<string, string>[]; meta_title?: string; meta_description?: string }>(
    "seo_geo_check", "reason", piece, userId, system, user, schema, 1800, async (data, cost, model) => {
      const result = { checked_at: new Date().toISOString(), ...data, checks: data.checks.filter((c) => areas.includes(c.area)) };
      const { error } = await admin.from("pieces").update(scope === "final" ? { seo_geo_final: result } : { seo_geo_outline: result })
        .eq("id", piece.id);
      if (error) throw error;
      await logEvent(piece, userId, `seo_geo_${scope}_check`, {
        improve: data.checks.filter((c) => c.status === "improve").length,
      });
      return { ...result, cost_usd: cost, model };
    },
  );
}

// ---------------------------------------------------------------------------
// Repurposing: a plan in front of the target format's normal workflow
// ---------------------------------------------------------------------------

const REPURPOSE_BASE = `You plan how to repurpose a company's finished content into another format. You
plan; the writer decides and writes. Use only what the source pieces and their approved research
contain; don't invent facts. Refer to research items by their number. Follow the writer's specific
requirements when given.`;

const REPURPOSE_SHAPES: Record<string, string> = {
  split: `SPLIT one source into several pieces in the target format. Find the distinct key points worth a
piece of their own (usually 3 to 7; fewer is fine if the source doesn't support more). Each entry
is one new piece: a heading that states the point, an angle (the story or framing that makes this
piece different from the others), notes for the writer, and the research items that support it.
Points must not overlap; similar is fine, repeated is not. Leave sections empty unless the target
format has an outline.`,
  adapt: `ADAPT one source into exactly one piece in a different medium. Return one entry. Map the source
onto the target format's structure: list the target sections in order, each with a purpose saying
which source sections or points it draws on. Use the target format's fixed outline when it has one.
In not_translated, list what doesn't carry over to the new medium (tables, long citations, visual
references) and how to handle each.`,
  combine: `COMBINE several sources into exactly one longer piece. Return one entry. Group the sources'
points into themes and propose the sections in a sensible order, each with a purpose naming which
sources it draws on. In gaps, list the connecting material none of the sources covers (it will need
new research or the writer's own knowledge).`,
};

const repurposeSchema = obj({
  entries: list(obj({
    heading: str,
    angle: str,
    notes: str,
    items: list({ type: "integer" }),
    sections: list(obj({ heading: str, purpose: str })),
  })),
  not_translated: list(str),
  gaps: list(str),
});

async function prepareRepurpose(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { data: plan } = await admin.from("repurpose_plans").select("*").eq("id", String(body.plan_id ?? "")).maybeSingle();
  if (!plan) throw new UserError("Plan not found.", 404);
  await requireRole(userId, plan.company_id, "member");
  if (plan.status !== "draft") throw new UserError("This plan was already used.");
  const { data: format } = await admin.from("formats").select("name, description, recipe").eq("id", plan.target_format_id).single();
  const { data: profile } = await admin.from("context_documents").select("content").eq("format_id", plan.target_format_id).maybeSingle();

  // Sources: their text (by section) and approved research, numbered across all sources.
  const items: { n: number; id: string }[] = [];
  const parts: string[] = [];
  for (const sourceId of plan.source_piece_ids as string[]) {
    const src = await loadPiece(sourceId);
    if (src.company_id !== plan.company_id) throw new UserError("A source piece belongs to another company.");
    const { data: secs } = await admin.from("piece_sections").select("heading, content").eq("piece_id", src.id).order("position");
    const approved = await approvedItems(src.id);
    const { data: sectionItems } = await admin.from("research_items").select("id, statement, source_type").eq("piece_id", src.id)
      .eq("scope", "section").eq("status", "approved");
    const all = [...approved.map((a) => ({ id: a.id, statement: a.statement, source_type: a.source_type })), ...(sectionItems ?? [])];
    const lines = all.map((a) => {
      const n = items.length + 1;
      items.push({ n, id: a.id as string });
      return `[${n}] (${a.source_type}) ${a.statement}`;
    });
    const code = (src as unknown as { code?: string; version?: number }).code ?? "";
    const version = (src as unknown as { version?: number }).version ?? 1;
    parts.push(`<source id="${code} v${version}" title="${src.title.replace(/"/g, "'")}">
${(secs ?? []).map((x) => `## ${x.heading}\n\n${x.content}`).join("\n\n")}

<approved_research>
${lines.join("\n") || "(none)"}
</approved_research>
</source>`);
  }
  const recipe = (format?.recipe ?? {}) as { outline?: { mode?: string; template?: string[] }; contract?: { mode?: string } };
  const target = `<target_format name="${format?.name}">
${format?.description ?? ""}
Outline: ${recipe.outline?.mode === "off" ? "none (single section)" : recipe.outline?.mode === "fixed" ? `fixed: ${(recipe.outline.template ?? []).join(" / ")}` : "free"}
Reader contract: ${recipe.contract?.mode ?? "full"}
${profile?.content?.trim() ? `Style profile:\n${profile.content.trim()}` : ""}
</target_format>`;
  const user = `${parts.join("\n\n")}\n\n${target}\n\n<specific_requirements>\n${plan.instructions || "(none)"}\n</specific_requirements>`;
  const system = `${REPURPOSE_BASE}\n\n${REPURPOSE_SHAPES[plan.shape]}`;
  return {
    companyId: plan.company_id,
    taskType: "reason",
    system,
    user,
    expectedOutputTokens: 2500,
    run: async () => {
      const r = await runModel<{ entries: { heading: string; angle: string; notes: string; items: number[]; sections: { heading: string; purpose: string }[] }[]; not_translated: string[]; gaps: string[] }>(
        plan.company_id, { taskType: "reason", system, user, schema: repurposeSchema, schemaName: "repurpose_plan", maxTokens: 16000 },
      );
      await recordUsage(plan.company_id, userId, "repurpose_plan", "reason", r);
      const entries = (plan.shape === "split" ? r.data.entries : r.data.entries.slice(0, 1)).map((e) => ({
        heading: e.heading,
        angle: e.angle,
        notes: e.notes,
        item_ids: e.items.map((n) => items.find((i) => i.n === n)?.id).filter((x): x is string => Boolean(x)),
        sections: e.sections,
      }));
      const proposal = { entries, not_translated: r.data.not_translated, gaps: r.data.gaps };
      const { error } = await admin.from("repurpose_plans").update({ proposal }).eq("id", plan.id);
      if (error) throw error;
      return { proposal, cost_usd: r.costUsd, model: r.model };
    },
  };
}

// ---------------------------------------------------------------------------
// Learning from the writer: edits and feedback -> voice memory suggestions
// ---------------------------------------------------------------------------

const LEARN_SYSTEM = `You learn how a company's writer wants their writing to read, from what they
changed and what they said. You'll see: AI drafts next to what the writer kept, the assembled draft
next to the version they published, and the writer's own messages during the piece.

Suggest voice rules the writer would recognise as theirs: specific, behavioural and reusable across
pieces ("Open with the claim, not the context"; "Never use 'leverage'"; "Numbers as digits"). Skip
anything already in the core voice or the existing memory, anything that only applies to this topic,
and anything you can't point to evidence for. For each rule, quote or describe the evidence briefly.
Return at most 6 rules, or none.`;

const learnSchema = obj({ rules: list(obj({ rule: str, evidence: str })) });

async function prepareLearn(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "signoff.learn"), "Learning from pieces");
  const { data: sections } = await admin.from("piece_sections").select("heading, content, ai_draft").eq("piece_id", piece.id)
    .order("position");
  const { data: full } = await admin.from("pieces").select("final_text").eq("id", piece.id).single();
  const { data: threads } = await admin.from("threads").select("thread_messages(role, content)").eq("piece_id", piece.id);
  const writerSaid = (threads ?? []).flatMap((t) => (t.thread_messages ?? []) as { role: string; content: string }[])
    .filter((m) => m.role === "writer").map((m) => `- ${m.content}`);
  const edits = (sections ?? []).filter((s) => s.ai_draft && s.ai_draft.trim() !== s.content.trim())
    .map((s) => `<section heading="${s.heading}">\n<ai_draft>\n${s.ai_draft}\n</ai_draft>\n<writer_kept>\n${s.content}\n</writer_kept>\n</section>`);
  const assembled = (sections ?? []).map((s) => `## ${s.heading}\n\n${s.content}`).join("\n\n");
  const published = full?.final_text?.trim() && full.final_text.trim() !== assembled.trim()
    ? `<assembled_draft>\n${assembled}\n</assembled_draft>\n<published_version>\n${full.final_text}\n</published_version>`
    : "";
  if (!edits.length && !published && !writerSaid.length) {
    throw new UserError("Nothing to learn from yet: no edited AI drafts, no pasted final version, no feedback messages.");
  }
  const context = await contextFor(piece, ["core_voice", "voice_memory"]);
  const user = `${context}\n\n${edits.join("\n\n")}\n\n${published}\n\n<writer_messages>\n${writerSaid.join("\n") || "(none)"}\n</writer_messages>`;
  return task<{ rules: { rule: string; evidence: string }[] }>("learn_voice", "reason", piece, userId, LEARN_SYSTEM, user,
    learnSchema, 800, async (data, cost, model) => {
      await logEvent(piece, userId, "voice_learned", { suggestions: data.rules.length });
      return { rules: data.rules, cost_usd: cost, model };
    });
}

export const WRITING_TASKS: Record<string, (userId: string, body: Record<string, unknown>) => Promise<Prepared>> = {
  analysis: prepareAnalysis,
  outline_suggest: prepareOutline,
  section_brief: prepareBrief,
  section_draft: prepareDraft,
  grammar_check: prepareGrammar,
  fact_check: prepareFacts,
  contract_check: prepareContractCheck,
  learn_voice: prepareLearn,
  seo_geo_check: prepareSeoGeo,
  repurpose_plan: prepareRepurpose,
};
