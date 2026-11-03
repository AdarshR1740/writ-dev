// Fetch a public web page and return its readable text, so users can add a
// source by URL. Sites that block scraping return a "paste instead" answer.

import { handle, json } from "../_shared/cors.ts";
import { requireRole, requireUser } from "../_shared/supabase.ts";
import { fetchPage } from "../_shared/web.ts";

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  await requireRole(user.id, body.company_id ?? "", "member");
  return json(await fetchPage(String(body.url ?? "")));
}));
