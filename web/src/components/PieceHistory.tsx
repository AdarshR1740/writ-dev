import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatDate, plural } from "../lib/format";
import type { Piece, PieceLink, ResearchItem } from "../lib/types";
import { SOURCE_TYPE_LABELS } from "../lib/types";
import { ErrorText, Loading, Modal } from "./ui";

const KIND_LABEL: Record<PieceLink["kind"], [string, string]> = {
  revision: ["Revision of", "Revised as"],
  split: ["Split from", "Split into"],
  adapt: ["Adapted from", "Adapted into"],
  combine: ["Combined from", "Combined into"],
};

type Mini = Pick<Piece, "id" | "code" | "version" | "title" | "stage">;

/** Where this piece came from, what was made from it, and its versions. */
export function LineagePanel({ piece }: { piece: Piece }) {
  const { data } = useLoad(async () => {
    const links = must<PieceLink[]>(await supabase.from("piece_links").select("from_piece, to_piece, kind, created_at")
      .or(`from_piece.eq.${piece.id},to_piece.eq.${piece.id}`));
    const versions = must<Mini[]>(await supabase.from("pieces").select("id, code, version, title, stage")
      .eq("company_id", piece.company_id).eq("code", piece.code).order("version"));
    const ids = [...new Set(links.flatMap((l) => [l.from_piece, l.to_piece]))].filter((x) => x !== piece.id);
    const others = ids.length
      ? must<Mini[]>(await supabase.from("pieces").select("id, code, version, title, stage").in("id", ids))
      : [];
    // Newer finished versions of the pieces this one was made from.
    const sourceIds = links.filter((l) => l.to_piece === piece.id && l.kind !== "revision").map((l) => l.from_piece);
    const sourceCodes = [...new Set(others.filter((o) => sourceIds.includes(o.id)).map((o) => o.code))];
    const newer = sourceCodes.length
      ? must<Mini[]>(await supabase.from("pieces").select("id, code, version, title, stage").eq("company_id", piece.company_id)
        .in("code", sourceCodes).eq("stage", "done"))
      : [];
    return { links, versions, others, sourceIds, newer };
  }, [piece.id]);

  if (!data) return null;
  const byId = (id: string) => data.others.find((o) => o.id === id);
  const updatedSources = data.sourceIds.map(byId).filter((s): s is Mini => Boolean(s)).flatMap((s) => {
    const latest = data.newer.filter((n) => n.code === s.code && n.version > s.version).sort((a, b) => b.version - a.version)[0];
    return latest ? [{ from: s, latest }] : [];
  });
  const incoming = data.links.filter((l) => l.to_piece === piece.id && l.kind !== "revision");
  const outgoing = data.links.filter((l) => l.from_piece === piece.id && l.kind !== "revision");
  if (data.versions.length < 2 && incoming.length === 0 && outgoing.length === 0) return null;
  const banner = updatedSources.length > 0 && !piece.revised_by && (
    <p className="notice small">
      {updatedSources.map(({ from, latest }) => (
        <span key={from.id}>
          This piece was made from <Link to={`/pieces/${from.id}`}>{from.code} v{from.version}</Link>, which now has a newer
          version (<Link to={`/pieces/${latest.id}`}>v{latest.version}</Link>). Compare them under History, and revise this piece if it
          repeats something that changed.{" "}
        </span>
      ))}
    </p>
  );

  const ref = (p: Mini | undefined) => p && <Link key={p.id} to={`/pieces/${p.id}`} className="tag ref pencil">{p.code} v{p.version}</Link>;
  return (
    <>
    {banner}
    <div className="lineage small">
      {data.versions.length > 1 && (
        <span className="row" style={{ gap: 4 }}>
          Versions:
          {data.versions.map((v) => v.id === piece.id
            ? <span key={v.id} className="tag ref current" aria-current="page">v{v.version} (this)</span>
            : <Link key={v.id} to={`/pieces/${v.id}`} className="tag ref pencil">v{v.version}</Link>)}
        </span>
      )}
      {(["split", "adapt", "combine"] as const).map((k) => {
        const inc = incoming.filter((l) => l.kind === k);
        const out = outgoing.filter((l) => l.kind === k);
        return (
          <span key={k} className="row" style={{ gap: 4 }}>
            {inc.length > 0 && <>{KIND_LABEL[k][0]} {inc.map((l) => ref(byId(l.from_piece)))}</>}
            {out.length > 0 && <>{KIND_LABEL[k][1]} {out.map((l) => ref(byId(l.to_piece)))}</>}
          </span>
        );
      })}
    </div>
    </>
  );
}

/** Revise a finished piece: choose the workflow and what research carries over. */
export function ReviseDialog({ piece, onClose }: { piece: Piece; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: items } = useLoad(async () => must<ResearchItem[]>(await supabase.from("research_items")
    .select("*, sources(id, url, title, published, in_library)").eq("piece_id", piece.id).eq("status", "approved").order("created_at")), [piece.id]);
  const [useCurrent, setUseCurrent] = useState(false);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={`Revise ${piece.code} v${piece.version}`} onClose={onClose}>
      <p className="small muted">
        This version stays as it is, tagged "Revised" and linked to v{piece.version + 1}. The new version starts with this
        version's contract, outline and text for you to edit.
      </p>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <span>Workflow</span>
        <label className="check-label small"><input type="radio" checked={!useCurrent} onChange={() => setUseCurrent(false)} /> The workflow this version followed</label>
        <label className="check-label small"><input type="radio" checked={useCurrent} onChange={() => setUseCurrent(true)} disabled={!piece.format_id} /> The format's current workflow{!piece.format_id && " (this piece has no format)"}</label>
      </fieldset>
      <div className="stack" style={{ gap: 6 }}>
        <span className="small muted">Research to carry over (stays approved). Untick anything that's out of date.</span>
        {!items ? <Loading /> : items.length === 0 ? <p className="small faint">No approved research.</p> : (
          <ul className="carry-list">
            {items.map((i) => (
              <li key={i.id}>
                <label className="check-label small">
                  <input type="checkbox" checked={!dropped.has(i.id)} onChange={() => setDropped((d) => { const n = new Set(d); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} />
                  <span>{i.statement} <span className="faint">({SOURCE_TYPE_LABELS[i.source_type]}{i.sources?.published ? `, ${i.sources.published}` : ""})</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !items} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const carry = (items ?? []).filter((i) => !dropped.has(i.id)).map((i) => i.id);
            const { data, error: err } = await supabase.rpc("revise_piece", { source_piece: piece.id, use_current_recipe: useCurrent, carry });
            if (err) throw err;
            navigate(`/pieces/${data}`);
            onClose();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}>
          Start v{piece.version + 1}{items ? ` with ${plural((items.length - dropped.size), "item")}` : ""}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Review-due state for a finished piece. */
export function ReviewDue({ piece, onChanged }: { piece: Piece; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (piece.stage !== "done" || !piece.review_due_at || piece.revised_by) return null;
  // Not due yet: the next review date sits in the page's meta line, not in a banner.
  if (new Date(piece.review_due_at) > new Date()) return null;
  return (
    <div className="notice small row" style={{ gap: 8 }}>
      <span>Review due since {formatDate(piece.review_due_at)}. Is it still accurate?</span>
      {(
        <button type="button" className="btn btn-small" onClick={async () => {
          const { error: err } = await supabase.rpc("mark_reviewed", { target_piece: piece.id, note: "" });
          if (err) setError(err.message); else onChanged();
        }}>Still accurate</button>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
