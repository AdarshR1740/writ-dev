// The conversation on the Scope and Outline steps, built like a general AI chat: free-text replies that stream in
// as they are written, web search the model uses whenever IT decides it needs it, and a proposal tool the model
// calls only when it has a scope or an outline to suggest. Anthropic only for now.

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { corsHeaders, UserError } from "../_shared/cors.ts";
import { admin, requireRole } from "../_shared/supabase.ts";
import { connect } from "../_shared/llm.ts";
import { contextFor, loadPiece, logEvent, on, requireStep, setting } from "../_shared/context.ts";
import { costUsd, SEARCH_COST_USD } from "../_shared/models.ts";
import { promptSet } from "../_shared/prompt-overrides.ts";

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const CHAT_BASE = `ROLE
You are a helpful, knowledgeable assistant chatting with a writer who is planning one piece of B2B content. Talk the way a good general AI assistant does: answer whatever they ask, in plain words, on the piece or off it. Their questions often go wider than the piece, such as how other companies handle something, what is current in a field, or what a term means.

WHAT YOU KNOW
The piece's brief, the company's context and the current work are given below. Use them when they help. Do not repeat them back, and do not force every answer back to the piece.

TOOLS
- web_search: use it whenever you need current information, facts, examples, what other companies or pages say, or anything you are not sure of. Search for whatever the writer actually asked, even if it goes beyond the piece. You may search more than once. Do not search for things you already know well or for simple chat.
- The proposal tool (described below): call it only when the writer asks you to draft or change the proposal, or when you have a concrete one worth showing. Never call it for a plain question.

HOW TO ANSWER
- Short and direct. Use short paragraphs and simple dash lists. You may use **bold** for a key term. No headings and no tables.
- If an earlier message in the conversation said you could not browse or search, ignore it: you can. Do not apologise for it; just do the search.
- After a web search, say what you found and name the sites in plain words. Never state a fact from the web that you did not find. If a search found nothing useful, say so.
- Keep the whole conversation in mind. Build on earlier suggestions and the writer's changes instead of starting over.
- After you call the proposal tool, write one or two sentences saying what you suggest and why. The writer sees the proposal as a card next to your message.
- If something important is unclear, ask one question.`;

export const CHAT_SCOPE = `${CHAT_BASE}

THE PROPOSAL: SCOPE
The scope has a core question and 4 to 6 other points or ideas to include. Call propose_scope with:
- core_question: ONE question the reader wants answered, in the reader's own words, one sentence, not two questions joined by "and".
- expectations: the FULL list of points (not only changes), each one short plain line that starts with what the reader gets, such as "A step-by-step way to check...", "Why... matters", "How to tell whether...". Specific to the topic, so a reader could say "yes, it does that". No numbers or counts, no word counts, no format or layout words (checklist, table, steps), no required company names or figures: research finds those later.
Work out who the piece is for from the title and topic first. Use the company's ideal customer profile only if that reader fits the topic.
If the primary keyword or goal is missing, mention it once, briefly, when you propose a scope.`;

export const CHAT_OUTLINE = `${CHAT_BASE}

THE PROPOSAL: OUTLINE
The outline is the list of sections of the piece. Call propose_outline with the FULL outline each time (not only changes). Each section has:
- heading: specific to its sub-topic. Never "Introduction", "Overview" or "Conclusion".
- purpose: one line saying what the section does for the reader.
- expectations: the numbers of the scope points it serves (the scope is listed below, numbered). Every scope point should be served by at least one section.
Choose the shape from the reader's intent: "what are X" is the list up front then one section per item; "how to" is steps in order; "should I" is a decision framework. Do not plan word counts. Keep the parts of the outline the writer did not ask to change.`;

const SCOPE_TOOL = {
  name: "propose_scope",
  description: "Show the writer a proposed scope as a card they can apply. Call only when you have a scope to propose.",
  input_schema: {
    type: "object",
    properties: {
      core_question: { type: "string" },
      expectations: { type: "array", items: { type: "string" } },
    },
    required: ["core_question", "expectations"],
  },
};

const OUTLINE_TOOL = {
  name: "propose_outline",
  description: "Show the writer a proposed outline as a card they can apply. Call only when you have an outline to propose.",
  input_schema: {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            purpose: { type: "string" },
            expectations: { type: "array", items: { type: "integer" } },
          },
          required: ["heading", "purpose", "expectations"],
        },
      },
    },
    required: ["sections"],
  },
};

interface Row {
  id: string;
  role: string;
  content: string;
  payload: Record<string, unknown> | null;
}

/** An earlier AI reply as the model should see it: the words, plus anything it proposed. */
function aiText(r: Row): string {
  const p = r.payload ?? {};
  const out = [r.content];
  if (typeof p.core_question === "string" && Array.isArray(p.expectations)) {
    out.push(`[Scope I proposed]\n${p.core_question}\n${(p.expectations as string[]).map((x) => `- ${x}`).join("\n")}`);
  }
  if (Array.isArray(p.sections)) {
    out.push(`[Outline I proposed]\n${(p.sections as { heading: string; purpose: string }[]).map((s, i) => `${i + 1}. ${s.heading}: ${s.purpose}`).join("\n")}`);
  }
  return out.join("\n\n");
}

async function threadFor(piece: { id: string; company_id: string }, subject: "contract" | "outline"): Promise<string> {
  const { data } = await admin.from("threads").select("id").eq("piece_id", piece.id).eq("subject", subject).maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await admin.from("threads")
    .insert({ company_id: piece.company_id, piece_id: piece.id, subject }).select("id").single();
  if (error) throw error;
  return created.id;
}

/** Streams one reply. Events: status, delta, suggestion, done, error. Errors before streaming starts are plain JSON. */
export async function chatStream(userId: string, body: Record<string, unknown>): Promise<Response> {
  const piece = await loadPiece(String(body.piece_id ?? ""));
  await requireRole(userId, piece.company_id, "member");
  const kind = body.kind === "outline" ? "outline" : "scope";
  if (kind === "scope") {
    requireStep(piece, setting<string>(piece, "contract.mode") !== "off" && setting<boolean>(piece, "contract.ai_thread"), "The scope conversation");
  } else {
    requireStep(piece, setting<string>(piece, "outline.mode") === "free" && on(piece, "outline.ai_thread"), "The outline conversation");
    if (piece.stage !== "outline") throw new UserError("The outline can be discussed while it is open.");
  }
  const conn = await connect(piece.company_id, "reason");
  if (conn.provider !== "anthropic") {
    throw new UserError("The conversation needs an Anthropic key for now: it searches the web and replies live. Make Anthropic the active provider in AI settings.");
  }

  const threadId = await threadFor(piece, kind === "scope" ? "contract" : "outline");
  const { data: all } = await admin.from("thread_messages").select("id, role, content, payload").eq("thread_id", threadId).order("created_at");
  const retry = body.retry === true;
  const lastAi = retry && all?.length && all[all.length - 1].role === "ai" ? all[all.length - 1] : null;
  const history = ((lastAi ? all!.slice(0, -1) : all) ?? []) as Row[];
  let message = retry ? "" : String(body.message ?? "").trim();
  if (!message && !retry && history.length === 0) {
    message = kind === "scope" ? "Suggest a first scope for this piece." : "Suggest a first outline for this piece.";
  }

  // The conversation as real chat turns.
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  const add = (role: "user" | "assistant", content: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  };
  for (const r of history) add(r.role === "ai" ? "assistant" : "user", r.role === "ai" ? aiText(r) : r.content);
  if (message) add("user", message);
  if (turns.length === 0 || turns[0].role !== "user") turns.unshift({ role: "user", content: "(The conversation starts here.)" });
  if (turns[turns.length - 1].role === "assistant") add("user", "Continue.");

  // What the piece looks like now goes in the system prompt, fresh every turn.
  const prompts = await promptSet(piece.company_id);
  let context: string;
  if (kind === "scope") {
    context = await contextFor(piece, ["brief", "contract", "icp", "positioning", "strategy_notes"]);
  } else {
    const { data: secs } = await admin.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id).order("position");
    const { data: c } = await admin.from("piece_contracts").select("core_question, expectations").eq("piece_id", piece.id).single();
    const points = ((c?.expectations ?? []) as { text: string }[]).map((e, i) => `${i + 1}. ${e.text}`).join("\n");
    context = `${await contextFor(piece, ["brief", "analysis", "piece_items", "format_profile"])}\n\n<scope>\nCore question: ${c?.core_question ?? ""}\n${points}\n</scope>\n\n<current_outline>\n${(secs ?? []).map((s) => `${s.position}. ${s.heading} (${s.purpose})`).join("\n") || "(empty)"}\n</current_outline>`;
  }
  const system = `${prompts(kind === "scope" ? "chat.scope" : "chat.outline", kind === "scope" ? CHAT_SCOPE : CHAT_OUTLINE)}\n\n${context}`;
  const tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: 4 },
    kind === "scope" ? SCOPE_TOOL : OUTLINE_TOOL,
  ] as unknown as Anthropic.Beta.BetaToolUnion[];
  const threadSubject = kind === "scope" ? "contract" : "outline";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        if (lastAi) await admin.from("thread_messages").delete().eq("id", lastAi.id);
        if (message) {
          const { error } = await admin.from("thread_messages").insert({
            company_id: piece.company_id, thread_id: threadId, role: "writer", content: message, created_by: userId,
          });
          if (error) throw error;
        }

        const client = new Anthropic({ apiKey: conn.apiKey, maxRetries: 2 });
        const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
        let text = "";
        let suggestion: Record<string, unknown> | null = null;
        const sources = new Map<string, string>();
        let inputTokens = 0;
        let outputTokens = 0;
        let searches = 0;
        let nudged = false;

        for (let turn = 0; turn < 7; turn++) {
          if (text && turn > 0) { text += "\n\n"; send({ type: "delta", text: "\n\n" }); }
          const s = client.beta.messages.stream({
            model: conn.model,
            max_tokens: 4000,
            system,
            messages,
            tools,
            ...(FALLBACK_MODELS.has(conn.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          });
          s.on("text", (t: string) => { text += t; send({ type: "delta", text: t }); });
          s.on("streamEvent", (ev: { type: string; content_block?: { type: string } }) => {
            if (ev.type === "content_block_start" && ev.content_block?.type === "server_tool_use") send({ type: "status", text: "Searching the web…" });
          });
          const msg = await s.finalMessage();
          inputTokens += msg.usage.input_tokens;
          outputTokens += msg.usage.output_tokens;
          searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
          if (msg.stop_reason === "refusal") throw new UserError("The model declined this request. Rephrase and try again.", 422);

          for (const block of msg.content as unknown as { type: string; content?: unknown; citations?: { url?: string; title?: string }[] | null }[]) {
            if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
              for (const x of block.content as { url?: string; title?: string }[]) if (x.url) sources.set(x.url, x.title ?? x.url);
            }
            for (const c of block.citations ?? []) if (c.url) sources.set(c.url, c.title ?? c.url);
          }

          if (msg.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: msg.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
            continue;
          }
          const use = (msg.content as unknown as { type: string; id: string; name: string; input: Record<string, unknown> }[])
            .find((b) => b.type === "tool_use");
          if (msg.stop_reason === "tool_use" && use) {
            if (use.name === "propose_scope") {
              const qs = Array.isArray(use.input.expectations) ? (use.input.expectations as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
              suggestion = { core_question: String(use.input.core_question ?? "").trim(), expectations: qs.slice(0, 8) };
            } else if (use.name === "propose_outline" && Array.isArray(use.input.sections)) {
              suggestion = {
                sections: (use.input.sections as { heading?: unknown; purpose?: unknown; expectations?: unknown }[])
                  .map((x) => ({
                    heading: String(x.heading ?? "").trim(),
                    purpose: String(x.purpose ?? "").trim(),
                    expectations: Array.isArray(x.expectations) ? (x.expectations as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
                  }))
                  .filter((x) => x.heading).slice(0, 20),
              };
            }
            if (suggestion) send({ type: "suggestion", suggestion });
            messages.push(
              { role: "assistant", content: msg.content as unknown as Anthropic.Beta.BetaContentBlockParam[] },
              { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "Shown to the writer as a card they can apply." }] },
            );
            continue;
          }
          // The model ended its turn with nothing to show. Ask once for a reply, then give up with a clear error.
          if (!text.trim() && !suggestion) {
            console.error("chat: empty turn", { stop_reason: msg.stop_reason, blocks: msg.content.map((b: { type: string }) => b.type) });
            if (!nudged) {
              nudged = true;
              messages.push({ role: "assistant", content: msg.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
              messages.push({ role: "user", content: "(Reply to the writer now, in words. If they asked for a proposal, call the proposal tool.)" });
              continue;
            }
          }
          break;
        }
        if (!text.trim() && !suggestion) throw new UserError("The AI sent an empty reply. Press Retry, or rephrase.");

        const tokenCost = costUsd(conn.model, inputTokens, outputTokens);
        await admin.from("usage_events").insert({
          company_id: piece.company_id, piece_id: piece.id, user_id: userId,
          task: `chat_${kind}`, task_type: "reason", provider: conn.provider, model: conn.model,
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: tokenCost === null ? null : tokenCost + searches * SEARCH_COST_USD,
        });

        const { data: aiMessage, error } = await admin.from("thread_messages").insert({
          company_id: piece.company_id,
          thread_id: threadId,
          role: "ai",
          content: text.trim() || "Here is a suggestion.",
          payload: {
            ...(suggestion ?? {}),
            ...(sources.size ? { web: { sources: [...sources].slice(0, 12).map(([url, title]) => ({ url, title })) } } : {}),
          },
        }).select().single();
        if (error) throw error;
        await logEvent(piece, userId, `${threadSubject}_chat`, { searches });
        send({ type: "done", message: aiMessage });
      } catch (err) {
        const msg = err instanceof UserError ? err.message
          : err instanceof Anthropic.AuthenticationError ? "Anthropic rejected the API key. Check it in AI settings."
          : err instanceof Anthropic.RateLimitError ? "Anthropic is rate-limiting this key. Wait a minute and try again."
          : err instanceof Anthropic.APIError ? `Anthropic returned an error (${err.status}): ${err.message}`
          : "Something went wrong on the server. Try again.";
        if (!(err instanceof UserError)) console.error(err);
        send({ type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
