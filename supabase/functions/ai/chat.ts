// Shared parts of the two AI conversations (scope and outline): reading the thread back, retrying the last
// answer, and looking things up on the web when the writer asks.

import type Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { admin } from "../_shared/supabase.ts";
import { callAnthropicCited, callOpenAISearch, connect } from "../_shared/llm.ts";
import { costUsd, SEARCH_COST_USD } from "../_shared/models.ts";
import type { Piece } from "../_shared/context.ts";
import { promptSet } from "../_shared/prompt-overrides.ts";

export interface ThreadRow {
  id: string;
  role: string;
  content: string;
  payload: Record<string, unknown> | null;
}

/** Whether a message asks the AI to look something up online. A plain keyword check: cheap and predictable. */
export function wantsWeb(message: string): boolean {
  return /\b(search\w*|google|look(?:ing)?\s*(?:up|for|into)|lookup|internet|web|online|competitors?|competing|serp|top[- ]ranking|ranking (?:pages|articles)|latest|recent|news|statistics|stats|benchmarks?|find out|find (?:me )?(?:articles|pages|examples|data|sources|stats)|browse|browsing|articles? (?:on|about|covering)|similar (?:keywords?|topics?|pages|articles))\b/i
    .test(message);
}

/** The conversation as text for the model: each reply with what it suggested and any web findings it used. */
export function describeThread(rows: ThreadRow[], extra?: { role: string; content: string }): string {
  const parts = rows.map((m) => {
    const p = m.payload ?? {};
    const lines = [m.content];
    if (typeof p.core_question === "string" && Array.isArray(p.expectations)) {
      lines.push(`Suggested scope: ${p.core_question}`, ...(p.expectations as string[]).map((x) => `- ${x}`));
    }
    if (Array.isArray(p.sections)) {
      lines.push("Suggested outline:", ...(p.sections as { heading: string; purpose: string }[]).map((s, i) => `${i + 1}. ${s.heading} (${s.purpose})`));
    }
    const web = p.web as { findings?: string } | undefined;
    if (web?.findings) lines.push(`Web findings used:\n${web.findings}`);
    return `<${m.role}>\n${lines.join("\n")}\n</${m.role}>`;
  });
  if (extra) parts.push(`<${extra.role}>\n${extra.content}\n</${extra.role}>`);
  return parts.join("\n");
}

export const WEB_LOOKUP_SYSTEM = `ROLE
You look things up on the web for a writer who is planning one piece of B2B content. You do not plan the piece. You bring back facts and what other pages do.

WHAT YOU RECEIVE
- <piece>: the title, topic and primary keyword, so every search stays on the subject.
- <request>: what the writer asked you to look up.
- <conversation>: what was said so far, for context.

STEPS
1. Work out what the writer wants to know.
2. Search the web for it. Every search must be about the piece's subject.
3. Write down what you found, as short bullets.

RULES
- Use only what you found on pages. Never fill a gap from memory.
- End each bullet with the site it came from, in brackets, such as (source: example.com).
- Write 4 to 8 bullets. If you found nothing useful, say so in one line.
- Plain words. No advice on how to write the piece.

OUTPUT
Only the bullets, one per line, each starting with a dash.`;

export interface WebFindings {
  findings: string;
  sources: { url: string; title: string }[];
}

/**
 * Looks something up on the web for the conversation. Works with an Anthropic or OpenAI key; with any other
 * provider it says so, and the model is told it cannot browse. Usage is recorded as a research task.
 */
export async function webLookup(piece: Piece, userId: string, request: string, subject: string, thread: string): Promise<WebFindings | null> {
  const conn = await connect(piece.company_id, "research");
  if (conn.provider !== "anthropic" && conn.provider !== "openai") return null;
  const system = (await promptSet(piece.company_id))("chat.web", WEB_LOOKUP_SYSTEM);
  const user = `<piece>\nTitle: ${piece.title}\nSubject: ${subject}${piece.primary_keyword ? `\nPrimary keyword: ${piece.primary_keyword}` : ""}\n</piece>\n\n<request>\n${request}\n</request>\n\n<conversation>\n${thread || "(none yet)"}\n</conversation>`;
  const maxSearches = 3;
  let text = "";
  const sources = new Map<string, string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let searches = 0;
  if (conn.provider === "anthropic") {
    const r = await callAnthropicCited(conn, {
      system,
      content: [{ type: "text", text: user }],
      // Basic search, called directly: the newer version needs code execution, which some models reject.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches } as Anthropic.Beta.BetaToolUnion],
      effort: "low",
      maxTokens: 6000,
    });
    for (const block of r.content) {
      if (block.type !== "text") continue;
      text += block.text;
      for (const c of (block as { citations?: { type: string; url?: string; title?: string }[] | null }).citations ?? []) {
        if (c.url) sources.set(c.url, c.title ?? c.url);
      }
    }
    // The pages the search itself returned, in case the text carries no citations.
    for (const block of r.content) {
      const results = (block as { type: string; content?: unknown }).type === "web_search_tool_result" ? (block as { content?: unknown }).content : null;
      if (Array.isArray(results)) for (const x of results as { url?: string; title?: string }[]) if (x.url) sources.set(x.url, x.title ?? x.url);
    }
    ({ inputTokens, outputTokens, searches } = r);
  } else {
    const r = await callOpenAISearch(conn, system, user, maxSearches);
    text = r.text;
    for (const u of r.urls) sources.set(u.url, u.title);
    ({ inputTokens, outputTokens, searches } = r);
  }
  const tokenCost = costUsd(conn.model, inputTokens, outputTokens);
  await admin.from("usage_events").insert({
    company_id: piece.company_id,
    piece_id: piece.id,
    user_id: userId,
    task: "chat_web_lookup",
    task_type: "research",
    provider: conn.provider,
    model: conn.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: tokenCost === null ? null : tokenCost + (conn.provider === "anthropic" ? searches * SEARCH_COST_USD : 0),
  });
  return { findings: text.trim(), sources: [...sources].slice(0, 12).map(([url, title]) => ({ url, title })) };
}

/** The block added to the model's input after a lookup (or when a lookup was wanted but isn't possible). */
export function webBlock(found: WebFindings | null): string {
  return found
    ? `<web_findings>\n${found.findings || "(The lookup found nothing useful.)"}\n</web_findings>`
    : "<web_findings>\n(The writer asked for a web lookup, but it isn't available with the current AI provider. Say so in your reply, and answer only from what you have.)\n</web_findings>";
}
