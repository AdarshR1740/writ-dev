import { Link } from "react-router-dom";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany, useSession } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import { ErrorText, Loading, Lede, PromptHelper, CleanTextarea } from "../components/ui";
import { StepNav } from "../components/StepNav";
import { VOICE_MEMORY_PROMPT } from "../lib/sections";
import { parseRules } from "../lib/rules";

export interface MemoryRule {
  id: string;
  rule: string;
  evidence: string;
  origin: "manual" | "learned";
  created_at: string;
}

export function VoiceMemoryPage() {
  const company = useCompany();
  const { session } = useSession();
  const { data, error, reload } = useLoad(
    async () => must<MemoryRule[]>(await supabase.from("voice_memory").select("*").eq("company_id", company.id).order("created_at")),
    [company.id],
  );
  const [adding, setAdding] = useState("");
  const [pasted, setPasted] = useState("");
  const [editing, setEditing] = useState<{ id: string; rule: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link></span>
        <h1>Voice memory</h1>
        <Lede more={<>Learned from your edits to AI drafts, the final versions you paste back, and what you say in the conversations. Only drafting reads it.</>}>What the tool has learned about how you write. Every rule is yours to change.</Lede>
      </div>
      <ErrorText>{error ?? actionError}</ErrorText>
      <PromptHelper title="Get rules from your AI tool" prompt={VOICE_MEMORY_PROMPT}>
        <p className="small muted">
          If you already write with ChatGPT, Claude or Gemini, it has seen your corrections. Paste this prompt into that tool, then paste its list of rules in the box below.
        </p>
      </PromptHelper>
      {data && (
        <div className="card stack" style={{ padding: 16 }}>
          <h3>Paste a list of rules</h3>
          <p className="small muted">One rule per line. Bullets and numbers are removed, and rules you already have are skipped. You can edit or delete any of them afterwards.</p>
          <CleanTextarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={"Open with the claim, not the context\nWrite numbers as digits"} aria-label="Rules to add" />
          {(() => {
            const rules = parseRules(pasted, data.map((m) => m.rule));
            return (
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={rules.length === 0} onClick={() => act(async () => {
                  must(await supabase.from("voice_memory").insert(
                    rules.map((rule) => ({ company_id: company.id, rule, origin: "manual", created_by: session!.user.id })),
                  ).select("id"));
                  setPasted("");
                })}>
                  {rules.length ? `Add ${rules.length} rule${rules.length === 1 ? "" : "s"}` : "Add rules"}
                </button>
              </div>
            );
          })()}
        </div>
      )}
      {!data ? <Loading /> : (
        <>
          {data.length === 0 && (
            <EmptyState icon="voice" title="Nothing learned yet">
              <p>After a piece is signed off, choose "Suggest voice rules" on its sign-off page. Writ compares the drafts with what you published and suggests rules; you keep only the ones you agree with.</p>
            </EmptyState>
          )}
          <ul className="memory">
            {data.map((m) => (
              <li key={m.id}>
                {editing?.id === m.id ? (
                  <form className="row" style={{ flex: 1 }} onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => { must(await supabase.from("voice_memory").update({ rule: editing.rule.trim() }).eq("id", m.id).select("id")); setEditing(null); });
                  }}>
                    <input type="text" value={editing.rule} onChange={(e) => setEditing({ id: m.id, rule: e.target.value })} style={{ flex: 1 }} aria-label="Rule" autoFocus />
                    <button type="submit" className="btn btn-small btn-primary">Save</button>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <div className="stack" style={{ gap: 2, flex: 1 }}>
                      <span>{m.rule}</span>
                      <span className="small faint">{m.origin === "learned" ? `Learned ${formatDate(m.created_at)}` : "Added by hand"}{m.evidence ? ` · ${m.evidence}` : ""}</span>
                    </div>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing({ id: m.id, rule: m.rule })}>Edit</button>
                    <button type="button" className="btn btn-quiet btn-small btn-danger" onClick={() => act(async () => must(await supabase.from("voice_memory").delete().eq("id", m.id).select("id")))}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <form className="row" onSubmit={(e) => {
            e.preventDefault();
            if (!adding.trim()) return;
            act(async () => {
              must(await supabase.from("voice_memory").insert({ company_id: company.id, rule: adding.trim(), origin: "manual", created_by: session!.user.id }).select("id"));
              setAdding("");
            });
          }}>
            <input type="text" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a rule, e.g. Numbers as digits, always" style={{ flex: 1 }} aria-label="New rule" />
            <button type="submit" className="btn" disabled={!adding.trim()}>Add rule</button>
          </form>
        </>
      )}
      <StepNav />
    </div>
  );
}
