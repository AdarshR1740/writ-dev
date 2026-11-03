import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import { ErrorText } from "../components/ui";
import { AuthPage } from "./AuthPage";

export function InvitePage() {
  const { token } = useParams();
  const { session, refreshCompanies, selectCompany } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(null), [session?.user.id]);

  if (!session) {
    return <AuthPage intro="You've been invited to a company. Sign in or create an account with the email the invite was sent to." />;
  }

  async function accept() {
    setBusy(true);
    try {
      const { data, error: err } = await supabase.rpc("accept_invitation", { invite_token: token });
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
    <div className="auth">
      <div className="auth-box">
        <span className="eyebrow">Invitation</span>
        <h1>Join the company</h1>
        <p className="lede">You're signed in as {session.user.email}. The invite must be for this email.</p>
        <ErrorText>{error}</ErrorText>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={accept} disabled={busy}>
            {busy ? "Joining…" : "Accept invitation"}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => supabase.auth.signOut()}>Use another account</button>
        </div>
      </div>
    </div>
  );
}
