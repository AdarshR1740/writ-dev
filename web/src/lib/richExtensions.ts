import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import type { Extensions } from "@tiptap/core";

/**
 * What the section editor can hold, and so what its Markdown can say: headings, lists, bold, italic, links and tables.
 * Nothing the export can't carry (code, quotes, rules, underline, strike). The section's own title is not part of the
 * text: it is the section's H2, edited above the editor, so the text uses H3 and H4 for its own headings (H2 is still
 * read, in case older text has one).
 */
export const richExtensions = (): Extensions => [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    // Links are opened with Ctrl or Cmd + click (or from the list under the editor), not by a plain click.
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noreferrer", target: "_blank" } },
  }),
  TableKit.configure({ table: { resizable: false } }),
];
