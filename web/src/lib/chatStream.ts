import { supabase } from "./supabase";
import type { ThreadMessage } from "./types";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export interface ChatEvents {
  /** The model started a web search. */
  onStatus?: (text: string) => void;
  /** A piece of the reply text, as it is written. */
  onDelta: (text: string) => void;
  /** The model proposed a scope or an outline. */
  onSuggestion?: (suggestion: NonNullable<ThreadMessage["payload"]>) => void;
}

/**
 * Sends one chat turn to the `ai` function and reads the reply as it streams in. Resolves with the saved AI
 * message; throws with the server's message on any failure.
 */
export async function streamChat(body: Record<string, unknown>, events: ChatEvents, signal?: AbortSignal): Promise<ThreadMessage> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${url}/functions/v1/ai`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey ?? "",
      Authorization: `Bearer ${data.session?.access_token ?? anonKey ?? ""}`,
    },
    body: JSON.stringify({ task: "chat", ...body }),
  });
  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error ?? "Couldn't reach the server. Wait a few seconds and try again.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: ThreadMessage | null = null;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 2);
      if (!raw.startsWith("data:")) continue;
      const event = JSON.parse(raw.slice(5).trim()) as { type: string; text?: string; error?: string; suggestion?: ThreadMessage["payload"]; message?: ThreadMessage };
      if (event.type === "delta" && event.text) events.onDelta(event.text);
      else if (event.type === "status" && event.text) events.onStatus?.(event.text);
      else if (event.type === "suggestion" && event.suggestion) events.onSuggestion?.(event.suggestion);
      else if (event.type === "done" && event.message) done = event.message;
      else if (event.type === "error") throw new Error(event.error ?? "Something went wrong. Try again.");
    }
  }
  if (!done) throw new Error("The reply was cut off. Try again.");
  return done;
}
