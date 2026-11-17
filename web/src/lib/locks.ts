import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { CLIENT_ID } from "./clientId";

/**
 * Edit locks, from the app's side. One person (or one Claude) at a time works on each step of a piece: the scope, the research,
 * the outline, each section's text, and the final checks and sign-off. The lock is taken on the first edit, renewed while work
 * goes on, and frees itself a few minutes after the last activity. The database enforces it (see
 * supabase/migrations/20261129000000_edit_locks.sql and 20261130000000_lock_every_step.sql); this hook is how the screen takes it
 * and shows who holds it.
 *
 * A lock keeps two people from saving at once. It does not tell a tab that what it is showing has gone out of date (someone saved
 * while this tab was locked out): the screens compare with what is saved before they write, and ask.
 */
export type LockScope = "scope" | "research" | "outline" | "section" | "final";

export interface LockHolder {
  label: string;
  kind: "person" | "ai";
  /** When they took it, as an ISO time. */
  since: string;
}

type Acquired = { ok: true; token: string; expires_at: string } | { ok: false; holder_label: string; holder_kind: "person" | "ai"; since: string; expires_at: string };

const NIL = "00000000-0000-0000-0000-000000000000";
const POLL_MS = 10_000;
const RENEW_MS = 60_000;
/** A lock is renewed only while the writer has done something in the last three minutes. */
const ACTIVE_MS = 180_000;

/** Whether an error says the lock functions aren't in the database yet (the app is ahead of the migration): then nothing is locked. */
export const lockUnavailable = (err: { code?: string; message?: string } | null | undefined) =>
  Boolean(err && (err.code === "PGRST202" || err.code === "42883" || err.code === "42P01" || /acquire_lock|edit_locks/.test(err.message ?? "")));

/** "Adarsh is editing the outline since 14:02", for a banner. */
export function holderText(h: LockHolder, what: string): string {
  const time = new Date(h.since);
  const at = Number.isNaN(time.getTime()) ? "" : ` since ${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return `${h.label} is editing ${what}${at}.`;
}

async function acquire(pieceId: string, scope: LockScope, sectionId: string | null, takeOver: boolean): Promise<Acquired | "unavailable"> {
  const { data, error } = await supabase.rpc("acquire_lock", {
    target_piece: pieceId, lock_scope: scope, target_section: sectionId, client: CLIENT_ID, kind: "person", take_over: takeOver, lease_seconds: 180,
  });
  if (error) {
    if (lockUnavailable(error)) return "unavailable";
    throw error;
  }
  return data as Acquired;
}

const LOCK_WORDS: Record<LockScope, string> = {
  scope: "the scope", research: "the research", outline: "the outline", section: "this section", final: "the final checks and sign-off",
};

/**
 * For a one-off write outside the step that owns the lock (a scope point edited from the outline's check, a research item
 * approved there): takes the lock, runs the write, lets go. Someone else holding it means nothing is written and the writer is
 * told who. Do not use it for a lock this tab already holds through useEditLock: letting go would drop that one.
 */
export async function withShortLock<T>(pieceId: string, scope: LockScope, fn: () => Promise<T>): Promise<T> {
  // This tab already holds that lock (a step is open on it, or an overlapping short lock): take nothing, and let go of nothing.
  const key = `${pieceId}:${scope}`;
  if (heldHere.get(key)?.() || shortHeld.has(key)) return fn();
  shortHeld.add(key);
  try {
    return await takeAndRun(pieceId, scope, fn);
  } finally {
    shortHeld.delete(key);
  }
}

/** Locks this tab holds through useEditLock, by piece and kind (section locks are not piece-wide and are left out). */
const heldHere = new Map<string, () => boolean>();
const shortHeld = new Set<string>();

async function takeAndRun<T>(pieceId: string, scope: LockScope, fn: () => Promise<T>): Promise<T> {
  let got: Acquired | "unavailable";
  try {
    got = await acquire(pieceId, scope, null, false);
  } catch {
    return fn(); // the lock can't be reached (the network): the database still refuses a write someone else's lock should stop
  }
  if (got !== "unavailable" && !got.ok) {
    throw new Error(`${got.holder_label} is editing ${LOCK_WORDS[scope]}. Wait until they finish, or take over from that step.`);
  }
  try {
    return await fn();
  } finally {
    if (got !== "unavailable" && got.ok) {
      void supabase.rpc("release_lock", { target_piece: pieceId, lock_scope: scope, target_section: null, client: CLIENT_ID, lock_token: got.token });
    }
  }
}

/**
 * Takes the lock on the first edit and holds it while the writer works. `enabled` is false when there is nothing to lock (the
 * outline is confirmed, the section is written): then `ensure` always says yes and nothing is shown.
 *
 * - `ensure()` is called before saving and on the first edit: true means this tab holds the lock; false means someone else does.
 *   A failure to reach the lock (the network) says yes: the database still refuses a save that someone else's lock should stop.
 * - `other` is who holds it when it isn't this tab (checked every few seconds), for the banner.
 * - `takeOver()` takes it from them.
 */
export function useEditLock(pieceId: string, scope: LockScope, sectionId: string | null, enabled: boolean) {
  const [other, setOther] = useState<LockHolder | null>(null);
  const mine = useRef(false);
  const token = useRef<string | null>(null);
  const expiresAt = useRef(0);
  const lastActive = useRef(0);
  // Counts the times this tab asked for the lock: a check of who holds it that began before the latest ask is out of date.
  const asked = useRef(0);
  const sid = sectionId ?? NIL;

  const [problem, setProblem] = useState<string | null>(null);
  const took = (r: { token: string; expires_at: string }) => {
    // A check of who holds it that began before this is out of date now.
    asked.current += 1;
    mine.current = true;
    token.current = r.token;
    expiresAt.current = Date.parse(r.expires_at);
    setOther(null);
  };

  // Lets a one-off write (withShortLock) know this tab already holds the lock, so it does not take it again and let go of it.
  useEffect(() => {
    if (scope === "section") return;
    const key = `${pieceId}:${scope}`;
    const holds = () => mine.current;
    heldHere.set(key, holds);
    return () => { if (heldHere.get(key) === holds) heldHere.delete(key); };
  }, [pieceId, scope]);

  // Who holds it, as seen from here.
  useEffect(() => {
    if (!enabled) { setOther(null); return; }
    let stop = false;
    async function read() {
      const startedAt = asked.current;
      const { data, error } = await supabase.from("edit_locks")
        .select("holder_client, holder_kind, holder_label, acquired_at")
        .eq("piece_id", pieceId).eq("scope", scope).eq("section_id", sid).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (stop || error || startedAt !== asked.current) return;
      if (data && data.holder_client !== CLIENT_ID) {
        mine.current = false;
        setOther({ label: data.holder_label, kind: data.holder_kind, since: data.acquired_at });
      } else {
        setOther(null);
        if (!data) mine.current = false;
      }
    }
    void read();
    const t = window.setInterval(read, POLL_MS);
    return () => { stop = true; window.clearInterval(t); };
  }, [pieceId, scope, sid, enabled]);

  // Keep it while the writer is working, and let it go when they leave.
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      if (!mine.current || Date.now() - lastActive.current > ACTIVE_MS) return;
      asked.current += 1;
      acquire(pieceId, scope, sectionId, false).then((r) => {
        if (r === "unavailable") return;
        if (r.ok) took(r);
        else { mine.current = false; setOther({ label: r.holder_label, kind: r.holder_kind, since: r.since }); }
      }).catch(() => { /* try again at the next renewal */ });
    }, RENEW_MS);
    return () => {
      window.clearInterval(t);
      if (mine.current) {
        mine.current = false;
        // Only this lock is let go: if the writer is back on the same section already and has taken a new one, it stays.
        void supabase.rpc("release_lock", { target_piece: pieceId, lock_scope: scope, target_section: sectionId, client: CLIENT_ID, lock_token: token.current });
      }
    };
  }, [pieceId, scope, sectionId, enabled]);

  const ensure = useCallback(async (): Promise<boolean> => {
    lastActive.current = Date.now();
    if (!enabled) return true;
    if (mine.current && expiresAt.current - Date.now() > 60_000) return true;
    asked.current += 1;
    try {
      const r = await acquire(pieceId, scope, sectionId, false);
      if (r === "unavailable") return true;
      if (r.ok) { took(r); return true; }
      mine.current = false;
      setOther({ label: r.holder_label, kind: r.holder_kind, since: r.since });
      return false;
    } catch {
      return true;
    }
  }, [pieceId, scope, sectionId, enabled]);

  const takeOver = useCallback(async () => {
    asked.current += 1;
    setProblem(null);
    try {
      const r = await acquire(pieceId, scope, sectionId, true);
      if (r === "unavailable") setProblem("Locking isn't available on this database yet.");
      else if (r.ok) { lastActive.current = Date.now(); took(r); }
    } catch (e) {
      setProblem(`Couldn't take over: ${e instanceof Error ? e.message : "try again."}`);
    }
  }, [pieceId, scope, sectionId]);

  return { other, ensure, takeOver, problem };
}
