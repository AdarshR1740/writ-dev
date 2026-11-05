import { useEffect, useState } from "react";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { BLOCK_LABELS, type Analysis, type Block, type BlockType, type Contract, type Piece, type Section, type ThreadMessage } from "../lib/types";
import { CardForm, emptyCard } from "./CardForm";
import { AiAction, ErrorText, Loading, Modal, CleanTextarea } from "./ui";
import { SeoGeoPanel } from "./SeoGeoPanel";
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
  const { data, error, reload, setData } = useLoad(async () => {
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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<{ question: string } | null>(null);
  const [fixReply, setFixReply] = useState<string | null>(null);
  // The outline as it was before "Fix now" changed it, so the change can be undone.
  const [undo, setUndo] = useState<Draft[] | null>(null);
  const confirmed = Boolean(piece.outline_confirmed_at);
  const recipe = normalise(piece.recipe);
  const aiThread = recipe.outline.mode === "free" && recipe.outline.ai_thread;

  useEffect(() => {
    if (data && draft === null) {
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
    setDraft(null);
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
      {recipe.analysis.enabled && <AnalysisPanel piece={piece} onRan={onChanged} onAnswer={(q) => setAnswering({ question: q })} />}

      <div className="workbench">
        <section className="doc-surface" aria-label="Outline">
          <header>
            <strong>Outline</strong>
            {confirmed ? <span className="tag ok">Confirmed</span> : <span className="tag">Draft</span>}
            <span className="spacer" />
            {confirmed && piece.stage === "writing" && recipe.outline.mode !== "off" && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => {
                if (!window.confirm("Reopen the outline for editing?\n\nSections you have already written keep their text. Writing pauses until you confirm the outline again. Sections you remove lose their text.")) return;
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

        {!confirmed && aiThread && (
          <aside className="rail thread" aria-label="Conversation">
            <h3>Work it out with AI</h3>
            <div className="messages">
              {messages.length === 0 && <p className="small muted">Ask for a first outline built from your scope and the reviewed research.</p>}
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <p>{m.content}</p>
                  {m.role === "ai" && m.payload?.sections && (
                    <details>
                      <summary className="small">Suggested outline ({m.payload.sections.length} sections)</summary>
                      <ol className="small">{m.payload.sections.map((s, i) => <li key={i}><strong>{s.heading}</strong>: {s.purpose}</li>)}</ol>
                      <button type="button" className="btn btn-small" onClick={() => setDraft(m.payload!.sections!.map((s) => ({
                        key: keyFor(s.heading),
                        heading: s.heading,
                        purpose: s.purpose,
                        expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
                        structure: [],
                      })))}>
                        Use this outline
                      </button>
                    </details>
                  )}
                </div>
              ))}
            </div>
            <CleanTextarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Put the cost comparison before the deep dives" aria-label="Message" style={{ minHeight: 70 }} />
            <AiAction<{ message: ThreadMessage }>
              label={messages.length ? "Send" : "Suggest an outline"}
              disabled={dirty}
              reason="Save your edits first so the AI sees them"
              payload={{ task: "outline_suggest", piece_id: piece.id, message }}
              onDone={(r) => {
                setData((d) => d && { ...d, messages: [...d.messages, r.message] });
                setMessage("");
                reload();
              }}
            />
          </aside>
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

function AnalysisPanel({ piece, onRan, onAnswer }: { piece: Piece; onRan: () => void; onAnswer: (q: string) => void }) {
  const a: Analysis | null = piece.analysis;
  return (
    <section className="card stack" aria-label="Analysis">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h2>Where the substance is</h2>
          <p className="small muted">Tensions between sources, where your own insight differs from the consensus, and what nobody answers.</p>
        </div>
        <span className="spacer" />
        {!piece.outline_confirmed_at && (
          <AiAction label={a ? "Run again" : "Analyse research"} primary={!a} payload={{ task: "analysis", piece_id: piece.id }} onDone={onRan} />
        )}
      </div>
      {a && (
        <div className="grid-3 analysis">
          <div>
            <h3>Tensions</h3>
            {a.tensions.length ? <ul>{a.tensions.map((t, i) => <li key={i}>{t.text} <span className="faint mono">{t.items.map((n) => `[${n}]`).join("")}</span></li>)}</ul> : <p className="small faint">None found.</p>}
          </div>
          <div>
            <h3>Your insight vs. the consensus</h3>
            {a.consensus_vs_insight.length ? <ul>{a.consensus_vs_insight.map((t, i) => <li key={i}>{t.text} <span className="faint mono">{t.items.map((n) => `[${n}]`).join("")}</span></li>)}</ul> : <p className="small faint">No company insight in the approved research yet.</p>}
          </div>
          <div>
            <h3>Open gaps</h3>
            {a.gaps.length ? (
              <ul>
                {a.gaps.map((g, i) => (
                  <li key={i}>
                    {g.text}
                    <div className="small muted">Ask your expert: {g.expert_question}</div>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => onAnswer(g.expert_question)}>Record the answer</button>
                  </li>
                ))}
              </ul>
            ) : <p className="small faint">None found.</p>}
          </div>
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
    </section>
  );
}
