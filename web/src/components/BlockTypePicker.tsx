import { useEffect, useId, useRef, useState } from "react";
import { BLOCK_LABELS, type BlockType } from "../lib/types";

/** One line on what each kind of block is for, shown under its name in the list. */
const DESCRIPTIONS: Record<BlockType, string> = {
  answer: "A short, standalone answer to the section's question",
  paragraph: "Explanation or argument in prose",
  bullets: "A list of parallel points",
  steps: "A numbered procedure",
  table: "A comparison, with rows and columns",
  example: "A customer case, scenario or worked example",
  data: "A figure or finding from the research, with its source",
  subheading: "A smaller heading that splits the section into parts",
  faq: "A question readers ask, with a short answer",
  quote: "An expert's view from the company's own insights",
  takeaway: "One sentence on what the reader should do or remember",
};

/**
 * A dropdown for the kind of block, in the app's own style (the same look as the format picker): a name and a one-line
 * description per option, keyboard friendly, opening above the button when there is no room below.
 */
export function BlockTypePicker({ value, onChange, disabled, label }: {
  value: BlockType;
  onChange: (value: BlockType) => void;
  disabled?: boolean;
  label: string;
}) {
  const types = Object.keys(BLOCK_LABELS) as BlockType[];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  function show() {
    const r = button.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 260 && above > below;
      const maxHeight = Math.max(180, Math.min(360, up ? above : below));
      setPlace({ top: up ? r.top - maxHeight - 4 : r.bottom + 4, left: r.left, width: Math.max(r.width, 300), maxHeight });
    }
    setActive(Math.max(0, types.indexOf(value)));
    setOpen(true);
  }
  const close = () => { setOpen(false); button.current?.focus(); };
  const pick = (t: BlockType) => { onChange(t); setOpen(false); button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    // The list is fixed to the screen, so it would drift from its button when the page scrolls: close it instead.
    const scrolled = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(types.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(types.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(types[active]); }
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div className="fp fp-compact">
      <button ref={button} type="button" className="fp-button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled} onClick={() => (open ? close() : show())} onKeyDown={onKey}>
        <span className="fp-name">{BLOCK_LABELS[value] ?? value}</span>
        <span className="fp-caret" aria-hidden="true">▾</span>
      </button>
      {open && place && (
        <ul ref={list} id={`${id}-list`} role="listbox" className="fp-list" aria-label="Kind of block"
          style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}>
          {types.map((t, i) => (
            <li key={t} role="option" id={`${id}-${i}`} data-i={i} aria-selected={t === value}
              className={`fp-option${i === active ? " active" : ""}${t === value ? " chosen" : ""}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); pick(t); }}>
              <span className="fp-text">
                <span className="fp-name">{BLOCK_LABELS[t]}</span>
                <span className="fp-desc">{DESCRIPTIONS[t]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
