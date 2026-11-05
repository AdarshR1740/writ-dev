import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface FormatChoice {
  /** "" none chosen, a format id, "tpl:<key>" for a template not added yet, or "none" for no format. */
  value: string;
  name: string;
  description: string;
  /** Template key, when the format came from a template. */
  templateKey: string | null;
}

const ICONS: Record<string, ReactNode> = {
  doc: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h4" /></>,
  post: <path d="M4 5h16v11H9l-5 4z" />,
  image: <><rect x="4" y="4" width="16" height="16" rx="4" /><circle cx="12" cy="12" r="3.5" /></>,
  carousel: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M18 8v8M21 10v4" /></>,
  thread: <path d="M5 6h14M5 12h10M5 18h12" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></>,
  talk: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M12 16v4M8 20h8" /></>,
  case: <><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M9 8V5h6v3M3 13h18" /></>,
  layers: <><path d="M12 4l9 5-9 5-9-5z" /><path d="M3 14l9 5 9-5" /></>,
  pencil: <path d="M4 20l1-4L16 5l3 3L8 19z" />,
};

const BY_KEY: Record<string, string> = {
  tl_blog: "doc", longform_blog: "doc",
  tl_linkedin: "post", promo_social: "post", short_social: "post",
  case_study: "case",
  instagram_caption: "image",
  instagram_carousel: "carousel", linkedin_carousel: "carousel",
  x_thread: "thread",
  short_video_script: "video", video_script: "video",
  newsletter: "mail",
  webinar_outline: "talk",
};

/** An icon for a format: from its template when it has one, otherwise from words in its name. */
export function formatIcon(c: Pick<FormatChoice, "value" | "name" | "templateKey">): string {
  if (c.value === "none") return "layers";
  if (c.templateKey && BY_KEY[c.templateKey]) return BY_KEY[c.templateKey];
  const n = c.name.toLowerCase();
  if (/video|reel|short|tiktok/.test(n)) return "video";
  if (/carousel/.test(n)) return "carousel";
  if (/thread/.test(n)) return "thread";
  if (/newsletter|email/.test(n)) return "mail";
  if (/webinar|talk|deck|slides/.test(n)) return "talk";
  if (/case/.test(n)) return "case";
  if (/caption|instagram/.test(n)) return "image";
  if (/linkedin|social|post/.test(n)) return "post";
  if (/blog|article|essay|long/.test(n)) return "doc";
  return "pencil";
}

function Icon({ name }: { name: string }) {
  return (
    <svg className="fp-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      {ICONS[name] ?? ICONS.pencil}
    </svg>
  );
}

/**
 * A format dropdown in the app's own style: an icon, a name and a one-line description per option, with the
 * company's own formats first and the templates not added yet underneath.
 */
export function FormatPicker({ value, onChange, own, templates, none, loading = false }: {
  value: string;
  onChange: (value: string) => void;
  own: FormatChoice[];
  templates: FormatChoice[];
  none: FormatChoice;
  /** The company's formats are still loading, so the list isn't complete yet. */
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const all = [...own, ...templates, none];
  const chosen = all.find((c) => c.value === value) ?? null;

  function show() {
    const r = button.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 220 && above > below;
      const maxHeight = Math.max(160, Math.min(340, up ? above : below));
      setPlace({ top: up ? r.top - maxHeight - 4 : r.bottom + 4, left: r.left, width: r.width, maxHeight });
    }
    setActive(Math.max(0, all.findIndex((c) => c.value === value)));
    setOpen(true);
  }

  const close = () => { setOpen(false); button.current?.focus(); };
  const pick = (c: FormatChoice) => { onChange(c.value); setOpen(false); button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
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
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(all.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(all.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(all[active]); }
    else if (e.key === "Tab") setOpen(false);
  }

  const row = (c: FormatChoice, i: number) => (
    <li key={c.value} role="option" id={`${id}-${i}`} data-i={i} aria-selected={c.value === value}
      className={`fp-option${i === active ? " active" : ""}${c.value === value ? " chosen" : ""}`}
      onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}
      // preventDefault: the picker sits inside a <label>, which would otherwise forward this click to the button and reopen the list.
      onClick={(e) => { e.preventDefault(); pick(c); }}>
      <Icon name={formatIcon(c)} />
      <span className="fp-text">
        <span className="fp-name">{c.name}</span>
        {c.description && <span className="fp-desc">{c.description}</span>}
      </span>
    </li>
  );

  return (
    <div className="fp">
      <button ref={button} type="button" className="fp-button" role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={loading} onClick={() => (open ? close() : show())} onKeyDown={onKey}>
        {chosen ? <><Icon name={formatIcon(chosen)} /><span className="fp-name">{chosen.name}</span></> : <span className="fp-placeholder">{loading ? "Loading formats…" : "Choose a format…"}</span>}
        <span className="fp-caret" aria-hidden="true">▾</span>
      </button>
      {open && place && (
        <ul ref={list} id={`${id}-list`} role="listbox" className="fp-list" aria-label="Format"
          style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}>
          {own.length > 0 && <li role="presentation" className="fp-group">Your formats</li>}
          {own.map((c, i) => row(c, i))}
          {templates.length > 0 && <li role="presentation" className="fp-group">Add from templates</li>}
          {templates.map((c, i) => row(c, own.length + i))}
          <li role="presentation" className="fp-group">Or</li>
          {row(none, own.length + templates.length)}
        </ul>
      )}
    </div>
  );
}
