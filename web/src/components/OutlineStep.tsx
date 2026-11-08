import { useEffect, useRef, useState } from "react";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { BLOCK_LABELS, type Analysis, type Block, type BlockType, type Contract, type FixProposal, type Piece, type ResearchItem, type Section, type ThreadMessage } from "../lib/types";
import { CardForm, emptyCard } from "./CardForm";
import { AiAction, CleanTextarea, ErrorText, Loading, Modal } from "./ui";
import { SeoGeoPanel } from "./SeoGeoPanel";
import { ChatPanel } from "./ChatPanel";
import { normalise } from "../lib/recipes";

interface Draft {
  key: string;
  heading: string;
  purpose: string;
  expectation_ids: string[];
  /** What goes under the heading, block by block. Empty until planned. */
  structure: Block[];
}

/** Edits one section's planned blocks: what kind of block, and what goes in it. */
function StructureEditor({ blocks, disabled, onChange }: { blocks: Block[]; disabled: boolean; onChange: (b: Block[]) => void }) {
  const set = (i: number, patch: Partial<Block>) => onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i: number, d: -1 | 1) => {
    const list = [...blocks];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    onChange(list);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {blocks.length === 0 && <p className="small muted">No structure planned. Without one, the section tends to come out as a single paragraph.</p>}
      <ol className="structure-list">
        {blocks.map((b, i) => (
          <li key={i}>
            <select value={b.type} disabled={disabled} onChange={(e) => set(i, { type: e.target.value as BlockType })} aria-label={`Block ${i + 1} type`}>
              {(Object.keys(BLOCK_LABELS) as BlockType[]).map((t) => <option key={t} value={t}>{BLOCK_LABELS[t]}</option>)}
            </select>
            <input type="text" value={b.note} disabled={disabled} onChange={(e) => set(i, { note: e.target.value })}
              placeholder="What goes in this block" aria-label={`Block ${i + 1} note`} />
            {!disabled && (
              <span className="row" style={{ gap: 2 }}>
                <button type="button" className="btn btn-quiet btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move block up">↑</button>
                <button type="button" className="btn btn-quiet btn-small" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move block down">↓</button>
                <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block">✕</button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!disabled && <div><button type="button" className="btn btn-small" onClick={() => onChange([...blocks, { type: "paragraph", note: "" }])}>Add block</button></div>}
    </div>
  );
}

const key = () => Math.random().toString(36).slice(2, 9);

/** Analysis of the reviewed research, then the outline (writer-owned, AI-suggested). */
export function OutlineStep({ piece, onAdvanced, onChanged }: { piece: Piece; onAdvanced: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad(async () => {
    const [contract, sections, thread] = await Promise.all([
      supabase.from("piece_contracts").select("*").eq("piece_id", piece.id).single().then(must<Contract>),
      supabase.from("piece_sections").select("*").eq("piece_id", piece.id).order("position").then(must<Section[]>),
      supabase.from("threads").select("id").eq("piece_id", piece.id).eq("subject", "outline").maybeSingle()
        .then(must<{ id: string } | null>),
    ]);
    const messages = thread
      ? must<ThreadMessage[]>(await supabase.from("thread_messages").select("*").eq("thread_id", thread.id).order("created_at"))
      : [];
    return { contract, sections, messages };
  }, [piece.id]);

  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<{ question: string } | null>(null);
  const [fixReply, setFixReply] = useState<string | null>(null);
  // The conversation can take over the screen; the outline then shows as a compact bar.
  const [chatOpen, setChatOpen] = useState(false);
  // The outline as it was before "Fix now" changed it, so the change can be undone.
  const [undo, setUndo] = useState<Draft[] | null>(null);
  const confirmed = Boolean(piece.outline_confirmed_at);
  const recipe = normalise(piece.recipe);
  const aiThread = recipe.outline.mode === "free" && recipe.outline.ai_thread;

  // After a save or a fix changes the scope or sections, refresh the draft from the data that arrives next, without
  // blanking the screen (blanking remounts the analysis panel, which loses its undo information, and re-seeding from
  // the old data would show the previous outline again). Holds the data that was current when the change was made.
  const resync = useRef<unknown>(null);
  useEffect(() => {
    if (data && (draft === null || (resync.current !== null && data !== resync.current))) {
      resync.current = null;
      setDraft(data.sections.map((s) => ({ key: s.id, heading: s.heading, purpose: s.purpose, expectation_ids: s.expectation_ids, structure: s.structure ?? [] })));
    }
  }, [data, draft]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data || !draft) return <Loading />;
  const { contract, messages } = data;
  const cleanBlocks = (b: Block[]) => b.filter((x) => x.note.trim()).map((x) => ({ type: x.type, note: x.note.trim() }));
  const saved = JSON.stringify(data.sections.map((s) => [s.heading, s.purpose, s.expectation_ids, cleanBlocks(s.structure ?? [])]));
  const dirty = JSON.stringify(draft.map((s) => [s.heading.trim(), s.purpose.trim(), s.expectation_ids, cleanBlocks(s.structure)])) !== saved;
  const unplanned = draft.filter((s) => s.heading.trim() && s.structure.length === 0).length;
  const uncovered = contract.expectations.filter((e) => !draft.some((s) => s.expectation_ids.includes(e.id)));

  async function act(fn: () => Promise<void>) {
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

  async function save(list: Draft[] = draft!) {
    const clean = list.filter((s) => s.heading.trim()).map((s) => ({ id: s.key, heading: s.heading.trim(), purpose: s.purpose.trim(), expectation_ids: s.expectation_ids, structure: cleanBlocks(s.structure) }));
    const { error: err } = await supabase.rpc("save_outline", { target_piece: piece.id, sections: clean });
    if (err) throw err;
    resync.current = data;
    await reload();
  }

  // A section the AI keeps under the same heading stays the same section, so its text and research are kept.
  const keyFor = (heading: string) => draft.find((d) => d.heading.trim().toLowerCase() === heading.trim().toLowerCase())?.key ?? key();
  const update = (k: string, patch: Partial<Draft>) => setDraft(draft.map((s) => (s.key === k ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const list = [...draft];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setDraft(list);
  };

  return (
    <div className="stack-lg">
      {recipe.analysis.enabled && (
        <AnalysisPanel
          piece={piece}
          onRan={onChanged}
          onAnswer={(q) => setAnswering({ question: q })}
          blocked={dirty ? "Save your outline edits first" : null}
          coveredIds={data.sections.flatMap((s) => s.expectation_ids)}
          onOutlineChanged={() => { resync.current = data; void reload(); }}
        />
      )}

      <div className={`workbench${chatOpen && !confirmed && aiThread ? " chat-open" : " no-rail"}`}>
        {chatOpen && !confirmed && aiThread ? (
          <div className="scope-bar">
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span className="small muted">Outline · {dirty ? "Unsaved edits" : "Draft"}</span>
              <strong className="clip">{draft.filter((s) => s.heading.trim()).map((s) => s.heading.trim()).join(" · ") || "No sections yet"}</strong>
              <span className="small muted">{draft.filter((s) => s.heading.trim()).length} sections</span>
            </div>
            <button type="button" className="btn btn-small" onClick={() => setChatOpen(false)}>Edit outline</button>
          </div>
        ) : (
        <section className="doc-surface" aria-label="Outline">
          <header>
            <strong>Outline</strong>
            {confirmed ? <span className="tag ok">Confirmed</span> : <span className="tag">Draft</span>}
            <span className="spacer" />
            {confirmed && piece.stage === "writing" && recipe.outline.mode !== "off" && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => {
                void act(async () => {
                  const { error: err } = await supabase.rpc("reopen_outline", { target_piece: piece.id });
                  if (err) throw err;
                  setUndo(null);
                  setFixReply(null);
                  onChanged();
                });
              }}>Reopen outline</button>
            )}
            {!confirmed && dirty && <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(save)}>Save</button>}
            {!confirmed && aiThread && <button type="button" className="btn btn-small btn-primary" onClick={() => setChatOpen(true)}>Ask AI</button>}
          </header>
          <div className="stack" style={{ padding: "18px 20px 22px" }}>
            {recipe.outline.mode === "fixed" && (
              <p className="small muted">This format starts from a fixed outline. Adjust the headings if this piece needs it.</p>
            )}
            <p className="small muted">
              Each section says which contract expectations it is responsible for. Those are what it gets checked
              against after you write it.
            </p>
            <ol className="expectations outline-list">
              {draft.map((s, i) => (
                <li key={s.key}>
                  <input type="text" value={s.heading} disabled={confirmed} onChange={(e) => update(s.key, { heading: e.target.value })}
                    placeholder="Section heading" aria-label={`Section ${i + 1} heading`} className="heading-input" />
                  <input type="text" value={s.purpose} disabled={confirmed} onChange={(e) => update(s.key, { purpose: e.target.value })}
                    placeholder="What this section does for the reader" aria-label={`Section ${i + 1} purpose`} />
                  <div className="owed">
                    {contract.expectations.map((e, n) => (
                      <label key={e.id} className={`chip${s.expectation_ids.includes(e.id) ? " on" : ""}`} title={e.text}>
                        <input type="checkbox" disabled={confirmed} checked={s.expectation_ids.includes(e.id)} onChange={(ev) => update(s.key, {
                          expectation_ids: ev.target.checked ? [...s.expectation_ids, e.id] : s.expectation_ids.filter((x) => x !== e.id),
                        })} />
                        Point {n + 1}
                      </label>
                    ))}
                  </div>
                  <details className="structure" open={s.structure.length > 0 && !confirmed}>
                    <summary className="small">
                      Structure under this heading {s.structure.length > 0 ? `(${s.structure.length} blocks)` : "(not planned)"}
                    </summary>
                    <StructureEditor blocks={s.structure} disabled={confirmed} onChange={(structure) => update(s.key, { structure })} />
                  </details>
                  {!confirmed && (
                    <div className="row" style={{ gap: 2 }}>
                      <button type="button" className="btn btn-quiet btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                      <button type="button" className="btn btn-quiet btn-small" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                      <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => setDraft(draft.filter((x) => x.key !== s.key))}>Remove</button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {!confirmed && (
              <div>
                <button type="button" className="btn btn-small" onClick={() => setDraft([...draft, { key: key(), heading: "", purpose: "", expectation_ids: [], structure: [] }])}>
                  Add section
                </button>
              </div>
            )}
            {!confirmed && recipe.outline.mode !== "off" && draft.length > 0 && (
              <div className="notice stack" style={{ gap: 8 }}>
                <p className="small">
                  <strong>Plan what goes under each heading.</strong>{" "}
                  {unplanned > 0
                    ? `${unplanned} of ${draft.length} sections have no structure yet. A section with only a heading and a purpose usually comes out as one paragraph, which search and answer engines read poorly.`
                    : "Every section has a planned structure. Edit any block, or run this again after changing the outline."}
                </p>
                <div className="row">
                  <AiAction<{ sections: { position: number; blocks: Block[] }[] }>
                    label={unplanned === draft.length ? "Improve structure" : "Improve structure again"}
                    primary={unplanned > 0}
                    disabled={dirty}
                    reason="Save your edits first so the AI sees them"
                    payload={{ task: "outline_structure", piece_id: piece.id }}
                    onDone={(r) => {
                      setDraft(draft.map((s, i) => {
                        const blocks = r.sections.find((x) => x.position === i + 1)?.blocks;
                        return blocks?.length ? { ...s, structure: blocks } : s;
                      }));
                      setUndo(null);
                      setFixReply("Structure suggested for every section. Review the blocks, edit what you like, then save.");
                    }}
                  />
                  <span className="small muted">Suggests blocks such as a short answer, a table or steps. It does not change your headings.</span>
                </div>
              </div>
            )}
            {fixReply && (
              <p className="notice small row">
                <span>{fixReply}</span>
                {undo && <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => { await save(undo); setUndo(null); setFixReply("Reverted to your previous outline."); })}>Undo</button>}
              </p>
            )}
            {uncovered.length > 0 && draft.length > 0 && (
              <p className="notice small">
                Not covered by any section: {uncovered.map((e) => `"${e.text}"`).join("; ")}
              </p>
            )}
            <ErrorText>{actionError}</ErrorText>
            {!confirmed && (
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={busy || draft.length === 0} onClick={() => act(async () => {
                  if (dirty) await save();
                  const { error: err } = await supabase.rpc("confirm_outline", { target_piece: piece.id });
                  if (err) throw err;
                  onAdvanced();
                })}>
                  Confirm outline
                </button>
                <span className="small muted">Then each section is researched, briefed and written in turn.</span>
              </div>
            )}
          </div>
        </section>
        )}

        {!confirmed && aiThread && chatOpen && (
          <ChatPanel
            messages={messages}
            kind="outline"
            pieceId={piece.id}
            placeholder={messages.length ? "Ask anything, or tell the AI what to change" : "Ask for a first outline, or chat about anything"}
            beforeSend={dirty ? () => act(save) : undefined}
            onSent={() => reload()}
            onMinimize={() => setChatOpen(false)}
            copyText={(m) => [m.content, ...(m.payload?.sections ? ["", ...m.payload.sections.map((s, i) => `${i + 1}. ${s.heading}: ${s.purpose}`)] : [])].join("\n")}
            renderExtra={(m) => m.payload?.sections ? (
              <details>
                <summary className="small">Suggested outline ({m.payload.sections.length} sections)</summary>
                <ol className="small">{m.payload.sections.map((s, i) => <li key={i}><strong>{s.heading}</strong>: {s.purpose}</li>)}</ol>
                <button type="button" className="btn btn-small btn-primary" onClick={() => {
                  // Ask first when this would replace edits that aren't saved yet.
                  if (dirty && !window.confirm("Replace your unsaved edits to the outline with this suggestion?")) return;
                  setDraft(m.payload!.sections!.map((s) => ({
                    key: keyFor(s.heading),
                    heading: s.heading,
                    purpose: s.purpose,
                    expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
                    structure: [],
                  })));
                  setChatOpen(false);
                }}>
                  Use this outline
                </button>
              </details>
            ) : null}
          />
        )}
      </div>

      {recipe.outline.seo_geo_check && <SeoGeoPanel piece={piece} scope="outline" result={piece.seo_geo_outline} disabled={dirty || data.sections.length === 0} reason={dirty ? "Save your edits first" : "Add sections first"} onDone={onChanged}
        fixBlocked={confirmed ? "The outline is confirmed, so it can't be changed here." : undefined}
        onFixOutline={(fix) => {
          const before = draft;
          const next: Draft[] = fix.sections.map((s) => ({
            key: keyFor(s.heading),
            heading: s.heading,
            purpose: s.purpose,
            expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
            structure: s.blocks,
          }));
          // Apply and save in one step; the previous outline is kept so it can be undone.
          void act(async () => {
            await save(next);
            setUndo(before);
            setFixReply(`${fix.reply} The outline is updated. Run the check again to see what is left.`);
          });
        }} />}

      {answering && (
        <Modal title="Save the expert's answer as an insight" onClose={() => setAnswering(null)}>
          <p className="small muted">Question: {answering.question}</p>
          <CardForm
            initial={{ ...emptyCard("opinion"), detail: "" }}
            submitLabel="Save insight card"
            onCancel={() => setAnswering(null)}
            onSubmit={async (f) => {
              const { data: auth } = await supabase.auth.getUser();
              const { error: err } = await supabase.from("cards").insert({ ...f, company_id: piece.company_id, created_by: auth.user!.id, origin: "manual" });
              if (err) setActionError(err.message);
              setAnswering(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** A reference in the check's text, such as [3] or "Point 2": a link while it can still be edited. */
function Ref({ label, onOpen }: { label: string; onOpen?: () => void }) {
  return onOpen
    ? <button type="button" className="ref-link" onClick={onOpen}>{label}</button>
    : <span className="faint mono">{label}</span>;
}

/** One research item, opened from the check: edit its statement, reject it, or approve it again. */
function ItemModal({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const { data, error } = useLoad(async () => must<ResearchItem>(
    await supabase.from("research_items").select("*, sources(id, url, title, published, in_library)").eq("id", id).single()), [id]);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const value = text ?? data?.statement ?? "";

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    setErr(null);
    try {
      const { error: e } = await supabase.rpc("review_item", { item: id, decision, new_statement: decision === "approved" ? value.trim() : null });
      if (e) throw e;
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Research item" onClose={onClose}>
      {error ? <ErrorText>{error}</ErrorText> : !data ? <Loading /> : (
        <div className="stack">
          <CleanTextarea rows={4} value={value} onChange={(e) => setText(e.target.value)} aria-label="Statement" />
          {data.quote && <blockquote className="quote">{data.quote}</blockquote>}
          {data.sources?.url && <a className="small" href={data.sources.url} target="_blank" rel="noreferrer">{data.sources.title || data.sources.url}</a>}
          {data.status !== "approved" && <p className="small muted">This item is currently {data.status === "rejected" ? "rejected" : "not approved"}.</p>}
          <p className="small muted">Changing research after the check makes it out of date. Run the check again to refresh it.</p>
          <ErrorText>{err}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || !value.trim() || (data.status === "approved" && value.trim() === data.statement)}
              onClick={() => decide("approved")}>{data.status === "approved" ? "Save" : "Save and approve"}</button>
            {data.status === "approved" && <button type="button" className="btn" disabled={busy} onClick={() => decide("rejected")}>Reject</button>}
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One point of the scope, opened from the check. Saving confirms the scope again; the outline keeps its link to the point. */
function PointModal({ pieceId, expectationId, onClose, onSaved }: { pieceId: string; expectationId: string; onClose: () => void; onSaved: () => void }) {
  const { data, error } = useLoad(async () => must<Contract>(await supabase.from("piece_contracts").select("*").eq("piece_id", pieceId).single()), [pieceId]);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const point = data?.expectations.find((e) => e.id === expectationId);
  const value = text ?? point?.text ?? "";

  async function saveAndConfirm() {
    if (!data) return;
    setBusy(true);
    setErr(null);
    let saved = false;
    try {
      must(await supabase.from("piece_contracts").update({
        expectations: data.expectations.map((e) => (e.id === expectationId ? { ...e, text: value.trim() } : e)),
      }).eq("piece_id", pieceId).select("piece_id"));
      saved = true;
      const { error: e } = await supabase.rpc("confirm_contract", { target_piece: pieceId });
      if (e) throw e;
      onSaved();
    } catch (e) {
      setErr(saved ? `Your edit is saved, but the scope isn't confirmed yet: ${errorMessage(e)} Confirm it again from the Scope step.` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Scope point" onClose={onClose}>
      {error ? <ErrorText>{error}</ErrorText> : !data ? <Loading /> : !point ? <p className="small muted">This point is no longer in the scope.</p> : (
        <div className="stack">
          <CleanTextarea rows={3} value={value} onChange={(e) => setText(e.target.value)} aria-label="Scope point" />
          <p className="small muted">Saving confirms the scope again. The outline keeps its link to this point.</p>
          <ErrorText>{err}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || !value.trim() || value.trim() === point.text} onClick={saveAndConfirm}>
              {busy ? "Saving…" : "Save and re-confirm"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const FIX_LABELS: Record<FixProposal["type"], string> = {
  reject_item: "Reject research",
  edit_point: "Reword scope point",
  remove_point: "Remove scope point",
  add_point: "Add scope point",
  add_section: "Add outline section",
};

/**
 * "Fix it": the AI proposes changes for what the check found; the writer ticks the ones to apply, and one Undo
 * puts them all back. Rejecting research, rewording, removing or adding scope points, and adding outline sections.
 */
function FixPanel({ piece, analysisSig, actionable, stateSig, blocked, onChanged }: {
  piece: Piece;
  analysisSig: string;
  /** Whether there is anything a fix could act on. */
  actionable: boolean;
  /** Everything the proposals depend on; when it changes, an empty result is no longer known to still hold. */
  stateSig: string;
  blocked: string | null;
  onChanged: () => void;
}) {
  // An empty result is remembered (for this browser tab) until what it was based on changes.
  const emptyKey = `writ.fixEmpty.${piece.id}`;
  const [emptySig, setEmptySigState] = useState<string | null>(() => {
    try { return sessionStorage.getItem(emptyKey); } catch { return null; }
  });
  const setEmptySig = (v: string | null) => {
    setEmptySigState(v);
    try { if (v === null) sessionStorage.removeItem(emptyKey); else sessionStorage.setItem(emptyKey, v); } catch { /* storage unavailable */ }
  };
  const knownEmpty = emptySig === stateSig;
  const [proposals, setProposals] = useState<FixProposal[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // One snapshot per applied batch, so each Apply can be undone, latest first. Kept for this browser tab, so a
  // reload doesn't lose the Undo.
  const storeKey = `writ.fixUndo.${piece.id}`;
  const [snapshots, setSnapshotList] = useState<unknown[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey) ?? "[]") as unknown[];
    } catch {
      return [];
    }
  });
  const setSnapshots = (update: (s: unknown[]) => unknown[]) => setSnapshotList((s) => {
    const next = update(s);
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    return next;
  });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A new check makes old proposals wrong (the numbers they were built on have changed). Applied batches stay undoable.
  useEffect(() => {
    setProposals(null);
    setPicked(new Set());
    setNote(null);
    setAskForce(false);
  }, [analysisSig]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const apply = () => run(async () => {
    const chosen = (proposals ?? []).filter((p) => picked.has(p.id));
    const removed = new Set(chosen.filter((p) => p.type === "remove_point").map((p) => p.point_id!));
    let skipped = 0;
    const sections = chosen.flatMap((p) => {
      if (p.type === "add_point" && p.heading) return [{ heading: p.heading, purpose: p.purpose ?? "", expectation_ids: [p.new_point_id!] }];
      if (p.type === "add_section") {
        const ids = (p.point_ids ?? []).filter((x) => !removed.has(x));
        if (!ids.length && (p.point_ids ?? []).length > 0) skipped += 1;
        return ids.length ? [{ heading: p.heading!, purpose: p.purpose ?? "", expectation_ids: ids }] : [];
      }
      return [];
    });
    const fixes = {
      reject_items: chosen.filter((p) => p.type === "reject_item").map((p) => p.item_id),
      edit_points: chosen.filter((p) => p.type === "edit_point").map((p) => ({ id: p.point_id, text: p.text })),
      remove_points: [...removed],
      add_points: chosen.filter((p) => p.type === "add_point").map((p) => ({ id: p.new_point_id, text: p.text })),
      add_sections: sections,
    };
    const { data, error: e } = await supabase.rpc("apply_alignment_fixes", { target_piece: piece.id, fixes });
    if (e) throw e;
    setSnapshots((s) => [...s, data]);
    setEmptySig(null);
    const done = chosen.length - skipped;
    setNote(`Applied ${done} ${done === 1 ? "change" : "changes"}.${skipped ? ` ${skipped} ${skipped === 1 ? "section was" : "sections were"} skipped because ${skipped === 1 ? "its point was" : "their points were"} removed.` : ""}`);
    setProposals((proposals ?? []).filter((p) => !picked.has(p.id)));
    setPicked(new Set());
    onChanged();
  });

  // Set when the piece changed after the fixes were applied: Undo then waits for the writer to say it may reverse those too.
  const [askForce, setAskForce] = useState(false);
  const undo = (force = false) => run(async () => {
    const { error: e } = await supabase.rpc("undo_alignment_fixes", { target_piece: piece.id, snapshot: snapshots[snapshots.length - 1], force });
    if (e) {
      if (e.message.includes("changed_since_apply")) { setAskForce(true); return; }
      throw e;
    }
    setAskForce(false);
    setSnapshots((s) => s.slice(0, -1));
    setEmptySig(null);
    setNote("Put the last changes back as they were.");
    setProposals(null);
    onChanged();
  });

  // Nothing a fix could act on, or an empty result that still holds: no button to click, just the way forward.
  const idle = !actionable || knownEmpty;
  const hasList = Boolean(proposals && proposals.length > 0);
  if (idle && !hasList && snapshots.length === 0 && !note) {
    return <p className="small muted">Nothing left to fix here. Record an expert's answer to a gap, restore something you ignored, or run the check again.</p>;
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <h3>Fix it</h3>
        <span className="spacer" />
        {snapshots.length > 0 && <button type="button" className="btn btn-small" disabled={busy || Boolean(blocked)} onClick={() => undo()}>Undo</button>}
        {(!idle || hasList) && (
          <AiAction<{ proposals: FixProposal[] }>
            label={proposals ? "Check for more" : "Propose fixes"}
            primary={!proposals}
            disabled={Boolean(blocked) || busy}
            reason={blocked ?? ""}
            payload={{ task: "analysis_fix", piece_id: piece.id }}
            onDone={(r) => {
              setProposals(r.proposals);
              setPicked(new Set(r.proposals.map((p) => p.id)));
              setNote(null);
              setEmptySig(r.proposals.length === 0 ? stateSig : null);
            }}
          />
        )}
      </div>
      {!proposals && !note && !idle && <p className="small muted">Suggests changes for what the check found. Nothing changes until you apply them, and you can undo them.</p>}
      {note && <p className="small muted">{note}</p>}
      {askForce && (
        <div className="notice stack" style={{ gap: 6 }}>
          <span className="small">You changed things after applying these fixes (scope, research or an added section). Undo will reverse those changes too, and anything typed into the added sections is lost.</span>
          <div className="row">
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => undo(true)}>Undo anyway</button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setAskForce(false)}>Keep my changes</button>
          </div>
        </div>
      )}
      <ErrorText>{err}</ErrorText>
      {idle && !hasList && !note && <p className="small muted">Nothing left to fix here. Record an expert's answer to a gap, restore something you ignored, or run the check again.</p>}
      {proposals && proposals.length > 0 && (
        <>
          <ul className="stack" style={{ gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
            {proposals.map((p) => (
              <li key={p.id}>
                <label className="row" style={{ gap: 10, alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <input type="checkbox" checked={picked.has(p.id)} style={{ width: "auto", margin: "4px 0 0" }}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                  <span className="stack" style={{ gap: 2 }}>
                    <span><strong>{FIX_LABELS[p.type]}</strong>{" "}
                      {p.type === "reject_item" && p.item_text}
                      {p.type === "edit_point" && <><span className="muted">{p.point_text}</span> → {p.text}</>}
                      {p.type === "remove_point" && p.point_text}
                      {p.type === "add_point" && <>{p.text}{p.heading && <span className="muted"> (with a section: {p.heading})</span>}</>}
                      {p.type === "add_section" && <>{p.heading}{p.purpose && <span className="muted"> — {p.purpose}</span>}</>}
                    </span>
                    <span className="small muted">{p.why}</span>
                  </span>
                </label>
                <button type="button" className="btn btn-quiet btn-small" style={{ marginLeft: 26 }} disabled={busy}
                  onClick={() => { setProposals((list) => (list ?? []).filter((x) => x.id !== p.id)); setPicked((s) => { const n = new Set(s); n.delete(p.id); return n; }); }}>
                  Ignore
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || picked.size === 0 || Boolean(blocked)} onClick={apply}>
              {busy ? "Applying…" : `Apply ${picked.size} ${picked.size === 1 ? "change" : "changes"}`}
            </button>
            <span className="small muted">
              {blocked ?? (proposals.some((p) => picked.has(p.id) && p.type !== "reject_item" && p.type !== "add_section") ? "Scope changes confirm the scope again." : "")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function AnalysisPanel({ piece, onRan, onAnswer, blocked, coveredIds, onOutlineChanged }: {
  piece: Piece;
  /** Scope points that a saved outline section already covers. */
  coveredIds: string[];
  onRan: () => void;
  onAnswer: (q: string) => void;
  /** Why fixes can't be applied right now (unsaved outline edits), or null. */
  blocked: string | null;
  /** Reload the outline and scope after a fix changed them. */
  onOutlineChanged: () => void;
}) {
  const a: Analysis | null = piece.analysis;
  const recipe = normalise(piece.recipe);
  // The references open only while the plan can still change, and only when the check saved what they point to.
  const editable = piece.stage === "outline" && !piece.outline_confirmed_at;
  const [open, setOpen] = useState<{ kind: "item" | "point"; id: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const itemRef = (n: number) => { const id = a?.item_ids?.[n - 1]; return id && editable ? () => setOpen({ kind: "item", id }) : undefined; };
  const pointRef = (n: number) => { const id = a?.point_ids?.[n - 1]; return id && editable ? () => setOpen({ kind: "point", id }) : undefined; };
  const refs = (items: number[] = [], points: number[] = []) => (
    <span className="refs">
      {points.map((n) => <Ref key={`p${n}`} label={`Point ${n}`} onOpen={pointRef(n)} />)}
      {items.map((n) => <Ref key={`i${n}`} label={`[${n}]`} onOpen={itemRef(n)} />)}
    </span>
  );
  // Fix it has something to work on only for drift, suggested scope changes, a verdict that isn't "aligned", or an open
  // gap about a point no section covers. A gap that is only missing evidence needs the expert, not a fix.
  const actionable = Boolean(a?.alignment) && (
    a!.alignment!.verdict !== "aligned"
    || (a!.drift ?? []).some((d) => !d.ignored)
    || (a!.contract_suggestions ?? []).length > 0
    || a!.gaps.some((g) => !g.ignored && (g.points ?? []).some((n) => {
      const id = a!.point_ids?.[n - 1];
      return Boolean(id) && !coveredIds.includes(id!);
    }))
  );
  const stateSig = JSON.stringify([a, coveredIds]);
  const [ignoring, setIgnoring] = useState(false);
  const [ignoreErr, setIgnoreErr] = useState<string | null>(null);
  const ignoredCount = (a?.gaps ?? []).filter((g) => g.ignored).length + (a?.drift ?? []).filter((d) => d.ignored).length;
  /** Ignore (or restore) one finding. It is saved with the check, and the fix proposals leave it alone. */
  async function setIgnored(kind: "gaps" | "drift", index: number, value: boolean) {
    if (!a) return;
    setIgnoring(true);
    setIgnoreErr(null);
    try {
      const list = (a[kind] ?? []).map((x, i) => (i === index ? { ...x, ignored: value || undefined } : x));
      must(await supabase.from("pieces").update({ analysis: { ...a, [kind]: list } }).eq("id", piece.id).select("id"));
      onRan();
    } catch (e) {
      setIgnoreErr(errorMessage(e));
    } finally {
      setIgnoring(false);
    }
  }
  return (
    <section className="card stack" aria-label="Analysis">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h2>Alignment with your topic</h2>
          <p className="small muted">Whether the scope and research still match the topic you started with, and what is missing.</p>
        </div>
        <span className="spacer" />
        {!piece.outline_confirmed_at && (
          <AiAction label={a ? "Run again" : "Check alignment"} primary={!a} payload={{ task: "analysis", piece_id: piece.id }} onDone={() => { setChanged(false); onRan(); }} />
        )}
      </div>
      <ErrorText>{ignoreErr}</ErrorText>
      {changed && <p className="small notice">The scope or research changed since this check. Run it again to refresh it.</p>}
      {a && !a.alignment && (
        <p className="small muted">This result is from an earlier version of the check, which looked at the sources. Run it again for the alignment check.</p>
      )}
      {a?.alignment && (
        <div className="stack analysis" style={{ gap: 14 }}>
          <div className="row">
            <span className={`tag${a.alignment.verdict === "aligned" ? " ok" : ""}`}>
              {{ aligned: "Aligned", partly: "Partly aligned", drifted: "Drifted" }[a.alignment.verdict]}
            </span>
          </div>
          {a.drift && a.drift.some((d) => !d.ignored) && (
            <div>
              <h3>Where it drifts</h3>
              <ul className="finding-list">
                {a.drift.map((d, i) => d.ignored ? null : (
                  <li key={i} className="finding">
                    <p>{d.text}</p>
                    {refs(d.items, d.points)}
                    <div className="row finding-actions">
                      <button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("drift", i, true)}>Ignore</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recipe.analysis.gaps && (
            <div>
              <h3>Open gaps</h3>
              {a.gaps.some((g) => !g.ignored) ? (
                <ul className="finding-list">
                  {a.gaps.map((g, i) => g.ignored ? null : (
                    <li key={i} className="finding">
                      <p>{g.text}</p>
                      {refs([], g.points)}
                      <div className="small muted">Ask your expert: {g.expert_question}</div>
                      <div className="row finding-actions">
                        <button type="button" className="btn btn-primary btn-small" onClick={() => onAnswer(g.expert_question)}>Record the answer</button>
                        <button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("gaps", i, true)}>Ignore</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="small faint">{a.gaps.length ? "All gaps ignored." : "None found."}</p>}
            </div>
          )}
          {ignoredCount > 0 && (
            <details className="small">
              <summary className="muted">{ignoredCount} ignored</summary>
              <ul className="finding-list" style={{ marginTop: 8 }}>
                {a.drift?.map((d, i) => !d.ignored ? null : (
                  <li key={`d${i}`} className="finding is-ignored">
                    <p>{d.text}</p>
                    <div className="row finding-actions"><button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("drift", i, false)}>Restore</button></div>
                  </li>
                ))}
                {a.gaps.map((g, i) => !g.ignored ? null : (
                  <li key={`g${i}`} className="finding is-ignored">
                    <p>{g.text}</p>
                    <div className="row finding-actions"><button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("gaps", i, false)}>Restore</button></div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {a?.contract_suggestions && a.contract_suggestions.length > 0 && (
        <div className="notice stack" style={{ gap: 6 }}>
          <strong className="small">The research suggests changes to your scope</strong>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {a.contract_suggestions.map((c, i) => <li key={i}>{c.change} <span className="muted">({c.why})</span></li>)}
          </ul>
          <span className="small muted">If you agree, edit the scope in step 1 and confirm it again before confirming the outline.</span>
        </div>
      )}
      {editable && a?.alignment && (
        <FixPanel piece={piece} actionable={actionable} stateSig={stateSig} analysisSig={JSON.stringify(a, (k, v) => (k === "ignored" ? undefined : v))} blocked={blocked} onChanged={() => { setChanged(true); onRan(); onOutlineChanged(); }} />
      )}
      {open?.kind === "item" && <ItemModal id={open.id} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setChanged(true); onRan(); }} />}
      {open?.kind === "point" && <PointModal pieceId={piece.id} expectationId={open.id} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setChanged(true); onRan(); }} />}
    </section>
  );
}
