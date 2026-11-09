import { useEffect, useRef, useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { formatCost } from "../lib/format";
import { useShowCosts } from "../lib/showCosts";
import { must, useLoad } from "../lib/useLoad";
import { BLOCK_LABELS, type Analysis, type Block, type Contract, type FixProposal, type Piece, type ResearchItem, type Section, type ThreadMessage } from "../lib/types";
import { CardForm, emptyCard } from "./CardForm";
import { AiAction, CleanTextarea, ErrorText, Loading, Modal } from "./ui";
import { cardDetail } from "../lib/cards";
import { SeoGeoPanel, type OutlineFix, type SeoGeoResult } from "./SeoGeoPanel";
import { BlockTypePicker } from "./BlockTypePicker";
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

/** The piece's working title and primary keyword, editable on the outline. Each is saved when you leave its box. */
function TitleFields({ piece, disabled, onSaved }: { piece: Piece; disabled: boolean; onSaved: () => void }) {
  const [title, setTitle] = useState(piece.title);
  const [keyword, setKeyword] = useState(piece.primary_keyword ?? "");
  const [err, setErr] = useState<string | null>(null);
  // Follow the piece when something else changes it (an SEO fix, or Undo).
  useEffect(() => setTitle(piece.title), [piece.title]);
  useEffect(() => setKeyword(piece.primary_keyword ?? ""), [piece.primary_keyword]);

  async function persist(patch: { title?: string; primary_keyword?: string }) {
    setErr(null);
    try {
      must(await supabase.from("pieces").update(patch).eq("id", piece.id).select("id"));
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="title-fields">
        <label className="stack" style={{ gap: 4 }}>
          <span className="small muted">Working title</span>
          <input type="text" value={title} disabled={disabled} maxLength={160} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const t = title.trim(); if (t && t !== piece.title) void persist({ title: t }); else setTitle(piece.title); }} />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="small muted">Primary keyword</span>
          <input type="text" value={keyword} disabled={disabled} maxLength={120} placeholder="The phrase people search for" onChange={(e) => setKeyword(e.target.value)}
            onBlur={() => { const k = keyword.trim(); if (k !== (piece.primary_keyword ?? "")) void persist({ primary_keyword: k }); }} />
        </label>
      </div>
      <ErrorText>{err}</ErrorText>
    </div>
  );
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
            <BlockTypePicker value={b.type} disabled={disabled} onChange={(type) => set(i, { type })} label={`Block ${i + 1} type`} />
            {!disabled && (
              <span className="row block-controls" style={{ gap: 2 }}>
                <button type="button" className="btn btn-quiet btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move block up">↑</button>
                <button type="button" className="btn btn-quiet btn-small" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move block down">↓</button>
                <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block">✕</button>
              </span>
            )}
            {/* The note gets the full width of the box on its own line, and grows with its text, so none of it is cut off. */}
            <textarea className="block-note" value={b.note} disabled={disabled} rows={Math.max(1, b.note.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 95)), 0))}
              onChange={(e) => set(i, { note: e.target.value })} placeholder="What goes in this block" aria-label={`Block ${i + 1} note`} />
          </li>
        ))}
      </ol>
      {!disabled && <div><button type="button" className="btn btn-small" onClick={() => onChange([...blocks, { type: "paragraph", note: "" }])}>Add block</button></div>}
    </div>
  );
}

const key = () => Math.random().toString(36).slice(2, 9);

const cleanBlocks = (b: Block[]) => b.filter((x) => x.note.trim()).map((x) => ({ type: x.type, note: x.note.trim() }));
/** What gets saved: the sections that have a heading, in order, with their blocks tidied. */
const savable = (list: Draft[]) => list.filter((s) => s.heading.trim()).map((s) => ({
  id: s.key, heading: s.heading.trim(), purpose: s.purpose.trim(), expectation_ids: s.expectation_ids, structure: cleanBlocks(s.structure),
}));
/** The same, as one comparable string: equal means there is nothing new to save. */
const outlineSig = (list: { heading: string; purpose: string; expectation_ids: string[]; structure?: Block[] | null }[]) =>
  JSON.stringify(list.filter((s) => s.heading.trim()).map((s) => [s.heading.trim(), s.purpose.trim(), s.expectation_ids, cleanBlocks(s.structure ?? [])]));

/** Analysis of the reviewed research, then the outline (writer-owned, AI-suggested). */
export function OutlineStep({ piece, onAdvanced, onChanged }: { piece: Piece; onAdvanced: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad(async () => {
    const [contract, sections, thread, approved, pending] = await Promise.all([
      supabase.from("piece_contracts").select("*").eq("piece_id", piece.id).single().then(must<Contract>),
      supabase.from("piece_sections").select("*").eq("piece_id", piece.id).order("position").then(must<Section[]>),
      // The conversation comes with the thread, in one trip.
      supabase.from("threads").select("id, thread_messages(*)").eq("piece_id", piece.id).eq("subject", "outline")
        .order("created_at", { referencedTable: "thread_messages" }).maybeSingle()
        .then(must<{ id: string; thread_messages: ThreadMessage[] } | null>),
      // The approved research as it is now, to tell when the saved check no longer matches it.
      supabase.from("research_items").select("id").eq("piece_id", piece.id).eq("scope", "piece").eq("status", "approved").then(must<{ id: string }[]>),
      // Research found for the gaps and waiting for the writer's decision.
      supabase.from("research_items").select("*, sources(id, url, title, published, in_library)").eq("piece_id", piece.id)
        .eq("scope", "piece").eq("status", "unreviewed").order("created_at").then(must<ResearchItem[]>),
    ]);
    const messages = thread?.thread_messages ?? [];
    return { contract, sections, messages, itemIds: approved.map((r) => r.id), pendingItems: pending };
  }, [piece.id]);

  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<{ question: string } | null>(null);
  // Counts expert answers added to the research, so the check can say it is out of date.
  const [answeredCount, setAnsweredCount] = useState(0);
  const savedCard = useRef<string | null>(null);
  const savedQuote = useRef("");
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

  // Edits are saved by themselves a moment after the writer stops typing. The draft is left as it is (not reloaded
  // from the server) so nothing typed while a save runs is lost.
  // The SEO & GEO results appear (at the top) only after the writer runs the checks.
  const [seoOpen, setSeoOpen] = useState(false);
  // What an AI action in the outline's header is doing right now, for the animation (null when none is).
  const [working, setWorking] = useState<string | null>(null);
  // Same for the Fix it chain in the SEO & GEO panel, which has several steps.
  const [fixWorking, setFixWorking] = useState<string | null>(null);
  const fixChain = useRef(false);
  // The working title before the SEO/GEO fix changed it, so Undo can put it back.
  // `to` is the title the fix set; Undo restores `from` only if the title is still `to` (not edited by hand since).
  const [undoTitle, setUndoTitle] = useState<{ from: string; to: string } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  // The outline as it was when a save last failed: it isn't tried again until the writer changes something.
  const failedSig = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !draft || confirmed || saveState === "saving" || busy) return;
    const sig = outlineSig(draft);
    if (sig === outlineSig(data.sections) || sig === failedSig.current) return;
    const t = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const { error: err } = await supabase.rpc("save_outline", { target_piece: piece.id, sections: savable(draft) });
        if (err) throw err;
        failedSig.current = null;
        await reload();
        setSaveState("idle");
      } catch (e) {
        failedSig.current = sig;
        setActionError(errorMessage(e));
        setSaveState("error");
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [draft, data, confirmed, saveState, busy]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data || !draft) return <Loading />;
  const { contract, messages } = data;
  // Not saved yet (the editor saves by itself shortly after an edit).
  const dirty = outlineSig(draft) !== outlineSig(data.sections);
  // Every section with a heading already has sub-sections, so there is nothing for Define sub-sections to plan.
  const allPlanned = draft.filter((s) => s.heading.trim()).every((s) => s.structure.length > 0);
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
    // While this runs, the automatic save waits, so the two never write at once.
    setSaveState("saving");
    try {
      const { error: err } = await supabase.rpc("save_outline", { target_piece: piece.id, sections: savable(list) });
      if (err) throw err;
      failedSig.current = null;
      resync.current = data;
      await reload();
    } finally {
      setSaveState("idle");
    }
  }

  // A section the AI keeps under the same heading stays the same section, so its text and research are kept.
  const keyFor = (heading: string) => draft.find((d) => d.heading.trim().toLowerCase() === heading.trim().toLowerCase())?.key ?? key();
  const update = (k: string, patch: Partial<Draft>) => setDraft(draft.map((s) => (s.key === k ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const list = [...draft];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setDraft(list);
  };

  /**
   * "Create outline": the AI plans the sections from the confirmed scope and research, then what goes inside each one.
   * The result lands in the editor as a draft (saved, not confirmed); the outline it replaces can be put back with Undo.
   */
  async function createOutline(progress: (text: string) => void) {
    const before = draft ?? [];
    progress("Planning the sections…");
    const built = await callFunction<{ sections: { heading: string; purpose: string; expectations: number[] }[] }>("ai", { task: "outline_build", piece_id: piece.id });
    const planned: Draft[] = built.sections.map((s) => ({
      key: keyFor(s.heading),
      heading: s.heading,
      purpose: s.purpose,
      expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
      structure: [],
    }));
    await save(planned);
    if (before.some((s) => s.heading.trim())) setUndo(before);
    setUndoTitle(null);
    progress("Planning what goes in each section…");
    let note = "The outline is ready. Edit it as you like, then confirm it.";
    let structured = true;
    try {
      const st = await callFunction<{ sections: { position: number; blocks: Block[] }[] }>("ai", { task: "outline_structure", piece_id: piece.id });
      await save(planned.map((s, i) => ({ ...s, structure: st.sections.find((x) => x.position === i + 1)?.blocks ?? [] })));
    } catch (e) {
      // The sections are saved; only the planning inside them is missing.
      structured = false;
      note = `The sections are ready, but planning the sub-sections didn't finish (${errorMessage(e)}). Use Define sub-sections to try again.`;
    }
    // The search and answer-engine checks run here, once, and what they find is fixed. After this the writer edits the
    // outline and runs the checks again themselves, from the button at the top.
    if (structured && recipe.outline.seo_geo_check) {
      let fixed = 0;
      try {
        progress("Checking the outline for search and answer engines…");
        await callFunction("ai", { task: "seo_geo_check", piece_id: piece.id, scope: "outline" });
        const { data: row } = await supabase.from("pieces").select("seo_geo_outline").eq("id", piece.id).single();
        const improve = ((row?.seo_geo_outline as SeoGeoResult | null)?.checks ?? []).filter((c) => c.status === "improve").length;
        if (improve > 0) {
          progress(`Fixing ${improve} ${improve === 1 ? "thing" : "things"} the checks found…`);
          const fix = await callFunction<OutlineFix>("ai", { task: "seo_fix", piece_id: piece.id, scope: "outline" });
          await save(outlineFromFix(fix));
          fixed = improve;
          // Only the issues that were flagged are checked again, not the whole outline.
          progress("Checking the fixed issues again…");
          const v = await callFunction<{ closed: number; open: number }>("ai", { task: "seo_geo_verify", piece_id: piece.id });
          note = `The outline is ready. The search and answer-engine checks flagged ${improve} ${improve === 1 ? "issue" : "issues"}; the AI made small changes, and ${v.closed} ${v.closed === 1 ? "is" : "are"} now fixed${v.open > 0 ? `, ${v.open} still open` : ""}. Edit the outline as you like, then run the checks again yourself.`;
          if (v.open > 0) setSeoOpen(true);
        } else {
          note = "The outline is ready, and it passed the search and answer-engine checks. Edit it as you like, then run the checks again yourself.";
        }
      } catch (e) {
        // The fix is in but the check on it didn't finish: show the panel so the writer can see where things stand.
        if (fixed > 0) setSeoOpen(true);
        note = fixed > 0
          ? `The outline is ready, and the AI made small changes for ${fixed} ${fixed === 1 ? "thing" : "things"} the search and answer-engine checks found. The final check didn't finish (${errorMessage(e)}); use Run SEO & GEO Checks to see where it stands.`
          : `The outline is ready, but the search and answer-engine checks didn't finish (${errorMessage(e)}). Use Run SEO & GEO Checks to try again.`;
      }
    }
    onChanged();
    setFixReply(note);
  }

  /** Ignores (or brings back) one issue in the SEO and GEO results. Fix it and the re-check leave ignored ones alone. */
  async function ignoreSeo(check: string, value: boolean) {
    await act(async () => {
      // Read the saved results again, so a quick second click doesn't overwrite the first.
      const { data: row } = await supabase.from("pieces").select("seo_geo_outline").eq("id", piece.id).single();
      const cur = row?.seo_geo_outline as SeoGeoResult | null;
      if (!cur) return;
      must(await supabase.from("pieces").update({
        seo_geo_outline: { ...cur, checks: cur.checks.map((c) => (c.check === check ? { ...c, ignored: value || undefined } : c)) },
      }).eq("id", piece.id).select("id"));
      onChanged();
    });
  }

  /** The AI's revised outline from the SEO/GEO fix, as editor sections. */
  function outlineFromFix(fix: OutlineFix): Draft[] {
    return fix.sections.map((s) => ({
      key: keyFor(s.heading),
      heading: s.heading,
      purpose: s.purpose,
      expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
      structure: s.blocks,
    }));
  }

  // The benchmark comes first. Once the writer finalizes it, it gives way to the outline editor. A format with no
  // benchmark, or an outline that is already confirmed, goes straight to the editor.
  const benchmarkDone = Boolean((piece.analysis as Analysis | null)?.benchmark_done);
  const showBenchmark = recipe.analysis.enabled && !confirmed && !benchmarkDone;
  const showOutline = !recipe.analysis.enabled || confirmed || benchmarkDone;

  return (
    <div className="stack-lg">
      {recipe.analysis.enabled && !confirmed && benchmarkDone && (
        <div className="row notice" style={{ alignItems: "center" }}>
          <span className="small">The benchmark of your scope and research is finished.</span>
          <span className="spacer" />
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => {
            const { benchmark_done: _done, ...rest } = (piece.analysis ?? {}) as Analysis;
            must(await supabase.from("pieces").update({ analysis: rest }).eq("id", piece.id).select("id"));
            onChanged();
          })}>Show the benchmark</button>
        </div>
      )}
      {showBenchmark && (
        <AnalysisPanel
          piece={piece}
          onRan={onChanged}
          onAnswer={(q) => setAnswering({ question: q })}
          blocked={dirty ? "Save your outline edits first" : null}
          coveredIds={data.sections.flatMap((s) => s.expectation_ids)}
          answeredCount={answeredCount}
          currentItemIds={data.itemIds}
          pendingItems={data.pendingItems}
          currentPointIds={contract.expectations.map((e) => e.id)}
          hasOutline={draft.some((s) => s.heading.trim())}
          createOutline={createOutline}
          onOutlineChanged={() => { resync.current = data; void reload(); }}
        />
      )}

      {showOutline && <>
      {/* Shown at the top after the checks are run: only what needs improving, with Fix it. */}
      {seoOpen && !confirmed && recipe.outline.seo_geo_check && piece.seo_geo_outline && (
        <SeoGeoPanel piece={piece} scope="outline" result={piece.seo_geo_outline} hideRun
          disabled={dirty || saveState === "saving" || data.sections.length === 0} reason="Saving…" onDone={onChanged}
          onClose={() => setSeoOpen(false)}
          working={fixWorking}
          // The animation starts with the AI's work; if that fails, nothing else follows, so it stops here.
          onFixBusy={(b) => { if (b) setFixWorking("Finding small changes to make…"); else if (!fixChain.current) setFixWorking(null); }}
          onFixOutline={(fix) => {
            const before = draft;
            const next = outlineFromFix(fix);
            const oldTitle = piece.title;
            // The AI's small changes are applied and saved in one step (the previous outline, and title, are kept for Undo);
            // then only the flagged issues are checked again, and the panel shows what is left.
            fixChain.current = true;
            void act(async () => {
              try {
                setFixWorking("Applying the changes…");
                await save(next);
                setUndo(before);
                if (fix.title) {
                  must(await supabase.from("pieces").update({ title: fix.title }).eq("id", piece.id).select("id"));
                  setUndoTitle({ from: oldTitle, to: fix.title });
                } else {
                  setUndoTitle(null);
                }
                setFixWorking("Checking the flagged issues again…");
                try {
                  await callFunction("ai", { task: "seo_geo_verify", piece_id: piece.id });
                } catch (e) {
                  setActionError(`Couldn't check the flagged issues again (${errorMessage(e)}). Run the checks again to see where they stand.`);
                }
                onChanged();
                const s = fix.summary;
                const changed = Boolean(fix.title) || Boolean(s && (s.edited || s.added || s.moved || s.blocks));
                setFixReply(changed ? "The outline is updated." : "Nothing in the outline could be changed for these issues.");
              } finally {
                fixChain.current = false;
                setFixWorking(null);
              }
            });
          }}
          onIgnore={ignoreSeo} />
      )}
      <div className={`workbench${chatOpen && !confirmed && aiThread ? " chat-open" : " no-rail"}`}>
        {chatOpen && !confirmed && aiThread ? (
          <div className="scope-bar">
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span className="small muted">Outline · {dirty || saveState === "saving" ? "Saving…" : "Draft"}</span>
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
                  setSeoOpen(false);
                  onChanged();
                });
              }}>Reopen outline</button>
            )}
            {!confirmed && (saveState === "error" && dirty
              ? <span className="small" style={{ color: "var(--flag, #b3261e)" }}>Couldn't save. Your edits are kept here; change something to try again.</span>
              : (dirty || saveState === "saving") && <span className="small faint">Saving…</span>)}
            {!confirmed && recipe.outline.mode !== "off" && draft.some((s) => s.heading.trim()) && (
              <AiAction<{ sections: { position: number; blocks: Block[] }[] }>
                label="Define sub-sections"
                primary={false}
                small
                reasonAsTitle
                disabled={dirty || saveState === "saving" || allPlanned}
                reason={saveState === "error" ? "Your last edit couldn't be saved" : allPlanned ? "Every section has sub-sections" : "Saving…"}
                // Only sections that have none are planned; the sub-sections you already have are left as they are.
                payload={{ task: "outline_structure", piece_id: piece.id, only_missing: true }}
                onBusyChange={(b) => setWorking(b ? "Defining the sub-sections…" : null)}
                onDone={(r) => {
                  // Sections the AI planned get their blocks; they are saved by themselves like any other edit. The
                  // positions count only sections with a heading, as the server does.
                  let n = 0;
                  setDraft(draft.map((s) => {
                    if (!s.heading.trim()) return s;
                    n += 1;
                    const blocks = r.sections.find((x) => x.position === n)?.blocks;
                    return blocks?.length ? { ...s, structure: blocks } : s;
                  }));
                  setUndo(null);
                  setFixReply(null);
                }}
              />
            )}
            {!confirmed && recipe.outline.seo_geo_check && (
              <AiAction label="Run SEO & GEO Checks" primary={false} small reasonAsTitle disabled={dirty || saveState === "saving" || data.sections.length === 0}
                reason="Saving…" payload={{ task: "seo_geo_check", piece_id: piece.id, scope: "outline" }} onDone={() => { setSeoOpen(true); onChanged(); }}
                onBusyChange={(b) => setWorking(b ? "Running the search and answer-engine checks…" : null)} />
            )}
            {!confirmed && aiThread && <button type="button" className="btn btn-small btn-primary" onClick={() => setChatOpen(true)}>Ask AI</button>}
          </header>
          <div className="stack" style={{ padding: "18px 20px 22px" }}>
            {recipe.outline.mode === "fixed" && (
              <p className="small muted">This format starts from a fixed outline. Adjust the headings if this piece needs it.</p>
            )}
            {/* The working title and primary keyword, here so anything the SEO & GEO checks say about them can be fixed in place. */}
            {(recipe.outline.seo_geo_check || piece.primary_keyword) && <TitleFields piece={piece} disabled={confirmed} onSaved={onChanged} />}
            <p className="small muted">
              Each section says which contract expectations it is responsible for. Those are what it gets checked
              against after you write it.
            </p>
            {working && (
              <div className="applying" role="status" aria-live="polite">
                <div className="applying-ring" aria-hidden="true"><span /></div>
                <strong>{working}</strong>
                <span className="small muted">This can take a minute.</span>
              </div>
            )}
            <ol className="expectations outline-list" style={working ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
              {draft.map((s, i) => (
                <li key={s.key}>
                  {/* One card per section: the heading with its controls, what it is for, the points it serves, and its sub-sections. */}
                  <div className="outline-card">
                    <div className="section-head">
                      <input type="text" value={s.heading} disabled={confirmed} onChange={(e) => update(s.key, { heading: e.target.value })}
                        placeholder="Section heading" aria-label={`Section ${i + 1} heading`} className="heading-input" />
                      {!confirmed && (
                        <div className="row" style={{ gap: 2, flexWrap: "nowrap" }}>
                          <button type="button" className="btn btn-quiet btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move section up">↑</button>
                          <button type="button" className="btn btn-quiet btn-small" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label="Move section down">↓</button>
                          <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => setDraft(draft.filter((x) => x.key !== s.key))}>Remove</button>
                        </div>
                      )}
                    </div>
                    {/* A box that grows with its text, so a long purpose is never cut off. */}
                    <textarea className="purpose-input" value={s.purpose} disabled={confirmed} rows={Math.max(1, Math.ceil(s.purpose.length / 100))}
                      onChange={(e) => update(s.key, { purpose: e.target.value })}
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
                    {/* Closed by default, with the kinds of block in the summary, so the whole outline can be read at a glance. */}
                    <details className="structure">
                      <summary className="small">
                        <span className="structure-title">Sub-sections</span>
                        <span className="clip">
                          {s.structure.length > 0
                            ? `· ${s.structure.length}: ${s.structure.map((b) => BLOCK_LABELS[b.type] ?? b.type).join(" · ")}`
                            : "· none yet"}
                        </span>
                      </summary>
                      <StructureEditor blocks={s.structure} disabled={confirmed} onChange={(structure) => update(s.key, { structure })} />
                    </details>
                  </div>
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
            {fixReply && (
              <p className="notice small row">
                <span>{fixReply}</span>
                {undo && <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => {
                  await save(undo);
                  if (undoTitle !== null) {
                    // Put the old title back only if nobody has changed it since the fix did.
                    if (piece.title === undoTitle.to) {
                      must(await supabase.from("pieces").update({ title: undoTitle.from }).eq("id", piece.id).select("id"));
                    }
                    setUndoTitle(null);
                    onChanged();
                  }
                  setUndo(null);
                  setFixReply("Reverted to your previous outline.");
                })}>Undo</button>}
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
                  setSeoOpen(false);
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
                  // Only what changed is updated: a section the AI left as it was stays exactly as it is, including the
                  // sub-sections planned for it. A changed section keeps its sub-sections too, unless it is new.
                  const norm = (h: string) => h.trim().toLowerCase();
                  const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every((id) => y.includes(id));
                  const incoming = m.payload!.sections!.map((s) => ({
                    heading: s.heading,
                    purpose: s.purpose,
                    expectation_ids: s.expectations.map((n) => contract.expectations[n - 1]?.id).filter((x): x is string => Boolean(x)),
                  }));
                  let changed = 0;
                  // Each existing section is matched once, so two sections with the same heading stay two sections.
                  const used = new Set<string>();
                  const merged: Draft[] = incoming.map((inc) => {
                    const old = draft.find((d) => !used.has(d.key) && norm(d.heading) === norm(inc.heading));
                    if (old) used.add(old.key);
                    if (old && old.purpose.trim() === inc.purpose.trim() && sameSet(old.expectation_ids, inc.expectation_ids)) return old;
                    changed += 1;
                    return { ...inc, key: old?.key ?? key(), structure: old?.structure ?? [] };
                  });
                  const dropped = draft.filter((d) => d.heading.trim() && !incoming.some((inc) => norm(inc.heading) === norm(d.heading))).length;
                  const before = draft;
                  setUndo(before);
                  setUndoTitle(null);
                  setDraft(merged);
                  setFixReply(`Updated ${changed} of ${merged.length} sections${dropped ? ` and removed ${dropped}` : ""}. The others are untouched.`);
                  setChatOpen(false);
                }}>
                  Use this outline
                </button>
              </details>
            ) : null}
          />
        )}
      </div>

      </>}

      {answering && (
        <Modal title="Add the expert's answer to this piece's research" onClose={() => { savedCard.current = null; setActionError(null); setAnswering(null); }}>
          <p className="small muted">Question: {answering.question}</p>
          <ErrorText>{actionError}</ErrorText>
          <p className="small muted">The answer is saved as an insight card in your library and added to this piece's research as an approved item, so the next check counts it.</p>
          <CardForm
            initial={{ ...emptyCard("opinion"), detail: "" }}
            submitLabel="Save and add to research"
            onCancel={() => { savedCard.current = null; setActionError(null); setAnswering(null); }}
            onSubmit={async (f) => {
              setActionError(null);
              try {
                // The card is saved once; if adding it to the research fails, a retry reuses it instead of making a copy.
                if (!savedCard.current) {
                  const { data: auth } = await supabase.auth.getUser();
                  const card = must(await supabase.from("cards").insert({ ...f, company_id: piece.company_id, created_by: auth.user!.id, origin: "manual" }).select("id, claim, detail").single()) as { id: string; claim: string; detail: string };
                  savedCard.current = card.id;
                  savedQuote.current = cardDetail(card.claim, card.detail);
                }
                // The writer is the one giving this answer, so it is added as approved.
                const { error: e } = await supabase.rpc("add_answer_to_research", { target_piece: piece.id, card: savedCard.current, item_quote: savedQuote.current });
                if (e) throw e;
                savedCard.current = null;
                setAnsweredCount((n) => n + 1);
                onChanged();
                await reload();
                setAnswering(null);
              } catch (e) {
                // Keep the form open so nothing typed is lost.
                setActionError(`${savedCard.current ? "The answer is saved as an insight card, but it isn't in the research yet: " : ""}${errorMessage(e)}`);
              }
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

/** Research a search for the gaps found: approve or reject each item. Approved items count the next time the check runs. */
function PendingResearch({ items, onDecided, onOpen }: { items: ResearchItem[]; onDecided: () => void; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    setErr(null);
    try {
      const { error: e } = await supabase.rpc("review_item", { item: id, decision, new_statement: null });
      if (e) throw e;
      onDecided();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3>New research to review ({items.length})</h3>
      <p className="small muted">Found by the search for the gaps above. Approve what you want to keep, then run the check again.</p>
      <ErrorText>{err}</ErrorText>
      <ul className="finding-list">
        {items.map((it) => (
          <li key={it.id} className="finding">
            <p>{it.statement}</p>
            {it.quote && <blockquote className="quote small">{it.quote}</blockquote>}
            {it.sources?.url && <a className="small" href={it.sources.url} target="_blank" rel="noreferrer">{it.sources.title || it.sources.url}</a>}
            <div className="row finding-actions">
              <button type="button" className="btn btn-primary btn-small" disabled={busy !== null} onClick={() => decide(it.id, "approved")}>Approve</button>
              <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => decide(it.id, "rejected")}>Reject</button>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => onOpen(it.id)}>Open</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** All the scope points at once, for edits the check couldn't tie to one point. Saving confirms the scope again. */
function ScopeModal({ pieceId, onClose, onSaved }: { pieceId: string; onClose: () => void; onSaved: () => void }) {
  const { data, error } = useLoad(async () => must<Contract>(await supabase.from("piece_contracts").select("*").eq("piece_id", pieceId).single()), [pieceId]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textOf = (id: string, original: string) => texts[id] ?? original;
  const points = data?.expectations ?? [];
  const changed = points.some((p) => textOf(p.id, p.text).trim() !== p.text.trim());
  const empty = points.some((p) => !textOf(p.id, p.text).trim());

  async function saveAndConfirm() {
    if (!data) return;
    setBusy(true);
    setErr(null);
    let saved = false;
    try {
      must(await supabase.from("piece_contracts").update({
        expectations: data.expectations.map((p) => ({ ...p, text: textOf(p.id, p.text).trim() })),
      }).eq("piece_id", pieceId).select("piece_id"));
      saved = true;
      const { error: e } = await supabase.rpc("confirm_contract", { target_piece: pieceId });
      if (e) throw e;
      onSaved();
    } catch (e) {
      setErr(saved ? `Your edits are saved, but the scope isn't confirmed yet: ${errorMessage(e)} Confirm it again from the Scope step.` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit the scope points" onClose={onClose}>
      {error ? <ErrorText>{error}</ErrorText> : !data ? <Loading /> : (
        <div className="stack">
          {/* The same look as the points on the Scope step: the number beside the top of each box, boxes sized to their text. */}
          <ol className="expectations">
            {points.map((p, i) => (
              <li key={p.id}>
                <CleanTextarea rows={Math.max(2, Math.ceil(textOf(p.id, p.text).length / 80))} value={textOf(p.id, p.text)}
                  onChange={(e) => setTexts((t) => ({ ...t, [p.id]: e.target.value }))} aria-label={`Scope point ${i + 1}`} />
              </li>
            ))}
          </ol>
          <ErrorText>{err}</ErrorText>
          {/* Stays in view however many points there are. */}
          <div className="modal-footer">
            <button type="button" className="btn btn-primary" disabled={busy || !changed || empty} onClick={saveAndConfirm}>{busy ? "Saving…" : "Save and re-confirm"}</button>
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <span className="small muted">Confirms the scope again. The outline keeps its link to each point.</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

const FIX_LABELS: Record<FixProposal["type"], string> = {
  reject_item: "Remove research",
  edit_point: "Reword point",
  remove_point: "Remove point",
  add_point: "Add point",
  add_section: "Add section",
  research_gap: "Research a gap",
};

/** What one Apply did, for Undo: the scope/research/outline snapshot (null when only searches ran), the findings it settled,
 *  the research items its gap searches added, and the gaps that were searched. */
interface FixBatch {
  snap: unknown;
  resolves: string[];
  researchItems: string[];
  researched: string[];
}

/** One proposed fix as a card: what kind of change, a clear title, the detail, and why. */
function ProposalCard({ p, checked, busy, costNote, onToggle, onIgnore }: {
  p: FixProposal;
  checked: boolean;
  busy: boolean;
  costNote: string;
  onToggle: (on: boolean) => void;
  onIgnore: () => void;
}) {
  const [more, setMore] = useState(false);
  // What the card is called, and the smaller line under it.
  const title = {
    reject_item: p.item_text,
    edit_point: p.text,
    remove_point: p.point_text,
    add_point: p.text,
    add_section: p.heading,
    research_gap: p.text,
  }[p.type] ?? "";
  const detail = {
    reject_item: "",
    edit_point: p.point_text ? `Now: ${p.point_text}` : "",
    remove_point: "",
    add_point: p.heading ? `With a new section: ${p.heading}` : "",
    add_section: p.purpose ?? "",
    research_gap: `Searches the web and adds up to 3 of the best sources to your research${costNote ? ` (${costNote})` : ""}.`,
  }[p.type];
  // A long statement shows two lines until you ask for more.
  const long = p.type === "reject_item" && (title?.length ?? 0) > 140;
  return (
    <li className={`finding proposal${checked ? "" : " is-off"}`}>
      <div className="row finding-top">
        <label className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} style={{ width: "auto", margin: 0 }} aria-label={`Apply: ${FIX_LABELS[p.type]}`} />
          <span className="tag">{FIX_LABELS[p.type]}</span>
        </label>
        <span className="spacer" />
        <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={onIgnore}>Ignore</button>
      </div>
      <p className={`proposal-title${long && !more ? " clamp" : ""}`}>{title}</p>
      {long && <button type="button" className="btn btn-quiet btn-small" style={{ justifySelf: "start" }} onClick={() => setMore((m) => !m)}>{more ? "Show less" : "Show more"}</button>}
      {detail && <div className="small muted">{detail}</div>}
      {p.why && <div className="small muted proposal-why">{p.why}</div>}
    </li>
  );
}

/**
 * "Fix it": the AI proposes changes for what the check found; the writer ticks the ones to apply, and one Undo
 * puts them all back. Rejecting research, rewording, removing or adding scope points, and adding outline sections.
 */
function FixPanel({ piece, includeGaps, quiet, analysisSig, actionable, stateSig, blocked, onChanged }: {
  piece: Piece;
  /** The "use AI to address these" tick: also propose a web search for each open gap that one could fill. */
  includeGaps: boolean;
  /** No open gaps remain: the finalize bar says so, so this panel stays silent about having nothing to fix. */
  quiet: boolean;
  analysisSig: string;
  /** Whether there is anything a fix could act on. */
  actionable: boolean;
  /** Everything the proposals depend on; when it changes, an empty result is no longer known to still hold. */
  stateSig: string;
  blocked: string | null;
  onChanged: () => void;
}) {
  const showCosts = useShowCosts();
  // What one gap search is estimated to cost, shown on the proposals before anything runs.
  const [gapCost, setGapCost] = useState<number | null>(null);
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
  const lastSig = useRef(analysisSig);
  useEffect(() => {
    setProposals(null);
    setPicked(new Set());
    setNote(null);
    setAskForce(false);
    // The finding positions saved with older batches belong to the previous check; undoing them must not touch the new one.
    if (lastSig.current !== analysisSig) {
      lastSig.current = analysisSig;
      setSnapshots((s) => s.map((b) => (b && typeof b === "object" && "snap" in b ? { ...(b as object), resolves: [], researched: [] } : b)));
    }
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

  /** Rewrites the saved check, for marking findings as settled (or bringing them back). */
  async function writeAnalysis(change: (a: Analysis) => Analysis) {
    // Read the saved check again, so an ignore or a re-run made a moment ago isn't overwritten.
    const { data: row } = await supabase.from("pieces").select("analysis").eq("id", piece.id).single();
    const a = (row?.analysis ?? null) as Analysis | null;
    if (!a) return;
    must(await supabase.from("pieces").update({ analysis: change(a) }).eq("id", piece.id).select("id"));
  }
  /** Marks the findings named by refs such as "drift-0", "suggestion-1", "gap-2" as resolved, or clears that. */
  function setResolved(a: Analysis, refs: string[], value: boolean): Analysis {
    const next = { ...a };
    const mark = <T extends { resolved?: boolean }>(list: T[] | undefined, prefix: string): T[] | undefined =>
      list?.map((x, i) => (refs.includes(`${prefix}-${i}`) ? { ...x, resolved: value || undefined } : x));
    next.drift = mark(a.drift, "drift");
    next.gaps = mark(a.gaps, "gap") ?? a.gaps;
    next.contract_suggestions = mark(a.contract_suggestions, "suggestion");
    return next;
  }

  const [applying, setApplying] = useState(false);
  // "applying" while changes go in, then "rechecking" while the check runs again.
  const [applyPhase, setApplyPhase] = useState<"applying" | "rechecking">("applying");
  const apply = async () => {
    setApplyPhase("applying");
    setApplying(true);
    try {
      await applyChanges();
    } finally {
      setApplying(false);
    }
  };
  const applyChanges = () => run(async () => {
    const chosenAll = (proposals ?? []).filter((p) => picked.has(p.id));
    // Searches for gaps run after the scope, research and outline changes; they work differently (see below).
    const chosenGaps = chosenAll.filter((p) => p.type === "research_gap");
    const chosen = chosenAll.filter((p) => p.type !== "research_gap");
    const removed = new Set(chosen.filter((p) => p.type === "remove_point").map((p) => p.point_id!));
    let skipped = 0;
    // A section that is skipped (all its points were removed) settles nothing.
    const notApplied = new Set<string>();
    const sections = chosen.flatMap((p) => {
      if (p.type === "add_point" && p.heading) return [{ heading: p.heading, purpose: p.purpose ?? "", expectation_ids: [p.new_point_id!] }];
      if (p.type === "add_section") {
        const ids = (p.point_ids ?? []).filter((x) => !removed.has(x));
        if (!ids.length) notApplied.add(p.id);
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
    let message = "";
    // Everything this Apply did, kept as one batch so one Undo reverses all of it.
    const batch: FixBatch = { snap: null, resolves: [], researchItems: [], researched: [] };
    if (chosen.length > 0) {
      const { data, error: e } = await supabase.rpc("apply_alignment_fixes", { target_piece: piece.id, fixes });
      if (e) throw e;
      // The findings these changes settle drop out of the list. The scope and research have moved on from what the check
      // numbered, so the check also stops offering more proposals until it is run again.
      const resolves = [...new Set(chosen.filter((p) => !notApplied.has(p.id)).flatMap((p) => p.resolves ?? []))];
      batch.snap = data;
      batch.resolves = resolves;
      // The changes are already in; if the list can't be updated, say so rather than undoing anything.
      // A gap whose scope point now has an outline section is marked, so the card can say what was done for it.
      const sectionPointIds = new Set(chosen.filter((p) => p.type === "add_section" && !notApplied.has(p.id)).flatMap((p) => p.point_ids ?? []));
      try {
        await writeAnalysis((a) => ({
          ...setResolved(a, resolves, true),
          gaps: setResolved(a, resolves, true).gaps.map((g) => ((g.points ?? []).some((n) => sectionPointIds.has(a.point_ids?.[n - 1] ?? "")) ? { ...g, sectioned: true } : g)),
          fixes_applied: true,
        }));
      } catch (we) {
        setErr(`The changes were applied, but the list of findings couldn't be updated: ${errorMessage(we)} Run the check again to refresh it.`);
      }
      const done = chosen.length - skipped;
      message = `Applied ${done} ${done === 1 ? "change" : "changes"}.${skipped ? ` ${skipped} ${skipped === 1 ? "section was" : "sections were"} skipped because ${skipped === 1 ? "its point was" : "their points were"} removed.` : ""}`;
    }
    if (chosenGaps.length > 0) {
      // A search adds sources to the research. It does not close the gap: only the next check can say that, so the gap
      // is marked as researched, not settled. The sources are remembered in the batch, so Undo can remove them again.
      const added: Record<string, number> = {};
      const failures: string[] = [];
      for (const g of chosenGaps) {
        try {
          const r = await callFunction<{ added: number; item_ids?: string[] }>("research", { action: "search", piece_id: piece.id, focus: g.text });
          added[g.resolves![0]] = r.added;
          batch.researchItems.push(...(r.item_ids ?? []));
          batch.researched.push(g.resolves![0]);
        } catch (ge) {
          failures.push(errorMessage(ge));
        }
      }
      const total = Object.values(added).reduce((n, x) => n + x, 0);
      if (Object.keys(added).length > 0) {
        try {
          await writeAnalysis((a) => ({
            ...a,
            gaps: a.gaps.map((x, i) => (`gap-${i}` in added ? { ...x, researched: (x.researched ?? 0) + added[`gap-${i}`] } : x)),
          }));
        } catch (we) {
          failures.push(`the gaps couldn't be marked as researched (${errorMessage(we)})`);
        }
      }
      message += ` Searched for ${Object.keys(added).length} ${Object.keys(added).length === 1 ? "gap" : "gaps"}: ${total} new ${total === 1 ? "source" : "sources"} added to the research.`;
      if (failures.length > 0) message += ` ${failures.length === 1 ? "One problem" : `${failures.length} problems`}: ${failures.join("; ")}`;
    }
    // After sections or searches, check only whether the findings from the first check are now closed. It is not a new
    // check: it looks at those findings and nothing else, and the ones it closes drop out of the list.
    const sectionsAdded = chosen.some((p) => (p.type === "add_section" && !notApplied.has(p.id)) || (p.type === "add_point" && p.heading));
    if (sectionsAdded || batch.researchItems.length > 0) {
      setApplyPhase("rechecking");
      try {
        const v = await callFunction<{ closed_refs: string[]; open: number }>("ai", { task: "analysis_verify", piece_id: piece.id });
        // Undo brings these findings back, the same as the ones the fixes settled directly.
        batch.resolves = [...new Set([...batch.resolves, ...v.closed_refs])];
        const closed = v.closed_refs.length;
        message += ` Checked the findings again: ${closed} closed, ${v.open} still open.`;
      } catch (ce) {
        message += ` Couldn't check the findings again (${errorMessage(ce)}). Run the check again to see what is left.`;
      }
    }
    if (batch.snap !== null || batch.researchItems.length > 0) setSnapshots((s) => [...s, batch]);
    setEmptySig(null);
    setNote(message.trim());
    setProposals((proposals ?? []).filter((p) => !picked.has(p.id)));
    setPicked(new Set());
    onChanged();
  });

  // Set when the piece changed after the fixes were applied: Undo then waits for the writer to say it may reverse those too.
  const [askForce, setAskForce] = useState(false);
  const undo = (force = false) => run(async () => {
    const latest = snapshots[snapshots.length - 1] as Partial<FixBatch> | undefined;
    // Batches saved before findings were tracked are the bare snapshot.
    const batch: FixBatch = latest && "snap" in latest
      ? { snap: latest.snap ?? null, resolves: latest.resolves ?? [], researchItems: latest.researchItems ?? [], researched: latest.researched ?? [] }
      : { snap: latest ?? null, resolves: [], researchItems: [], researched: [] };
    // A batch of only gap searches has no scope, research or outline change to put back.
    if (batch.snap !== null) {
      const { error: e } = await supabase.rpc("undo_alignment_fixes", { target_piece: piece.id, snapshot: batch.snap, force });
      if (e) {
        if (e.message.includes("changed_since_apply")) { setAskForce(true); return; }
        throw e;
      }
    }
    setAskForce(false);
    // The sources the searches added are removed again.
    let removed = 0;
    if (batch.researchItems.length > 0) {
      const { data: n, error: re } = await supabase.rpc("remove_gap_research", { target_piece: piece.id, item_ids: batch.researchItems });
      if (re) throw re;
      removed = Number(n ?? 0);
    }
    // The findings come back, and once every batch is undone the check can propose again.
    await writeAnalysis((a) => {
      const back = setResolved(a, batch.resolves, false);
      back.gaps = back.gaps.map((x, i) => (batch.researched.includes(`gap-${i}`) ? { ...x, researched: undefined } : x));
      return snapshots.length <= 1 ? { ...back, fixes_applied: undefined } : back;
    });
    setSnapshots((s) => s.slice(0, -1));
    setEmptySig(null);
    setNote(`Put the last changes back as they were.${removed > 0 ? ` Removed the ${removed} ${removed === 1 ? "source" : "sources"} the search added.` : ""}`);
    setProposals(null);
    onChanged();
  });

  // Nothing a fix could act on, or an empty result that still holds: no button to click, just the way forward.
  const idle = !actionable || knownEmpty;
  const hasList = Boolean(proposals && proposals.length > 0);
  if (idle && !hasList && snapshots.length === 0 && !note) {
    return quiet ? null : <p className="small muted">Nothing left to fix here. Record an expert's answer to a gap, restore something you ignored, or run the check again.</p>;
  }

  const undoButton = snapshots.length > 0
    ? <button type="button" className="btn btn-small" disabled={busy || Boolean(blocked)} onClick={() => undo()}>Undo last fixes</button>
    : null;
  // The action bar: what Fix it does on the left, the button on the right. While proposals are listed, Undo moves next to Apply.
  const showBar = !hasList && (!idle || snapshots.length > 0);

  return (
    <div className="stack" style={{ gap: 8 }}>
      {showBar && (
        <div className="fix-bar">
          <p className="small muted">{!proposals && !note && !idle ? "Suggests changes for what the check found. Nothing changes until you apply them, and you can undo them." : ""}</p>
          <div className="row" style={{ flexShrink: 0 }}>
            {!idle && (
              <AiAction<{ proposals: FixProposal[] }>
                label="Propose fixes"
                primary
                disabled={Boolean(blocked) || busy}
                reason={blocked ?? ""}
                payload={{ task: "analysis_fix", piece_id: piece.id, include_gaps: includeGaps }}
                onDone={(r) => {
                  setProposals(r.proposals);
                  setPicked(new Set(r.proposals.map((p) => p.id)));
                  setNote(null);
                  setGapCost(null);
                  const firstSearch = r.proposals.find((p) => p.type === "research_gap");
                  if (firstSearch) {
                    void callFunction<{ cost_usd: number | null }>("research", { action: "search", mode: "estimate", piece_id: piece.id, focus: firstSearch.text })
                      .then((est) => setGapCost(est.cost_usd))
                      .catch(() => setGapCost(null));
                  }
                  setEmptySig(r.proposals.length === 0 ? stateSig : null);
                }}
              />
            )}
            {undoButton}
          </div>
        </div>
      )}
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
      {idle && !quiet && !hasList && !note && <p className="small muted">Nothing left to fix here. Record an expert's answer to a gap, restore something you ignored, or run the check again.</p>}
      {applying && (
        <div className="applying" role="status" aria-live="polite">
          <div className="applying-ring" aria-hidden="true"><span /></div>
          <strong>{applyPhase === "rechecking" ? "Checking what was found…" : "Applying your changes…"}</strong>
          <span className="small muted">
            {applyPhase === "rechecking" ? "Seeing which of the earlier findings the changes closed." : (() => {
              const n = (proposals ?? []).filter((p) => picked.has(p.id) && p.type === "research_gap").length;
              return n > 0 ? `Searching the web for ${n} ${n === 1 ? "gap" : "gaps"}. This can take a minute.` : "This only takes a moment.";
            })()}
          </span>
        </div>
      )}
      {!applying && proposals && proposals.length > 0 && (
        <>
          <ul className="finding-list">
            {proposals.map((p) => (
              <ProposalCard key={p.id} p={p} checked={picked.has(p.id)} busy={busy}
                costNote={p.type === "research_gap" && showCosts && gapCost !== null ? `about ${formatCost(gapCost)}` : ""}
                onToggle={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(p.id); else n.delete(p.id); return n; })}
                onIgnore={() => { setProposals((list) => (list ?? []).filter((x) => x.id !== p.id)); setPicked((s) => { const n = new Set(s); n.delete(p.id); return n; }); }} />
            ))}
          </ul>
          {/* Stays at the bottom of the screen while the cards scroll. */}
          <div className="apply-bar">
            <button type="button" className="btn btn-primary" disabled={busy || picked.size === 0 || Boolean(blocked)} onClick={apply}>
              {busy ? "Applying…" : `Apply ${picked.size} ${picked.size === 1 ? "change" : "changes"}`}
            </button>
            <span className="small muted">
              {blocked ?? (proposals.some((p) => picked.has(p.id) && p.type !== "reject_item" && p.type !== "add_section" && p.type !== "research_gap") ? "Scope changes confirm the scope again." : "")}
            </span>
            <span className="spacer" />
            {undoButton}
          </div>
        </>
      )}
    </div>
  );
}

function AnalysisPanel({ piece, onRan, onAnswer, blocked, coveredIds, answeredCount, currentItemIds, currentPointIds, pendingItems, hasOutline, createOutline, onOutlineChanged }: {
  piece: Piece;
  /** The outline already has sections, so creating one asks before it replaces them. */
  hasOutline: boolean;
  /** Has the AI plan the outline from the scope and research; reports what it is doing as it goes. */
  createOutline: (progress: (text: string) => void) => Promise<void>;
  /** Research items still waiting for the writer's decision (found by searches for the gaps). */
  pendingItems: ResearchItem[];
  /** The approved research and the scope points as they are now, to tell when the saved check is out of date. */
  currentItemIds: string[];
  currentPointIds: string[];
  /** Expert answers added to the research since this screen opened; each makes the saved check out of date. */
  answeredCount: number;
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
  const [open, setOpen] = useState<{ kind: "item" | "point"; id: string } | { kind: "scope" } | null>(null);
  const [changed, setChanged] = useState(false);
  // "Use AI to address these": also let the AI search the web for the gaps.
  const [useAi, setUseAi] = useState(false);
  useEffect(() => { if (answeredCount > 0) setChanged(true); }, [answeredCount]);
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
  // After fixes are applied the scope and research have moved on from what the check numbered, so it can't propose
  // more; running the check again is what starts a new round.
  const hidden = (x: { ignored?: boolean; resolved?: boolean }) => Boolean(x.ignored || x.resolved);
  // The check numbered the research and scope as they were then. If either changed since (an answer added, an item
  // edited, a point reworded), fixes can't be proposed from it. After fixes were applied that is expected, so it's not flagged.
  const sameIds = (x: string[] | undefined, y: string[]) => !x || (x.length === y.length && x.every((id) => y.includes(id)));
  const stale = Boolean(a?.alignment) && !a!.fixes_applied
    && (!sameIds(a!.item_ids, currentItemIds) || !sameIds(a!.point_ids, currentPointIds));
  const actionable = Boolean(a?.alignment) && !a!.fixes_applied && !stale && (
    a!.alignment!.verdict !== "aligned"
    || (a!.drift ?? []).some((d) => !hidden(d))
    || (a!.contract_suggestions ?? []).some((c) => !hidden(c))
    || (useAi && a!.gaps.some((g) => !hidden(g) && !g.researched))
    || a!.gaps.some((g) => !hidden(g) && (g.points ?? []).some((n) => {
      const id = a!.point_ids?.[n - 1];
      return Boolean(id) && !coveredIds.includes(id!);
    }))
  );
  const stateSig = JSON.stringify([a, coveredIds, useAi]);
  const [ignoring, setIgnoring] = useState(false);
  const [ignoreErr, setIgnoreErr] = useState<string | null>(null);
  // What the AI is doing while it builds the outline (null when it isn't).
  const [building, setBuilding] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  /** Has the AI create the outline, then ends the benchmark: it is hidden and the outline editor takes its place. */
  async function buildOutline() {
    if (!a) return;
    setConfirmReplace(false);
    setBuilding("Planning the sections…");
    setIgnoreErr(null);
    try {
      await createOutline(setBuilding);
      must(await supabase.from("pieces").update({ analysis: { ...a, benchmark_done: true } }).eq("id", piece.id).select("id"));
      onRan();
    } catch (e) {
      setIgnoreErr(errorMessage(e));
    } finally {
      setBuilding(null);
    }
  }
  const showSuggestions = recipe.analysis.contract_suggestions;
  // Drift and suggested scope changes are one kind of finding: something that exists but needs adjusting.
  const needsAdjusting = (a?.drift ?? []).some((d) => !hidden(d))
    || (showSuggestions && (a?.contract_suggestions ?? []).some((c) => !hidden(c)));
  const ignoredCount = (a?.gaps ?? []).filter((g) => g.ignored).length + (a?.drift ?? []).filter((d) => d.ignored).length
    + (a?.contract_suggestions ?? []).filter((c) => c.ignored).length;
  const fixedTexts = [
    ...(a?.drift ?? []).filter((d) => d.resolved && !d.ignored).map((d) => d.text),
    ...(a?.contract_suggestions ?? []).filter((c) => c.resolved && !c.ignored).map((c) => c.change),
    ...(a?.gaps ?? []).filter((g) => g.resolved && !g.ignored).map((g) => g.text),
  ];
  /** Ignore (or restore) one finding. It is saved with the check, and the fix proposals leave it alone. */
  async function setIgnored(kind: "gaps" | "drift" | "contract_suggestions", index: number, value: boolean) {
    if (!a) return;
    setIgnoring(true);
    setIgnoreErr(null);
    try {
      const list = ((a[kind] ?? []) as { ignored?: boolean }[]).map((x, i) => (i === index ? { ...x, ignored: value || undefined } : x));
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
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 16 }}>
        <div className="stack" style={{ gap: 2, flex: "1 1 auto", minWidth: 0 }}>
          <h2>Benchmark your scope and research against the original topic</h2>
        </div>
        {!piece.outline_confirmed_at && (
          <div style={{ flex: "0 0 auto" }}>
            <AiAction label={a ? "Run again" : "Check alignment"} primary={!a} payload={{ task: "analysis", piece_id: piece.id }} onDone={() => { setChanged(false); onRan(); }} />
          </div>
        )}
      </div>
      <ErrorText>{ignoreErr}</ErrorText>
      {(changed || stale) && !a?.fixes_applied && <p className="small notice">The scope or research changed since this check. Run it again to refresh it.</p>}
      {a && !a.alignment && (
        <p className="small muted">This result is from an earlier version of the check, which looked at the sources. Run it again for the alignment check.</p>
      )}
      {editable && a?.alignment && (
        <FixPanel piece={piece} includeGaps={useAi} quiet={a.gaps.every((g) => hidden(g))} actionable={actionable} stateSig={stateSig} analysisSig={JSON.stringify(a, (k, v) => (k === "ignored" || k === "resolved" || k === "researched" || k === "fixes_applied" || k === "benchmark_done" ? undefined : v))} blocked={blocked} onChanged={() => { onRan(); onOutlineChanged(); }} />
      )}
      {a?.alignment && (
        <div className="stack analysis" style={{ gap: 14 }}>
          {needsAdjusting && (
            <div>
              <h3>Needs adjusting</h3>
              <ul className="finding-list">
                {(a.drift ?? []).map((d, i) => hidden(d) ? null : (
                  <li key={i} className="finding">
                    <p>{d.text}</p>
                    {d.verify_note && <p className="small muted" style={{ margin: 0 }}>Still open: {d.verify_note}</p>}
                    <div className="row finding-top">
                      {d.points && d.points.length > 0 ? refs([], d.points) : editable && (
                        <button type="button" className="btn btn-small" onClick={() => setOpen({ kind: "scope" })}>Edit manually</button>
                      )}
                      <span className="spacer" />
                      <button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("drift", i, true)}>Ignore</button>
                    </div>
                  </li>
                ))}
                {showSuggestions && (a.contract_suggestions ?? []).map((c, i) => hidden(c) ? null : (
                  <li key={i} className="finding">
                    <p>{c.change}</p>
                    <div className="small muted">{c.why}</div>
                    {c.verify_note && <p className="small muted" style={{ margin: 0 }}>Still open: {c.verify_note}</p>}
                    <div className="row finding-top">
                      {editable && <button type="button" className="btn btn-small" onClick={() => setOpen({ kind: "scope" })}>Edit manually</button>}
                      <span className="spacer" />
                      <button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("contract_suggestions", i, true)}>Ignore</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recipe.analysis.gaps && a.gaps.some((g) => !hidden(g)) && (
            <div>
              <h3>Needs your input</h3>
              {editable && !a.fixes_applied && a.gaps.some((g) => !hidden(g) && !g.researched) && (
                <label className="row" style={{ gap: 8, alignItems: "center", flexWrap: "nowrap", margin: "2px 0 10px" }}>
                  <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} style={{ width: "auto", margin: 0 }} />
                  <span className="small">Use AI to address these. It searches the web for what is missing and adds the best sources to your research.</span>
                </label>
              )}
              {a.gaps.some((g) => !hidden(g)) ? (
                <ul className="finding-list">
                  {a.gaps.map((g, i) => hidden(g) ? null : (
                    <li key={i} className="finding">
                      <p>{g.text}</p>
                      <div className="row finding-top">
                        {refs([], g.points)}
                        <span className="spacer" />
                        <button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("gaps", i, true)}>Ignore</button>
                      </div>
                      <div className="small muted">Ask your expert: {g.expert_question}</div>
                      {g.verify_note && <p className="small muted" style={{ margin: 0 }}>Still open: {g.verify_note}</p>}
                      {g.sectioned && g.researched === undefined && <p className="small notice" style={{ margin: 0 }}>An outline section was added for this. Run the check again to see whether this is closed.</p>}
                      {!g.sectioned && g.researched === undefined && (a.fixes_applied || a.gaps.some((x) => x.sectioned || x.researched !== undefined)) && (
                        <p className="small muted" style={{ margin: 0 }}>Needs your expert: a web search can't answer this one, so nothing was done for it.</p>
                      )}
                      {g.researched !== undefined && (
                        <p className="small notice" style={{ margin: 0 }}>
                          Searched the web: {g.researched} new {g.researched === 1 ? "source" : "sources"} added to the research. Run the check again to see whether this is closed.
                        </p>
                      )}
                      <div className="row finding-actions">
                        <button type="button" className="btn btn-primary btn-small" onClick={() => onAnswer(g.expert_question)}>Record the answer</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {fixedTexts.length > 0 && (
            <details className="small">
              <summary className="muted">{fixedTexts.length} fixed</summary>
              <ul className="finding-list" style={{ marginTop: 8 }}>
                {fixedTexts.map((t, i) => <li key={i} className="finding is-ignored"><p>{t}</p></li>)}
              </ul>
            </details>
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
                {a.contract_suggestions?.map((c, i) => !c.ignored ? null : (
                  <li key={`c${i}`} className="finding is-ignored">
                    <p>{c.change}</p>
                    <div className="row finding-actions"><button type="button" className="btn btn-quiet btn-small" disabled={ignoring} onClick={() => setIgnored("contract_suggestions", i, false)}>Restore</button></div>
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
      {editable && a?.alignment && a.gaps.every((g) => hidden(g)) && (
        building ? (
          <div className="applying" role="status" aria-live="polite">
            <div className="applying-ring" aria-hidden="true"><span /></div>
            <strong>{building}</strong>
            <span className="small muted">The AI is working from your scope and research. This can take a minute.</span>
          </div>
        ) : (
          <div className="finalize-bar">
            <div className="stack" style={{ gap: 2 }}>
              <strong>No gaps left.</strong>
              <span className="small muted">
                {stale
                  ? "The scope or research changed since this check. Run it again before you continue."
                  : confirmReplace
                  ? "This replaces the outline you have now. You can undo it afterwards."
                  : needsAdjusting
                  ? "Some adjustments are still listed. You can apply or ignore them first, or let the AI create the outline now."
                  : "Your scope and research are ready. The AI will plan the outline from them, and you can edit it before you confirm."}
              </span>
            </div>
            {confirmReplace ? (
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={buildOutline}>Replace the outline</button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmReplace(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="btn btn-primary" disabled={stale} onClick={() => (hasOutline ? setConfirmReplace(true) : buildOutline())}>
                {hasOutline ? "Rebuild outline" : "Create outline"}
              </button>
            )}
          </div>
        )
      )}
      {editable && pendingItems.length > 0 && (
        <PendingResearch items={pendingItems} onDecided={() => { onRan(); onOutlineChanged(); }} onOpen={(id) => setOpen({ kind: "item", id })} />
      )}
      {open?.kind === "item" && <ItemModal id={open.id} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setChanged(true); onRan(); onOutlineChanged(); }} />}
      {open?.kind === "scope" && <ScopeModal pieceId={piece.id} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setChanged(true); onRan(); onOutlineChanged(); }} />}
      {open?.kind === "point" && <PointModal pieceId={piece.id} expectationId={open.id} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setChanged(true); onRan(); onOutlineChanged(); }} />}
    </section>
  );
}
