import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "./supabase";

// Whether screens show what AI runs cost. Saved on the person's profile, so it follows the account across devices;
// the AI provider & models page always shows costs. The browser keeps a copy so pages don't flicker while it loads.
const KEY = "writ.showCosts";
const listeners = new Set<() => void>();

function readCache(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

let current = readCache();
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;

function publish(on: boolean) {
  current = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

// Signing out forgets the choice, so the next person on this browser doesn't inherit it.
supabase.auth.onAuthStateChange((event) => {
  if (event !== "SIGNED_OUT") return;
  loadedFor = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  current = true;
  listeners.forEach((l) => l());
});

/** Reads the saved choice once per signed-in user. If the column isn't deployed yet, the browser's copy stands. */
async function ensureLoaded(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const { data: auth } = await supabase.auth.getUser();
    const id = auth.user?.id ?? null;
    if (!id || id === loadedFor) return;
    // Marked before the query, so a failure (such as the column not being deployed yet) isn't retried on every screen.
    loadedFor = id;
    const { data, error } = await supabase.from("profiles").select("show_ai_costs").eq("id", id).maybeSingle();
    if (error || !data) return;
    publish(data.show_ai_costs !== false);
  })().finally(() => { loading = null; });
  return loading;
}

/** Saves the choice to the account. Rejects (and restores the old choice) if it couldn't be saved. */
export async function setShowCosts(on: boolean): Promise<void> {
  const before = current;
  publish(on);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  const { error } = await supabase.from("profiles").update({ show_ai_costs: on }).eq("id", auth.user.id);
  if (error) {
    publish(before);
    throw error;
  }
}

export function useShowCosts(): boolean {
  useEffect(() => { void ensureLoaded(); }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    () => current,
    () => true,
  );
}
