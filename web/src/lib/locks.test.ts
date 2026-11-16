import { afterEach, describe, expect, it, vi } from "vitest";
import { errorMessage, withClientId } from "./supabase";
import { holderText, lockUnavailable } from "./locks";
import { CLIENT_ID } from "./clientId";

describe("edit locks in the app", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names who is editing, and since when", () => {
    const text = holderText({ label: "Adarsh", kind: "person", since: "2026-11-16T10:02:00Z" }, "the outline");
    expect(text).toMatch(/^Adarsh is editing the outline since \d{1,2}:\d{2}/);
    expect(holderText({ label: "Claude (for Adarsh)", kind: "ai", since: "not a time" }, "this section")).toBe("Claude (for Adarsh) is editing this section.");
  });

  it("treats a database without the lock functions as unlocked, so the app can run ahead of the migration", () => {
    expect(lockUnavailable({ code: "PGRST202" })).toBe(true);
    expect(lockUnavailable({ code: "42P01" })).toBe(true);
    expect(lockUnavailable({ message: "Could not find the function public.acquire_lock" })).toBe(true);
    expect(lockUnavailable({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(lockUnavailable(null)).toBe(false);
  });

  it("turns a refused change into a plain sentence", () => {
    expect(errorMessage(new Error("edit_locked: Claude (for Adarsh) is editing this section (since 10:02 UTC)")))
      .toBe('Claude (for Adarsh) is editing this section (since 10:02 UTC). Use "Take over" in the banner to continue, or wait until they finish.');
    expect(errorMessage({ message: "something else" })).toBe("something else");
  });

  it("says which tab is asking on database requests, and only on those", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response("{}"); }));
    await withClientId("https://x.supabase.co/rest/v1/pieces?select=id", { headers: { apikey: "k" } });
    await withClientId("https://x.supabase.co/functions/v1/ai", { headers: { apikey: "k" } });
    expect(seen[0].get("x-writ-client")).toBe(CLIENT_ID);
    expect(seen[0].get("apikey")).toBe("k");
    expect(seen[1].get("x-writ-client")).toBeNull();
    expect(CLIENT_ID).toMatch(/^web-/);
  });
});
