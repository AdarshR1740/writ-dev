import { describe, expect, it } from "vitest";
import { familyNote, sectionFamily } from "../../../supabase/functions/_shared/outline";

const rows = [
  { position: 1, heading: "A", level: 2 },
  { position: 2, heading: "a1", purpose: "first", level: 3 },
  { position: 3, heading: "a2", level: 3 },
  { position: 4, heading: "B", level: 2 },
];

describe("where a section sits in the outline", () => {
  it("lists the sub-headings under a main heading", () => {
    const f = sectionFamily(rows, 1);
    expect(f.children.map((r) => r.heading)).toEqual(["a1", "a2"]);
    expect(familyNote(f)).toContain("only what opens the main heading");
  });
  it("gives a sub-heading its parent and siblings", () => {
    const f = sectionFamily(rows, 2);
    expect(f.parent?.heading).toBe("A");
    expect(f.siblings.map((r) => r.heading)).toEqual(["a2"]);
    expect(familyNote(f)).toContain('under the main heading "A"');
  });
  it("says nothing for a main heading without sub-headings", () => {
    expect(familyNote(sectionFamily(rows, 4))).toBe("");
    expect(familyNote(sectionFamily(rows, 99))).toBe("");
  });
});
