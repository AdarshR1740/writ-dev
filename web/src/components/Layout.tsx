import { createContext, useContext, useState, type ReactNode } from "react";
import { LogoMark, Wordmark } from "./Logo";
import { AskWrit } from "./AskWrit";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { DOC_SECTIONS } from "../lib/sections";
import type { DocKind } from "../lib/types";

export interface SetupStatus {
  docs: Record<string, { id: string; filled: boolean; pending: boolean }>;
  formats: { id: string; name: string; documentId: string | null; filled: boolean; pending: boolean }[];
  insightCount: number;
  dataCount: number;
  hasActiveKey: boolean;
}

async function loadStatus(companyId: string): Promise<SetupStatus> {
  const [docs, proposals, formats, cards, keys] = await Promise.all([
    supabase.from("context_documents").select("id, kind, format_id, content").eq("company_id", companyId)
      .then(must<{ id: string; kind: DocKind; format_id: string | null; content: string }[]>),
    supabase.from("document_proposals").select("document_id").eq("company_id", companyId).eq("status", "pending")
      .then(must<{ document_id: string }[]>),
    supabase.from("formats").select("id, name").eq("company_id", companyId).order("created_at")
      .then(must<{ id: string; name: string }[]>),
    supabase.from("cards").select("type").eq("company_id", companyId).then(must<{ type: string }[]>),
    supabase.from("provider_keys").select("is_active").eq("company_id", companyId).eq("is_active", true)
      .then(must<{ is_active: boolean }[]>),
  ]);
  const pending = new Set(proposals.map((p) => p.document_id));
  const status: SetupStatus = {
    docs: {},
    formats: [],
    insightCount: cards.filter((c) => c.type !== "data_point").length,
    dataCount: cards.filter((c) => c.type === "data_point").length,
    hasActiveKey: keys.length > 0,
  };
  for (const d of docs) {
    if (d.kind !== "format_profile") {
      status.docs[d.kind] = { id: d.id, filled: d.content.trim().length > 0, pending: pending.has(d.id) };
    }
  }
  status.formats = formats.map((f) => {
    const d = docs.find((x) => x.format_id === f.id);
    return { id: f.id, name: f.name, documentId: d?.id ?? null, filled: Boolean(d?.content.trim()), pending: d ? pending.has(d.id) : false };
  });
  return status;
}

const StatusCtx = createContext<{ status: SetupStatus | null; refresh: () => void }>({ status: null, refresh: () => {} });
export const useSetupStatus = () => useContext(StatusCtx);

function Dot({ filled, pending }: { filled: boolean; pending: boolean }) {
  const cls = pending ? "pending" : filled ? "done" : "";
  const label = pending ? "changes to review" : filled ? "done" : "not started";
  return <span className={`dot ${cls}`} role="img" aria-label={label} title={label[0].toUpperCase() + label.slice(1)} />;
}

export function Layout({ children }: { children: ReactNode }) {
  const { companies, company, selectCompany, session } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { data: status, reload } = useLoad(() => loadStatus(company!.id), [company?.id, location.pathname]);

  const formatsFilled = (status?.formats ?? []).some((f) => f.filled);
  const formatsPending = (status?.formats ?? []).some((f) => f.pending);
  // The house file folds into one entry; its parts show only while you're in it.
  const inHouseFile = /^\/(house-file|setup|formats|insights|data|voice-memory|voices)(\/|$)/.test(location.pathname);
  const required = [
    ...DOC_SECTIONS.filter((d) => d.required).map((d) => Boolean(status?.docs[d.kind]?.filled)),
    formatsFilled,
    (status?.insightCount ?? 0) > 0,
  ];
  const houseTotal = required.length;
  const houseDone = required.filter(Boolean).length;
  const housePending = formatsPending || Object.values(status?.docs ?? {}).some((d) => d?.pending);

  return (
    <StatusCtx.Provider value={{ status, refresh: reload }}>
      <div className={`shell${navOpen ? " nav-open" : ""}`}>
        <div className="mobile-bar">
          <button type="button" className="btn btn-small" onClick={() => setNavOpen((v) => !v)} aria-expanded={navOpen}>
            Menu
          </button>
          <LogoMark size={22} title="Writ" />
          <strong>{company?.name}</strong>
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={() => setAsking(true)}>Ask</button>
        </div>
        <nav className="sidebar" aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest("a") && setNavOpen(false)}>
          <div className="brand"><Wordmark size={24} /></div>

          <label className="field company-switch">
            <span>Company</span>
            <select
              value={company?.id ?? ""}
              onChange={(e) => (e.target.value === "__new" ? navigate("/new-company") : selectCompany(e.target.value))}
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new">+ Add a company…</option>
            </select>
          </label>

          <button type="button" className="ask-button" onClick={() => { setAsking(true); setNavOpen(false); }} aria-expanded={asking}>
            <span aria-hidden="true">?</span> Ask Writ
            <span className="small faint">your own material</span>
          </button>

          <div className="nav-group">
            <p>Writing</p>
            <NavLink to="/pieces" className="nav-link nav-primary"><span className="nav-icon" aria-hidden="true">✎</span>Write</NavLink>
            <NavLink to="/history" className="nav-link">History</NavLink>
            <NavLink to="/library" className="nav-link">Source library</NavLink>
          </div>

          <div className="nav-group">
            <p>Company</p>
            <NavLink to="/house-file" className={() => `nav-link${inHouseFile ? " active" : ""}`} aria-expanded={inHouseFile}>
              <Dot filled={houseDone === houseTotal} pending={housePending} />
              House file
              <span className="count" title={`${houseDone} of ${houseTotal} required parts in place`}>{status ? `${houseDone}/${houseTotal}` : ""}</span>
            </NavLink>
            {inHouseFile && (
              <div className="nav-sub">
                {DOC_SECTIONS.map((s) => {
                  const st = status?.docs[s.kind];
                  return (
                    <NavLink key={s.kind} to={`/setup/${s.path}`} className="nav-link">
                      <Dot filled={Boolean(st?.filled)} pending={Boolean(st?.pending)} />
                      {s.title}
                    </NavLink>
                  );
                })}
                <NavLink to="/voice-memory" className="nav-link sub" title="Rules learned from your finished pieces, part of the core voice">Voice memory</NavLink>
                <NavLink to="/voices" className="nav-link sub" title="How particular leaders write, so a finished piece can be edited to sound like them">Leader voices</NavLink>
                <NavLink to="/formats" className="nav-link">
                  <Dot filled={formatsFilled} pending={formatsPending} />
                  Formats
                  <span className="count">{status?.formats.length ?? ""}</span>
                </NavLink>
                <NavLink to="/insights" className="nav-link">
                  <Dot filled={(status?.insightCount ?? 0) > 0} pending={false} />
                  Insights
                  <span className="count">{status?.insightCount ?? ""}</span>
                </NavLink>
                <NavLink to="/data" className="nav-link">
                  <Dot filled={(status?.dataCount ?? 0) > 0} pending={false} />
                  Proprietary data
                  <span className="count">{status?.dataCount ?? ""}</span>
                </NavLink>
                <div className="nav-legend" aria-hidden="true">
                  <span><span className="dot done" /> done</span>
                  <span><span className="dot pending" /> to review</span>
                  <span><span className="dot" /> not started</span>
                </div>
              </div>
            )}
            <NavLink to="/team" className="nav-link">Team &amp; settings</NavLink>
            <NavLink to="/ai" className="nav-link">AI provider &amp; models</NavLink>
            <NavLink to="/prompts" className="nav-link">Prompts</NavLink>
          </div>

          <div className="sidebar-foot">
            <span className="faint">{session?.user.email}</span>
            <button type="button" className="btn btn-quiet btn-small" style={{ justifySelf: "start" }} onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </nav>
        <main className="main">{children}</main>
        {asking && <AskWrit onClose={() => setAsking(false)} />}
      </div>
    </StatusCtx.Provider>
  );
}
