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
import { promptSet } from "../_shared/prompt-overrides.ts";

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

export const ANALYSIS_SYSTEM = `ROLE
You analyse reviewed research for one piece of B2B content before it is outlined. You do not write the piece. Your job is to show the writer where the real substance is.

WHAT YOU RECEIVE
- <brief> and <reader_contract>: what the piece is about and what the reader expects.
- <approved_research>: numbered items, written [1], [2], and so on. Items from the company's own insight cards are marked "card". Everything else is from outside sources.

STEPS
1. Read every approved item.
2. Look for each of the four things below. Take them one at a time.
3. For each thing you find, write one short, concrete entry. Refer to items by their number.

THE FOUR THINGS
- tensions: places where two or more items disagree, or where the evidence is mixed. Entry: "text" says what disagrees; "items" lists the item numbers.
- consensus_vs_insight: places where a "card" item confirms or contradicts what the outside items say. These are the strongest angles ("everyone says X; our own calls say Y"). Entry: "text" says what the consensus is and what the company's view is; "items" lists the numbers.
- gaps: important questions for this reader that no approved item answers. Entry: "text" names the gap; "expert_question" is ONE specific question the company's own expert could answer from experience.
- contract_suggestions: changes the research suggests for the reader contract, such as an expectation readers clearly need that the contract lacks, or one the evidence can't support. Entry: "change" says what to change; "why" says why. The writer decides.

RULES
- Use only the approved items. Don't bring in outside facts.
- Be concrete and brief: one or two sentences per entry.
- If there is nothing real for one of the four things, return an empty list for it. Never pad.`;

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
  const base = (await promptSet(piece.company_id))("analysis", ANALYSIS_SYSTEM);
  const system = off.length ? `${base}\n\nThis format doesn't use: ${off.join(", ")}. Return empty lists for those.` : base;
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

export const OUTLINE_SYSTEM = `ROLE
You are a writer outlining one piece of B2B content.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject and the numbered expectations the piece owes the reader.
- <analysis>: tensions, company insights and gaps found in the research.
- <approved_research>: numbered items.
- <format_profile> (sometimes): how pieces in this format are usually organised.
- <current_outline> and <conversation>: the outline now, and what the writer and you have said.

STEPS
1. Choose the shape from the reader's intent:
   - "what are X": the list up front, then one section per item
   - "how to": steps in order
   - "should I": a decision framework
2. Write the sections in a sensible order. Each section gets a heading and a one-line purpose.
3. For each section, list the numbers of the contract expectations it serves.
4. Check that every contract expectation is served by at least one section. If one is not, add or change a section, or say in "reply" that it is uncovered.
5. If the writer sent a message, apply it and keep the parts they didn't mention.

RULES
- Headings are specific to the sub-topic. Never use "Introduction", "Overview" or "Conclusion".
- Use the format profile only for structure (how pieces open and are organised), not for wording.
- Don't plan word counts.

OUTPUT (both fields are required)
- reply: 1 to 3 sentences to the writer: what you changed and why, or one question.
- sections: the FULL outline. Each section has "heading", "purpose" (one line) and "expectations" (a list of contract expectation numbers).`;

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
    "outline_suggest", "reason", piece, userId, (await promptSet(piece.company_id))("outline", OUTLINE_SYSTEM), user, outlineSchema, 2000,
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

export const BRIEF_SYSTEM = `ROLE
You write the brief for ONE section of a piece. The writer will write the section by hand from your bullets, so the bullets must carry content, not style.

WHAT YOU RECEIVE
- <section>: the heading, its purpose, and the contract expectations it owes.
- <outline>, <analysis>: the whole piece's plan and what the research found.
- <section_research>: numbered approved items, [1], [2], and so on.

STEPS
1. Read the expectations this section owes. Each one must be covered by at least one bullet.
2. Read the approved items. Pick the facts this section needs.
3. If the analysis shows a tension, or a company insight that contradicts the consensus, and it belongs in this section, add a bullet for it.
4. Write 4 to 10 bullets in a sensible order. Put the "answer:" bullet first.

BULLET RULES
- Format: "label: content". Labels are short, such as answer, what, use, adopter, limit, cost, our view.
- Fragments and keywords only. No full sentences, no transitions, no adjectives, nothing quotable. Elaborate phrasing would leak into the writer's style and make the text read as AI-written.
- One idea per bullet.
- The first bullet is "answer:": the section's core answer in a few words, so the writer can open with it.
- Use only approved research. Never add a fact that is not in an item.
- "refs" lists the numbers of the items a bullet uses. A bullet that is the writer's own argument or experience has an empty list.

EXAMPLE (invented subject; shows the style only)
- answer: virtual copy of the supply network; tests changes before they happen  (refs: [4])
- adopter: Acme Foods, 2023  (refs: [7])
- limit: data integration cost  (refs: [9])
- our view: customers stall at data prep  (refs: [])`;

// Short, single-section formats (a LinkedIn post, a social post).
export const BRIEF_SHORT = `SHORT FORMAT (this overrides the steps above)
This is a short, single-section format. Write 3 to 6 bullets in exactly this order:
- hook: the idea of the opening line (not its wording)
- answer: the one point
- proof: one or two facts or a story, with refs
- close: the takeaway or a question; add a call to action only if the brief has one`;

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
  const prompts = await promptSet(piece.company_id);
  const system = single
    ? `${prompts("brief.base", BRIEF_SYSTEM)}\n\n${prompts("brief.short", BRIEF_SHORT)}`
    : prompts("brief.base", BRIEF_SYSTEM);
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

export const DRAFT_SYSTEM = `ROLE
You draft ONE section of a piece for a company's writer, who will edit it afterwards.

WHAT YOU RECEIVE
- <section>: the heading and purpose. <outline>: the whole piece's plan.
- <section_research> (or <approved_research>): numbered approved items.
- <core_voice>, <format_profile>, <voice_memory>: how the company writes.
- <brief>: the bullets to follow.

STEPS
1. Follow the brief bullets in order. Every bullet must appear in the draft.
2. Open with the "answer:" bullet's point, in one or two plain sentences.
3. For each fact or figure, use the approved item it comes from and say in the text where it comes from.
4. Write in the company's core voice, with the habits of the format profile, and obey the voice memory.

RULES
- Use only the approved research for facts and figures. Do NOT add any other number, name, date or claim.
- Bullets without a research item are the writer's own view. Write them as that view and add no facts.
- No heading, no preamble, no closing summary, no "In conclusion".
- Plain prose the writer can edit.

OUTPUT
- text: the section text only.`;

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
  return task<{ text: string }>("section_draft", "write", piece, userId, (await promptSet(piece.company_id))("draft", DRAFT_SYSTEM), user, obj({ text: str }), 2500,
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

export const GRAMMAR_SYSTEM = `ROLE
You are a grammar checker, like a conventional spelling and grammar plugin.

WHAT YOU RECEIVE
- <text>: the writer's text.

STEPS
1. Read the text one sentence at a time.
2. For each spelling mistake, grammar mistake or punctuation mistake, write one suggestion.

RULES
- Correct ONLY spelling, grammar and punctuation.
- Never change style, tone, clarity, length or word choice that is already correct.
- Never rewrite a sentence. Never suggest a "better" way to say something.
- If the text is correct, return an empty list.

OUTPUT (for each suggestion)
- original: the few words around the error, copied exactly from the text. It must appear in the text word for word, and be short.
- replacement: the same words with the error fixed.
- reason: a few words, such as "missing comma" or "spelling".

EXAMPLE
original: "their going to launch"   replacement: "they're going to launch"   reason: "their / they're"`;

const grammarSchema = obj({ suggestions: list(obj({ original: str, replacement: str, reason: str })) });

async function prepareGrammar(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "checks.grammar"), "The grammar check");
  const text = String(body.text ?? section.content).trim();
  if (!text) throw new UserError("Write something first.");
  return task<{ suggestions: { original: string; replacement: string; reason: string }[] }>("grammar_check", "extract",
    piece, userId, (await promptSet(piece.company_id))("grammar", GRAMMAR_SYSTEM), `<text>\n${text}\n</text>`, grammarSchema, 800, async (data, cost, model) => ({
      suggestions: data.suggestions.filter((s) => s.original && s.original !== s.replacement && text.includes(s.original)),
      cost_usd: cost,
      model,
    }));
}

export const FACT_SYSTEM = `ROLE
You check a section a writer wrote against the research they approved. You do not edit the text.

WHAT YOU RECEIVE
- <section_research> (or <approved_research>): numbered approved items, [1], [2], and so on.
- <written_section>: the writer's text.

STEPS
1. Go through the written section sentence by sentence.
2. Pick out each sentence that states a number, date, name, ranking or other factual claim.
3. For each one, look for an approved item that supports it.
   - Found and it matches: say nothing.
   - Found but the text gets it wrong (wrong figure, year, scope or attribution): flag it as "mismatch".
   - Not found in any approved item: flag it as "unsupported".

RULES
- Opinions, arguments and the writer's own experience are fine. Don't flag them.
- Judge only against the approved items. Do not use your own knowledge to decide what is true.
- If everything checks out, return an empty list.

OUTPUT (for each flag)
- sentence: the sentence copied exactly from the written section.
- kind: "unsupported" or "mismatch".
- issue: one plain sentence saying what is wrong. For a mismatch, say what the item says.
- item: the item number for a mismatch. Use 0 for "unsupported".`;

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
    userId, (await promptSet(piece.company_id))("fact", FACT_SYSTEM), user, factSchema, 1000, async (data, cost, model) => {
      const result = {
        checked_at: new Date().toISOString(),
        flags: data.flags.map((f) => ({ ...f, item_id: items.find((i) => i.n === f.item)?.id ?? null })),
      };
      await admin.from("piece_sections").update({ fact_check: result }).eq("id", section.id);
      await logEvent(piece, userId, "fact_check_run", { section: section.id, flags: result.flags.length });
      return { ...result, cost_usd: cost, model };
    });
}

export const CONTRACT_CHECK_SYSTEM = `ROLE
You check written text against a reader contract. There is no score.

WHAT YOU RECEIVE
- <reader_contract>: the core question and a numbered list of expectations.
- <text>: the text to check.

STEPS
For EACH numbered expectation, in order:
1. Search the text for what delivers it.
2. Decide the status:
   - "met": the text fully delivers it.
   - "partly": the text delivers some of it.
   - "missing": the text does not deliver it.
3. Fill in the evidence and the gap as described below.

RULES
- Judge only what the text actually says, not what it might mean or what the writer probably intended.
- Return one result for every expectation, using its number.

OUTPUT (for each expectation)
- expectation: its number.
- status: "met", "partly" or "missing".
- evidence: for met and partly, the shortest passage from the text that shows it, copied exactly. For missing, an empty string.
- gap: for partly and missing, one plain sentence saying what is missing. For met, an empty string.`;

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
    piece, userId, (await promptSet(piece.company_id))("contract_check", CONTRACT_CHECK_SYSTEM), user, contractCheckSchema, 1200, async (data, cost, model) => {
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
// SEO and GEO checks (outline and finished piece). Based on common SEO/GEO
// guidelines, as checklists with evidence, never a score or keyword quota.
// ---------------------------------------------------------------------------

export const SEO_GEO_BASE = `ROLE
You review a piece of B2B content for search (SEO) and for being cited by AI answer engines such as Google AI Overviews, ChatGPT search and Perplexity (GEO). You give a checklist, not a score.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and what the reader expects.
- <search_landscape>: what ranking pages cover and skip, and what people ask.
- Either an <outline> or the finished <piece>. The list of checks below says which.

STEPS
1. Read the checks listed below.
2. For EACH check, look at the outline or piece and decide: "fine", "improve" or "n/a".
3. For "improve", write one concrete, specific fix.

RULES
- Never suggest keyword density, repeating the keyword, term quotas or padding. A reader-first piece that answers the intent well beats one tuned to a tool.
- Judge only what you can see in the outline or piece. Use "n/a" when a check doesn't apply.

OUTPUT (for each check)
- area: "seo" or "geo", as the check is grouped below.
- check: the check's key (the word before the colon, such as "answer_first").
- label: a short plain-English name for the check.
- status: "fine", "improve" or "n/a".
- evidence: what you saw, quoted from the outline or piece when you can.
- fix: for "improve", one concrete fix. Otherwise an empty string.`;

export const SEO_GEO_CHECKS = {
  outline: `Checks for an OUTLINE (judge the plan, not prose):

SEO
- intent: the outline's shape serves the search intent of the primary keyword.
- title: the working title states the topic plainly with the primary keyword near the start, in about 60 characters or fewer.
- headings: every section heading is descriptive and specific to its sub-topic; no generic placeholders such as "Introduction", "The current landscape", "Key considerations" or "Conclusion".
- answer_first: the first section delivers the core answer instead of background.
- questions: the questions people ask (from the search landscape) are covered by a section, or deliberately left out for a reason that fits the contract.
- coverage_gap: the outline covers at least one thing ranking pages skip or get wrong.

GEO
- extractable_sections: sections are planned so each can open with a short, standalone answer.
- structure: comparisons are planned as tables and procedures as numbered steps where the content calls for it.
- first_party: at least one section is built on the company's own insight or data.`,
  final: `Checks for the FINISHED PIECE:

SEO
- intent: the piece serves the search intent of the primary keyword.
- title: the title states the topic with the primary keyword near the start, about 60 characters or fewer.
- headings: headings are descriptive and specific; no generic placeholders.
- answer_first: the opening (roughly the first 150 words) gives the core answer.
- questions: the questions people ask are answered where they fit.
- internal_links: name 2 to 4 topics on the company's own site the piece should link to, with suggested anchor text (status "improve" with the suggestions, or "n/a").
- scannability: lists and short paragraphs where readers scan; no walls of text.

GEO
- answer_capsules: key sections open with a concise, standalone answer (about 40 to 60 words) that an answer engine could quote as is.
- self_contained_claims: important claims name their subject and context in the same sentence, so they still make sense when quoted alone.
- named_entities: real companies, products, standards and frameworks are named, not described vaguely.
- attribution: figures and claims say where they come from, in the text.
- structure: comparisons use tables and procedures use numbered steps where it helps.
- first_party: the piece includes the company's own insight or data, which answer engines can't find elsewhere.
- freshness: figures carry dates.

Also write a meta title (60 characters or fewer, primary keyword near the start) and a meta description (140 to 155 characters, plain value statement with the keyword once).`,
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
  const prompts = await promptSet(piece.company_id);
  const system = `${prompts("seo.base", SEO_GEO_BASE)}\n\n${prompts(`seo.${scope}`, SEO_GEO_CHECKS[scope])}${
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

export const REPURPOSE_BASE = `ROLE
You plan how to repurpose a company's finished content into another format. You plan; the writer decides and writes.

WHAT YOU RECEIVE
- One or more <source> pieces: their sections, and their approved research as numbered items [1], [2].
- <target_format>: the format to produce, its outline and contract mode, and its style profile.
- <specific_requirements>: extra instructions from the writer.

RULES
- Use only what the source pieces and their approved research contain. Never invent facts.
- Refer to research items by their number.
- Follow the writer's specific requirements when given.

OUTPUT FIELDS
- entries: the new pieces. Each has heading, angle, notes (for the writer), items (research item numbers) and sections (heading + purpose).
- not_translated: what doesn't carry over to the new medium. Empty unless the shape below asks for it.
- gaps: material the sources don't cover. Empty unless the shape below asks for it.`;

export const REPURPOSE_SHAPES: Record<string, string> = {
  split: `SHAPE: SPLIT one source into several pieces in the target format.
1. Find the distinct key points worth a piece of their own. Usually 3 to 7; fewer is fine if the source doesn't support more.
2. Each entry is one new piece: "heading" states the point; "angle" is the story or framing that makes this piece different from the others; "notes" are for the writer; "items" are the research items that support it.
3. Points must not overlap. Similar is fine; repeated is not.
4. Leave "sections" empty unless the target format has an outline.`,
  adapt: `SHAPE: ADAPT one source into exactly ONE piece in a different medium.
1. Return exactly one entry.
2. Map the source onto the target format's structure. List the target sections in order, each with a purpose saying which source sections or points it draws on. Use the target format's fixed outline when it has one.
3. In "not_translated", list what doesn't carry over to the new medium (tables, long citations, visual references) and say how to handle each.`,
  combine: `SHAPE: COMBINE several sources into exactly ONE longer piece.
1. Return exactly one entry.
2. Group the sources' points into themes. Propose the sections in a sensible order, each with a purpose naming which sources it draws on.
3. In "gaps", list the connecting material none of the sources covers. It will need new research or the writer's own knowledge.`,
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
  const prompts = await promptSet(plan.company_id);
  const system = `${prompts("repurpose.base", REPURPOSE_BASE)}\n\n${prompts(`repurpose.${plan.shape}`, REPURPOSE_SHAPES[plan.shape])}`;
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

export const LEARN_SYSTEM = `ROLE
You learn how a company's writer wants their writing to read, from what they changed and what they said.

WHAT YOU RECEIVE
- <core_voice> and <voice_memory>: the rules that already exist.
- <ai_draft> next to <writer_kept>: an AI draft and what the writer kept.
- <assembled_draft> next to <published_version>: what was assembled and what was finally published.
- <writer_messages>: what the writer said during the piece.

STEPS
1. Compare each AI draft with what the writer kept, and the assembled draft with the published version. Note what the writer changed, cut or added, and notice patterns.
2. Read the writer's messages for stated preferences.
3. Turn each clear pattern into one voice rule.
4. Drop any rule that is already in the core voice or the voice memory, that only applies to this topic, or that you cannot point to evidence for.

GOOD RULES are specific, behavioural and reusable across pieces:
- "Open with the claim, not the context."
- "Never use 'leverage'."
- "Write numbers as digits."
BAD RULES are vague ("Be more engaging") or topic-specific ("Mention Acme in the intro").

OUTPUT
- rules: at most 6, or an empty list. Each has "rule" (one sentence) and "evidence" (a short quote or
  description of what you saw).`;

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
  return task<{ rules: { rule: string; evidence: string }[] }>("learn_voice", "reason", piece, userId, (await promptSet(piece.company_id))("learn", LEARN_SYSTEM), user,
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
