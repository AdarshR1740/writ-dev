import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import { ErrorText } from "../components/ui";
import { Wordmark } from "../components/Logo";

export function NewCompanyPage({ first }: { first?: boolean }) {
  const { refreshCompanies, selectCompany, session } = useSession();
  const firstName = String(session?.user.user_metadata?.display_name ?? "").trim().split(/\s+/)[0];
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc("create_company", { company_name: name });
      if (err) throw err;
      await refreshCompanies();
      selectCompany(data as string);
      navigate("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth-split">
      <aside className="auth-brand" aria-label="Setting up Writ">
        <Wordmark size={30} />
        <div className="auth-brand-body">
          <h2 className="auth-headline">{first ? <>Welcome{firstName ? `, ${firstName}` : ""}.<br />Four steps to your first piece.</> : "Each company is its own Writ."}</h2>
          <ol className="setup-steps">
            <li className="now"><strong>Name the company</strong> <span>Who the content is for and from. Agencies add one per client.</span></li>
            <li><strong>Fill in the house file</strong> <span>Who you write for, what you stand for, and how you sound. Paste what you already have.</span></li>
            <li><strong>Add your AI key</strong> <span>Anthropic, OpenAI or Gemini. Costs go straight to your own account.</span></li>
            <li><strong>Start a piece</strong> <span>Pick a format, review the research, write it, sign it off.</span></li>
          </ol>
        </div>
        <p className="auth-foot">Each company keeps its own voice, insights, team and keys.</p>
      </aside>
      <main className="auth-form-side">
      <form className="auth-box" onSubmit={create}>
        <div className="stack" style={{ gap: 8 }}>
          <span className="eyebrow">{first ? "Step 1 of 4" : "New company"}</span>
          <h1>{first ? "Name your company" : "Add a company"}</h1>
          <p className="muted">Everything you add next, from the house file to pieces, belongs to this company.</p>
        </div>
        <label className="field">
          <span>Company name</span>
          <input type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Northwind Logistics" />
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create company"}
          </button>
          {!first && <button type="button" className="btn btn-quiet" onClick={() => navigate(-1)}>Cancel</button>}
          {!name.trim() && <span className="small muted disabled-reason">Add a name</span>}
        </div>
      </form>
      </main>
    </div>
  );
}
