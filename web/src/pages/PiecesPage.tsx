import { useEffect, useMemo, useState } from "react";
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
import { ErrorText, Loading, Modal, Lede, CleanTextarea } from "../components/ui";
import { GettingStarted } from "../components/GettingStarted";

type Row = Pick<Piece, "id" | "code" | "version" | "title" | "topic" | "primary_keyword" | "stage" | "format_id" | "revised_by" | "review_due_at" | "updated_at">;
type StageFilter = "" | "active" | Piece["stage"] | "due";

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
        <h1>Write</h1>
        <Lede more={<>Each piece moves through the steps its format's workflow switches on: reader contract, reviewed research, outline, writing and sign-off.</>}>Every piece you're writing or have written. Nothing moves on until a person approves it.</Lede>
      </div>
      <BudgetAlert companyId={company.id} />
      {data && <GettingStarted status={status ?? null} pieceCount={data.pieces.length} onStart={() => setCreating(true)} />}
      {data && data.pieces.length > 0 && <div><button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Start a piece</button></div>}
      <ErrorText>{error}</ErrorText>
      {!data ? <Loading /> : data.pieces.length === 0 ? (
        <EmptyState icon="page" title="Nothing written yet"
          actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Start your first piece</button>}>
          <p>Every piece starts with a title and a format. The format decides the steps: a LinkedIn post skips the outline, a case study adds customer approval.</p>
        </EmptyState>
      ) : (
        <>
          <ContinueWriting pieces={data.pieces} formats={data.formats} />
          <PieceList pieces={data.pieces} formats={data.formats} />
        </>
      )}
      {creating && <NewPiece onClose={() => setCreating(false)} />}
    </div>
  );
}

/** All pieces, grouped by format, with search (titles, IDs, keywords and the text itself) and filters. */
function PieceList({ pieces, formats }: { pieces: Row[]; formats: { id: string; name: string }[] }) {
  const company = useCompany();
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("");
  const [stage, setStage] = useState<StageFilter>("");
  const [older, setOlder] = useState(false);
  const [grouped, setGrouped] = useState(true);
  // Pieces whose written text matches the search (checked on the server).
  const [textHits, setTextHits] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 3) { setTextHits(new Set()); return; }
    let live = true;
    const t = setTimeout(async () => {
      const { data } = await supabase.from("piece_sections").select("piece_id")
        .eq("company_id", company.id).ilike("content", `%${q.replace(/[\\%_]/g, "\\$&")}%`).limit(500);
      if (live) setTextHits(new Set((data ?? []).map((r: { piece_id: string }) => r.piece_id)));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, company.id]);

  const today = new Date();
  const shown = useMemo(() => pieces.filter((p) => {
    if (!older && p.revised_by) return false;
    if (format && (format === "none" ? p.format_id !== null : p.format_id !== format)) return false;
    if (stage === "active" && p.stage === "done") return false;
    if (stage === "due" && !(p.stage === "done" && !p.revised_by && p.review_due_at && new Date(p.review_due_at) <= today)) return false;
    if (stage && stage !== "active" && stage !== "due" && p.stage !== stage) return false;
    if (!q) return true;
    return `${p.code} ${p.title} ${p.primary_keyword} ${p.topic}`.toLowerCase().includes(q) || textHits.has(p.id);
  }), [pieces, older, format, stage, q, textHits]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatName = (id: string | null) => (id ? formats.find((f) => f.id === id)?.name ?? "Format" : "No format");
  const groups = grouped
    ? [...formats.map((f) => f.id), null].map((id) => ({ id, name: formatName(id), items: shown.filter((p) => p.format_id === id) })).filter((g) => g.items.length)
    : [{ id: "all", name: "", items: shown }];
  const filtered = Boolean(q || format || stage || older);

  return (
    <div className="stack">
      <div className="filters">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, IDs, keywords and text" aria-label="Search pieces" />
        <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format">
          <option value="">All formats</option>
          {formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          <option value="none">No format</option>
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value as StageFilter)} aria-label="Stage">
          <option value="">Any stage</option>
          <option value="active">In progress</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>)}
          <option value="due">Review due</option>
        </select>
        <label className="check-label small"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by format</label>
        <label className="check-label small"><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} /> Older versions</label>
      </div>
      <p className="small muted" aria-live="polite">
        {shown.length} of {pieces.filter((p) => older || !p.revised_by).length} pieces
        {filtered && <> · <button type="button" className="link-btn" onClick={() => { setQuery(""); setFormat(""); setStage(""); setOlder(false); }}>Clear filters</button></>}
      </p>
      {shown.length === 0 ? <EmptyState icon="page" title="Nothing matches"><p>Try fewer words, or clear the filters.</p></EmptyState> : groups.map((g) => (
        <section key={g.id ?? "none"} className="stack" style={{ gap: 8 }} aria-label={g.name || "Pieces"}>
          {grouped && <h2 className="group-head">{g.name} <span className="faint">{g.items.length}</span></h2>}
          <div className="checklist">
            {g.items.map((p) => (
              <Link key={p.id} to={`/pieces/${p.id}`} className="check-item" style={{ gridTemplateColumns: "1fr auto" }}>
                <span className="stack" style={{ gap: 2 }}>
                  <strong><span className="id faint">{p.code} v{p.version}</span> {p.title}</strong>
                  <span className="small muted">
                    {!grouped && <>{formatName(p.format_id)} · </>}
                    {p.primary_keyword && <>{p.primary_keyword} · </>}updated {formatDate(p.updated_at)}
                    {q.length >= 3 && textHits.has(p.id) && <> · <span className="flag-text">matches in the text</span></>}
                  </span>
                </span>
                <span className={`tag ${p.revised_by ? "" : p.stage === "done" ? "ok" : "pencil"}`}>{p.revised_by ? "Revised" : stageLabel(p.stage)}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
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


const NEXT_STEP: Record<Piece["stage"], string> = {
  contract: "Agree the reader contract",
  research: "Review the research",
  outline: "Confirm the outline",
  writing: "Keep writing",
  done: "",
};

/** The three most recent pieces still in progress, with what each needs next. */
function ContinueWriting({ pieces, formats }: { pieces: Row[]; formats: { id: string; name: string }[] }) {
  const active = pieces.filter((p) => p.stage !== "done" && !p.revised_by).slice(0, 3);
  if (active.length === 0) return null;
  return (
    <section className="stack" style={{ gap: 10 }} aria-label="Pick up where you left off">
      <h2 className="group-head" style={{ marginTop: 0 }}>Pick up where you left off</h2>
      <div className="continue-grid">
        {active.map((p) => (
          <Link key={p.id} to={`/pieces/${p.id}`} className="continue-card">
            <span className="small muted"><span className="id">{p.code}</span> · {formats.find((f) => f.id === p.format_id)?.name ?? "No format"}</span>
            <strong>{p.title}</strong>
            <span className="continue-next">{NEXT_STEP[p.stage]} →</span>
            <span className="small faint">Updated {formatDate(p.updated_at)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
