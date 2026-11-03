import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  page: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h4" /></>,
  quote: <><path d="M5 11a4 4 0 0 1 4-4v3a1 1 0 0 0-1 1h1.5v5H5zM13 11a4 4 0 0 1 4-4v3a1 1 0 0 0-1 1h1.5v5H13z" /></>,
  bookmark: <path d="M7 3h10v18l-5-4-5 4z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  shapes: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="3.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M14 20.5l3-6 3 6z" /></>,
  chart: <><path d="M4 20h16" /><path d="M7 16v-5M12 16V7M17 16v-8" /></>,
  voice: <><path d="M4 12h2M8 8v8M12 5v14M16 9v6M20 11v2" /></>,
};

/** A first-run empty state: what belongs here, and how to add the first one. */
export function EmptyState({ icon, title, children, actions }: {
  icon: keyof typeof PATHS;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <svg className="empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        {PATHS[icon]}
      </svg>
      <h2>{title}</h2>
      {children && <div className="empty-body">{children}</div>}
      {actions && <div className="row" style={{ justifyContent: "center" }}>{actions}</div>}
    </section>
  );
}
