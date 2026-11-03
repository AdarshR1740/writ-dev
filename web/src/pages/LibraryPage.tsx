import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { supabase, errorMessage } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import type { Source } from "../lib/types";
import { ErrorText, Loading, Lede } from "../components/ui";

export function LibraryPage() {
  const company = useCompany();
  const { data, error, reload } = useLoad(
    async () => must<Source[]>(await supabase.from("sources").select("id, url, title, published, origin, in_library, tags, last_checked, snapshot")
      .eq("company_id", company.id).eq("in_library", true).order("created_at", { ascending: false })),
    [company.id],
  );
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  async function update(id: string, patch: Partial<Source>) {
    try {
      must(await supabase.from("sources").update(patch).eq("id", id).select("id"));
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">{company.name}</span>
        <h1>Source library</h1>
        <Lede more={<>When a new piece's research starts, library sources whose title or tags match it are suggested, and findings are pulled fresh from the saved copy for that piece.</>}>Sources you chose to keep.</Lede>
      </div>
      <ErrorText>{error ?? actionError}</ErrorText>
      {!data ? <Loading /> : data.length === 0 ? (
        <EmptyState icon="bookmark" title="Your library is empty">
          <p>Sources you want to use again live here. During research, choose "Add source to library" on a finding worth keeping; later pieces on the same topic will suggest it.</p>
        </EmptyState>
      ) : (
        <div className="card-list">
          {data.map((s) => (
            <article key={s.id} className="insight">
              <div className="row">
                <strong>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a> : s.title}</strong>
                <span className="spacer" />
                <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => update(s.id, { in_library: false })}>Remove from library</button>
              </div>
              <div className="meta">
                {s.published && <span>{s.published} ·</span>}
                <span>last checked {formatDate(s.last_checked)}</span>
                {!s.snapshot && <span className="tag flag">no saved text</span>}
                {s.tags.map((t) => <span key={t} className="tag">{t}</span>)}
              </div>
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                const tags = (tagDraft[s.id] ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
                update(s.id, { tags: [...new Set([...s.tags, ...tags])] });
                setTagDraft({ ...tagDraft, [s.id]: "" });
              }}>
                <input type="text" value={tagDraft[s.id] ?? ""} onChange={(e) => setTagDraft({ ...tagDraft, [s.id]: e.target.value })}
                  placeholder="Add tags, comma-separated" aria-label="Add tags" style={{ flex: 1 }} />
                <button type="submit" className="btn btn-small">Add tags</button>
              </form>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
