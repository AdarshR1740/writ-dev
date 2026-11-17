import { createClient } from "@supabase/supabase-js";
import { CLIENT_ID } from "./clientId";

/** Set by /config.js on a hosted server; empty in development, where the values come from the build environment. */
const runtime = (typeof window !== "undefined" ? (window as { __WRIT_CONFIG__?: { supabaseUrl?: string; supabaseAnonKey?: string } }).__WRIT_CONFIG__ : undefined) ?? {};
const url = runtime.supabaseUrl || (import.meta.env.VITE_SUPABASE_URL as string | undefined);
const anonKey = runtime.supabaseAnonKey || (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

export const configured = Boolean(url && anonKey);

/**
 * Says which tab is asking, on database requests only (not on edge function calls, which have their own allowed headers), so the
 * database can tell this tab from another one and from Claude when it checks edit locks.
 */
export const withClientId: typeof fetch = (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!href.includes("/rest/v1/")) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-writ-client", CLIENT_ID);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(url ?? "http://localhost", anonKey ?? "missing", {
  auth: { persistSession: true, autoRefreshToken: true },
  global: { fetch: withClientId },
});

/**
 * A server function refused because someone else holds the edit lock (they took it over while the AI was running), and sent back
 * what the AI had produced so the writer does not lose it.
 */
export class UnsavedResultError extends Error {
  constructor(message: string, public unsaved: unknown, public task: string) {
    super(message);
  }
}

/** Tells the page to show an AI result that could not be saved (see UnsavedResult). */
export const UNSAVED_EVENT = "writ:unsaved";

/**
 * Call one of our edge functions; throws an Error with the server's message. The body carries this tab's client id: the
 * function takes the edit lock as this tab, so it can tell this tab from another one and from Claude.
 */
export async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: { ...body, client: CLIENT_ID } });
  if (error) {
    let message = error.message;
    // The browser got no response at all: offline, the function was being redeployed, or the run took too long.
    if (/failed to send a request|failed to fetch/i.test(message)) {
      message = "Couldn't reach the server, so nothing was saved by this step. This usually passes: wait a few seconds and try again. If it keeps happening on the same piece, the run may be taking too long.";
    }
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      const payload = await ctx.json().catch(() => null);
      if (payload?.error) message = payload.error;
      if (payload && payload.code === "edit_locked" && payload.unsaved != null) {
        const task = String(body.task ?? body.action ?? name);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UNSAVED_EVENT, { detail: { message, unsaved: payload.unsaved, task } }));
        throw new UnsavedResultError(message, payload.unsaved, task);
      }
    }
    throw new Error(message);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message
    : err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message)
    : "Something went wrong.";
  // A change refused because someone else holds the edit lock: say it plainly.
  return raw.startsWith("edit_locked:") ? `${raw.replace(/^edit_locked:\s*/, "")}. Use "Take over" in the banner to continue, or wait until they finish.` : raw;
}
