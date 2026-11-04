// A company's own versions of Writ's prompts (Settings -> Prompts). Each task asks for its prompt
// by key and gets the company's version if it has one, otherwise the built-in text.

import { admin } from "./supabase.ts";

export type PromptSet = (key: string, builtIn: string) => string;

/** The built-in prompts, unchanged. For code paths with no company (and tests). */
export const BUILT_IN: PromptSet = (_key, builtIn) => builtIn;

export async function promptSet(companyId: string): Promise<PromptSet> {
  const { data, error } = await admin.from("prompt_overrides").select("prompt_key, text").eq("company_id", companyId);
  // If the lookup fails, fall back to the built-in prompts rather than stopping the writer's work.
  if (error) console.error("prompt overrides lookup failed", error);
  const mine = new Map((data ?? []).map((r) => [r.prompt_key as string, r.text as string]));
  return (key, builtIn) => mine.get(key) ?? builtIn;
}

/** Fill a {PLACEHOLDER} without treating "$" in the value as a replacement pattern. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{([A-Z_]+)\}/g, (whole, name) => (name in values ? values[name] : whole));
}
