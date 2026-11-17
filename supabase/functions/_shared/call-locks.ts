// Edit locks for Writ's own server functions.
//
// A server function writes with the service role, which the database's lock triggers do not check. So it takes the same lock a
// browser tab would: as the person who made the call and from that person's tab (the "client" id the web app sends in the request
// body). Rules:
//   - it takes the lock before it spends anything on the AI, and refuses at once, naming who is editing, if someone else holds it;
//   - if the caller's own tab already holds the lock, nothing changes hands: the call is counted, and the tab keeps its lock. Calls
//     running side by side from one tab share the lock, and the last one out lets go of a lock a call took;
//   - right before it writes, it checks again (assertStillHeld). If someone took the lock over meanwhile, it writes nothing and
//     sends the result back with the refusal, so the writer does not lose what the AI produced.
// A database without the call-lock functions yet behaves as before.

import { AsyncLocalStorage } from "node:async_hooks";
import { admin } from "./supabase.ts";
import { UserError } from "./cors.ts";

export type LockScope = "scope" | "research" | "outline" | "section" | "final";
export type Need = { scope: LockScope; sectionId?: string | null };

const WORDS: Record<LockScope, string> = {
  scope: "the scope", research: "the research", outline: "the outline", section: "this section", final: "the final checks and sign-off",
};

type Held = { pieceId: string; scope: LockScope; sectionId: string | null; client: string; token: string | null };
type Store = { held: Held[] };
const store = new AsyncLocalStorage<Store>();

const functionsMissing = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || /call_lock_/.test(e.message ?? "") && /does not exist|Could not find/i.test(e.message ?? "");

/** The tab that made the call: sent in the request body by the web app. */
export function clientOf(body: Record<string, unknown>): string {
  const c = typeof body.client === "string" ? body.client.trim().slice(0, 120) : "";
  // A caller that sends no client (an old page, another tool) is still one client, so another tab is kept out.
  return c || `fn-${crypto.randomUUID()}`;
}

function when(since: unknown): string {
  const t = new Date(String(since ?? ""));
  return Number.isNaN(t.getTime()) ? "" : ` (since ${t.toISOString().slice(11, 16)} UTC)`;
}

/** Runs one request's work; whatever locks it took with takeCallLocks are let go when it ends, however it ends. */
export async function callLockScope<T>(fn: () => Promise<T>): Promise<T> {
  const s: Store = { held: [] };
  try {
    return await store.run(s, fn);
  } finally {
    await Promise.all(s.held.filter((h) => h.token).map((h) =>
      Promise.resolve(admin.rpc("call_lock_release", {
        target_piece: h.pieceId, lock_scope: h.scope, target_section: h.sectionId, client: h.client, lock_token: h.token,
      })).catch(() => undefined)));
  }
}

/** Takes the locks a function needs, for the person it acts for. Refuses, naming who is editing, when someone else holds one. */
export async function takeCallLocks(userId: string, client: string, pieceId: string, needs: Need[]): Promise<void> {
  const s = store.getStore();
  if (!s) throw new Error("takeCallLocks must run inside callLockScope");
  for (const n of needs) {
    const sectionId = n.scope === "section" ? n.sectionId ?? null : null;
    const { data, error } = await admin.rpc("call_lock_acquire", {
      target_piece: pieceId, lock_scope: n.scope, target_section: sectionId, client, for_user: userId, lease_seconds: 300,
    });
    if (error) {
      if (functionsMissing(error)) return;
      if (/piece not found/.test(error.message)) throw new UserError("Piece not found.", 404);
      throw error;
    }
    const r = data as { ok: boolean; token?: string; holder_label?: string; since?: string };
    if (!r?.ok) {
      throw new UserError(
        `${r?.holder_label ?? "Someone"} is editing ${WORDS[n.scope]} in Writ${when(r?.since)}. Nothing was changed. Wait until they finish, or use "Take over" in the banner there.`,
        409,
      );
    }
    // Every call is counted, whether it took the lock or the tab already held it; the database lets go only after the last one.
    s.held.push({ pieceId, scope: n.scope, sectionId, client, token: r.token ?? null });
  }
}

/**
 * Call right before writing. If someone else now holds a lock this call took, nothing is written: the refusal carries `unsaved`
 * (what the AI produced), which the web app shows to the writer so it is not lost.
 */
export async function assertStillHeld(unsaved?: unknown): Promise<void> {
  const s = store.getStore();
  if (!s) return;
  for (const h of s.held) {
    const { data, error } = await admin.rpc("call_lock_check", {
      target_piece: h.pieceId, lock_scope: h.scope, target_section: h.sectionId, client: h.client,
    });
    if (error) continue;
    const r = data as { ok: boolean; holder_label?: string; since?: string };
    if (r && r.ok === false) {
      throw new UserError(
        `${r.holder_label ?? "Someone"} took over ${WORDS[h.scope]} while this was running${when(r.since)}, so the result was not saved. It is shown below so you can keep it.`,
        409,
        { code: "edit_locked", unsaved: unsaved ?? null },
      );
    }
  }
}

/** Which locks an AI task needs, and which piece they are on. Tasks that only propose (nothing is written) need none. */
export async function aiLockPlan(task: string, body: Record<string, unknown>): Promise<{ pieceId: string; needs: Need[] } | null> {
  const sectionId = body.section_id ? String(body.section_id) : null;
  let needs: Need[];
  switch (task) {
    case "analysis":
    case "analysis_verify":
    case "seo_geo_verify":
      needs = [{ scope: "outline" }]; break;
    case "seo_geo_check":
      needs = [{ scope: body.scope === "final" ? "final" : "outline" }]; break;
    case "section_points":
      needs = [{ scope: "section", sectionId }, { scope: "research" }]; break;
    case "section_draft":
    case "grammar_check":
    case "fact_check":
    case "seo_fix_apply":
      needs = [{ scope: "section", sectionId }]; break;
    case "contract_check":
      needs = [sectionId ? { scope: "section", sectionId } : { scope: "final" }]; break;
    default:
      return null;
  }
  if (needs.some((n) => n.scope === "section") && !sectionId) return null;
  let pieceId = body.piece_id ? String(body.piece_id) : "";
  if (!pieceId && sectionId) {
    const { data } = await admin.from("piece_sections").select("piece_id").eq("id", sectionId).maybeSingle();
    pieceId = data?.piece_id ?? "";
  }
  return pieceId ? { pieceId, needs } : null;
}
