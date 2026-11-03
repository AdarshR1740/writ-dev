// Fetching public web pages safely: used for URL sources, quote
// verification, and checking local-model endpoints.

import { UserError } from "./cors.ts";

// Sites that block automated fetching. Users paste these instead.
export const PASTE_ONLY_DOMAINS = [
  "linkedin.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
];

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;

export function isPasteOnly(host: string): boolean {
  return PASTE_ONLY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v === "::" ||
      v.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function assertPublicHost(host: string): Promise<void> {
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".")) {
    throw new UserError("Use a public web address.");
  }
  const addrs = [
    ...(await Deno.resolveDns(host, "A").catch(() => [] as string[])),
    ...(await Deno.resolveDns(host, "AAAA").catch(() => [] as string[])),
  ];
  if (addrs.length === 0) throw new UserError("That address doesn't resolve. Check the URL.");
  if (addrs.some(isPrivateAddress)) throw new UserError("Use a public web address.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Turn page HTML into plain text with headings and list items kept. */
export function htmlToText(html: string): { title: string; text: string; published: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  const published =
    html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|date|pubdate)["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ?? "";
  let body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
  return { title, text, published };
}


export type PageResult =
  | { ok: true; url: string; title: string; text: string; published: string }
  | { ok: false; paste: boolean; reason: string; redirect?: string | null };

/** Fetch a public page as readable text. Never throws for site problems. */
export async function fetchPage(raw: string): Promise<PageResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError("Enter a full web address, starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserError("Use an http or https address.");
  const host = url.hostname.toLowerCase();
  if (isPasteOnly(host)) return { ok: false, paste: true, reason: `${host} blocks automated fetching. Paste the text instead.` };
  await assertPublicHost(host);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WriterBot/1.0)", Accept: "text/html,text/plain" },
    });
  } catch {
    return { ok: false, paste: true, reason: "The page didn't respond. Paste the text instead." };
  }
  if (res.status >= 300 && res.status < 400) {
    const next = res.headers.get("location");
    return { ok: false, paste: false, redirect: next ? new URL(next, url).toString() : null, reason: "This address redirects. Try the final address." };
  }
  if (!res.ok) return { ok: false, paste: true, reason: `The site answered ${res.status}. Paste the text instead.` };
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    return { ok: false, paste: true, reason: "That address isn't a web page. Upload the file instead." };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return { ok: false, paste: true, reason: "The page is too large to fetch. Paste the part you need." };
  const html = new TextDecoder().decode(buf);
  const page = type.includes("text/plain") ? { title: "", text: html.trim(), published: "" } : htmlToText(html);
  if (page.text.length < 200) {
    return { ok: false, paste: true, reason: "Couldn't find readable text on the page (it may need a browser to load). Paste the text instead." };
  }
  return { ok: true, url: url.toString(), ...page };
}

/** Normalise text for quote matching: case, whitespace, quotes and dashes. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019\u201b]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ").trim();
}

/** True when the quote appears verbatim (after normalising) in the text. */
export function quoteFound(quote: string, text: string): boolean {
  const q = normalise(quote).replace(/^\W+|\W+$/g, "");
  if (q.length < 12) return false;
  return normalise(text).includes(q);
}
