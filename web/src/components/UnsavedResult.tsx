import { useEffect, useState } from "react";
import { UNSAVED_EVENT } from "../lib/supabase";
import { CopyButton, Modal } from "./ui";

type Unsaved = { message: string; unsaved: unknown; task: string };

/** Readable text for what the AI produced: its own text when it is a string, otherwise the data as indented JSON. */
export function unsavedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const only = Object.values(value as Record<string, unknown>);
    if (only.length === 1 && typeof only[0] === "string") return only[0];
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * When someone took an edit lock over while the AI was running, the server saves nothing and sends the result back. This shows it
 * so the writer can copy it, instead of losing a run they paid for. Mounted once for the whole app.
 */
export function UnsavedResult() {
  const [shown, setShown] = useState<Unsaved | null>(null);
  useEffect(() => {
    const on = (e: Event) => setShown((e as CustomEvent<Unsaved>).detail);
    window.addEventListener(UNSAVED_EVENT, on);
    return () => window.removeEventListener(UNSAVED_EVENT, on);
  }, []);
  if (!shown) return null;
  const text = unsavedText(shown.unsaved);
  return (
    <Modal title="Not saved: someone else took over" onClose={() => setShown(null)}>
      <p>{shown.message}</p>
      <textarea readOnly value={text} rows={12} aria-label="The AI's unsaved result" style={{ width: "100%" }} />
      <div className="row">
        <CopyButton text={text} label="Copy the result" />
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setShown(null)}>Close</button>
      </div>
      <p className="muted">When they have finished, run the step again to save a fresh result.</p>
    </Modal>
  );
}
