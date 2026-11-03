import { Link } from "react-router-dom";
import type { SetupStatus } from "./Layout";

function setupSteps(status: SetupStatus, pieceCount: number) {
  return [
    { done: Boolean(status.docs.icp?.filled), title: "Who you write for", detail: "The ideal customer profile. Paste what you have; AI merges it for you to review.", to: "/setup/icp", action: "Add it" },
    { done: Boolean(status.docs.core_voice?.filled), title: "How you sound", detail: "Your core voice: viewpoint, vocabulary, the rules you write by.", to: "/setup/voice", action: "Add it" },
    { done: Boolean(status.docs.positioning?.filled), title: "What you stand for", detail: "Your positioning against the alternatives.", to: "/setup/positioning", action: "Add it" },
    { done: status.hasActiveKey, title: "Your AI key", detail: "Research, briefs and checks run on your own key. Costs go to your account.", to: "/ai", action: "Add a key" },
    { done: pieceCount > 0, title: "Your first piece", detail: "Pick a format, review the research, write, sign off.", to: "/pieces", action: "Start writing" },
  ];
}
export const setupDone = (status: SetupStatus, pieceCount: number) => setupSteps(status, pieceCount).every((s) => s.done);

/** The steps from a new company to its first piece. Disappears once they're all done. */
export function GettingStarted({ status, pieceCount, onStart }: { status: SetupStatus | null; pieceCount: number; onStart?: () => void }) {
  if (!status) return null;
  const steps = setupSteps(status, pieceCount);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.findIndex((s) => !s.done);
  // Once you're writing, setup shrinks to one line so your pieces come first.
  if (pieceCount > 0) {
    const n = steps[next];
    return (
      <div className="setup-strip" aria-label="Getting started">
        <span className="progress" style={{ width: 80 }} aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></span>
        <span className="small"><strong>Setup {done} of {steps.length}.</strong> Next: {n.title.toLowerCase()}.</span>
        <span className="spacer" />
        <Link to={n.to} className="btn btn-small">{n.action}</Link>
      </div>
    );
  }
  return (
    <section className="getting-started" aria-label="Getting started">
      <header>
        <div className="row">
          <h2>{done === 0 ? "Get ready for your first piece" : "Getting started"}</h2>
          <span className="spacer" />
          <span className="small muted">{done} of {steps.length} done</span>
        </div>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      </header>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? "done" : i === next ? "next" : ""}>
            <span className="stack" style={{ gap: 2 }}>
              <strong>{s.title}</strong>
              {!s.done && <span className="small muted">{s.detail}</span>}
            </span>
            {s.done ? <span className="small ok-text">Done</span>
              : s.to === "/pieces" && onStart
                ? <button type="button" className={`btn btn-small${i === next ? " btn-primary" : ""}`} onClick={onStart}>{s.action}</button>
                : <Link to={s.to} className={`btn btn-small${i === next ? " btn-primary" : ""}`}>{s.action}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
