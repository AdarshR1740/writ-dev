import { useEffect, useRef, useState } from "react";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatCost } from "../lib/format";
import { countWords } from "../lib/wordCount";
import { useShowCosts } from "../lib/showCosts";
import { BLOCK_LABELS, type BriefBullet, type CheckResult, type Contract, type FactFlag, type Piece, type ResearchItem, type Section } from "../lib/types";
import { ResearchStep } from "./ResearchStep";
import { AiAction, ClearButton, CopyButton, ErrorText, Loading } from "./ui";
import { normalise, type Recipe } from "../lib/recipes";
import { WriteLikeRow } from "./WriteLike";
import { headingLine } from "../lib/assemble";
import { SourceLinks } from "./Links";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { RevisePanel } from "./Revise";
import { writingState } from "../lib/stepViews";
import { useEditLock } from "../lib/locks";
import { LockBanner } from "./LockBanner";
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
  const { startable } = writingState(sections, autoPrepare);
  const showStart = startable && (selected === null || selected === "start");
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
  const nextSection = sections.filter((x) => x.position > current.position).sort((a, b) => a.position - b.position)[0];

  const writtenCount = sections.filter((x) => x.status === "written").length;
  const allWritten = writtenCount === sections.length;
  const left = sections.length - writtenCount;

  return (
    <div className="writing-wrap">
    {onContinue && piece.stage === "writing" && (
      <div className="writing-bar" role="region" aria-label="Finish writing">
        <span className="small">
          {allWritten
            ? <><strong>Writing is complete.</strong> You can still reopen a section to edit it.</>
            : <>{writtenCount} of {sections.length} sections written</>}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-small" disabled={busyRun}
          title={!allWritten ? `${left} ${left === 1 ? "section is" : "sections are"} not marked written yet. Sign-off shows what is still missing, and you can come back here.` : undefined}
          onClick={onContinue}>
          Send to {finishLabel.toLowerCase()} →
        </button>
      </div>
    )}
    <div className={`writing${sections.length === 1 && recipe.outline.mode === "off" ? " single" : ""}`}>
      <nav className="section-nav" aria-label="Sections">
        {sections.length > 1 && (
          <p className="small faint section-progress" aria-live="polite">
            {sections.filter((s) => s.status === "written").length} of {sections.length} written
          </p>
        )}
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
          <button key={s.id} type="button" className={`section-link${s.level === 3 ? " is-sub" : ""}${!showAll && !showDraft && !showStart && s.id === current.id ? " active" : ""}`} disabled={busyRun} onClick={() => setSelected(s.id)}>
            <span className={`dot ${s.status === "written" ? "done" : s.id === current.id ? "pending" : ""}`} />
            <span className="stack" style={{ gap: 0 }}>
              <span>{s.level === 3 ? "" : `${s.position}. `}{s.heading}</span>
              <span className="small faint">{autoPrepare && isUnprepared(s) && !manual.has(s.id) ? "Not prepared" : STATUS_LABEL[s.status]}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className="stack-lg" style={{ minWidth: 0 }}>
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
              onNext={nextSection ? () => setSelected(nextSection.id) : undefined}
              onDeleted={() => {
                const others = sections.filter((x) => x.id !== current.id && !subHeadingsOf(sections, current).some((c) => c.id === x.id));
                const before = others.filter((x) => x.position < current.position).pop();
                setSelected((before ?? others[0])?.id ?? null);
              }}
              nextDisabled={busyRun}
              busyRun={busyRun}
              allSections={sections}
            />
          </>
        )}
      </div>
    </div>
    </div>
  );
}

/** The sub-headings that go with a main heading when it is deleted (none for a sub-heading). */
function subHeadingsOf(all: Section[], s: Section): Section[] {
  const sorted = [...all].sort((a, b) => a.position - b.position);
  const at = sorted.findIndex((x) => x.id === s.id);
  const subs: Section[] = [];
  if (s.level === 2) {
    for (let i = at + 1; i < sorted.length && sorted[i].level === 3; i++) subs.push(sorted[i]);
  }
  return subs;
}

/** Deleting this section (with its sub-headings) would leave the piece with nothing. */
const coversAll = (all: Section[], s: Section) => 1 + subHeadingsOf(all, s).length >= all.length;

/** What deleting a section removes, in words, for the confirmation. */
function removedWith(all: Section[], s: Section): string {
  const subs = subHeadingsOf(all, s);
  const words = [s, ...subs].reduce((n, x) => n + countWords(x.content), 0);
  const what = subs.length > 0 ? `"${s.heading}" and its ${subs.length} ${subs.length === 1 ? "sub-heading" : "sub-headings"}` : `"${s.heading}"`;
  return `${what} will be removed from the piece, with ${words} ${words === 1 ? "word" : "words"} of text, its talking points and its research. The other sections stay and are renumbered. To get a section back you would have to add it again in the outline.`;
}

function SectionWork({ piece, section, contract, recipe, blockedResearch, blockedBrief, onChanged, onNext, onDeleted, nextDisabled, allSections, busyRun }: {
  piece: Piece;
  section: Section;
  contract: Contract;
  recipe: Recipe;
  blockedResearch: string | null;
  blockedBrief: string | null;
  onChanged: () => void;
  /** Opens the next section, when there is one. */
  onNext?: () => void;
  /** Called after this section has been deleted, so the page can pick another one. */
  onDeleted: () => void;
  nextDisabled?: boolean;
  allSections: Section[];
  /** A prepare or AI-write run is going: nothing may be removed under it. */
  busyRun: boolean;
}) {
  const owed = contract.expectations.filter((e) => section.expectation_ids.includes(e.id));
  return (
    <>
      <div className="gate page-head">
        <div className="row" style={{ alignItems: "center" }}>
          <span className="eyebrow">Section {section.position} of {allSections.length}</span>
          <span className="spacer" />
          {piece.stage !== "done" && (
            <ClearButton what="this section" label="Delete section" verb="Delete" busyText="Deleting…"
              disabledReason={busyRun ? "Wait for the AI run to finish" : coversAll(allSections, section) ? "A piece needs at least one section" : null}
              consequence={removedWith(allSections, section)}
              onConfirm={async () => {
                const { error: err } = await supabase.rpc("delete_section", { target_section: section.id });
                if (err) throw new Error(/edit_locked/.test(err.message) ? err.message.replace(/^.*edit_locked:\s*/, "") : err.message);
                onDeleted();
                onChanged();
              }} />
          )}
        </div>
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
        <Writer piece={piece} section={section} recipe={recipe} onChanged={onChanged} onNext={onNext} nextDisabled={nextDisabled} allSections={allSections} />
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

function Writer({ piece, section, recipe, onChanged, onNext, nextDisabled, allSections }: { piece: Piece; section: Section; recipe: Recipe; onChanged: () => void; onNext?: () => void; nextDisabled?: boolean; allSections: Section[] }) {
  const [text, setText] = useState(section.content);
  const [savedText, setSavedText] = useState(section.content);
  const [saving, setSaving] = useState(false);
  const [fixes, setFixes] = useState<GrammarFix[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The talking points and sources beside the editor. Once the AI has written the section they are tucked away by default,
  // so the text has the whole width; they are one click away.
  // The choice is remembered per piece (in this browser) once the writer makes it.
  const railKey = `writ.rail.${piece.id}`;
  const [railOpen, setRailOpenState] = useState(() => {
    try {
      const saved = localStorage.getItem(railKey);
      if (saved === "open") return true;
      if (saved === "closed") return false;
    } catch { /* storage unavailable: use the default */ }
    return !section.ai_draft;
  });
  const setRailOpen = (open: boolean) => {
    setRailOpenState(open);
    try { localStorage.setItem(railKey, open ? "open" : "closed"); } catch { /* not remembered */ }
  };
  const [moreOpen, setMoreOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
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
  // Bumped when the text is cleared, so an autosave already under way doesn't write the old text back.
  const clearedAt = useRef(0);
  const written = section.status === "written";
  // One person (or one Claude) at a time writes a section. The lock is taken on the first edit.
  const lock = useEditLock(piece.id, "section", section.id, !written);
  const lockedOut = lock.other !== null;
  // Someone saved different text while this tab was open (the server's version is kept here): the writer chooses which to keep.
  const [conflict, setConflict] = useState<string | null>(null);
  async function serverContent(): Promise<string | null> {
    const { data: row } = await supabase.from("piece_sections").select("content").eq("id", section.id).single();
    return row ? (row.content as string) : null;
  }
  useEffect(() => {
    if (text !== savedText && !written) void lock.ensure();
  }, [text]);
  const number = (id: string | null) => (id ? (items ?? []).findIndex((i) => i.id === id) + 1 : 0);

  // Autosave a moment after typing stops.
  useEffect(() => {
    if (text === savedText || lock.other || conflict !== null) return;
    if (timer.current) window.clearTimeout(timer.current);
    const startedAt = clearedAt.current;
    timer.current = window.setTimeout(async () => {
      // Someone else may have taken the section since the last edit: then nothing is saved, and the banner says why.
      if (!(await lock.ensure())) return;
      const server = await serverContent();
      if (clearedAt.current !== startedAt) return;
      if (server !== null && server !== savedText) { setConflict(server); return; }
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
  }, [text, savedText, section.id, lock.other, conflict]);

  async function flush() {
    if (text === savedText) return;
    if (!(await lock.ensure())) throw new Error("Someone else is editing this section. Take over from the banner to save your changes.");
    const server = await serverContent();
    if (server !== null && server !== savedText) { setConflict(server); throw new Error("This section changed while you were editing. Choose which version to keep in the banner above the text."); }
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

  const words = countWords(text);
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
  const contractState = stateOf(Boolean(section.contract_check), section.contract_check?.rev);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const grammarFound = fixes?.length ?? section.grammar_check?.found ?? 0;
  const contractOpen = section.contract_check?.results.filter((r) => r.status !== "met").length ?? 0;

  // Open flags from the checks, counted where the writer is looking.
  const flagCount = (fixes?.length ?? 0) + (section.fact_check?.flags.length ?? 0)
    + (section.contract_check?.results.filter((r) => r.status !== "met").length ?? 0);

  // The whole piece as Markdown for copying, with this section's text as it is now (including unsaved typing).
  const draftText = [`# ${piece.title}`, ...allSections.map((s) => `${headingLine(s)}\n\n${(s.id === section.id ? text : s.content).trim() || "(not written yet)"}`)].join("\n\n");

  const hasSide = Boolean(section.points) || (section.brief ?? []).length > 0 || (items ?? []).length > 0;

  return (
    <div className={`workbench${railOpen && hasSide ? "" : " no-rail"}`}>
      <div className="stack-lg">
        <section className="doc-surface fit" aria-label="Your writing">
          <header>
            <strong>Write</strong>
            {section.ai_draft && <span className="tag flag">started from an AI draft</span>}
            {written && <span className="tag ok">Written</span>}
            {!written && flagCount > 0 && (
              <a href="#checks" className="tag flag flag-jump" onClick={(e) => { e.preventDefault(); document.getElementById("checks")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                {flagCount} to look at ↓
              </a>
            )}
            <span className="spacer" />
            {!written && !lockedOut && recipe.writing.ai_draft && text.trim() && (
              <button type="button" className="btn btn-small" aria-expanded={reviseOpen} onClick={() => setReviseOpen((o) => !o)}>Revise</button>
            )}
            {hasSide && (
              <button type="button" className="btn btn-small" aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}>
                {railOpen ? "Hide points and sources" : "Show points and sources"}
              </button>
            )}
            {!written && (
              <span className="more-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreOpen(false); }}
                onKeyDown={(e) => { if (e.key === "Escape") setMoreOpen(false); }}>
                <button type="button" className="btn btn-quiet btn-small" aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More actions" title="More actions" onClick={() => setMoreOpen((o) => !o)}>…</button>
                {moreOpen && (
                  <div className="more-menu-list" role="menu">
                    <button type="button" role="menuitem" className="btn btn-quiet btn-small btn-danger" onMouseDown={(e) => e.preventDefault()}
                      disabled={lockedOut || (!text.trim() && !section.content.trim() && !section.ai_draft)}
                      title={lockedOut ? "Someone else is editing this section" : !text.trim() && !section.content.trim() && !section.ai_draft ? "The section is already empty" : undefined}
                      onClick={() => { setMoreOpen(false); setClearOpen(true); }}>Clear text…</button>
                  </div>
                )}
              </span>
            )}
            {!written && (
              <ClearButton what="this section's text" label="Clear text" hideButton open={clearOpen} onOpenChange={setClearOpen}
                consequence="Everything written in this section is removed, including the AI draft it started from. Its talking points and sources stay, so you can start again."
                disabledReason={lockedOut ? "Someone else is editing this section" : !text.trim() && !section.content.trim() && !section.ai_draft ? "The section is already empty" : null}
                onConfirm={async () => {
                  if (!(await lock.ensure())) throw new Error("Someone else is editing this section. Take over from the banner to continue.");
                  clearedAt.current += 1;
                  if (timer.current) window.clearTimeout(timer.current);
                  // The checks described the old text, so they go with it.
                  must(await supabase.from("piece_sections").update({ content: "", ai_draft: null, grammar_check: null, fact_check: null, contract_check: null }).eq("id", section.id).select("id"));
                  setText("");
                  setSavedText("");
                  setConflict(null);
                  setReviseOpen(false);
                  onChanged();
                }} />
            )}
          </header>
          {reviseOpen && !written && (
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--rule)" }}>
              <RevisePanel sectionId={section.id} text={text} editor={editorRef} onApply={setText} onClose={() => setReviseOpen(false)} />
            </div>
          )}
          {conflict !== null && (
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--rule)" }}>
              <div className="notice row" role="alert" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <span className="small"><strong>This section changed while you were editing.</strong> Someone else saved a different version. Your latest edits are not saved yet.</span>
                <span className="spacer" />
                <button type="button" className="btn btn-small" onClick={() => { setText(conflict); setSavedText(conflict); setConflict(null); onChanged(); }}>Use the saved version</button>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => { setSavedText(conflict); setConflict(null); }}>Keep my version</button>
              </div>
            </div>
          )}
          {lock.other && (
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--rule)" }}>
              <LockBanner holder={lock.other} what="this section" unsaved={text !== savedText} problem={lock.problem} onTakeOver={() => void lock.takeOver()} />
            </div>
          )}
          {/* The section's own heading: its H2 in the finished piece. It starts as the outline's heading and can be changed. */}
          <div className="section-h2">
            <span className="section-h2-tag" aria-hidden="true">H2</span>
            <input type="text" value={heading} readOnly={written || lockedOut} maxLength={300} onChange={(e) => setHeading(e.target.value)} onBlur={() => void saveHeading()}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="Section heading" aria-label="Section heading (H2)" />
          </div>
          <RichEditor value={text} onChange={setText} readOnly={written || lockedOut} label="Section text" handleRef={editorRef}
            placeholder="Write this section in your own words, from the talking points and sources." />
          <div className="writer-bar">
            <span className="small faint">{words} words · {saving ? "saving…" : unsaved ? "unsaved" : "saved"}</span>
            <span className="spacer" />
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
            {onNext && <button type="button" className="btn btn-quiet btn-small" disabled={nextDisabled || unsaved || saving} title={unsaved || saving ? "Saving your text first" : undefined} onClick={onNext}>Next section →</button>}
          </div>
        </section>
        <SourceLinks text={text} items={items} disabled={written || lockedOut} onChange={setText} />
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

        <ErrorText>{error}</ErrorText>
        {note && <p className="notice small">{note}</p>}

        {!written && (
          <div className="checks" id="checks">
            <div className="check">
              <p className="small faint check-intro">The checks are advisory; you can still mark the section written.</p>
              <ul className="check-rows">
                {recipe.checks.grammar && <li>
                  <div className="check-row">
                    <strong title="Spelling, grammar and punctuation only. Never rewrites your sentences.">Grammar</strong>
                    <CheckStatus state={grammarState} summary={grammarFound === 0 ? "no corrections" : plural(grammarFound, "suggestion", "suggestions")} />
                    <AiAction<{ suggestions: GrammarFix[]; cost_usd: number | null }>
                      label={grammarState === "never" ? "Run" : "Run again"}
                      primary={false}
                      small
                      reasonAsTitle
                      disabled={!text.trim() || unsaved}
                      reason={!text.trim() ? "Write something first" : "Saving…"}
                      payload={{ task: "grammar_check", section_id: section.id, text }}
                      onDone={(r) => { setFixes(r.suggestions); setNote(r.suggestions.length ? null : (showCosts ? `No corrections needed (${formatCost(r.cost_usd)}).` : "No corrections needed.")); onChanged(); }}
                    />
                  </div>
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
                </li>}

                {recipe.checks.fact && <li>
                  <div className="check-row">
                    <strong title="Flags numbers and claims that don't match your approved research.">Facts</strong>
                    <CheckStatus state={factState} summary={section.fact_check && section.fact_check.flags.length > 0 ? `${plural(section.fact_check.flags.length, "flag", "flags")} to look at` : "every claim matches"} />
                    <AiAction label={factState === "never" ? "Run" : "Run again"} primary={false} small reasonAsTitle disabled={!text.trim() || unsaved}
                      reason={!text.trim() ? "Write something first" : "Saving…"}
                      payload={{ task: "fact_check", section_id: section.id }} onDone={onChanged} />
                  </div>
                  {section.fact_check && section.fact_check.flags.length > 0 && (
                    <ul className="flags">
                      {section.fact_check.flags.map((f: FactFlag, i) => (
                        <li key={i}>
                          <span className={`tag ${f.kind === "mismatch" ? "flag" : ""}`}>{f.kind}</span>
                          <q>{f.sentence}</q>
                          <span className="small muted">{f.issue}{f.item_id ? ` See item [${number(f.item_id)}].` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>}

                {recipe.checks.contract && recipe.contract.mode !== "off" && <li>
                  <div className="check-row">
                    <strong title="Checks that this section still delivers the points the piece's original scope assigned to it. No score.">Scope verification</strong>
                    {section.expectation_ids.length > 0
                      ? <CheckStatus state={contractState} summary={contractOpen > 0 ? `${plural(contractOpen, "point", "points")} not fully covered` : "every point is covered"} />
                      : <span className="check-state">No scope points assigned</span>}
                    <AiAction label={contractState === "never" ? "Run" : "Run again"} primary={false} small reasonAsTitle
                      disabled={!text.trim() || unsaved || section.expectation_ids.length === 0}
                      reason={section.expectation_ids.length === 0 ? "No scope points are assigned to this section" : !text.trim() ? "Write something first" : "Saving…"}
                      payload={{ task: "contract_check", section_id: section.id }} onDone={onChanged} />
                  </div>
                  {section.contract_check && <ContractResults results={section.contract_check.results} />}
                </li>}

                <WriteLikeRow sections={allSections} currentId={section.id} text={text} onApplyCurrent={setText} onChanged={onChanged}
                  blocked={lockedOut ? "Someone else is editing this section" : unsaved ? "Saving your text…" : null} />

                <li>
                  <div className="check-row polish">
                    <strong title="Copies just the text, to polish in another AI tool. Paste the result back above and check numbers and names.">Polish in another tool</strong>
                    <span className="row" style={{ flexWrap: "wrap" }}>
                      <CopyButton text={draftText} label="Copy entire draft" />
                      <CopyButton text={text} label="Copy this section" disabled={!text.trim()} title={!text.trim() ? "Write something first" : undefined} />
                    </span>
                  </div>
                </li>
              </ul>
            </div>


          </div>
        )}
        {written && section.contract_check && <ContractResults results={section.contract_check.results} />}
      </div>
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
