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
import { describeThread, type ThreadRow, wantsWeb, webBlock, webLookup } from "./chat.ts";

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
  after: (data: T, cost: number | null, model: string, extra?: unknown) => Promise<unknown>,
  /** Runs first, when the task runs: may add to the model's input and hand something to `after`. */
  before?: () => Promise<{ userSuffix: string; extra: unknown }>,
): Prepared {
  return {
    companyId: piece.company_id,
    taskType,
    system,
    user,
    expectedOutputTokens,
    run: async () => {
      const pre = before ? await before() : null;
      const r = await runModel<T>(piece.company_id, {
        taskType, system, user: user + (pre?.userSuffix ?? ""), schema, schemaName: name, maxTokens: 16000,
      });
      await recordUsage(piece.company_id, userId, name, taskType, r, piece.id);
      return after(r.data, r.costUsd, r.model, pre?.extra);
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis (before the outline)
// ---------------------------------------------------------------------------

export const ANALYSIS_SYSTEM = `ROLE
You check whether a piece of B2B content is still on the topic it started with, before it is outlined. You do not write the piece.

WHAT YOU RECEIVE
- <brief>: the original intent: the title, topic, primary keyword and goal the piece started with.
- <reader_contract>: the current intent: the core question and the points the piece owes the reader.
- <approved_research>: numbered items, written [1], [2], and so on. They are references for drafting later. Do not judge the sources, their quality, their wording or whether they agree with each other.

STEPS
1. Write the original intent down for yourself in one line, from the brief's topic and primary keyword.
2. Compare the reader contract with it. Does the core question, and each point, still serve that intent?
3. Compare the approved research with the intent and with the contract. Taken together, does it cover what the piece is about, or has it moved onto a neighbouring subject?
4. Report what you found, in the parts below.

THE PARTS
- alignment: "verdict" is "aligned" when the contract and research both match the original intent, "partly" when some of either has moved away, "drifted" when most has. "summary" is one or two sentences naming the original intent and how the current contract and research relate to it.
- drift: places where the contract or the research moves away from the original intent. Describe each by theme, not item by item: one entry for a group of research that covers the same neighbouring subject, one for a contract point that has moved. Entry: "text" says what moved away and where (which contract point, or what that part of the research covers); "items" lists the numbers of the items in that group, as references only, and is empty when it is about the contract alone; "points" lists the numbers of the contract expectations involved, numbered as in <reader_contract>, and is empty when it is about the research alone.
- gaps: important questions that the original intent implies for this reader and that no approved item answers. Entry: "text" names the gap; "expert_question" is ONE specific question the company's own expert could answer from experience; "points" lists the numbers of the contract expectations the gap belongs to, numbered as in <reader_contract>, or is empty.
- contract_suggestions: changes to the reader contract that would bring it back in line with the original intent, such as a point to add, narrow or drop. Entry: "change" says what to change; "why" says why. The writer decides.

RULES
- Judge fit with the topic only. Use only the brief, the contract and the approved items. Don't bring in outside facts.
- Never comment on a source: not on whether it is reliable, a vendor, secondary, dated or one-sided, and not on whether its figures can be trusted. Say what the research covers or lacks, nothing about where it came from.
- Be concrete and brief: one or two sentences per entry.
- Never write item numbers or point numbers inside "text". Say what the research covers, not which item; the numbers go in "items" and "points" only.
- Report only gaps that matter: at most four. Do not list a gap just because a contract point has little research behind it; list it when the missing material would change what the piece can say. Merge gaps that share a cause.
- If there is nothing real for a part, return an empty list for it. Never pad. A verdict of "aligned" with empty lists is a good answer.`;

const analysisSchema = obj({
  alignment: obj({ verdict: { type: "string", enum: ["aligned", "partly", "drifted"] }, summary: str }),
  drift: list(obj({ text: str, items: list({ type: "integer" }), points: list({ type: "integer" }) })),
  gaps: list(obj({ text: str, expert_question: str, points: list({ type: "integer" }) })),
  contract_suggestions: list(obj({ change: str, why: str })),
});

async function prepareAnalysis(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "analysis.enabled"), "Analysis");
  if (!["outline", "writing", "done"].includes(piece.stage)) throw new UserError("Finish research first.");
  // Wiring: brief, contract and approved research as plain statements (no source details, since sources aren't
  // judged here). No voice.
  const context = await contextFor(piece, ["brief", "contract", "piece_items_plain"]);
  // The ids behind the numbers the model will use, so the screen can open "item 4" or "point 2" even after the
  // lists change.
  const itemIds = (await approvedItems(piece.id)).map((i) => i.id);
  const { data: contractRow } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
  const pointIds = ((contractRow?.expectations ?? []) as { id: string }[]).map((e) => e.id);
  const off = [
    ["gaps", "analysis.gaps"],
    ["contract_suggestions", "analysis.contract_suggestions"],
  ].filter(([, path]) => !on(piece, path)).map(([field]) => field);
  const base = (await promptSet(piece.company_id))("analysis", ANALYSIS_SYSTEM);
  const system = off.length ? `${base}\n\nThis format doesn't use: ${off.join(", ")}. Return empty lists for those.` : base;
  return task<Record<string, unknown>>("analysis", "reason", piece, userId, system, context, analysisSchema, 2500,
    async (data, cost, model) => {
      const analysis = { ...data, item_ids: itemIds, point_ids: pointIds };
      const { error } = await admin.from("pieces").update({ analysis }).eq("id", piece.id);
      if (error) throw error;
      await logEvent(piece, userId, "analysis_run");
      return { analysis, cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// Fixes for what the alignment check found
// ---------------------------------------------------------------------------

export const ANALYSIS_FIX_SYSTEM = `ROLE
You propose concrete fixes for a piece of B2B content whose reader contract and research have been checked against the topic the piece started with. You do not write the piece.

WHAT YOU RECEIVE
- <brief>: the original intent: the title, topic, primary keyword and goal.
- <reader_contract>: the core question and the numbered expectations (the scope points).
- <approved_research>: numbered items. Do not judge the sources, only whether an item fits the topic.
- <analysis>: what the alignment check found: the verdict, where the plan drifts, gaps and suggested contract changes.
- <outline>: the sections so far, each with the numbers of the scope points it covers.

STEPS
1. Read what the analysis found.
2. For each finding that one of the actions below can fix, propose the smallest change that fixes it.
3. Propose nothing for a finding that none of the actions can fix. A gap, for example, needs the company's own expert, so it is left alone.

THE ACTIONS
- reject_item: "item" is the number of approved research that is off the topic, taken from where the plan drifts. Rejecting keeps the item; the writer can restore it.
- edit_point: "point" is the number of a scope point that has drifted; "text" is its new wording. Keep what still fits.
- remove_point: "point" is a scope point that does not serve the original intent and cannot be fixed by rewording.
- add_point: "text" is a new scope point that the original intent needs and the contract lacks. To also add an outline section for it, fill "heading" and "purpose"; otherwise leave them empty.
- add_section: "points" lists the numbers of existing scope points that an open gap in <analysis> names and that no outline section covers; "heading" and "purpose" describe one new section that covers them and gives the gap a home. The heading is a reader-facing section title; the purpose says what the section tells the reader. Points that share a gap go in one section.

EVERY PROPOSAL HAS ALL FIELDS
Use 0 for "item" and "point", "" for "text", "heading" and "purpose", and [] for "points" when an action doesn't use them. "why" is one sentence saying what the change fixes. "resolves" lists the "ref" values (such as "drift-0" or "suggestion-1") of the entries in <analysis> that this change fully settles, so the writer's list can drop them; list none you are unsure of, and never invent a ref. A gap is never settled by these actions.

RULES
- Every proposal must answer a specific finding in <analysis>: an entry under drift, a suggested contract change, or an open gap whose scope point has no outline section yet. Do not look for improvements of your own. Fixing a finding once settles it; do not propose a second change for the same thing.
- add_section is only for scope points that an open gap names and that no section covers. It may be proposed when <outline> has no sections yet. Never propose a section for a point that already has one.
- If the verdict is "aligned", the analysis has no drift entries and no suggested contract changes, and no open gap names a scope point without a section, return an empty list.
- Judge fit with the topic only. Use only what you are given. Never invent facts and never reword research items.
- Never comment on a source's reliability.
- Propose at most 10 changes, fewer when fewer will do. If nothing needs fixing, return an empty list.
- Scope points are things the reader needs, in plain words, not tasks for the writer.
- Never remove the last scope point.`;

const FIX_TYPES = ["reject_item", "edit_point", "remove_point", "add_point", "add_section", "research_gap"] as const;

/** Added to the system prompt when the writer ticked "use AI to address these" for the gaps. */
const RESEARCH_GAP_RULES = `

ONE MORE ACTION FOR THIS REQUEST
- research_gap: "text" is a short question for a web search; "resolves" holds the "ref" of the one open gap it is for. Use it only for a gap whose missing material is published knowledge a web search can find, such as how a method works or what studies and vendors report. Never use it for a gap that asks what the company itself saw, did or measured: leave that gap alone. At most one research_gap per gap. Searching adds items for the writer to review; it does not settle the gap.
- This action may answer a gap in <analysis> even though the other rules say gaps are left alone.`;
const analysisFixSchema = obj({
  proposals: list(obj({
    type: { type: "string", enum: [...FIX_TYPES] },
    why: str,
    item: { type: "integer" },
    point: { type: "integer" },
    text: str,
    heading: str,
    purpose: str,
    points: list({ type: "integer" }),
    resolves: list(str),
  })),
});

/** One proposed change, with ids the screen can apply. */
interface FixProposal {
  id: string;
  type: (typeof FIX_TYPES)[number];
  why: string;
  item_id?: string;
  item_text?: string;
  point_id?: string;
  point_text?: string;
  /** New wording for edit_point, or the text of the point add_point creates. */
  text?: string;
  /** add_point: the id the new point will have, so a section can point at it. */
  new_point_id?: string;
  /** A new section, for add_section or add_point. */
  heading?: string;
  purpose?: string;
  point_ids?: string[];
  /** The findings (their "ref" in <analysis>) this change settles. */
  resolves?: string[];
  /** research_gap: the gap the search is for. */
  gap_text?: string;
}

function newPointId(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function prepareAnalysisFix(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "analysis.enabled"), "Analysis");
  const { data: row } = await admin.from("pieces").select("analysis, outline_confirmed_at, stage").eq("id", piece.id).single();
  if (row?.stage !== "outline" || row.outline_confirmed_at) throw new UserError("Fixes can be applied before the outline is confirmed.");
  if (!row.analysis) throw new UserError("Run the alignment check first.");

  const items = await approvedItems(piece.id);
  const { data: c } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
  const points = (c?.expectations ?? []) as { id: string; text: string }[];
  // The check's numbers ([3], "point 2") belong to the research and scope as they were when it ran. If either has
  // changed since, they no longer line up, so the check has to be run again first.
  const ran = row.analysis as { item_ids?: string[]; point_ids?: string[] };
  if (ran.item_ids?.join() !== items.map((i) => i.id).join() || ran.point_ids?.join() !== points.map((x) => x.id).join()) {
    throw new UserError("The research or scope has changed since the check. Run the check again first.");
  }
  const { data: secs } = await admin.from("piece_sections").select("heading, purpose, expectation_ids").eq("piece_id", piece.id).order("position");
  const outline = (secs ?? []).map((s, i) => {
    const covers = points.flatMap((p, j) => (s.expectation_ids as string[]).includes(p.id) ? [j + 1] : []);
    return `${i + 1}. ${s.heading}${s.purpose ? ` (${s.purpose})` : ""} covers points: ${covers.join(", ") || "none"}`;
  }).join("\n");
  const context = `${await contextFor(piece, ["brief", "contract", "piece_items_plain", "analysis"])}\n\n<outline>\n${outline || "(no sections yet)"}\n</outline>`;

  const canEditScope = setting<string>(piece, "contract.mode") !== "off";
  const canAddSections = setting<string>(piece, "outline.mode") !== "off";
  const found = row.analysis as {
    alignment?: { verdict?: string };
    drift?: unknown[];
    contract_suggestions?: unknown[];
    gaps?: { points?: number[]; ignored?: boolean }[];
  };
  // Gaps the writer ignored are left alone: no section is proposed for them.
  // The refs a proposal may name are the positions in the stored lists, counted before anything is filtered out.
  const validRefs = new Set<string>([
    ...(found.gaps ?? []).map((_, i) => `gap-${i}`),
    ...(found.drift ?? []).map((_, i) => `drift-${i}`),
    ...(found.contract_suggestions ?? []).map((_, i) => `suggestion-${i}`),
  ]);
  const settled = (x: unknown) => Boolean((x as { ignored?: boolean; resolved?: boolean }).ignored || (x as { resolved?: boolean }).resolved);
  // Gaps still open, by their ref and text, before the lists are filtered (a research_gap may only name one of these).
  // A gap already searched for isn't searched for again until the check is run again.
  const openGaps = new Map((found.gaps ?? []).flatMap((g, i) => (settled(g) || (g as { researched?: number }).researched
    ? [] : [[`gap-${i}`, (g as { text?: string }).text ?? ""] as [string, string]])));
  const withGaps = body.include_gaps === true;
  found.gaps = (found.gaps ?? []).filter((g) => !settled(g));
  found.drift = (found.drift ?? []).filter((d) => !settled(d));
  found.contract_suggestions = (found.contract_suggestions ?? []).filter((c) => !settled(c));
  // A section can only fix a gap: it must cover a scope point an open gap names and no section covers yet. Once it
  // exists the point is covered, so the same fix is never proposed twice.
  const covered = new Set((secs ?? []).flatMap((s) => s.expectation_ids as string[]));
  const gapPointIds = new Set((found.gaps ?? []).flatMap((g) => g.points ?? [])
    .map((n) => points[n - 1]?.id).filter((id): id is string => Boolean(id) && !covered.has(id)));
  const nothingToFix = found.alignment?.verdict === "aligned" && !found.drift?.length && !found.contract_suggestions?.length
    && gapPointIds.size === 0 && !(withGaps && openGaps.size > 0);
  const maxPoints = setting<string>(piece, "contract.mode") === "lite" ? 2 : 7;
  const system = (await promptSet(piece.company_id))("analysis_fix", ANALYSIS_FIX_SYSTEM)
    + (canEditScope ? "" : "\n\nThis format has no scope: do not propose edit_point, remove_point or add_point.")
    + (canAddSections ? "" : "\n\nThis format has no outline sections: do not propose add_section, and leave heading and purpose empty.")
    + (withGaps ? RESEARCH_GAP_RULES : "");

  return task<{ proposals: { type: string; why: string; item: number; point: number; text: string; heading: string; purpose: string; points: number[]; resolves: string[] }[] }>(
    "analysis_fix", "reason", piece, userId, system, context, analysisFixSchema, 2500,
    async (data, cost, model) => {
      const out: FixProposal[] = [];
      const usedItems = new Set<string>();
      const usedPoints = new Set<string>();
      const sectionPoints = new Set<string>();
      const usedGaps = new Set<string>();
      let removed = 0;
      let added = 0;
      // An "aligned" check with nothing under drift or suggestions has nothing to fix, whatever the model says.
      for (const p of nothingToFix ? [] : data.proposals.slice(0, 10)) {
        const why = p.why.trim();
        const heading = p.heading.trim();
        const purpose = p.purpose.trim();
        const text = p.text.trim();
        const id = `${p.type}-${out.length + 1}`;
        // Which findings this change settles, kept only when they are real ones.
        // Only evidence settles a gap, and a search only adds items to review, so no proposal settles one. A
        // research_gap names its gap here only to say which gap the search is for.
        const named = [...new Set((p.resolves ?? []).filter((r) => validRefs.has(r)))];
        const resolves = p.type === "research_gap" ? named : named.filter((r) => !r.startsWith("gap-"));
        if (p.type === "reject_item") {
          const it = items[p.item - 1];
          if (!it || usedItems.has(it.id)) continue;
          usedItems.add(it.id);
          out.push({ id, type: p.type, why, item_id: it.id, item_text: it.statement, resolves });
        } else if (p.type === "edit_point" || p.type === "remove_point") {
          const pt = points[p.point - 1];
          if (!canEditScope || !pt || usedPoints.has(pt.id)) continue;
          if (p.type === "edit_point" && (!text || text === pt.text.trim())) continue;
          if (p.type === "remove_point" && points.length - removed <= 1) continue;
          usedPoints.add(pt.id);
          if (p.type === "remove_point") removed++;
          out.push({ id, type: p.type, why, point_id: pt.id, point_text: pt.text, resolves, ...(p.type === "edit_point" ? { text } : {}) });
        } else if (p.type === "add_point") {
          if (!canEditScope || !text || points.length - removed + added >= maxPoints) continue;
          added++;
          out.push({ id, type: p.type, why, text, new_point_id: newPointId(), resolves, ...(canAddSections && heading ? { heading, purpose } : {}) });
        } else if (p.type === "add_section") {
          const ids = [...new Set(p.points.map((n) => points[n - 1]?.id).filter((x): x is string => Boolean(x)))]
            .filter((x) => gapPointIds.has(x) && !sectionPoints.has(x));
          if (!canAddSections || !heading || !ids.length) continue;
          ids.forEach((x) => sectionPoints.add(x));
          out.push({ id, type: p.type, why, heading, purpose, point_ids: ids, resolves });
        } else if (p.type === "research_gap") {
          // One search per open gap, and only when the writer asked for it. Never counted as settling the gap here:
          // the search adds items to review, and the next check says whether the gap is closed.
          const gapRef = resolves.find((r) => openGaps.has(r) && r.startsWith("gap-"));
          if (!withGaps || !gapRef || !text || usedGaps.has(gapRef)) continue;
          usedGaps.add(gapRef);
          out.push({ id, type: p.type, why, text, gap_text: openGaps.get(gapRef), resolves: [gapRef] });
        }
      }
      await logEvent(piece, userId, "analysis_fixes_proposed", { count: out.length });
      return { proposals: out, cost_usd: cost, model };
    });
}

// ---------------------------------------------------------------------------
// Outline (conversation, like the contract)
// ---------------------------------------------------------------------------

export const OUTLINE_SYSTEM = `ROLE
You are a writer outlining one piece of B2B content.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject and the numbered expectations the piece owes the reader.
- <analysis>: whether the scope and research still match the original topic, where they drift from it, and gaps.
- <approved_research>: numbered items.
- <format_profile> (sometimes): how pieces in this format are usually organised.
- <current_outline> and <conversation>: the outline now, and what the writer and you have said, including earlier suggestions and anything found on the web.
- <web_findings> (sometimes): what a web lookup found for the writer's last message.

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
- Use <web_findings> when they are given, and name the sites in plain words in "reply". Never state a fact from the web that is not in them. If the writer asked you to look something up and there are no findings, say the lookup did not run and ask them to tick "Search the web" under the message box and send it again. Do not pretend the web is unavailable.
- Build on earlier suggestions and the writer's changes instead of starting over.

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
  const retry = body.retry === true;
  const message = retry ? "" : String(body.message ?? "").trim();
  const thread = await threadId(piece, "outline");
  const { data: all } = await admin.from("thread_messages").select("id, role, content, payload").eq("thread_id", thread)
    .order("created_at");
  // Retrying drops the last AI reply and answers the writer's last message again.
  const lastAi = retry && all?.length && all[all.length - 1].role === "ai" ? all[all.length - 1] : null;
  const history = ((lastAi ? all!.slice(0, -1) : all) ?? []) as ThreadRow[];
  const askedFor = message || (retry ? [...history].reverse().find((m) => m.role === "writer")?.content ?? "" : "");
  // A lookup runs when the writer ticked "Search the web", asked for one in words, or the reply being retried had one.
  const lookup = askedFor !== "" && (body.web === true || wantsWeb(askedFor) || Boolean((lastAi?.payload as { web?: unknown } | null)?.web));
  const { data: current } = await admin.from("piece_sections").select("position, heading, purpose").eq("piece_id", piece.id)
    .order("position");
  // Wiring: brief, contract, analysis, approved research, format profile. No core voice or memory.
  const context = await contextFor(piece, ["brief", "contract", "analysis", "piece_items", "format_profile"]);
  const convo = describeThread(history, message ? { role: "writer", content: message } : undefined);
  const user = `${context}

<current_outline>
${(current ?? []).map((s) => `${s.position}. ${s.heading} (${s.purpose})`).join("\n") || "(empty)"}
</current_outline>

<conversation>
${convo || "(No messages yet. Suggest a first outline.)"}
</conversation>`;
  return task<{ reply: string; sections: { heading: string; purpose: string; expectations: number[] }[] }>(
    "outline_suggest", "reason", piece, userId, (await promptSet(piece.company_id))("outline", OUTLINE_SYSTEM), user, outlineSchema, 2000,
    async (data, cost, model, found) => {
      if (lastAi) await admin.from("thread_messages").delete().eq("id", lastAi.id);
      if (message) {
        await admin.from("thread_messages").insert({ company_id: piece.company_id, thread_id: thread, role: "writer", content: message, created_by: userId });
      }
      const { data: msg, error } = await admin.from("thread_messages").insert({
        company_id: piece.company_id, thread_id: thread, role: "ai", content: data.reply,
        payload: { sections: data.sections, ...(found ? { web: found } : {}) },
      }).select().single();
      if (error) throw error;
      await logEvent(piece, userId, "outline_suggested");
      return { message: msg, cost_usd: cost, model };
    },
    // Looked up only when the writer asks for it; what it finds is kept with the reply and carried forward.
    lookup
      ? async () => {
        const found = await webLookup(piece, userId, askedFor, piece.topic || piece.title, convo);
        return { userSuffix: `\n\n${webBlock(found)}`, extra: found };
      }
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Section brief: crisp bullets, never prose
// ---------------------------------------------------------------------------

export const BRIEF_SYSTEM = `ROLE
You write the brief for ONE section of a piece. The writer will write the section by hand from your bullets, so the bullets must carry content, not style.

WHAT YOU RECEIVE
- <section>: the heading, its purpose, the contract expectations it owes, and sometimes its planned structure (blocks such as answer, bullets, table).
- <outline>, <analysis>: the whole piece's plan and what the research found.
- <section_research>: numbered approved items, [1], [2], and so on.

STEPS
1. Read the expectations this section owes. Each one must be covered by at least one bullet.
2. Read the approved items. Pick the facts this section needs.
3. If the analysis shows a tension, or a company insight that contradicts the consensus, and it belongs in this section, add a bullet for it.
4. Write 4 to 10 bullets in a sensible order. Put the "answer:" bullet first.
5. If <section> lists a planned structure, cover each planned block with at least one bullet, in the same order. Use the block type as the label (for example "table: rows = three tools; columns = cost, setup time").

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
- <section> may list a planned structure: the blocks the section is made of.

STEPS
1. Follow the brief bullets in order. Every bullet must appear in the draft.
   If a planned structure is given, build the section from its blocks in order: answer = a short standalone answer of about 40 to 60 words; bullets = a "- " list; steps = a numbered list; table = a markdown table; subheading = a "### " line; faq = the question in bold, then a short answer; example, data, quote, takeaway = a short paragraph of that kind.
2. Open with the "answer:" bullet's point, in one or two plain sentences.
3. For each fact or figure, use the approved item it comes from and say in the text where it comes from.
4. Write in the company's core voice, with the habits of the format profile, and obey the voice memory.

RULES
- Use only the approved research for facts and figures. Do NOT add any other number, name, date or claim.
- Bullets without a research item are the writer's own view. Write them as that view and add no facts.
- No heading for the section itself (the writer adds it), no preamble, no closing summary, no "In conclusion".
- Without a planned structure, write plain prose. With one, use only the formatting its blocks call for.
- Never write the section as one block of prose when the structure lists several blocks.

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
    piece, userId, (await promptSet(piece.company_id))("grammar", GRAMMAR_SYSTEM), `<text>\n${text}\n</text>`, grammarSchema, 800, async (data, cost, model) => {
      const suggestions = data.suggestions.filter((s) => s.original && s.original !== s.replacement && text.includes(s.original));
      // Remember which revision of the text was checked, so the tick goes away on the next edit.
      // A check of text that wasn't saved yet can't be tied to a revision, so it isn't recorded.
      if (text === section.content.trim()) {
        await admin.from("piece_sections").update({
          grammar_check: { checked_at: new Date().toISOString(), rev: section.content_rev, found: suggestions.length },
        }).eq("id", section.id);
      }
      return { suggestions, cost_usd: cost, model };
    });
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
        rev: section.content_rev,
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
        rev: section?.content_rev ?? null,
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

// ---------------------------------------------------------------------------
// Section structure: what goes under each heading, so a section is more than a paragraph
// ---------------------------------------------------------------------------

export const BLOCK_TYPES = ["answer", "paragraph", "bullets", "steps", "table", "example", "data", "subheading", "faq", "quote", "takeaway"] as const;

export const STRUCTURE_SYSTEM = `ROLE
You plan the inside of each section of a B2B article. The outline gives each section a heading and a one-line purpose. You decide what each section is made of, so the finished article is not just "heading, paragraph, heading, paragraph".

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and what the reader expects.
- <analysis>, <approved_research>: what the research found, as numbered items.
- <format_profile> (sometimes): how pieces in this format are usually organised.
- <search_landscape>: what ranking pages cover and skip, and what people ask.
- <outline>: the sections, numbered, with their purpose.

STEPS
1. Read the whole outline. Decide which sections carry a decision, a comparison, a process, a proof or a plain explanation.
2. For each section, choose 3 to 6 blocks, in reading order.
3. Give every block a "note": one line saying what goes in this block for THIS section. Name the real subject, and the research item numbers [n] it can draw on.
4. Compare neighbouring sections. If two in a row have the same shape, change one, unless the content really calls for it.

BLOCK TYPES (use exactly these words for "type")
- answer: a short, standalone answer to the section's question (about 40 to 60 words). Usually first.
- paragraph: explanation or argument in prose.
- bullets: a list of parallel points.
- steps: a numbered procedure.
- table: a comparison. The note names the rows and the columns.
- example: a real customer case, scenario or worked example.
- data: a figure or finding from the research, with its source and date.
- subheading: a smaller heading inside the section that splits it into parts. The note gives the heading text.
- faq: a question readers ask, with a short answer. The note gives the question.
- quote: an expert's view from the company's own insights.
- takeaway: one sentence saying what the reader should do or remember.

RULES
- Match the block to the content: comparisons go in a table, procedures in steps, parallel points in bullets. Do not use a table or list when prose reads better.
- A section is not made of one paragraph. Use at least one block that is not "paragraph".
- Use "answer" first in a section whose heading is a question or a "what is / how to / which" topic.
- Use only subjects and facts found in the brief, contract, analysis and approved research. Never invent a customer, figure or quote.
- Do not write the content itself. Describe it.
- Do not change the headings or the order of the sections.

OUTPUT
- sections: one entry per outline section, in the same order. Each has "position" (the section's number) and "blocks" (a list of "type" and "note").`;

const blockSchema = obj({ type: { type: "string", enum: [...BLOCK_TYPES] }, note: str });
const structureSchema = obj({ sections: list(obj({ position: { type: "integer" }, blocks: list(blockSchema) })) });

function cleanBlocks(blocks: { type: string; note: string }[]): { type: string; note: string }[] {
  return blocks.filter((b) => (BLOCK_TYPES as readonly string[]).includes(b.type) && b.note?.trim())
    .map((b) => ({ type: b.type, note: b.note.trim() })).slice(0, 8);
}

function outlineText(secs: { position: number; heading: string; purpose: string; structure?: unknown }[], withStructure: boolean): string {
  return secs.map((s) => {
    const blocks = withStructure && Array.isArray(s.structure) ? (s.structure as { type: string; note: string }[]) : [];
    return `${s.position}. ${s.heading} (${s.purpose})${blocks.map((b) => `\n   - ${b.type}: ${b.note}`).join("")}`;
  }).join("\n");
}

async function prepareStructure(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, setting<string>(piece, "outline.mode") !== "off", "Section structure");
  if (piece.stage !== "outline") throw new UserError("Structure is planned while the outline is open.");
  const { data: secs } = await admin.from("piece_sections").select("position, heading, purpose, structure").eq("piece_id", piece.id)
    .order("position");
  if (!secs?.length) throw new UserError("Save an outline first.");
  const { data: serp } = await admin.from("research_items").select("statement").eq("piece_id", piece.id)
    .eq("source_type", "serp").eq("status", "approved");
  const landscape = (serp ?? []).map((r) => `- ${r.statement}`).join("\n") || "(no search-landscape items were approved)";
  // Wiring: brief, contract, analysis, approved research, format profile, outline. No voice or memory.
  const context = await contextFor(piece, ["brief", "contract", "analysis", "piece_items", "format_profile"]);
  const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n<outline>\n${outlineText(secs, false)}\n</outline>`;
  return task<{ sections: { position: number; blocks: { type: string; note: string }[] }[] }>(
    "outline_structure", "reason", piece, userId, (await promptSet(piece.company_id))("structure", STRUCTURE_SYSTEM), user, structureSchema, 2500,
    async (data, cost, model) => {
      const sections = secs.map((s) => ({
        position: s.position,
        blocks: cleanBlocks(data.sections.find((x) => x.position === s.position)?.blocks ?? []),
      }));
      await logEvent(piece, userId, "outline_structure_suggested", { sections: sections.length });
      return { sections, cost_usd: cost, model };
    },
  );
}

// ---------------------------------------------------------------------------
// Fixing SEO and GEO gaps with AI
// ---------------------------------------------------------------------------

export const SEO_FIX_OUTLINE = `ROLE
You revise an article outline so that it fixes the gaps a search (SEO) and answer-engine (GEO) review found. You change the plan, not the subject.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and the numbered expectations the piece owes.
- <search_landscape>: what ranking pages cover and skip, and what people ask.
- <gaps>: the review's "improve" items. Each has a check name, what the reviewer saw, and a suggested fix.
- <outline>: the current sections, numbered, each with its purpose, the contract expectations it serves, and its planned blocks.

STEPS
1. Read each gap. Decide which section or sections it affects.
2. Change only what a gap needs: a heading, a purpose, the order, a section added or removed, or the planned blocks.
3. Keep every section that has no gap exactly as it is.
4. Check that every contract expectation is still served by at least one section.

RULES
- Headings stay specific to the sub-topic. Never "Introduction", "Overview" or "Conclusion".
- Never suggest keyword stuffing, repeating the keyword, or padding.
- A title or meta gap is fixed in "reply" as a suggestion; the outline has no title.
- Block types are: answer, paragraph, bullets, steps, table, example, data, subheading, faq, quote, takeaway. Each block has a one-line "note" saying what goes in it for this section.
- Do not invent facts, customers or figures.

OUTPUT
- reply: 1 to 3 sentences saying what you changed and which gaps it fixes, and what you could not fix in the outline.
- sections: the FULL revised outline. Each has "heading", "purpose", "expectations" (contract expectation numbers) and "blocks".`;

export const SEO_FIX_FINAL = `ROLE
You propose small edits to a finished article that fix the gaps a search (SEO) and answer-engine (GEO) review found. The writer reads and accepts each edit one by one.

WHAT YOU RECEIVE
- <gaps>: the review's "improve" items. Each has a check name, what the reviewer saw, and a suggested fix.
- <piece>: the article, section by section. Each section is numbered.

STEPS
1. Read each gap. Find the place in the article it applies to.
2. Decide whether a text edit can fix it. Gaps about internal links, publication dates you cannot know, or the title and meta text cannot be fixed by an edit: skip them.
3. For each fixable gap, write the smallest edit that fixes it.

EDIT KINDS (use exactly these words for "where")
- replace: change a passage. "original" is the passage copied exactly from the section, word for word. "replacement" is the new passage.
- start: add text at the beginning of the section. "original" is an empty string.
- end: add text at the end of the section. "original" is an empty string.

RULES
- Keep the writer's wording. Change as few words as the fix needs. Never rewrite a whole paragraph.
- Use only facts, names and numbers already in the article. Do not add any.
- To make a section start with a direct answer, write one or two plain sentences (about 40 to 60 words) from what the section already says.
- To make a claim stand alone, name its subject in the same sentence. To add attribution, use the source the article already mentions.
- Do not add keywords for their own sake.
- At most 8 edits in total.

OUTPUT
- reply: 1 or 2 sentences: what the edits fix and which gaps you skipped and why.
- edits: a list. Each has "section" (the section number), "where", "original", "replacement", "check" (the gap's check name) and "reason" (a few words).`;

const fixOutlineSchema = obj({
  reply: str,
  sections: list(obj({ heading: str, purpose: str, expectations: list({ type: "integer" }), blocks: list(blockSchema) })),
});
const fixFinalSchema = obj({
  reply: str,
  edits: list(obj({
    section: { type: "integer" },
    where: { type: "string", enum: ["replace", "start", "end"] },
    original: str,
    replacement: str,
    check: str,
    reason: str,
  })),
});

type Gap = { check: string; label: string; evidence: string; fix: string };

async function prepareSeoFix(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  const scope = body.scope === "final" ? "final" : "outline";
  requireStep(piece, scope === "outline" ? on(piece, "outline.seo_geo_check") : on(piece, "checks.seo") || on(piece, "checks.geo"),
    "Fixing SEO and GEO gaps");
  const { data: saved } = await admin.from("pieces").select("seo_geo_outline, seo_geo_final").eq("id", piece.id).single();
  const result = (scope === "outline" ? saved?.seo_geo_outline : saved?.seo_geo_final) as { checks: (Gap & { status: string })[] } | null;
  const gaps = (result?.checks ?? []).filter((c) => c.status === "improve" && c.fix);
  if (!gaps.length) throw new UserError("Run the check first. There is nothing to improve yet.");
  const gapText = `<gaps>\n${gaps.map((g) => `- ${g.check} (${g.label}): saw: ${g.evidence || "n/a"} | suggested fix: ${g.fix}`).join("\n")}\n</gaps>`;
  const prompts = await promptSet(piece.company_id);

  if (scope === "outline") {
    if (piece.stage !== "outline") throw new UserError("The outline can be improved while it is open.");
    const { data: secs } = await admin.from("piece_sections").select("position, heading, purpose, expectation_ids, structure")
      .eq("piece_id", piece.id).order("position");
    if (!secs?.length) throw new UserError("Save an outline first.");
    const { data: c } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).single();
    const expectations = (c?.expectations ?? []) as { id: string }[];
    const { data: serp } = await admin.from("research_items").select("statement").eq("piece_id", piece.id)
      .eq("source_type", "serp").eq("status", "approved");
    const landscape = (serp ?? []).map((r) => `- ${r.statement}`).join("\n") || "(none)";
    const context = await contextFor(piece, ["brief", "contract"]);
    const outline = secs.map((s) => {
      const nums = (s.expectation_ids as string[]).map((id) => expectations.findIndex((e) => e.id === id) + 1).filter((n) => n > 0);
      return `${outlineText([s], true)}\n   serves expectations: ${nums.join(", ") || "none"}`;
    }).join("\n");
    const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n${gapText}\n\n<outline>\n${outline}\n</outline>`;
    return task<{ reply: string; sections: { heading: string; purpose: string; expectations: number[]; blocks: { type: string; note: string }[] }[] }>(
      "seo_fix_outline", "reason", piece, userId, prompts("seo_fix.outline", SEO_FIX_OUTLINE), user, fixOutlineSchema, 3000,
      async (data, cost, model) => {
        await logEvent(piece, userId, "seo_fix_outline_suggested", { gaps: gaps.length });
        return {
          reply: data.reply,
          sections: data.sections.map((s) => ({ ...s, blocks: cleanBlocks(s.blocks) })),
          cost_usd: cost,
          model,
        };
      },
    );
  }

  const { data: secs } = await admin.from("piece_sections").select("id, position, heading, content").eq("piece_id", piece.id).order("position");
  const text = (secs ?? []).map((s) => `<section n="${s.position}" heading="${s.heading}">\n${s.content}\n</section>`).join("\n\n");
  if (!text.trim()) throw new UserError("Nothing written yet.");
  const user = `${gapText}\n\n<piece>\n# ${piece.title}\n\n${text}\n</piece>`;
  return task<{ reply: string; edits: { section: number; where: string; original: string; replacement: string; check: string; reason: string }[] }>(
    "seo_fix_final", "reason", piece, userId, prompts("seo_fix.final", SEO_FIX_FINAL), user, fixFinalSchema, 3000,
    async (data, cost, model) => {
      // Keep only edits that can be applied: a known section, and for "replace" a passage that is really there.
      const edits = data.edits.flatMap((e) => {
        const s = secs?.find((x) => x.position === e.section);
        if (!s || !e.replacement.trim()) return [];
        if (e.where === "replace" && (!e.original || !s.content.includes(e.original) || e.original === e.replacement)) return [];
        return [{ ...e, section_id: s.id, heading: s.heading }];
      }).slice(0, 8);
      await logEvent(piece, userId, "seo_fix_final_suggested", { gaps: gaps.length, edits: edits.length });
      return { reply: data.reply, edits, cost_usd: cost, model };
    },
  );
}

/** Applies one accepted edit to a section and records that the text now contains AI-suggested wording. No model call. */
export async function applySeoFix(userId: string, body: Record<string, unknown>) {
  const { piece, section } = await sectionFor(userId, body);
  if (piece.stage === "done") throw new UserError("This piece is signed off. Revise it to change the text.");
  const where = String(body.where ?? "");
  const original = String(body.original ?? "");
  const replacement = String(body.replacement ?? "");
  if (!replacement.trim()) throw new UserError("Nothing to add.");
  let content: string;
  if (where === "replace") {
    if (!original || !section.content.includes(original)) throw new UserError("That passage has changed since the suggestion. Run the fix again.");
    content = section.content.replace(original, () => replacement);
  } else if (where === "start") {
    content = `${replacement.trim()}\n\n${section.content.replace(/^\s+/, "")}`;
  } else if (where === "end") {
    content = `${section.content.replace(/\s+$/, "")}\n\n${replacement.trim()}`;
  } else {
    throw new UserError("Unknown edit.");
  }
  const { error } = await admin.from("piece_sections").update({ content }).eq("id", section.id);
  if (error) throw error;
  await logEvent(piece, userId, "seo_fix_applied", { section: section.id, where, check: String(body.check ?? "") });
  return { content };
}

export const WRITING_TASKS: Record<string, (userId: string, body: Record<string, unknown>) => Promise<Prepared>> = {
  analysis: prepareAnalysis,
  analysis_fix: prepareAnalysisFix,
  outline_suggest: prepareOutline,
  section_brief: prepareBrief,
  section_draft: prepareDraft,
  grammar_check: prepareGrammar,
  fact_check: prepareFacts,
  contract_check: prepareContractCheck,
  learn_voice: prepareLearn,
  seo_geo_check: prepareSeoGeo,
  outline_structure: prepareStructure,
  seo_fix: prepareSeoFix,
  repurpose_plan: prepareRepurpose,
};
