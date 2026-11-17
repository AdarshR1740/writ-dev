/** Words of text, not of Markdown: link addresses and the marks around headings, lists and emphasis are left out. */
export function countWords(markdown: string): number {
  const plain = markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#{1,6}|[-*]|\d+[.)])\s+/gm, "")
    .replace(/\*\*?|\\|\|/g, " ");
  const trimmed = plain.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
