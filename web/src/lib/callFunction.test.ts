import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID } from "./clientId";
import { callFunction, supabase, UNSAVED_EVENT, UnsavedResultError } from "./supabase";
import { unsavedText } from "../components/UnsavedResult";

// `supabase.functions` makes a new client on each read, so the stand-in replaces the property itself.
const invoke = vi.fn();
vi.spyOn(supabase, "functions", "get").mockReturnValue({ invoke } as never);

describe("calling a server function", () => {
  afterEach(() => invoke.mockReset());

  it("says which tab is asking, so the function takes the edit lock as this tab", async () => {
    invoke.mockResolvedValueOnce({ data: { ok: true }, error: null } as never);
    await callFunction("ai", { task: "grammar_check", section_id: "s1" });
    expect(invoke).toHaveBeenCalledWith("ai", { body: { task: "grammar_check", section_id: "s1", client: CLIENT_ID } });
  });

  it("hands the writer the AI's result when the save was refused because someone took the lock over", async () => {
    const payload = { error: "Priya took over this section while this was running, so the result was not saved.", code: "edit_locked", unsaved: { text: "The drafted section." } };
    invoke.mockResolvedValueOnce({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => payload } } } as never);
    // These tests run without a browser: a bare event target stands in for the window.
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const seen: unknown[] = [];
    page.addEventListener(UNSAVED_EVENT, (e) => seen.push((e as CustomEvent).detail));
    const err = await callFunction("ai", { task: "section_draft" }).catch((e) => e);
    vi.unstubAllGlobals();
    expect(err).toBeInstanceOf(UnsavedResultError);
    expect((err as UnsavedResultError).message).toMatch(/Priya took over this section/);
    expect((err as UnsavedResultError).unsaved).toEqual({ text: "The drafted section." });
    expect(seen).toEqual([{ message: payload.error, unsaved: payload.unsaved, task: "section_draft" }]);
  });

  it("does not show a result when the refusal came before the AI ran", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "x", context: { json: async () => ({ error: "Priya is editing this section in Writ. Nothing was changed." }) } } } as never);
    const err = await callFunction("ai", { task: "section_draft" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnsavedResultError);
    expect((err as Error).message).toMatch(/Priya is editing this section/);
  });
});

describe("the unsaved result shown to the writer", () => {
  it("shows a lone text field as plain text, anything else as indented data", () => {
    expect(unsavedText({ text: "A drafted section." })).toBe("A drafted section.");
    expect(unsavedText("plain")).toBe("plain");
    expect(unsavedText([{ statement: "x" }])).toBe('[\n  {\n    "statement": "x"\n  }\n]');
  });
});
