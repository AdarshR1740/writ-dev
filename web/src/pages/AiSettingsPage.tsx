import { useState } from "react";
import { Link } from "react-router-dom";
import { BudgetSection } from "../components/Budget";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatCost } from "../lib/format";
import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  TASK_TYPE_LABELS,
  type Provider,
  type ProviderKey,
  type TaskType,
} from "../lib/types";
import { useSetupStatus } from "../components/Layout";
import { ErrorText, Loading, Lede } from "../components/ui";

const TASK_NAMES: Record<string, string> = {
  consolidate: "Merge document",
  extract_cards: "Extract insights",
  contract_suggest: "Scope",
  research_search: "Web research",
  research_extract: "Source findings",
  analysis: "Research analysis",
  outline_suggest: "Outline",
  section_brief: "Section brief",
  section_draft: "AI draft",
  grammar_check: "Grammar check",
  fact_check: "Fact check",
  contract_check: "Scope check",
  learn_voice: "Voice learning",
  seo_geo_check: "SEO & GEO check",
};

const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini", "local"];
const TASKS: TaskType[] = ["extract", "research", "reason", "write"];

const PROVIDER_NOTES: Record<Provider, string> = {
  anthropic: "Tested defaults. Research quotes come straight from Claude's citations.",
  openai: "Default models: GPT-5 nano, mini and GPT-5. Web search works; quotes are checked against each page before review.",
  gemini: "No default models yet: choose one per task type below. Web search isn't available; add research sources by URL or paste.",
  local: "Any OpenAI-compatible server (Ollama, LM Studio, vLLM). Our server calls it, so it must be reachable over the internet, e.g. through a tunnel; localhost won't work. Choose your installed model names below. No web search.",
};

interface UsageRow {
  piece_id: string | null;
  pieces: { code: string; title: string } | null;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  created_at: string;
}

export function AiSettingsPage() {
  const company = useCompany();
  const { refresh } = useSetupStatus();
  const isEditor = company.role === "editor";
  // Calendar month in UTC, matching the server's budget.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const { data, error, reload } = useLoad(async () => {
    const [keys, overrides, usage] = await Promise.all([
      supabase.from("provider_keys").select("provider, key_hint, base_url, is_active, created_at").eq("company_id", company.id)
        .then(must<ProviderKey[]>),
      supabase.from("model_overrides").select("provider, task_type, model").eq("company_id", company.id)
        .then(must<{ provider: Provider; task_type: TaskType; model: string }[]>),
      supabase.from("usage_events").select("task, model, input_tokens, output_tokens, cost_usd, created_at, piece_id, pieces(code, title)")
        .eq("company_id", company.id).gte("created_at", monthStart).order("created_at", { ascending: false })
        .then(must<UsageRow[]>),
    ]);
    return { keys, overrides, usage };
  }, [company.id]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<Provider | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
      refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const active = data.keys.find((k) => k.is_active)?.provider ?? null;
  const monthCost = data.usage.reduce((sum, u) => sum + Number(u.cost_usd ?? 0), 0);
  const unpriced = data.usage.some((u) => u.cost_usd === null);
  // This month's cost per piece, highest first (for agencies billing by piece), each expandable to its tasks.
  const groups = usageByPiece(data.usage);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>AI provider &amp; models</h1>
        <Lede more={<>Keys are encrypted on the server and never shown again. You can store keys for several providers; one is active at a time.</>}>{company.name} uses its own AI key, so model costs go straight to your provider at their rates.</Lede>
      </div>
      <ErrorText>{actionError}</ErrorText>

      <section className="stack">
        <h2>Providers</h2>
        {PROVIDERS.map((p) => {
          const k = data.keys.find((x) => x.provider === p);
          return (
            <div key={p} className="card stack" style={{ gap: 10 }}>
              <div className="row">
                <strong>{PROVIDER_LABELS[p]}</strong>
                {k?.is_active && <span className="tag ok">Active</span>}
                {k && !k.is_active && <span className="tag">Stored</span>}
                {k && <span className="mono faint">{k.key_hint}</span>}
                <span className="spacer" />
                {isEditor && k && !k.is_active && (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() =>
                    callFunction("provider-keys", { action: "activate", company_id: company.id, provider: p }))}>
                    Make active
                  </button>
                )}
                {isEditor && (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => { setKeyFor(p); setKeyValue(""); }}>
                    {k ? "Replace key" : "Add key"}
                  </button>
                )}
                {isEditor && k && (
                  <button type="button" className="btn btn-quiet btn-small btn-danger" disabled={busy} onClick={() => {
                    if (window.confirm(`Remove the ${PROVIDER_LABELS[p]} key?`)) {
                      act(() => callFunction("provider-keys", { action: "remove", company_id: company.id, provider: p }));
                    }
                  }}>
                    Remove
                  </button>
                )}
              </div>
              <p className="small faint">{PROVIDER_NOTES[p]}</p>
              {k?.base_url && <p className="small mono faint">{k.base_url}</p>}
              {keyFor === p && (
                <form className="row" onSubmit={(e) => {
                  e.preventDefault();
                  act(async () => {
                    await callFunction("provider-keys", { action: "save", company_id: company.id, provider: p, api_key: keyValue, base_url: baseUrl });
                    setKeyFor(null);
                    setKeyValue("");
                    setBaseUrl("");
                  });
                }}>
                  {p === "local" && (
                    <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoFocus
                      placeholder="https://your-tunnel.example.com/v1" aria-label="Local model API address" style={{ flex: "1 1 100%", width: "auto" }} />
                  )}
                  <input type="password" autoComplete="off" value={keyValue} onChange={(e) => setKeyValue(e.target.value)}
                    placeholder={p === "local" ? "API key (if your server needs one)" : "Paste the API key"} aria-label={`${PROVIDER_LABELS[p]} API key`} style={{ flex: "1 1 260px", width: "auto" }} autoFocus={p !== "local"} />
                  <button type="submit" className="btn btn-primary" disabled={busy || (p === "local" ? !baseUrl.trim() : keyValue.trim().length < 20)}>
                    {busy ? "Checking key…" : "Check and save"}
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => setKeyFor(null)}>Cancel</button>
                </form>
              )}
            </div>
          );
        })}
        {!isEditor && <p className="small muted">Only editors can change keys and models.</p>}
      </section>

      {active && (
        <section className="stack">
          <div className="stack" style={{ gap: 4 }}>
            <h2>Models by task</h2>
            <p className="small muted">
              Each kind of task uses the cheapest model that does it well. Override a default only if you have a reason to.
            </p>
          </div>
          <ModelsTable
            provider={active}
            companyId={company.id}
            overrides={data.overrides}
            editable={isEditor}
            busy={busy}
            onSave={(t, model) => act(async () => {
              if (model) {
                must(await supabase.from("model_overrides").upsert({ company_id: company.id, provider: active, task_type: t, model }).select("model"));
              } else {
                must(await supabase.from("model_overrides").delete().eq("company_id", company.id).eq("provider", active).eq("task_type", t).select("model"));
              }
            })}
          />
        </section>
      )}

      <BudgetSection companyId={company.id} editable={isEditor} />

      <section className="stack">
        <div className="stack" style={{ gap: 4 }}>
          <h2>Usage this month</h2>
          <p className="small muted">
            {data.usage.length === 0
              ? "No AI runs yet this month."
              : `${data.usage.length} runs, ${formatCost(monthCost)}${unpriced ? " plus runs on models we can't price" : ""}. Your provider's bill is the final word.`}
          </p>
        </div>
        {groups.length > 0 && (
          <div className="usage-list">
            <div className="usage-row usage-head" aria-hidden="true">
              <span>Piece</span><span>Runs</span><span>Tokens in / out</span><span>Cost</span>
            </div>
            {groups.map((g) => (
              <details key={g.id} className="usage-group">
                <summary className="usage-row">
                  <span className="usage-title">
                    {g.code ? <><span className="id">{g.code}</span> {g.title}</> : g.title}
                  </span>
                  <span>{g.runs}</span>
                  <span className="mono">{g.input.toLocaleString()} / {g.output.toLocaleString()}</span>
                  <span>{money(g.cost, g.unpriced)}</span>
                </summary>
                <div className="usage-body">
                  <table className="plain">
                    <thead><tr><th>Task</th><th>Model</th><th>Runs</th><th>Tokens in / out</th><th>Cost</th></tr></thead>
                    <tbody>
                      {g.tasks.map((t) => (
                        <tr key={t.task}>
                          <td>{TASK_NAMES[t.task] ?? t.task}</td>
                          <td className="mono">{[...t.models].join(", ")}</td>
                          <td>{t.runs}</td>
                          <td className="mono">{t.input.toLocaleString()} / {t.output.toLocaleString()}</td>
                          <td>{money(t.cost, t.unpriced)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {g.pieceId && <p className="small"><Link to={`/pieces/${g.pieceId}`}>Open this piece</Link></p>}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const money = (cost: number, unpriced: boolean) => `$${cost.toFixed(cost < 0.1 ? 3 : 2)}${unpriced ? "+" : ""}`;

interface UsageGroup {
  id: string;
  pieceId: string | null;
  code: string | null;
  title: string;
  runs: number;
  input: number;
  output: number;
  cost: number;
  unpriced: boolean;
  tasks: { task: string; models: Set<string>; runs: number; input: number; output: number; cost: number; unpriced: boolean }[];
}

/** This month's runs grouped by piece (most expensive first), each with a per-task breakdown. */
function usageByPiece(usage: UsageRow[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const u of usage) {
    const id = u.piece_id ?? "none";
    const g = groups.get(id) ?? {
      id,
      pieceId: u.piece_id,
      code: u.pieces?.code ?? null,
      title: u.piece_id ? (u.pieces?.title ?? "Piece") : "Not tied to a piece (house file, Ask Writ)",
      runs: 0, input: 0, output: 0, cost: 0, unpriced: false, tasks: [],
    };
    let t = g.tasks.find((x) => x.task === u.task);
    if (!t) g.tasks.push(t = { task: u.task, models: new Set(), runs: 0, input: 0, output: 0, cost: 0, unpriced: false });
    for (const row of [g, t]) {
      row.runs += 1;
      row.input += u.input_tokens;
      row.output += u.output_tokens;
      row.cost += Number(u.cost_usd ?? 0);
      row.unpriced ||= u.cost_usd === null;
    }
    t.models.add(u.model);
    groups.set(id, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.tasks.sort((a, b) => b.cost - a.cost);
  return out.sort((a, b) => b.cost - a.cost);
}

function ModelsTable({ provider, companyId, overrides, editable, busy, onSave }: {
  provider: Provider;
  companyId: string;
  overrides: { provider: Provider; task_type: TaskType; model: string }[];
  editable: boolean;
  busy: boolean;
  onSave: (task: TaskType, model: string | null) => void;
}) {
  // The provider's own list of models for this key. Editors only, since listing needs the stored key.
  const { data: models, error: listError, loading } = useLoad(
    async () => editable ? (await callFunction<{ models: string[] }>("provider-keys", { action: "models", company_id: companyId, provider })).models : null,
    [companyId, provider, editable],
  );
  return (
    <>
      {editable && listError && <p className="small muted">Couldn't load the model list ({listError}). Type a model ID instead.</p>}
      <table className="plain">
        <thead><tr><th>Task</th><th>Model</th></tr></thead>
        <tbody>
          {TASKS.map((t) => (
            <ModelRow
              key={`${provider}-${t}`}
              task={t}
              fallback={DEFAULT_MODELS[provider][t] ?? null}
              current={overrides.find((o) => o.provider === provider && o.task_type === t)?.model ?? null}
              models={models ?? null}
              loadingModels={loading && editable}
              editable={editable}
              busy={busy}
              onSave={(model) => onSave(t, model)}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

function ModelRow({ task, fallback, current, models, loadingModels, editable, busy, onSave }: {
  task: TaskType;
  fallback: string | null;
  current: string | null;
  models: string[] | null;
  loadingModels: boolean;
  editable: boolean;
  busy: boolean;
  onSave: (model: string | null) => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const dirty = value.trim() !== (current ?? "");
  const label = `Model for ${TASK_TYPE_LABELS[task].name}`;
  // The list, plus the saved model if the provider no longer lists it, so it never silently disappears.
  const options = models ? (current && !models.includes(current) ? [current, ...models] : models) : null;
  return (
    <tr>
      <td>
        <strong>{TASK_TYPE_LABELS[task].name}</strong>
        <div className="small muted">{TASK_TYPE_LABELS[task].detail}</div>
      </td>
      <td>
        {editable && (options || loadingModels) ? (
          <select
            className="mono"
            aria-label={label}
            value={current ?? ""}
            disabled={busy || loadingModels}
            onChange={(e) => onSave(e.target.value || null)}
            style={{ width: "100%", maxWidth: 360 }}
          >
            <option value="">{loadingModels ? "Loading models…" : fallback ? `Default (${fallback})` : "Choose a model…"}</option>
            {(options ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : editable ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); onSave(value.trim() || null); }}>
            <input type="text" className="mono" value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={fallback ?? "Required: enter a model ID"} aria-label={label} style={{ flex: "1 1 180px", width: "auto" }} />
            {dirty && <button type="submit" className="btn btn-small btn-primary" disabled={busy}>{value.trim() ? "Save" : "Use default"}</button>}
          </form>
        ) : (
          <span className="mono">{current ?? fallback ?? "Not set"}</span>
        )}
        {!current && fallback && <div className="small faint">Default</div>}
        {!current && !fallback && <div className="small error">Set a model to use this provider for these tasks.</div>}
      </td>
    </tr>
  );
}
