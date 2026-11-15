import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPiece, getSection, saveSectionDraft, WritError } from "./writ.js";

const PIECE = "22222222-2222-4222-8222-222222222222";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "11111111-1111-4111-8111-111111111112";
const S3 = "11111111-1111-4111-8111-111111111113";

const row = (id: string, position: number, heading: string, extra: Record<string, unknown> = {}) => ({
  id, piece_id: PIECE, position, heading, purpose: "", status: "writing", expectation_ids: [], content: "", ai_draft: null,
  points: null, brief: null, structure: null, ...extra,
});

/** A Supabase stand-in. With `old`, the sections table has no level or depth column, as on a Writ that predates sub-headings. */
function fake(opts: { old?: boolean } = {}) {
  const selects: string[] = [];
  const all = [
    row(S1, 1, "Executive summary", { level: 2, depth: "standard" }),
    row(S2, 2, "Emerging technologies", { level: 2, depth: "standard" }),
    row(S3, 3, "Quantum computing", { level: 3, depth: "deep" }),
  ].map((r) => (opts.old ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "level" && k !== "depth")) : r));
  const tables: Record<string, unknown> = {
    pieces: { id: PIECE, code: "SI-0001", title: "T", topic: "", primary_keyword: "", goal: "", audience_notes: "", stage: "writing",
      company_id: "c", format_id: null, outline_confirmed_at: "x", recipe: { writing: { ai_draft: true } }, updated_at: "" },
    piece_contracts: { core_question: "Q?", expectations: [], confirmed_at: null },
  };
  const db = {
    from(table: string) {
      let cols = "";
      const filters: Record<string, unknown> = {};
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "select") return (c: string) => { cols = c; if (table === "piece_sections") selects.push(c); return q; };
          if (prop === "eq") return (k: string, v: unknown) => { filters[k] = v; return q; };
          if (prop === "maybeSingle") return async () => ({ data: table === "piece_sections" ? all.find((r) => r.id === filters.id) ?? null : tables[table] ?? null, error: null });
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              if (table === "piece_sections" && opts.old && /\b(level|depth)\b/.test(cols)) {
                return resolve({ data: null, error: { message: "column piece_sections.level does not exist" } });
              }
              return resolve({ data: table === "piece_sections" ? all : [], error: null });
            };
          }
          return () => q;
        },
      });
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, selects };
}

describe("sub-headings in the read tools", () => {
  it("getPiece reports each section's level, depth and the main heading it sits under", async () => {
    const r = await getPiece(fake().db, "SI-0001");
    expect(r.sections.map((s) => [s.heading, s.level, s.depth, s.parent])).toEqual([
      ["Executive summary", 2, "standard", undefined],
      ["Emerging technologies", 2, "standard", undefined],
      ["Quantum computing", 3, "deep", "Emerging technologies"],
    ]);
  });

  it("still works against a Writ database that has no level or depth column", async () => {
    const { db, selects } = fake({ old: true });
    const r = await getPiece(db, "SI-0001");
    expect(r.sections.map((s) => [s.level, s.depth, s.parent])).toEqual([[2, "standard", undefined], [2, "standard", undefined], [2, "standard", undefined]]);
    expect(selects.length).toBe(2);
    expect(selects[0]).toMatch(/level/);
    expect(selects[1]).not.toMatch(/level/);
  });

  it("getSection adds level, depth and parent, and levels in the outline, without changing the other keys", async () => {
    const r = await getSection(fake().db, S3);
    expect(r.section).toMatchObject({ id: S3, position: 3, level: 3, depth: "deep", parent: "Emerging technologies", heading: "Quantum computing", status: "writing" });
    expect(r.outline).toEqual([
      { position: 1, level: 2, heading: "Executive summary", purpose: "" },
      { position: 2, level: 2, heading: "Emerging technologies", purpose: "" },
      { position: 3, level: 3, heading: "Quantum computing", purpose: "" },
    ]);
    expect(Object.keys(r)).toEqual(expect.arrayContaining(["piece", "reader_question", "outline", "section", "talking_points", "approved_research", "current_text", "existing_ai_draft", "ai_drafts_allowed"]));
  });

  it("getSection on an older database treats every section as a main heading", async () => {
    const r = await getSection(fake({ old: true }).db, S2);
    expect(r.section).toMatchObject({ level: 2, depth: "standard" });
    expect(r.outline.every((o) => o.level === 2)).toBe(true);
  });
});

describe("saveSectionDraft for a sub-heading", () => {
  it("refuses a heading of its own but takes #### inside", async () => {
    await expect(saveSectionDraft(fake().db, S3, "### Quantum\nText")).rejects.toThrow(WritError);
    await expect(saveSectionDraft(fake().db, S3, "### Quantum\nText")).rejects.toThrow(/####/);
    // A main heading keeps taking ### as before.
    const ok = await saveSectionDraft(fake().db, S2, "### Part\nText");
    expect(ok.saved).toBe(true);
  });
});
