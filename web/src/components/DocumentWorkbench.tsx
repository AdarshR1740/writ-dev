import { useState } from "react";
import { supabase, errorMessage } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatDate, plural } from "../lib/format";
import type { InputMethod } from "../lib/sections";
import type { ContextDocument, ContextInput, Proposal } from "../lib/types";
import { AddMaterial } from "./AddMaterial";
import { diffStats, Redline } from "./Redline";
import { AiAction, ErrorText, Loading } from "./ui";

interface Loaded {
  doc: ContextDocument;
  inputs: ContextInput[];
  proposal: Proposal | null;
}

async function load(documentId: string): Promise<Loaded> {
  const [doc, inputs, proposals] = await Promise.all([
    supabase.from("context_documents").select("*").eq("id", documentId).single().then(must<ContextDocument>),
    supabase.from("context_inputs").select("*").eq("document_id", documentId).order("created_at", { ascending: false })
      .then(must<ContextInput[]>),
    supabase.from("document_proposals").select("*").eq("document_id", documentId).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1).then(must<Proposal[]>),
  ]);
  return { doc, inputs, proposal: proposals[0] ?? null };
}

/**
 * One context document: the consolidated text, the raw material behind it,
 * and AI merges shown as a redline to accept, edit or reject.
 */
export function DocumentWorkbench({
  documentId,
  companyId,
  methods,
  placeholder,
  onChanged,
}: {
  documentId: string;
  companyId: string;
  methods: InputMethod[];
  placeholder: string;
  onChanged?: () => void;
}) {
  const { data, error, loading, reload } = useLoad(() => load(documentId), [documentId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [reviewEdit, setReviewEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorText>{error ?? "Couldn't load this document."}</ErrorText>;
  const { doc, inputs, proposal } = data;
  const unmerged = inputs.filter((i) => !i.merged_at);
  const stale = proposal && proposal.base_version !== doc.version;

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
      onChanged?.();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const saveEdit = () =>
    act(async () => {
      must(await supabase.from("context_documents").update({ content: editing }).eq("id", doc.id).select("id"));
      setEditing(null);
    });

  const accept = () =>
    act(async () => {
      const { error: rpcError } = await supabase.rpc("accept_proposal", {
        proposal_id: proposal!.id,
        final_content: reviewEdit ?? proposal!.proposed_content,
      });
      if (rpcError) throw new Error(rpcError.message);
      setReviewEdit(null);
    });

  const reject = () =>
    act(async () => {
      must(await supabase.from("document_proposals").update({ status: "rejected" }).eq("id", proposal!.id).select("id"));
      setReviewEdit(null);
    });

  const removeInput = (id: string) =>
    act(async () => {
      must(await supabase.from("context_inputs").delete().eq("id", id).select("id"));
    });

  const [summary, ...conflicts] = (proposal?.summary ?? "").split("\n");
  const stats = proposal ? diffStats(doc.content, proposal.proposed_content) : null;

  return (
    <div className="workbench">
      <div className="stack-lg">
        {proposal ? (
          <section className="redline" aria-label="Proposed changes">
            <header>
              <div className="row">
                <span className="tag pencil">Proposed merge</span>
                {stats && <span className="small muted">+{stats.added} / −{stats.removed} words</span>}
              </div>
              {summary && <p>{summary}</p>}
              {conflicts.length > 0 && (
                <ul className="conflicts">
                  {conflicts.map((c, i) => <li key={i}>{c.replace(/^Conflict: /, "")}</li>)}
                </ul>
              )}
              {stale && (
                <p className="notice">The document was edited after this was proposed. Reject it and merge again.</p>
              )}
            </header>
            {reviewEdit === null ? (
              <Redline before={doc.content} after={proposal.proposed_content} />
            ) : (
              <textarea className="doc" value={reviewEdit} onChange={(e) => setReviewEdit(e.target.value)} aria-label="Edit before accepting" />
            )}
            <footer>
              <button type="button" className="btn btn-primary" onClick={accept} disabled={busy || Boolean(stale)}>
                {reviewEdit === null ? "Accept changes" : "Accept edited version"}
              </button>
              {reviewEdit === null ? (
                <button type="button" className="btn" onClick={() => setReviewEdit(proposal.proposed_content)} disabled={busy}>
                  Edit before accepting
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => setReviewEdit(null)} disabled={busy}>Show changes</button>
              )}
              <span className="spacer" />
              <button type="button" className="btn btn-quiet btn-danger" onClick={reject} disabled={busy}>Reject</button>
            </footer>
          </section>
        ) : (
          <section className="doc-surface" aria-label="Document">
            <header>
              <span className="small muted">
                {doc.version === 0 && !doc.content ? "Empty" : `Version ${doc.version} · updated ${formatDate(doc.updated_at)}`}
              </span>
              <span className="spacer" />
              {editing === null ? (
                <button type="button" className="btn btn-small" onClick={() => setEditing(doc.content)}>Edit</button>
              ) : (
                <>
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                  <button type="button" className="btn btn-small btn-primary" onClick={saveEdit} disabled={busy}>Save</button>
                </>
              )}
            </header>
            {editing !== null ? (
              <textarea className="doc" value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Document text" autoFocus />
            ) : doc.content ? (
              <div className="doc-render">{doc.content}</div>
            ) : (
              <div className="doc-empty">
                <p>Nothing here yet.</p>
                <p className="small">Add material on the right, then merge it. Or write it yourself with Edit.</p>
              </div>
            )}
          </section>
        )}
        <ErrorText>{actionError}</ErrorText>
      </div>

      <aside className="rail" aria-label="Sources">
        <AddMaterial companyId={companyId} documentId={doc.id} methods={methods} placeholder={placeholder} onAdded={reload} />
        <div className="row">
          <h3>Sources</h3>
          <span className="spacer" />
          <span className="small faint">{plural(inputs.length, "source")}</span>
        </div>
        {unmerged.length > 0 && !proposal && (
          <div className="card stack" style={{ padding: 14 }}>
            <p className="small">{plural(unmerged.length, "source")} not merged yet. AI will fold them into the document and show you every change first.</p>
            <AiAction<{ proposal: Proposal }>
              label="Merge into document"
              payload={{ task: "consolidate", document_id: doc.id }}
              onDone={() => reload()}
            />
          </div>
        )}
        {inputs.length === 0 && <p className="small muted">No sources yet.</p>}
        {inputs.map((i) => (
          <div key={i.id} className={`source${i.merged_at ? "" : " unmerged"}`}>
            <div className="row" style={{ gap: 6 }}>
              <span className="tag">{i.origin}</span>
              {!i.merged_at && <span className="tag pencil">not merged</span>}
              <span className="spacer" />
              <button type="button" className="btn btn-quiet btn-small" onClick={() => removeInput(i.id)} disabled={busy} aria-label={`Remove ${i.label}`}>
                Remove
              </button>
            </div>
            <strong className="small">
              {i.source_url ? <a href={i.source_url} target="_blank" rel="noreferrer">{i.label}</a> : i.label}
            </strong>
            <p className="excerpt">{i.content}</p>
          </div>
        ))}
      </aside>
    </div>
  );
}
