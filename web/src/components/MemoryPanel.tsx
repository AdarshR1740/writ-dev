import { Link } from "react-router-dom";
import type { Piece } from "../lib/types";
import { formatDate } from "../lib/format";
import { AiAction } from "./ui";

export interface MemoryFlag {
  kind: "contradiction" | "repeat" | "link";
  sentence: string;
  found_in_piece: boolean;
  note: string;
  earlier: { label: string; title: string; path: string; excerpt: string };
}
export interface MemoryResult {
  checked_at: string;
  flags: MemoryFlag[];
  compared: { label: string; title: string; path: string }[];
}

const KIND: Record<MemoryFlag["kind"], { label: string; tag: string }> = {
  contradiction: { label: "Contradicts", tag: "flag" },
  repeat: { label: "Repeats", tag: "flag" },
  link: { label: "Could link to", tag: "pencil" },
};

/** This piece against what the company has already published: contradictions, repeats and links. */
export function MemoryPanel({ piece, disabled, reason, onDone }: { piece: Piece; disabled?: boolean; reason?: string; onDone: () => void }) {
  const result = piece.memory_check;
  return (
    <section className="card stack" aria-label="Against what you've published">
      <div className="row">
        <div className="check-head">
          <strong>Against what you've published</strong>
          <span className="small muted">Contradictions, repeated angles and earlier pieces worth linking. Compared with your finished pieces and their research.</span>
        </div>
        <span className="spacer" />
        <AiAction label={result ? "Check again" : "Run check"} primary={!result} disabled={disabled} reason={reason}
          payload={{ task: "memory_check", piece_id: piece.id }} onDone={onDone} />
      </div>
      {result && (
        <>
          <p className="small faint">
            Checked {formatDate(result.checked_at)} against {result.compared.length ? result.compared.map((c, i) => (
              <span key={c.path}>{i > 0 && ", "}<Link to={c.path}>{c.label}</Link></span>
            )) : "your published pieces"}.
          </p>
          {result.flags.length === 0 ? <p className="small ok-text">No contradictions or repeats found.</p> : (
            <ul className="memory-flags">
              {result.flags.map((f, i) => (
                <li key={i} className={f.kind}>
                  <span className={`tag ${KIND[f.kind].tag}`}>{KIND[f.kind].label}</span>
                  <q>{f.sentence}</q>
                  {!f.found_in_piece && <span className="small flag-text">This sentence isn't word for word in the piece; find the matching passage yourself.</span>}
                  <span className="small">{f.note}</span>
                  <div className="memory-earlier">
                    <Link to={f.earlier.path} className="small"><span className="id">{f.earlier.label}</span> {f.earlier.title}</Link>
                    <q>{f.earlier.excerpt}</q>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
