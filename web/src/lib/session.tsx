import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Company, Role } from "./types";

interface SessionState {
  session: Session | null;
  ready: boolean;
  companies: Company[];
  company: Company | null;
  selectCompany: (id: string) => void;
  refreshCompanies: () => Promise<Company[]>;
}

const Ctx = createContext<SessionState | null>(null);
const STORAGE_KEY = "writer.company";

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function remember(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // Whose company list is loaded. Until it matches the signed-in user, routing waits;
  // otherwise the first render after sign-in sees no companies and sends you to "Add a company".
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(remembered());

  const refreshCompanies = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return [];
    // RLS shows every membership in companies you belong to; only yours define your list and role.
    const { data, error } = await supabase
      .from("memberships")
      .select("role, companies(id, name)")
      .eq("user_id", auth.user.id)
      .order("created_at");
    if (error) throw error;
    const list: Company[] = (data ?? []).flatMap((m) => {
      const c = Array.isArray(m.companies) ? m.companies[0] : m.companies;
      return c ? [{ id: c.id as string, name: c.name as string, role: m.role as Role }] : [];
    });
    setCompanies(list);
    return list;
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session === undefined ? undefined : (session?.user.id ?? null);
  useEffect(() => {
    if (userId === undefined) return;
    if (userId === null) {
      setCompanies([]);
      setLoadedFor(null);
      return;
    }
    let live = true;
    refreshCompanies().catch(() => setCompanies([])).finally(() => { if (live) setLoadedFor(userId); });
    return () => { live = false; };
  }, [userId, refreshCompanies]);
  const ready = userId !== undefined && loadedFor === userId;

  const selectCompany = useCallback((id: string) => {
    setCompanyId(id);
    remember(id);
  }, []);

  const company = useMemo(
    () => companies.find((c) => c.id === companyId) ?? companies[0] ?? null,
    [companies, companyId],
  );

  return (
    <Ctx.Provider value={{ session: session ?? null, ready, companies, company, selectCompany, refreshCompanies }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside provider");
  return v;
}

/** The current company; only use inside routes that require one. */
export function useCompany(): Company {
  const { company } = useSession();
  if (!company) throw new Error("No company selected");
  return company;
}
