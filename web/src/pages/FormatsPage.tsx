import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Link, useParams } from "react-router-dom";
import { errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { FORMAT_PROMPT, FORMAT_TEMPLATES } from "../lib/sections";
import type { Format } from "../lib/types";
import { useSetupStatus } from "../components/Layout";
import { DocumentWorkbench } from "../components/DocumentWorkbench";
import { RecipeEditor } from "../components/RecipeEditor";
import { BASES, normalise, presetFor, type Base } from "../lib/recipes";
import { ErrorText, Loading, Modal, PromptHelper, Tabs, Lede } from "../components/ui";

export function FormatsPage() {
  const company = useCompany();
  const { status, refresh } = useSetupStatus();
  const [adding, setAdding] = useState(false);
  if (!status) return <Loading />;
  const taken = new Set(status.formats.map((f) => f.name.toLowerCase()));

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link></span>
        <h1>Formats</h1>
        <Lede more={<>The profile is learned from pieces you consider perfect. Drafting a LinkedIn post uses your core voice plus the LinkedIn profile, and nothing else.</>}>Each format gets its own style profile and workflow.</Lede>
      </div>
      {status.formats.length === 0 ? (
        <EmptyState icon="shapes" title="No formats yet"
          actions={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Add a format</button>}>
          <p>Start from one of 14 templates (blog, LinkedIn post, case study, newsletter, video script and more) or define your own. Each gets its own workflow and style profile.</p>
          <p className="small">You can also pick a template when you start a piece.</p>
        </EmptyState>
      ) : (
        <>
          <div className="checklist">
            {status.formats.map((f) => (
              <Link key={f.id} to={`/formats/${f.id}`} className="check-item">
                <span className={`check-mark${f.pending ? " pending" : f.filled ? " done" : ""}`} aria-hidden>
                  {f.pending ? "!" : f.filled ? "✓" : ""}
                </span>
                <strong>{f.name}</strong>
                <span className="small faint">{f.pending ? "Changes to review" : f.filled ? "Profile ready" : "Needs examples"}</span>
              </Link>
            ))}
          </div>
          <div><button type="button" className="btn" onClick={() => setAdding(true)}>Add a format</button></div>
        </>
      )}
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState<Base>("long_form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(template?: (typeof FORMAT_TEMPLATES)[number]) {
    setBusy(true);
    setError(null);
    try {
      must(await supabase.from("formats").insert({
        company_id: companyId,
        name: template?.name ?? name.trim(),
        description: template?.description ?? description.trim(),
        template_key: template?.key ?? null,
        recipe: template ? presetFor(template.key) : BASES[base].recipe,
      }).select("id"));
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a format" onClose={onClose}>
      <div className="stack">
        <h3>Start from a template</h3>
        <div className="grid-2">
          {FORMAT_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              className="card"
              style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
              disabled={busy || taken.has(t.name.toLowerCase())}
              onClick={() => add(t)}
            >
              <strong>{t.name}</strong>
              <p className="small muted">{taken.has(t.name.toLowerCase()) ? "Already added" : t.description}</p>
            </button>
          ))}
        </div>
      </div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <h3>Or define your own</h3>
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Founder newsletter" maxLength={80} />
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
        <ErrorText>{error}</ErrorText>
        <div><button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Add format</button></div>
      </form>
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

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow"><Link to="/formats">Formats</Link></span>
        <h1>{format.name}</h1>
        <Lede more={<>{format.description ? "Add pieces you consider perfect examples of this format. " : ""}AI describes what they have in common; you review every line before it becomes the profile.</>}>{format.description || "Add pieces you consider perfect examples of this format."}</Lede>
      </div>
      <Tabs value={tab} onChange={setTab} options={[{ value: "profile", label: "Style profile" }, { value: "workflow", label: "Workflow" }]} />
      {tab === "profile" ? (
        <>
          <PromptHelper title="Prefer to build the profile in your own AI tool?" prompt={FORMAT_PROMPT(format.name)} />
          <DocumentWorkbench
            key={entry.documentId}
            documentId={entry.documentId}
            companyId={company.id}
            methods={["paste", "upload", "url"]}
            placeholder="Paste one complete example piece."
            onChanged={refresh}
          />
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
