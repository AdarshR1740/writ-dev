import { useState } from "react";
import type { CardFields, CardType, Citation } from "../lib/types";
import { CARD_TYPE_LABELS } from "../lib/types";
import { CARD_TYPES } from "../lib/cards";

export const emptyCard = (type: CardType = "opinion"): CardFields => ({
  type,
  claim: "",
  detail: "",
  source_who: "",
  source_where: "",
  source_date: "",
  citation: "internal",
  tags: [],
  value: type === "data_point" ? "" : null,
  unit: null,
  period: null,
  sample_size: null,
});

export function CardForm({
  initial,
  dataOnly,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: CardFields;
  dataOnly?: boolean;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (card: CardFields) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState<CardFields>(initial);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const set = <K extends keyof CardFields>(k: K, v: CardFields[K]) => setC((prev) => ({ ...prev, [k]: v }));
  const isData = c.type === "data_point";
  const valid = c.claim.trim() && (!isData || (c.value ?? "").trim());

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          ...c,
          claim: c.claim.trim(),
          tags: [...new Set(tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))],
          value: isData ? (c.value ?? "").trim() : null,
          unit: isData ? c.unit?.trim() || null : null,
          period: isData ? c.period?.trim() || null : null,
          sample_size: isData ? c.sample_size?.trim() || null : null,
        });
      }}
    >
      {!dataOnly && (
        <label className="field">
          <span>Type</span>
          <select value={c.type} onChange={(e) => set("type", e.target.value as CardType)}>
            {CARD_TYPES.map((t) => <option key={t} value={t}>{CARD_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>Claim</span>
        <input type="text" required maxLength={400} value={c.claim} onChange={(e) => set("claim", e.target.value)} placeholder="One plain sentence a competitor couldn't write" />
      </label>
      {isData && (
        <div className="grid-2">
          <label className="field"><span>Value</span><input type="text" required value={c.value ?? ""} onChange={(e) => set("value", e.target.value)} placeholder="18%" /></label>
          <label className="field"><span>Unit</span><input type="text" value={c.unit ?? ""} onChange={(e) => set("unit", e.target.value)} placeholder="% of customers" /></label>
          <label className="field"><span>Period</span><input type="text" value={c.period ?? ""} onChange={(e) => set("period", e.target.value)} placeholder="Q1 2026" /></label>
          <label className="field"><span>Sample size</span><input type="text" value={c.sample_size ?? ""} onChange={(e) => set("sample_size", e.target.value)} placeholder="212 customers" /></label>
        </div>
      )}
      <label className="field">
        <span>Detail</span>
        <textarea rows={4} value={c.detail} onChange={(e) => set("detail", e.target.value)} placeholder="2–5 sentences with the specifics, so the card stands alone" />
      </label>
      <div className="grid-3">
        <label className="field"><span>Who said it</span><input type="text" value={c.source_who} onChange={(e) => set("source_who", e.target.value)} /></label>
        <label className="field"><span>Where</span><input type="text" value={c.source_where} onChange={(e) => set("source_where", e.target.value)} placeholder="Sales call, report…" /></label>
        <label className="field"><span>When</span><input type="text" value={c.source_date} onChange={(e) => set("source_date", e.target.value)} placeholder="2026-09-14" /></label>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>Citation</span>
          <select value={c.citation} onChange={(e) => set("citation", e.target.value as Citation)}>
            <option value="internal">Internal: shapes the argument, never named</option>
            <option value="public">Public: can be quoted and attributed</option>
          </select>
        </label>
        <label className="field"><span>Tags</span><input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="churn, onboarding" /></label>
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>{submitLabel}</button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
