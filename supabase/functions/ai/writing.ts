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
Use 0 for "item" and "point", "" for "text", "heading" and "purpose", and [] for "points" when an action doesn't use them. "why" is one short plain sentence for the writer saying what the change fixes. Write it as you would explain it to a colleague: refer to things by what they are about ("the landing-page section", "the research on AI incidents"), never by a ref or a number, and never use the words "gap", "drift", "finding", "entry", "ref", "expectation" or "scope point". "resolves" lists the "ref" values (such as "drift-0" or "suggestion-1") of the entries in <analysis> that this change fully settles, so the writer's list can drop them; list none you are unsure of, and never invent a ref. A gap is never settled by these actions.

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
export const RESEARCH_GAP_RULES = `

ONE MORE ACTION FOR THIS REQUEST
- research_gap: "text" is a short question for a web search; "resolves" holds the "ref" of the one open gap it is for. Judge each gap by what its description says is missing, not by the question put to the company's expert. Use it whenever the missing material is something published that a web search can find: how a method or check works, accepted practice or standards, regulator or platform guidance, what studies and vendors report. Many gaps have a general part (published practice) and a part only the company can answer (what it saw, did or measured): search for the general part and leave the rest to the expert. Skip a gap only when nothing about it could be found on the web, because it is entirely about the company's own results or decisions. At most one research_gap per gap. A search adds sources to the research; it does not settle the gap.
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
// Checking whether the fixes closed what the alignment check found
// ---------------------------------------------------------------------------

export const ANALYSIS_VERIFY_SYSTEM = `ROLE
You check whether the changes made to a piece of B2B content settled the problems an earlier alignment check found. You do not look for new problems.

WHAT YOU RECEIVE
- <brief>, <reader_contract>, <approved_research>, <outline>: the piece as it is now.
- <findings_to_check>: the problems found earlier. Each has a "ref", a "kind", a description, and what has been done about it since.

STEPS
For each finding, decide whether it is now closed.
- gap: closed only when <approved_research> now holds material that answers what the gap says is missing. An outline section alone does not close a gap, and neither does a search whose results do not answer it.
- adjustment (research that drifted off the topic, or a suggested change to a scope point): closed when the scope point now says what the finding asked for, or the research that drifted is no longer approved.

RULES
- Judge only the listed findings, and only against what you are given. Never add a finding and never raise anything new.
- Judge fit with the topic, not the quality of sources. Never comment on a source's reliability.
- When unsure, answer "open": a finding is closed only when the material is clearly there.
- "reason" is one short plain sentence for the writer. Refer to things by what they are about, never by a ref or a number, and never use the words "gap", "drift", "finding" or "entry".
- Return one result for every finding, with its exact ref.`;

const analysisVerifySchema = obj({
  results: list(obj({ ref: str, closed: { type: "boolean" }, reason: str })),
});

async function prepareAnalysisVerify(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "analysis.enabled"), "Analysis");
  const { data: row } = await admin.from("pieces").select("analysis, outline_confirmed_at, stage").eq("id", piece.id).single();
  if (row?.stage !== "outline" || row.outline_confirmed_at) throw new UserError("Checking again works before the outline is confirmed.");
  if (!row.analysis) throw new UserError("Run the alignment check first.");

  type Entry = { text?: string; change?: string; why?: string; points?: number[]; items?: number[]; ignored?: boolean; resolved?: boolean; researched?: number; sectioned?: boolean };
  const a = row.analysis as { gaps?: Entry[]; drift?: Entry[]; contract_suggestions?: Entry[]; item_ids?: string[]; point_ids?: string[] };
  const items = await approvedItems(piece.id);
  const approvedIds = new Set(items.map((i) => i.id));
  const { data: c } = await admin.from("piece_contracts").select("expectations").eq("piece_id", piece.id).maybeSingle();
  const points = (c?.expectations ?? []) as { id: string; text: string }[];
  // The check numbered scope points as they were; map each number to the point's current wording.
  const pointTexts = (nums: number[] = []) => nums.flatMap((n) => {
    const p = points.find((x) => x.id === a.point_ids?.[n - 1]);
    return p ? [p.text] : [];
  });

  // The refs are positions in the saved lists, counted before anything is skipped (the screen uses the same ones).
  const findings: { ref: string; kind: string; description: string; scope_points?: string[]; done_since?: string[] }[] = [];
  const open = (x: Entry) => !x.ignored && !x.resolved;
  (a.gaps ?? []).forEach((g, i) => {
    if (!open(g)) return;
    const done: string[] = [];
    if (g.researched) done.push(`a web search added ${g.researched} sources to the approved research`);
    if (g.sectioned) done.push("an outline section was added for it");
    findings.push({ ref: `gap-${i}`, kind: "gap", description: g.text ?? "", scope_points: pointTexts(g.points), done_since: done });
  });
  (a.drift ?? []).forEach((d, i) => {
    if (!open(d)) return;
    const named = (d.items ?? []).map((n) => a.item_ids?.[n - 1]).filter((id): id is string => Boolean(id));
    const dropped = named.filter((id) => !approvedIds.has(id)).length;
    findings.push({
      ref: `drift-${i}`, kind: "adjustment", description: d.text ?? "", scope_points: pointTexts(d.points),
      done_since: named.length ? [`${dropped} of the ${named.length} research items it names are no longer approved`] : [],
    });
  });
  (a.contract_suggestions ?? []).forEach((s, i) => {
    if (!open(s)) return;
    findings.push({ ref: `suggestion-${i}`, kind: "adjustment", description: `${s.change ?? ""} (${s.why ?? ""})` });
  });
  if (!findings.length) throw new UserError("Nothing is left to check.");

  const { data: secs } = await admin.from("piece_sections").select("heading, purpose, expectation_ids").eq("piece_id", piece.id).order("position");
  const outline = (secs ?? []).map((s, i) => {
    const covers = points.flatMap((p, j) => (s.expectation_ids as string[]).includes(p.id) ? [j + 1] : []);
    return `${i + 1}. ${s.heading}${s.purpose ? ` (${s.purpose})` : ""} covers points: ${covers.join(", ") || "none"}`;
  }).join("\n");
  const context = `${await contextFor(piece, ["brief", "contract", "piece_items_plain"])}\n\n<outline>\n${outline || "(no sections yet)"}\n</outline>\n\n<findings_to_check>\n${JSON.stringify(findings, null, 1)}\n</findings_to_check>`;
  const system = (await promptSet(piece.company_id))("analysis_verify", ANALYSIS_VERIFY_SYSTEM);

  return task<{ results: { ref: string; closed: boolean; reason: string }[] }>(
    "analysis_verify", "reason", piece, userId, system, context, analysisVerifySchema, 2000,
    async (data, cost, model) => {
      const valid = new Set(findings.map((f) => f.ref));
      const byRef = new Map<string, { closed: boolean; reason: string }>();
      for (const r of data.results) {
        if (valid.has(r.ref) && !byRef.has(r.ref)) byRef.set(r.ref, { closed: r.closed === true, reason: r.reason.trim() });
      }
      // Read the saved check again, so an Ignore made a moment ago isn't overwritten. Closed findings are marked
      // resolved; open ones keep the reason. Nothing else about the check changes.
      const { data: fresh } = await admin.from("pieces").select("analysis").eq("id", piece.id).single();
      const cur = fresh?.analysis as { gaps?: Record<string, unknown>[]; drift?: Record<string, unknown>[]; contract_suggestions?: Record<string, unknown>[] } | null;
      if (!cur) throw new UserError("The saved check is gone. Run the check again.");
      const mark = (list: Record<string, unknown>[] | undefined, prefix: string) => list?.map((x, i) => {
        const r = byRef.get(`${prefix}-${i}`);
        if (!r) return x;
        return r.closed ? { ...x, resolved: true, verify_note: undefined } : { ...x, verify_note: r.reason };
      });
      const next = { ...cur, gaps: mark(cur.gaps, "gap"), drift: mark(cur.drift, "drift"), contract_suggestions: mark(cur.contract_suggestions, "suggestion"), fixes_applied: true };
      const { error } = await admin.from("pieces").update({ analysis: next }).eq("id", piece.id);
      if (error) throw error;
      const closedRefs = [...byRef].filter(([, r]) => r.closed).map(([ref]) => ref);
      await logEvent(piece, userId, "analysis_verified", { closed: closedRefs.length, open: byRef.size - closedRefs.length });
      return { closed_refs: closedRefs, open: byRef.size - closedRefs.length, cost_usd: cost, model };
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
// Building the outline in one go, from the scope and research the writer just settled
// ---------------------------------------------------------------------------

export const OUTLINE_BUILD_SYSTEM = `ROLE
You are a writer turning the confirmed scope and approved research of one piece of B2B content into an outline. There is no conversation: you produce the outline once, and the writer edits it afterwards.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject and the numbered expectations the piece owes the reader.
- <analysis> (sometimes): an earlier check of the plan against the topic. Entries marked resolved or ignored are settled; use the rest only to see what the research now covers.
- <approved_research>: numbered items. Build on what they say.
- <format_profile> (sometimes): how pieces in this format are usually organised.

STEPS
1. Choose the shape from the reader's intent:
   - "what are X": the list up front, then one section per item
   - "how to": steps in order
   - "should I": a decision framework
2. Write the sections in an order that carries the reader from the question to what they can do. Each section gets a heading and a one-line purpose that says what it tells the reader.
3. For each section, list the numbers of the contract expectations it serves.
4. Check that every contract expectation is served by at least one section. If one is not, add or change a section.
5. Let the approved research shape the sections: give room to what it covers well, and do not plan a section the research gives nothing to say about.

RULES
- Headings are specific to the sub-topic. Never use "Introduction", "Overview" or "Conclusion".
- Use the format profile only for structure (how pieces open and are organised), not for wording.
- Use only subjects found in the brief, contract and approved research. Never invent a customer, a figure or a claim.
- Don't plan word counts.
- Use as few sections as serve every expectation, usually 4 to 8.

OUTPUT
- sections: the full outline. Each section has "heading", "purpose" (one line) and "expectations" (a list of contract expectation numbers).`;

const outlineBuildSchema = obj({
  sections: list(obj({ heading: str, purpose: str, expectations: list({ type: "integer" }) })),
});

async function prepareOutlineBuild(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, setting<string>(piece, "outline.mode") !== "off", "Outline");
  const { data: row } = await admin.from("pieces").select("stage, outline_confirmed_at").eq("id", piece.id).single();
  if (row?.stage !== "outline" || row.outline_confirmed_at) throw new UserError("The outline can be built while it is open.");
  // Wiring: brief, contract, analysis, approved research, format profile. No voice or memory.
  const context = await contextFor(piece, ["brief", "contract", "analysis", "piece_items", "format_profile"]);
  return task<{ sections: { heading: string; purpose: string; expectations: number[] }[] }>(
    "outline_build", "reason", piece, userId, (await promptSet(piece.company_id))("outline_build", OUTLINE_BUILD_SYSTEM), context, outlineBuildSchema, 2500,
    async (data, cost, model) => {
      const sections = data.sections
        .map((s) => ({ heading: s.heading.trim(), purpose: s.purpose.trim(), expectations: [...new Set(s.expectations)] }))
        .filter((s) => s.heading)
        .slice(0, 12);
      if (!sections.length) throw new UserError("The AI didn't return an outline. Try again.");
      await logEvent(piece, userId, "outline_built", { sections: sections.length });
      return { sections, cost_usd: cost, model };
    },
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
// Talking points for one section: the default way a section is prepared for the writer
// ---------------------------------------------------------------------------

export const SECTION_POINTS_SYSTEM = `ROLE
You prepare ONE section of a B2B article so that the writer can write it without leaving the screen. You do not write the section. You give the writer what they need: the points to make, how to make them, and the evidence behind each. Your aim is to strengthen the section and make it a really good source to write from.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and what the reader expects.
- <section>: this section's heading, purpose, the contract expectations it owes, and its planned sub-sections in order.
- <outline>: the whole article's plan.
- <earlier_sections>: what the sections before this one already cover, so you don't repeat them.
- <research>: numbered items found for this piece and this section: [1], [2] and so on.

STEPS
1. Read what the section owes the reader and its planned sub-sections.
2. For each planned sub-section, in order, work out the points the writer should make. Add a point for any expectation the section owes that no sub-section covers.
3. For each point, say how to make it, and pull in the best evidence from <research>.
4. Look for what would make the section stronger than a typical article: a sharper angle, a worked example, a comparison, a number that makes the point land. Include it only when <research> or the brief supports it.
5. Suggest 2 or 3 alternative headings for the section, specific to its sub-topic.
6. If the planned sub-sections leave something out that this section needs, suggest an extra sub-section and say why.
7. Say where the research is thin and the writer will need their own view or experience.

POINT FIELDS
- point: the idea or claim, in plain words, one short sentence.
- direction: how to treat it: what to say, the angle, an example to use, what to avoid. Directions, not finished sentences or quotable lines.
- evidence: the specific fact, figure or finding to use, with where it comes from in a few words. Empty when no research supports the point.
- refs: the numbers of the research items it uses. Empty when none.
- sub_section: the planned sub-section it belongs to (its kind and note), or "" when it belongs to none.

RULES
- Use only <research> for facts, figures, names and dates. Never invent a customer, number or claim. A point with no evidence is the writer's own view: say so in "direction".
- Do not repeat what <earlier_sections> already covers; build on it or refer to it.
- Never use the words "Introduction", "Overview" or "Conclusion" in a heading.
- Write plain words. Do not write the section's prose: no transitions, no polished sentences the writer could paste in.
- 4 to 10 points. Quality over count.

OUTPUT
- titles: 2 or 3 alternative headings.
- points: the list of points, in the order the section should make them.
- extra_sub_sections: each with "heading" and "why". Empty when the plan is enough.
- thin: where the research is thin, one line each. Empty when it is well covered.`;

const sectionPointsSchema = obj({
  titles: list(str),
  points: list(obj({ point: str, direction: str, evidence: str, refs: list({ type: "integer" }), sub_section: str })),
  extra_sub_sections: list(obj({ heading: str, why: str })),
  thin: list(str),
});

async function prepareSectionPoints(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, setting<string>(piece, "outline.mode") !== "off", "Section talking points");
  if (section.status === "written") throw new UserError("This section is already written. Reopen it to prepare it again.");
  // Research for this section, then the piece's own approved research, as one numbered list.
  const sectionItems = await approvedItems(piece.id, section.id);
  const pieceItems = await approvedItems(piece.id);
  const all = [
    ...sectionItems.map((i) => ({ ...i, scope: "section" as const })),
    ...pieceItems.map((i) => ({ ...i, scope: "piece" as const })),
  ].map((i, idx) => ({ ...i, n: idx + 1 }));
  const researchText = all.map((i) => `[${i.n}] (${i.source_type}${i.source ? `; ${i.source}` : ""}) ${i.statement}`).join("\n") || "(none)";
  const { data: before } = await admin.from("piece_sections").select("position, heading, points").eq("piece_id", piece.id)
    .lt("position", section.position).order("position");
  const earlier = (before ?? []).map((s) => {
    const pts = ((s.points as { points?: { point: string }[] } | null)?.points ?? []).map((p) => p.point).slice(0, 6);
    return `${s.position}. ${s.heading}${pts.length ? `: ${pts.join("; ")}` : ""}`;
  }).join("\n") || "(this is the first section)";
  // Wiring: brief, contract, the section and the outline, what earlier sections cover, and the research. No voice.
  const context = await contextFor(piece, ["brief", "contract", "outline"], section);
  const user = `${context}\n\n<earlier_sections>\n${earlier}\n</earlier_sections>\n\n<research>\n${researchText}\n</research>`;
  return task<{
    titles: string[];
    points: { point: string; direction: string; evidence: string; refs: number[]; sub_section: string }[];
    extra_sub_sections: { heading: string; why: string }[];
    thin: string[];
  }>(
    "section_points", "reason", piece, userId, (await promptSet(piece.company_id))("section_points", SECTION_POINTS_SYSTEM), user, sectionPointsSchema, 3500,
    async (data, cost, model) => {
      // A piece-level item the points lean on is copied into this section's research, so the fact check can see it.
      const sectionStatements = new Map(sectionItems.map((i) => [i.statement, i.id]));
      const idOf = async (n: number): Promise<string | null> => {
        const item = all.find((i) => i.n === n);
        if (!item) return null;
        if (item.scope === "section") return item.id;
        const known = sectionStatements.get(item.statement);
        if (known) return known;
        const { data: src } = await admin.from("research_items").select("*").eq("id", item.id).single();
        if (!src) return null;
        const { data: copy, error } = await admin.from("research_items").insert({
          company_id: src.company_id, piece_id: src.piece_id, scope: "section", section_key: section.id, source_id: src.source_id,
          card_id: src.card_id, statement: src.statement, quote: src.quote, source_type: src.source_type, secondary: src.secondary,
          status: "approved", edited: src.edited, reviewed_by: userId, reviewed_at: new Date().toISOString(),
        }).select("id").single();
        if (error) throw error;
        sectionStatements.set(item.statement, copy.id);
        return copy.id as string;
      };
      const points: { point: string; direction: string; evidence: string; refs: string[]; sub_section: string }[] = [];
      for (const p of data.points.slice(0, 12)) {
        const point = p.point.trim();
        if (!point) continue;
        const refs = [...new Set((await Promise.all([...new Set(p.refs)].map(idOf))).filter((x): x is string => Boolean(x)))];
        points.push({ point, direction: p.direction.trim(), evidence: p.evidence.trim(), refs, sub_section: p.sub_section.trim() });
      }
      if (!points.length) throw new UserError("The AI didn't return any talking points. Try again.");
      const stored = {
        titles: [...new Set(data.titles.map((t) => t.trim()).filter((t) => t && t !== section.heading))].slice(0, 4),
        points,
        extra_sub_sections: data.extra_sub_sections.map((e) => ({ heading: e.heading.trim(), why: e.why.trim() })).filter((e) => e.heading).slice(0, 5),
        thin: data.thin.map((t) => t.trim()).filter(Boolean).slice(0, 6),
        prepared_at: new Date().toISOString(),
      };
      // The brief is kept in step with the points (it is what an optional AI draft and the checks work from), and the
      // section moves on to writing: no manual research review or brief confirmation in this flow.
      const brief = points.slice(0, 10).map((p) => ({ text: `${p.point}${p.direction ? `: ${p.direction}` : ""}`.slice(0, 400), refs: p.refs }));
      const patch: Record<string, unknown> = { points: stored, brief };
      if (section.status === "research" || section.status === "brief") patch.status = "writing";
      const { error } = await admin.from("piece_sections").update(patch).eq("id", section.id);
      if (error) throw error;
      await logEvent(piece, userId, "section_prepared", { section: section.id, points: points.length });
      return { points: stored, cost_usd: cost, model };
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
- Without a planned structure, write prose, organised under headings as HEADINGS says. With one, use the formatting its blocks call for, and the headings HEADINGS asks for.
- Never write the section as one block of prose when the structure lists several blocks.

OUTPUT
- text: the section text only.`;

/**
 * Added to every draft prompt: how the section is organised under headings. Without it the draft only gets a heading when
 * the plan has a block of the kind "subheading", so most sections came out as one run of paragraphs.
 */
export const DRAFT_HEADINGS_NOTE = `HEADINGS
The section's own heading (H2) is added separately: never write one, and never use "#" or "##". Organise the section with:
- ### (H3) for each part of the section that stands on its own: a planned block of the kind steps, table, example, data, faq or subheading, or a group of points that belong to one planned sub-section. Open each with an H3 that names that part specifically, in plain words.
- #### (H4) for a smaller part inside an H3, only when that part needs its own label.
A short opening (an "answer" block or a first paragraph) comes before the first heading and has none. A section with only one or two small parts needs no headings. Headings are short noun phrases or plain statements, never "Introduction", "Overview" or "Conclusion", and never a question (a question belongs in an faq block, in bold).`;

/** Added to every draft prompt: sources are linked in the text, so the writer can open each one and decide whether to keep it. */
export const DRAFT_LINKS_NOTE = `INLINE SOURCES
When the text uses a fact, figure or finding from a research item, link it in line as a markdown link, [text](URL), on the source's name or on the phrase that carries the fact. Take the URL from that item's "url" line in <section_research>. Use only URLs given there and never invent one. Link a source once per paragraph at most. An item with no url is not linked.`;

/** Added to the draft prompt when the section has talking points (the Writing step's prepare run). */
export const DRAFT_POINTS_NOTE = `TALKING POINTS
<talking_points> lists what this section must address, each with the direction for it and its evidence. Address every point, in order, following the planned structure. Use the evidence given and say where it comes from. A point marked "no evidence" is the writer's own view: write it as a view and add no facts. Do not number the points or write the section as a list of them.`;

/** What the section is meant to cover, for the AI: its talking points (with evidence cited as [n]), or the hand-made brief. */
async function sectionGuide(piece: Piece, section: Awaited<ReturnType<typeof sectionFor>>["section"]): Promise<{ points: boolean; guide: string }> {
  const points = section.points?.points?.length ? section.points.points : null;
  if (points) {
    // The evidence is cited by the same [n] as in <section_research>.
    const numbered = await approvedItems(piece.id, section.id);
    const nOf = (id: string) => numbered.find((i) => i.id === id)?.n;
    return {
      points: true,
      guide: `<talking_points>\n${points.map((p, i) => {
        const cites = p.refs.map(nOf).filter((n): n is number => n !== undefined).map((n) => ` [${n}]`).join("");
        return `${i + 1}. ${p.point}${p.direction ? ` | direction: ${p.direction}` : ""}${p.evidence ? ` | evidence: ${p.evidence}${cites}` : " | no evidence"}${p.sub_section ? ` | for: ${p.sub_section}` : ""}`;
      }).join("\n")}\n</talking_points>`,
    };
  }
  return { points: false, guide: `<brief>\n${(section.brief ?? []).map((b) => `- ${b.text}`).join("\n") || "(no brief: write from the section and research)"}\n</brief>` };
}

async function prepareDraft(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "writing.ai_draft"), "AI drafting");
  if (!section.points?.points?.length && !section.brief?.length && on(piece, "sections.brief")) throw new UserError("Confirm the brief first.");
  // Wiring for drafting: section, outline, section research, core voice, format profile, and the talking points
  // (or the brief for a section prepared by hand).
  const single = setting<string>(piece, "outline.mode") === "off";
  const context = await contextFor(piece,
    single ? ["brief", "piece_items", "core_voice", "format_profile", "voice_memory"]
      : ["outline", "section_items", "core_voice", "format_profile", "voice_memory"], section);
  const { points: hasPoints, guide } = await sectionGuide(piece, section);
  const points = hasPoints ? [true] : null;
  const user = `${context}\n\n${guide}`;
  const draftSystem = (await promptSet(piece.company_id))("draft", DRAFT_SYSTEM) + `\n\n${DRAFT_HEADINGS_NOTE}\n\n${DRAFT_LINKS_NOTE}` + (points ? `\n\n${DRAFT_POINTS_NOTE}` : "");
  return task<{ text: string }>("section_draft", "write", piece, userId, draftSystem, user, obj({ text: str }), points ? 3500 : 2500,
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
// Revising a section from the writer's feedback, as small edits the writer accepts one by one
// ---------------------------------------------------------------------------

export const REVISE_SYSTEM = `ROLE
You revise part of one section of a B2B article, following the writer's feedback. You change as little as the feedback needs, and the writer accepts or ignores each change.

WHAT YOU RECEIVE
- <section>: the heading, purpose and planned structure. <outline>: the whole article's plan.
- <talking_points> or <brief>: what the section is meant to cover.
- <section_research>: numbered approved items, each with its url.
- <core_voice>, <format_profile>, <voice_memory>: how the company writes.
- <feedback>: what the writer wants changed.
- <scope>: whether the change is limited to the whole section, one part of it, or a selected passage, and which passage.
- <text>: the whole section as it is now, in Markdown.

STEPS
1. Read the feedback and decide exactly which passages it affects. Stay inside <scope>.
2. For each, write the smallest edit that does what the writer asked, in the company's voice, keeping the surrounding text, links and formatting.
3. Return edits, not a rewrite of the section.

EDIT FIELDS
- original: the passage to replace, copied EXACTLY from <text>, Markdown marks included, and long enough to appear only once.
- replacement: the new passage, in Markdown.
- reason: a few words on what it does.

RULES
- When <scope> is a part or a selection, every "original" must lie inside the passage given there. Never edit outside it.
- Change only what the feedback asks for. Do not reword for style, and do not touch sentences the feedback doesn't mention.
- New facts, figures, names and dates come only from <section_research>. Keep the inline source links, [text](URL), on facts you keep or add, and never invent a URL or a fact.
- Keep the heading levels: ### and ####, never ## or #.
- If the feedback needs something you don't have (a fact the research lacks), make no edit for that part and say so in "reply".
- At most 10 edits.

OUTPUT
- reply: 1 or 2 sentences: what you changed, and anything you couldn't do and why.
- edits: the list of edits. Empty when nothing should change.`;

const reviseSchema = obj({
  reply: str,
  edits: list(obj({ original: str, replacement: str, reason: str })),
});

async function prepareRevise(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const { piece, section } = await sectionFor(userId, body);
  requireStep(piece, on(piece, "writing.ai_draft"), "AI revision");
  if (section.status === "written") throw new UserError("This section is marked written. Reopen it to revise it.");
  // What the writer sees now (it may not be saved yet), what they want, and how far the change may reach.
  const text = String(body.text ?? "");
  const feedback = String(body.feedback ?? "").trim();
  if (!text.trim()) throw new UserError("There is no text to revise yet.");
  if (!feedback) throw new UserError("Say what should change.");
  if (text.length > 60_000 || feedback.length > 4_000) throw new UserError("That is too long to revise in one go.");
  const scope = body.scope === "selection" ? "selection" : body.scope === "part" ? "part" : "section";
  const excerpt = scope === "section" ? "" : String(body.excerpt ?? "");
  if (scope !== "section" && !excerpt.trim()) throw new UserError("Select the passage to revise first.");
  if (scope !== "section") {
    // The passage must be in the text, and only once: otherwise "inside the passage" would be ambiguous.
    const first = text.indexOf(excerpt.trim());
    if (first < 0) throw new UserError("The selected passage has changed. Select it again.");
    if (text.indexOf(excerpt.trim(), first + 1) >= 0) throw new UserError("That passage appears more than once. Select a little more of it, so it is unique.");
  }

  const single = setting<string>(piece, "outline.mode") === "off";
  // Wiring: section, outline, section research (with urls), core voice, format profile, voice memory, the points or brief.
  const context = await contextFor(piece,
    single ? ["brief", "piece_items", "core_voice", "format_profile", "voice_memory"]
      : ["outline", "section_items", "core_voice", "format_profile", "voice_memory"], section);
  const { guide } = await sectionGuide(piece, section);
  const scopeText = scope === "section"
    ? `section: the whole section may change.`
    : `${scope}: change only this passage.\n<passage>\n${excerpt.trim()}\n</passage>`;
  const user = `${context}\n\n${guide}\n\n<feedback>\n${feedback}\n</feedback>\n\n<scope>\n${scopeText}\n</scope>\n\n<text>\n${text}\n</text>`;
  const system = `${(await promptSet(piece.company_id))("revise", REVISE_SYSTEM)}\n\n${DRAFT_LINKS_NOTE}`;
  return task<{ reply: string; edits: { original: string; replacement: string; reason: string }[] }>(
    "section_revise", "write", piece, userId, system, user, reviseSchema, 3000,
    async (data, cost, model) => {
      // Keep only edits that can be applied cleanly: the passage is really there, once, and (for a part or a
      // selection) inside the passage the writer pointed at. Edits that overlap an earlier one are dropped.
      const found = data.edits.flatMap((e) => {
        const original = e.original;
        if (!original.trim() || original === e.replacement) return [];
        const at = text.indexOf(original);
        if (at < 0 || text.indexOf(original, at + 1) >= 0) return [];
        if (scope !== "section") {
          // For a part or a selection the edit must lie inside the passage the writer chose.
          const from = text.indexOf(excerpt.trim());
          if (from < 0 || at < from || at + original.length > from + excerpt.trim().length) return [];
        }
        return [{ at, end: at + original.length, original, replacement: e.replacement, reason: e.reason.trim() }];
      }).sort((a, b) => a.at - b.at);
      const edits: { original: string; replacement: string; reason: string }[] = [];
      let upTo = -1;
      for (const e of found) {
        if (e.at < upTo) continue;
        upTo = e.end;
        edits.push({ original: e.original, replacement: e.replacement, reason: e.reason });
      }
      await logEvent(piece, userId, "section_revision_proposed", { section: section.id, scope, edits: edits.length });
      return { reply: data.reply, edits: edits.slice(0, 10), cost_usd: cost, model };
    });
}

/** Records that the writer accepted AI-suggested revisions in a section. No model call, no cost. */
export async function logRevision(userId: string, body: Record<string, unknown>) {
  const { piece, section } = await sectionFor(userId, body);
  const edits = Math.max(0, Math.min(50, Number(body.edits) || 0));
  await logEvent(piece, userId, "section_revision_accepted", { section: section.id, edits });
  return { ok: true };
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
  // With only_missing, sections that already have sub-sections are left exactly as they are: they are shown for context
  // and only the ones without any are planned.
  const onlyMissing = body.only_missing === true;
  const planned = (s: { structure?: unknown }) => Array.isArray(s.structure) && s.structure.length > 0;
  const todo = onlyMissing ? secs.filter((s) => !planned(s)) : secs;
  if (!todo.length) throw new UserError("Every section already has sub-sections.");
  const outlineBlock = onlyMissing
    ? secs.map((s) => planned(s)
      ? `${outlineText([s], true)}\n   [already planned: leave as it is]`
      : `${outlineText([s], false)}\n   [PLAN THIS ONE]`).join("\n")
    : outlineText(secs, false);
  const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n<outline>\n${outlineBlock}\n</outline>`;
  const system = (await promptSet(piece.company_id))("structure", STRUCTURE_SYSTEM)
    + (onlyMissing ? "\n\nSOME SECTIONS ARE ALREADY PLANNED\nPlan only the sections marked [PLAN THIS ONE]. Sections marked [already planned] stay as they are: use them to avoid repeating the same shape, and return no entry for them." : "");
  return task<{ sections: { position: number; blocks: { type: string; note: string }[] }[] }>(
    "outline_structure", "reason", piece, userId, system, user, structureSchema, 2500,
    async (data, cost, model) => {
      const sections = todo.map((s) => ({
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
You improve an article outline so that it fixes the gaps a search (SEO) and answer-engine (GEO) review found. You make small changes to the plan. You never rewrite it and you never delete anything.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and the numbered expectations the piece owes.
- <search_landscape>: what ranking pages cover and skip, and what people ask.
- <gaps>: the review's "improve" items. Each has a check name, what the reviewer saw, and a suggested fix.
- <outline>: the current sections, numbered, each with its purpose, the contract expectations it serves, and its planned blocks (numbered within the section).

STEPS
1. Read each gap. Decide which section or sections it affects.
2. Address EVERY gap that a change to the outline or the working title can fix. Do not stop after a few. When a gap says "each section" or "every section", give each section that lacks the thing its own change.
3. For each gap, make the smallest change that fixes it, as one or more entries in "changes".
4. Leave every section and block that no gap needs exactly as it is.

CHANGES (use exactly these words for "kind"; sections and blocks are numbered as in <outline>)
- edit_title: change the working title. "heading" is the new title, written out in full. Use it for a title gap, keeping the topic and putting the primary keyword near the start; keep it within the length the gap names.
- edit_section: reword section "position". "heading" and "purpose" are the new text (leave one empty to keep it). "expectations" lists contract expectation numbers the section should ALSO serve.
- add_section: a new section, placed just after section "after" (0 = first), with "heading", "purpose", "expectations" and its "blocks".
- move_section: move section "position" to just after section "after" (0 = first).
- add_block: add the "blocks" to section "position". "index" is where the first one goes (1 = first), or 0 for the end.
- edit_block: change block number "index" of section "position" into the one block in "blocks".

EVERY CHANGE HAS ALL FIELDS
Use 0 for numbers, "" for text and [] for lists that a kind doesn't use. "check" is the check name of the gap the change fixes.

RULES
- Never delete a section, a block or a contract expectation. Reordering is allowed when a gap needs it, for example putting the direct answer first.
- At most 12 changes. A gap that neither the outline nor the title can fix gets none; say so in "reply".
- Headings stay specific to the sub-topic. Never "Introduction", "Overview" or "Conclusion".
- Never suggest keyword stuffing, repeating the keyword, or padding.
- A meta title or meta description gap is dealt with in "reply" as a suggestion; the outline has neither.
- Block types are: answer, paragraph, bullets, steps, table, example, data, subheading, faq, quote, takeaway. Each block has a one-line "note" saying what goes in it for this section.
- Do not invent facts, customers or figures.

OUTPUT
- reply: 1 to 3 sentences saying what you changed and which gaps it fixes, and what you could not fix in the outline.
- changes: the list of changes.`;

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

const OUTLINE_CHANGE_KINDS = ["edit_title", "edit_section", "add_section", "move_section", "add_block", "edit_block"] as const;
const fixOutlineSchema = obj({
  reply: str,
  changes: list(obj({
    kind: { type: "string", enum: [...OUTLINE_CHANGE_KINDS] },
    position: { type: "integer" },
    after: { type: "integer" },
    index: { type: "integer" },
    heading: str,
    purpose: str,
    expectations: list({ type: "integer" }),
    blocks: list(blockSchema),
    check: str,
  })),
});

type OutlineChange = {
  kind: string; position: number; after: number; index: number; heading: string; purpose: string;
  expectations: number[]; blocks: { type: string; note: string }[]; check: string;
};
type OutlineRow = {
  /** The section's number in the outline before any change; null for a section the changes add. */
  origin: number | null;
  heading: string;
  purpose: string;
  expectations: number[];
  blocks: { type: string; note: string }[];
  /** Set when these changes added or moved the section: the section it was put after (0 = first). Later ones placed after the same section keep their order. */
  placedAfter?: number;
};

/**
 * Applies the AI's small changes to the outline and returns the result. Nothing is ever removed: every section and
 * block the outline had is still there afterwards. A change that doesn't make sense (an unknown section, an empty
 * heading, a heading that already exists) is ignored, and at most 8 are applied.
 */
export function applyOutlineChanges(
  sections: { position: number; heading: string; purpose: string; expectations: number[]; blocks: { type: string; note: string }[] }[],
  expectationCount: number,
  changes: OutlineChange[],
  currentTitle = "",
): { rows: OutlineRow[]; title: string | null; summary: { edited: number; added: number; moved: number; blocks: number } } {
  const rows: OutlineRow[] = sections.map((s) => ({ origin: s.position, heading: s.heading, purpose: s.purpose, expectations: [...s.expectations], blocks: cleanBlocks(s.blocks) }));
  const byOrigin = (n: number) => rows.find((r) => r.origin === n);
  const goodNumbers = (nums: number[]) => nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= expectationCount);
  const headingTaken = (h: string) => rows.some((r) => r.heading.trim().toLowerCase() === h.trim().toLowerCase());
  const edited = new Set<OutlineRow>();
  const moved = new Set<OutlineRow>();
  let added = 0;
  let blocksAdded = 0;

  /** A place is "first" (0) or just after a section the outline had. Anything else is not a place. */
  const validAfter = (after: number) => after === 0 || (Number.isInteger(after) && byOrigin(after) !== undefined);
  const place = (row: OutlineRow, after: number) => {
    const old = rows.indexOf(row);
    if (old >= 0) rows.splice(old, 1);
    let at = 0;
    if (after > 0) at = rows.indexOf(byOrigin(after)!) + 1;
    // Sections already put after this same place stay ahead of this one.
    while (at < rows.length && rows[at].placedAfter === after) at++;
    row.placedAfter = after;
    rows.splice(at, 0, row);
  };

  let title: string | null = null;
  for (const c of changes.slice(0, 12)) {
    const row = byOrigin(c.position);
    if (c.kind === "edit_title") {
      // The working title: a new one, within a sensible length, that is actually different.
      const next = c.heading.trim().replace(/\s+/g, " ");
      if (next && next.length <= 120 && next !== currentTitle.trim()) title = next;
    } else if (c.kind === "edit_section" && row) {
      const heading = c.heading.trim();
      if (heading && heading !== row.heading && !headingTaken(heading)) { row.heading = heading; edited.add(row); }
      if (c.purpose.trim() && c.purpose.trim() !== row.purpose) { row.purpose = c.purpose.trim(); edited.add(row); }
      const more = goodNumbers(c.expectations).filter((n) => !row.expectations.includes(n));
      if (more.length) { row.expectations.push(...more); edited.add(row); }
    } else if (c.kind === "add_section") {
      const heading = c.heading.trim();
      if (!heading || headingTaken(heading) || !validAfter(c.after)) continue;
      const fresh: OutlineRow = { origin: null, heading, purpose: c.purpose.trim(), expectations: [...new Set(goodNumbers(c.expectations))], blocks: cleanBlocks(c.blocks) };
      place(fresh, c.after);
      added += 1;
    } else if (c.kind === "move_section" && row && c.after !== c.position && validAfter(c.after)) {
      place(row, c.after);
      moved.add(row);
    } else if (c.kind === "add_block" && row) {
      const fresh = cleanBlocks(c.blocks);
      // 8 is the most blocks a section keeps (cleanBlocks), so more would be cut on the next save.
      if (!fresh.length || row.blocks.length + fresh.length > 8) continue;
      if (c.index >= 1 && c.index <= row.blocks.length) row.blocks.splice(c.index - 1, 0, ...fresh);
      else row.blocks.push(...fresh);
      blocksAdded += fresh.length;
      edited.add(row);
    } else if (c.kind === "edit_block" && row) {
      const next = cleanBlocks(c.blocks)[0];
      if (!next || c.index < 1 || c.index > row.blocks.length) continue;
      row.blocks[c.index - 1] = next;
      edited.add(row);
    }
  }
  return { rows, title, summary: { edited: edited.size, added, moved: moved.size, blocks: blocksAdded } };
}
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
  // Issues the writer ignored are left alone.
  const gaps = (result?.checks ?? []).filter((c) => c.status === "improve" && c.fix && !(c as { ignored?: boolean }).ignored);
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
    const numbersOf = (s: { expectation_ids: unknown }) =>
      (s.expectation_ids as string[]).map((id) => expectations.findIndex((e) => e.id === id) + 1).filter((n) => n > 0);
    const blocksOf = (s: { structure?: unknown }) => (Array.isArray(s.structure) ? s.structure : []) as { type: string; note: string }[];
    // Blocks are numbered within their section so the AI can point at one.
    const outline = secs.map((s) =>
      `${s.position}. ${s.heading} (${s.purpose})${blocksOf(s).map((b, i) => `\n   ${i + 1}. ${b.type}: ${b.note}`).join("")}\n   serves expectations: ${numbersOf(s).join(", ") || "none"}`,
    ).join("\n");
    const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n${gapText}\n\n<outline>\n${outline}\n</outline>`;
    return task<{ reply: string; changes: OutlineChange[] }>(
      "seo_fix_outline", "reason", piece, userId, prompts("seo_fix.outline", SEO_FIX_OUTLINE), user, fixOutlineSchema, 3000,
      async (data, cost, model) => {
        // The AI proposes small changes; they are applied here, and nothing in the outline can be removed by them.
        const { rows, title, summary } = applyOutlineChanges(
          secs.map((s) => ({ position: s.position, heading: s.heading, purpose: s.purpose, expectations: numbersOf(s), blocks: blocksOf(s) })),
          expectations.length,
          data.changes,
          piece.title,
        );
        await logEvent(piece, userId, "seo_fix_outline_suggested", { gaps: gaps.length, ...summary, title: title !== null });
        return {
          reply: data.reply,
          summary,
          // A new working title, when the fix changes it. The screen applies it (and can undo it).
          ...(title !== null ? { title } : {}),
          sections: rows.map((r) => ({ heading: r.heading, purpose: r.purpose, expectations: r.expectations, blocks: r.blocks })),
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

// ---------------------------------------------------------------------------
// After a fix: only the flagged issues are checked again
// ---------------------------------------------------------------------------

export const SEO_VERIFY_SYSTEM = `ROLE
You check whether changes to an article outline fixed the issues a search (SEO) and answer-engine (GEO) review flagged. You do not look for new issues.

WHAT YOU RECEIVE
- <brief>, <reader_contract>: the subject, the primary keyword and the expectations the piece owes.
- <search_landscape>: what ranking pages cover and skip, and what people ask.
- <outline>: the outline as it is now, with each section's purpose and planned blocks.
- <issues_to_check>: the issues flagged earlier. Each has a check name, what the reviewer saw, and the suggested fix.

STEPS
For each issue, decide from the outline as it is now whether the issue is closed. Closed means the outline now does what the suggested fix asked, or something equivalent.

RULES
- Judge only the listed issues. Never add an issue and never raise anything else.
- Never suggest keyword density, repeating the keyword or padding.
- When unsure, answer "open": an issue is closed only when the outline clearly addresses it.
- "reason" is one short plain sentence for the writer, pointing at the part of the outline you looked at.
- Return one result for every issue, with its exact check name.

OUTPUT
- results: a list. Each has "check" (the check name), "closed" (true or false) and "reason".`;

const seoVerifySchema = obj({ results: list(obj({ check: str, closed: { type: "boolean" }, reason: str })) });

async function prepareSeoVerify(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await pieceFor(userId, body);
  requireStep(piece, on(piece, "outline.seo_geo_check"), "The outline SEO/GEO check");
  if (piece.stage !== "outline") throw new UserError("The outline can be checked while it is open.");
  const { data: saved } = await admin.from("pieces").select("seo_geo_outline").eq("id", piece.id).single();
  const result = saved?.seo_geo_outline as { checks: (Gap & { status: string })[] } | null;
  const flagged = (result?.checks ?? []).filter((c) => c.status === "improve" && !(c as { ignored?: boolean }).ignored);
  if (!flagged.length) throw new UserError("Nothing is flagged.");
  const { data: secs } = await admin.from("piece_sections").select("position, heading, purpose, structure").eq("piece_id", piece.id).order("position");
  if (!secs?.length) throw new UserError("Save an outline first.");
  const { data: serp } = await admin.from("research_items").select("statement").eq("piece_id", piece.id)
    .eq("source_type", "serp").eq("status", "approved");
  const landscape = (serp ?? []).map((r) => `- ${r.statement}`).join("\n") || "(none)";
  const context = await contextFor(piece, ["brief", "contract"]);
  const outline = secs.map((s) => {
    const blocks = (Array.isArray(s.structure) ? s.structure : []) as { type: string; note: string }[];
    return `${s.position}. ${s.heading} (${s.purpose})${blocks.map((b) => `\n   - ${b.type}: ${b.note}`).join("")}`;
  }).join("\n");
  const issues = flagged.map((g) => `- ${g.check} (${g.label}): saw: ${g.evidence || "n/a"} | suggested fix: ${g.fix}`).join("\n");
  const user = `${context}\n\n<search_landscape>\n${landscape}\n</search_landscape>\n\n<outline>\n${outline}\n</outline>\n\n<issues_to_check>\n${issues}\n</issues_to_check>`;
  const prompts = await promptSet(piece.company_id);
  return task<{ results: { check: string; closed: boolean; reason: string }[] }>(
    "seo_geo_verify", "reason", piece, userId, prompts("seo.verify", SEO_VERIFY_SYSTEM), user, seoVerifySchema, 1500,
    async (data, cost, model) => {
      const byCheck = new Map<string, { closed: boolean; reason: string }>();
      for (const r of data.results) {
        if (flagged.some((f) => f.check === r.check) && !byCheck.has(r.check)) byCheck.set(r.check, { closed: r.closed === true, reason: r.reason.trim() });
      }
      // Read the saved result again, then update only the flagged checks: closed ones become "fine", open ones keep the reason.
      const { data: fresh } = await admin.from("pieces").select("seo_geo_outline").eq("id", piece.id).single();
      const cur = fresh?.seo_geo_outline as ({ checks: (Gap & { status: string })[] } & Record<string, unknown>) | null;
      if (!cur) throw new UserError("The saved check is gone. Run it again.");
      const checks = cur.checks.map((c) => {
        const r = byCheck.get(c.check);
        if (!r || c.status !== "improve") return c;
        return r.closed ? { ...c, status: "fine", evidence: r.reason, fix: "" } : { ...c, evidence: r.reason };
      });
      const { error } = await admin.from("pieces").update({ seo_geo_outline: { ...cur, checks, verified_at: new Date().toISOString() } }).eq("id", piece.id);
      if (error) throw error;
      const closed = [...byCheck.values()].filter((r) => r.closed).length;
      await logEvent(piece, userId, "seo_geo_outline_verified", { closed, open: byCheck.size - closed });
      return { closed, open: byCheck.size - closed, cost_usd: cost, model };
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
  analysis_verify: prepareAnalysisVerify,
  seo_geo_verify: prepareSeoVerify,
  outline_suggest: prepareOutline,
  outline_build: prepareOutlineBuild,
  section_brief: prepareBrief,
  section_points: prepareSectionPoints,
  section_draft: prepareDraft,
  section_revise: prepareRevise,
  grammar_check: prepareGrammar,
  fact_check: prepareFacts,
  contract_check: prepareContractCheck,
  learn_voice: prepareLearn,
  seo_geo_check: prepareSeoGeo,
  outline_structure: prepareStructure,
  seo_fix: prepareSeoFix,
  repurpose_plan: prepareRepurpose,
};
