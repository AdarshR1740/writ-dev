import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, log } from "./server.js";

/** The hosted server: one endpoint, /mcp, where each writer signs in through Supabase's OAuth server (no passwords are stored here). */
export type HttpConfig = {
  port: number;
  host: string;
  /** The public address of this server, for example https://writ-v1.duckdns.org */
  publicUrl: string;
  supabaseUrl: string;
  anonKey: string;
  /** Only tokens issued to these OAuth apps are accepted. */
  allowedClients: string[];
};

export function configFromEnv(env: NodeJS.ProcessEnv): HttpConfig {
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) throw new Error(`Missing setting ${k}. See docs/hosting.md.`); return v; };
  const allowedClients = need("WRIT_OAUTH_CLIENT_IDS").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(env.PORT ?? 3100),
    host: env.HOST ?? "127.0.0.1",
    publicUrl: need("WRIT_PUBLIC_URL").replace(/\/+$/, ""),
    supabaseUrl: need("WRIT_SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: need("WRIT_SUPABASE_ANON_KEY"),
    allowedClients,
  };
}

export type Caller = { userId: string; clientId: string | null };
export type HttpDeps = {
  /** Checks a bearer token; null when it is not valid. */
  verify?: (token: string) => Promise<Caller | null>;
  /** A Supabase client that acts as the token's owner. */
  makeClient?: (token: string, lockId: string) => SupabaseClient;
};

/** The claims inside a JWT. Only read after Supabase has accepted the token itself. */
export function claimsOf(token: string): { sub?: string; client_id?: string } {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
}

type Session = { transport: StreamableHTTPServerTransport; userId: string; state: { token: string }; touched: number };

const IDLE_MS = 4 * 60 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_SESSIONS_PER_USER = 10;

export async function startHttp(cfg: HttpConfig, deps: HttpDeps = {}): Promise<Server> {
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const anon = createClient(cfg.supabaseUrl, cfg.anonKey, noSession);
  const verify = deps.verify ?? (async (token: string): Promise<Caller | null> => {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id, clientId: claimsOf(token).client_id ?? null };
  });
  const makeClient = deps.makeClient ?? ((token: string, lockId: string) =>
    createClient(cfg.supabaseUrl, cfg.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}`, "x-writ-client": lockId } } }));

  // Asking Supabase about the same token on every request is wasteful: remember a good answer for a minute.
  const verified = new Map<string, { caller: Caller | null; until: number }>();
  async function authenticate(token: string): Promise<Caller | null> {
    const hit = verified.get(token);
    if (hit && hit.until > Date.now()) return hit.caller;
    const caller = await verify(token);
    if (!caller) {
      // A wrong token is remembered for a few seconds too, so a flood of bad requests doesn't become a flood of calls to Supabase.
      verified.set(token, { caller: null, until: Date.now() + 10_000 });
      return null;
    }
    verified.set(token, { caller, until: Date.now() + 60_000 });
    if (verified.size > 500) for (const [k, v] of verified) if (v.until < Date.now()) verified.delete(k);
    return caller;
  }

  const metadataUrl = `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const sessions = new Map<string, Session>();

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const rpcError = (res: ServerResponse, status: number, message: string, headers?: Record<string, string>) =>
    json(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error("too large");
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const caller = bearer ? await authenticate(bearer) : null;
    if (!bearer || !caller) {
      return rpcError(res, 401, "Sign in to Writ to use this server.", { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` });
    }
    // Only tokens issued to an approved OAuth app: the web app's own sign-in token has no client and is refused.
    if (!caller.clientId || !cfg.allowedClients.includes(caller.clientId)) {
      return rpcError(res, 403, "This app is not allowed to use Writ.");
    }

    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let body: unknown;
    if (req.method === "POST") {
      try { body = await readBody(req); } catch { return rpcError(res, 400, "The request body is not valid JSON."); }
    } else if (req.method !== "GET" && req.method !== "DELETE") {
      return rpcError(res, 405, "Method not allowed.", { allow: "GET, POST, DELETE" });
    }

    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return rpcError(res, 404, "Session not found. Start a new one.");
      if (s.userId !== caller.userId) return rpcError(res, 403, "This session belongs to someone else.");
      s.state.token = bearer; // Claude refreshes its token now and then; use the newest.
      s.touched = Date.now();
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "Start with an initialize request.");

    if ([...sessions.values()].filter((x) => x.userId === caller.userId).length >= MAX_SESSIONS_PER_USER) {
      return rpcError(res, 429, "Too many open Claude chats on Writ. Close some, or wait a while.");
    }
    const lockId = `ai-${randomUUID()}`;
    const state = { token: bearer };
    let current: { token: string; client: SupabaseClient } | null = null;
    const db = async () => {
      if (!current || current.token !== state.token) current = { token: state.token, client: makeClient(state.token, lockId) };
      return current.client;
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, userId: caller.userId, state, touched: Date.now() }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await buildServer({ db, clientId: lockId }).connect(transport);
    return transport.handleRequest(req, res, body);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    (async () => {
      if (path === "/healthz") return json(res, 200, { ok: true });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return json(res, 200, { resource: `${cfg.publicUrl}/mcp`, authorization_servers: [`${cfg.supabaseUrl}/auth/v1`], bearer_methods_supported: ["header"] });
      }
      if (path === "/mcp") return handleMcp(req, res);
      return json(res, 404, { error: "Not found" });
    })().catch((e) => {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) rpcError(res, 500, "Something went wrong."); else res.end();
    });
  });

  const sweep = setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.touched > IDLE_MS) { sessions.delete(id); void s.transport.close(); }
  }, 10 * 60 * 1000);
  sweep.unref();
  server.on("close", () => clearInterval(sweep));

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, cfg.host, resolve); });
  log(`listening on ${cfg.host}:${cfg.port}`);
  return server;
}
