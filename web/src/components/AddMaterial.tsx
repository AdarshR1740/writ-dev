import { useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { ACCEPTED_FILES, readFileText } from "../lib/files";
import type { InputMethod, MaterialCopy } from "../lib/sections";
import { MAX_LINKS, parseLinks } from "../lib/links";
import { plural } from "../lib/format";
import { ErrorText, Tabs, CleanTextarea } from "./ui";

interface FetchResult {
  ok: boolean;
  paste?: boolean;
  reason?: string;
  redirect?: string | null;
  url?: string;
  title?: string;
  text?: string;
}

const LABELS: Record<InputMethod, string> = { paste: "Paste text", upload: "Upload files", url: "Paste links" };

/** Adds raw material (pasted text, files, web pages) to a context document. */
export function AddMaterial({
  companyId,
  documentId,
  methods,
  copy,
  onAdded,
}: {
  companyId: string;
  documentId: string;
  methods: InputMethod[];
  copy: MaterialCopy;
  onAdded: () => void;
}) {
  const [method, setMethod] = useState<InputMethod>(methods[0]);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [links, setLinks] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function save(rows: { origin: InputMethod; label: string; content: string; source_url?: string }[]) {
    const { data: auth } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from("context_inputs").insert(
      rows.map((r) => ({ ...r, company_id: companyId, document_id: documentId, created_by: auth.user?.id })),
    );
    if (insertError) throw new Error(insertError.message);
    onAdded();
  }

  async function addPaste() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await save([{ origin: "paste", label: label.trim() || "Pasted text", content: text.trim() }]);
      setText("");
      setLabel("");
      setNote(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    const problems: string[] = [];
    const rows: { origin: InputMethod; label: string; content: string }[] = [];
    for (const file of Array.from(files)) {
      try {
        const content = await readFileText(file);
        if (content) rows.push({ origin: "upload", label: file.name, content });
        else problems.push(`${file.name} is empty.`);
      } catch (err) {
        problems.push(errorMessage(err));
      }
    }
    try {
      if (rows.length) await save(rows);
    } catch (err) {
      problems.push(errorMessage(err));
    }
    setError(problems.join(" ") || null);
    setBusy(false);
  }

  // One link per line. Each page is fetched on its own so one blocked site doesn't stop the rest.
  async function addLinks() {
    const batch = parseLinks(links).slice(0, MAX_LINKS);
    if (!batch.length) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const rows: { origin: InputMethod; label: string; content: string; source_url?: string }[] = [];
    const missed: { url: string; reason: string }[] = [];
    for (const [i, link] of batch.entries()) {
      setProgress(`Fetching ${i + 1} of ${batch.length}…`);
      try {
        const res = await callFunction<FetchResult>("fetch-url", { company_id: companyId, url: link });
        if (res.ok && res.text) rows.push({ origin: "url", label: res.title || res.url || link, content: res.text, source_url: res.url ?? link });
        else missed.push({ url: link, reason: res.reason ?? "Couldn't fetch that page." });
      } catch (err) {
        missed.push({ url: link, reason: errorMessage(err) });
      }
    }
    try {
      if (rows.length) await save(rows);
      setLinks(missed.map((m) => m.url).join("\n"));
      if (missed.length) {
        setNote(`${plural(rows.length, "link")} added. ${plural(missed.length, "link")} couldn't be fetched and ${missed.length === 1 ? "is" : "are"} left in the box; paste ${missed.length === 1 ? "its" : "their"} text on the Paste text tab instead. ${missed.map((m) => `${m.url}: ${m.reason}`).join(" ")}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h3>{copy.title}</h3>
      <p className="small muted">{copy.intro}</p>
      {methods.length > 1 && (
        <Tabs value={method} onChange={setMethod} options={methods.map((m) => ({ value: m, label: LABELS[m] }))} />
      )}
      {note && <p className="notice">{note}</p>}

      {method === "paste" && (
        <div className="stack">
          <label className="field">
            <span>Name (so you can recognise it later)</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`e.g. ${copy.nameExample}`} />
          </label>
          <label className="field">
            <span>Text</span>
            <CleanTextarea value={text} onChange={(e) => setText(e.target.value)} placeholder={copy.textPlaceholder} rows={8} />
          </label>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={addPaste} disabled={busy || !text.trim()}>
              {busy ? "Adding…" : "Add text"}
            </button>
          </div>
        </div>
      )}

      {method === "upload" && (
        <label className="field">
          <span>Files</span>
          <input type="file" multiple accept={ACCEPTED_FILES} disabled={busy} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <small>{copy.uploadHelp} .txt, .md, .docx or .pdf, up to 15 MB each. Only the text is kept.</small>
        </label>
      )}

      {method === "url" && (
        <div className="stack">
          <label className="field">
            <span>Links, one per line</span>
            <CleanTextarea
              rows={5}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder={"https://\nhttps://\nhttps://"}
              disabled={busy}
            />
            <small>{copy.linksHelp} Up to {MAX_LINKS} at a time.</small>
          </label>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={addLinks} disabled={busy || parseLinks(links).length === 0}>
              {progress ?? (parseLinks(links).length > 1 ? `Fetch ${parseLinks(links).length} links` : "Fetch page")}
            </button>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
