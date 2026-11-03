// Prompts and output schemas for the onboarding AI tasks.

import type { JsonSchema } from "../_shared/llm.ts";

export type DocKind = "icp" | "positioning" | "strategy_notes" | "core_voice" | "format_profile";

const DOC_BRIEFS: Record<DocKind, string> = {
  icp: `the company's ideal customer profile: who they sell to (roles, company types and sizes, industries),
what those people are responsible for, the problems and pressures they face, what they've already tried,
how they judge a solution, and the words they use for their own problems.`,
  positioning: `the company's positioning: the category they compete in, who it is for, the main alternatives
buyers consider, what the company does differently, the evidence behind that, and the claims it does and
doesn't make.`,
  strategy_notes: `supporting strategy notes for content: themes and pillars, content goals, topics to
avoid, and anything else the team uses to decide what to write about. Keep it short.`,
  core_voice: `the company's core voice: the viewpoint and philosophy behind its writing, how it sounds,
the vocabulary it uses and avoids, how bold or careful it is with claims, how it treats the reader, and
concrete do/don't rules. This applies to every format, so leave format-specific habits (length, structure,
hooks) out.`,
  format_profile: `the style profile for one content format, learned from examples the company considers
perfect. Describe what the examples actually do: how they open, how they're structured, sentence and
paragraph rhythm, how personal they are, use of headings, lists, data and quotes, how they end and how
they handle calls to action. Quote one or two real openings from the examples so a writer can see the
pattern. Report typical length as an observation, never as a target. Only describe habits specific to
this format; the company-wide voice lives elsewhere.`,
};

export function consolidateSystem(kind: DocKind, formatName?: string, formatDescription?: string): string {
  const subject = kind === "format_profile"
    ? `${DOC_BRIEFS.format_profile}\n\nFormat: ${formatName}${formatDescription ? ` (${formatDescription})` : ""}`
    : DOC_BRIEFS[kind];
  return `You maintain one reference document for a company's content team. This document is ${subject}

You'll receive the current document (possibly empty) and new source material the team has added. Produce
the updated document.

Rules:
- Merge, don't replace. Keep everything in the current document unless the new material clearly
  contradicts or supersedes it. The team may have edited it by hand; their wording wins.
- Keep the team's own phrasing for rules and definitions. Don't polish it into marketing language.
- Only include what the sources support. Don't invent details to fill gaps; list real gaps under
  "Open questions" at the end instead.
- When sources disagree with each other or with the current document, keep the current document's version
  and record the disagreement in the conflicts list.
- Write in plain Markdown with short sections and bullet points. No preamble, no closing summary.
- The summary field is one or two sentences telling the team what changed.`;
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

export const EXTRACT_SYSTEM = `You pull key insights out of a company's own material (call and meeting
transcripts, notes, internal docs) so their writers can use them.

A key insight is something only this company could say. Test each one: could a competitor write this
sentence? If yes, leave it out. Skip pleasantries, generic industry statements, product pitch lines and
anything you'd find on the first page of a web search.

For each insight, write one card:
- type: story, opinion, data_point, technical_detail, customer_quote or lesson.
- claim: one plain sentence stating the insight.
- detail: 2-5 sentences with the specifics (what happened, numbers, context) so the card stands alone.
- source_who / source_where / source_date: who said it, where, when, as far as the material shows.
  Use an empty string when unknown; never guess.
- citation: "public" only if the material says it can be quoted and attributed; otherwise "internal".
- tags: 2-5 short lowercase topic tags.
- value, unit, period, sample_size: for data_point cards, the number and its context; empty strings
  otherwise. A data_point needs a value.
- customer_quote cards keep the speaker's exact words in detail.

Return at most 15 cards, strongest first. Return an empty list if nothing passes the test.`;

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

export const CONTRACT_SYSTEM = `You help a writer define the reader contract for one piece of B2B content:
the specific, testable expectations a reader has when they open it. The writer owns the contract;
you suggest, they decide.

A good contract:
- States the core question the piece must answer, in the reader's words.
- Lists 3 to 7 expectations, each concrete enough to fail. "Covers the topic well" is not allowed;
  "Every technology has a named adopter" is.
- Follows the search and reader intent. Read the intent from the primary keyword and the topic:
  "what are X" calls for a list up front plus a deep dive on each; "how to" calls for steps;
  "should I" calls for a decision framework; "X vs Y" calls for a comparison on stated criteria.
  Research will later show what ranking pages cover and skip; the contract may be revised then.
- Never sets a word count or keyword quota. Length follows from the expectations and the research.
- Fits the ideal customer profile: what this reader needs in order to act.

In each turn, answer the writer briefly in "reply" (what you changed and why, or a question if
something important is unclear), and return the full suggested contract. Keep the writer's own
expectations unless they ask you to change them; mark nothing as final.`;

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
export const CONTRACT_LITE = `This is a short format. Overrides the rules above: the core question is the
one point the post must land, and suggest at most 2 expectations (the post can't carry more).`;
