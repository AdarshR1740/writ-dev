/**
 * Who this browser tab is, for edit locks. It is sent with every database request (the x-writ-client header), so the database
 * can tell this tab from another tab of the same person, and from Claude. Kept per tab: sessionStorage survives a reload but
 * is not shared between tabs.
 */
function make(): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web-${id}`;
}

export const CLIENT_ID: string = (() => {
  const key = "writ.clientId";
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const id = make();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    // Storage is blocked: this tab is still one client for as long as it stays open.
    return make();
  }
})();
