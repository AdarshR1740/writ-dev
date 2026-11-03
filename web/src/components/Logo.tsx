import { useId } from "react";

/**
 * The Writ mark: a written page with a seal breaking its corner. The page and
 * lines follow the theme's ink and surface; the seal is the pencil blue. The gap
 * around the seal is cut with a mask, so it works on any background.
 */
export function LogoMark({ size = 24, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title} className="logo-mark">
      <defs>
        <mask id={`cut-${id}`}>
          <rect width="32" height="32" fill="#fff" />
          <circle cx="23" cy="23.5" r="8.7" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#cut-${id})`}>
        <rect x="5" y="3" width="19" height="25" rx="2.5" fill="var(--ink)" />
        <path d="M9.5 9.5h10M9.5 14h7" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
      <circle cx="23" cy="23.5" r="6.5" fill="var(--pencil)" />
    </svg>
  );
}

/** Mark plus the name, for the sidebar and the sign-in page. */
export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: Math.round(size * 0.82) }}>
      <LogoMark size={size} />
      <span>Writ</span>
    </span>
  );
}
