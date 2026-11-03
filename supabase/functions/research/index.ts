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
  FINDING_FORMAT,
  type Finding,
  pageAges,
  parseFindings,
  parseQuotedFindings,
  QUOTED_FORMAT,
  SOURCE_TYPES,
} from "../_shared/citations.ts";

const DEFAULT_MAX_SEARCHES = 6;
const MAX_SOURCE_CHARS = 300_000;

const SEARCH_BASE = `You research a piece of B2B content for a company's writers. You find facts;
you don't write the piece.

Search widely, not just the first page of results. Deliberately look for each kind of source:
- original research and reports (studies, surveys, benchmarks)
- official sources (documentation, filings, standards, government data)
- practitioners (case studies, engineering blogs, conference talks)
- critical or contrary views (limitations, failures, criticism)
- raw data

{SERP}The reader contract shows what the piece must deliver; use it to decide what to look for, but report
anything important you find outside it too. Prefer the original source over pages that repeat it.
Report 8 to 15 findings.`;

const SERP = `For piece-level research, also read the search landscape for the primary keyword: what intent the
ranking pages serve, what they all cover, what they skip or get wrong, and which questions people ask
about it. Report those as [serp] findings; they inform the piece, they're not a template to copy.

`;

/** The search prompt for this piece's recipe (search landscape only when switched on). */
function searchSystem(withSerp: boolean, quoted: boolean): string {
  const base = SEARCH_BASE.replace("{SERP}", withSerp ? SERP : "");
  return `${base}\n\n${quoted ? QUOTED_FORMAT : FINDING_FORMAT}`;
}

const EXTRACT_BASE = `You pull research findings out of one source for a piece of B2B content. Report
only what this source actually says that matters for the piece: facts, figures, examples, named
companies, dates, and claims worth checking. Skip filler and anything unrelated. Report at most 12
findings.`;

const EXTRACT_SYSTEM = `${EXTRACT_BASE}\n\n${FINDING_FORMAT}`;

// For providers without document citations: structured findings with a
// verbatim quote, checked against the source text by the server.
const EXTRACT_SYSTEM_QUOTED = `${EXTRACT_BASE}

For each finding give: the kind of source (original_research, official, practitioner, critical, data,
serp or web), whether it is secondary (the source reports someone else's figure or claim), the
finding in one plain sentence, and a short passage copied word for word from the source that
supports it. Quotes are checked against the source; never paraphrase them.`;

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
  opts: { origin: "search" | "url" | "paste"; sourceId?: string; ages?: Map<string, string>; section?: SectionRow | null },
): Promise<number> {
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
  const { error } = await admin.from("research_items").insert(findings.map((f) => ({
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
  })));
  if (error) throw error;
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
  await requireRole(user.id, piece.company_id, "member");
  if (section) {
    if (section.status !== "research") throw new UserError("This section's research is already finished.");
    const { data: p } = await admin.from("pieces").select("section_timing").eq("id", piece.id).single();
    if (p?.section_timing === "just_in_time") {
      const { data: earlier } = await admin.from("piece_sections").select("id").eq("piece_id", piece.id)
        .lt("position", section.position).neq("status", "written");
      if (earlier?.length) throw new UserError("Write the earlier sections first (this piece researches one section at a time).");
    }
  } else if (piece.stage !== "research") {
    throw new UserError("Piece-level research is finished.");
  }
  const { data: contract } = await admin.from("piece_contracts").select("confirmed_at").eq("piece_id", piece.id)
    .single();
  if (!contract?.confirmed_at) throw new UserError("Confirm the reader contract before researching.");
  const conn = await connect(piece.company_id, "research");
  const estimate = body.mode === "estimate";

  const maxSearches = Math.min(10, Math.max(1, Number(setting<number>(piece, "research.max_searches")) || DEFAULT_MAX_SEARCHES));
  const withSerp = !section && on(piece, "research.serp");

  if (body.action === "search") {
    requireStep(piece, on(piece, "research.web_search") && (section ? on(piece, "sections.research") : on(piece, "research.enabled")),
      "Web search");
    // Wiring: research gets the brief, the contract and the ICP. Never voice or memory.
    const context = section
      ? await contextFor(piece, ["brief", "contract", "outline"], section)
      : await contextFor(piece, ["brief", "contract", "icp"]);
    const prompt = section
      ? `${context}\n\nResearch this one section in depth: specifics, named examples, numbers, and limits. The piece-level research is already done; go deeper, not wider.`
      : `${context}\n\nResearch this piece.`;
    if (estimate) {
      if (conn.provider !== "anthropic" && conn.provider !== "openai") {
        throw new UserError("Web search needs an Anthropic or OpenAI key. With this provider, add sources yourself by URL or paste.");
      }
      const input = estimateTokens(searchSystem(withSerp, false).length + prompt.length) + maxSearches * 3000;
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
        system: searchSystem(withSerp, false),
        content: [{ type: "text", text: prompt }],
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches } as Anthropic.Beta.BetaToolUnion],
        effort: "medium",
      });
      const findings = parseFindings(r.content as never);
      const added = await storeFindings(piece, user.id, findings, { origin: "search", ages: pageAges(r.content as never), section });
      const cost = await recordUsage(piece, user.id, "research_search", conn.model, conn.provider, r);
      await logEvent(piece, user.id, "research_searched", { items: added, searches: r.searches });
      return json({ added, searches: r.searches, cost_usd: cost, model: conn.model });
    }
    if (conn.provider === "openai") {
      const r = await callOpenAISearch(conn, searchSystem(withSerp, true), prompt, maxSearches);
      const findings = parseQuotedFindings(r.text);
      const pages = await verifyQuotes(findings);
      const ages = new Map([...pages].filter(([, p]) => p.published).map(([u, p]) => [u, p.published]));
      const added = await storeFindings(piece, user.id, findings, { origin: "search", ages, section });
      const cost = await recordUsage(piece, user.id, "research_search", conn.model, conn.provider, r);
      const unverified = findings.filter((f) => f.quoteStatus === "unverified").length;
      await logEvent(piece, user.id, "research_searched", { items: added, searches: r.searches, unverified });
      return json({ added, unverified, searches: r.searches, cost_usd: cost, model: conn.model });
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
      const input = estimateTokens(EXTRACT_SYSTEM.length + prompt.length + text.length);
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
        system: EXTRACT_SYSTEM,
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
        system: EXTRACT_SYSTEM_QUOTED,
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
