import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Signs in as the writer, with the same email and password as the Writ web app. The session lives only in this process
 * and refreshes itself, so Writ's row-level security applies to everything the tools do.
 */
export async function signedInClient(env: NodeJS.ProcessEnv = process.env): Promise<SupabaseClient> {
  const url = env.WRIT_SUPABASE_URL;
  const anon = env.WRIT_SUPABASE_ANON_KEY;
  const email = env.WRIT_EMAIL;
  const password = env.WRIT_PASSWORD;
  const missing = [["WRIT_SUPABASE_URL", url], ["WRIT_SUPABASE_ANON_KEY", anon], ["WRIT_EMAIL", email], ["WRIT_PASSWORD", password]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}. See the README.`);
  const db = createClient(url!, anon!, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await db.auth.signInWithPassword({ email: email!, password: password! });
  if (error) throw new Error(`Could not sign in to Writ: ${error.message}`);
  return db;
}
