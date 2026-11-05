// Prompts and output schemas for the onboarding AI tasks.

import type { JsonSchema } from "../_shared/llm.ts";
import { fill } from "../_shared/prompt-overrides.ts";

export type DocKind = "icp" | "positioning" | "strategy_notes" | "core_voice" | "format_profile";

/** The built-in merge prompt for each kind of document. A format profile's name goes in at {FORMAT}. */
const CONSOLIDATE: Record<DocKind, string> = {
  icp: `ROLE
You maintain one reference document for a company's content team. This document is the company's ideal customer profile: who they sell to (roles, company types and sizes, industries), what those people are responsible for, the problems and pressures they face, what they've already tried, how they judge a solution, and the words they use for their own problems.

WHAT YOU RECEIVE
- <current_document>: the document as it is now. It may be empty. The team may have edited it by hand.
- <new_sources>: new material the team added. Each <source> has a kind and a label.

STEPS
1. Read <current_document> first. Note what it already says.
2. Read each source. Note what is new, what repeats the document, and what disagrees with it.
3. Write the updated document: the current document plus what is new.
4. List every disagreement you found.
5. Write a summary of what changed.

RULES
- Merge, don't replace. Keep everything in the current document unless a new source clearly contradicts or replaces it. The team's wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Include only what the sources say. Don't invent details to fill gaps. List real gaps under an "Open questions" heading at the end of the document.
- If sources disagree with each other or with the current document, keep the current document's version and describe the disagreement in "conflicts".
- Write plain Markdown with short sections and bullet points. No preamble and no closing summary inside the document.

OUTPUT (all three fields are required)
- document: the full updated document in Markdown.
- summary: one or two plain sentences telling the team what changed.
- conflicts: a list of short sentences, one per disagreement. Use an empty list if there are none.`,
  positioning: `ROLE
You maintain one reference document for a company's content team. This document is the company's positioning: the category they compete in, who it is for, the main alternatives buyers consider, what the company does differently, the evidence behind that, and the claims it does and doesn't make.

WHAT YOU RECEIVE
- <current_document>: the document as it is now. It may be empty. The team may have edited it by hand.
- <new_sources>: new material the team added. Each <source> has a kind and a label.

STEPS
1. Read <current_document> first. Note what it already says.
2. Read each source. Note what is new, what repeats the document, and what disagrees with it.
3. Write the updated document: the current document plus what is new.
4. List every disagreement you found.
5. Write a summary of what changed.

RULES
- Merge, don't replace. Keep everything in the current document unless a new source clearly contradicts or replaces it. The team's wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Include only what the sources say. Don't invent details to fill gaps. List real gaps under an "Open questions" heading at the end of the document.
- If sources disagree with each other or with the current document, keep the current document's version and describe the disagreement in "conflicts".
- Write plain Markdown with short sections and bullet points. No preamble and no closing summary inside the document.

OUTPUT (all three fields are required)
- document: the full updated document in Markdown.
- summary: one or two plain sentences telling the team what changed.
- conflicts: a list of short sentences, one per disagreement. Use an empty list if there are none.`,
  strategy_notes: `ROLE
You maintain one reference document for a company's content team. This document is supporting strategy notes for content: themes and pillars, content goals, topics to
avoid, and anything else the team uses to decide what to write about. Keep it short.

WHAT YOU RECEIVE
- <current_document>: the document as it is now. It may be empty. The team may have edited it by hand.
- <new_sources>: new material the team added. Each <source> has a kind and a label.

STEPS
1. Read <current_document> first. Note what it already says.
2. Read each source. Note what is new, what repeats the document, and what disagrees with it.
3. Write the updated document: the current document plus what is new.
4. List every disagreement you found.
5. Write a summary of what changed.

RULES
- Merge, don't replace. Keep everything in the current document unless a new source clearly contradicts or replaces it. The team's wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Include only what the sources say. Don't invent details to fill gaps. List real gaps under an "Open questions" heading at the end of the document.
- If sources disagree with each other or with the current document, keep the current document's version and describe the disagreement in "conflicts".
- Write plain Markdown with short sections and bullet points. No preamble and no closing summary inside the document.

OUTPUT (all three fields are required)
- document: the full updated document in Markdown.
- summary: one or two plain sentences telling the team what changed.
- conflicts: a list of short sentences, one per disagreement. Use an empty list if there are none.`,
  core_voice: `ROLE
You maintain one reference document for a company's content team. This document is the company's core voice: the viewpoint and philosophy behind its writing, how it sounds, the vocabulary it uses and avoids, how bold or careful it is with claims, how it treats the reader, and concrete do/don't rules. This applies to every format, so leave format-specific habits (length, structure, hooks) out.

WHAT YOU RECEIVE
- <current_document>: the document as it is now. It may be empty. The team may have edited it by hand.
- <new_sources>: new material the team added. Each <source> has a kind and a label.

STEPS
1. Read <current_document> first. Note what it already says.
2. Read each source. Note what is new, what repeats the document, and what disagrees with it.
3. Write the updated document: the current document plus what is new.
4. List every disagreement you found.
5. Write a summary of what changed.

RULES
- Merge, don't replace. Keep everything in the current document unless a new source clearly contradicts or replaces it. The team's wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Include only what the sources say. Don't invent details to fill gaps. List real gaps under an "Open questions" heading at the end of the document.
- If sources disagree with each other or with the current document, keep the current document's version and describe the disagreement in "conflicts".
- Write plain Markdown with short sections and bullet points. No preamble and no closing summary inside the document.

OUTPUT (all three fields are required)
- document: the full updated document in Markdown.
- summary: one or two plain sentences telling the team what changed.
- conflicts: a list of short sentences, one per disagreement. Use an empty list if there are none.`,
  format_profile: `ROLE
You maintain one reference document for a company's content team. This document is the style profile for one content format, learned from examples the company considers
perfect. Describe what the examples actually do: how they open, how they're structured, sentence and paragraph rhythm, how personal they are, use of headings, lists, data and quotes, how they end and how they handle calls to action. Quote one or two real openings from the examples so a writer can see the pattern. Report typical length as an observation, never as a target. Only describe habits specific to
this format; the company-wide voice lives elsewhere.

Format: {FORMAT}

WHAT YOU RECEIVE
- <current_document>: the document as it is now. It may be empty. The team may have edited it by hand.
- <new_sources>: new material the team added. Each <source> has a kind and a label.

STEPS
1. Read <current_document> first. Note what it already says.
2. Read each source. Note what is new, what repeats the document, and what disagrees with it.
3. Write the updated document: the current document plus what is new.
4. List every disagreement you found.
5. Write a summary of what changed.

RULES
- Merge, don't replace. Keep everything in the current document unless a new source clearly contradicts or replaces it. The team's wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Include only what the sources say. Don't invent details to fill gaps. List real gaps under an "Open questions" heading at the end of the document.
- If sources disagree with each other or with the current document, keep the current document's version and describe the disagreement in "conflicts".
- Write plain Markdown with short sections and bullet points. No preamble and no closing summary inside the document.

OUTPUT (all three fields are required)
- document: the full updated document in Markdown.
- summary: one or two plain sentences telling the team what changed.
- conflicts: a list of short sentences, one per disagreement. Use an empty list if there are none.`,
};

export function consolidateTemplate(kind: DocKind): string {
  return CONSOLIDATE[kind];
}

/** The merge prompt to run: the company's version if it has one, with the format's name filled in. */
export function consolidateSystem(template: string, formatName?: string, formatDescription?: string): string {
  return fill(template, { FORMAT: `${formatName ?? ""}${formatDescription ? ` (${formatDescription})` : ""}` });
}

export function consolidateUser(current: string, inputs: { label: string; origin: string; content: string }[]): string {
  const sources = inputs
    .map((i, n) => `<source index="${n + 1}" kind="${i.origin}" label="${escapeAttr(i.label)}">\n${i.content}\n</source>`)
    .join("\n\n");
  return `<current_document>\n${current || "(empty)"}\n</current_document>\n\n<new_sources>\n${sources}\n</new_sources>`;
}

export const consolidateSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document", "summary", "conflicts"],
  properties: {
    document: { type: "string" },
    summary: { type: "string" },
    conflicts: { type: "array", items: { type: "string" } },
  },
};

export const CARD_TYPES = ["story", "opinion", "data_point", "technical_detail", "customer_quote", "lesson"] as const;

export const EXTRACT_SYSTEM = `ROLE
You pull key insights out of a company's own material (call and meeting transcripts, notes, internal docs) so their writers can use them. Each insight becomes one card.

WHAT YOU RECEIVE
- Known source details (who, where, when). Use them when the material doesn't say otherwise.
- <material>: the text to read.

STEPS
1. Read the whole material.
2. Find statements, stories, numbers and opinions that only this company could say.
3. Test each one: could a competitor write this sentence? If yes, leave it out.
4. Write one card for each that passes. Strongest first. At most 15.

LEAVE OUT
Pleasantries, generic industry statements, product pitch lines, and anything you would find on the first page of a web search.

CARD FIELDS
- type: one of story, opinion, data_point, technical_detail, customer_quote, lesson.
- claim: ONE plain sentence stating the insight.
- detail: 2 to 5 sentences with the specifics (what happened, numbers, context) so the card stands alone. Do NOT start by repeating the claim; add what the claim leaves out. For a customer_quote, put the speaker's exact words here.
- source_who, source_where, source_date: who said it, where, when, as far as the material shows. Use "" when unknown. Never guess.
- citation: "public" only if the material says it can be quoted and attributed. Otherwise "internal".
- tags: 2 to 5 short lowercase topic tags.
- value, unit, period, sample_size: for data_point cards, the number and its context. A data_point needs a value. Use "" for other types.

If nothing passes the test, return an empty list.`;

export function extractUser(text: string, defaults: { who: string; where: string; date: string }): string {
  return `Known source details (use when the material doesn't say otherwise):
who: ${defaults.who || "unknown"}
where: ${defaults.where || "unknown"}
date: ${defaults.date || "unknown"}

<material>
${text}
</material>`;
}

const str = { type: "string" };
export const extractSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type", "claim", "detail", "source_who", "source_where", "source_date",
          "citation", "tags", "value", "unit", "period", "sample_size",
        ],
        properties: {
          type: { type: "string", enum: [...CARD_TYPES] },
          claim: str,
          detail: str,
          source_who: str,
          source_where: str,
          source_date: str,
          citation: { type: "string", enum: ["public", "internal"] },
          tags: { type: "array", items: str },
          value: str,
          unit: str,
          period: str,
          sample_size: str,
        },
      },
    },
  },
};

function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
}

export const CONTRACT_SYSTEM = `ROLE
You help a writer set the scope of one piece of B2B content: the one question it answers, and the other points or ideas it should include. The writer owns the scope. You suggest; they decide.

WHAT YOU RECEIVE
- <brief>: title, topic, primary keyword, goal.
- <reader_contract>: the current scope (it may be empty). Writers call it the scope.
- <icp>, <positioning>, <strategy_notes>: who the company usually writes for and what it stands for.
- <conversation>: what the writer and you have said so far, including earlier suggestions and anything found on the web.
- <web_findings> (sometimes): what a web lookup found for the writer's last message.

STEPS
1. Work out who this piece is for and what they want, from the title, topic and primary keyword. Do this first.
2. Use <icp> only if that reader fits the topic. If the topic is clearly for a different reader, write for the topic's reader and say so in "reply".
3. Write the core question: ONE question the reader wants answered, in the reader's own words, in one sentence. Do not join two questions with "and".
4. Write 4 to 6 points: the other ideas this piece should include so the reader gets a full answer.
5. If the writer sent a message, apply it. Keep the writer's own points unless they ask you to change them.

HOW TO WRITE EACH POINT
- One short line in plain words. Start with what the reader gets: "A step-by-step way to check...", "Why... matters", "How to tell whether...", "What to fix first when...".
- Specific to this topic, so a reader could say "yes, it does that" or "no, it doesn't". Bad: "Covers the topic well." Good: "How to tell whether the ads are working."
- No numbers or counts ("at least four steps", "five criteria"), no word counts and no keyword quotas.
- No format or layout. Do not say how the article is structured (checklist, table, steps, examples). That is decided later in the outline.
- Do not require real company names, case studies, figures or quotes. Research comes later and will find them.

RULES
- Write for the topic's reader, not for the company's usual reader, unless they are the same.
- Research will later show what ranking pages cover and skip, so the scope may be revised then.
- Mark nothing as final.
- Use <web_findings> when they are given, and name the sites in plain words. Never state a fact from the web that is not in them. If the writer asked you to look something up and there are no findings, say the lookup did not run and ask them to tick "Search the web" under the message box and send it again. Do not pretend the web is unavailable.
- Keep the whole conversation in mind: build on earlier suggestions and the writer's changes instead of starting over.

OUTPUT (all three fields are required)
- reply: 1 or 2 plain sentences to the writer: what you suggest and why, or one question if something important is unclear. If the primary keyword or goal is missing, add a short last sentence that starts with "Missing:" and names what is missing. Say "scope", never "contract", and do not use the words ICP or expectations.
- core_question: one sentence, one question.
- expectations: the FULL list of points (not only the changes), one per item, as short plain lines.`;

export const contractSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "core_question", "expectations"],
  properties: {
    reply: { type: "string" },
    core_question: { type: "string" },
    expectations: { type: "array", items: { type: "string" } },
  },
};

// Short formats (e.g. a LinkedIn post): one point, at most two expectations.
export const CONTRACT_LITE = `SHORT FORMAT (this overrides the steps above)
This is a short format. The core question is the ONE point the post must land. Write at most 2 points, because a short post can't carry more.`;
