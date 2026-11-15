import { describe, expect, it } from "vitest";
import { applyOutlineChanges, normaliseLevels, type OutlineChange } from "../../../supabase/functions/_shared/outline";

const section = (position: number, heading: string, level: 2 | 3 = 2, expectations: number[] = []) => ({ position, heading, purpose: "", expectations, blocks: [], level, depth: "standard" });
const change = (c: Partial<OutlineChange>): OutlineChange => ({ kind: "edit_section", position: 0, after: 0, index: 0, heading: "", purpose: "", expectations: [], blocks: [], check: "", ...c });
const sections = () => [section(1, "A"), section(2, "a1", 3), section(3, "B", 2, [1]), section(4, "b1", 3)];
const heads = (rows: { heading: string }[]) => rows.map((r) => r.heading);

describe("the SEO fix applies changes without splitting sub-headings from their main heading", () => {
  it("moves a main heading with its sub-headings", () => {
    const r = applyOutlineChanges(sections(), 2, [change({ kind: "move_section", position: 1, after: 3 })]);
    expect(heads(r.rows)).toEqual(["B", "b1", "A", "a1"]);
    expect(r.summary.moved).toBe(1);
  });

  it("puts a new section after a main heading's last sub-heading, as a main heading", () => {
    const r = applyOutlineChanges(sections(), 2, [change({ kind: "add_section", after: 1, heading: "New" })]);
    expect(heads(r.rows)).toEqual(["A", "a1", "New", "B", "b1"]);
    expect(r.rows[2]).toMatchObject({ level: 2, depth: "standard" });
  });

  it("treats 'after a sub-heading' as after the end of that group", () => {
    const r = applyOutlineChanges(sections(), 2, [change({ kind: "add_section", after: 2, heading: "New" })]);
    expect(heads(r.rows)).toEqual(["A", "a1", "New", "B", "b1"]);
  });

  it("puts a new section first when after is 0", () => {
    const r = applyOutlineChanges(sections(), 2, [change({ kind: "add_section", after: 0, heading: "First" })]);
    expect(heads(r.rows)).toEqual(["First", "A", "a1", "B", "b1"]);
  });

  it("never moves a sub-heading, and never moves a main heading into its own group", () => {
    const sub = applyOutlineChanges(sections(), 2, [change({ kind: "move_section", position: 2, after: 3 })]);
    expect(heads(sub.rows)).toEqual(["A", "a1", "B", "b1"]);
    expect(sub.summary.moved).toBe(0);
    const own = applyOutlineChanges(sections(), 2, [change({ kind: "move_section", position: 1, after: 2 })]);
    expect(heads(own.rows)).toEqual(["A", "a1", "B", "b1"]);
    expect(own.summary.moved).toBe(0);
  });

  it("lets a sub-heading's words be edited but gives it no contract points", () => {
    const r = applyOutlineChanges(sections(), 2, [change({ kind: "edit_section", position: 2, heading: "a1 renamed", purpose: "Why", expectations: [1] })]);
    expect(r.rows[1]).toMatchObject({ heading: "a1 renamed", purpose: "Why", expectations: [], level: 3 });
  });

  it("keeps levels and depth on every row it returns", () => {
    const r = applyOutlineChanges(sections(), 2, []);
    expect(r.rows.map((x) => [x.level, x.depth])).toEqual([[2, "standard"], [3, "standard"], [2, "standard"], [3, "standard"]]);
  });

  it("still behaves for an outline with no sub-headings", () => {
    const flat = [section(1, "A"), section(2, "B"), section(3, "C")];
    const r = applyOutlineChanges(flat, 2, [change({ kind: "move_section", position: 1, after: 2 }), change({ kind: "add_section", after: 3, heading: "D" })]);
    expect(heads(r.rows)).toEqual(["B", "A", "C", "D"]);
  });
});

describe("normaliseLevels", () => {
  it("makes the first row a main heading, clears a sub-heading's points, and fixes a bad depth", () => {
    const out = normaliseLevels([
      { heading: "A", level: 3, depth: "deep", expectations: [1] },
      { heading: "b", level: 3, depth: "huge", expectations: [1, 2] },
      { heading: "C", level: 7, expectations: [2] },
    ]);
    expect(out.map((r) => [r.level, r.depth, r.expectations])).toEqual([[2, "standard", [1]], [3, "standard", []], [2, "standard", [2]]]);
  });
});
