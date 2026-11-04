import { describe, expect, it } from "vitest";
import { cleanPaste } from "./paste";

describe("cleanPaste", () => {
  it("collapses runs of blank lines into one blank line", () => {
    expect(cleanPaste("One.\n\n\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("keeps a single line break as it is", () => {
    expect(cleanPaste("Line one\nLine two\n\nNew paragraph")).toBe("Line one\nLine two\n\nNew paragraph");
  });

  it("treats lines holding only spaces as blank", () => {
    expect(cleanPaste("One.\n   \n \t \nTwo.")).toBe("One.\n\nTwo.");
  });

  it("normalises Windows and old Mac line endings", () => {
    expect(cleanPaste("One.\r\n\r\n\r\nTwo.\rThree.")).toBe("One.\n\nTwo.\nThree.");
  });

  it("removes trailing spaces, non-breaking spaces and zero-width characters", () => {
    expect(cleanPaste("Hello world ​again  \nnext")).toBe("Hello world again\nnext");
  });

  it("trims blank lines from both ends", () => {
    expect(cleanPaste("\n\n  \nText\n\n\n")).toBe("Text");
  });
});
