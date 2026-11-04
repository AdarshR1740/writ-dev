import { useEffect, useState } from "react";
import { BudgetAlert } from "../components/Budget";
import { EmptyState } from "../components/EmptyState";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import { STAGES, type Format, type Piece } from "../lib/types";
import { LONG_FORM, normalise, presetFor, stagesFor } from "../lib/recipes";
import { FORMAT_TEMPLATES } from "../lib/sections";
import { useSetupStatus } from "../components/Layout";
import { ErrorText, Loading, Modal, CleanTextarea } from "../components/ui";
import { GettingStarted } from "../components/GettingStarted";

type Row = Pick<Piece, "id" | "code" | "version" | "title" | "topic" | "primary_keyword" | "stage" | "format_id" | "revised_by" | "review_due_at" | "updated_at">;
const stageLabel = (s: Piece["stage"]) => (s === "done" ? "Done" : STAGES.find((x) => x.key === s)?.label ?? s);

export function PiecesPage() {
  const company = useCompany();
  const { status } = useSetupStatus();
  const [creating, setCreating] = useState(false);
  const { data, error } = useLoad(async () => {
    const [pieces, formats] = await Promise.all([
      supabase.from("pieces").select("id, code, version, title, topic, primary_keyword, stage, format_id, revised_by, review_due_at, updated_at")
        .eq("company_id", company.id).order("updated_at", { ascending: false }).then(must<Row[]>),
      supabase.from("formats").select("id, name").eq("company_id", company.id).order("name").then(must<{ id: string; name: string }[]>),
    ]);
    return { pieces, formats };
  }, [company.id]);


  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">{company.name}</span>
        <div className="row" style={{ alignItems: "center" }}>
          <h1 style={{ flex: 1 }}>Write</h1>
          {data && data.pieces.length > 0 && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Start a piece</button>}
        </div>
        <p className="muted">Your pieces, from first idea to sign-off. Open one to carry on where it stopped.</p>
      </div>
      <BudgetAlert companyId={company.id} />
      {data && <GettingStarted status={status ?? null} pieceCount={data.pieces.length} onStart={() => setCreating(true)} />}
      <ErrorText>{error}</ErrorText>
      {!data ? <Loading /> : data.pieces.length === 0 ? (
        <EmptyState icon="page" title="Nothing written yet"
          actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Start your first piece</button>}>
          <p>Every piece starts with a title and a format. The format decides the steps: a LinkedIn post skips the outline, a case study adds customer approval.</p>
        </EmptyState>
      ) : (
        <>
          <PieceList pieces={data.pieces} formats={data.formats} />
        </>
      )}
      {creating && <NewPiece onClose={() => setCreating(false)} />}
    </div>
  );
}

const NEXT_STEP: Record<Piece["stage"], string> = {
  contract: "Agree the reader contract",
  research: "Review the research",
  outline: "Confirm the outline",
  writing: "Keep writing",
  done: "",
};

/** Pieces in progress, or finished. One search box; format and older versions sit behind "Filters". */
function PieceList({ pieces, formats }: { pieces: Row[]; formats: { id: string; name: string }[] }) {
  const company = useCompany();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"active" | "done" | null>(null);
  const [format, setFormat] = useState("");
  const [older, setOlder] = useState(false);
  // Pieces whose written text matches the search (checked on the server).
  const [textHits, setTextHits] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 3) { setTextHits(new Set()); return; }
    let live = true;
    const t = setTimeout(async () => {
      const { data } = await supabase.from("piece_sections").select("piece_id")
        .eq("company_id", company.id).ilike("content", `%${q.replace(/[\%_]/g, "\$&")}%`).limit(500);
      if (live) setTextHits(new Set((data ?? []).map((r: { piece_id: string }) => r.piece_id)));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, company.id]);

  const today = new Date();
  const base = pieces.filter((p) => (older || !p.revised_by) && (!format || (format === "none" ? p.format_id === null : p.format_id === format)));
  const activeCount = base.filter((p) => p.stage !== "done").length;
  const doneCount = base.length - activeCount;
  // Open on "In progress", or on "Done" when nothing is in progress.
  const view = tab ?? (activeCount > 0 ? "active" : "done");
  const shown = q
    ? base.filter((p) => `${p.code} ${p.title} ${p.primary_keyword} ${p.topic}`.toLowerCase().includes(q) || textHits.has(p.id))
    : base.filter((p) => (view === "active") === (p.stage !== "done"));
  const formatName = (id: string | null) => (id ? formats.find((f) => f.id === id)?.name ?? "Format" : "No format");
  const groups = [...formats.map((f) => f.id), null]
    .map((id) => ({ id, name: formatName(id), items: shown.filter((p) => p.format_id === id) })).filter((g) => g.items.length);
  const filters = (format ? 1 : 0) + (older ? 1 : 0);
  const reviewDue = (p: Row) => p.stage === "done" && !p.revised_by && p.review_due_at && new Date(p.review_due_at) <= today;

  return (
    <div className="stack">
      <div className="list-bar">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your pieces" aria-label="Search pieces" />
        {!q && (
          <div className="seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={view === "active"} className={view === "active" ? "on" : ""} onClick={() => setTab("active")}>In progress <span className="faint">{activeCount}</span></button>
            <button type="button" role="tab" aria-selected={view === "done"} className={view === "done" ? "on" : ""} onClick={() => setTab("done")}>Done <span className="faint">{doneCount}</span></button>
          </div>
        )}
      </div>
      <details className="more-filters" open={filters > 0}>
        <summary className="small">Filters{filters > 0 ? ` (${filters})` : ""}</summary>
        <div className="row" style={{ flexWrap: "wrap", gap: "8px 16px", paddingTop: 8 }}>
          <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format">
            <option value="">All formats</option>
            {formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            <option value="none">No format</option>
          </select>
          <label className="check-label small"><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} /> Include older versions</label>
          {filters > 0 && <button type="button" className="link-btn small" onClick={() => { setFormat(""); setOlder(false); }}>Clear filters</button>}
        </div>
      </details>
      {q && <p className="small muted" aria-live="polite">{shown.length} {shown.length === 1 ? "piece matches" : "pieces match"} “{query.trim()}” across In progress and Done.</p>}
      {shown.length === 0 ? (
        <EmptyState icon="page" title={q ? "Nothing matches" : view === "active" ? "Nothing in progress" : "Nothing finished yet"}>
          <p>{q ? "Try fewer words, or clear the filters." : view === "active" ? "Start a piece, or open the Done tab to revisit finished work." : "Pieces appear here once they are signed off."}</p>
        </EmptyState>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {groups.map((g) => (
            <details key={g.id ?? "none"} className="format-group" open={q.length > 0 || groups.length === 1}>
              <summary>
                <span className="group-name">{g.name}</span>
                <span className="faint">{g.items.length} {g.items.length === 1 ? "piece" : "pieces"}</span>
              </summary>
              <div className="checklist">
                {g.items.map((p) => {
                  // The keyword where the format uses one; otherwise the title. The title or topic (which can be a long paragraph) is not shown in the row; it appears as a tooltip.
                  const keyword = p.primary_keyword.trim();
                  const headline = keyword || p.title;
                  const sub = keyword ? p.title : p.topic.trim();
                  return (
                    <Link key={p.id} to={`/pieces/${p.id}`} className="check-item" style={{ gridTemplateColumns: "1fr auto" }} title={[p.code, sub && sub !== headline ? sub : ""].filter(Boolean).join(" · ")}>
                      <span className="stack" style={{ gap: 2 }}>
                        <strong>{headline}</strong>
                        <span className="small muted">
                          {p.version > 1 && <>Version {p.version} · </>}Updated {formatDate(p.updated_at)}
                          {q.length >= 3 && textHits.has(p.id) && <> · <span className="flag-text">matches in the text</span></>}
                        </span>
                        {p.stage !== "done" && <span className="small next-step">Next: {NEXT_STEP[p.stage].toLowerCase()} →</span>}
                      </span>
                      <span className={`tag ${p.revised_by ? "" : p.stage === "done" ? (reviewDue(p) ? "flag" : "ok") : "pencil"}`}>
                        {p.revised_by ? "Revised" : reviewDue(p) ? "Review due" : stageLabel(p.stage)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function NewPiece({ onClose }: { onClose: () => void }) {
  const company = useCompany();
  const navigate = useNavigate();
  const { data: formats, reload: reloadFormats } = useLoad(
    async () => must<Format[]>(await supabase.from("formats").select("id, name, template_key, description, recipe").eq("company_id", company.id).order("created_at")),
    [company.id],
  );
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [keyword, setKeyword] = useState("");
  const [format, setFormat] = useState("");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [timing, setTiming] = useState<"just_in_time" | "up_front" | "">("");
  const [customer, setCustomer] = useState("");
  const [approvalContact, setApprovalContact] = useState("");
  const [offer, setOffer] = useState("");
  const [cta, setCta] = useState("");
  const chosen = formats?.find((f) => f.id === format);
  // Templates not added yet can be picked straight away; the format is created with the piece.
  const template = format.startsWith("tpl:") ? FORMAT_TEMPLATES.find((t) => t.key === format.slice(4)) : undefined;
  const unused = FORMAT_TEMPLATES.filter((t) => !(formats ?? []).some((f) => f.template_key === t.key));
  const recipe = template ? presetFor(template.key) : chosen ? normalise(chosen.recipe) : LONG_FORM;
  const hasSections = recipe.outline.mode !== "off" && recipe.sections.research;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let formatId = template ? null : format || null;
      if (template) {
        const [created] = must<{ id: string }[]>(await supabase.from("formats").insert({
          company_id: company.id, name: template.name, description: template.description,
          template_key: template.key, recipe: presetFor(template.key),
        }).select("id"));
        formatId = created.id;
        // If starting the piece fails below, a retry uses this format instead of adding it again.
        setFormat(created.id);
        reloadFormats();
      }
      const { data, error: err } = await supabase.rpc("create_piece", {
        target_company: company.id,
        piece_title: title,
        piece_topic: topic,
        format: formatId,
        piece_goal: recipe.brief.goal ? goal : "",
        audience: recipe.brief.audience ? audience : "",
        timing: hasSections ? (timing || recipe.sections.timing) : "",
        keyword: recipe.brief.keyword ? keyword : "",
        extra: {
          ...(recipe.brief.customer ? { customer, approval_contact: approvalContact } : {}),
          ...(recipe.brief.offer ? { offer, cta } : {}),
        },
      });
      if (err) throw err;
      navigate(`/pieces/${data}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Start a piece" onClose={onClose}>
      <form className="stack" onSubmit={create}>
        <label className="field">
          <span>Working title</span>
          <input type="text" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Emerging supply chain technologies" />
        </label>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">No format (full workflow)</option>
            {(formats ?? []).length > 0 && (
              <optgroup label="Your formats">
                {(formats ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </optgroup>
            )}
            {unused.length > 0 && (
              <optgroup label="Templates (added to your formats)">
                {unused.map((t) => <option key={t.key} value={`tpl:${t.key}`}>{t.name}</option>)}
              </optgroup>
            )}
          </select>
          <small>
            {template && <>{template.description} Starting the piece adds this format, which you can adjust under Formats. </>}
            Workflow: {stagesFor(recipe).filter((x) => x !== "done").map((x) => STAGES.find((st) => st.key === x)?.label).join(" → ")} → {recipe.signoff.required ? "Sign-off" : "Mark done"}
          </small>
        </label>
        {recipe.brief.keyword && (
          <label className="field">
            <span>Primary keyword</span>
            <input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="From Semrush, Ahrefs…" />
            <small>Bring it from your keyword research; the tool doesn't pick keywords.</small>
          </label>
        )}
        <label className="field">
          <span>{recipe.outline.mode === "off" ? "The point you want to make (optional)" : "Topic and angle (optional)"}</span>
          <CleanTextarea rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What you want to say, and why now" style={{ minHeight: 80 }} />
        </label>
        {(recipe.brief.goal || recipe.brief.audience) && (
          <div className="grid-2">
            {recipe.brief.goal && (
              <label className="field">
                <span>Goal (optional)</span>
                <input type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. demo requests from ops leaders" />
              </label>
            )}
            {recipe.brief.audience && (
              <label className="field">
                <span>Audience notes (optional)</span>
                <input type="text" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Anything beyond your ICP" />
              </label>
            )}
          </div>
        )}
        {recipe.brief.customer && (
          <div className="grid-2">
            <label className="field"><span>Customer</span><input type="text" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Company name" /></label>
            <label className="field"><span>Approval contact</span><input type="text" value={approvalContact} onChange={(e) => setApprovalContact(e.target.value)} placeholder="Who signs off on their side" /></label>
          </div>
        )}
        {recipe.brief.offer && (
          <div className="grid-2">
            <label className="field"><span>Offer</span><input type="text" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="What's on offer, with terms" /></label>
            <label className="field"><span>Call to action</span><input type="text" value={cta} onChange={(e) => setCta(e.target.value)} placeholder="e.g. Book a demo" /></label>
          </div>
        )}
        {hasSections && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <span>Section research</span>
            <label className="row small"><input type="radio" checked={(timing || recipe.sections.timing) === "just_in_time"} onChange={() => setTiming("just_in_time")} /> One section at a time: research, review, write, then the next</label>
            <label className="row small"><input type="radio" checked={(timing || recipe.sections.timing) === "up_front"} onChange={() => setTiming("up_front")} /> All sections up front: review everything in one sitting, then write</label>
          </fieldset>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>{busy ? "Starting…" : "Start piece"}</button>
          {!title.trim() && <span className="small muted disabled-reason">Add a working title</span>}
        </div>
      </form>
    </Modal>
  );
}
