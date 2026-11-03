import { useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { useCompany, useSession } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import type { Invitation, Member, Role } from "../lib/types";
import { CopyButton, ErrorText, Loading, Lede } from "../components/ui";

export function TeamPage() {
  const company = useCompany();
  const { session, refreshCompanies } = useSession();
  const isEditor = company.role === "editor";
  const { data, error, reload } = useLoad(async () => {
    const [members, invites] = await Promise.all([
      supabase.from("memberships").select("user_id, role, profiles(email, display_name)").eq("company_id", company.id)
        .order("created_at").then(must<Member[]>),
      isEditor
        ? supabase.from("invitations").select("*").eq("company_id", company.id).is("accepted_at", null)
          .order("created_at", { ascending: false }).then(must<Invitation[]>)
        : Promise.resolve([] as Invitation[]),
    ]);
    return { members, invites };
  }, [company.id, isEditor]);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      must(await supabase.from("invitations").insert({
        company_id: company.id, email: email.trim().toLowerCase(), role, invited_by: session!.user.id,
      }).select("id"));
      setEmail("");
    });
  };
  const link = (token: string) => `${window.location.origin}/invite/${token}`;

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>Team</h1>
        <Lede more={<>People see only the companies they belong to.</>}>Editors manage the team and settings and sign off pieces; members work on content.</Lede>
      </div>
      {isEditor && <CompanyName companyId={company.id} name={company.name} onRenamed={refreshCompanies} />}
      <ErrorText>{error ?? actionError}</ErrorText>
      {!data ? <Loading /> : (
        <>
          <table className="plain">
            <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
            <tbody>
              {data.members.map((m) => {
                const me = m.user_id === session?.user.id;
                return (
                  <tr key={m.user_id}>
                    <td>
                      <strong>{m.profiles?.display_name || m.profiles?.email}</strong>{me && <span className="faint"> (you)</span>}
                      <div className="small muted">{m.profiles?.email}</div>
                    </td>
                    <td>
                      {isEditor ? (
                        <select value={m.role} disabled={busy} aria-label={`Role for ${m.profiles?.email}`} onChange={(e) => act(async () => {
                          must(await supabase.from("memberships").update({ role: e.target.value }).eq("company_id", company.id).eq("user_id", m.user_id).select("user_id"));
                          if (me) await refreshCompanies();
                        })}>
                          <option value="editor">Editor</option>
                          <option value="member">Member</option>
                        </select>
                      ) : m.role === "editor" ? "Editor" : "Member"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {(isEditor || me) && (
                        <button type="button" className="btn btn-quiet btn-small btn-danger" disabled={busy} onClick={() => {
                          if (!window.confirm(me ? `Leave ${company.name}?` : `Remove ${m.profiles?.email}?`)) return;
                          act(async () => {
                            must(await supabase.from("memberships").delete().eq("company_id", company.id).eq("user_id", m.user_id).select("user_id"));
                            if (me) await refreshCompanies();
                          });
                        }}>
                          {me ? "Leave" : "Remove"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {isEditor && <EditorialSettings companyId={company.id} />}
          {isEditor && <WordPressConnection companyId={company.id} />}

          {isEditor && (
            <section className="stack">
              <h2>Invite someone</h2>
              <form className="row" onSubmit={invite}>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Email" style={{ flex: "1 1 240px", width: "auto" }} />
                <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role" style={{ width: "auto" }}>
                  <option value="member">Member</option>
                  <option value="editor">Editor</option>
                </select>
                <button type="submit" className="btn btn-primary" disabled={busy}>Create invite link</button>
              </form>
              <p className="small muted">Send them the link. It works once, for that email, for 14 days.</p>
              {data.invites.map((i) => (
                <div key={i.id} className="card row">
                  <div className="stack" style={{ gap: 2 }}>
                    <strong>{i.email}</strong>
                    <span className="small muted">{i.role === "editor" ? "Editor" : "Member"} · expires {formatDate(i.expires_at)}</span>
                  </div>
                  <span className="spacer" />
                  <CopyButton text={link(i.token)} label="Copy link" />
                  <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => act(async () => {
                    must(await supabase.from("invitations").delete().eq("id", i.id).select("id"));
                  })}>Cancel invite</button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function EditorialSettings({ companyId }: { companyId: string }) {
  const { data, reload } = useLoad(
    async () => must<{ editorial_record: boolean; disclosure_line: string; review_interval_months: number }>(
      await supabase.from("companies").select("editorial_record, disclosure_line, review_interval_months").eq("id", companyId).single(),
    ),
    [companyId],
  );
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    const { error: err } = await supabase.from("companies").update(patch).eq("id", companyId);
    if (err) setError(err.message);
    else { setLine(null); reload(); }
  };
  return (
    <section className="stack">
      <h2>Editorial record</h2>
      <label className="row">
        <input type="checkbox" checked={data.editorial_record} onChange={(e) => save({ editorial_record: e.target.checked })} />
        <span>Require a named editor to sign off every piece</span>
      </label>
      <p className="small muted">
        Every decision is logged either way. Turn this on for regulated topics or EU audiences, where documented human
        review and a responsible editor matter.
      </p>
      <label className="field">
        <span>Review finished pieces every</span>
        <select value={data.review_interval_months} onChange={(e) => save({ review_interval_months: Number(e.target.value) })} style={{ width: "auto" }}>
          {[3, 6, 9, 12, 18, 24].map((m) => <option key={m} value={m}>{m} months</option>)}
        </select>
        <small>Applies from each piece's sign-off. Due pieces show up under History → Review due.</small>
      </label>
      <label className="field">
        <span>Default disclosure line (optional to publish)</span>
        <input type="text" value={line ?? data.disclosure_line} onChange={(e) => setLine(e.target.value)} />
      </label>
      {line !== null && line !== data.disclosure_line && (
        <div><button type="button" className="btn btn-small btn-primary" onClick={() => save({ disclosure_line: line })}>Save line</button></div>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/** Rename the company. Editors only (enforced by the companies update policy). */
function CompanyName({ companyId, name, onRenamed }: { companyId: string; name: string; onRenamed: () => Promise<unknown> }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const trimmed = value.trim();
  const changed = trimmed !== name;
  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      setSaved(false);
      const { error: err } = await supabase.from("companies").update({ name: trimmed }).eq("id", companyId);
      if (err) setError(err.message);
      else { await onRenamed(); setSaved(true); }
      setBusy(false);
    }}>
      <h2>Company name</h2>
      <div className="row">
        <input type="text" value={value} maxLength={120} onChange={(e) => { setValue(e.target.value); setSaved(false); }} aria-label="Company name" style={{ flex: "1 1 260px", width: "auto" }} />
        <button type="submit" className="btn" disabled={busy || !trimmed || !changed}>{busy ? "Saving…" : "Rename"}</button>
        {saved && <span className="small ok-text">Renamed.</span>}
        {!trimmed && <span className="small muted disabled-reason">A company needs a name</span>}
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

/** Connect a WordPress site, so finished pieces can be sent to it as drafts. */
function WordPressConnection({ companyId }: { companyId: string }) {
  const { data: loaded, reload } = useLoad(async () => ({ target: must<{ site_url: string; username: string; key_hint: string } | null>(
    await supabase.from("publishing_targets").select("site_url, username, key_hint").eq("company_id", companyId).eq("kind", "wordpress").maybeSingle()) }), [companyId]);
  const [editing, setEditing] = useState(false);
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!loaded) return null;
  const data = loaded.target;
  const form = editing || !data;

  return (
    <section className="stack">
      <h2>WordPress</h2>
      <p className="small muted">
        Send finished pieces to your site as drafts, ready to review and publish there. Uses an application password
        (in WordPress: Users, your profile, Application Passwords), which Writ encrypts and never shows again.
      </p>
      {data && !editing && (
        <div className="row">
          <span>Connected to <a href={data.site_url} target="_blank" rel="noreferrer">{data.site_url.replace(/^https:\/\//, "")}</a> as <strong>{data.username}</strong> <span className="faint">({data.key_hint})</span></span>
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={() => { setEditing(true); setSite(data.site_url); setUsername(data.username); }}>Change</button>
          <button type="button" className="btn btn-small btn-quiet btn-danger" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await callFunction("publish", { action: "remove_target", company_id: companyId }); reload(); } catch (err) { setError(errorMessage(err)); }
            setBusy(false);
          }}>Disconnect</button>
        </div>
      )}
      {form && (
        <form className="stack" style={{ gap: 10 }} onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          try {
            await callFunction("publish", { action: "save_target", company_id: companyId, site_url: site, username, app_password: password });
            setEditing(false); setPassword(""); reload();
          } catch (err) { setError(errorMessage(err)); }
          setBusy(false);
        }}>
          <label className="field"><span>Site address</span><input type="text" inputMode="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://blog.example.com" required /></label>
          <div className="grid-2">
            <label className="field"><span>WordPress username</span><input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required /></label>
            <label className="field"><span>Application password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" required /></label>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || !site.trim() || !username.trim() || !password.trim()}>{busy ? "Checking…" : "Check and connect"}</button>
            {editing && <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
