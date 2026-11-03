import { useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { ACCEPTED_FILES, readFileText } from "../lib/files";
import type { InputMethod } from "../lib/sections";
import { ErrorText, Tabs } from "./ui";

interface FetchResult {
  ok: boolean;
  paste?: boolean;
  reason?: string;
  redirect?: string | null;
  url?: string;
  title?: string;
  text?: string;
}

const LABELS: Record<InputMethod, string> = { paste: "Paste text", upload: "Upload files", url: "From a URL" };

/** Adds raw material (pasted text, files, web pages) to a context document. */
export function AddMaterial({
  companyId,
  documentId,
  methods,
  placeholder,
  onAdded,
}: {
  companyId: string;
  documentId: string;
  methods: InputMethod[];
  placeholder: string;
  onAdded: () => void;
}) {
  const [method, setMethod] = useState<InputMethod>(methods[0]);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
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
      await save([{ origin: url && note ? "url" : "paste", label: label.trim() || "Pasted text", content: text.trim(), source_url: url && note ? url : undefined }]);
      setText("");
      setLabel("");
      setNote(null);
      setUrl("");
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

  async function addUrl() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await callFunction<FetchResult>("fetch-url", { company_id: companyId, url: url.trim() });
      if (res.ok && res.text) {
        await save([{ origin: "url", label: res.title || res.url || url, content: res.text, source_url: res.url }]);
        setUrl("");
      } else if (res.redirect) {
        setUrl(res.redirect);
        setNote(`${res.reason} The address has been updated; fetch again.`);
      } else if (res.paste) {
        setNote(res.reason ?? "Paste the text instead.");
        setLabel(url.trim());
        setMethod("paste");
      } else {
        setError(res.reason ?? "Couldn't fetch that page.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h3>Add material</h3>
      {methods.length > 1 && (
        <Tabs value={method} onChange={setMethod} options={methods.map((m) => ({ value: m, label: LABELS[m] }))} />
      )}
      {note && <p className="notice">{note}</p>}

      {method === "paste" && (
        <div className="stack">
          <label className="field">
            <span>Name (so you can recognise it later)</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Brand guidelines 2026" />
          </label>
          <label className="field">
            <span>Text</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={8} />
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
          <small>.txt, .md, .docx or .pdf, up to 15 MB each. Only the text is kept.</small>
        </label>
      )}

      {method === "url" && (
        <div className="stack">
          <label className="field">
            <span>Web address</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            <small>LinkedIn, X and similar sites block fetching. Paste those posts instead.</small>
          </label>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={addUrl} disabled={busy || !url.trim()}>
              {busy ? "Fetching…" : "Fetch page"}
            </button>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
