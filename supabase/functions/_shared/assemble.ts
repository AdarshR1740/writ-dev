/**
 * Putting a piece's sections back together as one Markdown text. A section row is a main heading (level 2) or a
 * sub-heading (level 3) under the main heading above it, so each is written with its own number of #.
 * The same rule is in web/src/lib/assemble.ts: keep the two in step.
 */
export interface AssemblyRow {
  heading: string;
  content: string;
  /** 2 for a main heading (the default), 3 for a sub-heading. */
  level?: number | null;
}

export function headingLine(row: Pick<AssemblyRow, "heading" | "level">): string {
  return `${row.level === 3 ? "###" : "##"} ${row.heading}`;
}

/** Every section as its heading line and its text, in the order given. */
export function assemble(rows: AssemblyRow[], opts: { trim?: boolean } = {}): string {
  return rows.map((r) => `${headingLine(r)}\n\n${opts.trim ? r.content.trim() : r.content}`).join("\n\n");
}
