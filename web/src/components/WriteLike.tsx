import { useState } from "react";
import { Link } from "react-router-dom";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { useCompany } from "../lib/session";
import { writeLikePrompt } from "../lib/sections";
import type { LeaderVoice, Section } from "../lib/types";
import { CopyButton } from "./ui";

/**
 * "Write like X": the writer picks one of the company's leader voices and copies a prompt plus their text
 * into their own AI tool, then pastes the edited text back. Writ never restyles text itself.
 */
export function WriteLike({ text, what = "section" }: { text: string; what?: string }) {
  const company = useCompany();
  const { data: voices, error } = useLoad(
    async () => must<LeaderVoice[]>(await supabase.from("leader_voices").select("*").eq("company_id", company.id).order("name")),
    [company.id],
  );
  const [chosen, setChosen] = useState("");

  if (error) return <p className="small muted">Leader voices couldn't be loaded.</p>;
  if (!voices) return <p className="small muted">Loading voices…</p>;
  if (voices.length === 0) {
    return (
      <p className="small muted">
        No leader voices are defined yet. {company.role === "editor"
          ? <>Add one on the <Link to="/voices">Leader voices</Link> page.</>
          : "An editor can add them on the Leader voices page."}
      </p>
    );
  }

  const voice = voices.find((v) => v.id === chosen) ?? null;
  const prompt = voice ? writeLikePrompt(voice) : "";

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="Leader voice">
          <option value="">Choose a voice…</option>
          {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.role ? `, ${v.role}` : ""}</option>)}
        </select>
        {voice && text.trim() && <CopyButton text={`${prompt}\n\n<text>\n${text}\n</text>`} label={`Copy prompt + this ${what}`} />}
        {voice && <CopyButton text={prompt} label="Copy prompt only" />}
      </div>
      <p className="small muted">
        Paste it into ChatGPT, Claude or Gemini, then paste the result back into the box above. Read it against the original: the facts must not change.
      </p>
    </div>
  );
}

interface VoiceEdit { original: string; replacement: string; reason: string }
interface Proposal { sectionId: string; heading: string; isCurrent: boolean; reply: string; edits: VoiceEdit[] }

const occurrences = (text: string, original: string) => (original ? text.split(original).length - 1 : 0);

/** Applies the edits that are still in the text exactly once, from the end so one can't move another's place. */
function applyBatch(base: string, edits: VoiceEdit[]): { next: string; applied: number; used: VoiceEdit[] } {
  const usable = edits
    .filter((e) => occurrences(base, e.original) === 1)
    .map((e) => ({ e, at: base.indexOf(e.original) }))
    .sort((a, b) => b.at - a.at);
  let next = base;
  let end = Infinity;
  let applied = 0;
  const used: VoiceEdit[] = [];
  for (const { e, at } of usable) {
    if (at + e.original.length > end) continue;
    next = `${next.slice(0, at)}${e.replacement}${next.slice(at + e.original.length)}`;
    end = at;
    applied += 1;
    used.push(e);
  }
  return { next, applied, used };
}

/**
 * The "Write like…" row on the Writing page's checks card: pick a leader voice, tick what to edit, and the AI proposes
 * small wording changes to sound like them. Nothing changes until the writer accepts a change.
 */
export function WriteLikeRow({ sections, currentId, text, onApplyCurrent, onChanged, blocked }: {
  sections: Section[];
  currentId: string;
  /** The current section's text as it is now, including typing that is not saved yet. */
  text: string;
  onApplyCurrent: (text: string) => void;
  onChanged: () => void;
  /** Why the edit can't run right now (someone else is editing, text unsaved), or null. */
  blocked: string | null;
}) {
  const company = useCompany();
  const { data: voices, error } = useLoad(
    async () => must<LeaderVoice[]>(await supabase.from("leader_voices").select("*").eq("company_id", company.id).order("name")),
    [company.id],
  );
  const [chosen, setChosen] = useState("");
  const [entireDraft, setEntireDraft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);

  const hasVoices = Boolean(voices && voices.length > 0);
  const voice = voices?.find((v) => v.id === chosen) ?? null;
  // The sections the edit would cover: the one open, or every section that has text and is not marked written.
  const textOf = (s: Section) => (s.id === currentId ? text : s.content);
  const targets = entireDraft ? sections.filter((s) => s.status !== "written" && textOf(s).trim()) : sections.filter((s) => s.id === currentId && text.trim());
  const skippedWritten = entireDraft ? sections.filter((s) => s.status === "written" && s.content.trim()).length : 0;
  const why = blocked ?? (!voice ? "Choose a voice first" : targets.length === 0 ? "There is no text to edit yet" : null);

  async function run() {
    if (!voice) return;
    setProblem(null);
    setProposals(null);
    const found: Proposal[] = [];
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      setBusy(targets.length > 1 ? `Editing ${i + 1} of ${targets.length}…` : "Editing…");
      try {
        const r = await callFunction<{ reply: string; edits: VoiceEdit[] }>("ai", { task: "section_voice", section_id: s.id, text: textOf(s), voice_id: voice.id });
        found.push({ sectionId: s.id, heading: s.heading, isCurrent: s.id === currentId, reply: r.reply, edits: r.edits });
      } catch (e) {
        failures.push(`${s.heading}: ${errorMessage(e)}`);
      }
    }
    setBusy(null);
    setProposals(found);
    if (failures.length > 0) setProblem(failures.join(" "));
  }

  async function accept(p: Proposal, edits: VoiceEdit[]) {
    setProblem(null);
    let appliedCount = edits.length;
    let usedEdits = edits;
    try {
      if (p.isCurrent) {
        const { next, applied, used } = applyBatch(text, edits);
        if (applied === 0) throw new Error("The text has changed since this was suggested.");
        appliedCount = applied;
        usedEdits = used;
        onApplyCurrent(next);
      } else {
        // Another section: change its saved text, but only if it is still what the suggestion was made from.
        const { data: row } = await supabase.from("piece_sections").select("content, status").eq("id", p.sectionId).single();
        if (row?.status === "written") throw new Error(`"${p.heading}" has been marked written. Reopen it to change it.`);
        const base = (row?.content as string | undefined) ?? "";
        const { next, applied, used } = applyBatch(base, edits);
        if (applied === 0) throw new Error(`The text of "${p.heading}" has changed since this was suggested.`);
        const { data: saved, error: saveError } = await supabase.from("piece_sections").update({ content: next })
          .eq("id", p.sectionId).eq("content", base).neq("status", "written").select("id");
        if (saveError) throw new Error(/lock|editing/i.test(saveError.message) ? `Someone else is editing "${p.heading}". Try again when they finish.` : saveError.message);
        if (!saved || saved.length === 0) throw new Error(`The text of "${p.heading}" changed while you were reviewing. Run the edit again.`);
        appliedCount = applied;
        usedEdits = used;
        onChanged();
      }
      setProposals((all) => all && all.map((x) => (x.sectionId === p.sectionId ? { ...x, edits: x.edits.filter((e) => !usedEdits.includes(e)) } : x)));
      if (appliedCount < edits.length) setProblem(`${appliedCount} of ${edits.length} changes were applied. The rest no longer match the text and are still listed.`);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  const open = (proposals ?? []).filter((p) => p.edits.length > 0);

  return (
    <li>
      <div className="check-row write-like">
        <strong title="Edit your text to sound like one of your company's leaders. You accept or ignore every change.">Write like…</strong>
        {error ? <span className="check-state">Leader voices couldn't be loaded.</span>
          : !voices ? <span className="check-state">Loading voices…</span>
          : !hasVoices ? (
            <span className="check-state">
              No leader voices yet. {company.role === "editor" ? <>Add one on the <Link to="/voices">Leader voices</Link> page.</> : "An editor can add them on the Leader voices page."}
            </span>
          ) : (
            <span className="write-like-controls">
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="Leader voice" disabled={Boolean(busy)}>
                <option value="">Choose a voice…</option>
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.role ? `, ${v.role}` : ""}</option>)}
              </select>
              <button type="button" className="btn btn-small write-like-run" disabled={Boolean(why) || Boolean(busy)} title={why ?? undefined} onClick={() => void run()}>
                {busy ?? "Run edit"}
              </button>
              <span className="write-like-ticks">
              <label className="inline-check" title="Edit only the section you are writing">
                <input type="checkbox" checked={!entireDraft} disabled={Boolean(busy)} onChange={() => setEntireDraft(false)} /> This section
              </label>
              <label className="inline-check" title="Edit every section that has text and isn't marked written">
                <input type="checkbox" checked={entireDraft} disabled={Boolean(busy)} onChange={() => setEntireDraft(true)} /> Entire draft
              </label>
              </span>
            </span>
          )}
      </div>
      {skippedWritten > 0 && !busy && !proposals && <p className="small faint check-note">{skippedWritten} {skippedWritten === 1 ? "section" : "sections"} marked written will be left out. Reopen {skippedWritten === 1 ? "it" : "them"} to include {skippedWritten === 1 ? "it" : "them"}.</p>}
      {problem && <p className="small check-note" style={{ color: "var(--flag)" }} role="alert">{problem}</p>}
      {proposals && open.length === 0 && !problem && <p className="small check-note ok-text">Nothing to change: the text already reads like {voice?.name ?? "them"}.</p>}
      {open.map((p) => (
        <div key={p.sectionId} className="voice-proposal">
          <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <strong className="small">{p.heading}</strong>
            <span className="small muted">{p.edits.length} {p.edits.length === 1 ? "change" : "changes"}</span>
            <span className="spacer" />
            {p.edits.length > 1 && <button type="button" className="btn btn-small btn-primary" onClick={() => void accept(p, p.edits)}>Accept all</button>}
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setProposals((all) => all && all.map((x) => (x.sectionId === p.sectionId ? { ...x, edits: [] } : x)))}>Ignore all</button>
          </div>
          {p.reply && <p className="small muted" style={{ margin: 0 }}>{p.reply}</p>}
          <ul className="fixes">
            {p.edits.map((e, i) => (
              <li key={i}>
                <span className="stack" style={{ gap: 4 }}>
                  {e.reason && <strong className="small">{e.reason}</strong>}
                  <span><del>{e.original}</del> → <ins>{e.replacement}</ins></span>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-small" onClick={() => void accept(p, [e])}>Accept</button>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setProposals((all) => all && all.map((x) => (x.sectionId === p.sectionId ? { ...x, edits: x.edits.filter((y) => y !== e) } : x)))}>Ignore</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </li>
  );
}
