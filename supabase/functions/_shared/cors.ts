export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** An error whose message is safe to show the user. */
export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof UserError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  };
}
