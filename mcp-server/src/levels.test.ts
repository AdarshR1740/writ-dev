import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPiece, getPiece, getSection, lockedMessage, lockedOutline, lockedPiece, lockedResearchOf, lockedSection, saveOutline, saveSectionDraft, withLock, AI_LEASE_SECONDS, claimForRead, noteRead, WritError } from "./writ.js";
import { CLIENT_ID } from "./client-id.js";

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
function checkDb(opts: { piece?: Record<string, unknown>; sections?: Record<string, unknown>[]; analysis?: unknown; old?: boolean; fail?: string; locks?: unknown[] } = {}) {
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
              if (table === "edit_locks") return resolve({ data: opts.locks ?? [], error: null });
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

/** A stand-in with a scriptable lock: it records acquire and release calls. */
function lockDb(acquire: unknown, opts: { error?: { code?: string; message: string } } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "acquire_lock") return opts.error ? { data: null, error: opts.error } : { data: acquire, error: null };
      return { data: null, error: null };
    },
    from() {
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle") return async () => ({ data: { id: PIECE, code: "SI-0001", piece_id: PIECE, stage: "outline", company_id: "c", recipe: {} }, error: null });
          return () => q;
        },
      });
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("edit locks on Claude's writes", () => {
  it("takes the lock as Claude, runs the write, and keeps the lock for its lease", async () => {
    const { db, calls } = lockDb({ ok: true, token: "tok-1" });
    await noteRead(db, CLIENT_ID, PIECE, [{ scope: "outline" }]);
    const r = await withLock(db, PIECE, "outline", null, async () => "saved");
    expect(r).toBe("saved");
    expect(calls.map((c) => c.fn)).toEqual(["acquire_lock"]);
    expect(calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: "outline", target_section: null, client: CLIENT_ID, kind: "ai", take_over: false, lease_seconds: AI_LEASE_SECONDS });
    expect(CLIENT_ID).toMatch(/^ai-/);
  });

  it("writes nothing and says who is editing when someone else holds it", async () => {
    const { db, calls } = lockDb({ ok: false, holder_label: "Adarsh", holder_kind: "person", since: "2026-11-16T10:02:00Z", expires_at: "2026-11-16T10:05:00Z" });
    let ran = false;
    await expect(withLock(db, PIECE, "section", S1, async () => { ran = true; })).rejects.toThrow(/Adarsh is editing the section in Writ \(since 10:02 UTC\)\. Nothing was saved/);
    expect(ran).toBe(false);
    expect(calls.map((c) => c.fn)).toEqual(["acquire_lock"]);
    expect(lockedMessage({ holder_label: "X", since: "bad" }, "outline")).toMatch(/^X is editing the outline in Writ\. Nothing was saved\./);
  });

  it("passes a failed write's error through", async () => {
    const { db, calls } = lockDb({ ok: true });
    await noteRead(db, CLIENT_ID, PIECE, [{ scope: "outline" }]);
    await expect(withLock(db, PIECE, "outline", null, async () => { throw new WritError("boom"); })).rejects.toThrow("boom");
    expect(calls.map((c) => c.fn)).toEqual(["acquire_lock"]);
  });

  it("behaves as before on a Writ database that has no lock functions yet", async () => {
    const { db, calls } = lockDb(null, { error: { code: "PGRST202", message: "Could not find the function public.acquire_lock" } });
    expect(await withLock(db, PIECE, "outline", null, async () => 7)).toBe(7);
    expect(calls.map((c) => c.fn)).toEqual(["acquire_lock"]);
    const other = lockDb(null, { error: { code: "XX000", message: "something else broke" } });
    await expect(withLock(other.db, PIECE, "outline", null, async () => 7)).rejects.toThrow(/Could not check the edit lock/);
  });

  it("finds the piece for an outline or a section before locking", async () => {
    const a = lockDb({ ok: true });
    await noteRead(a.db, CLIENT_ID, PIECE, [{ scope: "outline" }]);
    await lockedOutline(a.db, "SI-0001", async () => undefined);
    expect(a.calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: "outline" });
    const b = lockDb({ ok: true });
    await noteRead(b.db, CLIENT_ID, PIECE, [{ scope: "section", sectionId: S2 }]);
    await lockedSection(b.db, S2, async () => undefined);
    expect(b.calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: "section", target_section: S2 });
    await expect(lockedSection(b.db, "not-an-id", async () => undefined)).rejects.toThrow(/section_id must be/);
  });

  it("locks the scope, the research and the final checks too, and says which one is busy", async () => {
    for (const scope of ["scope", "research", "final"] as const) {
      const a = lockDb({ ok: true });
      await noteRead(a.db, CLIENT_ID, PIECE, [{ scope }]);
      await lockedPiece(a.db, "SI-0001", scope, async () => undefined);
      expect(a.calls.map((c) => c.fn)).toEqual(["acquire_lock"]);
      expect(a.calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: scope, target_section: null, kind: "ai" });
    }
    const busy = { ok: false, holder_label: "Adarsh", holder_kind: "person", since: "2026-11-16T10:02:00Z", expires_at: "2026-11-16T10:05:00Z" };
    let ran = false;
    await expect(lockedPiece(lockDb(busy).db, "SI-0001", "scope", async () => { ran = true; })).rejects.toThrow(/Adarsh is editing the scope in Writ \(since 10:02 UTC\)\. Nothing was saved/);
    await expect(lockedPiece(lockDb(busy).db, "SI-0001", "research", async () => { ran = true; })).rejects.toThrow(/is editing the research in Writ/);
    await expect(lockedPiece(lockDb(busy).db, "SI-0001", "final", async () => { ran = true; })).rejects.toThrow(/is editing the final checks and sign-off in Writ/);
    expect(ran).toBe(false);
  });

  it("finds the piece behind a research item or a section before taking the research lock", async () => {
    const a = lockDb({ ok: true });
    const append = { append: true };
    await lockedResearchOf(a.db, { item: S1 }, async () => undefined, CLIENT_ID, append);
    expect(a.calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: "research", target_section: null });
    const b = lockDb({ ok: true });
    await lockedResearchOf(b.db, { section: S2 }, async () => undefined, CLIENT_ID, append);
    expect(b.calls[0].args).toMatchObject({ target_piece: PIECE, lock_scope: "research" });
    // A batch of decisions on one piece is one lock; decisions spanning pieces are refused before anything is written.
    const c = lockDb({ ok: true });
    await lockedResearchOf(c.db, { items: [S1, S2] }, async () => undefined, CLIENT_ID, append);
    expect(c.calls.filter((x) => x.fn === "acquire_lock")).toHaveLength(1);
    let n = 0;
    const two = { rpc: async () => ({ data: { ok: true }, error: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { piece_id: `piece-${n++}` }, error: null }) }) }) }) } as unknown as SupabaseClient;
    await expect(lockedResearchOf(two, { items: [S1, S2] }, async () => undefined)).rejects.toThrow(/different pieces/);
    await expect(lockedResearchOf(b.db, { item: "nope" }, async () => undefined)).rejects.toThrow(/not a research item id/);
    await expect(lockedResearchOf(b.db, { section: "nope" }, async () => undefined)).rejects.toThrow(/section_id must be/);
  });
});

/** A stand-in whose step versions can be moved on, as if the writer saved something. The lock is always free. */
function versionDb() {
  const state = { version: "2026-11-17T10:00:00+00:00", by: "Adarsh", missing: false };
  const db = {
    rpc: async () => ({ data: { ok: true, token: "t" }, error: null }),
    from(table: string) {
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle") {
            return async () => table === "step_versions"
              ? state.missing ? { data: null, error: { code: "42P01", message: 'relation "step_versions" does not exist' } } : { data: { version: state.version, changed_by_label: state.by }, error: null }
              : { data: { id: PIECE, code: "SI-0001", piece_id: PIECE }, error: null };
          }
          return () => q;
        },
      });
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, state };
}

describe("step versions: Claude does not save over what changed after it read", () => {
  const read = (db: SupabaseClient, client = CLIENT_ID) => noteRead(db, client, PIECE, [{ scope: "research" }]);
  it("refuses a save when the step has not been read in this connection", async () => {
    const { db } = versionDb();
    let ran = false;
    await expect(lockedPiece(db, "SI-0001", "research", async () => { ran = true; }, "ai-never-read")).rejects.toThrow(/not read the research.*Nothing was saved/);
    expect(ran).toBe(false);
  });
  it("lets a save through when nothing changed since the read, and again after its own save", async () => {
    const { db, state } = versionDb();
    await read(db, "ai-a");
    await lockedPiece(db, "SI-0001", "research", async () => { state.version = "2026-11-17T10:00:05+00:00"; state.by = "Claude (for Adarsh)"; }, "ai-a");
    await lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-a");
  });
  it("refuses when the writer changed the step after the read, names them, and does not merge", async () => {
    const { db, state } = versionDb();
    await read(db, "ai-b");
    state.version = "2026-11-17T10:12:00+00:00"; state.by = "Priya";
    let ran = false;
    await expect(lockedPiece(db, "SI-0001", "research", async () => { ran = true; }, "ai-b"))
      .rejects.toThrow(/Priya changed the research at 10:12 UTC, after you last read it\. Nothing was saved\..*ask how they want the two versions combined/);
    expect(ran).toBe(false);
  });
  it("lets Claude save again after it reads the changed step", async () => {
    const { db, state } = versionDb();
    await read(db, "ai-c");
    state.version = "2026-11-17T10:12:00+00:00";
    await expect(lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-c")).rejects.toThrow(/changed the research/);
    await read(db, "ai-c");
    await lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-c");
  });
  it("keeps each connection's reads apart", async () => {
    const { db, state } = versionDb();
    await read(db, "ai-d1");
    state.version = "2026-11-17T10:12:00+00:00";
    await read(db, "ai-d2");
    await lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-d2");
    await expect(lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-d1")).rejects.toThrow(/changed the research/);
  });
  it("lets an append go through without a read, and does not hide a change from the next replace", async () => {
    const { db, state } = versionDb();
    await lockedPiece(db, "SI-0001", "research", async () => { state.version = "2026-11-17T10:00:09+00:00"; }, "ai-e", { append: true });
    await expect(lockedPiece(db, "SI-0001", "research", async () => undefined, "ai-e")).rejects.toThrow(/not read the research/);
  });
  /** A stand-in that keeps a version per step, so one write can move several steps on. */
  function versionStore() {
    const NIL = "00000000-0000-0000-0000-000000000000";
    const rows = new Map<string, { version: string; changed_by_label: string }>();
    const set = (scope: string, section: string | null, version: string, by: string) => rows.set(`${scope}|${section ?? NIL}`, { version, changed_by_label: by });
    const db = {
      rpc: async () => ({ data: { ok: true, token: "t" }, error: null }),
      from(table: string) {
        const f: Record<string, string> = {};
        const q: Record<string | symbol, unknown> = new Proxy({}, {
          get(_t, prop) {
            if (prop === "eq") return (c: string, v: string) => { f[c] = v; return q; };
            if (prop === "maybeSingle") return async () => ({ data: table === "step_versions" ? rows.get(`${f.scope}|${f.section_id}`) ?? null : { id: PIECE, code: "SI-0001", piece_id: PIECE }, error: null });
            return () => q;
          },
        });
        return q;
      },
    } as unknown as SupabaseClient;
    return { db, set };
  }
  it("does not take Claude's own effect on a section (a heading changed by saving the outline) for someone else's change", async () => {
    const { db, set } = versionStore();
    set("outline", null, "v1", "Adarsh"); set("section", S1, "v1", "Adarsh");
    await noteRead(db, "ai-h", PIECE, [{ scope: "outline" }, { scope: "section", sectionId: S1 }]);
    await lockedOutline(db, "SI-0001", async () => { set("outline", null, "v2", "Claude (for Adarsh)"); set("section", S1, "v2", "Claude (for Adarsh)"); }, "ai-h");
    await lockedSection(db, S1, async () => undefined, "ai-h");
  });
  it("still refuses a section the writer changed while Claude saved the outline", async () => {
    const { db, set } = versionStore();
    set("outline", null, "v1", "Adarsh"); set("section", S1, "v1", "Adarsh");
    await noteRead(db, "ai-i", PIECE, [{ scope: "outline" }, { scope: "section", sectionId: S1 }]);
    await lockedOutline(db, "SI-0001", async () => { set("outline", null, "v2", "Claude (for Adarsh)"); set("section", S1, "v2", "Priya"); }, "ai-i");
    await expect(lockedSection(db, S1, async () => undefined, "ai-i")).rejects.toThrow(/Priya changed the section/);
  });
  it("behaves as before on a database without step versions", async () => {
    const { db, state } = versionDb();
    state.missing = true;
    expect(await lockedPiece(db, "SI-0001", "research", async () => 5, "ai-f")).toBe(5);
  });
  it("tells Claude, when it reads a step to write it, that the writer is already in it", async () => {
    const busy = { rpc: async () => ({ data: { ok: false, holder_label: "Priya", holder_kind: "person", since: "2026-11-17T10:02:00Z", expires_at: "x" }, error: null }) } as unknown as SupabaseClient;
    expect(await claimForRead(busy, "ai-g", PIECE, "section", S1)).toMatch(/Priya is editing the section in Writ right now at 10:02 UTC\. Do not start drafting/);
    const free = { rpc: async () => ({ data: { ok: true, token: "t" }, error: null }) } as unknown as SupabaseClient;
    expect(await claimForRead(free, "ai-g", PIECE, "section", S1)).toBeNull();
  });
});

describe("checkPiece and edit locks", () => {
  const held = (label: string, client: string, scope = "outline", sectionId = "") => ({ scope, section_id: sectionId, holder_client: client, holder_label: label, holder_kind: "person", acquired_at: "2026-11-16T10:02:00Z" });
  it("tells Claude who is editing, so a refused save is not a surprise", async () => {
    const r = await checkPiece(checkDb({ locks: [held("Adarsh", "web-1")] }), "SI-0001");
    expect(r.concerns.find((c) => c.id === "locked-outline")?.message).toBe("Adarsh is editing the outline in Writ (since 10:02 UTC).");
    expect(r.healthy).toBe(true);
  });
  it("does not report Claude's own lock", async () => {
    const r = await checkPiece(checkDb({ locks: [held("Claude (for Adarsh)", CLIENT_ID)] }), "SI-0001");
    expect(r.concerns.map((c) => c.id)).not.toContain("locked-outline");
  });
  it("copes with a database that has no edit_locks table", async () => {
    const r = await checkPiece(checkDb({ fail: "edit_locks" }), "SI-0001");
    expect(r.concerns.map((c) => c.id)).not.toContain("locked-outline");
  });
});
