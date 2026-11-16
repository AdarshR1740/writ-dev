import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { OAuthAuthorizationDetails } from "@supabase/auth-js";
import { errorMessage, supabase } from "../lib/supabase";
import { isTrustedRedirect } from "../lib/oauthConsent";
import { ErrorText, Loading } from "../components/ui";

/** Where Supabase sends a writer to approve or refuse an app (Claude) that wants to use their Writ account. */
export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const id = params.get("authorization_id");
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(id ? null : "This page needs a sign-in request from Claude. Start again from Claude.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let live = true;
    supabase.auth.oauth.getAuthorizationDetails(id).then(({ data, error: err }) => {
      if (!live) return;
      if (err || !data) return setError(errorMessage(err ?? "This request has expired. Start again from Claude."));
      if ("redirect_url" in data) { window.location.href = data.redirect_url; return; } // already approved before
      setDetails(data);
    });
    return () => { live = false; };
  }, [id]);

  async function decide(approve: boolean) {
    if (!id) return;
    setBusy(true);
    setError(null);
    // Supabase sends the browser back to the app once this succeeds.
    const { error: err } = approve ? await supabase.auth.oauth.approveAuthorization(id) : await supabase.auth.oauth.denyAuthorization(id);
    if (err) { setError(errorMessage(err)); setBusy(false); }
  }

  const trusted = details ? isTrustedRedirect(details.redirect_uri) : false;
  let host = "";
  try { host = details ? new URL(details.redirect_uri).host : ""; } catch { host = details?.redirect_uri ?? ""; }

  return (
    <div className="auth">
      <div className="auth-box stack">
        <h1>Connect Claude to Writ</h1>
        {!details && !error && <Loading />}
        <ErrorText>{error}</ErrorText>
        {details && (
          <>
            <p className="lede">
              <strong>{details.client.name}</strong> wants to use Writ as <strong>{details.user.email}</strong>.
            </p>
            <p className="muted">
              It could read your companies' pieces, research and house files, and save drafts, outlines and checks, as you can. It cannot
              see your password. You can stop it any time from your account.
            </p>
            <p className="small muted">It will return to: <span className="mono">{host}</span></p>
            {!trusted && (
              <p className="notice">
                This is not Claude's address, so Writ will not connect it, whatever the app calls itself. If you did not start this from Claude,
                close this page.
              </p>
            )}
            <div className="row" style={{ gap: 8 }}>
              {trusted && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>Allow</button>}
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => decide(false)}>{trusted ? "Deny" : "Refuse"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
