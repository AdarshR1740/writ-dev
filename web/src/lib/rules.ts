const MIN = 3;
const MAX = 500;

/**
 * Voice rules from a pasted list: one per line. Bullets and numbering are stripped, headings and lines
 * that are too short or too long are skipped, and duplicates (also of rules already saved) are dropped.
 */
export function parseRules(raw: string, existing: string[] = []): string[] {
  const seen = new Set(existing.map((r) => r.trim().toLowerCase()));
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const rule = line.replace(/^\s*(?:[-*•–—]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim();
    if (rule.length < MIN || rule.length > MAX || /^#{1,6}\s/.test(rule) || /:$/.test(rule)) continue;
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}
