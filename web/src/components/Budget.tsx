import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { ErrorText } from "./ui";

export interface BudgetSettings { monthly_budget_usd: number | null; budget_alert_pct: number; budget_hard_limit: boolean }

export const usd = (n: number) => `$${n.toFixed(2)}`;

export function useBudget(companyId: string) {
  return useLoad(async () => {
    const [settings, spent] = await Promise.all([
      supabase.from("companies").select("monthly_budget_usd, budget_alert_pct, budget_hard_limit").eq("id", companyId).single()
        .then(must<BudgetSettings>),
      supabase.rpc("month_spend", { target: companyId }).then(must<number>),
    ]);
    return { ...settings, monthly_budget_usd: settings.monthly_budget_usd === null ? null : Number(settings.monthly_budget_usd), spent: Number(spent ?? 0) };
  }, [companyId]);
}

/** Where this month's spend stands against the budget: "ok", "alert" (past the alert level) or "over". */
export function budgetLevel(b: BudgetSettings & { spent: number }): "none" | "ok" | "alert" | "over" {
  if (b.monthly_budget_usd === null) return "none";
  if (b.spent >= b.monthly_budget_usd) return "over";
  return b.spent >= (b.monthly_budget_usd * b.budget_alert_pct) / 100 ? "alert" : "ok";
}

export function BudgetBar({ spent, budget, level }: { spent: number; budget: number; level: string }) {
  return (
    <div className={`budget-bar ${level}`} role="progressbar" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent} aria-label="AI spend this month">
      <span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
    </div>
  );
}

/** Shown on the Write home once spend passes the alert level. */
export function BudgetAlert({ companyId }: { companyId: string }) {
  const { data } = useBudget(companyId);
  if (!data) return null;
  const level = budgetLevel(data);
  if (level !== "alert" && level !== "over") return null;
  return (
    <p className="notice small">
      {level === "over"
        ? <>This month's AI spend ({usd(data.spent)}) has reached the {usd(data.monthly_budget_usd!)} budget.{data.budget_hard_limit ? " AI runs are paused until next month or until an editor raises the budget." : ""} </>
        : <>AI spend this month is {usd(data.spent)}, {Math.round((data.spent / data.monthly_budget_usd!) * 100)}% of the {usd(data.monthly_budget_usd!)} budget. </>}
      <Link to="/ai">See spending</Link>
    </p>
  );
}

/** Budget settings (editors) and where the month stands (everyone). */
export function BudgetSection({ companyId, editable }: { companyId: string; editable: boolean }) {
  const { data, reload } = useBudget(companyId);
  const [amount, setAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const level = budgetLevel(data);
  const save = async (patch: Partial<BudgetSettings>) => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from("companies").update(patch).eq("id", companyId);
    if (err) setError(err.message);
    else { setAmount(null); reload(); }
    setBusy(false);
  };
  const value = amount ?? (data.monthly_budget_usd === null ? "" : String(data.monthly_budget_usd));
  const parsed = value.trim() === "" ? null : Number(value);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed <= 0);

  return (
    <section className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h2>Monthly budget</h2>
        <p className="small muted">A spending limit for this company's AI key, per calendar month (UTC). Costs are Writ's estimates from token counts; your provider's bill is the final word.</p>
      </div>
      {data.monthly_budget_usd !== null ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <strong>{usd(data.spent)}</strong>
            <span className="muted">of {usd(data.monthly_budget_usd)} this month</span>
            <span className="spacer" />
            {level === "over" && <span className="tag flag">Budget reached</span>}
            {level === "alert" && <span className="tag flag">Past {data.budget_alert_pct}%</span>}
          </div>
          <BudgetBar spent={data.spent} budget={data.monthly_budget_usd} level={level} />
        </div>
      ) : (
        <p className="small">{usd(data.spent)} spent this month. No budget set.</p>
      )}
      {editable && (
        <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (!invalid) save({ monthly_budget_usd: parsed }); }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ width: 160 }}>
              <span>Budget (USD a month)</span>
              <input type="text" inputMode="decimal" value={value} onChange={(e) => setAmount(e.target.value)} placeholder="No budget" />
            </label>
            <label className="field">
              <span>Warn at</span>
              <select value={data.budget_alert_pct} onChange={(e) => save({ budget_alert_pct: Number(e.target.value) })} disabled={busy}>
                {[50, 75, 80, 90, 100].map((p) => <option key={p} value={p}>{p}%</option>)}
              </select>
            </label>
            <button type="submit" className="btn" disabled={busy || invalid || amount === null}>Save budget</button>
            {data.monthly_budget_usd !== null && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => save({ monthly_budget_usd: null, budget_hard_limit: false })}>Remove budget</button>}
          </div>
          {invalid && <p className="small error">Enter an amount in dollars, like 50.</p>}
          <label className="check-label small">
            <input type="checkbox" checked={data.budget_hard_limit} disabled={busy || data.monthly_budget_usd === null} onChange={(e) => save({ budget_hard_limit: e.target.checked })} />
            <span>Stop AI runs when the budget is used up. Off: Writ warns, but runs continue.</span>
          </label>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
