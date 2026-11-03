// Memory across pieces, and Ask Writ. Both answer only from the company's own
// material, found by search_material(), and every claim points back to a
// numbered passage the person can open.

import { UserError } from "../_shared/cors.ts";
import { admin, requireRole } from "../_shared/supabase.ts";
import { type JsonSchema, recordUsage, runModel } from "../_shared/llm.ts";
import type { TaskType } from "../_shared/models.ts";
import { loadPiece, logEvent } from "../_shared/context.ts";
import type { Prepared } from "./prepared.ts";

interface Passage { kind: string; ref_id: string; piece_id: string | null; label: string; title: string; body: string; path: string }

async function search(companyId: string, q: string, n: number, kinds: string[] | null = null, excludeCode: string | null = null): Promise<Passage[]> {
  const { data, error } = await admin.rpc("search_material", {
    target_company: companyId, q: q.slice(0, 4000), n, only_kinds: kinds, exclude_code: excludeCode,
  });
  if (error) throw error;
  return (data ?? []) as Passage[];
}

const numbered = (passages: Passage[]) =>
  passages.map((p, i) => `<passage n="${i + 1}" source="${p.label}: ${p.title.replace(/"/g, "'")}">\n${p.body}\n</passage>`).join("\n");

/** Passage text as a reader sees it: no Markdown markers, links reduced to their words. */
export const plain = (s: string) => s
  .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, "$1")
  .replace(/(\*\*|__)(.+?)\1/g, "$2")
  .replace(/^#{1,6}\s+/gm, "")
  .replace(/^\s*[-*]\s+/gm, "• ")
  .replace(/\s+/g, " ")
  .trim();

const cite = (p: Passage, n: number) => ({ n, kind: p.kind, label: p.label, title: p.title, path: p.path, excerpt: plain(p.body).slice(0, 400) });

// ---------------------------------------------------------------------------
// Ask Writ
// ---------------------------------------------------------------------------

const ASK_SYSTEM = `You are Writ's assistant for one company. You answer questions using ONLY
the numbered passages, which come from the company's own material: its finished
pieces, insight and data cards, house file (customer profile, positioning, voice)
and approved research.

Rules:
- Every statement in your answer must come from the passages. Cite each one with
  its passage number in square brackets, like [2] or [1][4].
- If the passages don't answer the question, or only partly, say so plainly in
  the first sentence. Then say where the answer would belong (for example "add it
  as an insight card" or "it isn't in the house file yet"). Never fill gaps with
  general knowledge, and never guess.
- Be brief and specific: a few sentences or a short list. Quote exact figures.
- You help people find and reuse what they already know. You don't write or
  rewrite content; if asked to, explain that writing happens in a piece, and
  offer the relevant passages instead.
- Earlier turns are context for follow-up questions; answer the latest question.`;

const askSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "covered", "cited"],
  properties: {
    answer: { type: "string" },
    covered: { type: "string", enum: ["yes", "partly", "no"] },
    cited: { type: "array", items: { type: "integer" } },
  },
};

async function prepareAsk(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const companyId = String(body.company_id ?? "");
  await requireRole(userId, companyId, "member");
  const question = String(body.question ?? "").trim();
  const estimating = body.mode === "estimate";
  if (!question && !estimating) throw new UserError("Ask a question.");
  if (question.length > 1500) throw new UserError("Keep the question under 1,500 characters.");

  const { data: history } = await admin.from("ask_messages").select("role, content").eq("company_id", companyId)
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(6);
  const turns = (history ?? []).reverse();
  // The question's own matches come first. Short follow-ups ("and in 2024?") borrow the
  // previous question's words only when they find little on their own.
  const lastQuestion = [...turns].reverse().find((t) => t.role === "user")?.content ?? "";
  let passages = question ? await search(companyId, question, 14) : [];
  const words = question.split(/\s+/).filter(Boolean).length;
  if (question && lastQuestion && passages.length < 4 && words <= 8) {
    const seen = new Set(passages.map((p) => `${p.kind}:${p.ref_id}:${p.body.slice(0, 40)}`));
    const more = (await search(companyId, `${question} ${lastQuestion}`, 14)).filter((p) => !seen.has(`${p.kind}:${p.ref_id}:${p.body.slice(0, 40)}`));
    passages = [...passages, ...more].slice(0, 14);
  }
  const conversation = turns.map((t) => `<${t.role}>\n${t.content}\n</${t.role}>`).join("\n");
  const user = `${conversation ? `<earlier>\n${conversation}\n</earlier>\n\n` : ""}<passages>\n${passages.length ? numbered(passages) : "(No passages matched.)"}\n</passages>\n\n<question>\n${question || "What do we know about our customers?"}\n</question>`;
  const taskType: TaskType = "reason";

  return {
    companyId,
    taskType,
    system: ASK_SYSTEM,
    user,
    expectedOutputTokens: 600,
    run: async () => {
      const { error: qErr } = await admin.from("ask_messages").insert({ company_id: companyId, user_id: userId, role: "user", content: question });
      if (qErr) throw qErr;
      let answer: string;
      let covered = "no";
      let sources: ReturnType<typeof cite>[] = [];
      let cost: number | null = 0;
      if (passages.length === 0) {
        // Nothing to answer from: say so without paying for a model call.
        answer = "I couldn't find anything about that in your material. If it's something your company knows, add it as an insight card or to the house file, and I'll be able to find it.";
      } else {
        const r = await runModel<{ answer: string; covered: string; cited: number[] }>(companyId, {
          taskType, system: ASK_SYSTEM, user, schema: askSchema, schemaName: "ask_writ", maxTokens: 4000,
        });
        await recordUsage(companyId, userId, "ask", taskType, r);
        cost = r.costUsd;
        covered = r.data.covered;
        // Keep only citations that point at a real passage, renumbered in order of first use.
        const used = [...new Set([...r.data.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
          .filter((n) => n >= 1 && n <= passages.length);
        const renumber = new Map(used.map((n, i) => [n, i + 1]));
        answer = r.data.answer.replace(/\[(\d+)\]/g, (m, d) => (renumber.has(Number(d)) ? `[${renumber.get(Number(d))}]` : ""));
        sources = used.map((n) => cite(passages[n - 1], renumber.get(n)!));
      }
      const { data: msg, error } = await admin.from("ask_messages").insert({
        company_id: companyId, user_id: userId, role: "writ", content: answer, payload: { covered, sources },
      }).select().single();
      if (error) throw error;
      return { message: msg, cost_usd: cost };
    },
  };
}

// ---------------------------------------------------------------------------
// Memory check: this piece against what the company has already published
// ---------------------------------------------------------------------------

const MEMORY_SYSTEM = `You compare a new piece of B2B content with what the same company has
already published, shown as numbered passages from earlier finished pieces and
their approved research. Flag only what an editor would want to know before
publishing:

- "contradiction": the new piece states a fact, figure or position that conflicts
  with an earlier piece (for example a different number for the same statistic,
  or the opposite recommendation). The most important kind.
- "repeat": the new piece makes the same argument, uses the same story or example,
  or leads with the same angle as an earlier piece, so readers who saw that one
  get little new.
- "link": an earlier piece covers a point the new piece mentions in passing, so
  linking to it would help the reader.

For each flag give the exact sentence from the new piece (copied word for word),
the passage number it relates to, and one short note saying what the editor
should check or do. Flag nothing that is merely on the same topic. Fewer, better
flags; an empty list is a fine answer. No scores.`;

const memorySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flags"],
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "sentence", "passage", "note"],
        properties: {
          kind: { type: "string", enum: ["contradiction", "repeat", "link"] },
          sentence: { type: "string" },
          passage: { type: "integer" },
          note: { type: "string" },
        },
      },
    },
  },
};

const norm = (s: string) => s.toLowerCase().replace(/[*_`#>\[\]]/g, "").replace(/\s+/g, " ").trim();

async function prepareMemoryCheck(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await loadPiece(String(body.piece_id ?? ""));
  await requireRole(userId, piece.company_id, "member");
  const { data: secs } = await admin.from("piece_sections").select("heading, content").eq("piece_id", piece.id).order("position");
  const text = (secs ?? []).map((s) => `## ${s.heading}\n\n${s.content.trim()}`).join("\n\n");
  if (!(secs ?? []).some((s) => s.content.trim())) throw new UserError("Write the piece first; the check compares its text.");
  // Search with the piece's own words: title, keyword, headings and text. Earlier versions of this piece don't count.
  const passages = await search(piece.company_id, `${piece.title} ${piece.primary_keyword} ${text}`, 12, ["piece", "research"], piece.code);
  if (passages.length === 0) {
    throw new UserError("Nothing you've published yet covers this topic, so there's nothing to compare against.");
  }
  const user = `<published>\n${numbered(passages)}\n</published>\n\n<new_piece title="${piece.title.replace(/"/g, "'")}">\n${text}\n</new_piece>`;
  const taskType: TaskType = "reason";

  return {
    companyId: piece.company_id,
    taskType,
    system: MEMORY_SYSTEM,
    user,
    expectedOutputTokens: 1500,
    run: async () => {
      const r = await runModel<{ flags: { kind: string; sentence: string; passage: number; note: string }[] }>(piece.company_id, {
        taskType, system: MEMORY_SYSTEM, user, schema: memorySchema, schemaName: "memory_check", maxTokens: 8000,
      });
      await recordUsage(piece.company_id, userId, "memory_check", taskType, r, piece.id);
      const body = norm(text);
      const flags = r.data.flags
        .filter((f) => f.passage >= 1 && f.passage <= passages.length)
        .map((f) => ({
          kind: f.kind,
          sentence: f.sentence,
          // A sentence the model didn't copy exactly is still shown, but marked so the editor checks it.
          found_in_piece: body.includes(norm(f.sentence).slice(0, 120)),
          note: f.note,
          earlier: cite(passages[f.passage - 1], f.passage),
        }))
        .sort((a, b) => ["contradiction", "repeat", "link"].indexOf(a.kind) - ["contradiction", "repeat", "link"].indexOf(b.kind));
      const compared = [...new Map(passages.filter((p) => p.piece_id).map((p) => [p.piece_id, { label: p.label, title: p.title.split(":")[0], path: p.path }])).values()];
      const result = { checked_at: new Date().toISOString(), flags, compared };
      const { error } = await admin.from("pieces").update({ memory_check: result }).eq("id", piece.id);
      if (error) throw error;
      await logEvent(piece, userId, "memory_checked", { flags: flags.length });
      return { result, cost_usd: r.costUsd };
    },
  };
}

export const MEMORY_TASKS: Record<string, (userId: string, body: Record<string, unknown>) => Promise<Prepared>> = {
  ask: prepareAsk,
  memory_check: prepareMemoryCheck,
};
