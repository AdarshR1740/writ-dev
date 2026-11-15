/**
 * The outline as a list of rows in document order: a main heading (level 2) and the sub-headings (level 3) under it. The pure
 * rules for changing one live here, apart from the AI calls, so they can be tested on their own.
 */

export const BLOCK_TYPES = ["answer", "paragraph", "bullets", "steps", "table", "example", "data", "subheading", "faq", "quote", "takeaway"] as const;

export function cleanBlocks(blocks: { type: string; note: string }[]): { type: string; note: string }[] {
  return blocks.filter((b) => (BLOCK_TYPES as readonly string[]).includes(b.type) && b.note?.trim())
    .map((b) => ({ type: b.type, note: b.note.trim() })).slice(0, 8);
}

export const LEVEL_DEPTHS = ["short", "standard", "deep"];

/**
 * Makes a list of outline sections safe to use: the first is a main heading, a level is 2 or 3, a depth is one of the three,
 * and a sub-heading owes no expectations (its main heading does).
 */
export function normaliseLevels<T extends { level?: number; depth?: string; expectations: number[] }>(rows: T[]): T[] {
  return rows.map((r, i) => {
    const sub = i > 0 && r.level === 3;
    return {
      ...r,
      level: sub ? 3 : 2,
      depth: sub && r.depth && LEVEL_DEPTHS.includes(r.depth) ? r.depth : "standard",
      expectations: sub ? [] : r.expectations,
    };
  });
}

export type OutlineChange = {
  kind: string; position: number; after: number; index: number; heading: string; purpose: string;
  expectations: number[]; blocks: { type: string; note: string }[]; check: string;
};
export type OutlineRow = {
  /** The section's number in the outline before any change; null for a section the changes add. */
  origin: number | null;
  heading: string;
  purpose: string;
  expectations: number[];
  blocks: { type: string; note: string }[];
  /** 2 for a main heading, 3 for a sub-heading under the main heading above it. */
  level: 2 | 3;
  depth: string;
  /** Set when these changes added or moved the section: the section it was put after (0 = first). Later ones placed after the same section keep their order. */
  placedAfter?: number;
};

/**
 * Applies the AI's small changes to the outline and returns the result. Nothing is ever removed: every section and
 * block the outline had is still there afterwards. A change that doesn't make sense (an unknown section, an empty
 * heading, a heading that already exists) is ignored, and at most 8 are applied.
 */
export function applyOutlineChanges(
  sections: { position: number; heading: string; purpose: string; expectations: number[]; blocks: { type: string; note: string }[]; level?: number | null; depth?: string | null }[],
  expectationCount: number,
  changes: OutlineChange[],
  currentTitle = "",
): { rows: OutlineRow[]; title: string | null; summary: { edited: number; added: number; moved: number; blocks: number } } {
  const rows: OutlineRow[] = sections.map((s) => ({
    origin: s.position, heading: s.heading, purpose: s.purpose, expectations: [...s.expectations], blocks: cleanBlocks(s.blocks),
    level: s.level === 3 ? 3 : 2, depth: s.depth ?? "standard",
  }));
  const byOrigin = (n: number) => rows.find((r) => r.origin === n);
  const goodNumbers = (nums: number[]) => nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= expectationCount);
  const headingTaken = (h: string) => rows.some((r) => r.heading.trim().toLowerCase() === h.trim().toLowerCase());
  const edited = new Set<OutlineRow>();
  const moved = new Set<OutlineRow>();
  let added = 0;
  let blocksAdded = 0;

  /** A place is "first" (0) or just after a section the outline had. Anything else is not a place. */
  const validAfter = (after: number) => after === 0 || (Number.isInteger(after) && byOrigin(after) !== undefined);
  // A main heading and the sub-headings under it move and stay together: the group ends where the next main heading starts.
  const groupEnd = (from: number) => {
    let end = from + 1;
    while (end < rows.length && rows[end].level === 3) end += 1;
    return end;
  };
  const place = (row: OutlineRow, after: number): boolean => {
    const old = rows.indexOf(row);
    const group = old >= 0 ? rows.slice(old, groupEnd(old)) : [row];
    // A place inside the group being moved is not a place.
    const target = after > 0 ? byOrigin(after) : undefined;
    if (target && group.includes(target)) return false;
    if (old >= 0) rows.splice(old, group.length);
    let at = 0;
    // Just after a section means after its sub-headings too, so a new main heading never splits them from their own.
    if (target) at = groupEnd(rows.indexOf(target) >= 0 ? rows.indexOf(target) : 0);
    // Sections already put after this same place stay ahead of this one.
    while (at < rows.length && rows[at].placedAfter === after) at = groupEnd(at);
    row.placedAfter = after;
    rows.splice(at, 0, ...group);
    return true;
  };

  let title: string | null = null;
  for (const c of changes.slice(0, 12)) {
    const row = byOrigin(c.position);
    if (c.kind === "edit_title") {
      // The working title: a new one, within a sensible length, that is actually different.
      const next = c.heading.trim().replace(/\s+/g, " ");
      if (next && next.length <= 120 && next !== currentTitle.trim()) title = next;
    } else if (c.kind === "edit_section" && row) {
      const heading = c.heading.trim();
      if (heading && heading !== row.heading && !headingTaken(heading)) { row.heading = heading; edited.add(row); }
      if (c.purpose.trim() && c.purpose.trim() !== row.purpose) { row.purpose = c.purpose.trim(); edited.add(row); }
      // Contract expectations belong to main headings; a sub-heading owes none.
      const more = row.level === 3 ? [] : goodNumbers(c.expectations).filter((n) => !row.expectations.includes(n));
      if (more.length) { row.expectations.push(...more); edited.add(row); }
    } else if (c.kind === "add_section") {
      const heading = c.heading.trim();
      if (!heading || headingTaken(heading) || !validAfter(c.after)) continue;
      const fresh: OutlineRow = { origin: null, heading, purpose: c.purpose.trim(), expectations: [...new Set(goodNumbers(c.expectations))], blocks: cleanBlocks(c.blocks), level: 2, depth: "standard" };
      place(fresh, c.after);
      added += 1;
    } else if (c.kind === "move_section" && row && row.level === 2 && c.after !== c.position && validAfter(c.after)) {
      // Only a main heading is moved (with its sub-headings); a sub-heading stays where it is.
      if (place(row, c.after)) moved.add(row);
    } else if (c.kind === "add_block" && row) {
      const fresh = cleanBlocks(c.blocks);
      // 8 is the most blocks a section keeps (cleanBlocks), so more would be cut on the next save.
      if (!fresh.length || row.blocks.length + fresh.length > 8) continue;
      if (c.index >= 1 && c.index <= row.blocks.length) row.blocks.splice(c.index - 1, 0, ...fresh);
      else row.blocks.push(...fresh);
      blocksAdded += fresh.length;
      edited.add(row);
    } else if (c.kind === "edit_block" && row) {
      const next = cleanBlocks(c.blocks)[0];
      if (!next || c.index < 1 || c.index > row.blocks.length) continue;
      row.blocks[c.index - 1] = next;
      edited.add(row);
    }
  }
  return { rows, title, summary: { edited: edited.size, added, moved: moved.size, blocks: blocksAdded } };
}
