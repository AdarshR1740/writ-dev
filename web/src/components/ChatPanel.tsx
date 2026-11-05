import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThreadMessage } from "../lib/types";
import { callFunction, errorMessage } from "../lib/supabase";
import { CleanTextarea, ErrorText } from "./ui";
import { RichText } from "./RichText";

/** Copies text to the clipboard, with a prompt as the fallback where the clipboard is blocked. */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("Copy this text:", text);
  }
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="chat-act" onClick={async () => { await copy(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

const TASKS = { scope: "contract_suggest", outline: "outline_suggest" } as const;

/**
 * A simple chat: the newest message is always in view, the box to type in stays pinned at the bottom, Enter
 * sends (Shift+Enter makes a new line), and each AI reply can be copied or, for the latest, answered again.
 * Tick "Search the web" (or ask for a search in words) and the AI looks things up first; a reply that did lists
 * the pages it used.
 */
export function ChatPanel({ kind, pieceId, messages, placeholder, beforeSend, onSent, onMinimize, renderExtra, copyText }: {
  /** Which conversation: the scope or the outline. */
  kind: "scope" | "outline";
  pieceId: string;
  messages: ThreadMessage[];
  placeholder: string;
  /** Runs before each send or retry, for example to save edits the AI should see. */
  beforeSend?: () => Promise<void>;
  /** Called after a reply is saved; the conversation is reloaded here. */
  onSent: () => Promise<unknown>;
  onMinimize: () => void;
  /** What a reply carries besides its text, such as the suggested scope and its "use" button. */
  renderExtra: (m: ThreadMessage) => ReactNode;
  /** The text copied for a reply. */
  copyText: (m: ThreadMessage) => string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState<{ message: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [web, setWeb] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastAi = [...messages].reverse().find((m) => m.role === "ai");
  const lastIsAi = messages.length > 0 && messages[messages.length - 1].role === "ai";

  // Newest message in view, on open and whenever something arrives.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  async function run(message: string | null) {
    setError(null);
    setSending({ message: message || null });
    try {
      await beforeSend?.();
      await callFunction("ai", {
        task: TASKS[kind],
        piece_id: pieceId,
        ...(web ? { web: true } : {}),
        ...(message === null ? { retry: true } : { message }),
      });
      if (message !== null) setText("");
      await onSent();
    } catch (err) {
      setError(errorMessage(err));
      // A send that failed part-way may still have saved the writer's message.
      await onSent().catch(() => undefined);
    } finally {
      setSending(null);
    }
  }

  const send = () => { if (!sending) void run(text.trim()); };

  return (
    <aside className="rail thread chat" aria-label="Conversation">
      <div className="row">
        <h3>Work it out with AI</h3>
        <span className="spacer" />
        <button type="button" className="btn btn-quiet btn-small" onClick={onMinimize}>Minimize</button>
      </div>
      <div className="messages" ref={scroller} role="log" aria-live="polite">
        {messages.length === 0 && !sending && (
          <p className="small muted">Ask for a first suggestion, or describe what the piece must do. Tick "Search the web" and the AI looks things up before it answers. Every turn is kept here.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <span className="msg-who">{m.role === "ai" ? "Writ AI" : "You"}</span>
            {m.role === "ai" ? <RichText text={m.content} /> : <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>}
            {m.role === "ai" && renderExtra(m)}
            {m.role === "ai" && (m.payload?.web?.sources?.length ?? 0) > 0 && (
              <details className="chat-sources">
                <summary className="small">Looked up on the web ({m.payload!.web!.sources.length} pages)</summary>
                <ul>{m.payload!.web!.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></li>)}</ul>
              </details>
            )}
            {m.role === "ai" && (
              <div className="chat-actions">
                <CopyAction text={copyText(m)} />
                {m.id === lastAi?.id && lastIsAi && (
                  <button type="button" className="chat-act" disabled={Boolean(sending)} onClick={() => void run(null)}>Retry</button>
                )}
              </div>
            )}
          </div>
        ))}
        {sending?.message && (
          <div className="msg writer"><span className="msg-who">You</span><p style={{ whiteSpace: "pre-wrap" }}>{sending.message}</p></div>
        )}
        {sending && (
          <div className="msg ai"><span className="msg-who">Writ AI</span><p className="muted">{web ? "Searching the web and working…" : "Working…"}</p></div>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="chat-composer">
        <CleanTextarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim() || messages.length === 0) send(); } }}
          placeholder={placeholder}
          aria-label="Message"
        />
        <div className="row">
          <label className="check-label small" title="The AI looks things up online before it answers. Costs a little more. Needs an Anthropic or OpenAI key.">
            <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Search the web
          </label>
          <span className="small faint">Enter to send</span>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={Boolean(sending) || (!text.trim() && messages.length > 0)} onClick={send}>
            {sending ? "Working…" : messages.length === 0 && !text.trim() ? "Suggest" : "Send"}
          </button>
        </div>
      </div>
    </aside>
  );
}
