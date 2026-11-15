import type { Block } from "./types";

/** The outline editor's rows: a main heading (level 2) and the sub-headings (level 3) under it, in document order. */
export interface Draft {
  key: string;
  /** 2 is a main heading (H2); 3 is a sub-heading (H3) under the main heading above it. */
  level: 2 | 3;
  /** How much a sub-heading should say. Guidance for writing, never a cut-off. */
  depth: "short" | "standard" | "deep";
  heading: string;
  purpose: string;
  expectation_ids: string[];
  /** What goes under the heading, block by block. Empty until planned. */
  structure: Block[];
}

export const asDepth = (d: unknown): Draft["depth"] => (d === "short" || d === "deep" ? d : "standard");
export const DEPTH_LABELS: Record<Draft["depth"], string> = { short: "Short note", standard: "Standard", deep: "Deep dive" };

/** A main heading with no name but with sub-headings under it can't be saved: its sub-headings would join the heading above. */
export const blankMainWithSubs = (list: Draft[]) => list.some((s, i) => s.level === 2 && !s.heading.trim() && list[i + 1]?.level === 3);

/** Where the group that starts at `i` ends: a main heading and the sub-headings under it. */
export const groupEnd = (list: Draft[], i: number) => {
  let end = i + 1;
  while (end < list.length && list[end].level === 3) end += 1;
  return end;
};

/** Moves the main heading at `i`, with its sub-headings, past the previous or next main heading. */
export function moveGroup(list: Draft[], i: number, d: -1 | 1): Draft[] {
  const end = groupEnd(list, i);
  const block = list.slice(i, end);
  if (d === -1) {
    let p = i - 1;
    while (p >= 0 && list[p].level === 3) p -= 1;
    if (p < 0) return list;
    return [...list.slice(0, p), ...block, ...list.slice(p, i), ...list.slice(end)];
  }
  if (end >= list.length) return list;
  const nextEnd = groupEnd(list, end);
  return [...list.slice(0, i), ...list.slice(end, nextEnd), ...block, ...list.slice(nextEnd)];
}

/** Moves the sub-heading at `i` up or down. At the edge of its group it crosses into the neighbouring main heading's group. */
export function moveSub(list: Draft[], i: number, d: -1 | 1): Draft[] {
  const row = list[i];
  if (d === -1) {
    if (i === 0) return list;
    if (list[i - 1].level === 3) return [...list.slice(0, i - 1), row, list[i - 1], ...list.slice(i + 1)];
    // The row above is its own main heading: go to the end of the previous group, if there is one.
    if (i - 1 === 0) return list;
    return [...list.slice(0, i - 1), row, list[i - 1], ...list.slice(i + 1)];
  }
  if (i + 1 >= list.length) return list;
  if (list[i + 1].level === 3) return [...list.slice(0, i), list[i + 1], row, ...list.slice(i + 2)];
  // The row below is the next main heading: become the first sub-heading under it.
  return [...list.slice(0, i), list[i + 1], row, ...list.slice(i + 2)];
}

/** Makes the row at `i` a main heading, or a sub-heading under the main heading above. A demoted row's contract points go to that main heading. */
export function setLevel(list: Draft[], i: number, level: 2 | 3): Draft[] {
  const row = list[i];
  if (level === 2) return list.map((s, j) => (j === i ? { ...s, level: 2, depth: "standard" } : s));
  let p = i - 1;
  while (p >= 0 && list[p].level === 3) p -= 1;
  if (p < 0) return list;
  return list.map((s, j) => {
    if (j === i) return { ...s, level: 3, expectation_ids: [] };
    if (j === p) return { ...s, expectation_ids: [...new Set([...s.expectation_ids, ...row.expectation_ids])] };
    return s;
  });
}
