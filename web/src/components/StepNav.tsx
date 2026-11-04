import { Link, useLocation } from "react-router-dom";
import { DOC_SECTIONS } from "../lib/sections";

/** The house-file pages in the order the sidebar lists them. */
const STEPS: { to: string; label: string }[] = [
  ...DOC_SECTIONS.map((s) => ({ to: `/setup/${s.path}`, label: s.title })),
  { to: "/voice-memory", label: "Voice memory" },
  { to: "/formats", label: "Formats" },
  { to: "/insights", label: "Insights" },
  { to: "/data", label: "Proprietary data" },
];

/** Back and next links at the foot of a house-file page, so setup can be done in one pass. */
export function StepNav() {
  const { pathname } = useLocation();
  const at = STEPS.findIndex((s) => pathname === s.to);
  if (at < 0) return null;
  const prev = STEPS[at - 1];
  const next = STEPS[at + 1];
  return (
    <nav className="step-nav" aria-label="House file steps">
      {prev ? <Link className="btn" to={prev.to}>← {prev.label}</Link> : <Link className="btn btn-quiet" to="/house-file">← Overview</Link>}
      <span className="small faint">Step {at + 1} of {STEPS.length}</span>
      {next
        ? <Link className="btn btn-primary" to={next.to}>Next: {next.label} →</Link>
        : <Link className="btn btn-primary" to="/pieces">Done: start writing →</Link>}
    </nav>
  );
}
