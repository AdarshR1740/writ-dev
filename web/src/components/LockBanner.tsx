import { holderText, type LockHolder } from "../lib/locks";

/**
 * Shown when someone else (another person, another tab of yours, or Claude) holds the edit lock on what you are looking at.
 * You can read it; to change it, wait until they finish or take over.
 */
export function LockBanner({ holder, what, unsaved = false, problem = null, onTakeOver, onDiscard }: {
  holder: LockHolder;
  /** What is locked, in words: "the outline", "this section". */
  what: string;
  /** The writer has changes here that could not be saved because of the lock. */
  unsaved?: boolean;
  /** Why taking over did not work, if it didn't. */
  problem?: string | null;
  onTakeOver: () => void;
  /** Throw away the unsaved changes and show what is saved. */
  onDiscard?: () => void;
}) {
  return (
    <div className="notice row lock-banner" role="status" style={{ alignItems: "center", flexWrap: "wrap" }}>
      <span className="small">
        <strong>{holderText(holder, what)}</strong>{" "}
        You can read it. {unsaved ? "Your latest changes are not saved. " : ""}
        Wait until they finish, or take over{holder.kind === "ai" ? " (Claude's next save will then be refused)" : ""}.
      </span>
      {problem && <span className="small" style={{ color: "var(--flag)" }}>{problem}</span>}
      <span className="spacer" />
      <button type="button" className="btn btn-small" onClick={() => {
        if (window.confirm(`Take over from ${holder.label}? Anything they have not saved yet may be lost.`)) onTakeOver();
      }}>Take over</button>
      {unsaved && onDiscard && <button type="button" className="btn btn-quiet btn-small" onClick={onDiscard}>Discard my changes</button>}
    </div>
  );
}
