#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signedInClient } from "./client.js";
import { CLIENT_ID } from "./client-id.js";
import { buildServer, log } from "./server.js";

async function main() {
  // Hosted: `node dist/index.js --http` (see docs/hosting.md). Anything else is the local stdio server.
  if (process.argv.includes("--http")) {
    const { startHttp, configFromEnv } = await import("./http.js");
    await startHttp(configFromEnv(process.env));
    return;
  }
  // stdio: one writer, signed in from the environment, for the life of the process.
  let session: Promise<SupabaseClient> | null = null;
  const db = () => (session ??= signedInClient().catch((e) => { session = null; throw e; }));
  await buildServer({ db, clientId: CLIENT_ID }).connect(new StdioServerTransport());
  log("ready");
}
main().catch((e) => { log(e instanceof Error ? e.message : String(e)); process.exit(1); });
