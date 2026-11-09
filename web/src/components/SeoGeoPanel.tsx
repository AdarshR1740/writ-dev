import { useState } from "react";
import type { Block, Piece } from "../lib/types";
import { callFunction, errorMessage } from "../lib/supabase";
import { formatDate } from "../lib/format";
import { AiAction, CopyButton, ErrorText } from "./ui";

export interface SeoGeoResult {
  checked_at: string;
  /** `ignored`: the writer dismissed this issue, so Fix it and the re-check leave it alone. */
  checks: { area: "seo" | "geo"; check: string; label: string; status: "fine" | "improve" | "n/a"; evidence: string; fix: string; ignored?: boolean }[];
  meta_title?: string;
  meta_description?: string;
}

/** A revised outline the AI proposes to close the gaps. The writer reviews and saves it. */
export interface OutlineFix {
  reply: string;
  /** What the small changes did, counted. Nothing is ever removed. */
  summary?: { edited: number; added: number; moved: number; blocks: number };
  /** A new working title, when the fix changes it. */
  title?: string;
  /** The whole outline after the changes: every section it had, with the changes made. */
  sections: { heading: string; purpose: string; expectations: number[]; blocks: Block[] }[];
}

interface TextEdit {
  section_id: string;
  heading: string;
  where: "replace" | "start" | "end";
  original: string;
  replacement: string;
  check: string;
  reason: string;
}

/** SEO and GEO as a checklist with evidence and fixes. No score to chase. */
export function SeoGeoPanel({ piece, scope, result, disabled, reason, onDone, onFixOutline, fixBlocked, onEdited, hideRun, onClose, onIgnore, working, onFixBusy }: {
  piece: Piece;
  /** Outline scope: what Fix it is doing right now. While set, the panel shows an animation in place of the issues. */
  working?: string | null;
  /** Outline scope: told when the AI starts and stops working out the fix. */
  onFixBusy?: (busy: boolean) => void;
  /** Outline scope: ignore (or bring back) one issue by its check name. */
  onIgnore?: (check: string, ignored: boolean) => void;
  /** Outline scope: closes the panel (it is shown only after the writer runs the checks). */
  onClose?: () => void;
  /** The button that runs the check lives elsewhere (the outline puts it in its header), so don't draw one here. */
  hideRun?: boolean;
  scope: "outline" | "final";
  result: SeoGeoResult | null;
  disabled?: boolean;
  reason?: string;
  onDone: () => void;
  /** Outline scope: receives the AI's revised outline. */
  onFixOutline?: (fix: OutlineFix) => void;
  /** Why "Fix now" can't be used right now (for example, the outline is confirmed). */
  fixBlocked?: string;
  /** Final scope: called after an edit was applied to a section's text. */
  onEdited?: () => void;
}) {
  const improve = result?.checks.filter((c) => c.status === "improve").length ?? 0;
  const [edits, setEdits] = useState<{ reply: string; list: TextEdit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept(e: TextEdit) {
    setBusy(true);
    setError(null);
    try {
      await callFunction("ai", { task: "seo_fix_apply", section_id: e.section_id, where: e.where, original: e.original, replacement: e.replacement, check: e.check });
      setEdits((cur) => cur && { ...cur, list: cur.list.filter((x) => x !== e) });
      onEdited?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function acceptAll() {
    for (const e of edits?.list ?? []) {
      // Stop at the first failure so the rest stay listed.
      setBusy(true);
      setError(null);
      try {
        await callFunction("ai", { task: "seo_fix_apply", section_id: e.section_id, where: e.where, original: e.original, replacement: e.replacement, check: e.check });
        setEdits((cur) => cur && { ...cur, list: cur.list.filter((x) => x !== e) });
      } catch (err) {
        setError(errorMessage(err));
        setBusy(false);
        onEdited?.();
        return;
      }
    }
    setBusy(false);
    onEdited?.();
  }

  // On the outline the panel shows only what needs improving, with Fix it; what passed is one closed line.
  if (scope === "outline" && result) {
    const issues = result.checks.filter((c) => c.status === "improve" && !c.ignored);
    const ignoredIssues = result.checks.filter((c) => c.status === "improve" && c.ignored);
    const passed = result.checks.filter((c) => c.status === "fine");
    return (
      <section className="card stack" aria-label="SEO and GEO check" style={{ gap: 14 }}>
        <div className="row" style={{ alignItems: "center" }}>
          <div className="check-head">
            <strong>Search &amp; answer engines</strong>
            <span className="small muted">
              {issues.length > 0 ? `${issues.length} to improve` : "Nothing to improve."} · Checked {formatDate(result.checked_at)}
            </span>
          </div>
          <span className="spacer" />
          {issues.length > 0 && onFixOutline && (
            <AiAction<OutlineFix> label="Fix it" primary disabled={disabled || Boolean(fixBlocked) || Boolean(working)} reason={fixBlocked ?? reason}
              payload={{ task: "seo_fix", piece_id: piece.id, scope }} onDone={onFixOutline} onBusyChange={onFixBusy} />
          )}
          {onClose && <button type="button" className="btn btn-quiet btn-small" disabled={Boolean(working)} onClick={onClose}>Close</button>}
        </div>
        {working && (
          <div className="applying" role="status" aria-live="polite">
            <div className="applying-ring" aria-hidden="true"><span /></div>
            <strong>{working}</strong>
            <span className="small muted">This can take a minute.</span>
          </div>
        )}
        {!working && issues.length > 0 && (
          <ul className="finding-list">
            {issues.map((c) => (
              <li key={c.check} className="finding">
                <div className="row finding-top">
                  <span className="tag">{c.area === "seo" ? "SEO" : "GEO"}</span>
                  <strong>{c.label}</strong>
                  <span className="spacer" />
                  {onIgnore && <button type="button" className="btn btn-quiet btn-small" onClick={() => onIgnore(c.check, true)}>Ignore</button>}
                </div>
                {c.evidence && <p className="small muted" style={{ margin: 0 }}>{c.evidence}</p>}
                {c.fix && <p className="small" style={{ margin: 0 }}>{c.fix}</p>}
              </li>
            ))}
          </ul>
        )}
        {ignoredIssues.length > 0 && (
          <details className="small">
            <summary className="muted">{ignoredIssues.length} ignored</summary>
            <ul className="finding-list" style={{ marginTop: 8 }}>
              {ignoredIssues.map((c) => (
                <li key={c.check} className="finding is-ignored">
                  <div className="row finding-top">
                    <strong>{c.label}</strong>
                    <span className="spacer" />
                    {onIgnore && <button type="button" className="btn btn-quiet btn-small" onClick={() => onIgnore(c.check, false)}>Restore</button>}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
        {passed.length > 0 && (
          <details className="small">
            <summary className="muted">{passed.length} {passed.length === 1 ? "check" : "checks"} passed</summary>
            <ul className="stack" style={{ gap: 6, marginTop: 8, paddingLeft: 18 }}>
              {passed.map((c) => <li key={c.check}><strong>{c.label}</strong>{c.evidence ? <span className="muted"> — {c.evidence}</span> : null}</li>)}
            </ul>
          </details>
        )}
      </section>
    );
  }

  return (
    <section className="card stack" aria-label="SEO and GEO check">
      <div className="row">
        <div className="check-head">
          <strong>Search &amp; answer engines</strong>
          <span className="small muted">
            {scope === "outline"
              ? "Does the plan serve the search intent, and will sections be easy for AI answer engines to quote?"
              : "Search basics and what makes a piece citable by AI answer engines, plus a meta title and description."}
            {" "}A checklist with fixes, not a score.
          </span>
        </div>
        <span className="spacer" />
        {!hideRun && (
          <AiAction label={result ? "Check again" : "Run check"} primary={!result} disabled={disabled} reason={reason}
            payload={{ task: "seo_geo_check", piece_id: piece.id, scope }} onDone={onDone} />
        )}
      </div>
      {result && (
        <>
          <div className="row">
            <p className="small faint">Checked {formatDate(result.checked_at)} · {improve ? `${improve} to improve` : "nothing to improve"}</p>
            <span className="spacer" />
            {improve > 0 && scope === "outline" && onFixOutline && (
              <AiAction<OutlineFix> label="Fix now" primary disabled={disabled || Boolean(fixBlocked)} reason={fixBlocked ?? reason}
                payload={{ task: "seo_fix", piece_id: piece.id, scope }} onDone={onFixOutline} />
            )}
            {improve > 0 && scope === "final" && (
              <AiAction<{ reply: string; edits: TextEdit[] }> label="Fix now" primary disabled={disabled} reason={reason}
                payload={{ task: "seo_fix", piece_id: piece.id, scope }} onDone={(r) => { setError(null); setEdits({ reply: r.reply, list: r.edits }); }} />
            )}
          </div>
          {edits && (
            <div className="notice stack" style={{ gap: 8 }}>
              <p className="small">{edits.reply || "Suggested edits."} Nothing changes until you accept an edit. Accepted text is recorded in the editorial record as an AI-suggested edit.</p>
              {edits.list.length === 0 && <p className="small muted">No edit to accept. Some gaps can't be fixed by changing the text.</p>}
              {edits.list.length > 1 && (
                <div><button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={acceptAll}>Accept all {edits.list.length} edits</button></div>
              )}
              <ul className="fixes">
                {edits.list.map((e, i) => (
                  <li key={i}>
                    <span className="stack" style={{ gap: 4 }}>
                      <strong className="small">{e.heading} <span className="faint">· {e.reason || e.check}</span></strong>
                      {e.where === "replace"
                        ? <span><del>{e.original}</del> → <ins>{e.replacement}</ins></span>
                        : <span className="small">{e.where === "start" ? "Add at the start" : "Add at the end"}: <ins>{e.replacement}</ins></span>}
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button type="button" className="btn btn-small" disabled={busy} onClick={() => accept(e)}>Accept</button>
                      <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setEdits({ ...edits, list: edits.list.filter((x) => x !== e) })}>Ignore</button>
                    </span>
                  </li>
                ))}
              </ul>
              <ErrorText>{error}</ErrorText>
            </div>
          )}
          {(["seo", "geo"] as const).map((area) => (
            <div key={area} className="stack" style={{ gap: 6 }}>
              <h3>{area === "seo" ? "SEO" : "GEO"}</h3>
              <ul className="contract-results">
                {result.checks.filter((c) => c.area === area).map((c) => (
                  <li key={c.check} className={c.status === "improve" ? "partly" : ""}>
                    <span className={`tag ${c.status === "fine" ? "ok" : c.status === "improve" ? "flag" : ""}`}>{c.status}</span>
                    <div className="stack" style={{ gap: 4 }}>
                      <strong className="small">{c.label}</strong>
                      {c.evidence && <span className="small muted">{c.evidence}</span>}
                      {c.status === "improve" && c.fix && <span className="small">{c.fix}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {result.meta_title && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Meta</h3>
              <div className="row"><span className="small"><strong>Title</strong> ({result.meta_title.length}): {result.meta_title}</span><CopyButton text={result.meta_title} /></div>
              <div className="row"><span className="small"><strong>Description</strong> ({result.meta_description?.length ?? 0}): {result.meta_description}</span><CopyButton text={result.meta_description ?? ""} /></div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
