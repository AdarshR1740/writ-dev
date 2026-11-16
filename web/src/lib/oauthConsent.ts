/**
 * Where an approved connection may send the writer back to. Anyone can try to start a sign-in with an app called "Claude", so the
 * consent page trusts the address the app returns to, never the name it gives itself.
 */
const TRUSTED_CALLBACKS = [
  { host: "claude.ai", path: "/api/mcp/auth_callback" },
  { host: "claude.com", path: "/api/mcp/auth_callback" },
];

export function isTrustedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && TRUSTED_CALLBACKS.some((t) => u.hostname === t.host && u.pathname === t.path);
  } catch {
    return false;
  }
}
