import { useState } from "react";
import { Link } from "react-router-dom";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { useCompany } from "../lib/session";
import { bodyHtml, copyFormatted, docxBlob, documentHtml, download, fileName, markdown, type ExportPiece } from "../lib/exportDoc";
import type { Piece } from "../lib/types";
import { ErrorText } from "./ui";

type Kind = "docx" | "html" | "markdown" | "copy" | "wordpress";

/** Export a finished piece: Word, HTML, Markdown, formatted copy, or a WordPress draft. */
export function ExportPanel({ piece, sections, disclosure }: {
  piece: Piece;
  sections: { heading: string; content: string }[];
  disclosure: string;
}) {
  const company = useCompany();
  const { data } = useLoad(async () => {
    const [sources, target] = await Promise.all([
      supabase.from("research_items").select("sources(title, url, published)").eq("piece_id", piece.id).eq("status", "approved")
        .not("source_id", "is", null).then(must<{ sources: { title: string; url: string | null; published: string | null } | null }[]>),
      supabase.from("publishing_targets").select("site_url").eq("company_id", piece.company_id).eq("kind", "wordpress").maybeSingle()
        .then(({ data: t }) => t as { site_url: string } | null),
    ]);
    // One entry per source, in the order first approved.
    const seen = new Set<string>();
    const list = sources.flatMap((r) => (r.sources ? [r.sources] : [])).filter((s) => {
      const k = s.url ?? s.title;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { sources: list, target };
  }, [piece.id]);
  const [withSources, setWithSources] = useState(false);
  const [withDisclosure, setWithDisclosure] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [done, setDone] = useState<{ kind: Kind; link?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doc: ExportPiece = {
    title: piece.title,
    sections,
    sources: withSources ? data?.sources : undefined,
    disclosure: withDisclosure ? disclosure : null,
    metaTitle: piece.seo_geo_final?.meta_title ?? null,
    metaDescription: piece.seo_geo_final?.meta_description ?? null,
  };

  async function run(kind: Kind, fn: () => Promise<string | void>) {
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      const link = await fn();
      if (kind !== "wordpress") await supabase.rpc("record_export", { target_piece: piece.id, export_kind: kind });
      setDone({ kind, link: link ?? undefined });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const DONE: Record<Kind, string> = {
    docx: "Downloaded. Open it in Word, or upload it to Google Drive to edit it as a Google Doc.",
    html: "Downloaded.",
    markdown: "Downloaded.",
    copy: "Copied with formatting. Paste into Google Docs, WordPress, Webflow or any editor.",
    wordpress: "Sent to WordPress as a draft.",
  };

  return (
    <div className="card stack" style={{ padding: 16 }}>
      <h3>Export</h3>
      <div className="stack" style={{ gap: 6 }}>
        <label className="check-label small">
          <input type="checkbox" checked={withSources} onChange={(e) => setWithSources(e.target.checked)} disabled={!data?.sources.length} />
          <span>Add a sources list{data && !data.sources.length ? " (no web sources)" : data ? ` (${data.sources.length})` : ""}</span>
        </label>
        <label className="check-label small">
          <input type="checkbox" checked={withDisclosure} onChange={(e) => setWithDisclosure(e.target.checked)} />
          <span>Add the disclosure line</span>
        </label>
      </div>
      <div className="export-actions">
        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => run("copy", () => copyFormatted(doc))}>
          {busy === "copy" ? "Copying…" : "Copy formatted"}
        </button>
        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => run("docx", async () => download(await docxBlob(doc), fileName(piece.title, "docx")))}>
          {busy === "docx" ? "Preparing…" : "Word (.docx)"}
        </button>
        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => run("html", async () => download(new Blob([documentHtml(doc)], { type: "text/html" }), fileName(piece.title, "html")))}>HTML</button>
        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => run("markdown", async () => download(new Blob([markdown(doc)], { type: "text/markdown" }), fileName(piece.title, "md")))}>Markdown</button>
      </div>
      {data?.target ? (
        <button type="button" className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => run("wordpress", async () => {
          const r = await callFunction<{ edit_url: string }>("publish", {
            action: "wordpress_draft", piece_id: piece.id, title: doc.metaTitle || piece.title, html: bodyHtml(doc), excerpt: doc.metaDescription ?? "",
          });
          return r.edit_url;
        })}>
          {busy === "wordpress" ? "Sending…" : `Send to WordPress as a draft`}
        </button>
      ) : data && (
        <p className="small muted">
          {company.role === "editor" ? <>Publish to WordPress? <Link to="/team">Connect your site</Link> in Team &amp; settings.</> : "An editor can connect a WordPress site in Team & settings."}
        </p>
      )}
      {done && (
        <p className="small ok-text" role="status">
          {DONE[done.kind]} {done.link && <a href={done.link} target="_blank" rel="noreferrer">Open the draft</a>}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
