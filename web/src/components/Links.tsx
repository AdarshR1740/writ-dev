import type { ReactNode } from "react";
import type { ResearchItem } from "../lib/types";

/** A markdown link in the text, [label](https://…), with where it sits so one occurrence can be changed. */
export interface TextLink {
  label: string;
  url: string;
  start: number;
  end: number;
}

// A link address may hold one level of brackets, as in https://en.wikipedia.org/wiki/Foo_(bar).
const URL_PART = String.raw`https?:\/\/(?:[^()\s]|\([^()\s]*\))+`;
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]\((${URL_PART})\)`, "g");

/** Every markdown link in the text, in order. */
export function findLinks(text: string): TextLink[] {
  return [...text.matchAll(LINK)].map((m) => ({ label: m[1], url: m[2], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** The text with one link turned back into plain words. */
export function unlink(text: string, link: TextLink): string {
  return `${text.slice(0, link.start)}${link.label}${text.slice(link.end)}`;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const same = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");

// Group 1 is a backslash-escaped character (the editor writes snake\_case and 2\*3), then a link, bold and italic.
const INLINE = new RegExp(String.raw`\\([\\*_\[\]()#|~>+!.-])|\[([^\]\n]+)\]\((${URL_PART})\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*`, "g");

/** Inline Markdown (links, bold, italic) as React nodes. Only http(s) links become links; nothing is injected as HTML. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    if (m[1]) nodes.push(m[1]);
    else if (m[2]) nodes.push(<a key={at} href={m[3]} target="_blank" rel="noreferrer" title={m[3]}>{renderInline(m[2])}</a>);
    else if (m[4]) nodes.push(<strong key={at}>{renderInline(m[4])}</strong>);
    else nodes.push(<em key={at}>{renderInline(m[5])}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableRule = (l: string) => /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(l);
// A cell can hold an escaped pipe (\|), which is not a cell boundary.
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * A section's Markdown, shown as a document: headings, lists, tables, bold, italic and links (which open in a new tab).
 * Used where text is only read: the complete draft and the sign-off view.
 */
export function MarkdownView({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className="linked-text">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const head = block.match(/^(#{2,4}) (.*)$/);
        if (head && lines.length === 1) return head[1] === "####" ? <h4 key={i}>{renderInline(head[2])}</h4> : <h3 key={i}>{renderInline(head[2])}</h3>;
        if (lines.every((l) => /^\s*[-*] /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{renderInline(l.replace(/^\s*[-*] /, ""))}</li>)}</ul>;
        if (lines.every((l) => /^\s*\d+[.)] /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{renderInline(l.replace(/^\s*\d+[.)] /, ""))}</li>)}</ol>;
        if (lines.length >= 2 && lines.every(isTableRow) && isTableRule(lines[1])) {
          const [header, , ...rows] = lines;
          return (
            <table key={i}>
              <thead><tr>{cells(header).map((c, j) => <th key={j}>{renderInline(c)}</th>)}</tr></thead>
              <tbody>{rows.map((r, j) => <tr key={j}>{cells(r).map((c, k) => <td key={k}>{renderInline(c)}</td>)}</tr>)}</tbody>
            </table>
          );
        }
        return <p key={i}>{renderInline(lines.join("\n"))}</p>;
      })}
    </div>
  );
}

/** The text with its links as real, clickable links (opening in a new tab), paragraph by paragraph. */
export function LinkedText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="linked-text">
      {paragraphs.map((p, i) => {
        const nodes: ReactNode[] = [];
        let last = 0;
        for (const l of findLinks(p)) {
          if (l.start > last) nodes.push(p.slice(last, l.start));
          nodes.push(<a key={l.start} href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.label}</a>);
          last = l.end;
        }
        if (last < p.length) nodes.push(p.slice(last));
        return <p key={i}>{nodes}</p>;
      })}
    </div>
  );
}

/**
 * Every link in a section's text, one by one: where it goes, and what the section's research says about that source, so
 * the writer can open it, check it, and decide whether to keep the link. A link to a page that isn't in the research is
 * marked, since it is not something the AI was given.
 */
export function SourceLinks({ text, items, disabled, onChange }: {
  text: string;
  items: ResearchItem[] | null;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const links = findLinks(text);
  if (links.length === 0) return null;
  return (
    <details className="source-links" open>
      <summary><strong>Sources linked in this section ({links.length})</strong></summary>
      <p className="small muted">Open each one to check it. Remove any link you don't want to keep; the words stay.</p>
      <ul>
        {links.map((l) => {
          const item = (items ?? []).find((i) => i.sources?.url && same(i.sources.url, l.url));
          return (
            <li key={l.start}>
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <span><strong>{l.label}</strong> <span className="faint small">· {host(l.url)}</span></span>
                {item
                  ? <span className="small muted">{item.statement}</span>
                  : <span className="small" style={{ color: "var(--flag)" }}>Not in this section's research. Check this link before you keep it.</span>}
              </div>
              <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <a className="btn btn-small" href={l.url} target="_blank" rel="noreferrer">Open</a>
                {!disabled && <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange(unlink(text, l))}>Remove link</button>}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
