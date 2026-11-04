import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Link, useParams } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { FORMAT_PROMPT, FORMAT_TEMPLATES, formatMaterial } from "../lib/sections";
import type { Format } from "../lib/types";
import { useSetupStatus } from "../components/Layout";
import { DocumentWorkbench } from "../components/DocumentWorkbench";
import { RecipeEditor } from "../components/RecipeEditor";
import { BASES, normalise, presetFor, type Base } from "../lib/recipes";
import { ErrorText, Loading, Modal, PromptHelper, Tabs, Lede } from "../components/ui";
import { StepNav } from "../components/StepNav";

export function FormatsPage() {
  const company = useCompany();
  const { status, refresh } = useSetupStatus();
  const [adding, setAdding] = useState(false);
  if (!status) return <Loading />;
  const taken = new Set(status.formats.map((f) => f.name.toLowerCase()));
  const ready = status.formats.filter((f) => f.filled && !f.pending).length;
  // The format to work on next: one with changes waiting for review first, then one with no examples yet.
  const next = status.formats.find((f) => f.pending) ?? status.formats.find((f) => !f.filled);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link></span>
        <h1>Formats</h1>
        <Lede more={<>The profile is learned from pieces you consider perfect. Drafting a LinkedIn post uses your core voice plus the LinkedIn profile, and nothing else.</>}>Each format you write gets its own style profile, learned from your best examples.</Lede>
      </div>

      <ol className="how-steps">
        <li className={status.formats.length ? "done" : "now"}><strong>Add the formats you write.</strong> Pick several at once from the templates.</li>
        <li className={status.formats.length === 0 ? "" : ready === status.formats.length ? "done" : "now"}><strong>Open each one and add 2 to 5 of your best examples.</strong> Paste links in bulk, or paste the text.</li>
        <li className={ready === status.formats.length && ready > 0 ? "done" : ""}><strong>Merge, then review.</strong> AI describes what the examples have in common; you accept, edit or reject it.</li>
      </ol>

      {status.formats.length === 0 ? (
        <EmptyState icon="shapes" title="No formats yet"
          actions={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Add formats</button>}>
          <p>Start from the templates (blog, LinkedIn post, case study, newsletter, video script and more) or define your own. Each gets its own workflow and style profile.</p>
          <p className="small">You can also pick a template when you start a piece.</p>
        </EmptyState>
      ) : (
        <>
          <div className="row">
            <strong>{ready} of {status.formats.length} formats ready</strong>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setAdding(true)}>Add formats</button>
          </div>
          {next && (
            <div className="notice info row" style={{ gap: 12 }}>
              <span>
                <strong>Next:</strong>{" "}
                {next.pending ? `review the proposed changes to the ${next.name} profile.` : `add examples of your best ${next.name}.`}
              </span>
              <span className="spacer" />
              <Link className="btn btn-primary btn-small" to={`/formats/${next.id}`}>{next.pending ? "Review" : "Add examples"}</Link>
            </div>
          )}
          <div className="checklist">
            {status.formats.map((f) => (
              <Link key={f.id} to={`/formats/${f.id}`} className="check-item">
                <span className={`check-mark${f.pending ? " pending" : f.filled ? " done" : ""}`} aria-hidden>
                  {f.pending ? "!" : f.filled ? "✓" : ""}
                </span>
                <span className="stack" style={{ gap: 2 }}>
                  <strong>{f.name}</strong>
                  <span className="small muted">
                    {f.pending ? "Changes are waiting for your review." : f.filled ? "Style profile ready." : "No examples yet."}
                  </span>
                </span>
                <span className={f.pending ? "tag flag" : f.filled ? "small ok-text" : "small muted"}>
                  {f.pending ? "Review changes" : f.filled ? "Edit" : "Add examples →"}
                </span>
              </Link>
            ))}
          </div>
          {!next && <p className="small muted">Every format has a style profile. You can still open one to add more examples or change its workflow.</p>}
        </>
      )}
      <StepNav />
      {adding && (
        <AddFormat
          companyId={company.id}
          taken={taken}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); refresh(); }}
        />
      )}
    </div>
  );
}

function AddFormat({ companyId, taken, onClose, onAdded }: { companyId: string; taken: Set<string>; onClose: () => void; onAdded: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState<Base>("long_form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const customName = name.trim();
  const customTaken = customName !== "" && taken.has(customName.toLowerCase());
  const total = picked.length + (customName && !customTaken ? 1 : 0);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const rows = [
        ...FORMAT_TEMPLATES.filter((t) => picked.includes(t.key)).map((t) => ({
          company_id: companyId,
          name: t.name,
          description: t.description,
          template_key: t.key,
          recipe: presetFor(t.key),
        })),
        ...(customName && !customTaken
          ? [{ company_id: companyId, name: customName, description: description.trim(), template_key: null, recipe: BASES[base].recipe }]
          : []),
      ];
      must(await supabase.from("formats").insert(rows).select("id"));
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add formats" onClose={onClose}>
      <div className="stack">
        <h3>Pick the formats you write</h3>
        <p className="small muted">Select as many as you like, then add them together. You'll add examples to each one afterwards.</p>
        <div className="grid-2">
          {FORMAT_TEMPLATES.map((t) => {
            const isTaken = taken.has(t.name.toLowerCase());
            const on = picked.includes(t.key);
            return (
              <button
                key={t.key}
                type="button"
                className={`card pick${on ? " picked" : ""}`}
                style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
                aria-pressed={on}
                disabled={busy || isTaken}
                onClick={() => toggle(t.key)}
              >
                <span className="row"><strong>{t.name}</strong><span className="spacer" />{on && <span className="tag ok">Selected</span>}</span>
                <p className="small muted">{isTaken ? "Already added" : t.description}</p>
              </button>
            );
          })}
        </div>
      </div>
      <div className="stack">
        <h3>Or define your own</h3>
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Founder newsletter" maxLength={80} />
          {customTaken && <small>You already have a format with that name.</small>}
        </label>
        <label className="field">
          <span>What it is (optional)</span>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who it's for and what it does" />
        </label>
        <label className="field">
          <span>Workflow to start from</span>
          <select value={base} onChange={(e) => setBase(e.target.value as Base)}>
            {(Object.keys(BASES) as Base[]).map((b) => <option key={b} value={b}>{BASES[b].label}</option>)}
          </select>
          <small>Editors can adjust every step afterwards.</small>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || total === 0} onClick={add}>
          {busy ? "Adding…" : total === 0 ? "Select a format" : `Add ${total} format${total === 1 ? "" : "s"}`}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Modal>
  );
}

export function FormatDetailPage() {
  const { formatId } = useParams();
  const company = useCompany();
  const { status, refresh } = useSetupStatus();
  const [tab, setTab] = useState<"profile" | "workflow">("profile");
  const { data: format, error, reload } = useLoad(
    async () => must<Format>(await supabase.from("formats").select("*").eq("id", formatId!).single()),
    [formatId],
  );
  const entry = status?.formats.find((f) => f.id === formatId);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!format || !entry?.documentId) return <Loading />;
  // The next format that still needs work, so a writer can go straight on to it.
  const others = (status?.formats ?? []).filter((f) => f.id !== format.id);
  const nextFormat = others.find((f) => f.pending) ?? others.find((f) => !f.filled);

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow"><Link to="/formats">Formats</Link></span>
        <h1>{format.name}</h1>
        <Lede more={<>AI describes what your examples have in common; you review every line before it becomes the profile.</>}>{format.description || "Add pieces you consider perfect examples of this format."}</Lede>
      </div>
      <Tabs value={tab} onChange={setTab} options={[{ value: "profile", label: "Style profile" }, { value: "workflow", label: "Workflow" }]} />
      {tab === "profile" ? (
        <>
          <ol className="how-steps">
            <li className={entry.filled || entry.pending ? "done" : "now"}><strong>Add examples.</strong> Paste the most relevant links in bulk, or paste the text.</li>
            <li className={entry.pending ? "now" : entry.filled ? "done" : ""}><strong>Merge into the profile.</strong> Press "Merge into document" on the right.</li>
            <li className={entry.filled && !entry.pending ? "done" : ""}><strong>Review the changes</strong> and accept, edit or reject them.</li>
          </ol>
          <PromptHelper title="Prefer to build the profile in your own AI tool?" prompt={FORMAT_PROMPT(format.name)} />
          <DocumentWorkbench
            key={entry.documentId}
            documentId={entry.documentId}
            companyId={company.id}
            methods={["url", "paste", "upload"]}
            copy={formatMaterial(format.name)}
            onChanged={refresh}
          />
          <nav className="step-nav" aria-label="Formats">
            <Link className="btn" to="/formats">← All formats</Link>
            {nextFormat
              ? <Link className="btn btn-primary" to={`/formats/${nextFormat.id}`}>Next format: {nextFormat.name} →</Link>
              : <Link className="btn btn-primary" to="/insights">Next: Insights →</Link>}
          </nav>
        </>
      ) : (
        <RecipeEditor
          key={JSON.stringify(format.recipe)}
          initial={normalise(format.recipe)}
          editable={company.role === "editor"}
          onSave={async (recipe) => {
            must(await supabase.from("formats").update({ recipe }).eq("id", format.id).select("id"));
            await reload();
          }}
        />
      )}
    </div>
  );
}
