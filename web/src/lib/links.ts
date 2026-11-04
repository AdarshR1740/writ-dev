export const MAX_LINKS = 10;

/** Links from a pasted block: one per line (commas or spaces also work), duplicates dropped. */
export function parseLinks(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const link = part.trim();
    if (/^https?:\/\/\S+$/i.test(link)) seen.add(link);
  }
  return [...seen];
}
