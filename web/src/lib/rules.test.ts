import { describe, expect, it } from "vitest";
import { parseRules } from "./rules";

describe("parseRules", () => {
  it("strips bullets and numbering", () => {
    expect(parseRules("- Open with the claim\n2. Numbers as digits\n* Never use 'leverage'")).toEqual([
      "Open with the claim", "Numbers as digits", "Never use 'leverage'",
    ]);
  });
  it("skips headings, blank lines and duplicates, including saved rules", () => {
    expect(parseRules("## Rules\nShort sentences.\n\nshort sentences.\nKeep it plain.", ["Keep it plain."])).toEqual(["Short sentences."]);
  });
  it("skips intro lines that end with a colon", () => {
    expect(parseRules("Here are your rules:\n- Write numbers as digits")).toEqual(["Write numbers as digits"]);
  });
});
