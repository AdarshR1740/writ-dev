import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import { STAGES, type Contract, type Expectation, type Piece, type Stage, type ThreadMessage } from "../lib/types";
import { ErrorText, Loading, CleanTextarea } from "../components/ui";
import { ChatPanel } from "../components/ChatPanel";
import { ResearchStep } from "../components/ResearchStep";
import { normalise, stagesFor, type Recipe } from "../lib/recipes";
import { LineagePanel, ReviewDue, ReviseDialog } from "../components/PieceHistory";
import { OutlineStep } from "../components/OutlineStep";
import { WritingStep } from "../components/WritingStep";
import { SignOffStep } from "../components/SignOffStep";

export function PiecePage() {
  const { pieceId } = useParams();
  const { data: piece, error, reload } = useLoad(
    async () => must<Piece>(await supabase.from("pieces").select("*").eq("id", pieceId!).single()),
    [pieceId],
  );
  const [view, setView] = useState<Stage | null>(null);
  const [revising, setRevising] = useState(false);
  // Writing is complete when every section is marked written; sign-off then takes over as the current step.
  const { data: sectionStates, reload: reloadSections } = useLoad(
    async () => must<{ status: string }[]>(await supabase.from("piece_sections").select("status").eq("piece_id", pieceId!)),
    [pieceId],
  );

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!piece) return <Loading />;
  const recipe = normalise(piece.recipe);
  // Only the stages this piece's workflow uses (a LinkedIn post has no outline).
  const stages = STAGES.filter((s) => stagesFor(recipe).includes(s.key))
    .map((s) => (s.key === "done" && !recipe.signoff.required ? { ...s, label: "Finish" } : s));
  const current = stages.findIndex((s) => s.key === piece.stage);
  const shown = view ?? piece.stage;
  const writingDone = piece.stage === "writing" && (sectionStates?.length ?? 0) > 0 && sectionStates!.every((s) => s.status === "written");

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow"><Link to="/pieces">Write</Link> · <span className="id">{piece.code} v{piece.version}</span></span>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <h1 style={{ flex: 1 }}>{piece.title}</h1>
          {piece.stage === "done" && (
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn" onClick={() => setRevising(true)}>Revise</button>
              <Link to={`/repurpose/new?from=${piece.id}`} className="btn">Repurpose</Link>
            </div>
          )}
        </div>
        <p className="muted small">
          {piece.primary_keyword && <><span>{piece.primary_keyword}</span> · </>}
          {piece.section_timing === "up_front" ? "Section research up front" : "Section research one at a time"} · started {formatDate(piece.created_at)}
          {piece.stage === "done" && !piece.revised_by && piece.review_due_at && new Date(piece.review_due_at) > new Date() && (
            <> · next review {formatDate(piece.review_due_at)}{piece.last_reviewed_at ? ` (last ${formatDate(piece.last_reviewed_at)})` : ""}</>
          )}
        </p>
      </div>

      {piece.revised_by && (
        <p className="notice small">This version was revised. <Link to={`/pieces/${piece.revised_by}`}>Open the newer version</Link>.</p>
      )}
      <ReviewDue piece={piece} onChanged={reload} />
      <LineagePanel piece={piece} />
      {piece.origin_notes && piece.stage !== "done" && (
        <details className="notes-strip small" open={piece.stage === "contract" || piece.stage === "research"}>
          <summary>Notes from repurposing</summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{piece.origin_notes}</p>
        </details>
      )}
      {revising && <ReviseDialog piece={piece} onClose={() => setRevising(false)} />}

      <ol className="stages" aria-label="Stages">
        {stages.map((s, i) => {
          // Sign-off opens alongside writing; it shows what's still missing.
          const reachable = i <= current || (s.key === "done" && piece.stage === "writing");
          const state = piece.stage === "done" || i < current || (writingDone && s.key === "writing") ? "done" : i === current || reachable ? "current" : "later";
          return (
            <li key={s.key}>
              <button
                type="button"
                className={`stage ${state}${shown === s.key ? " shown" : ""}`}
                disabled={state === "later"}
                aria-current={shown === s.key ? "step" : undefined}
                ref={shown === s.key ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
                onClick={() => setView(s.key)}
              >
                <span className="stage-n">{i + 1}</span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      {shown === "contract" && <ContractStep piece={piece} recipe={recipe} onAdvanced={() => { setView(null); reload(); }} />}
      {shown === "research" && <ResearchStep piece={piece} onAdvanced={() => { setView(null); reload(); }} />}
      {shown === "outline" && <OutlineStep piece={piece} onChanged={reload} onAdvanced={() => { setView(null); reload(); }} />}
      {shown === "writing" && <WritingStep piece={piece} onChanged={() => { reload(); reloadSections(); }} onContinue={() => setView("done")} finishLabel={recipe.signoff.required ? "Sign-off" : "Finish"} />}
      {shown === "done" && <SignOffStep piece={piece} onChanged={reload} />}
    </div>
  );
}

function newId() {
  return Math.random().toString(36).slice(2, 9);
}

function ContractStep({ piece, recipe, onAdvanced }: { piece: Piece; recipe: Recipe; onAdvanced: () => void }) {
  const lite = recipe.contract.mode === "lite";
  const maxExpectations = lite ? 2 : 7;
  const { data, error, reload } = useLoad(async () => {
    const [contract, thread] = await Promise.all([
      supabase.from("piece_contracts").select("*").eq("piece_id", piece.id).single().then(must<Contract>),
      supabase.from("threads").select("id").eq("piece_id", piece.id).eq("subject", "contract").single()
        .then(must<{ id: string }>),
    ]);
    const messages = must<ThreadMessage[]>(
      await supabase.from("thread_messages").select("*").eq("thread_id", thread.id).order("created_at"),
    );
    return { contract, messages };
  }, [piece.id]);

  const [draft, setDraft] = useState<{ core_question: string; expectations: Expectation[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  // The conversation can take over the screen; the scope then shows as a compact bar.
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft({ core_question: data.contract.core_question, expectations: data.contract.expectations });
  }, [data, draft]);
  useEffect(() => threadEnd.current?.scrollIntoView({ block: "nearest" }), [data?.messages.length]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data || !draft) return <Loading />;
  const { contract, messages } = data;
  const dirty = draft.core_question !== contract.core_question ||
    JSON.stringify(draft.expectations) !== JSON.stringify(contract.expectations);

  async function save(next = draft!) {
    const clean = { core_question: next.core_question.trim(), expectations: next.expectations.filter((e) => e.text.trim()) };
    must(await supabase.from("piece_contracts").update(clean).eq("piece_id", piece.id).select("piece_id"));
    setDraft(clean);
    await reload();
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const setExp = (id: string, text: string) =>
    setDraft({ ...draft, expectations: draft.expectations.map((e) => (e.id === id ? { ...e, text } : e)) });
  const move = (i: number, d: -1 | 1) => {
    const list = [...draft.expectations];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setDraft({ ...draft, expectations: list });
  };

  return (
    <div className={`workbench${chatOpen && recipe.contract.ai_thread ? " chat-open" : " no-rail"}`}>
      {chatOpen ? (
        <div className="scope-bar">
          <div className="stack" style={{ gap: 2, minWidth: 0 }}>
            <span className="small muted">Scope · {contract.confirmed_at && !dirty ? "Confirmed" : dirty ? "Unsaved edits" : "Draft"}</span>
            <strong className="clip">{draft.core_question || "No core question yet"}</strong>
            <span className="small muted">{draft.expectations.filter((x) => x.text.trim()).length} points to include</span>
          </div>
          <button type="button" className="btn btn-small" onClick={() => setChatOpen(false)}>Edit scope</button>
        </div>
      ) : (
      <section className="doc-surface" aria-label="Scope">
        <header>
          <strong>Scope</strong>
          {contract.confirmed_at && !dirty ? <span className="tag ok">Confirmed</span> : <span className="tag">Draft</span>}
          <span className="spacer" />
          {dirty && <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => save())}>Save</button>}
          {recipe.contract.ai_thread && <button type="button" className="btn btn-small btn-primary" onClick={() => setChatOpen(true)}>Ask AI</button>}
        </header>
        <div className="stack" style={{ padding: "18px 20px 22px", gap: 28 }}>
          {lite && <p className="small muted">A short format: one point to land, plus up to two more to cover.</p>}
          <label className="field">
            <span>Core question this piece wants to answer</span>
            <input type="text" value={draft.core_question} onChange={(e) => setDraft({ ...draft, core_question: e.target.value })}
              placeholder="The one question a reader wants answered" />
          </label>
          <div className="field">
            <span>What other points or ideas to include</span>
            <ol className="expectations">
              {draft.expectations.map((e, i) => (
                <li key={e.id}>
                  <CleanTextarea rows={2} value={e.text} onChange={(ev) => setExp(e.id, ev.target.value)} placeholder="e.g. A checklist to test whether your messaging is ready" aria-label={`Point ${i + 1}`} />
                  <div className="row" style={{ gap: 2 }}>
                    <button type="button" className="btn btn-quiet btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button type="button" className="btn btn-quiet btn-small" disabled={i === draft.expectations.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => setDraft({ ...draft, expectations: draft.expectations.filter((x) => x.id !== e.id) })}>Remove</button>
                  </div>
                </li>
              ))}
            </ol>
            <div>
              <button type="button" className="btn btn-small" disabled={draft.expectations.length >= maxExpectations} onClick={() => setDraft({ ...draft, expectations: [...draft.expectations, { id: newId(), text: "" }] })}>
                Add a point
              </button>
            </div>
          </div>
          <ErrorText>{actionError}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || (Boolean(contract.confirmed_at) && !dirty)} onClick={() => run(async () => {
              if (dirty) await save();
              const { error: err } = await supabase.rpc("confirm_contract", { target_piece: piece.id });
              if (err) throw err;
              onAdvanced();
            })}>
              {contract.confirmed_at && !dirty ? "Confirmed" : "Confirm scope"}
            </button>
            {contract.confirmed_at && !dirty && (
              <button type="button" className="btn" disabled={busy} onClick={() => {
                if (!window.confirm("Reopen the scope for review?\n\nThe piece goes back to this step. Your research and sections are kept, and you confirm the scope again to move on.")) return;
                void run(async () => {
                  const { error: err } = await supabase.rpc("reopen_contract", { target_piece: piece.id });
                  if (err) throw err;
                  onAdvanced();
                });
              }}>Reopen scope</button>
            )}
          </div>
        </div>
      </section>
      )}

      {recipe.contract.ai_thread && chatOpen && (
        <ChatPanel
          messages={messages}
          kind="scope"
          pieceId={piece.id}
          placeholder={messages.length ? "Ask anything, or tell the AI what to change" : "Ask for a first scope, or chat about anything"}
          beforeSend={dirty ? () => save() : undefined}
          onSent={() => reload()}
          onMinimize={() => setChatOpen(false)}
          copyText={(m) => [m.content, ...(m.payload?.expectations ? ["", m.payload.core_question ?? "", ...m.payload.expectations.map((x, i) => `${i + 1}. ${x}`)] : [])].join("\n")}
          renderExtra={(m) => m.payload?.expectations ? (
            <details>
              <summary className="small">Suggested scope ({m.payload.expectations.length} points)</summary>
              <p className="small"><strong>{m.payload.core_question}</strong></p>
              <ol className="small">{m.payload.expectations.map((x, i) => <li key={i}>{x}</li>)}</ol>
              <button type="button" className="btn btn-small btn-primary" onClick={() => {
                // Ask first when this would replace edits that aren't saved yet.
                if (dirty && !window.confirm("Replace your unsaved edits to the scope with this suggestion?")) return;
                setDraft({
                  core_question: m.payload!.core_question ?? draft.core_question,
                  expectations: m.payload!.expectations!.map((text) => ({ id: newId(), text })),
                });
                setChatOpen(false);
              }}>
                Use this suggestion
              </button>
            </details>
          ) : null}
        />
      )}
    </div>
  );
}
