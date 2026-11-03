import { UserError } from "./cors.ts";

// AES-256-GCM encryption for provider API keys.
// KEY_ENCRYPTION_SECRET must be 32 random bytes, base64-encoded
// (scripts/dev.sh makes one locally). It never leaves the server.

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

let cached: CryptoKey | null = null;
async function key(): Promise<CryptoKey> {
  if (cached) return cached;
  const raw = Deno.env.get("KEY_ENCRYPTION_SECRET");
  // Setup problems are shown in full: they name a setting, never a key.
  if (!raw) {
    throw new UserError("Server setup: KEY_ENCRYPTION_SECRET isn't set for the functions. Locally, stop the app and run ./scripts/dev.sh again; on Supabase, set it with `supabase secrets set`.", 500);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unb64(raw.trim());
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes.length !== 32) throw new UserError("Server setup: KEY_ENCRYPTION_SECRET must be 32 random bytes, base64-encoded.", 500);
  cached = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return cached;
}

export async function encrypt(plain: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain));
  return { ciphertext: b64(new Uint8Array(out)), iv: b64(iv) };
}

export async function decrypt(ciphertext: string, iv: string): Promise<string> {
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ciphertext));
  return new TextDecoder().decode(out);
}
