import { useState } from "react";
import { Link } from "react-router-dom";
import { BudgetSection } from "../components/Budget";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { useCompany } from "../lib/session";
import { must, useLoad } from "../lib/useLoad";
import { formatCost, formatDate } from "../lib/format";
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
  contract_suggest: "Reader contract",
  research_search: "Web research",
  research_extract: "Source findings",
  analysis: "Research analysis",
  outline_suggest: "Outline",
  section_brief: "Section brief",
  section_draft: "AI draft",
  grammar_check: "Grammar check",
  fact_check: "Fact check",
  contract_check: "Contract check",
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
  // Cost per piece this month, highest first (for agencies billing by piece).
  const byPiece = Object.values(data.usage.reduce<Record<string, { id: string; code: string; title: string; runs: number; cost: number; unpriced: boolean }>>((acc, u) => {
    if (!u.piece_id || !u.pieces) return acc;
    const row = acc[u.piece_id] ??= { id: u.piece_id, code: u.pieces.code, title: u.pieces.title, runs: 0, cost: 0, unpriced: false };
    row.runs += 1;
    row.cost += Number(u.cost_usd ?? 0);
    row.unpriced ||= u.cost_usd === null;
    return acc;
  }, {})).sort((a, b) => b.cost - a.cost);

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
          <table className="plain">
            <thead><tr><th>Task</th><th>Model</th></tr></thead>
            <tbody>
              {TASKS.map((t) => (
                <ModelRow
                  key={`${active}-${t}`}
                  task={t}
                  fallback={DEFAULT_MODELS[active][t] ?? null}
                  current={data.overrides.find((o) => o.provider === active && o.task_type === t)?.model ?? null}
                  editable={isEditor}
                  busy={busy}
                  onSave={(model) => act(async () => {
                    if (model) {
                      must(await supabase.from("model_overrides").upsert({ company_id: company.id, provider: active, task_type: t, model }).select("model"));
                    } else {
                      must(await supabase.from("model_overrides").delete().eq("company_id", company.id).eq("provider", active).eq("task_type", t).select("model"));
                    }
                  })}
                />
              ))}
            </tbody>
          </table>
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
        {byPiece.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <h3>By piece</h3>
            <table className="plain">
              <thead><tr><th>Piece</th><th>Runs</th><th>Cost</th></tr></thead>
              <tbody>
                {byPiece.slice(0, 10).map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/pieces/${p.id}`}><span className="id">{p.code}</span> {p.title}</Link></td>
                    <td>{p.runs}</td>
                    <td>${p.cost.toFixed(2)}{p.unpriced ? "+" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.usage.length > 0 && (
          <table className="plain">
            <thead><tr><th>When</th><th>Task</th><th>Model</th><th>Tokens in / out</th><th>Cost</th></tr></thead>
            <tbody>
              {data.usage.slice(0, 25).map((u, i) => (
                <tr key={i}>
                  <td>{formatDate(u.created_at)}</td>
                  <td>{TASK_NAMES[u.task] ?? u.task}</td>
                  <td className="mono">{u.model}</td>
                  <td className="mono">{u.input_tokens.toLocaleString()} / {u.output_tokens.toLocaleString()}</td>
                  <td>{u.cost_usd === null ? "—" : `$${Number(u.cost_usd).toFixed(3)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ModelRow({ task, fallback, current, editable, busy, onSave }: {
  task: TaskType;
  fallback: string | null;
  current: string | null;
  editable: boolean;
  busy: boolean;
  onSave: (model: string | null) => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const dirty = value.trim() !== (current ?? "");
  return (
    <tr>
      <td>
        <strong>{TASK_TYPE_LABELS[task].name}</strong>
        <div className="small muted">{TASK_TYPE_LABELS[task].detail}</div>
      </td>
      <td>
        {editable ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); onSave(value.trim() || null); }}>
            <input type="text" className="mono" value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={fallback ?? "Required: enter a model ID"} aria-label={`Model for ${TASK_TYPE_LABELS[task].name}`} style={{ flex: "1 1 180px", width: "auto" }} />
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
