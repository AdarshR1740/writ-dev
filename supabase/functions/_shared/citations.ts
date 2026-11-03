// Turn Claude's cited answer into research items. Every statement comes with
// the exact passage the API says supports it (cited_text), never a quote the
// model wrote itself.

export const SOURCE_TYPES = ["original_research", "official", "practitioner", "critical", "data", "serp", "web"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface Finding {
  statement: string;
  quote: string;
  url: string | null;
  title: string;
  sourceType: SourceType;
  secondary: boolean;
  /** cited: from the provider's citation API; verified/unverified: we checked the quote against the source. */
  quoteStatus: "cited" | "verified" | "unverified";
}

const TAGS = `Start the paragraph with one tag for the kind of source: [original_research], [official],
[practitioner], [critical], [data], [serp] (what ranking pages cover or skip, questions people ask,
search intent) or [web]. Add [secondary] right after it when the page reports a figure or claim from
somewhere else. One fact per paragraph, plain and specific, with the date when the source gives one.`;

export const FINDING_FORMAT = `Write each finding as its own paragraph, separated by a blank line. ${TAGS}
Every finding must be supported by a citation. No introduction, headings or summary.`;

/** For providers without a citation API: the model quotes, we verify. */
export const QUOTED_FORMAT = `Write each finding as its own block, separated by a blank line, in exactly this
shape:

[tag] The finding in one plain sentence.
URL: the exact page address you read it on
QUOTE: "a short passage copied word for word from that page that supports the finding"

${TAGS} The quote must be copied exactly, not paraphrased: it is checked against the page, and
findings whose quote can't be found are flagged to the reviewer. No introduction, headings or summary.`;

/** Parse QUOTED_FORMAT blocks. Quotes start unverified; the caller checks them. */
export function parseQuotedFindings(text: string): Finding[] {
  const out: Finding[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const url = block.match(/^\s*URL:\s*(\S+)/mi)?.[1]?.replace(/[)>.,]+$/, "") ?? null;
    const quote = block.match(/^\s*QUOTE:\s*["\u201c]?([\s\S]*?)["\u201d]?\s*$/mi)?.[1]?.trim() ?? "";
    let statement = block.replace(/^\s*(URL|QUOTE):.*$/gmi, "").trim().replace(/^[-*•]\s*/, "");
    let sourceType: SourceType = "web";
    let secondary = false;
    for (;;) {
      const m = statement.match(/^\[([a-z_]+)\]\s*/i);
      if (!m) break;
      const tag = m[1].toLowerCase();
      if ((SOURCE_TYPES as readonly string[]).includes(tag)) sourceType = tag as SourceType;
      if (tag === "secondary") secondary = true;
      statement = statement.slice(m[0].length);
    }
    statement = statement.replace(/\s+/g, " ").trim();
    if (statement.length < 15 || !url || !/^https?:\/\//.test(url)) continue;
    out.push({ statement: statement.slice(0, 1200), quote: quote.slice(0, 2000), url, title: url, sourceType, secondary, quoteStatus: "unverified" });
  }
  return out;
}

interface LooseCitation {
  type: string;
  cited_text?: string;
  url?: string;
  title?: string | null;
  document_title?: string | null;
}
interface LooseBlock {
  type: string;
  text?: string;
  citations?: LooseCitation[] | null;
}

/** Parse text blocks with citations into findings, one per cited paragraph. */
export function parseFindings(blocks: LooseBlock[], fallback?: { url: string | null; title: string }): Finding[] {
  const paragraphs: { text: string; citations: LooseCitation[] }[] = [{ text: "", citations: [] }];
  for (const b of blocks) {
    if (b.type !== "text" || !b.text) continue;
    const parts = b.text.split(/\n\s*\n/);
    parts.forEach((part, i) => {
      if (i > 0) paragraphs.push({ text: "", citations: [] });
      paragraphs[paragraphs.length - 1].text += part;
    });
    if (b.citations?.length) paragraphs[paragraphs.length - 1].citations.push(...b.citations);
  }

  const out: Finding[] = [];
  for (const p of paragraphs) {
    const cites = p.citations.filter((c) => c.cited_text && c.cited_text.trim());
    if (!cites.length) continue;
    let text = p.text.trim().replace(/^[-*•]\s*/, "");
    let sourceType: SourceType = "web";
    let secondary = false;
    for (;;) {
      const m = text.match(/^\[([a-z_]+)\]\s*/i);
      if (!m) break;
      const tag = m[1].toLowerCase();
      if ((SOURCE_TYPES as readonly string[]).includes(tag)) sourceType = tag as SourceType;
      if (tag === "secondary") secondary = true;
      text = text.slice(m[0].length);
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length < 15) continue;
    const first = cites[0];
    const url = first.url ?? fallback?.url ?? null;
    const sameSource = cites.filter((c) => (c.url ?? null) === (first.url ?? null));
    out.push({
      statement: text.slice(0, 1200),
      quote: [...new Set(sameSource.map((c) => c.cited_text!.trim()))].join(" … ").slice(0, 2000),
      url,
      title: first.title ?? first.document_title ?? fallback?.title ?? url ?? "",
      sourceType,
      secondary,
      quoteStatus: "cited",
    });
  }
  return out;
}

/** Publication hints from web search results (page_age), keyed by URL. */
export function pageAges(blocks: { type: string; content?: unknown }[]): Map<string, string> {
  const ages = new Map<string, string>();
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content as { url?: string; page_age?: string | null }[]) {
      if (r.url && r.page_age) ages.set(r.url, r.page_age);
    }
  }
  return ages;
}
