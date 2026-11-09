import { useEffect, useRef, useState } from "react";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatCost } from "../lib/format";
import { useShowCosts } from "../lib/showCosts";
import { BLOCK_LABELS, type BriefBullet, type CheckResult, type Contract, type FactFlag, type Piece, type ResearchItem, type Section } from "../lib/types";
import { ResearchStep } from "./ResearchStep";
import { AiAction, CopyButton, ErrorText, Loading } from "./ui";
import { HUMANIZER_PROMPT } from "../lib/sections";
import { normalise, type Recipe } from "../lib/recipes";
import { WriteLike } from "./WriteLike";
import { SourceLinks } from "./Links";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { RevisePanel } from "./Revise";
import { AiWritePanel, DraftOverview, FullDraft, PointsList, PreparePanel, StartChoice, isUnprepared } from "./SectionPrep";

/** The state of one check against the text as it is now. A tick shows only while the text is unchanged since the check. */
type CheckState = "never" | "current" | "stale";

function CheckStatus({ state, summary }: { state: CheckState; summary?: string }) {
  if (state === "current") {
    return <span className="check-state current"><span aria-hidden="true">✓</span> Checked{summary ? `: ${summary}` : ""}</span>;
  }
  if (state === "stale") return <span className="check-state stale">Edited since the last check. Check again.</span>;
  return <span className="check-state">Not checked yet</span>;
}

const STATUS_LABEL: Record<Section["status"], string> = {
  research: "Research",
  brief: "Brief",
  writing: "Writing",
  written: "Written",
};

/** Sections: research -> review -> brief -> write, one section at a time or research up front. */
export function WritingStep({ piece, onChanged, onContinue, onBusyChange, finishLabel = "Sign-off" }: {
  piece: Piece;
  onChanged: () => void;
  /** Told when a prepare or AI-writing run starts and stops. */
  onBusyChange?: (busy: boolean) => void;
  /** Opens the sign-off step. */
  onContinue?: () => void;
  finishLabel?: string;
}) {
  const { data, error, reload } = useLoad(async () => {
    const [sections, contract] = await Promise.all([
      supabase.from("piece_sections").select("*").eq("piece_id", piece.id).order("position").then(must<Section[]>),
      supabase.from("piece_contracts").select("*").eq("piece_id", piece.id).single().then(must<Contract>),
    ]);
    return { sections, contract };
  }, [piece.id]);
  // A section id, "all" for the overview of every section, or null for the first one still to do.
  const [selected, setSelected] = useState<string | null>(null);
  // Sections the writer chose to work through by hand (the old research and brief steps) instead of the prepare run.
  const [manual, setManual] = useState<Set<string>>(new Set());
  // The prepare run is going: its progress stays on screen, whatever is selected, and the section list waits.
  const [preparing, setPreparing] = useState(false);
  // "Write using AI" has been chosen: the AI is writing every section from its points (or paused part way).
  const [aiWriting, setAiWriting] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  // Tell the page while a run is going, so the step tabs can't take the writer away from it.
  useEffect(() => { onBusyChange?.(preparing || aiRunning); }, [preparing, aiRunning]);
  useEffect(() => () => onBusyChange?.(false), []);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const { sections, contract } = data;
  if (sections.length === 0) return <p className="notice">This piece has no sections. Reopen the outline and add some.</p>;
  const showAll = selected === "all";
  const showDraft = selected === "draft";
  const current = sections.find((s) => s.id === selected) ?? sections.find((s) => s.status !== "written") ?? sections[0];
  const recipe = normalise(piece.recipe);
  // Formats with an outline are prepared by the AI: a web search and talking points for each section, in turn.
  const autoPrepare = recipe.outline.mode !== "off";
  const unprepared = sections.filter(isUnprepared);
  // Once every section is prepared and no one has started writing, the choice is how: by hand, or using the AI.
  const started = sections.some((s) => s.content.trim() || s.status === "written");
  const showStart = autoPrepare && unprepared.length === 0 && !started && (selected === null || selected === "start");
  const busyRun = preparing || aiRunning;
  const upFront = piece.section_timing === "up_front" && recipe.sections.research;
  const researchOpen = sections.filter((s) => s.status === "research").length;

  // Up front: no briefs until every section's research is reviewed.
  // One at a time: a section's research waits for the earlier sections to be written.
  const blockedResearch = (s: Section) =>
    !upFront && sections.some((x) => x.position < s.position && x.status !== "written")
      ? "Write the earlier sections first. This piece researches one section at a time."
      : null;
  const blockedBrief = upFront && researchOpen > 0
    ? `Review the research for all sections first (${researchOpen} still open). This piece researches every section up front.`
    : null;

  const refresh = () => { reload(); onChanged(); };

  return (
    <div className={`writing${sections.length === 1 && recipe.outline.mode === "off" ? " single" : ""}`}>
      <nav className="section-nav" aria-label="Sections">
        {sections.some((s) => s.points) && (
          <button type="button" className={`section-link${showAll ? " active" : ""}`} disabled={busyRun} onClick={() => setSelected("all")}>
            <span className="dot" />
            <span className="stack" style={{ gap: 0 }}>
              <span>All sections</span>
              <span className="small faint">{sections.filter((s) => s.points).length} of {sections.length} prepared</span>
            </span>
          </button>
        )}
        {sections.some((s) => s.content.trim()) && (
          <button type="button" className={`section-link${showDraft ? " active" : ""}`} disabled={busyRun} onClick={() => setSelected("draft")}>
            <span className="dot" />
            <span className="stack" style={{ gap: 0 }}>
              <span>Complete draft</span>
              <span className="small faint">{sections.filter((s) => s.content.trim()).length} of {sections.length} with text</span>
            </span>
          </button>
        )}
        {sections.map((s) => (
          <button key={s.id} type="button" className={`section-link${!showAll && !showDraft && !showStart && s.id === current.id ? " active" : ""}`} disabled={busyRun} onClick={() => setSelected(s.id)}>
            <span className={`dot ${s.status === "written" ? "done" : s.id === current.id ? "pending" : ""}`} />
            <span className="stack" style={{ gap: 0 }}>
              <span>{s.position}. {s.heading}</span>
              <span className="small faint">{autoPrepare && isUnprepared(s) && !manual.has(s.id) ? "Not prepared" : STATUS_LABEL[s.status]}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className="stack-lg" style={{ minWidth: 0 }}>
        {sections.every((s) => s.status === "written") && piece.stage === "writing" && (
          <div className="notice ok-notice row" role="status">
            <span>
              <strong>Writing is complete.</strong>{" "}
              {sections.length === 1 ? "The text is written." : `All ${sections.length} sections are written.`} You can still reopen a section to edit it.
            </span>
            <span className="spacer" />
            {onContinue && <button type="button" className="btn btn-primary btn-small" onClick={onContinue}>Continue to {finishLabel.toLowerCase()}</button>}
          </div>
        )}
        {aiWriting ? (
          <AiWritePanel
            sections={sections}
            onRunningChange={setAiRunning}
            onProgress={refresh}
            onFinished={() => { refresh(); setAiWriting(false); setSelected("draft"); }}
            onBack={() => { setAiWriting(false); setSelected("start"); }}
          />
        ) : showDraft && !preparing ? (
          <FullDraft title={piece.title} sections={sections} onOpen={(id) => setSelected(id)} />
        ) : showAll && !preparing ? (
          <DraftOverview sections={sections} onOpen={(id) => setSelected(id)} />
        ) : showStart && !preparing ? (
          <StartChoice
            canUseAi={recipe.writing.ai_draft}
            onStart={() => setSelected(sections[0].id)}
            onAi={() => setAiWriting(true)}
            onAll={() => setSelected("all")}
          />
        ) : preparing || (autoPrepare && isUnprepared(current) && !manual.has(current.id)) ? (
          <PreparePanel
            pieceId={piece.id}
            sections={sections}
            manual={manual}
            onRunningChange={setPreparing}
            onProgress={refresh}
            onFinished={() => { refresh(); setSelected("start"); }}
            onManual={(id) => setManual((m) => new Set(m).add(id))}
          />
        ) : (
          <>
            {/* A section being done by hand can go back to the prepare run at any time. */}
            {autoPrepare && isUnprepared(current) && manual.has(current.id) && (
              <p className="notice small row">
                <span>You're working through this section by hand.</span>
                <span className="spacer" />
                <button type="button" className="btn btn-small btn-primary" onClick={() => setManual((m) => { const next = new Set(m); next.delete(current.id); return next; })}>
                  Back to preparing with AI
                </button>
              </p>
            )}
            {/* Part way through an AI run (some sections have an AI draft, others are still empty): a way to carry on. */}
            {recipe.writing.ai_draft && unprepared.length === 0 && sections.some((s) => s.ai_draft) && sections.some((s) => s.status === "writing" && !s.content.trim()) && (
              <p className="notice small row">
                <span>{sections.filter((s) => s.status === "writing" && !s.content.trim()).length} sections have no text yet.</span>
                <span className="spacer" />
                <button type="button" className="btn btn-small" onClick={() => setAiWriting(true)}>Write the rest using AI</button>
              </p>
            )}
            {autoPrepare && unprepared.some((s) => !manual.has(s.id)) && (
              <p className="notice small row">
                <span>{unprepared.length} {unprepared.length === 1 ? "section is" : "sections are"} not prepared yet.</span>
                <span className="spacer" />
                <button type="button" className="btn btn-small" onClick={() => setSelected(unprepared.find((s) => !manual.has(s.id))!.id)}>Prepare them</button>
              </p>
            )}
            <SectionWork
              key={current.id}
              piece={piece}
              section={current}
              contract={contract}
              recipe={recipe}
              blockedResearch={blockedResearch(current)}
              blockedBrief={blockedBrief}
              onChanged={refresh}
            />
          </>
        )}
      </div>
    </div>
  );
}

function SectionWork({ piece, section, contract, recipe, blockedResearch, blockedBrief, onChanged }: {
  piece: Piece;
  section: Section;
  contract: Contract;
  recipe: Recipe;
  blockedResearch: string | null;
  blockedBrief: string | null;
  onChanged: () => void;
}) {
  const owed = contract.expectations.filter((e) => section.expectation_ids.includes(e.id));
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Section {section.position}</span>
        {/* Once the section is being written its heading is edited in the editor, so it isn't shown twice. */}
        {section.status !== "writing" && section.status !== "written" && <h2>{section.heading}</h2>}
        {section.purpose && <p className="muted">{section.purpose}</p>}
        {owed.length > 0 && (
          // The points this section owes the reader, tucked away so the section's text starts higher up the page.
          <details className="owes-details small">
            <summary className="muted">What this section owes the reader ({owed.length})</summary>
            <ul className="owes small">{owed.map((e) => <li key={e.id}>{e.text}</li>)}</ul>
          </details>
        )}
      </div>
      {section.status === "research" && (
        <ResearchStep piece={piece} section={section} blocked={blockedResearch} onAdvanced={onChanged} />
      )}
      {section.status === "brief" && <BriefEditor section={section} scope={itemScope(recipe, section.id)} blocked={blockedBrief} onConfirmed={onChanged} />}
      {(section.status === "writing" || section.status === "written") && (
        <Writer piece={piece} section={section} recipe={recipe} onChanged={onChanged} />
      )}
    </>
  );
}

/** Approved research for a section, or for the whole piece when sections have no research of their own. */
function useItems(pieceId: string, sectionId: string | null) {
  return useLoad(
    async () => {
      let q = supabase.from("research_items").select("*, sources(id, url, title, published, in_library)")
        .eq("piece_id", pieceId).eq("status", "approved");
      q = sectionId ? q.eq("scope", "section").eq("section_key", sectionId) : q.eq("scope", "piece");
      return must<ResearchItem[]>(await q.order("created_at"));
    },
    [pieceId, sectionId],
  );
}

const itemScope = (recipe: Recipe, sectionId: string) =>
  recipe.outline.mode === "off" || !recipe.sections.research ? null : sectionId;

function BriefEditor({ section, scope, blocked, onConfirmed }: { section: Section; scope: string | null; blocked: string | null; onConfirmed: () => void }) {
  const [bullets, setBullets] = useState<BriefBullet[]>(section.brief ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: items } = useItems(section.piece_id, scope);
  const number = (id: string) => (items ?? []).findIndex((i) => i.id === id) + 1;

  return (
    <div className="workbench">
      <section className="doc-surface" aria-label="Section brief">
        <header>
          <strong>Brief</strong>
          <span className="small muted">Crisp bullets only, so the writing stays yours.</span>
        </header>
        <div className="stack" style={{ padding: "18px 20px 22px" }}>
          {blocked && <p className="notice info">{blocked}</p>}
          {bullets.length === 0 ? (
            <p className="muted small">Ask the AI for a brief from this section's approved research and the analysis, or write the bullets yourself.</p>
          ) : (
            <ul className="brief-edit">
              {bullets.map((b, i) => (
                <li key={i}>
                  <input type="text" value={b.text} onChange={(e) => setBullets(bullets.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} aria-label={`Bullet ${i + 1}`} />
                  <span className="refs">{b.refs.map((r) => <span key={r} className="tag" title={(items ?? []).find((x) => x.id === r)?.statement}>[{number(r)}]</span>)}</span>
                  <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => setBullets(bullets.filter((_, j) => j !== i))} aria-label="Remove bullet">✕</button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setBullets([...bullets, { text: "", refs: [] }])}>Add bullet</button>
            <span className="spacer" />
            <AiAction<{ bullets: BriefBullet[] }>
              label={bullets.length ? "Suggest again" : "Suggest a brief"}
              primary={bullets.length === 0}
              disabled={Boolean(blocked)}
              reason="Not yet: see the note above"
              payload={{ task: "section_brief", section_id: section.id }}
              onDone={(r) => setBullets(r.bullets)}
            />
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || Boolean(blocked) || !bullets.some((b) => b.text.trim())} onClick={async () => {
              setBusy(true);
              setError(null);
              const { error: err } = await supabase.rpc("confirm_brief", { target_section: section.id, bullets: bullets.filter((b) => b.text.trim()) });
              if (err) { setError(err.message); setBusy(false); } else onConfirmed();
            }}>
              Confirm brief and start writing
            </button>
          </div>
        </div>
      </section>
      <aside className="rail" aria-label="Approved research">
        <h3>Approved for this section</h3>
        <ItemList items={items} />
      </aside>
    </div>
  );
}

function ItemList({ items }: { items: ResearchItem[] | null }) {
  if (!items) return <Loading />;
  if (!items.length) return <p className="small muted">None.</p>;
  return (
    <ol className="item-list">
      {items.map((i) => (
        <li key={i.id} id={`ref-${i.id}`}>
          <span className="small">{i.statement}</span>
          {i.sources?.url && <a className="small" href={i.sources.url} target="_blank" rel="noreferrer">{i.sources.title || "source"}</a>}
        </li>
      ))}
    </ol>
  );
}

interface GrammarFix {
  original: string;
  replacement: string;
  reason: string;
}

function Writer({ piece, section, recipe, onChanged }: { piece: Piece; section: Section; recipe: Recipe; onChanged: () => void }) {
  const [text, setText] = useState(section.content);
  const [savedText, setSavedText] = useState(section.content);
  const [saving, setSaving] = useState(false);
  const [fixes, setFixes] = useState<GrammarFix[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The talking points and sources beside the editor. Once the AI has written the section they are tucked away by default,
  // so the text has the whole width; they are one click away.
  const [railOpen, setRailOpen] = useState(!section.ai_draft);
  // Revising from feedback: the panel, and the editor's handle (to read the selection or the part the cursor is in).
  const [reviseOpen, setReviseOpen] = useState(false);
  const editorRef = useRef<RichEditorHandle>(null);
  // The section's own heading (its H2), edited above the text. It is saved when you leave the box.
  const [heading, setHeading] = useState(section.heading);
  useEffect(() => setHeading(section.heading), [section.heading]);
  const showCosts = useShowCosts();
  // How many times the text has been saved since this copy of the section was loaded. A check is tied to
  // the revision it ran on, so any save after that means the check no longer describes the text.
  const [saves, setSaves] = useState({ rev: section.content_rev, n: 0 });
  const { data: items } = useItems(piece.id, itemScope(recipe, section.id));
  const timer = useRef<number | null>(null);
  const written = section.status === "written";
  const number = (id: string | null) => (id ? (items ?? []).findIndex((i) => i.id === id) + 1 : 0);

  // Autosave a moment after typing stops.
  useEffect(() => {
    if (text === savedText) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setSaving(true);
      const { error: err } = await supabase.from("piece_sections").update({ content: text }).eq("id", section.id);
      setSaving(false);
      if (err) setError(err.message);
      else {
        setSavedText(text);
        setSaves((s) => ({ rev: section.content_rev, n: (s.rev === section.content_rev ? s.n : 0) + 1 }));
      }
    }, 900);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [text, savedText, section.id]);

  async function flush() {
    if (text === savedText) return;
    must(await supabase.from("piece_sections").update({ content: text }).eq("id", section.id).select("id"));
    setSavedText(text);
    setSaves((s) => ({ rev: section.content_rev, n: (s.rev === section.content_rev ? s.n : 0) + 1 }));
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Words of text, not of Markdown: link addresses and the marks around headings, lists and emphasis are left out.
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|[-*]|\d+[.)])\s+/gm, "")
    .replace(/\*\*?|\\|\|/g, " ");
  const words = plain.trim() ? plain.trim().split(/\s+/).length : 0;
  const unsaved = text !== savedText;

  async function saveHeading() {
    const h = heading.trim();
    if (!h) { setHeading(section.heading); return; }
    if (h === section.heading) return;
    try {
      must(await supabase.from("piece_sections").update({ heading: h }).eq("id", section.id).select("id"));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setHeading(section.heading);
    }
  }

  // A tick shows only while the text is exactly what the check ran on.
  const unchanged = text === section.content && !(saves.rev === section.content_rev && saves.n > 0);
  const stateOf = (ran: boolean, rev: number | null | undefined): CheckState =>
    !ran ? "never" : unchanged && rev === section.content_rev ? "current" : "stale";
  const grammarState = stateOf(Boolean(section.grammar_check), section.grammar_check?.rev);
  const factState = stateOf(Boolean(section.fact_check), section.fact_check?.rev);
  const contractRuns = recipe.checks.contract && recipe.contract.mode !== "off" && section.expectation_ids.length > 0;
  const contractState = stateOf(Boolean(section.contract_check), section.contract_check?.rev);
  const notCurrent = [
    recipe.checks.grammar && grammarState !== "current" ? "Grammar" : null,
    recipe.checks.fact && factState !== "current" ? "Facts" : null,
    contractRuns && recipe.checks.contract && contractState !== "current" ? "Scope" : null,
  ].filter(Boolean) as string[];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const grammarFound = fixes?.length ?? section.grammar_check?.found ?? 0;
  const contractOpen = section.contract_check?.results.filter((r) => r.status !== "met").length ?? 0;

  // Open flags from the checks, counted where the writer is looking.
  const flagCount = (fixes?.length ?? 0) + (section.fact_check?.flags.length ?? 0)
    + (section.contract_check?.results.filter((r) => r.status !== "met").length ?? 0);

  const hasSide = Boolean(section.points) || (section.brief ?? []).length > 0 || (items ?? []).length > 0;

  return (
    <div className={`workbench${railOpen && hasSide ? "" : " no-rail"}`}>
      <div className="stack-lg">
        <section className="doc-surface" aria-label="Your writing">
          <header>
            <strong>Write</strong>
            <span className="small faint">{words} words · {saving ? "saving…" : unsaved ? "unsaved" : "saved"}</span>
            {section.ai_draft && <span className="tag flag">started from an AI draft</span>}
            {written && <span className="tag ok">Written</span>}
            {!written && flagCount > 0 && (
              <a href="#checks" className="tag flag flag-jump" onClick={(e) => { e.preventDefault(); document.getElementById("checks")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                {flagCount} to look at ↓
              </a>
            )}
            <span className="spacer" />
            {!written && recipe.writing.ai_draft && text.trim() && (
              <button type="button" className="btn btn-small" aria-expanded={reviseOpen} onClick={() => setReviseOpen((o) => !o)}>Revise</button>
            )}
            {hasSide && (
              <button type="button" className="btn btn-quiet btn-small" aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
                {railOpen ? "Hide points and sources" : "Show points and sources"}
              </button>
            )}
            {written ? (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => {
                must(await supabase.from("piece_sections").update({ status: "writing" }).eq("id", section.id).select("id"));
                onChanged();
              })}>Reopen</button>
            ) : (
              <button type="button" className="btn btn-small btn-primary" disabled={busy || !text.trim()} onClick={() => act(async () => {
                await flush();
                const { error: err } = await supabase.rpc("complete_section", { target_section: section.id });
                if (err) throw err;
                onChanged();
              })}>Mark section written</button>
            )}
          </header>
          {reviseOpen && !written && (
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--rule)" }}>
              <RevisePanel sectionId={section.id} text={text} editor={editorRef} onApply={setText} onClose={() => setReviseOpen(false)} />
            </div>
          )}
          {/* The section's own heading: its H2 in the finished piece. It starts as the outline's heading and can be changed. */}
          <div className="section-h2">
            <span className="section-h2-tag" aria-hidden="true">H2</span>
            <input type="text" value={heading} readOnly={written} maxLength={300} onChange={(e) => setHeading(e.target.value)} onBlur={() => void saveHeading()}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="Section heading" aria-label="Section heading (H2)" />
          </div>
          <RichEditor value={text} onChange={setText} readOnly={written} label="Section text" handleRef={editorRef}
            placeholder="Write this section in your own words, from the talking points and sources." />
        </section>
        <SourceLinks text={text} items={items} disabled={written} onChange={setText} />

        <ErrorText>{error}</ErrorText>
        {note && <p className="notice small">{note}</p>}

        {!written && text.trim() && notCurrent.length > 0 && (
          <p className="small faint">
            Not checked since your last edit: {notCurrent.join(", ")}. The checks are advisory; you can still mark the section written.
          </p>
        )}

        {!written && (
          <div className="checks" id="checks">
            {recipe.checks.grammar && <div className="check">
              <div className="check-head">
                <strong>Grammar</strong>
                <span className="small muted">Spelling, grammar and punctuation only. Never rewrites your sentences.</span>
                <CheckStatus state={grammarState} summary={grammarFound === 0 ? "no corrections" : plural(grammarFound, "suggestion", "suggestions")} />
              </div>
              <AiAction<{ suggestions: GrammarFix[]; cost_usd: number | null }>
                label="Check grammar"
                primary={false}
                disabled={!text.trim() || unsaved}
                reason={!text.trim() ? "Write something first" : "Saving…"}
                payload={{ task: "grammar_check", section_id: section.id, text }}
                onDone={(r) => { setFixes(r.suggestions); setNote(r.suggestions.length ? null : (showCosts ? `No corrections needed (${formatCost(r.cost_usd)}).` : "No corrections needed.")); onChanged(); }}
              />
              {fixes && fixes.length > 0 && (
                <ul className="fixes">
                  {fixes.map((f, i) => (
                    <li key={i}>
                      <span><del>{f.original}</del> → <ins>{f.replacement}</ins></span>
                      <span className="small faint">{f.reason}</span>
                      <span className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-small" disabled={!text.includes(f.original)} onClick={() => {
                          setText(text.replace(f.original, f.replacement));
                          setFixes(fixes.filter((_, j) => j !== i));
                        }}>Accept</button>
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => setFixes(fixes.filter((_, j) => j !== i))}>Ignore</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>}

            {recipe.checks.fact && <div className="check">
              <div className="check-head">
                <strong>Facts</strong>
                <span className="small muted">Flags numbers and claims that don't match your approved research.</span>
                <CheckStatus state={factState} summary={section.fact_check && section.fact_check.flags.length > 0 ? `${plural(section.fact_check.flags.length, "flag", "flags")} to look at` : "every claim matches"} />
              </div>
              <AiAction label="Check facts" primary={false} disabled={!text.trim() || unsaved}
                reason={!text.trim() ? "Write something first" : "Saving…"}
                payload={{ task: "fact_check", section_id: section.id }} onDone={onChanged} />
              {section.fact_check && (
                section.fact_check.flags.length === 0 ? <p className="small ok-text">Every factual claim matches approved research.</p> : (
                  <ul className="flags">
                    {section.fact_check.flags.map((f: FactFlag, i) => (
                      <li key={i}>
                        <span className={`tag ${f.kind === "mismatch" ? "flag" : ""}`}>{f.kind}</span>
                        <q>{f.sentence}</q>
                        <span className="small muted">{f.issue}{f.item_id ? ` See item [${number(f.item_id)}].` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>}

            {recipe.checks.contract && recipe.contract.mode !== "off" && <div className="check">
              <div className="check-head">
                <strong>Scope</strong>
                <span className="small muted">Does this section deliver what it owes? No score.</span>
                {section.expectation_ids.length > 0 && (
                  <CheckStatus state={contractState} summary={contractOpen > 0 ? `${plural(contractOpen, "point", "points")} not fully covered` : "every point is covered"} />
                )}
              </div>
              <AiAction label="Check against scope" primary={false} disabled={!text.trim() || unsaved || section.expectation_ids.length === 0}
                reason={section.expectation_ids.length === 0 ? "No scope points are assigned to this section" : !text.trim() ? "Write something first" : "Saving…"}
                payload={{ task: "contract_check", section_id: section.id }} onDone={onChanged} />
              {section.contract_check && <ContractResults results={section.contract_check.results} />}
            </div>}

            <div className="check">
              <div className="check-head">
                <strong>Humanizer</strong>
                <span className="small muted">Make the text sound less machine-written, in your own AI tool. Writ never rewrites your sentences.</span>
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {text.trim() && <CopyButton text={`${HUMANIZER_PROMPT}\n\n<text>\n${text}\n</text>`} label="Copy prompt + this section" />}
                <CopyButton text={HUMANIZER_PROMPT} label="Copy prompt only" />
              </div>
              <p className="small muted">
                Paste it into ChatGPT, Claude or Gemini, then paste the result back into the box above. Check numbers and names before you keep it.
              </p>
            </div>

            <div className="check">
              <div className="check-head">
                <strong>Write like…</strong>
                <span className="small muted">Edit this section to sound like one of your company's leaders, in your own AI tool. Writ never rewrites your sentences.</span>
              </div>
              <WriteLike text={text} what="section" />
            </div>

            {recipe.writing.ai_draft && <details className="helper">
              <summary>Rather have AI draft it? (not recommended)</summary>
              <div className="helper-body">
                <p className="small muted">
                  The AI drafts from the brief in your core voice and format profile. The section is then marked as AI-drafted
                  in the editorial record, and readers trust that less. {text.trim() ? "Your current text is kept; the draft appears below it." : ""}
                </p>
                <AiAction<{ text: string; replaced: boolean }>
                  label="Draft with AI"
                  primary={false}
                  payload={{ task: "section_draft", section_id: section.id }}
                  onDone={(r) => {
                    if (r.replaced) { setText(r.text); setSavedText(r.text); }
                    else setNote(`AI draft:\n\n${r.text}`);
                    onChanged();
                  }}
                />
              </div>
            </details>}
          </div>
        )}
        {written && section.contract_check && <ContractResults results={section.contract_check.results} />}
      </div>

      {railOpen && hasSide && <aside className="rail brief-rail" aria-label="Talking points, brief and research">
        {/* The prepared talking points, with their sources, so the section can be written without leaving this screen. */}
        {section.points && <PointsList points={section.points} number={number} />}
        {/* The brief mirrors the points when the section was prepared, so it is shown only for a hand-made one. */}
        {!section.points && (section.brief ?? []).length > 0 && <h3>Brief</h3>}
        {!section.points && (
          <ul className="brief-view">
            {(section.brief ?? []).map((b, i) => (
              <li key={i}>
                <span>{b.text}</span>
                {b.refs.map((r) => <a key={r} href={`#ref-${r}`} className="tag">[{number(r)}]</a>)}
              </li>
            ))}
          </ul>
        )}
        {(section.structure ?? []).length > 0 && (
          <>
            <h3>Planned structure</h3>
            <ol className="brief-view">
              {section.structure!.map((b, i) => (
                <li key={i}><span><strong>{BLOCK_LABELS[b.type] ?? b.type}</strong>: {b.note}</span></li>
              ))}
            </ol>
          </>
        )}
        <h3>Approved research</h3>
        <ItemList items={items} />
      </aside>}
    </div>
  );
}

export function ContractResults({ results }: { results: CheckResult[] }) {
  return (
    <ul className="contract-results">
      {results.map((r) => (
        <li key={r.expectation_id} className={r.status}>
          <span className={`tag ${r.status === "met" ? "ok" : r.status === "partly" ? "flag" : ""}`}>{r.status}</span>
          <div className="stack" style={{ gap: 4 }}>
            <span>{r.text}</span>
            {r.evidence && <q className="small muted">{r.evidence}</q>}
            {r.status !== "met" && r.gap && <span className="small">{r.gap}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
