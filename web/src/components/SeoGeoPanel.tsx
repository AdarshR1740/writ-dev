import { useState } from "react";
import type { Block, Piece } from "../lib/types";
import { callFunction, errorMessage } from "../lib/supabase";
import { formatDate } from "../lib/format";
import { AiAction, CopyButton, ErrorText } from "./ui";

export interface SeoGeoResult {
  checked_at: string;
  checks: { area: "seo" | "geo"; check: string; label: string; status: "fine" | "improve" | "n/a"; evidence: string; fix: string }[];
  meta_title?: string;
  meta_description?: string;
}

/** A revised outline the AI proposes to close the gaps. The writer reviews and saves it. */
export interface OutlineFix {
  reply: string;
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
export function SeoGeoPanel({ piece, scope, result, disabled, reason, onDone, onFixOutline, onEdited }: {
  piece: Piece;
  scope: "outline" | "final";
  result: SeoGeoResult | null;
  disabled?: boolean;
  reason?: string;
  onDone: () => void;
  /** Outline scope: receives the AI's revised outline. */
  onFixOutline?: (fix: OutlineFix) => void;
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
        <AiAction label={result ? "Check again" : "Run check"} primary={!result} disabled={disabled} reason={reason}
          payload={{ task: "seo_geo_check", piece_id: piece.id, scope }} onDone={onDone} />
      </div>
      {result && (
        <>
          <div className="row">
            <p className="small faint">Checked {formatDate(result.checked_at)} · {improve ? `${improve} to improve` : "nothing to improve"}</p>
            <span className="spacer" />
            {improve > 0 && scope === "outline" && onFixOutline && (
              <AiAction<OutlineFix> label="Fix with AI" primary={false} disabled={disabled} reason={reason}
                payload={{ task: "seo_fix", piece_id: piece.id, scope }} onDone={onFixOutline} />
            )}
            {improve > 0 && scope === "final" && (
              <AiAction<{ reply: string; edits: TextEdit[] }> label="Suggest edits with AI" primary={false} disabled={disabled} reason={reason}
                payload={{ task: "seo_fix", piece_id: piece.id, scope }} onDone={(r) => { setError(null); setEdits({ reply: r.reply, list: r.edits }); }} />
            )}
          </div>
          {edits && (
            <div className="notice stack" style={{ gap: 8 }}>
              <p className="small">{edits.reply || "Suggested edits."} Nothing changes until you accept an edit. Accepted text is recorded in the editorial record as an AI-suggested edit.</p>
              {edits.list.length === 0 && <p className="small muted">No edit to accept. Some gaps can't be fixed by changing the text.</p>}
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
