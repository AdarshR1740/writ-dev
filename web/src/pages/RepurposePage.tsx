import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany, useSession } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { plural } from "../lib/format";
import { normalise } from "../lib/recipes";
import {
  SOURCE_TYPE_LABELS,
  type Format,
  type Piece,
  type PlanEntry,
  type RepurposePlan,
  type ResearchItem,
  type Shape,
} from "../lib/types";
import { AiAction, ErrorText, Loading, Lede } from "../components/ui";

const SHAPES: { value: Shape; label: string; detail: string }[] = [
  { value: "split", label: "Split", detail: "One piece into several, e.g. a blog into five LinkedIn posts, each with its own angle." },
  { value: "adapt", label: "Adapt", detail: "One piece into one in a new medium, e.g. a blog into a video script." },
  { value: "combine", label: "Combine", detail: "Several pieces into one, e.g. a series of posts into a long-form guide." },
];

type Mini = Pick<Piece, "id" | "code" | "version" | "title" | "stage" | "revised_by">;

/** Step 1: choose the shape, target format, sources and specific requirements. */
export function NewRepurposePage() {
  const company = useCompany();
  const { session } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data } = useLoad(async () => {
    const [formats, pieces] = await Promise.all([
      supabase.from("formats").select("id, name, template_key, description, recipe").eq("company_id", company.id).order("created_at").then(must<Format[]>),
      supabase.from("pieces").select("id, code, version, title, stage, revised_by").eq("company_id", company.id).eq("stage", "done")
        .order("code").order("version").then(must<Mini[]>),
    ]);
    return { formats, pieces };
  }, [company.id]);
  const [shape, setShape] = useState<Shape>((params.get("shape") as Shape) || "split");
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState<string[]>(params.get("from") ? [params.get("from")!] : []);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <Loading />;
  const valid = target && sources.length >= 1 && (shape === "combine" ? sources.length >= 2 : sources.length === 1);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/history">History</Link></span>
        <h1>Repurpose</h1>
        <Lede more={<>The new pieces then follow their own format's workflow, with the source's approved research carried over.</>}>Plan how finished content becomes something new.</Lede>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted" style={{ marginBottom: 8 }}>Shape</legend>
        <div className="grid-3">
          {SHAPES.map((s) => (
            <label key={s.value} className={`card choice${shape === s.value ? " on" : ""}`}>
              <input type="radio" name="shape" checked={shape === s.value} onChange={() => { setShape(s.value); if (s.value !== "combine") setSources(sources.slice(0, 1)); }} />
              <strong>{s.label}</strong>
              <span className="small muted">{s.detail}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Target format</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a format</option>
          {data.formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {data.formats.length === 0 && <small>Add formats under House file → Formats first.</small>}
      </label>
      <div className="field">
        <span>{shape === "combine" ? "Sources (pick two or more)" : "Source"}</span>
        {data.pieces.length === 0 ? <p className="small muted">No finished pieces yet.</p> : (
          <ul className="carry-list">
            {data.pieces.map((p) => (
              <li key={p.id}>
                <label className="check-label small">
                  <input type={shape === "combine" ? "checkbox" : "radio"} name="source" checked={sources.includes(p.id)} onChange={() =>
                    setSources(shape === "combine" ? (sources.includes(p.id) ? sources.filter((x) => x !== p.id) : [...sources, p.id]) : [p.id])} />
                  <span><span className="mono">{p.code} v{p.version}</span> {p.title}{p.revised_by && <span className="faint"> (revised since)</span>}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="field">
        <span>Specific requirements (optional)</span>
        <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} style={{ minHeight: 80 }}
          placeholder="Anything the shape doesn't capture, e.g. 'one post per customer story', 'keep the script under 4 minutes', 'end each post with a question'." />
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const plan = must<{ id: string }>(await supabase.from("repurpose_plans").insert({
              company_id: company.id, shape, target_format_id: target, source_piece_ids: sources, instructions: instructions.trim(), created_by: session!.user.id,
            }).select("id").single());
            navigate(`/repurpose/${plan.id}`);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}>
          Continue to the plan
        </button>
        {!valid && <span className="small faint">{shape === "combine" ? "Choose a format and at least two sources." : "Choose a format and a source."}</span>}
      </div>
    </div>
  );
}

const blank = (): PlanEntry => ({ heading: "", angle: "", notes: "", item_ids: [], sections: [] });

/** Step 2: plan (with AI or by hand), edit, then create the pieces. */
export function RepurposePlanPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(async () => {
    const plan = must<RepurposePlan>(await supabase.from("repurpose_plans").select("*").eq("id", planId!).single());
    const [format, sources, items] = await Promise.all([
      supabase.from("formats").select("id, name, template_key, description, recipe").eq("id", plan.target_format_id).single().then(must<Format>),
      supabase.from("pieces").select("id, code, version, title, stage, revised_by").in("id", plan.source_piece_ids).then(must<Mini[]>),
      supabase.from("research_items").select("*, sources(id, url, title, published, in_library)").in("piece_id", plan.source_piece_ids)
        .eq("status", "approved").order("created_at").then(must<ResearchItem[]>),
    ]);
    return { plan, format, sources, items };
  }, [planId]);
  const [entries, setEntries] = useState<PlanEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (data && entries === null) setEntries(data.plan.proposal?.entries ?? [blank()]);
  }, [data, entries]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data || !entries) return <Loading />;
  const { plan, format, sources, items } = data;
  const recipe = normalise(format.recipe);
  const hasOutline = recipe.outline.mode !== "off";
  const used = plan.status === "created";
  const update = (i: number, patch: Partial<PlanEntry>) => setEntries(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow"><Link to="/history">History</Link> · Repurpose</span>
        <h1>{SHAPES.find((s) => s.value === plan.shape)?.label} into {format.name}</h1>
        <p className="muted small">
          From {sources.map((s) => <Link key={s.id} to={`/pieces/${s.id}`} className="tag pencil" style={{ marginRight: 4 }}>{s.code} v{s.version}</Link>)}
          {plan.instructions && <> · Specific requirements: {plan.instructions}</>}
        </p>
      </div>

      {used ? (
        <div className="card stack">
          <p>This plan created {plural(plan.created_pieces.length, "piece")}.</p>
          <div className="row">{plan.created_pieces.map((id) => <Link key={id} to={`/pieces/${id}`} className="btn btn-small">Open</Link>)}</div>
        </div>
      ) : (
        <>
          <div className="card row">
            <div className="stack" style={{ gap: 2 }}>
              <strong>Plan with AI</strong>
              <span className="small muted">
                {plan.shape === "split" ? "Proposes the key points, each with its own angle and the research behind it."
                  : plan.shape === "adapt" ? `Maps the source onto ${format.name}'s structure and lists what doesn't translate.`
                  : "Groups the sources into themes, proposes sections, and lists the gaps none of them covers."}
                {" "}Or fill it in yourself below.
              </span>
            </div>
            <span className="spacer" />
            <AiAction<{ proposal: RepurposePlan["proposal"] }>
              label={plan.proposal ? "Plan again" : "Plan with AI"}
              primary={!plan.proposal}
              payload={{ task: "repurpose_plan", plan_id: plan.id }}
              onDone={(r) => { setEntries(r.proposal?.entries ?? [blank()]); reload(); }}
            />
          </div>

          {plan.proposal && (plan.proposal.not_translated.length > 0 || plan.proposal.gaps.length > 0) && (
            <div className="notice stack" style={{ gap: 6 }}>
              {plan.proposal.not_translated.length > 0 && <><strong className="small">Doesn't carry over to {format.name}</strong>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{plan.proposal.not_translated.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
              {plan.proposal.gaps.length > 0 && <><strong className="small">Gaps none of the sources covers (research them in the new piece)</strong>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{plan.proposal.gaps.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
            </div>
          )}

          <div className="card-list">
            {entries.map((e, i) => (
              <article key={i} className="insight">
                <div className="row">
                  <span className="tag pencil">{plan.shape === "split" ? `Piece ${i + 1}` : "The new piece"}</span>
                  <span className="spacer" />
                  {plan.shape === "split" && entries.length > 1 && (
                    <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => setEntries(entries.filter((_, j) => j !== i))}>Remove</button>
                  )}
                </div>
                <input type="text" value={e.heading} onChange={(ev) => update(i, { heading: ev.target.value })}
                  placeholder={plan.shape === "split" ? "The point this piece makes" : "Working title"} aria-label="Heading" className="heading-input" />
                <input type="text" value={e.angle} onChange={(ev) => update(i, { angle: ev.target.value })}
                  placeholder="Angle: the story or framing that makes it different" aria-label="Angle" />
                <textarea rows={2} value={e.notes} onChange={(ev) => update(i, { notes: ev.target.value })} style={{ minHeight: 56 }}
                  placeholder="Notes for the writer (optional)" aria-label="Notes" />
                {hasOutline && (
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="small muted">Sections {recipe.outline.mode === "fixed" ? `(leave empty to use ${format.name}'s fixed outline)` : "(optional; the writer can still change the outline)"}</span>
                    {e.sections.map((s, k) => (
                      <div key={k} className="row" style={{ gap: 6 }}>
                        <input type="text" value={s.heading} onChange={(ev) => update(i, { sections: e.sections.map((x, j) => (j === k ? { ...x, heading: ev.target.value } : x)) })}
                          placeholder="Section heading" aria-label="Section heading" style={{ flex: "1 1 200px", width: "auto" }} />
                        <input type="text" value={s.purpose} onChange={(ev) => update(i, { sections: e.sections.map((x, j) => (j === k ? { ...x, purpose: ev.target.value } : x)) })}
                          placeholder="Draws on…" aria-label="Section purpose" style={{ flex: "2 1 260px", width: "auto" }} />
                        <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => update(i, { sections: e.sections.filter((_, j) => j !== k) })} aria-label="Remove section">✕</button>
                      </div>
                    ))}
                    <div><button type="button" className="btn btn-small" onClick={() => update(i, { sections: [...e.sections, { heading: "", purpose: "" }] })}>Add section</button></div>
                  </div>
                )}
                <details>
                  <summary className="small">Research to carry over: {e.item_ids.length} of {items.length} approved items (they stay approved)</summary>
                  <ul className="carry-list">
                    {items.map((it) => (
                      <li key={it.id}>
                        <label className="check-label small">
                          <input type="checkbox" checked={e.item_ids.includes(it.id)} onChange={() => update(i, {
                            item_ids: e.item_ids.includes(it.id) ? e.item_ids.filter((x) => x !== it.id) : [...e.item_ids, it.id],
                          })} />
                          <span>{it.statement} <span className="faint">({SOURCE_TYPE_LABELS[it.source_type]})</span></span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              </article>
            ))}
          </div>
          <div className="row">
            {plan.shape === "split" && <button type="button" className="btn" onClick={() => setEntries([...entries, blank()])}>Add a piece</button>}
            <span className="spacer" />
            <ErrorText>{actionError}</ErrorText>
            <button type="button" className="btn btn-primary" disabled={busy || entries.some((e) => !e.heading.trim())} onClick={async () => {
              setBusy(true);
              setActionError(null);
              try {
                const clean = entries.map((e) => ({ ...e, sections: e.sections.filter((s) => s.heading.trim()) }));
                const { data: ids, error: err } = await supabase.rpc("create_from_plan", { plan: plan.id, entries: clean });
                if (err) throw err;
                const created = ids as string[];
                navigate(created.length === 1 ? `/pieces/${created[0]}` : `/repurpose/${plan.id}`);
                reload();
              } catch (err) {
                setActionError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}>
              Create {plural(entries.length, "piece")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
