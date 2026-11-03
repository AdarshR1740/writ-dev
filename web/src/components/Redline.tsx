import { diffWordsWithSpace } from "diff";

/** Show the change from `before` to `after` as insertions and deletions. */
export function Redline({ before, after }: { before: string; after: string }) {
  const parts = diffWordsWithSpace(before, after);
  return (
    <div className="redline-body">
      {parts.map((p, i) =>
        p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>
      )}
    </div>
  );
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of diffWordsWithSpace(before, after)) {
    const words = p.value.trim() ? p.value.trim().split(/\s+/).length : 0;
    if (p.added) added += words;
    else if (p.removed) removed += words;
  }
  return { added, removed };
}
