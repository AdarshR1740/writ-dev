// Export to WordPress: save the site connection (editors), and send a finished
// piece as a draft post (any member). Uses a WordPress application password,
// which is checked against the site, encrypted, and never returned.

import { handle, json, UserError } from "../_shared/cors.ts";
import { admin, requireRole, requireUser } from "../_shared/supabase.ts";
import { decrypt, encrypt } from "../_shared/crypto.ts";
import { assertPublicHost } from "../_shared/web.ts";

const TIMEOUT_MS = 20_000;

/** https://example.com from whatever the editor pasted (no path, no trailing slash). */
export function normaliseSite(input: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new UserError("That isn't a web address. It should look like https://blog.example.com");
  }
  if (url.protocol !== "https:") throw new UserError("Use your site's https:// address.");
  // Sites in a subfolder keep it (https://example.com/blog); wp-admin paths are dropped.
  const path = url.pathname.replace(/\/(wp-admin|wp-json|wp-login\.php).*$/, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function basicAuth(username: string, password: string): string {
  // Application passwords are shown with spaces; WordPress accepts them either way.
  return "Basic " + btoa(`${username}:${password.replace(/\s+/g, "")}`);
}

async function wp(site: string, path: string, auth: string, init: RequestInit = {}): Promise<Response> {
  await assertPublicHost(new URL(site).hostname);
  const res = await fetch(`${site}/wp-json/wp/v2${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json", ...(init.headers ?? {}) },
  }).catch(() => null);
  if (!res) throw new UserError("Couldn't reach the site. Check the address and that it's online.", 502);
  if (res.status >= 300 && res.status < 400) {
    throw new UserError("The site redirected. Use its final address (for example with or without www).");
  }
  return res;
}

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.action === "save_target") {
    const companyId = String(body.company_id ?? "");
    await requireRole(user.id, companyId, "editor");
    const site = normaliseSite(String(body.site_url ?? ""));
    const username = String(body.username ?? "").trim();
    const password = String(body.app_password ?? "").trim();
    if (!username || password.replace(/\s+/g, "").length < 16) {
      throw new UserError("Enter the WordPress username and an application password (Users → Profile → Application Passwords).");
    }
    const res = await wp(site, "/users/me?context=edit", basicAuth(username, password));
    if (res.status === 401 || res.status === 403) throw new UserError("WordPress rejected that username and application password.");
    if (res.status === 404) throw new UserError("No WordPress REST API at that address. Check the site address.");
    if (!res.ok) throw new UserError(`The site answered ${res.status}. Check the address and try again.`, 502);
    const me = await res.json().catch(() => ({}));
    const caps = (me?.capabilities ?? {}) as Record<string, boolean>;
    if (!caps.edit_posts) throw new UserError("That WordPress user can't create posts. Use an author, editor or administrator account.");

    const { ciphertext, iv } = await encrypt(password);
    const { data: row, error } = await admin.from("publishing_targets").upsert({
      company_id: companyId, kind: "wordpress", site_url: site, username,
      key_hint: `…${password.replace(/\s+/g, "").slice(-4)}`, created_by: user.id,
    }, { onConflict: "company_id,kind" }).select("id").single();
    if (error) throw error;
    const { error: secretError } = await admin.from("publishing_target_secrets").upsert({ target_id: row.id, ciphertext, iv });
    if (secretError) throw secretError;
    return json({ ok: true, site_url: site });
  }

  if (body.action === "remove_target") {
    const companyId = String(body.company_id ?? "");
    await requireRole(user.id, companyId, "editor");
    const { error } = await admin.from("publishing_targets").delete().eq("company_id", companyId).eq("kind", "wordpress");
    if (error) throw error;
    return json({ ok: true });
  }

  if (body.action === "wordpress_draft") {
    const { data: piece } = await admin.from("pieces").select("id, company_id, title, stage, code, version")
      .eq("id", String(body.piece_id ?? "")).maybeSingle();
    if (!piece) throw new UserError("Piece not found.", 404);
    await requireRole(user.id, piece.company_id, "member");
    if (piece.stage !== "done") throw new UserError("Finish and sign off the piece before sending it to WordPress.");
    const html = String(body.html ?? "");
    if (!html.trim()) throw new UserError("The piece has no text to send.");

    const { data: target } = await admin.from("publishing_targets")
      .select("id, site_url, username, publishing_target_secrets(ciphertext, iv)")
      .eq("company_id", piece.company_id).eq("kind", "wordpress").maybeSingle();
    if (!target) throw new UserError("Connect a WordPress site in Team & settings first.");
    const secret = Array.isArray(target.publishing_target_secrets) ? target.publishing_target_secrets[0] : target.publishing_target_secrets;
    if (!secret) throw new UserError("The WordPress connection is incomplete. Connect the site again.");
    const password = await decrypt(secret.ciphertext, secret.iv);

    const res = await wp(target.site_url, "/posts", basicAuth(target.username, password), {
      method: "POST",
      body: JSON.stringify({
        title: String(body.title ?? piece.title).slice(0, 300),
        content: html,
        excerpt: String(body.excerpt ?? "").slice(0, 500),
        status: "draft",
      }),
    });
    if (res.status === 401 || res.status === 403) throw new UserError("WordPress rejected the saved credentials. An editor can reconnect the site.");
    if (!res.ok) throw new UserError(`WordPress answered ${res.status}. Try again, or check the site.`, 502);
    const post = await res.json().catch(() => ({})) as { id?: number; link?: string };
    if (!post.id) throw new UserError("WordPress didn't return the new post.", 502);
    const editUrl = `${target.site_url}/wp-admin/post.php?post=${post.id}&action=edit`;

    await admin.from("piece_events").insert({
      company_id: piece.company_id, piece_id: piece.id, actor: user.id, action: "exported",
      detail: { kind: "wordpress", post_id: post.id, edit_url: editUrl, site: target.site_url },
    });
    return json({ post_id: post.id, edit_url: editUrl });
  }

  throw new UserError("Unknown action.");
}));
