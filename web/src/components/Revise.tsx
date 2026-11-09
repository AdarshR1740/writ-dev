import { useState, type RefObject } from "react";
import { callFunction, errorMessage } from "../lib/supabase";
import type { RichEditorHandle } from "./RichEditor";

type Scope = "section" | "part" | "selection";

interface Edit {
  original: string;
  replacement: string;
  reason: string;
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/**
 * Revise a section from feedback, with the writer in control of how far the change reaches: the whole section, just the
 * part the cursor is in (from its heading to the next), or only the passage they selected. The AI proposes small edits
 * inside that scope, and the writer accepts or ignores each one. Nothing changes until an edit is accepted.
 */
export function RevisePanel({ sectionId, text, editor, onApply, onClose }: {
  sectionId: string;
  /** The section's text as it is now (Markdown). */
  text: string;
  editor: RefObject<RichEditorHandle | null>;
  /** The new text after edits were accepted. */
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const read = () => ({ selection: editor.current?.selection() ?? "", part: editor.current?.part() ?? null });
  // What the editor has selected, and the part the cursor is in, as of when the panel opened (or was refreshed).
  const [seen, setSeen] = useState(read);
  const [feedback, setFeedback] = useState("");
  const [scope, setScope] = useState<Scope>(() => (seen.selection ? "selection" : "section"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ reply: string; edits: Edit[] } | null>(null);

  const partOk = Boolean(seen.part && seen.part.markdown.trim() && seen.part.markdown.trim() !== text.trim());

  async function run() {
    setError(null);
    const now = read();
    const excerpt = scope === "selection" ? now.selection : scope === "part" ? (now.part?.markdown ?? "") : "";
    if (scope !== "section" && !excerpt.trim()) {
      setError(scope === "selection" ? "Select the passage in the text first, then press Revise again." : "Put the cursor in the part you want to change first.");
      return;
    }
    setSeen(now);
    // The selection and the part come from the editor in its own Markdown, so the text sent is the editor's version of
    // the same text: they then match exactly. If it differs from what is stored, the section is brought in line with it.
    const current = editor.current?.markdown() ?? text;
    if (current !== text) onApply(current);
    setBusy(true);
    try {
      const r = await callFunction<{ reply: string; edits: Edit[] }>("ai", { task: "section_revise", section_id: sectionId, text: current, feedback, scope, excerpt });
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const log = (n: number) => { void callFunction("ai", { task: "section_revise_log", section_id: sectionId, edits: n }).catch(() => {}); };
  // An edit can be applied only while its passage is in the text exactly once: if the text has changed since, so that the
  // passage is gone or appears elsewhere too, it is left out rather than applied in the wrong place.
  const occurrences = (original: string) => (original ? text.split(original).length - 1 : 0);
  const apply = (e: Edit) => {
    if (occurrences(e.original) !== 1) return;
    onApply(text.replace(e.original, () => e.replacement));
    setResult((r) => r && { ...r, edits: r.edits.filter((x) => x !== e) });
    log(1);
  };
  const applyAll = () => {
    if (!result) return;
    // Positions are found in the text as it is now and applied from the end, so one edit can't move another's place.
    const usable = result.edits
      .filter((e) => occurrences(e.original) === 1)
      .map((e) => ({ e, at: text.indexOf(e.original) }))
      .sort((a, b) => b.at - a.at);
    let next = text;
    let end = Infinity;
    let n = 0;
    for (const { e, at } of usable) {
      if (at + e.original.length > end) continue;
      next = `${next.slice(0, at)}${e.replacement}${next.slice(at + e.original.length)}`;
      end = at;
      n += 1;
    }
    if (n > 0) { onApply(next); log(n); }
    setResult({ ...result, edits: [] });
  };

  const choice = (value: Scope, label: string, detail?: string, disabled = false) => (
    <label className={`revise-scope${scope === value ? " on" : ""}${disabled ? " off" : ""}`}>
      <input type="radio" name="revise-scope" checked={scope === value} disabled={disabled} onChange={() => setScope(value)} />
      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
        <strong>{label}</strong>
        {detail && <span className="small muted">{detail}</span>}
      </span>
    </label>
  );

  return (
    <div className="revise-panel stack" style={{ gap: 12 }}>
      <div className="row" style={{ alignItems: "center" }}>
        <strong>Revise this section</strong>
        <span className="small muted">Say what should change. You choose how much of the text it may touch.</span>
        <span className="spacer" />
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose}>Close</button>
      </div>
      <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={busy}
        placeholder="For example: make the second point less technical, or add a short example of a failed campaign." aria-label="What should change" />
      <div className="revise-scopes" role="radiogroup" aria-label="How much may change">
        {choice("section", "The whole section", "The AI may change anything the feedback asks for, anywhere in it.")}
        {choice("part", partOk ? `The part I'm in: ${seen.part!.title}` : "The part I'm in", partOk ? "From its heading to the next one." : "Put the cursor in the part first.", !partOk)}
        {choice("selection", "The text I've selected", seen.selection ? `“${short(seen.selection)}”` : "Select a passage in the text first.", !seen.selection)}
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || !feedback.trim()} onClick={() => void run()}>
          {busy ? "Revising…" : "Suggest changes"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setSeen(read())}>Re-read my selection</button>
        {error && <span className="small" style={{ color: "var(--flag)" }}>{error}</span>}
      </div>
      {result && (
        <div className="stack" style={{ gap: 10 }}>
          {result.reply && <p className="small" style={{ margin: 0 }}>{result.reply}</p>}
          {result.edits.length === 0 && <p className="small muted" style={{ margin: 0 }}>No changes to accept.</p>}
          {result.edits.length > 1 && <div><button type="button" className="btn btn-small btn-primary" onClick={applyAll}>Accept all {result.edits.length} changes</button></div>}
          <ul className="fixes">
            {result.edits.map((e, i) => (
              <li key={i}>
                <span className="stack" style={{ gap: 4 }}>
                  {e.reason && <strong className="small">{e.reason}</strong>}
                  <span><del>{e.original}</del> → <ins>{e.replacement}</ins></span>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-small" disabled={occurrences(e.original) !== 1}
                    title={occurrences(e.original) !== 1 ? "The text has changed since this was suggested" : undefined} onClick={() => apply(e)}>Accept</button>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setResult({ ...result, edits: result.edits.filter((x) => x !== e) })}>Ignore</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
