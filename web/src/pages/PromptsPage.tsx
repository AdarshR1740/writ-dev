import { useMemo, useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { useCompany, useSession } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { formatDate } from "../lib/format";
import { DOC_SECTIONS, DATA_PROMPT, FORMAT_PROMPT, INSIGHT_PROMPT, VOICE_MEMORY_PROMPT } from "../lib/sections";
import { CopyButton, ErrorText, Lede, Loading } from "../components/ui";

interface Unit {
  /** Absent for prompts that run in your own AI tool: those are shown, not edited here. */
  key?: string;
  label: string;
  text: string;
  locked?: { label: string; text: string }[];
  hint?: string;
  override?: string | null;
  updated_at?: string | null;
}

interface Entry {
  id: string;
  group: string;
  title: string;
  when: string;
  tier: "extract" | "research" | "reason" | "write";
  receives: string[];
  units: Unit[];
}

const TIER_LABELS: Record<Entry["tier"], string> = {
  extract: "Extracting model",
  research: "Research model",
  reason: "Reasoning model",
  write: "Writing model",
};

const MIN_LENGTH = 20;
const MAX_LENGTH = 20000;

// Prompts a team runs in its own AI tool. They live in the web app, not on the server.
const OWN_TOOL: Entry[] = [
  ...DOC_SECTIONS.map((s) => ({
    id: `own-${s.kind}`,
    group: "Run in your own AI tool",
    title: `${s.title} (House file)`,
    when: `Shown on the ${s.title} page under "Get this from your AI tool".`,
    tier: "write" as const,
    receives: ["Whatever you share with your own AI tool"],
    units: [{ label: "Prompt", text: s.prompt }],
  })),
  {
    id: "own-format",
    group: "Run in your own AI tool",
    title: "Format style profile (House file)",
    when: "Shown on each format's page. The format's name is filled in.",
    tier: "write",
    receives: ["Examples you share with your own AI tool"],
    units: [{ label: "Prompt", text: FORMAT_PROMPT("Example format") }],
  },
  {
    id: "own-voice-memory",
    group: "Run in your own AI tool",
    title: "Voice memory rules",
    when: "Shown on the Voice memory page. Paste the list it returns into the box on that page.",
    tier: "extract",
    receives: ["Your own AI tool's memory of how you write"],
    units: [{ label: "Prompt", text: VOICE_MEMORY_PROMPT }],
  },
  {
    id: "own-insights",
    group: "Run in your own AI tool",
    title: "Insight cards from a call transcript",
    when: "Shown on the Insights page. Run it on each transcript; paste the answers back as a column.",
    tier: "extract",
    receives: ["A transcript you paste in"],
    units: [{ label: "Prompt", text: INSIGHT_PROMPT }],
  },
  {
    id: "own-data",
    group: "Run in your own AI tool",
    title: "Proprietary data points",
    when: "Shown on the Proprietary data page.",
    tier: "extract",
    receives: ["Reports or dashboards you share"],
    units: [{ label: "Prompt", text: DATA_PROMPT }],
  },
];

const placeholdersIn = (text: string) => [...new Set(text.match(/\{[A-Z_]+\}/g) ?? [])];

/** Every prompt Writ uses. Editors can change them for this company; each can be reset to Writ's version. */
export function PromptsPage() {
  const company = useCompany();
  const { session } = useSession();
  const canEdit = company.role === "editor";
  const { data, error, reload } = useLoad(
    async () => (await callFunction<{ prompts: Entry[] }>("ai", { task: "prompts", company_id: company.id })).prompts,
    [company.id],
  );
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...(data ?? []), ...OWN_TOOL].filter((p) =>
      !q || `${p.title} ${p.when} ${p.units.map((u) => `${u.label} ${u.override ?? u.text}`).join(" ")}`.toLowerCase().includes(q));
    const out = new Map<string, Entry[]>();
    for (const p of all) out.set(p.group, [...(out.get(p.group) ?? []), p]);
    return [...out];
  }, [data, query]);

  const edited = (data ?? []).flatMap((e) => e.units).filter((u) => u.override).length;

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>Prompts</h1>
        <Lede more={<>These are the instructions Writ gives the AI at each step. {canEdit
          ? "As an editor you can change any of them for this company; a change applies to the next run, for everyone, and you can reset it to Writ's version at any time. "
          : "Editors can change them for this company. "}
          Each step still receives only the context listed under it (for example, research never receives your voice). Parts Writ adds after a prompt, such as the output format its parser reads, are shown but can't be edited.</>}>
          Every prompt Writ uses, and what each one receives.{edited > 0 && ` ${edited} edited for ${company.name}.`}
        </Lede>
      </div>
      <ErrorText>{error}</ErrorText>
      {!data && !error ? <Loading /> : (
        <div className="stack-lg">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the prompts"
            aria-label="Search the prompts"
          />
          {groups.length === 0 && <p className="muted">No prompt matches that.</p>}
          {groups.map(([group, entries]) => (
            <section key={group} className="stack" style={{ gap: 8 }}>
              <h2>{group}</h2>
              {entries.map((e) => (
                <EntryView
                  key={e.id}
                  entry={e}
                  canEdit={canEdit}
                  companyId={company.id}
                  userId={session?.user.id ?? ""}
                  onChanged={reload}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryView({ entry, canEdit, companyId, userId, onChanged }: {
  entry: Entry;
  canEdit: boolean;
  companyId: string;
  userId: string;
  onChanged: () => void;
}) {
  const changed = entry.units.some((u) => u.override);
  return (
    <details className="helper">
      <summary>
        {entry.title}
        {changed && <span className="tag flag" style={{ marginLeft: 8 }}>edited</span>}
      </summary>
      <div className="helper-body">
        <p className="small muted">{entry.when}</p>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="tag">{TIER_LABELS[entry.tier]}</span>
          {entry.receives.map((r) => <span key={r} className="tag">{r}</span>)}
        </div>
        {entry.units.map((u) => (
          <UnitView key={u.key ?? u.label} unit={u} canEdit={canEdit} companyId={companyId} userId={userId} onChanged={onChanged} />
        ))}
      </div>
    </details>
  );
}

function UnitView({ unit, canEdit, companyId, userId, onChanged }: {
  unit: Unit;
  canEdit: boolean;
  companyId: string;
  userId: string;
  onChanged: () => void;
}) {
  const saved = unit.override ?? unit.text;
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = Boolean(unit.key) && canEdit;
  const dirty = draft !== saved;
  const missing = placeholdersIn(unit.text).filter((p) => !draft.includes(p));
  const tooShort = draft.trim().length < MIN_LENGTH;
  const tooLong = draft.length > MAX_LENGTH;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await fn();
      if (err) throw new Error(err.message);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const reset = () => run(async () => {
    const r = await supabase.from("prompt_overrides").delete().eq("company_id", companyId).eq("prompt_key", unit.key!);
    if (!r.error) setDraft(unit.text);
    return r;
  });

  // Saving Writ's own text is the same as having no version of your own.
  const save = () => (draft.trim() === unit.text.trim()
    ? reset()
    : run(() => supabase.from("prompt_overrides").upsert(
      { company_id: companyId, prompt_key: unit.key!, text: draft, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: "company_id,prompt_key" },
    )));

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <strong className="small">{unit.label}</strong>
        {unit.override && <span className="tag flag">edited{unit.updated_at ? ` ${formatDate(unit.updated_at)}` : ""}</span>}
        <span className="spacer" />
        <CopyButton text={editable ? draft : saved} />
      </div>
      {unit.hint && <p className="small muted">{unit.hint}</p>}
      {editable ? (
        <>
          <textarea
            className="prompt-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(24, Math.max(8, draft.split("\n").length + 1))}
            spellCheck={false}
            aria-label={`${unit.label} prompt`}
          />
          {missing.length > 0 && (
            <p className="small flag-text">
              Writ's version has {missing.join(", ")}, which Writ fills in at run time. Without {missing.length > 1 ? "them" : "it"}, that part is left out.
            </p>
          )}
          {tooShort && <p className="small flag-text">A prompt needs at least {MIN_LENGTH} characters.</p>}
          {tooLong && <p className="small flag-text">A prompt can be at most {MAX_LENGTH.toLocaleString()} characters.</p>}
          <ErrorText>{error}</ErrorText>
          <div className="row">
            <button type="button" className="btn btn-primary btn-small" disabled={busy || !dirty || tooShort || tooLong} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            {dirty && <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setDraft(saved)}>Discard changes</button>}
            {(unit.override || draft !== unit.text) && (
              <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => (unit.override ? reset() : setDraft(unit.text))}>
                Reset to Writ's version
              </button>
            )}
            {!dirty && <span className="small faint disabled-reason">{unit.override ? "Your version is in use." : "Writ's version is in use."}</span>}
          </div>
        </>
      ) : (
        <pre className="prompt">{saved}</pre>
      )}
      {(unit.locked ?? []).map((l) => (
        <details key={l.label} className="how">
          <summary>{l.label} (can't be edited)</summary>
          <pre className="prompt">{l.text}</pre>
        </details>
      ))}
    </div>
  );
}
