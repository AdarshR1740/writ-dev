import { useState } from "react";
import { BASES, presetFor, validate, type Base, type Recipe } from "../lib/recipes";
import { ErrorText, CleanTextarea } from "./ui";

type Shown = { show?: (r: Recipe) => boolean; sub?: boolean };
type Control = Shown & (
  | { path: string; label: string; kind: "bool"; hint?: string }
  | { path: string; label: string; kind: "select"; options: { value: string; label: string }[] }
  | { path: string; label: string; kind: "number"; min: number; max: number }
  | { path: string; label: string; kind: "list" }
);

// Sub-settings only show while their step is on.
// A module is "off" when its main switch is off; it then shows only that switch.
const OFF: Record<string, (r: Recipe) => boolean> = {
  "Scope": (r) => r.contract.mode === "off",
  Analysis: (r) => !r.analysis.enabled,
  Outline: (r) => r.outline.mode === "off",
};
const research = (_r: Recipe) => true;
const analysis = (r: Recipe) => r.analysis.enabled;

const MODULES: { title: string; lede: string; controls: Control[] }[] = [
  {
    title: "Brief",
    lede: "Fields the writer fills in when starting a piece.",
    controls: [
      { path: "brief.keyword", label: "Primary keyword", kind: "bool" },
      { path: "brief.goal", label: "Goal", kind: "bool" },
      { path: "brief.audience", label: "Audience notes", kind: "bool" },
      { path: "brief.customer", label: "Customer and approval contact", kind: "bool" },
      { path: "brief.offer", label: "Offer and call to action", kind: "bool" },
    ],
  },
  {
    title: "Scope",
    lede: "What the piece must answer and cover; later checks compare the writing against it.",
    controls: [
      { path: "contract.mode", label: "Scope", kind: "select", options: [
        { value: "full", label: "Full (3 to 7 points to cover)" },
        { value: "lite", label: "Lite (one point, up to 2 more)" },
        { value: "off", label: "Off" },
      ] },
      { show: (r) => r.contract.mode !== "off", sub: true, path: "contract.ai_thread", label: "AI suggestions in a conversation", kind: "bool" },
    ],
  },
  {
    title: "Research",
    lede: "Always available in every format. Choose where facts come from, and whether each item is reviewed.",
    controls: [

      { show: research, path: "research.web_search", label: "Web search", kind: "bool" },
      { show: (r) => r.research.enabled && r.research.web_search, sub: true, path: "research.max_searches", label: "Max searches per run", kind: "number", min: 1, max: 10 },
      { show: research, path: "research.serp", label: "Search landscape (intent, what ranking pages cover and skip)", kind: "bool" },
      { show: research, path: "research.cards", label: "Suggest insight cards", kind: "bool" },
      { show: research, path: "research.library", label: "Suggest library sources", kind: "bool" },
      { show: research, path: "research.manual", label: "Add sources by URL or paste", kind: "bool" },
      { show: research, path: "research.review", label: "Review every item before moving on", kind: "bool",
        hint: "Off: items are approved automatically, and the provenance summary says research wasn't individually reviewed." },
    ],
  },
  {
    title: "Analysis",
    lede: "Whether the scope and research still match the topic, before outlining.",
    controls: [
      { path: "analysis.enabled", label: "Alignment check", kind: "bool" },
      { show: analysis, sub: true, path: "analysis.gaps", label: "Gaps and expert questions", kind: "bool" },
      { show: analysis, sub: true, path: "analysis.contract_suggestions", label: "Suggest scope changes", kind: "bool" },
    ],
  },
  {
    title: "Outline",
    lede: "Off means the piece is written as one section.",
    controls: [
      { path: "outline.mode", label: "Outline", kind: "select", options: [
        { value: "free", label: "Free (writer builds it)" },
        { value: "fixed", label: "Fixed template" },
        { value: "off", label: "Off (single section)" },
      ] },
      { path: "outline.template", label: "Template headings", kind: "list" },
      { show: (r) => r.outline.mode === "free", path: "outline.ai_thread", label: "AI suggestions in a conversation", kind: "bool" },
      { show: (r) => r.outline.mode !== "off", path: "outline.seo_geo_check", label: "SEO/GEO check on the outline", kind: "bool" },
    ],
  },
  {
    title: "Sections",
    lede: "What happens before each section is written.",
    controls: [
      { path: "sections.research", label: "Research per section", kind: "bool" },
      { show: (r) => r.sections.research && r.outline.mode !== "off", sub: true, path: "sections.timing", label: "Section research timing (default)", kind: "select", options: [
        { value: "just_in_time", label: "One section at a time" },
        { value: "up_front", label: "All sections up front" },
      ] },
      { path: "sections.reuse_piece_items", label: "Reuse approved piece research", kind: "bool" },
      { path: "sections.brief", label: "Bullet brief before writing", kind: "bool" },
    ],
  },
  {
    title: "Writing",
    lede: "Writing by hand is always available.",
    controls: [{ path: "writing.ai_draft", label: "Allow AI drafts (recorded as AI-drafted)", kind: "bool" }],
  },
  {
    title: "Checks",
    lede: "Run while writing and before sign-off. No scores.",
    controls: [
      { path: "checks.grammar", label: "Grammar", kind: "bool" },
      { path: "checks.fact", label: "Facts against approved research", kind: "bool" },
      { path: "checks.contract", label: "Scope check", kind: "bool" },
      { path: "checks.seo", label: "SEO", kind: "bool" },
      { path: "checks.geo", label: "GEO (AI answer engines)", kind: "bool" },
      { path: "checks.customer_approval", label: "Customer approval, recorded before sign-off", kind: "bool" },
    ],
  },
  {
    title: "Sign-off",
    lede: "How a piece is finished.",
    controls: [
      { path: "signoff.required", label: "Named sign-off", kind: "bool",
        hint: "Off: the piece is marked done, and the summary says there was no named sign-off. The company's editorial-record setting still requires an editor." },
      { show: (r) => r.signoff.required, sub: true, path: "signoff.editor_required", label: "Only an editor can sign off", kind: "bool" },
      { path: "signoff.final_paste", label: "Paste the published version", kind: "bool" },
      { path: "signoff.learn", label: "Learn voice rules from the piece", kind: "bool" },
    ],
  },
];

function get(r: Recipe, path: string): unknown {
  const [g, k] = path.split(".");
  return (r as unknown as Record<string, Record<string, unknown>>)[g][k];
}

function set(r: Recipe, path: string, value: unknown): Recipe {
  const [g, k] = path.split(".");
  const next = JSON.parse(JSON.stringify(r)) as Record<string, Record<string, unknown>>;
  next[g][k] = value;
  return next as unknown as Recipe;
}

export function RecipeEditor({ initial, editable, onSave }: {
  initial: Recipe;
  editable: boolean;
  onSave: (r: Recipe) => Promise<void>;
}) {
  const [recipe, setRecipe] = useState<Recipe>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const issues = validate(recipe);
  const dirty = JSON.stringify(recipe) !== JSON.stringify(initial);
  const issueFor = (path: string) => issues.filter((i) => i.path === path);
  // What differs from the base preset this workflow started from.
  const base = BASES[recipe.base]?.recipe;
  const changed = (m: (typeof MODULES)[number]) => Boolean(base) && m.controls.some((c) => JSON.stringify(get(recipe, c.path)) !== JSON.stringify(get(base, c.path)));

  return (
    <div className="stack">
      <div className="row">
        <label className="field" style={{ flex: "1 1 320px" }}>
          <span>Start from a base</span>
          <select disabled={!editable} value="" onChange={(e) => e.target.value && setRecipe(presetFor(
            e.target.value === "long_form" ? "longform_blog" : e.target.value === "case_study" ? "case_study" : "tl_linkedin",
          ))}>
            <option value="">Replace with a base…</option>
            {(Object.keys(BASES) as Base[]).map((b) => <option key={b} value={b}>{BASES[b].label}</option>)}
          </select>
        </label>
      </div>
      <p className="small muted">
        Pieces keep the workflow they started with; changes apply to new pieces in this format.
        {!editable && " Only editors can change it."}
      </p>
      <div className="recipe">
        {MODULES.map((m) => (
          <fieldset key={m.title} className={`recipe-module${OFF[m.title]?.(recipe) ? " off" : ""}`} disabled={!editable}>
            <legend>{m.title}{changed(m) && <span className="tag flag" title={`Differs from the ${BASES[recipe.base].label} base`}>changed</span>}</legend>
            <p className="small faint">{m.lede}</p>
            {m.controls.map((c) => {
              const problems = issueFor(c.path);
              // Keep a hidden control visible while it's the cause of a problem.
              if (c.show && !c.show(recipe) && problems.length === 0) return null;
              const value = get(recipe, c.path);
              return (
                <div key={c.path} className={`recipe-control${c.sub ? " sub" : ""}${problems.length ? " has-issue" : ""}`}>
                  {c.kind === "bool" && (
                    <label className="check-label small">
                      <input type="checkbox" checked={Boolean(value)} onChange={(e) => setRecipe(set(recipe, c.path, e.target.checked))} />
                      {c.label}
                    </label>
                  )}
                  {c.kind === "select" && (
                    <label className="field">
                      <span>{c.label}</span>
                      <select value={String(value)} onChange={(e) => setRecipe(set(recipe, c.path, e.target.value))}>
                        {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                  )}
                  {c.kind === "number" && (
                    <label className="number-label small">
                      <input type="number" min={c.min} max={c.max} value={Number(value)}
                        onChange={(e) => setRecipe(set(recipe, c.path, Number(e.target.value)))} />
                      {c.label}
                    </label>
                  )}
                  {c.kind === "list" && recipe.outline.mode === "fixed" && (
                    <label className="field">
                      <span>{c.label} (one per line)</span>
                      <CleanTextarea rows={4} value={(value as string[]).join("\n")} style={{ minHeight: 90 }}
                        onChange={(e) => setRecipe(set(recipe, c.path, e.target.value.split("\n")))} />
                    </label>
                  )}
                  {"hint" in c && c.hint && !value && <p className="small flag-text">{c.hint}</p>}
                  {problems.map((p, i) => <p key={i} className="small error">{p.message}</p>)}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>
      {editable && (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy || !dirty || issues.length > 0} onClick={async () => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              const clean = set(recipe, "outline.template", recipe.outline.template.map((h) => h.trim()).filter(Boolean));
              await onSave(clean);
              setSaved(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}>
            Save workflow
          </button>
          {!dirty && issues.length === 0 && !busy && <span className="small muted disabled-reason">No changes yet</span>}
          {issues.length > 0 && <span className="small error">{issues.length} setting{issues.length === 1 ? "" : "s"} to fix first.</span>}
          {saved && !dirty && <span className="small muted">Saved.</span>}
          {dirty && <button type="button" className="btn btn-quiet" onClick={() => setRecipe(initial)}>Undo changes</button>}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
