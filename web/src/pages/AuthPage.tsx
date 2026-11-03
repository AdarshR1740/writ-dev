import { useState } from "react";
import { LogoMark, Wordmark } from "../components/Logo";
import { errorMessage, supabase } from "../lib/supabase";
import { ErrorText } from "../components/ui";

export function AuthPage({ intro }: { intro?: string }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-in") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.href },
        });
        if (err) throw err;
        if (!data.session) setSent(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const switchMode = () => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(null); setSent(false); };

  return (
    <div className="auth-split">
      <BrandPanel />
      <main className="auth-form-side">
      <form className="auth-box" onSubmit={submit}>
        <div className="stack" style={{ gap: 8 }}>
          <h1>{mode === "sign-in" ? "Sign in" : "Create your account"}</h1>
          <p className="muted">
            {intro ?? (mode === "sign-in" ? "Welcome back." : "Then add your company and its house file: who you write for, and how you sound.")}
          </p>
        </div>
        {sent ? (
          <p className="notice">Check {email} for a confirmation link, then come back here to sign in.</p>
        ) : (
          <>
            {mode === "sign-up" && (
              <label className="field">
                <span>Your name</span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label className="field">
              <span>Work email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              />
              {mode === "sign-up" && <small>At least 8 characters.</small>}
            </label>
            <ErrorText>{error}</ErrorText>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "One moment…" : mode === "sign-in" ? "Sign in" : "Create account"}
            </button>
          </>
        )}
        <p className="small muted auth-switch">
          {mode === "sign-in" ? "New to Writ? " : "Already have an account? "}
          <button type="button" className="link-btn" onClick={switchMode}>
            {mode === "sign-in" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </form>
      </main>
    </div>
  );
}

/**
 * The brand side: what Writ produces, shown rather than described. A claim with
 * its quoted source, approved by a person, and a named sign-off.
 */
function BrandPanel() {
  return (
    <aside className="auth-brand" aria-label="About Writ">
      <Wordmark size={30} />
      <div className="auth-brand-body">
        <h2 className="auth-headline">Content your experts can put their name to.</h2>
        <figure className="specimen" aria-label="Example of a finished claim in Writ">
          <p className="specimen-text">
            In a 2025 survey of 410 manufacturers, 23% ran a digital twin of at least one plant<sup>1</sup>.
            Most teams we talk to stall on data, not on choosing a tool<sup>2</sup>.
          </p>
          <ol className="specimen-sources">
            <li><q>23 percent of respondents reported operating a digital twin</q> <span>Industry survey, March 2025 · approved</span></li>
            <li><q>buyers had already shortlisted a tool but had no clean SKU master</q> <span>Your discovery calls · insight card</span></li>
          </ol>
          <figcaption className="specimen-seal">
            <LogoMark size={20} />
            <span>Signed off by <strong>Priya Nair</strong>, Head of Operations</span>
          </figcaption>
        </figure>
        <ul className="auth-points">
          <li><strong>Research you review.</strong> Every finding comes with the passage behind it.</li>
          <li><strong>Writing that stays yours.</strong> AI briefs and checks; it doesn't rewrite your sentences.</li>
          <li><strong>A record behind every piece.</strong> Sources, approvals and sign-off, kept.</li>
        </ul>
      </div>
      <p className="auth-foot">Expert content, AI-assisted. The example above is illustrative.</p>
    </aside>
  );
}
