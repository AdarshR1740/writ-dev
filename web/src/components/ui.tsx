import { useEffect, useRef, useState, type ReactNode } from "react";
import { callFunction, errorMessage } from "../lib/supabase";

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="error" role="alert">{children}</p>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="muted" aria-live="polite">{label}</p>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          window.prompt("Copy this text:", text);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row">
          <h2>{title}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PromptHelper({ title, prompt, children }: { title: string; prompt: string; children?: ReactNode }) {
  return (
    <details className="helper">
      <summary>{title}</summary>
      <div className="helper-body">
        {children}
        <pre className="prompt">{prompt}</pre>
        <div className="row"><CopyButton text={prompt} label="Copy prompt" /></div>
      </div>
    </details>
  );
}

/**
 * An AI action: one click runs it. Token use and cost are still recorded on the server for every run,
 * and the company's budget limit is enforced there; nothing is asked first.
 */
export function AiAction<T>({
  label,
  payload,
  disabled,
  onDone,
  fn = "ai",
  primary = true,
  reason,
  payloads,
  merge,
}: {
  label: string;
  payload: Record<string, unknown>;
  disabled?: boolean;
  /** Shown beside the button while it's disabled, so it never looks broken. */
  reason?: string;
  onDone: (result: T) => void;
  fn?: string;
  primary?: boolean;
  /** Several calls in one go (for example one per source), run one after another. */
  payloads?: Record<string, unknown>[];
  /** Combines the results of `payloads` into the one result `onDone` receives. */
  merge?: (results: T[]) => T;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const batch = payloads && payloads.length > 1 && merge ? payloads : null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let result: T;
      if (batch) {
        const results: T[] = [];
        for (const [i, p] of batch.entries()) {
          setProgress(`${i + 1} of ${batch.length}`);
          results.push(await callFunction<T>(fn, p));
        }
        result = merge!(results);
      } else {
        result = await callFunction<T>(fn, payloads?.[0] ?? payload);
      }
      onDone(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        <button type="button" className={`btn${primary ? " btn-primary" : ""}`} onClick={run} disabled={disabled || busy}>
          {busy ? `Working…${progress ? ` ${progress}` : ""}` : label}
        </button>
        {disabled && reason && <span className="small muted disabled-reason">{reason}</span>}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** One-line page intro; the longer explanation sits behind "How this works". */
export function Lede({ children, more }: { children: ReactNode; more?: ReactNode }) {
  return (
    <div className="lede">
      <p className="muted">{children}</p>
      {more && (
        <details className="how">
          <summary>How this works</summary>
          <p className="muted small">{more}</p>
        </details>
      )}
    </div>
  );
}
