// Save, activate and remove a company's AI provider keys. Editors only.
// Keys are checked against the provider, encrypted, and never returned.

import { handle, json, UserError } from "../_shared/cors.ts";
import { admin, requireRole, requireUser } from "../_shared/supabase.ts";
import { decrypt, encrypt } from "../_shared/crypto.ts";
import { listModels, verifyKey } from "../_shared/llm.ts";
import type { Provider } from "../_shared/models.ts";

const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini", "local"];

function hint(key: string): string {
  return `…${key.slice(-4)}`;
}

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const { action, company_id: companyId, provider } = body as {
    action?: string;
    company_id?: string;
    provider?: Provider;
  };
  await requireRole(user.id, companyId ?? "", "editor");
  if (!provider || !PROVIDERS.includes(provider)) throw new UserError("Choose a provider.");

  if (action === "save") {
    const isLocal = provider === "local";
    // Local models often need no key; we store a placeholder so the row is uniform.
    const apiKey = String(body.api_key ?? "").trim() || (isLocal ? "none" : "");
    const baseUrl = isLocal ? String(body.base_url ?? "").trim().replace(/\/+$/, "") : null;
    if (!isLocal && apiKey.length < 20) throw new UserError("That doesn't look like a complete API key.");
    await verifyKey(provider, apiKey, baseUrl);
    const { ciphertext, iv } = await encrypt(apiKey);

    // Stay active when replacing the active provider's key; become active if no provider is.
    const { data: active } = await admin
      .from("provider_keys").select("id, provider").eq("company_id", companyId).eq("is_active", true).maybeSingle();
    const makeActive = !active || active.provider === provider;

    const { data: row, error } = await admin
      .from("provider_keys")
      .upsert(
        {
          company_id: companyId,
          provider,
          key_hint: isLocal ? (apiKey === "none" ? "no key" : hint(apiKey)) : hint(apiKey),
          base_url: baseUrl,
          created_by: user.id,
          is_active: makeActive,
        },
        { onConflict: "company_id,provider" },
      )
      .select("id, is_active")
      .single();
    if (error) throw error;
    const { error: secretError } = await admin
      .from("provider_key_secrets")
      .upsert({ key_id: row.id, ciphertext, iv });
    if (secretError) throw secretError;
    return json({ ok: true, is_active: row.is_active });
  }

  if (action === "activate") {
    const { data: row } = await admin
      .from("provider_keys").select("id").eq("company_id", companyId).eq("provider", provider).maybeSingle();
    if (!row) throw new UserError("Add a key for this provider first.");
    // One active provider at a time: clear the current one, then set the new one.
    const { error: offError } = await admin
      .from("provider_keys").update({ is_active: false }).eq("company_id", companyId).eq("is_active", true);
    if (offError) throw offError;
    const { error: onError } = await admin.from("provider_keys").update({ is_active: true }).eq("id", row.id);
    if (onError) throw onError;
    return json({ ok: true });
  }

  if (action === "remove") {
    const { error } = await admin
      .from("provider_keys").delete().eq("company_id", companyId).eq("provider", provider);
    if (error) throw error;
    return json({ ok: true });
  }

  // The models this provider's key can use, for the model pickers in AI settings.
  if (action === "models") {
    const { data: row } = await admin
      .from("provider_keys").select("base_url, provider_key_secrets(ciphertext, iv)")
      .eq("company_id", companyId).eq("provider", provider).maybeSingle();
    const secret = row && (Array.isArray(row.provider_key_secrets) ? row.provider_key_secrets[0] : row.provider_key_secrets);
    if (!row || !secret) throw new UserError("Add a key for this provider first.");
    try {
      return json({ models: await listModels(provider, await decrypt(secret.ciphertext, secret.iv), row.base_url) });
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError("Couldn't get the model list from the provider. You can type a model ID instead.", 502);
    }
  }

  throw new UserError("Unknown action.");
}));
