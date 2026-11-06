import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { cardsToCsv, CARD_TYPES, parseCards, type CheckedRow } from "../lib/cards";
import { readFileText } from "../lib/files";
import { DATA_PROMPT, INSIGHT_PROMPT } from "../lib/sections";
import { formatCost, plural } from "../lib/format";
import { useShowCosts } from "../lib/showCosts";
import { CARD_TYPE_LABELS, type Card, type CardFields, type CardType } from "../lib/types";
import { useSetupStatus } from "../components/Layout";
import { CardForm, emptyCard } from "../components/CardForm";
import { AiAction, ErrorText, Loading, Modal, PromptHelper, Tabs, CleanTextarea } from "../components/ui";
import { StepNav } from "../components/StepNav";

type Mode = "insights" | "data";

const COPY: Record<Mode, { title: string; lede: string; empty: string }> = {
  insights: {
    title: "Insights",
    lede: "Stories, opinions, technical details, quotes and lessons only your company can tell. The test for each card: could a competitor write this sentence? Writing stages pull in only the cards relevant to a piece.",
    empty: "Cards are the stories, opinions and lessons only you can tell. Import the output of the per-call prompt, extract them from a transcript, or add one by hand.",
  },
  data: {
    title: "Proprietary data",
    lede: "Figures your company measured itself. They're first-party evidence a competitor can't cite. Most companies only have a few; that's fine.",
    empty: "Figures you've measured yourselves. Paste the output of the prompt below, or add one by hand.",
  },
};

export function CardsPage({ mode }: { mode: Mode }) {
  const company = useCompany();
  const { refresh } = useSetupStatus();
  const { data: cards, error, loading, reload } = useLoad(async () => {
    let q = supabase.from("cards").select("*").eq("company_id", company.id).order("created_at", { ascending: false });
    q = mode === "data" ? q.eq("type", "data_point") : q.neq("type", "data_point");
    return must<Card[]>(await q);
  }, [company.id, mode]);

  const [query, setQuery] = useState("");
  const [type, setType] = useState<CardType | "">("");
  const [citation, setCitation] = useState("");
  const [tag, setTag] = useState("");
  const [modal, setModal] = useState<"add" | "import" | "extract" | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const allTags = useMemo(() => [...new Set((cards ?? []).flatMap((c) => c.tags))].sort(), [cards]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cards ?? []).filter((c) =>
      (!type || c.type === type) &&
      (!citation || c.citation === citation) &&
      (!tag || c.tags.includes(tag)) &&
      (!q || `${c.claim} ${c.detail} ${c.source_who} ${c.source_where}`.toLowerCase().includes(q))
    );
  }, [cards, query, type, citation, tag]);

  const changed = () => { reload(); refresh(); };

  async function insertCards(list: CardFields[], origin: Card["origin"]) {
    const { data: auth } = await supabase.auth.getUser();
    const batch = crypto.randomUUID();
    for (let i = 0; i < list.length; i += 200) {
      must(await supabase.from("cards").insert(
        list.slice(i, i + 200).map((c) => ({ ...c, company_id: company.id, created_by: auth.user!.id, origin, import_batch: origin === "manual" ? null : batch })),
      ).select("id"));
    }
    changed();
  }

  async function saveEdit(id: string, fields: CardFields) {
    try {
      must(await supabase.from("cards").update(fields).eq("id", id).select("id"));
      setEditing(null);
      changed();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function remove(card: Card) {
    if (!window.confirm(`Delete "${card.claim}"?`)) return;
    try {
      must(await supabase.from("cards").delete().eq("id", card.id).select("id"));
      changed();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  function exportCsv() {
    const blob = new Blob([cardsToCsv(shown)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${company.name}-${mode}.csv`.replace(/\s+/g, "-").toLowerCase();
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const copy = COPY[mode];
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link>{mode === "data" ? " · optional" : ""}</span>
        <h1>{copy.title}</h1>
        <p className="muted">{copy.lede}</p>
      </div>

      {mode === "insights" ? (
        <PromptHelper title="Run this on every call transcript and keep the answer in its own column" prompt={INSIGHT_PROMPT}>
          <p className="small muted">
            Call summaries lose the details that make insights useful. Run this prompt on each transcript in your AI
            tool and store the answer in a separate column. Then export that column (or the sheet as CSV) and import it
            here. 1,000 calls give you 1,000 rows of insight.
          </p>
        </PromptHelper>
      ) : (
        <PromptHelper title="Pull your own figures out of reports with your AI tool" prompt={DATA_PROMPT} />
      )}

      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setModal("import")}>Import</button>
        {mode === "insights" && <button type="button" className="btn" onClick={() => setModal("extract")}>Extract from a transcript</button>}
        <button type="button" className="btn" onClick={() => setModal("add")}>Add by hand</button>
        <span className="spacer" />
        {shown.length > 0 && <button type="button" className="btn btn-quiet" onClick={exportCsv}>Export CSV</button>}
      </div>

      {(cards?.length ?? 0) > 0 && (
        <div className="toolbar">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cards" aria-label="Search cards" />
          {mode === "insights" && (
            <select value={type} onChange={(e) => setType(e.target.value as CardType | "")} aria-label="Filter by type">
              <option value="">All types</option>
              {CARD_TYPES.filter((t) => t !== "data_point").map((t) => <option key={t} value={t}>{CARD_TYPE_LABELS[t]}</option>)}
            </select>
          )}
          <select value={citation} onChange={(e) => setCitation(e.target.value)} aria-label="Filter by citation">
            <option value="">Public and internal</option>
            <option value="public">Public only</option>
            <option value="internal">Internal only</option>
          </select>
          {allTags.length > 0 && (
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
              <option value="">All tags</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <span className="small faint">{plural(shown.length, "card")}</span>
        </div>
      )}

      <ErrorText>{error ?? actionError}</ErrorText>
      {loading && !cards ? <Loading /> : cards?.length === 0 ? (
        <EmptyState icon={mode === "data" ? "chart" : "quote"} title={mode === "data" ? "No data points yet" : "No insight cards yet"}>
          <p>{copy.empty}</p>
        </EmptyState>
      ) : (
        <div className="card-list">
          {shown.map((c) => editing?.id === c.id ? (
            <div key={c.id} className="card">
              <CardForm initial={c} dataOnly={mode === "data"} submitLabel="Save card" onSubmit={(f) => saveEdit(c.id, f)} onCancel={() => setEditing(null)} />
            </div>
          ) : (
            <CardView key={c.id} card={c} onEdit={() => setEditing(c)} onDelete={() => remove(c)} />
          ))}
        </div>
      )}

      <StepNav />
      {modal === "add" && (
        <Modal title={mode === "data" ? "Add a data point" : "Add an insight"} onClose={() => setModal(null)}>
          <CardForm
            initial={emptyCard(mode === "data" ? "data_point" : "opinion")}
            dataOnly={mode === "data"}
            submitLabel="Add card"
            onSubmit={async (f) => {
              try { await insertCards([f], "manual"); setModal(null); } catch (err) { setActionError(errorMessage(err)); }
            }}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "import" && (
        <ImportCards mode={mode} onClose={() => setModal(null)} onImport={async (list) => { await insertCards(list, "import"); setModal(null); }} />
      )}
      {modal === "extract" && (
        <ExtractCards companyId={company.id} onClose={() => setModal(null)} onSave={async (list) => { await insertCards(list, "extraction"); setModal(null); }} />
      )}
    </div>
  );
}

function CardView({ card, draft, onEdit, onDelete, children }: {
  card: CardFields;
  draft?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <article className={`insight${draft ? " draft" : ""}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="tag">{CARD_TYPE_LABELS[card.type]}</span>
        <span className={`tag ${card.citation === "public" ? "ok" : ""}`}>{card.citation}</span>
        <span className="spacer" />
        {onEdit && <button type="button" className="btn btn-quiet btn-small" onClick={onEdit}>Edit</button>}
        {onDelete && <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={onDelete}>Delete</button>}
        {children}
      </div>
      {card.type === "data_point" && (
        <p className="datum">{card.value}{card.unit ? <span className="small muted"> {card.unit}</span> : null}</p>
      )}
      <p className="claim">{card.claim}</p>
      {card.detail && <p className="detail">{card.detail}</p>}
      <div className="meta">
        {[card.source_who, card.source_where, card.source_date, card.period, card.sample_size && `n = ${card.sample_size}`]
          .filter(Boolean).join(" · ")}
        {card.tags.map((t) => <span key={t} className="tag">{t}</span>)}
      </div>
    </article>
  );
}

function ImportCards({ mode, onClose, onImport }: { mode: Mode; onClose: () => void; onImport: (cards: CardFields[]) => Promise<void> }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<CheckedRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function check(source: string) {
    const parsed = parseCards(source, mode === "data" ? "data_point" : undefined).rows;
    const filtered = mode === "data"
      ? parsed.map((r) => r.card && r.card.type !== "data_point" ? { ...r, card: null, problems: ["Not a data point (import it under Insights)"] } : r)
      : parsed.map((r) => r.card?.type === "data_point" ? { ...r, card: null, problems: ["Data point (import it under Proprietary data)"] } : r);
    setRows(filtered);
  }

  const good = (rows ?? []).filter((r) => r.card).map((r) => r.card!);
  const bad = (rows ?? []).filter((r) => !r.card);

  return (
    <Modal title={mode === "data" ? "Import data points" : "Import insight cards"} onClose={onClose}>
      {!rows ? (
        <div className="stack">
          <p className="small muted">
            Paste a CSV with a header row (type, claim, detail, source_who, source_where, source_date, citation, tags,
            value, unit, period, sample_size), the JSON the prompt returns, or a spreadsheet column with one JSON
            answer per row.
          </p>
          <CleanTextarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste here" aria-label="Cards to import" />
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => check(text)}>Check</button>
            <span className="small muted">or</span>
            <input type="file" accept=".csv,.json,.txt" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { check(await readFileText(f)); } catch (err) { setError(errorMessage(err)); }
            }} aria-label="Upload CSV or JSON" />
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>
            <strong>{plural(good.length, "card")}</strong> ready to import
            {bad.length > 0 && <>; <span className="error">{plural(bad.length, "row")} with problems will be skipped</span></>}.
          </p>
          {bad.length > 0 && (
            <table className="plain">
              <thead><tr><th>Row</th><th>Problem</th></tr></thead>
              <tbody>
                {bad.slice(0, 50).map((r) => <tr key={r.row}><td className="mono">{r.row}</td><td>{r.problems.join("; ")}</td></tr>)}
              </tbody>
            </table>
          )}
          {good.slice(0, 3).map((c, i) => <CardView key={i} card={c} draft />)}
          {good.length > 3 && <p className="small muted">…and {good.length - 3} more.</p>}
          <ErrorText>{error}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || good.length === 0} onClick={async () => {
              setBusy(true);
              try { await onImport(good); } catch (err) { setError(errorMessage(err)); setBusy(false); }
            }}>
              {busy ? "Importing…" : `Import ${plural(good.length, "card")}`}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setRows(null)} disabled={busy}>Back</button>
          </div>
        </div>
      )}
      {!rows && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}

function ExtractCards({ companyId, onClose, onSave }: { companyId: string; onClose: () => void; onSave: (cards: CardFields[]) => Promise<void> }) {
  const [step, setStep] = useState<"input" | "review">("input");
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const [where, setWhere] = useState("");
  const [date, setDate] = useState("");
  const [drafts, setDrafts] = useState<CheckedRow[]>([]);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"paste" | "upload">("paste");
  const showCosts = useShowCosts();

  const kept = drafts.filter((d, i) => d.card && keep.has(i)).map((d) => d.card!);

  return (
    <Modal title="Extract insights from a transcript" onClose={onClose}>
      {step === "input" ? (
        <div className="stack">
          <p className="small muted">
            AI suggests cards; nothing is saved until you choose which to keep. The transcript itself isn't stored.
          </p>
          <Tabs value={tab} onChange={setTab} options={[{ value: "paste", label: "Paste" }, { value: "upload", label: "Upload file" }]} />
          {tab === "paste" ? (
            <CleanTextarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full transcript or notes" aria-label="Transcript" />
          ) : (
            <input type="file" accept=".txt,.md,.docx,.pdf" aria-label="Transcript file" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { setText(await readFileText(f)); setTab("paste"); } catch (err) { setError(errorMessage(err)); }
            }} />
          )}
          <div className="grid-3">
            <label className="field"><span>Who (if known)</span><input type="text" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Jane Doe, CFO at Acme" /></label>
            <label className="field"><span>Where</span><input type="text" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Discovery call" /></label>
            <label className="field"><span>When</span><input type="text" value={date} onChange={(e) => setDate(e.target.value)} placeholder="2026-10-21" /></label>
          </div>
          <ErrorText>{error}</ErrorText>
          <AiAction<{ cards: Record<string, unknown>[]; cost_usd: number | null }>
            label="Find insights"
            disabled={text.trim().length < 200}
            reason="Paste at least a few paragraphs (200+ characters)"
            payload={{ task: "extract_cards", company_id: companyId, text, source_who: who, source_where: where, source_date: date }}
            onDone={(r) => {
              const rows = r.cards.map((c, i) => parseCards(JSON.stringify([c])).rows[0] ?? { row: i + 1, card: null, problems: ["Unreadable"] });
              setDrafts(rows);
              setKeep(new Set(rows.flatMap((d, i) => (d.card ? [i] : []))));
              setCost(r.cost_usd);
              setStep("review");
            }}
          />
          {text.trim().length > 0 && text.trim().length < 200 && <p className="small faint">Paste the full transcript; this is too short.</p>}
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            {drafts.length === 0
              ? "Nothing passed the test: no insight here that a competitor couldn't also say."
              : `${plural(drafts.length, "suggestion")}. Keep the ones that are true and specific; edit them later if needed.`}
            {showCosts && cost !== null && ` This run cost ${formatCost(cost)}.`}
          </p>
          <div className="card-list">
            {drafts.map((d, i) => d.card ? (
              <div key={i} className={keep.has(i) ? "" : "is-discarded"}>
                <CardView card={d.card} draft>
                  <label className="row small" style={{ gap: 6 }}>
                    <input type="checkbox" checked={keep.has(i)} onChange={() => setKeep((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                    Keep
                  </label>
                </CardView>
              </div>
            ) : (
              <p key={i} className="error small">Suggestion {i + 1} was skipped: {d.problems.join("; ")}</p>
            ))}
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || kept.length === 0} onClick={async () => {
              setBusy(true);
              try { await onSave(kept); } catch (err) { setError(errorMessage(err)); setBusy(false); }
            }}>
              {busy ? "Saving…" : `Save ${plural(kept.length, "card")}`}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setStep("input")} disabled={busy}>Back</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
