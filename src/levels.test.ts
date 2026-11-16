import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPiece, getPiece, getSection, saveOutline, saveSectionDraft, WritError } from "./writ.js";

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

/** A stand-in that records save_outline calls. */
function outlineDb(existing: unknown[] = []) {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const tables: Record<string, unknown> = {
    pieces: { id: PIECE, code: "SI-0001", title: "T", stage: "outline", company_id: "c", recipe: {}, analysis: null },
    piece_contracts: { expectations: [{ id: "e1", text: "First" }, { id: "e2", text: "Second" }] },
  };
  const db = {
    from(table: string) {
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle") return async () => ({ data: tables[table] ?? null, error: null });
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: table === "piece_sections" ? existing : [], error: null });
          return () => q;
        },
      });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { data: null, error: null }; },
  } as unknown as SupabaseClient;
  return { db, rpcs };
}

describe("saveOutline with sub-headings (additive)", () => {
  it("sends nothing new when no level or depth is given, so older callers are unchanged", async () => {
    const { db, rpcs } = outlineDb();
    await saveOutline(db, "SI-0001", [{ heading: "One", covers: [1] }, { heading: "Two" }]);
    expect(rpcs[0].args.sections).toEqual([
      { heading: "One", purpose: "", expectation_ids: ["e1"] },
      { heading: "Two", purpose: "", expectation_ids: [] },
    ]);
  });

  it("passes level and depth through, and gives a sub-heading no scope points", async () => {
    const { db, rpcs } = outlineDb();
    await saveOutline(db, "SI-0001", [
      { heading: "Emerging technologies", level: 2, covers: [1] },
      { heading: "Quantum", level: 3, depth: "deep", covers: [2] },
    ]);
    expect(rpcs[0].args.sections).toEqual([
      { heading: "Emerging technologies", purpose: "", expectation_ids: ["e1"], level: 2 },
      { heading: "Quantum", purpose: "", expectation_ids: [], level: 3, depth: "deep" },
    ]);
  });

  it("refuses a first sub-heading, a bad level or depth, and raises the cap only when sub-headings are used", async () => {
    const { db } = outlineDb();
    await expect(saveOutline(db, "SI-0001", [{ heading: "A", level: 3 }])).rejects.toThrow(/start with a main heading/);
    await expect(saveOutline(db, "SI-0001", [{ heading: "A", level: 4 }])).rejects.toThrow(/level is 2/);
    await expect(saveOutline(db, "SI-0001", [{ heading: "A", depth: "huge" }])).rejects.toThrow(/depth is short/);
    await expect(saveOutline(db, "SI-0001", Array.from({ length: 13 }, (_, i) => ({ heading: `S${i}` })))).rejects.toThrow(/1 to 12/);
    const many = [{ heading: "Main", level: 2 }, ...Array.from({ length: 20 }, (_, i) => ({ heading: `Sub ${i}`, level: 3 }))];
    await expect(saveOutline(db, "SI-0001", many)).resolves.toBeTruthy();
  });
});

describe("saveOutline for an older caller that sends an outline with sub-headings back without levels", () => {
  const existing = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", structure: null, level: 2 },
    ...Array.from({ length: 14 }, (_, i) => ({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`, structure: null, level: 3 })),
  ];
  const resend = existing.map((e, i) => ({ id: e.id, heading: i === 0 ? "Main" : `Sub ${i}`, covers: [1] }));
  it("is not refused for having more than 12 rows, and a kept sub-heading's points are dropped", async () => {
    const { db, rpcs } = outlineDb(existing);
    await saveOutline(db, "SI-0001", resend);
    const sent = rpcs[0].args.sections as { expectation_ids: string[]; level?: number }[];
    expect(sent).toHaveLength(15);
    expect(sent[0].expectation_ids).toEqual(["e1"]);
    expect(sent.slice(1).every((s) => s.expectation_ids.length === 0 && s.level === undefined)).toBe(true);
  });
});

describe("saveOutline keeps what a kept section covers when covers is left out", () => {
  const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const ID2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const existing = [{ id: ID1, structure: null, level: 2, expectation_ids: ["e1"] }, { id: ID2, structure: null, level: 2, expectation_ids: ["e2"] }];
  it("sends the same points back, and counts them as covered", async () => {
    const { db, rpcs } = outlineDb(existing);
    const r = await saveOutline(db, "SI-0001", [{ id: ID1, heading: "One" }, { id: ID2, heading: "Two" }]);
    expect((rpcs[0].args.sections as { expectation_ids: string[] }[]).map((s) => s.expectation_ids)).toEqual([["e1"], ["e2"]]);
    expect(r.scope_points_not_covered).toEqual([]);
  });
  it("clears them only when covers is sent, even empty", async () => {
    const { db, rpcs } = outlineDb(existing);
    const r = await saveOutline(db, "SI-0001", [{ id: ID1, heading: "One", covers: [] }, { id: ID2, heading: "Two", covers: [1] }]);
    expect((rpcs[0].args.sections as { expectation_ids: string[] }[]).map((s) => s.expectation_ids)).toEqual([[], ["e1"]]);
    expect(r.scope_points_not_covered).toEqual([{ n: 2, text: "Second" }]);
  });
  it("does not carry points onto a new section, and a new one with no covers covers nothing", async () => {
    const { db, rpcs } = outlineDb(existing);
    await saveOutline(db, "SI-0001", [{ id: ID1, heading: "One" }, { heading: "Brand new" }]);
    expect((rpcs[0].args.sections as { expectation_ids: string[] }[]).map((s) => s.expectation_ids)).toEqual([["e1"], []]);
  });
});

/** A stand-in for checkPiece: the piece, its scope, its research and its sections. `old` has no level or depth column. */
function checkDb(opts: { piece?: Record<string, unknown>; sections?: Record<string, unknown>[]; analysis?: unknown; old?: boolean; fail?: string } = {}) {
  const sections = (opts.sections ?? [
    { position: 1, heading: "A", status: "writing", content: "one two three", points: { points: [{}] }, brief: null, ai_draft: "x", level: 2 },
    { position: 2, heading: "B", status: "writing", content: "four five", points: { points: [{}] }, brief: null, ai_draft: "x", level: 2 },
  ]).map((s) => (opts.old ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "level" && k !== "depth")) : s));
  const tables: Record<string, unknown> = {
    pieces: { id: PIECE, code: "SI-0001", title: "T", stage: "outline", company_id: "c", format_id: null, outline_confirmed_at: null, signed_off_at: null,
      analysis: opts.analysis ?? null, recipe: { analysis: { enabled: true }, outline: { mode: "free" }, contract: { mode: "full" }, writing: { ai_draft: true } }, ...opts.piece },
    piece_contracts: { expectations: [{ id: "e1" }, { id: "e2" }], confirmed_at: "2026-11-10" },
  };
  return {
    from(table: string) {
      let cols = "";
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "select") return (c: string) => { cols = c; return q; };
          if (prop === "maybeSingle") return async () => (table === opts.fail ? { data: null, error: { message: "boom" } } : { data: tables[table] ?? null, error: null });
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              if (table === opts.fail) return resolve({ data: null, error: { message: "boom" } });
              if (table === "piece_sections" && opts.old && /\b(level|depth)\b/.test(cols)) return resolve({ data: null, error: { message: "column piece_sections.level does not exist" } });
              if (table === "piece_sections") return resolve({ data: sections, error: null });
              if (table === "research_items") return resolve({ data: [{ status: "approved" }, { status: "approved" }, { status: "unreviewed" }], error: null });
              return resolve({ data: [], error: null });
            };
          }
          return () => q;
        },
      });
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("checkPiece", () => {
  it("reports a read that failed instead of describing an empty piece", async () => {
    await expect(checkPiece(checkDb({ fail: "research_items" }), "SI-0001")).rejects.toThrow(/Could not read the research: boom/);
    await expect(checkPiece(checkDb({ fail: "piece_contracts" }), "SI-0001")).rejects.toThrow(/Could not read the scope/);
  });
  it("describes what the writer sees for a piece made here (no gap analysis, outline saved) and finds it healthy", async () => {
    const r = await checkPiece(checkDb(), "SI-0001");
    expect(r.healthy).toBe(true);
    expect(r.what_the_writer_sees.outline).toMatch(/outline editor with 2 sections, open for editing/);
    expect(r.what_the_writer_sees.research).toMatch(/locked: 2 approved/);
    expect(r.concerns.map((c) => c.id)).toEqual(["benchmark-not-run"]);
    expect(r.how_to_use).toMatch(/Tell the writer about every concern marked problem/);
  });
  it("reports a problem when writing has started without a confirmed outline", async () => {
    const r = await checkPiece(checkDb({ piece: { stage: "writing" } }), "SI-0001");
    expect(r.healthy).toBe(false);
    expect(r.concerns.map((c) => c.id)).toContain("writing-without-confirmed-outline");
  });
  it("sees sub-headings, and works on a database that has no level column", async () => {
    const withSub = await checkPiece(checkDb({ sections: [
      { position: 1, heading: "A", status: "writing", content: "x", points: { points: [{}] }, level: 2 },
      { position: 2, heading: "a1", status: "writing", content: "", points: { points: [{}] }, level: 3 },
    ] }), "SI-0001");
    expect(withSub.what_the_writer_sees.outline).toMatch(/1 section and 1 sub-heading/);
    const old = await checkPiece(checkDb({ old: true }), "SI-0001");
    expect(old.what_the_writer_sees.outline).toMatch(/2 sections/);
  });
  it("treats a piece with a saved analysis as having had its benchmark run", async () => {
    const r = await checkPiece(checkDb({ analysis: { alignment: { verdict: "aligned", summary: "" }, benchmark_done: true } }), "SI-0001");
    expect(r.concerns.map((c) => c.id)).not.toContain("benchmark-not-run");
  });
});
