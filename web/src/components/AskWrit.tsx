import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { useCompany, useSession } from "../lib/session";
import type { Estimate } from "../lib/types";
import { ErrorText } from "./ui";

interface Source { n: number; kind: string; label: string; title: string; path: string; excerpt: string }
interface AskMessage {
  id: string;
  role: "user" | "writ";
  content: string;
  payload: { covered?: "yes" | "partly" | "no"; sources?: Source[] } | null;
  created_at: string;
}

const perQuestion = (usd: number | null) =>
  usd === null ? "Cost unknown" : usd < 0.01 ? "Under 1¢" : `About $${usd.toFixed(2)}`;

const EXAMPLES = [
  "What do we know about our ideal customer?",
  "Which figures have we published, and where?",
  "What have we said about pricing?",
  "Which insight cards come from customer calls?",
];

/** An answer with its [n] citations turned into links to the numbered sources below it. */
function Answer({ text, sources, messageId }: { text: string; sources: Source[]; messageId: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(sources.some((s) => s.n === n)
      ? <a key={m.index} href={`#ask-${messageId}-${n}`} className="cite">{n}</a>
      : null);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="ask-answer">{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</p>;
}

/** Ask Writ: questions answered only from the company's own material, with sources. */
export function AskWrit({ onClose }: { onClose: () => void }) {
  const company = useCompany();
  const { session } = useSession();
  const { data: messages, setData, reload } = useLoad(async () => must<AskMessage[]>(await supabase.from("ask_messages")
    .select("id, role, content, payload, created_at").eq("company_id", company.id).eq("user_id", session!.user.id).order("created_at")),
  [company.id]);
  const { data: estimate } = useLoad(() => callFunction<Estimate>("ai", { task: "ask", company_id: company.id, mode: "estimate" }).catch(() => null), [company.id]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, pending]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setPending(text);
    setQuestion("");
    setError(null);
    try {
      await callFunction("ai", { task: "ask", company_id: company.id, question: text });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
      setQuestion(text);
    } finally {
      setPending(null);
    }
  }

  async function clear() {
    const { error: err } = await supabase.from("ask_messages").delete().eq("company_id", company.id).eq("user_id", session!.user.id);
    if (err) setError(err.message);
    else setData([]);
  }

  return (
    <aside className="ask-panel" role="dialog" aria-label="Ask Writ">
      <header className="ask-head">
        <div className="stack" style={{ gap: 2 }}>
          <strong>Ask Writ</strong>
          <span className="small muted">Answers only from {company.name}'s own material, with sources.</span>
        </div>
        <span className="spacer" />
        {messages && messages.length > 0 && <button type="button" className="btn btn-quiet btn-small" onClick={clear}>Clear</button>}
        <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
      </header>

      <div className="ask-body" aria-live="polite">
        {messages && messages.length === 0 && !pending && (
          <div className="ask-empty">
            <p className="small muted">
              Ask about anything your company has written down: finished pieces, insight and data cards, the house file
              and approved research. If it isn't there, Writ says so instead of guessing.
            </p>
            <div className="ask-examples">
              {EXAMPLES.map((e) => <button key={e} type="button" className="chip" onClick={() => ask(e)}>{e}</button>)}
            </div>
          </div>
        )}
        {(messages ?? []).map((m) => m.role === "user" ? (
          <p key={m.id} className="ask-q">{m.content}</p>
        ) : (
          <div key={m.id} className="ask-a">
            {m.payload?.covered === "no" && <span className="tag flag">Not in your material</span>}
            {m.payload?.covered === "partly" && <span className="tag flag">Partly covered</span>}
            <Answer text={m.content} sources={m.payload?.sources ?? []} messageId={m.id} />
            {(m.payload?.sources ?? []).length > 0 && (
              <ol className="ask-sources">
                {m.payload!.sources!.map((s) => (
                  <li key={s.n} id={`ask-${m.id}-${s.n}`}>
                    <span className="cite">{s.n}</span>
                    <Link to={s.path} onClick={() => window.innerWidth < 860 && onClose()}>
                      <span className="small muted">{s.label}</span> <strong className="small">{s.title}</strong>
                    </Link>
                    <q>{s.excerpt}</q>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
        {pending && (
          <>
            <p className="ask-q">{pending}</p>
            <p className="small muted ask-a">Looking through your material…</p>
          </>
        )}
        <div ref={end} />
      </div>

      <form className="ask-input" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <ErrorText>{error}</ErrorText>
        <textarea ref={input} rows={2} value={question} maxLength={1500} onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); } }}
          placeholder="Ask about your pieces, cards or house file" aria-label="Your question" />
        <div className="row">
          <span className="small faint">{estimate ? `${perQuestion(estimate.cost_usd)} a question, on ${estimate.model}.` : "Needs an AI key."}</span>
          <span className="spacer" />
          <button type="submit" className="btn btn-primary btn-small" disabled={!question.trim() || pending !== null}>Ask</button>
        </div>
      </form>
    </aside>
  );
}
