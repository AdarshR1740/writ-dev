// Export a finished piece: Markdown, HTML (file, clipboard, WordPress) and Word.
// Section text is plain Markdown-ish writing: paragraphs, ### and #### subheads, - and 1. lists, tables,
// **bold**, *italic* and [links](https://…). Everything else is kept as text.

export interface ExportSection { heading: string; content: string }
export interface ExportSource { title: string; url: string | null; published: string | null }
export interface ExportPiece {
  title: string;
  sections: ExportSection[];
  disclosure?: string | null;
  sources?: ExportSource[];
  metaTitle?: string | null;
  metaDescription?: string | null;
}

type Block =
  | { kind: "h2" | "h3" | "h4" | "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; rows: string[][] };

const tableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const tableRule = (l: string) => /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(l);
// A cell can hold an escaped pipe (\|), which is not a cell boundary.
const tableCells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

// The editor writes a backslash before characters that would otherwise read as Markdown (snake\_case, 2\*3). They are
// set aside while links, bold and italic are read, then put back as the plain character.
const ESCAPED = /\\([\\*_[\]()#|~>+!.-])/g;
const SET_ASIDE = /(\d+)/g;
const protect = (text: string) => text.replace(ESCAPED, (_m, ch: string) => `${ch.charCodeAt(0)}`);
const restore = (text: string, map: (ch: string) => string = (c) => c) =>
  text.replace(SET_ASIDE, (_m, code: string) => map(String.fromCharCode(Number(code))));
// A link address may hold one level of brackets, as in https://en.wikipedia.org/wiki/Foo_(bar).
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;

/** Sections as blocks. A single section headed like the piece doesn't repeat the title. */
export function toBlocks(piece: ExportPiece): Block[] {
  const single = piece.sections.length === 1 && piece.sections[0].heading.trim().toLowerCase() === piece.title.trim().toLowerCase();
  const out: Block[] = [];
  for (const s of piece.sections) {
    if (!single && s.heading.trim()) out.push({ kind: "h2", text: s.heading.trim() });
    for (const raw of s.content.trim().split(/\n{2,}/)) {
      const block = raw.trim();
      if (!block) continue;
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*] /.test(l))) out.push({ kind: "ul", items: lines.map((l) => l.replace(/^\s*[-*] /, "")) });
      else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) out.push({ kind: "ol", items: lines.map((l) => l.replace(/^\s*\d+[.)] /, "")) });
      else if (lines.length >= 2 && lines.every(tableRow) && tableRule(lines[1])) out.push({ kind: "table", rows: [lines[0], ...lines.slice(2)].map(tableCells) });
      else if (/^#{2,4} /.test(block) && lines.length === 1) out.push({ kind: block.startsWith("## ") ? "h2" : block.startsWith("### ") ? "h3" : "h4", text: block.replace(/^#+ /, "") });
      else out.push({ kind: "p", text: lines.join(" ") });
    }
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown to HTML. Only http(s) links become links. */
export function inlineHtml(text: string): string {
  const html = escapeHtml(protect(text))
    .replace(new RegExp(LINK_RE.source, "g"), (_m, label: string, url: string) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return restore(html, escapeHtml);
}

/** The body as HTML, without the title: what a CMS editor or WordPress wants. */
export function bodyHtml(piece: ExportPiece): string {
  const parts = toBlocks(piece).map((b) => {
    if (b.kind === "ul" || b.kind === "ol") return `<${b.kind}>\n${b.items.map((i) => `  <li>${inlineHtml(i)}</li>`).join("\n")}\n</${b.kind}>`;
    if (b.kind === "table") {
      const [head, ...body] = b.rows;
      return `<table>\n<thead><tr>${head.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead>\n<tbody>\n${body.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>`;
    }
    return `<${b.kind}>${inlineHtml(b.text)}</${b.kind}>`;
  });
  if (piece.sources?.length) {
    parts.push("<h2>Sources</h2>", `<ol>\n${piece.sources.map((s) => `  <li>${s.url ? `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title || s.url)}</a>` : escapeHtml(s.title)}${s.published ? `, ${escapeHtml(s.published)}` : ""}</li>`).join("\n")}\n</ol>`);
  }
  if (piece.disclosure?.trim()) parts.push(`<p><em>${escapeHtml(piece.disclosure.trim())}</em></p>`);
  return parts.join("\n");
}

/** A complete HTML document, for download. */
export function documentHtml(piece: ExportPiece): string {
  const meta = piece.metaDescription ? `\n<meta name="description" content="${escapeHtml(piece.metaDescription)}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(piece.metaTitle || piece.title)}</title>${meta}
</head>
<body>
<h1>${escapeHtml(piece.title)}</h1>
${bodyHtml(piece)}
</body>
</html>
`;
}

export function markdown(piece: ExportPiece): string {
  const blocks = toBlocks(piece).map((b) => {
    if (b.kind === "h2") return `## ${b.text}`;
    if (b.kind === "h3") return `### ${b.text}`;
    if (b.kind === "h4") return `#### ${b.text}`;
    if (b.kind === "ul") return b.items.map((i) => `- ${i}`).join("\n");
    if (b.kind === "ol") return b.items.map((i, n) => `${n + 1}. ${i}`).join("\n");
    if (b.kind === "table") {
      const row = (cs: string[]) => `| ${cs.join(" | ")} |`;
      return [row(b.rows[0]), row(b.rows[0].map(() => "---")), ...b.rows.slice(1).map(row)].join("\n");
    }
    return b.text;
  });
  if (piece.sources?.length) blocks.push("## Sources", piece.sources.map((s, i) => `${i + 1}. ${s.url ? `[${s.title || s.url}](${s.url})` : s.title}${s.published ? `, ${s.published}` : ""}`).join("\n"));
  if (piece.disclosure?.trim()) blocks.push(`*${piece.disclosure.trim()}*`);
  return `# ${piece.title}\n\n${blocks.join("\n\n")}\n`;
}

/** A Word document (opens in Word, Google Docs and Pages). Loaded only when asked for. */
export async function docxBlob(piece: ExportPiece): Promise<Blob> {
  const { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const runs = (raw: string) => {
    // Links, bold and italic, from the same Markdown as the HTML.
    const text = protect(raw);
    const out: InstanceType<typeof TextRun | typeof ExternalHyperlink>[] = [];
    const re = new RegExp(`${LINK_RE.source}|\\*\\*([^*]+)\\*\\*|\\*([^*\\s][^*]*)\\*`, "g");
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) out.push(new TextRun(restore(text.slice(last, m.index))));
      if (m[1]) out.push(new ExternalHyperlink({ link: m[2], children: [new TextRun({ text: restore(m[1]), style: "Hyperlink" })] }));
      else if (m[3]) out.push(new TextRun({ text: restore(m[3]), bold: true }));
      else out.push(new TextRun({ text: restore(m[4]), italics: true }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(new TextRun(restore(text.slice(last))));
    return out;
  };
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [new Paragraph({ text: piece.title, heading: HeadingLevel.TITLE })];
  for (const b of toBlocks(piece)) {
    if (b.kind === "h2") children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_1 }));
    else if (b.kind === "h3") children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 }));
    else if (b.kind === "h4") children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_3 }));
    else if (b.kind === "ul") b.items.forEach((i) => children.push(new Paragraph({ children: runs(i), bullet: { level: 0 } })));
    else if (b.kind === "ol") b.items.forEach((i, n) => children.push(new Paragraph({ children: [new TextRun(`${n + 1}. `), ...runs(i)], indent: { left: 360 } })));
    else if (b.kind === "table") {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({
          tableHeader: ri === 0,
          children: r.map((c) => new TableCell({ children: [new Paragraph({ children: ri === 0 ? [new TextRun({ text: c, bold: true })] : runs(c) })] })),
        })),
      }));
    } else children.push(new Paragraph({ children: runs(b.text) }));
  }
  if (piece.sources?.length) {
    children.push(new Paragraph({ text: "Sources", heading: HeadingLevel.HEADING_1 }));
    piece.sources.forEach((s, i) => children.push(new Paragraph({
      children: [
        new TextRun(`${i + 1}. `),
        s.url ? new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.title || s.url, style: "Hyperlink" })] }) : new TextRun(s.title),
        ...(s.published ? [new TextRun(`, ${s.published}`)] : []),
      ],
    })));
  }
  if (piece.disclosure?.trim()) children.push(new Paragraph({ children: [new TextRun({ text: piece.disclosure.trim(), italics: true })] }));
  const doc = new Document({ creator: "Writ", title: piece.title, description: piece.metaDescription ?? undefined, sections: [{ children }] });
  return Packer.toBlob(doc);
}

export function fileName(title: string, ext: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "piece"}.${ext}`;
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Copy as formatted text, so headings and links survive a paste into Google Docs, WordPress or Webflow. */
export async function copyFormatted(piece: ExportPiece): Promise<void> {
  const html = `<h1>${escapeHtml(piece.title)}</h1>\n${bodyHtml(piece)}`;
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([markdown(piece)], { type: "text/plain" }),
    })]);
  } else {
    await navigator.clipboard.writeText(markdown(piece));
  }
}
