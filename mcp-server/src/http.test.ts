import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { claimsOf, configFromEnv, startHttp, type Caller } from "./http.js";

const APP = "claude-app";
const people: Record<string, Caller> = {
  "tok-ann": { userId: "ann", clientId: APP },
  "tok-bob": { userId: "bob", clientId: APP },
  "tok-web": { userId: "ann", clientId: null }, // the web app's own sign-in: no OAuth app
  "tok-other": { userId: "ann", clientId: "somebody-else" },
};
let server: Server | null = null;
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = null; });

async function start(makeClient?: (token: string, lockId: string) => SupabaseClient) {
  server = await startHttp(
    { port: 0, host: "127.0.0.1", publicUrl: "https://writ.example", supabaseUrl: "https://x.supabase.co", anonKey: "anon", allowedClients: [APP] },
    { verify: async (t) => people[t] ?? null, makeClient },
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const connect = async (base: string, token: string) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const post = (base: string, headers: Record<string, string>, body: unknown = init) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("hosted MCP server", () => {
  it("tells Claude where to sign in when there is no token", async () => {
    const base = await start();
    const r = await post(base, {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://writ.example/.well-known/oauth-protected-resource/mcp"');
    expect((await post(base, { Authorization: "Bearer nope" })).status).toBe(401);
  });

  it("publishes where the sign-in server is", async () => {
    const base = await start();
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await fetch(base + p)).json()).toMatchObject({ resource: "https://writ.example/mcp", authorization_servers: ["https://x.supabase.co/auth/v1"] });
    }
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("refuses tokens that were not issued to an approved app, including the web app's own", async () => {
    const base = await start();
    expect((await post(base, { Authorization: "Bearer tok-web" })).status).toBe(403);
    expect((await post(base, { Authorization: "Bearer tok-other" })).status).toBe(403);
  });

  it("serves the same tools as the local server, and runs them as the signed-in writer", async () => {
    const seen: { token: string; lockId: string }[] = [];
    const base = await start((token, lockId) => {
      seen.push({ token, lockId });
      return { from: () => { throw new Error("db reached"); } } as unknown as SupabaseClient;
    });
    const ann = await connect(base, "tok-ann");
    expect((await ann.listTools()).tools).toHaveLength(30);
    const r = await ann.callTool({ name: "writ_list_pieces", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/db reached/);
    const bob = await connect(base, "tok-bob");
    await bob.callTool({ name: "writ_list_pieces", arguments: {} });
    expect(seen.map((s) => s.token)).toEqual(["tok-ann", "tok-bob"]);
    expect(seen[0].lockId).toMatch(/^ai-/);
    expect(seen[0].lockId).not.toBe(seen[1].lockId); // each chat has its own edit-lock identity
    await ann.close(); await bob.close();
  });

  it("keeps a session to the person who started it", async () => {
    const base = await start();
    const first = await post(base, { Authorization: "Bearer tok-ann" });
    const sid = first.headers.get("mcp-session-id")!;
    expect(first.status).toBe(200);
    const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
    expect((await post(base, { Authorization: "Bearer tok-bob", "mcp-session-id": sid }, ping)).status).toBe(403);
    expect((await post(base, { Authorization: "Bearer tok-ann", "mcp-session-id": "missing" }, ping)).status).toBe(404);
    expect((await post(base, { Authorization: "Bearer tok-ann" }, ping)).status).toBe(400);
  });
});

describe("limits", () => {
  it("caps how many chats one person can keep open", async () => {
    const base = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(base, { Authorization: "Bearer tok-ann" })).status);
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await post(base, { Authorization: "Bearer tok-bob" })).status).toBe(200); // someone else is not affected
  });
});

describe("settings and tokens", () => {
  it("reads the settings and says what is missing", () => {
    const env = { WRIT_PUBLIC_URL: "https://writ.example/", WRIT_SUPABASE_URL: "https://x.supabase.co", WRIT_SUPABASE_ANON_KEY: "k", WRIT_OAUTH_CLIENT_IDS: "a, b" };
    expect(configFromEnv(env)).toMatchObject({ port: 3100, host: "127.0.0.1", publicUrl: "https://writ.example", allowedClients: ["a", "b"] });
    expect(() => configFromEnv({ ...env, WRIT_OAUTH_CLIENT_IDS: "" })).toThrow(/WRIT_OAUTH_CLIENT_IDS/);
  });

  it("reads the app a token was issued to", () => {
    const token = `h.${Buffer.from(JSON.stringify({ sub: "u1", client_id: "c1" })).toString("base64url")}.s`;
    expect(claimsOf(token)).toMatchObject({ sub: "u1", client_id: "c1" });
    expect(claimsOf("garbage")).toEqual({});
  });
});
