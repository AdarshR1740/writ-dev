// Parsing and checking insight/data cards from imports and AI output.
// Accepts CSV with a header row, a JSON array of cards, {"cards": [...]},
// or one JSON array per line (a spreadsheet column exported as text).

import Papa from "papaparse";
import type { CardFields, CardType, Citation } from "./types";

export const CARD_TYPES: CardType[] = ["story", "opinion", "data_point", "technical_detail", "customer_quote", "lesson"];

export const CARD_COLUMNS = [
  "type", "claim", "detail", "source_who", "source_where", "source_date",
  "citation", "tags", "value", "unit", "period", "sample_size",
] as const;

export interface CheckedRow {
  row: number;
  card: CardFields | null;
  problems: string[];
}

const TYPE_ALIASES: Record<string, CardType> = {
  data: "data_point",
  datapoint: "data_point",
  "data point": "data_point",
  stat: "data_point",
  statistic: "data_point",
  quote: "customer_quote",
  "customer quote": "customer_quote",
  technical: "technical_detail",
  "technical detail": "technical_detail",
  view: "opinion",
  stance: "opinion",
  mistake: "lesson",
  anecdote: "story",
};

function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normaliseType(raw: string): CardType | null {
  const t = raw.toLowerCase().trim().replace(/-/g, "_");
  if ((CARD_TYPES as string[]).includes(t)) return t as CardType;
  return TYPE_ALIASES[t.replace(/_/g, " ")] ?? null;
}

function normaliseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(clean) : clean(raw).split(/[,;|]/);
  return [...new Set(list.map((t) => t.toLowerCase().replace(/^#/, "").trim()).filter(Boolean))].slice(0, 10);
}

/** Check one raw record and turn it into card fields. */
export function checkCard(raw: Record<string, unknown>, row: number, fallbackType?: CardType): CheckedRow {
  const problems: string[] = [];
  const type = normaliseType(clean(raw.type)) ?? fallbackType ?? null;
  if (!type) problems.push(raw.type ? `Unknown type "${clean(raw.type)}"` : "Missing type");

  const claim = clean(raw.claim);
  if (!claim) problems.push("Missing claim");
  else if (claim.length > 400) problems.push("Claim is longer than 400 characters");

  const citationRaw = clean(raw.citation).toLowerCase();
  let citation: Citation | null = null;
  if (citationRaw === "public" || citationRaw === "internal") citation = citationRaw;
  else problems.push(citationRaw ? `Citation must be public or internal, not "${citationRaw}"` : "Missing citation level");

  const value = clean(raw.value);
  if (type === "data_point" && !value) problems.push("A data point needs a value");

  if (problems.length || !type || !citation) return { row, card: null, problems };

  const optional = (k: string) => (type === "data_point" ? clean(raw[k]) || null : null);
  return {
    row,
    problems,
    card: {
      type,
      claim,
      detail: clean(raw.detail),
      source_who: clean(raw.source_who),
      source_where: clean(raw.source_where),
      source_date: clean(raw.source_date),
      citation,
      tags: normaliseTags(raw.tags),
      value: type === "data_point" ? value : null,
      unit: optional("unit"),
      period: optional("period"),
      sample_size: optional("sample_size"),
    },
  };
}

function parseJson(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim();
  const attempt = (s: string): Record<string, unknown>[] | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.cards)) return v.cards;
      if (v && typeof v === "object") return [v];
    } catch {
      /* not JSON */
    }
    return null;
  };
  const whole = attempt(trimmed);
  if (whole) return whole;
  // One JSON value per line (e.g. a spreadsheet column).
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !/^[[{"]/.test(lines[0])) return null;
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    // CSV-quoted JSON from a spreadsheet: "[{""type"": ...}]"
    const unquoted = line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1).replace(/""/g, '"') : line;
    const parsed = attempt(unquoted);
    if (!parsed) return null;
    out.push(...parsed);
  }
  return out;
}

/** Parse pasted or uploaded text into checked rows. */
export function parseCards(text: string, fallbackType?: CardType): { rows: CheckedRow[]; format: "json" | "csv" } {
  const json = parseJson(text);
  if (json) {
    return { format: "json", rows: json.map((r, i) => checkCard(r ?? {}, i + 1, fallbackType)) };
  }
  const parsed = Papa.parse<Record<string, unknown>>(text.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
  return { format: "csv", rows: parsed.data.map((r, i) => checkCard(r, i + 2, fallbackType)) };
}

export function cardsToCsv(cards: CardFields[]): string {
  return Papa.unparse(
    cards.map((c) => ({ ...c, tags: c.tags.join(", ") })),
    { columns: [...CARD_COLUMNS] },
  );
}
