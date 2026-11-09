import { useEffect, useRef, useState } from "react";
import { callFunction, errorMessage } from "../lib/supabase";
import { CopyButton } from "./ui";
import { MarkdownView } from "./Links";
import type { Section, SectionPoints } from "../lib/types";

/** A section the "prepare" run hasn't done yet (the old manual research and brief steps are still reachable for it). */
export const isUnprepared = (s: Section) => s.status === "research" || s.status === "brief";

/** The talking points for a section, in the order to make them. `number` turns a source id into its [n] in the research list. */
export function PointsList({ points, number }: { points: SectionPoints; number?: (id: string) => number }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      {points.titles.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>Heading ideas</h3>
          <ul className="points-titles">
            {points.titles.map((t) => (
              <li key={t}><span>{t}</span><CopyButton text={t} label="Copy" /></li>
            ))}
          </ul>
        </div>
      )}
      <div className="stack" style={{ gap: 8 }}>
        <h3>Talking points</h3>
        <ol className="points-list">
          {points.points.map((p, i) => (
            <li key={i}>
              <strong>{p.point}</strong>
              {p.direction && <p className="small">{p.direction}</p>}
              {p.evidence && (
                <p className="small points-evidence">
                  {p.evidence}
                  {number && p.refs.map((r) => {
                    const n = number(r);
                    return n > 0 ? <a key={r} href={`#ref-${r}`} className="tag">[{n}]</a> : null;
                  })}
                </p>
              )}
              {!number && p.refs.length > 0 && <p className="small faint">{p.refs.length} {p.refs.length === 1 ? "source" : "sources"}</p>}
              {p.sub_section && <p className="small faint">For: {p.sub_section}</p>}
            </li>
          ))}
        </ol>
      </div>
      {points.extra_sub_sections.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>Sub-sections to consider adding</h3>
          <ul className="points-extra">
            {points.extra_sub_sections.map((e) => (
              <li key={e.heading}><strong>{e.heading}</strong>{e.why && <span className="small muted"> — {e.why}</span>}</li>
            ))}
          </ul>
        </div>
      )}
      {points.thin.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>Where you'll need your own view</h3>
          <ul className="points-extra">
            {points.thin.map((t) => <li key={t} className="small">{t}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Prepares every section that isn't ready, one after another: a web search for the section, then its talking points.
 * Each section is saved as it finishes, so a failure only means trying that section again.
 */
export function PreparePanel({ pieceId, sections, manual, onRunningChange, onProgress, onFinished, onManual }: {
  pieceId: string;
  sections: Section[];
  /** Sections the writer chose to do by hand: the run leaves them out. */
  manual: Set<string>;
  /** The run started or stopped, so the screen keeps this panel in view (and the section list still) while it works. */
  onRunningChange: (running: boolean) => void;
  /** A section was finished: reload the sections. */
  onProgress: () => void;
  /** Every section is prepared. */
  onFinished: () => void;
  /** Work through one section by hand instead (the old research and brief steps). */
  onManual: (sectionId: string) => void;
}) {
  void pieceId;
  const todo = sections.filter((s) => isUnprepared(s) && !manual.has(s.id));
  const total = sections.length;
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<{ id: string; step: string } | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  // Sections whose web search wasn't available; their points still came from the research the piece already has.
  const [noSearch, setNoSearch] = useState<string[]>([]);
  const stop = useRef(false);
  const busy = useRef(false);
  // The loop reads the sections as they are now, not as they were when it started, so one finished or chosen by hand
  // in the meantime is skipped.
  const latest = useRef({ sections, manual });
  latest.current = { sections, manual };

  async function run() {
    if (busy.current) return;
    busy.current = true;
    stop.current = false;
    setRunning(true);
    onRunningChange(true);
    setFailed(null);
    setNoSearch([]);
    let at = "";
    try {
      for (const s of todo) {
        if (stop.current) break;
        const now = latest.current.sections.find((x) => x.id === s.id);
        if (!now || !isUnprepared(now) || latest.current.manual.has(s.id)) continue;
        at = s.id;
        setCurrent({ id: s.id, step: "Searching the web for this section…" });
        try {
          await callFunction("research", { action: "search", section_id: s.id, auto: true });
        } catch (e) {
          // No web search (for example a provider without it): carry on with the research the piece already has.
          setNoSearch((list) => [...list, `${s.heading}: ${errorMessage(e)}`]);
        }
        setCurrent({ id: s.id, step: "Working out the talking points…" });
        await callFunction("ai", { task: "section_points", section_id: s.id });
        onProgress();
      }
      if (!stop.current) onFinished();
    } catch (e) {
      setFailed({ id: at, message: errorMessage(e) });
    } finally {
      busy.current = false;
      setRunning(false);
      setCurrent(null);
      onRunningChange(false);
    }
  }

  const position = (id: string) => sections.findIndex((s) => s.id === id) + 1;
  const first = todo[0];

  if (running && current) {
    return (
      <section className="card stack" aria-label="Preparing the sections" style={{ gap: 18 }}>
        <div className="applying" role="status" aria-live="polite">
          <div className="applying-ring" aria-hidden="true"><span /></div>
          <strong>Section {position(current.id)} of {total}: {sections.find((s) => s.id === current.id)?.heading}</strong>
          <span className="small muted">{current.step}</span>
        </div>
        <ol className="prepare-steps">
          {sections.map((s) => {
            const state = !isUnprepared(s) ? "done" : s.id === current.id ? "doing" : "waiting";
            return (
              <li key={s.id} className={state}>
                <span className="prepare-mark" aria-hidden="true">{state === "done" ? "✓" : state === "doing" ? "●" : "○"}</span>
                <span>{s.position}. {s.heading}</span>
              </li>
            );
          })}
        </ol>
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => { stop.current = true; }}>Stop after this section</button>
          <span className="small muted">Finished sections are kept, and you can pick up where you left off.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="card stack" aria-label="Prepare the sections" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Prepare your sections</h2>
        <p className="muted">
          The AI goes through the outline one section at a time. For each, it searches the web for material that strengthens the section,
          then works out the talking points: what to say, the evidence behind each point, heading ideas and where you'll need your own view.
          Everything you need to write a section is then on one screen. {todo.length < total ? `${todo.length} of ${total} sections are left to prepare.` : ""}
        </p>
      </div>
      {failed && (
        <p className="notice" role="alert">
          Stopped at section {position(failed.id)}: {failed.message} The sections already prepared are kept. Try again to continue from here.
        </p>
      )}
      {noSearch.length > 0 && (
        <p className="notice small">The web search wasn't available for {noSearch.length} {noSearch.length === 1 ? "section" : "sections"}, so those use the research the piece already has. {noSearch[0]}</p>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={todo.length === 0} onClick={run}>
          {failed ? "Try again" : todo.length < total ? `Prepare the other ${todo.length} ${todo.length === 1 ? "section" : "sections"}` : "Prepare all sections"}
        </button>
        {first && <button type="button" className="btn btn-quiet btn-small" onClick={() => onManual(first.id)}>Do a section by hand instead</button>}
      </div>
    </section>
  );
}

/** Shown once every section is prepared: write it yourself with the points beside you, or let the AI write from them. */
export function StartChoice({ canUseAi, onStart, onAi, onAll }: { canUseAi: boolean; onStart: () => void; onAi: () => void; onAll: () => void }) {
  return (
    <section className="card stack" aria-label="Start writing" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Your sections are ready</h2>
        <p className="muted">Every section has its talking points and sources. How do you want to write it?</p>
      </div>
      <div className="start-choices">
        <div className="start-choice">
          <button type="button" className="btn btn-primary" onClick={onStart}>Start Writing</button>
          <p className="small muted">Write each section yourself, in order, with its talking points and sources beside you. Grammar, fact and scope checks are there as you go.</p>
        </div>
        <div className="start-choice">
          <button type="button" className="btn" disabled={!canUseAi} onClick={onAi}>Write using AI</button>
          <p className="small muted">
            {canUseAi
              ? "The AI writes every section from the prepared points, one after another, with no further research. You then read the complete draft and edit it."
              : "This format doesn't use AI drafting."}
          </p>
        </div>
      </div>
      <div><button type="button" className="btn btn-quiet btn-small" onClick={onAll}>See all the prepared material first</button></div>
    </section>
  );
}

/**
 * Has the AI write each section from its prepared talking points, one after another. No new research. A section that
 * already has text is left alone. It starts as soon as it appears.
 */
export function AiWritePanel({ sections, onRunningChange, onProgress, onFinished, onBack }: {
  sections: Section[];
  onRunningChange: (running: boolean) => void;
  onProgress: () => void;
  /** Every section has its text. */
  onFinished: () => void;
  /** Leave without writing (or after a stop). */
  onBack: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const [stopped, setStopped] = useState(false);
  // Some sections were left without text (for example ones not prepared yet), so the draft isn't complete.
  const [skipped, setSkipped] = useState(false);
  const stop = useRef(false);
  const busy = useRef(false);
  const started = useRef(false);
  const latest = useRef(sections);
  latest.current = sections;
  // Sections still to write: prepared, with no text of their own yet.
  const needs = (s: Section) => s.status === "writing" && !s.content.trim();
  const todo = sections.filter(needs);
  const total = sections.length;

  async function run() {
    if (busy.current) return;
    busy.current = true;
    stop.current = false;
    setStopped(false);
    setRunning(true);
    onRunningChange(true);
    setFailed(null);
    let at = "";
    try {
      for (const s of sections.filter(needs)) {
        if (stop.current) { setStopped(true); return; }
        const now = latest.current.find((x) => x.id === s.id);
        if (!now || !needs(now)) continue;
        at = s.id;
        setCurrent(s.id);
        await callFunction("ai", { task: "section_draft", section_id: s.id });
        onProgress();
      }
      // A stop pressed during the last section still counts as a stop, and sections that couldn't be written (not
      // prepared yet) mean it isn't finished.
      if (stop.current) { setStopped(true); return; }
      if (latest.current.some(needs)) { setSkipped(true); return; }
      onFinished();
    } catch (e) {
      setFailed({ id: at, message: errorMessage(e) });
    } finally {
      busy.current = false;
      setRunning(false);
      setCurrent(null);
      onRunningChange(false);
    }
  }

  // Starts once, when the panel first appears.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const position = (id: string) => sections.findIndex((s) => s.id === id) + 1;
  if (running && current) {
    return (
      <section className="card stack" aria-label="Writing the sections" style={{ gap: 18 }}>
        <div className="applying" role="status" aria-live="polite">
          <div className="applying-ring" aria-hidden="true"><span /></div>
          <strong>Writing section {position(current)} of {total}: {sections.find((s) => s.id === current)?.heading}</strong>
          <span className="small muted">From the prepared points. No new research.</span>
        </div>
        <ol className="prepare-steps">
          {sections.map((s) => {
            const state = s.id === current ? "doing" : needs(s) ? "waiting" : "done";
            return (
              <li key={s.id} className={state}>
                <span className="prepare-mark" aria-hidden="true">{state === "done" ? "✓" : state === "doing" ? "●" : "○"}</span>
                <span>{s.position}. {s.heading}</span>
              </li>
            );
          })}
        </ol>
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => { stop.current = true; }}>Stop after this section</button>
          <span className="small muted">Sections already written are kept.</span>
        </div>
      </section>
    );
  }
  return (
    <section className="card stack" aria-label="Writing the sections" style={{ gap: 14 }}>
      <h2>{stopped ? "Writing paused" : failed ? "Writing stopped" : skipped ? "Some sections weren't written" : "Getting ready…"}</h2>
      {failed && <p className="notice" role="alert">Stopped at section {position(failed.id)}: {failed.message} Sections already written are kept.</p>}
      {stopped && <p className="muted">{todo.length} {todo.length === 1 ? "section is" : "sections are"} still to write.</p>}
      {skipped && <p className="muted">{todo.length} {todo.length === 1 ? "section couldn't" : "sections couldn't"} be written, because {todo.length === 1 ? "it isn't" : "they aren't"} prepared yet. Prepare {todo.length === 1 ? "it" : "them"} first.</p>}
      <div className="row">
        {(failed || stopped) && todo.length > 0 && <button type="button" className="btn btn-primary" onClick={() => void run()}>{failed ? "Try again" : "Carry on"}</button>}
        <button type="button" className="btn btn-quiet btn-small" onClick={onBack}>Back</button>
      </div>
    </section>
  );
}

/** The whole draft as one document, with a way into each section to edit it. */
export function FullDraft({ title, sections, onOpen }: { title: string; sections: Section[]; onOpen: (id: string) => void }) {
  const text = [`# ${title}`, ...sections.map((s) => `## ${s.heading}\n\n${s.content.trim() || "(not written yet)"}`)].join("\n\n");
  const words = sections.reduce((n, s) => n + (s.content.trim() ? s.content.trim().split(/\s+/).length : 0), 0);
  const written = sections.filter((s) => s.content.trim()).length;
  return (
    <div className="stack-lg">
      <div className="row" style={{ alignItems: "center" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2>Complete draft</h2>
          <p className="muted small">{written} of {sections.length} sections have text · {words} words. Read it through, then open any section to edit it and mark it written.</p>
        </div>
        <span className="spacer" />
        <CopyButton text={text} label="Copy the draft" />
      </div>
      <article className="card stack full-draft" aria-label="Complete draft" style={{ gap: 22 }}>
        <h1>{title}</h1>
        {sections.map((s) => (
          <section key={s.id} className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ alignItems: "baseline" }}>
              <h2>{s.heading}</h2>
              <span className="spacer" />
              {s.ai_draft && <span className="tag flag">AI draft</span>}
              {s.status === "written" && <span className="tag ok">Written</span>}
              <button type="button" className="btn btn-quiet btn-small" onClick={() => onOpen(s.id)}>Open to edit</button>
            </div>
            {s.content.trim()
              ? <MarkdownView text={s.content} />
              : <p className="muted" style={{ margin: 0 }}>Not written yet.</p>}
          </section>
        ))}
      </article>
    </div>
  );
}

/** Every section's prepared material in one place, with a way into each section to write it. */
export function DraftOverview({ sections, onOpen }: { sections: Section[]; onOpen: (id: string) => void }) {
  const prepared = sections.filter((s) => s.points).length;
  return (
    <div className="stack-lg">
      <div className="stack" style={{ gap: 4 }}>
        <h2>All sections</h2>
        <p className="muted small">
          The prepared material for each section, in order. {prepared} of {sections.length} sections are prepared. Open a section to write it with its talking points and sources beside you.
        </p>
      </div>
      {sections.map((s) => (
        <section key={s.id} className="card stack" aria-label={s.heading} style={{ gap: 12 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{s.position}. {s.heading}</h3>
            <span className={`tag${s.status === "written" ? " ok" : ""}`}>{s.status === "written" ? "Written" : s.points ? "Prepared" : "Not prepared"}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-small" onClick={() => onOpen(s.id)}>{s.status === "written" ? "Open" : "Open and write"}</button>
          </div>
          {s.purpose && <p className="small muted" style={{ margin: 0 }}>{s.purpose}</p>}
          {s.points ? <PointsList points={s.points} /> : <p className="small muted">Not prepared yet.</p>}
        </section>
      ))}
    </div>
  );
}
