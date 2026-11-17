import { describe, expect, it } from "vitest";
import { countWords } from "./wordCount";

describe("countWords", () => {
  it("counts plain words", () => {
    expect(countWords("one two  three\nfour")).toBe(4);
  });
  it("does not count the marks before a heading or list item", () => {
    expect(countWords("## What does an edit lock do?\n\nIt keeps writers apart.")).toBe(10);
    expect(countWords("- one\n- two\n1. three")).toBe(3);
  });
  it("counts a link's text, not its address", () => {
    expect(countWords("see [the guide](https://example.com/a/b) now")).toBe(4);
  });
  it("is zero for empty or mark-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  \n ")).toBe(0);
    expect(countWords("**")).toBe(0);
  });
});
