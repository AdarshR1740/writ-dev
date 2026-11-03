import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { UserError } from "./cors.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client: bypasses RLS. Only use after checking membership. */
export const admin: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

export async function requireUser(req: Request): Promise<{ id: string; email: string }> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new UserError("Sign in first.", 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new UserError("Your session has expired. Sign in again.", 401);
  return { id: data.user.id, email: data.user.email ?? "" };
}

export async function requireRole(
  userId: string,
  companyId: string,
  role: "member" | "editor",
): Promise<void> {
  if (typeof companyId !== "string" || !companyId) throw new UserError("Missing company.");
  const { data, error } = await admin
    .from("memberships")
    .select("role")
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError("You're not a member of this company.", 403);
  if (role === "editor" && data.role !== "editor") {
    throw new UserError("Only editors can do this.", 403);
  }
}
