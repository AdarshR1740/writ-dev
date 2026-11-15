import { describe, expect, it } from "vitest";
import { blankMainWithSubs, groupEnd, moveGroup, moveSub, setLevel, type Draft } from "./outlineRows";

const row = (heading: string, level: 2 | 3 = 2, ids: string[] = []): Draft => ({ key: heading, level, depth: level === 3 ? "deep" : "standard", heading, purpose: "", expectation_ids: ids, structure: [] });
const names = (list: Draft[]) => list.map((r) => r.heading);

describe("outline rows: main headings and sub-headings", () => {
  const list = [row("A"), row("a1", 3), row("a2", 3), row("B"), row("b1", 3)];

  it("finds where a group (a main heading and its sub-headings) ends", () => {
    expect(groupEnd(list, 0)).toBe(3);
    expect(groupEnd(list, 3)).toBe(5);
    expect(groupEnd(list, 1)).toBe(3);
  });

  it("moves a main heading together with its sub-headings", () => {
    expect(names(moveGroup(list, 0, 1))).toEqual(["B", "b1", "A", "a1", "a2"]);
    expect(names(moveGroup(list, 3, -1))).toEqual(["B", "b1", "A", "a1", "a2"]);
  });

  it("leaves the first group where it is when moved up, and the last when moved down", () => {
    expect(moveGroup(list, 0, -1)).toBe(list);
    expect(moveGroup(list, 3, 1)).toBe(list);
  });

  it("moves plain main headings like a simple list, for outlines with no sub-headings", () => {
    const flat = [row("X"), row("Y"), row("Z")];
    expect(names(moveGroup(flat, 1, 1))).toEqual(["X", "Z", "Y"]);
    expect(names(moveGroup(flat, 1, -1))).toEqual(["Y", "X", "Z"]);
  });

  it("moves a sub-heading within its group and across into the neighbouring group at the edges", () => {
    expect(names(moveSub(list, 1, 1))).toEqual(["A", "a2", "a1", "B", "b1"]);
    // the last sub-heading of A moves down into B's group, as its first sub-heading
    expect(names(moveSub(list, 2, 1))).toEqual(["A", "a1", "B", "a2", "b1"]);
    // the first sub-heading of B moves up into the end of A's group
    expect(names(moveSub(list, 4, -1))).toEqual(["A", "a1", "a2", "b1", "B"]);
  });

  it("does not move a sub-heading above the first main heading, or below the last row", () => {
    expect(moveSub(list, 1, -1)).toBe(list);
    expect(moveSub(list, 4, 1)).toBe(list);
  });

  it("a sub-heading that crossed over stays a sub-heading and ends up under the right main heading", () => {
    const moved = moveSub(list, 4, -1);
    expect(moved.map((r) => r.level)).toEqual([2, 3, 3, 3, 2]);
  });

  it("demotes a main heading under the one above it, and hands its contract points to that one", () => {
    const l = [row("A", 2, ["e1"]), row("B", 2, ["e2"])];
    const out = setLevel(l, 1, 3);
    expect(out[1]).toMatchObject({ level: 3, expectation_ids: [] });
    expect(out[0].expectation_ids.sort()).toEqual(["e1", "e2"]);
  });

  it("promotes a sub-heading to a main heading with the standard depth", () => {
    const out = setLevel(list, 1, 2);
    expect(out[1]).toMatchObject({ level: 2, depth: "standard" });
  });

  it("cannot demote the first row", () => {
    const l = [row("A"), row("B")];
    expect(setLevel(l, 0, 3)).toBe(l);
  });

  it("flags a main heading with no name that has sub-headings, which cannot be saved", () => {
    expect(blankMainWithSubs([row("A"), row("", 2), row("x", 3)])).toBe(true);
    expect(blankMainWithSubs([row(""), row("x", 3)])).toBe(true);
    // a blank main heading with nothing under it is simply dropped when saving
    expect(blankMainWithSubs([row("A"), row("a1", 3), row("")])).toBe(false);
    expect(blankMainWithSubs(list)).toBe(false);
  });
});
