// Piece-level research. Every item it creates carries the exact passage its
// source supports; the writer approves or rejects each one before outlining.
//
//   search          web search across source types, informed by the contract
//   extract_source  pull findings from a source the writer adds (URL, paste
//                   or library), using document citations
//
// Both accept mode: "estimate" for a cost check without a model call.
//
// Anthropic returns the exact cited passage through its citation API. OpenAI
// (web search) and other providers (sources you add) quote the passage
// themselves; the server then checks every quote against the actual source
// text and marks it verified or unverified before review.

import type Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { handle, json, UserError } from "../_shared/cors.ts";
import { admin, requireRole, requireUser } from "../_shared/supabase.ts";
import { budgetForEstimate, callAnthropicCited, callOpenAISearch, connect, recordUsage as recordModelUsage, runModel } from "../_shared/llm.ts";
import { fetchPage, quoteFound } from "../_shared/web.ts";
import { costUsd, estimateTokens, SEARCH_COST_USD } from "../_shared/models.ts";
import { contextFor, loadPiece, loadSection, logEvent, on, type Piece, requireStep, type SectionRow, setting } from "../_shared/context.ts";
import {
  type Finding,
  pageAges,
  parseFindings,
  parseQuotedFindings,
  SOURCE_TYPES,
} from "../_shared/citations.ts";
import { EXTRACT_QUOTED, extractSystem, searchSystem } from "../_shared/research-prompts.ts";
import { promptSet } from "../_shared/prompt-overrides.ts";

const DEFAULT_MAX_SEARCHES = 6;
const MAX_SOURCE_CHARS = 300_000;

/** The user message for a search: states the subject outright so a small model can't drift off it. */
function searchRequest(piece: Piece, context: string, section: SectionRow | null, focus = "", auto = false): string {
  const subject = piece.topic?.trim() || piece.title;
  const keyword = piece.primary_keyword ? ` (primary keyword: "${piece.primary_keyword}")` : "";
  if (auto && section) {
    // Preparing a section for the writer: material that makes the section a strong source, drawn from its sub-sections.
    return `${context}

TASK
Prepare one section of the piece "${piece.title}" (subject: "${subject}"${keyword}) for the writer.
Section: "${section.heading}"${section.purpose ? `, which should cover: ${section.purpose}` : ""}.
Find published material that makes this section a strong source to write from: facts and figures, named examples, expert or practitioner views, and anything that backs the planned sub-sections. Skip what the approved research already says. Every search must be about "${subject}" and this section.
Return at most 6 findings, one per source, best first. Weigh each source: prefer pages that answer the section directly and are credible and current. Fewer than 6 is fine; never pad the list.`;
  }
  if (focus) {
    // A gap the alignment check found: material the approved research doesn't have. Search for that and nothing else.
    return `${context}

TASK
The piece "${piece.title}" (subject: "${subject}"${keyword}) has been researched, but the approved research is missing this:
"${focus}"
Search only for published material that fills that gap. Every search must be about "${subject}" and that gap. Skip anything the approved research already says.
Return at most 3 findings, one per source, with the one that fills the gap best first. Weigh each source: prefer material that answers the gap directly and comes from a credible, current page. Fewer than 3 is fine; never pad the list.`;
  }
  if (section) {
    return `${context}

TASK
Research one section of the piece "${piece.title}". Subject of the piece: "${subject}"${keyword}.
Section: "${section.heading}"${section.purpose ? `, which should cover: ${section.purpose}` : ""}.
The piece-level research is already done, so go deeper, not wider: specifics, named examples, numbers
and limits for this section. Every search must be about "${subject}" and this section.`;
  }
  return `${context}

TASK
Research the piece "${piece.title}". Subject: "${subject}"${keyword}.
Follow the steps in your instructions. Every search must be about "${subject}".`;
}

const str = { type: "string" };
const extractQuotedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_type", "secondary", "statement", "quote"],
        properties: {
          source_type: { type: "string", enum: [...SOURCE_TYPES] },
          secondary: { type: "boolean" },
          statement: str,
          quote: str,
        },
      },
    },
  },
};

/** Fetch each cited page once and check every quote against it. */
async function verifyQuotes(findings: Finding[]): Promise<Map<string, { title: string; published: string }>> {
  const urls = [...new Set(findings.map((f) => f.url).filter((u): u is string => Boolean(u)))].slice(0, 12);
  const pages = new Map<string, { title: string; published: string; text: string }>();
  await Promise.all(urls.map(async (u) => {
    try {
      const page = await fetchPage(u);
      if (page.ok) pages.set(u, page);
    } catch {
      // Unreachable or private addresses stay unverified.
    }
  }));
  for (const f of findings) {
    const page = f.url ? pages.get(f.url) : undefined;
    f.quoteStatus = page && f.quote && quoteFound(f.quote, page.text) ? "verified" : "unverified";
    if (page?.title) f.title = page.title;
  }
  return new Map([...pages].map(([u, p]) => [u, { title: p.title, published: p.published }]));
}

async function storeFindings(
  piece: Piece,
  userId: string,
  findings: Finding[],
  opts: {
    origin: "search" | "url" | "paste";
    sourceId?: string;
    ages?: Map<string, string>;
    section?: SectionRow | null;
    /** Keep only the first N findings (the model lists the best first). */
    limit?: number;
    /** Store the items as already approved, for a gap search whose results are not reviewed one by one. */
    approved?: boolean;
    /** Filled with the ids of the items created, so the caller can report them. */
    collectIds?: string[];
  },
): Promise<number> {
  if (opts.limit) findings = findings.slice(0, opts.limit);
  if (!findings.length) return 0;
  const sourceIds = new Map<string, string>();
  if (opts.sourceId) {
    for (const f of findings) sourceIds.set(f.url ?? "", opts.sourceId);
  } else {
    for (const f of findings) {
      if (!f.url || sourceIds.has(f.url)) continue;
      const { data: existing } = await admin.from("sources").select("id").eq("company_id", piece.company_id)
        .eq("url", f.url).maybeSingle();
      if (existing) {
        sourceIds.set(f.url, existing.id);
        continue;
      }
      const { data, error } = await admin.from("sources").insert({
        company_id: piece.company_id,
        url: f.url,
        title: f.title,
        published: opts.ages?.get(f.url) ?? "",
        origin: opts.origin,
        created_by: userId,
      }).select("id").single();
      if (error) throw error;
      sourceIds.set(f.url, data.id);
    }
  }
  const { data: inserted, error } = await admin.from("research_items").insert(findings.map((f) => ({
    company_id: piece.company_id,
    piece_id: piece.id,
    scope: opts.section ? "section" : "piece",
    section_key: opts.section ? opts.section.id : null,
    source_id: sourceIds.get(f.url ?? "") ?? null,
    statement: f.statement,
    quote: f.quote,
    source_type: f.sourceType,
    secondary: f.secondary,
    quote_status: f.quoteStatus,
    ...(opts.approved ? { status: "approved", reviewed_by: userId, reviewed_at: new Date().toISOString() } : {}),
  }))).select("id");
  if (error) throw error;
  opts.collectIds?.push(...(inserted ?? []).map((r) => r.id as string));
  return findings.length;
}

async function recordUsage(piece: Piece, userId: string, task: string, model: string, provider: string, r: {
  inputTokens: number;
  outputTokens: number;
  searches: number;
}): Promise<number | null> {
  const tokenCost = costUsd(model, r.inputTokens, r.outputTokens);
  // Search pricing is known for Anthropic only; other providers record tokens alone.
  const cost = tokenCost === null ? null : provider === "anthropic" ? tokenCost + r.searches * SEARCH_COST_USD : tokenCost;
  const { error } = await admin.from("usage_events").insert({
    company_id: piece.company_id,
    piece_id: piece.id,
    user_id: userId,
    task,
    task_type: "research",
    provider,
    model,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cost_usd: cost,
  });
  if (error) console.error("usage insert failed", error);
  return cost;
}

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Library: keep a source with its saved text so later pieces can use it even
  // if the page changes. Search results have no text yet, so fetch it now.
  if (body.action === "library") {
    const { data: src } = await admin.from("sources").select("id, company_id, url, snapshot").eq("id", String(body.source_id ?? ""))
      .maybeSingle();
    if (!src) throw new UserError("Source not found.", 404);
    await requireRole(user.id, src.company_id, "member");
    if (body.in_library === false) {
      await admin.from("sources").update({ in_library: false }).eq("id", src.id);
      return json({ ok: true, in_library: false });
    }
    let saved = Boolean(src.snapshot);
    if (!saved && src.url) {
      try {
        const page = await fetchPage(src.url);
        if (page.ok) {
          await admin.from("sources").update({ snapshot: page.text, published: page.published || undefined, last_checked: new Date().toISOString() })
            .eq("id", src.id);
          saved = true;
        }
      } catch {
        // Saved without text; the writer is told to paste it when they use it.
      }
    }
    await admin.from("sources").update({ in_library: true }).eq("id", src.id);
    return json({ ok: true, in_library: true, saved_text: saved });
  }

  const section = body.section_id ? await loadSection(String(body.section_id)) : null;
  const piece = await loadPiece(section ? section.piece_id : String(body.piece_id ?? ""));
  // Set only for a search about one gap (piece level, search action).
  const focus = !section && body.action === "search" ? String(body.focus ?? "").trim().slice(0, 600) : "";
  // A section search run by the Writing step's prepare run: fewer, better sources, stored as approved.
  const auto = Boolean(section) && body.action === "search" && body.auto === true;
  await requireRole(user.id, piece.company_id, "member");
  if (section && auto) {
    // Preparing a section automatically (the Writing step's "prepare" run): any section not written yet, in any order.
    if (section.status !== "research" && section.status !== "brief") throw new UserError("This section is already being written.");
  } else if (section) {
    if (section.status !== "research") throw new UserError("This section's research is already finished.");
    const { data: p } = await admin.from("pieces").select("section_timing").eq("id", piece.id).single();
    if (p?.section_timing === "just_in_time") {
      const { data: earlier } = await admin.from("piece_sections").select("id").eq("piece_id", piece.id)
        .lt("position", section.position).neq("status", "written");
      if (earlier?.length) throw new UserError("Write the earlier sections first (this piece researches one section at a time).");
    }
  } else if (piece.stage !== "research" && !(focus && piece.stage === "outline")) {
    // A search aimed at a gap from the alignment check is also allowed at the outline step, before it is confirmed.
    throw new UserError("Piece-level research is finished.");
  }
  const { data: contract } = await admin.from("piece_contracts").select("confirmed_at").eq("piece_id", piece.id)
    .single();
  if (!contract?.confirmed_at) throw new UserError("Confirm the reader contract before researching.");
  if (auto && section) {
    // A retry after the points step failed must not search (and pay) again: the section already has its sources.
    const { count } = await admin.from("research_items").select("id", { count: "exact", head: true })
      .eq("piece_id", piece.id).eq("scope", "section").eq("section_key", section.id).eq("status", "approved");
    if ((count ?? 0) > 0) return json({ added: 0, item_ids: [], skipped: true });
  }
  const conn = await connect(piece.company_id, "research");
  const prompts = await promptSet(piece.company_id);
  const estimate = body.mode === "estimate";

  // A search for one gap is narrower than the piece's research, so it uses fewer searches.
  const maxSearches = Math.min(focus ? 3 : auto ? 4 : 10, Math.max(1, Number(setting<number>(piece, "research.max_searches")) || DEFAULT_MAX_SEARCHES));
  // Searches that keep only a few best sources and approve them on the spot (a gap, or a section being prepared).
  const quick = Boolean(focus) || auto;
  const quickLimit = focus ? 3 : 6;
  const withSerp = !section && on(piece, "research.serp");

  if (body.action === "search") {
    requireStep(piece, on(piece, "research.web_search") && (section ? on(piece, "sections.research") : on(piece, "research.enabled")),
      "Web search");
    // Wiring: research gets the brief, the contract and the ICP. Never voice or memory.
    const context = section
      ? await contextFor(piece, ["brief", "contract", "outline"], section)
      : await contextFor(piece, ["brief", "contract", "icp"]);
    // A gap search also sees what is already approved, so it doesn't repeat it.
    const prompt = searchRequest(piece, quick ? `${context}\n\n${await contextFor(piece, ["piece_items_plain"])}` : context, section, focus, auto);
    if (estimate) {
      if (conn.provider !== "anthropic" && conn.provider !== "openai") {
        throw new UserError("Web search needs an Anthropic or OpenAI key. With this provider, add sources yourself by URL or paste.");
      }
      const input = estimateTokens(searchSystem(withSerp, false, maxSearches, prompts).length + prompt.length) + maxSearches * 3000;
      const tokens = costUsd(conn.model, input, 4000);
      // OpenAI's per-search price isn't included; its estimate covers tokens only.
      const cost = tokens === null ? null : tokens + (conn.provider === "anthropic" ? maxSearches * SEARCH_COST_USD : 0);
      return json({
        model: conn.model,
        input_tokens: input,
        output_tokens: 4000,
        cost_usd: cost,
        ...(await budgetForEstimate(piece.company_id, cost)),
      });
    }
    if (conn.provider === "anthropic") {
      const r = await callAnthropicCited(conn, {
        system: searchSystem(withSerp, false, maxSearches, prompts),
        content: [{ type: "text", text: prompt }],
        // Basic search, called directly: the 20260209 version defaults to calling search from code
        // execution, which models without programmatic tool calling (such as Haiku) reject with a 400.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches } as Anthropic.Beta.BetaToolUnion],
        effort: "medium",
      });
      const findings = parseFindings(r.content as never);
      const itemIds: string[] = [];
      const added = await storeFindings(piece, user.id, findings, {
        origin: "search", ages: pageAges(r.content as never), section, collectIds: itemIds,
        ...(quick ? { limit: quickLimit, approved: true } : {}),
      });
      const cost = await recordUsage(piece, user.id, "research_search", conn.model, conn.provider, r);
      await logEvent(piece, user.id, "research_searched", { items: added, searches: r.searches });
      return json({ added, item_ids: itemIds, searches: r.searches, cost_usd: cost, model: conn.model });
    }
    if (conn.provider === "openai") {
      const r = await callOpenAISearch(conn, searchSystem(withSerp, true, maxSearches, prompts), prompt, maxSearches);
      const parsed = parseQuotedFindings(r.text);
      const pages = await verifyQuotes(parsed);
      const ages = new Map([...pages].filter(([, p]) => p.published).map(([u, p]) => [u, p.published]));
      // A gap search keeps the best three, and with no one reviewing them, only ones whose quote was found on the page.
      const findings = quick ? parsed.filter((f) => f.quoteStatus !== "unverified") : parsed;
      const itemIds: string[] = [];
      const added = await storeFindings(piece, user.id, findings, { origin: "search", ages, section, collectIds: itemIds, ...(quick ? { limit: quickLimit, approved: true } : {}) });
      const cost = await recordUsage(piece, user.id, "research_search", conn.model, conn.provider, r);
      const unverified = findings.filter((f) => f.quoteStatus === "unverified").length;
      await logEvent(piece, user.id, "research_searched", { items: added, searches: r.searches, unverified });
      return json({ added, item_ids: itemIds, unverified, searches: r.searches, cost_usd: cost, model: conn.model });
    }
    throw new UserError(
      "Web search needs an Anthropic or OpenAI key. With this provider, add sources yourself by URL or paste; their quotes are still checked.",
    );
  }

  if (body.action === "extract_source") {
    requireStep(piece, body.source_id ? on(piece, "research.library") : on(piece, "research.manual"),
      body.source_id ? "The source library" : "Adding your own sources");
    // Either an existing (library) source, or new material from a URL fetch or paste.
    let sourceId = body.source_id ? String(body.source_id) : null;
    let title = String(body.title ?? "").trim();
    let text = String(body.text ?? "").trim();
    let url = body.url ? String(body.url) : null;
    if (sourceId) {
      const { data: src } = await admin.from("sources").select("*").eq("id", sourceId).eq("company_id", piece.company_id)
        .maybeSingle();
      if (!src) throw new UserError("Source not found.", 404);
      if (!src.snapshot) throw new UserError("This source has no saved text. Add it again by URL or paste.");
      title = src.title;
      text = src.snapshot;
      url = src.url;
    }
    if (text.length < 200) throw new UserError("That source is too short to extract from.");
    if (text.length > MAX_SOURCE_CHARS) throw new UserError("That source is too long. Paste the relevant part.");

    const context = await contextFor(piece, ["brief", "contract"], section ?? undefined);
    const prompt = `${context}\n\nPull the findings that matter for ${section ? "this section" : "this piece"} from the attached source.`;
    if (estimate) {
      const input = estimateTokens(extractSystem(prompts).length + prompt.length + text.length);
      const cost = costUsd(conn.model, input, 2500);
      return json({ model: conn.model, input_tokens: input, output_tokens: 2500, cost_usd: cost, ...(await budgetForEstimate(piece.company_id, cost)) });
    }

    if (!sourceId) {
      const origin = body.origin === "url" ? "url" : "paste";
      const existing = url
        ? (await admin.from("sources").select("id").eq("company_id", piece.company_id).eq("url", url).maybeSingle()).data
        : null;
      if (existing) {
        sourceId = existing.id;
        await admin.from("sources").update({ snapshot: text, title: title || url, last_checked: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        const { data, error } = await admin.from("sources").insert({
          company_id: piece.company_id,
          url,
          title: title || url || "Pasted source",
          published: String(body.published ?? ""),
          snapshot: text,
          origin,
          created_by: user.id,
        }).select("id").single();
        if (error) throw error;
        sourceId = data.id;
      }
    }

    if (conn.provider === "anthropic") {
      const r = await callAnthropicCited(conn, {
        system: extractSystem(prompts),
        content: [
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: text },
            title: title || url || "Source",
            citations: { enabled: true },
          },
          { type: "text", text: prompt },
        ],
        effort: "low",
      });
      const findings = parseFindings(r.content as never, { url, title: title || url || "Source" });
      const added = await storeFindings(piece, user.id, findings, { origin: "paste", sourceId: sourceId!, section });
      const cost = await recordUsage(piece, user.id, "research_extract", conn.model, conn.provider, r);
      await logEvent(piece, user.id, "source_added", { source: sourceId, items: added });
      return json({ added, source_id: sourceId, cost_usd: cost, model: conn.model });
    }

    // Other providers: structured findings, every quote checked against the source text.
    const r = await runModel<{ findings: { source_type: string; secondary: boolean; statement: string; quote: string }[] }>(
      piece.company_id,
      {
        taskType: "research",
        system: prompts("research.extract_quoted", EXTRACT_QUOTED),
        user: `<source title="${(title || url || "Source").replace(/"/g, "'")}">\n${text}\n</source>\n\n${prompt}`,
        schema: extractQuotedSchema,
        schemaName: "source_findings",
        maxTokens: 8000,
      },
    );
    await recordModelUsage(piece.company_id, user.id, "research_extract", "research", r, piece.id);
    const findings: Finding[] = r.data.findings
      .filter((f) => f.statement.trim().length >= 15)
      .map((f) => ({
        statement: f.statement.trim().slice(0, 1200),
        quote: f.quote.trim().slice(0, 2000),
        url,
        title: title || url || "Source",
        sourceType: (SOURCE_TYPES as readonly string[]).includes(f.source_type) ? f.source_type as Finding["sourceType"] : "web",
        secondary: f.secondary,
        quoteStatus: quoteFound(f.quote, text) ? "verified" : "unverified",
      }));
    const added = await storeFindings(piece, user.id, findings, { origin: "paste", sourceId: sourceId!, section });
    const unverified = findings.filter((f) => f.quoteStatus === "unverified").length;
    await logEvent(piece, user.id, "source_added", { source: sourceId, items: added, unverified });
    return json({ added, unverified, source_id: sourceId, cost_usd: r.costUsd, model: r.model });
  }

  throw new UserError("Unknown action.");
}));
