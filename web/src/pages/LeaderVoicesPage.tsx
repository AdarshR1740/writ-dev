import { Link } from "react-router-dom";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { StepNav } from "../components/StepNav";
import { CleanTextarea, ErrorText, Lede, Loading, PromptHelper } from "../components/ui";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany, useSession } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { LEADER_VOICE_PROMPT } from "../lib/sections";
import type { LeaderVoice } from "../lib/types";

interface Draft {
  id: string | null;
  name: string;
  role: string;
  profile: string;
}

const EMPTY: Draft = { id: null, name: "", role: "", profile: "" };

/** How particular people at the company write. Editors define them; writers use one to restyle a text. */
export function LeaderVoicesPage() {
  const company = useCompany();
  const { session } = useSession();
  const canEdit = company.role === "editor";
  const { data, error, reload } = useLoad(
    async () => must<LeaderVoice[]>(await supabase.from("leader_voices").select("*").eq("company_id", company.id).order("name")),
    [company.id],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const valid = draft && draft.name.trim() && draft.profile.trim().length >= 20;

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link></span>
        <h1>Leader voices</h1>
        <Lede more={<>Each voice is a short description of how one person writes. In the Writing step, a writer can copy a voice with their section, run it in their own AI tool and paste the result back. Writ never restyles text itself, and the research and drafting steps never see these.</>}>
          How the people you write for sound, so a finished piece can be edited to read like them.
        </Lede>
      </div>
      <ErrorText>{error ?? actionError}</ErrorText>
      {!data ? <Loading /> : (
        <>
          {data.length === 0 && !draft && (
            <EmptyState icon="voice" title="No leader voices yet">
              <p>{canEdit ? "Add the people whose voice you want to write in, such as the CEO or a head of product." : "An editor can add the people whose voice you can write in."}</p>
            </EmptyState>
          )}
          <ul className="memory">
            {data.map((v) => (
              <li key={v.id}>
                <div className="stack" style={{ gap: 4, flex: 1 }}>
                  <strong>{v.name}{v.role && <span className="muted"> · {v.role}</span>}</strong>
                  <span className="small muted" style={{ whiteSpace: "pre-wrap" }}>{v.profile}</span>
                </div>
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => setDraft({ id: v.id, name: v.name, role: v.role, profile: v.profile })}>Edit</button>
                    <button type="button" className="btn btn-quiet btn-small btn-danger" disabled={busy} onClick={() => {
                      if (window.confirm(`Delete ${v.name}'s voice?`)) void act(async () => must(await supabase.from("leader_voices").delete().eq("id", v.id).select("id")));
                    }}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>

          {canEdit && !draft && <div><button type="button" className="btn btn-primary" onClick={() => setDraft(EMPTY)}>Add a leader voice</button></div>}

          {canEdit && draft && (
            <form className="card stack" style={{ padding: 16 }} onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              void act(async () => {
                const row = { name: draft.name.trim(), role: draft.role.trim(), profile: draft.profile.trim() };
                if (draft.id) must(await supabase.from("leader_voices").update(row).eq("id", draft.id).select("id"));
                else must(await supabase.from("leader_voices").insert({ ...row, company_id: company.id, created_by: session!.user.id }).select("id"));
                setDraft(null);
              });
            }}>
              <h3>{draft.id ? "Edit voice" : "New leader voice"}</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <label className="stack" style={{ gap: 4, flex: 1, minWidth: 180 }}>
                  <span className="small">Name</span>
                  <input type="text" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
                </label>
                <label className="stack" style={{ gap: 4, flex: 1, minWidth: 180 }}>
                  <span className="small">Role (optional)</span>
                  <input type="text" value={draft.role} maxLength={200} onChange={(e) => setDraft({ ...draft, role: e.target.value })} placeholder="e.g. CEO" />
                </label>
              </div>
              <PromptHelper title="Get the description from your AI tool" prompt={LEADER_VOICE_PROMPT}>
                <p className="small muted">
                  Paste this prompt into ChatGPT, Claude or Gemini together with 3 to 5 things this person has written (posts, emails, talks). Paste its list of rules below, and edit anything that is wrong.
                </p>
              </PromptHelper>
              <label className="stack" style={{ gap: 4 }}>
                <span className="small">How they write</span>
                <CleanTextarea rows={10} value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value })}
                  placeholder={"Opens with the claim, never with context\nShort sentences, many under ten words\nUses first person plural: \"we\" not \"the company\""} />
              </label>
              {draft.profile.trim().length > 0 && draft.profile.trim().length < 20 && <p className="small flag-text">Describe their voice in at least 20 characters.</p>}
              <div className="row">
                <button type="submit" className="btn btn-primary" disabled={busy || !valid}>{busy ? "Saving…" : "Save voice"}</button>
                <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
      <StepNav />
    </div>
  );
}
