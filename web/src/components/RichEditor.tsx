import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { richExtensions } from "../lib/richExtensions";

/**
 * A word-processor-style editor for a section's text. It shows headings, lists, bold, italic, links and tables as they
 * will look, and keeps Markdown underneath (what is saved, checked and exported), so nothing about the rest of the
 * app changes. The section's own title (its H2) is edited separately, above it.
 */
export interface RichEditorHandle {
  /** The whole text as the editor writes it (its own Markdown form, which can differ in small ways from what was stored). */
  markdown: () => string;
  /** The Markdown of the selected passage, or "" when nothing is selected. */
  selection: () => string;
  /** The part of the text the cursor is in: from its heading (H3 or H4) to the next heading at the same or a higher level. */
  part: () => { title: string; markdown: string } | null;
}

/** A toolbar icon. Defined here, not inside the editor, so React doesn't remount it on every render. */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", margin: "0 auto" }}>{children}</svg>
  );
}

export function RichEditor({ value, onChange, readOnly = false, placeholder, label, handleRef }: {
  /** The section's text, as Markdown. */
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  label: string;
  /** Lets the screen ask what is selected, or which part the cursor is in (for revising just that). */
  handleRef?: Ref<RichEditorHandle>;
}) {
  // The last Markdown this editor gave out: a different `value` coming in is a change from outside (a fix accepted, a
  // link removed, an AI draft), and is loaded into the editor.
  const emitted = useRef(value);
  const [linkBox, setLinkBox] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [...richExtensions(), Markdown, Placeholder.configure({ placeholder: placeholder ?? "" })],
    content: value,
    contentType: "markdown",
    editable: !readOnly,
    immediatelyRender: true,
    editorProps: { attributes: { "aria-label": label, role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: e }) => {
      const md = e.getMarkdown();
      emitted.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useImperativeHandle(handleRef, () => {
    const markdownOf = (nodes: unknown[]): string => editor?.markdown?.serialize({ type: "doc", content: nodes as never[] }).trim() ?? "";
    return {
      markdown: () => editor?.getMarkdown() ?? "",
      selection: () => {
        if (!editor || editor.state.selection.empty) return "";
        const { from, to } = editor.state.selection;
        const fragment = editor.state.doc.slice(from, to).content;
        const content = fragment.toJSON() as unknown[] | null;
        if (!content) return "";
        // A selection inside one paragraph or heading is bare text; it is wrapped as a paragraph so it can be written out.
        return markdownOf(fragment.firstChild?.isInline ? [{ type: "paragraph", content }] : content);
      },
      part: () => {
        if (!editor) return null;
        const doc = editor.state.doc;
        if (doc.childCount === 0) return null;
        const levelOf = (i: number) => (doc.child(i).type.name === "heading" ? (doc.child(i).attrs.level as number) : 0);
        let start = Math.min(editor.state.selection.$from.index(0), doc.childCount - 1);
        while (start > 0 && levelOf(start) === 0) start -= 1;
        const startLevel = levelOf(start);
        let end = start + 1;
        while (end < doc.childCount) {
          const level = levelOf(end);
          if (level > 0 && (startLevel === 0 || level <= startLevel)) break;
          end += 1;
        }
        const nodes: unknown[] = [];
        for (let i = start; i < end; i += 1) nodes.push(doc.child(i).toJSON());
        return { title: startLevel > 0 ? doc.child(start).textContent : "The opening", markdown: markdownOf(nodes) };
      },
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  // Which tools are on at the cursor, so the toolbar shows them pressed.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h3: e?.isActive("heading", { level: 3 }) ?? false,
      h4: e?.isActive("heading", { level: 4 }) ?? false,
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      bullets: e?.isActive("bulletList") ?? false,
      numbers: e?.isActive("orderedList") ?? false,
      link: e?.isActive("link") ?? false,
      table: e?.isActive("table") ?? false,
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false,
    }),
  });

  if (!editor) return null;
  const chain = () => editor.chain().focus();
  const tool = (on: boolean, title: string, run: () => void, face: React.ReactNode, disabled = false) => (
    <button type="button" className={`rich-tool${on ? " on" : ""}`} title={title} aria-label={title} aria-pressed={on} disabled={disabled || readOnly}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{face}</button>
  );

  function openLinkBox() {
    setLinkBox(editor!.getAttributes("link").href ?? "");
  }
  function applyLink() {
    const url = (linkBox ?? "").trim();
    if (!url) chain().extendMarkRange("link").unsetLink().run();
    // An address typed without a scheme (example.com) gets https://; one with a scheme is left as typed.
    else chain().extendMarkRange("link").setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run();
    setLinkBox(null);
  }

  return (
    <div className={`rich${readOnly ? " is-readonly" : ""}`}>
      {!readOnly && (
        <div className="rich-toolbar" role="toolbar" aria-label="Formatting">
          {tool(state?.h3 ?? false, "Heading", () => chain().toggleHeading({ level: 3 }).run(), <span style={{ fontWeight: 700 }}>H3</span>)}
          {tool(state?.h4 ?? false, "Subheading", () => chain().toggleHeading({ level: 4 }).run(), <span style={{ fontWeight: 700 }}>H4</span>)}
          <span className="rich-sep" aria-hidden="true" />
          {tool(state?.bold ?? false, "Bold (Ctrl+B)", () => chain().toggleBold().run(), <strong>B</strong>)}
          {tool(state?.italic ?? false, "Italic (Ctrl+I)", () => chain().toggleItalic().run(), <em>I</em>)}
          <span className="rich-sep" aria-hidden="true" />
          {tool(state?.bullets ?? false, "Bulleted list", () => chain().toggleBulletList().run(), <Icon><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/><path d="M9 6h11M9 12h11M9 18h11"/></Icon>)}
          {tool(state?.numbers ?? false, "Numbered list", () => chain().toggleOrderedList().run(), <Icon><path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 5l1.5-1v4M3.5 11.5c0-1.2 2.2-1.2 2.2 0 0 .9-2.2 1.6-2.2 2.5h2.4M3.5 16.5h2.2l-1 1.3c.8 0 1.2.5 1.2 1.1 0 .8-.8 1.1-2.4.9" strokeWidth="1.2"/></Icon>)}
          <span className="rich-sep" aria-hidden="true" />
          {tool(state?.link ?? false, "Link", openLinkBox, <Icon><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></Icon>)}
          {tool(state?.table ?? false, "Insert a table", () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), <Icon><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></Icon>, state?.table ?? false)}
          <span className="rich-sep" aria-hidden="true" />
          {tool(false, "Undo (Ctrl+Z)", () => chain().undo().run(), "↶", !(state?.canUndo ?? false))}
          {tool(false, "Redo (Ctrl+Y)", () => chain().redo().run(), "↷", !(state?.canRedo ?? false))}
          {state?.table && (
            <>
              <span className="rich-sep" aria-hidden="true" />
              <button type="button" className="rich-tool wide" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowAfter().run()}>+ Row</button>
              <button type="button" className="rich-tool wide" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnAfter().run()}>+ Column</button>
              <button type="button" className="rich-tool wide" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteRow().run()}>− Row</button>
              <button type="button" className="rich-tool wide" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteColumn().run()}>− Column</button>
              <button type="button" className="rich-tool wide danger" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteTable().run()}>Delete table</button>
            </>
          )}
        </div>
      )}
      {linkBox !== null && !readOnly && (
        <div className="rich-link-box">
          <input type="url" autoFocus value={linkBox} placeholder="https://…" aria-label="Link address"
            onChange={(e) => setLinkBox(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinkBox(null); }} />
          <button type="button" className="btn btn-small btn-primary" onClick={applyLink}>{linkBox.trim() ? "Apply" : "Remove link"}</button>
          <button type="button" className="btn btn-small btn-quiet" onClick={() => setLinkBox(null)}>Cancel</button>
        </div>
      )}
      <div
        className="rich-body"
        // Ctrl or Cmd + click opens a link; a plain click only puts the cursor in it. A read-only section opens it on a plain click.
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (a && (readOnly || e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.getAttribute("href") ?? "", "_blank", "noreferrer"); }
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
