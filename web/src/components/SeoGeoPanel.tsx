import type { Piece } from "../lib/types";
import { formatDate } from "../lib/format";
import { AiAction, CopyButton } from "./ui";

export interface SeoGeoResult {
  checked_at: string;
  checks: { area: "seo" | "geo"; check: string; label: string; status: "fine" | "improve" | "n/a"; evidence: string; fix: string }[];
  meta_title?: string;
  meta_description?: string;
}

/** SEO and GEO as a checklist with evidence and fixes. No score to chase. */
export function SeoGeoPanel({ piece, scope, result, disabled, reason, onDone }: {
  piece: Piece;
  scope: "outline" | "final";
  result: SeoGeoResult | null;
  disabled?: boolean;
  reason?: string;
  onDone: () => void;
}) {
  const improve = result?.checks.filter((c) => c.status === "improve").length ?? 0;
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
          <p className="small faint">Checked {formatDate(result.checked_at)} · {improve ? `${improve} to improve` : "nothing to improve"}</p>
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
