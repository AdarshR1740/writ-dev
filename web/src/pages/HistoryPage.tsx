import { useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import { STAGES, type Piece, type PieceLink, type Section } from "../lib/types";
import { Redline } from "../components/Redline";
import { ErrorText, Loading, Modal, Tabs, Lede } from "../components/ui";

type Row = Pick<Piece, "id" | "code" | "version" | "title" | "stage" | "revised_by" | "review_due_at" | "updated_at" | "format_id">;
type Filter = "all" | "due" | "progress";

/** All content by ID: versions, where it came from, what was made from it, and what's due for review. */
export function HistoryPage() {
  const company = useCompany();
  const { data, error } = useLoad(async () => {
    const [pieces, links, formats] = await Promise.all([
      supabase.from("pieces").select("id, code, version, title, stage, revised_by, review_due_at, updated_at, format_id")
        .eq("company_id", company.id).order("updated_at", { ascending: false }).then(must<Row[]>),
      supabase.from("piece_links").select("from_piece, to_piece, kind, created_at").eq("company_id", company.id).then(must<PieceLink[]>),
      supabase.from("formats").select("id, name").eq("company_id", company.id).then(must<{ id: string; name: string }[]>),
    ]);
    return { pieces, links, formats };
  }, [company.id]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [compare, setCompare] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byCode = new Map<string, Row[]>();
    for (const p of data?.pieces ?? []) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p]);
    const today = new Date();
    return [...byCode.entries()].map(([code, versions]) => {
      versions.sort((a, b) => b.version - a.version);
      const latest = versions[0];
      const due = versions.some((v) => v.stage === "done" && !v.revised_by && v.review_due_at && new Date(v.review_due_at) <= today);
      return { code, versions, latest, due };
    }).filter((g) => (filter === "due" ? g.due : filter === "progress" ? g.latest.stage !== "done" : true))
      .filter((g) => !query.trim() || `${g.code} ${g.latest.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  }, [data, filter, query]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const dueCount = groups.filter((g) => g.due).length;

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow">{company.name}</span>
        <h1>History</h1>
        <Lede more={<>Finished pieces come up for review on a schedule; revise them or confirm they're still accurate.</>}>Every piece by its ID, with its versions and what was made from it.</Lede>
      </div>
      {data.pieces.length > 0 && <div className="toolbar">
        <Tabs value={filter} onChange={setFilter} options={[
          { value: "all", label: "All" },
          { value: "due", label: `Review due${filter !== "due" && dueCount ? ` (${dueCount})` : ""}` },
          { value: "progress", label: "In progress" },
        ]} />
        <span className="spacer" />
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by ID or title" aria-label="Search" />
        <Link to="/repurpose/new?shape=combine" className="btn">Combine pieces…</Link>
      </div>}
      {groups.length === 0 ? (
        data.pieces.length === 0
          ? <EmptyState icon="clock" title="No history yet" actions={<Link to="/pieces" className="btn btn-primary">Start writing</Link>}>
              <p>Every piece gets an ID and keeps its versions here, with what it came from and what was made from it. Finished pieces come up for review on a schedule.</p>
            </EmptyState>
          : <EmptyState icon="clock" title="Nothing matches"><p>Try another search, or switch the filter back to All.</p></EmptyState>
      ) : (
        <table className="plain history">
          <thead><tr><th>ID</th><th>Title</th><th>Format</th><th>Versions</th><th>Came from / made into</th><th>Review</th></tr></thead>
          <tbody>
            {groups.map((g) => {
              const ids = g.versions.map((v) => v.id);
              const from = data.links.filter((l) => ids.includes(l.to_piece) && l.kind !== "revision");
              const into = data.links.filter((l) => ids.includes(l.from_piece) && l.kind !== "revision");
              // Made from a version that has since been revised.
              const sourceUpdated = !g.latest.revised_by && from.some((l) => data.pieces.find((p) => p.id === l.from_piece)?.revised_by);
              return (
                <tr key={g.code}>
                  <td className="id cell-id">{g.code}</td>
                  <td className="cell-title">
                    <Link to={`/pieces/${g.latest.id}`}><strong>{g.latest.title}</strong></Link>
                    <div className="small faint">{STAGES.find((s) => s.key === g.latest.stage)?.label} · updated {formatDate(g.latest.updated_at)}</div>
                  </td>
                  <td className="small" data-label="Format">{data.formats.find((f) => f.id === g.latest.format_id)?.name ?? "—"}</td>
                  <td data-label="Versions">
                    <div className="row" style={{ gap: 4 }}>
                      {[...g.versions].reverse().map((v) => (
                        <Link key={v.id} to={`/pieces/${v.id}`} className={`tag ref${v.revised_by ? " pencil" : " current"}`} title={v.revised_by ? "Revised" : "Current version"}>v{v.version}</Link>
                      ))}
                      {g.versions.length > 1 && <button type="button" className="btn btn-quiet btn-small" onClick={() => setCompare(g.code)}>Compare</button>}
                    </div>
                  </td>
                  <td className="small" data-label="Came from / made into">
                    <div className="stack" style={{ gap: 4 }}>
                    <Related links={from} dir="from" pieces={data.pieces} />
                    <Related links={into} dir="into" pieces={data.pieces} />
                    {!from.length && !into.length && <span className="faint">—</span>}
                    {sourceUpdated && <span className="tag flag" title="A source of this piece has a newer version">source updated</span>}
                    </div>
                  </td>
                  <td className="small" data-label="Review">
                    <div>{g.due ? <span className="tag flag">due</span> : g.versions.find((v) => !v.revised_by && v.review_due_at)
                      ? formatDate(g.versions.find((v) => !v.revised_by && v.review_due_at)!.review_due_at!) : <span className="faint">—</span>}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {compare && <CompareVersions versions={data.pieces.filter((p) => p.code === compare).sort((a, b) => a.version - b.version)} onClose={() => setCompare(null)} />}
    </div>
  );
}

const KIND_WORD: Record<string, [string, string]> = {
  split: ["Split from", "Split into"],
  adapt: ["Adapted from", "Adapted into"],
  combine: ["Combined from", "Combined into"],
};

/** One line per kind of link: a single piece is a link; several fold into a count that opens the list. */
function Related({ links, dir, pieces }: { links: PieceLink[]; dir: "from" | "into"; pieces: Row[] }) {
  const kinds = [...new Set(links.map((l) => l.kind))];
  return (
    <>
      {kinds.map((kind) => {
        const targets = links.filter((l) => l.kind === kind)
          .map((l) => pieces.find((p) => p.id === (dir === "from" ? l.from_piece : l.to_piece)))
          .filter((p): p is Row => Boolean(p));
        const word = (KIND_WORD[kind] ?? [kind, kind])[dir === "from" ? 0 : 1];
        const item = (p: Row) => <Link key={p.id} to={`/pieces/${p.id}`} className="id" title={p.title}>{p.code}</Link>;
        if (targets.length === 1) return <div key={kind} className="related"><span className="faint">{word}</span> {item(targets[0])}</div>;
        return (
          <details key={kind} className="related">
            <summary><span className="faint">{word}</span> {targets.length} pieces</summary>
            <ul>{targets.map((p) => <li key={p.id}>{item(p)}</li>)}</ul>
          </details>
        );
      })}
    </>
  );
}

function CompareVersions({ versions, onClose }: { versions: Row[]; onClose: () => void }) {
  const [a, setA] = useState(versions[versions.length - 2]?.id ?? versions[0].id);
  const [b, setB] = useState(versions[versions.length - 1].id);
  const { data } = useLoad(async () => {
    const text = async (id: string) => must<Pick<Section, "heading" | "content">[]>(await supabase.from("piece_sections")
      .select("heading, content").eq("piece_id", id).order("position")).map((s) => `## ${s.heading}\n\n${s.content.trim()}`).join("\n\n");
    return { before: await text(a), after: await text(b) };
  }, [a, b]);
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <label className="field" style={{ flex: 1 }}>
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}{v.revised_by ? " (revised)" : ""}</option>)}
      </select>
    </label>
  );
  return (
    <Modal title={`Compare versions of ${versions[0].code}`} onClose={onClose}>
      <div className="row">{pick(a, setA, "From")}{pick(b, setB, "To")}</div>
      {!data ? <Loading /> : <div className="redline"><Redline before={data.before} after={data.after} /></div>}
    </Modal>
  );
}
