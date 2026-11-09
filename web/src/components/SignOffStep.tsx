import { useState } from "react";
import { MemoryPanel } from "./MemoryPanel";
import { MarkdownView } from "./Links";
import { ExportPanel } from "./ExportPanel";
import { errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatDate, plural } from "../lib/format";
import { useCompany } from "../lib/session";
import type { Piece, Section } from "../lib/types";
import { ContractResults } from "./WritingStep";
import { AiAction, CopyButton, ErrorText, Loading, CleanTextarea } from "./ui";
import { useSession } from "../lib/session";
import { SeoGeoPanel } from "./SeoGeoPanel";
import { WriteLike } from "./WriteLike";
import { normalise, type Recipe } from "../lib/recipes";

interface Record_ {
  sections: Section[];
  items: { id: string; source_id: string | null; source_type: string; scope: string; reviewed_by: string | null }[];
  company: { editorial_record: boolean; disclosure_line: string };
  signer: { display_name: string | null; email: string } | null;
}

async function load(piece: Piece, companyId: string): Promise<Record_> {
  const [sections, items, company, signer] = await Promise.all([
    supabase.from("piece_sections").select("*").eq("piece_id", piece.id).order("position").then(must<Section[]>),
    supabase.from("research_items").select("id, source_id, source_type, scope, reviewed_by").eq("piece_id", piece.id).eq("status", "approved")
      .then(must<Record_["items"]>),
    supabase.from("companies").select("editorial_record, disclosure_line").eq("id", companyId).single()
      .then(must<Record_["company"]>),
    piece.signed_off_by
      ? supabase.from("profiles").select("display_name, email").eq("id", piece.signed_off_by).single()
        .then(must<NonNullable<Record_["signer"]>>)
      : Promise.resolve(null),
  ]);
  return { sections, items, company, signer };
}

/** Built from the records, never a template. */
export function provenance(r: Record_, signerName: string | null, recipe: Recipe): string {
  const insights = r.items.filter((i) => i.source_type === "card").length;
  const sources = new Set(r.items.filter((i) => i.source_id).map((i) => i.source_id)).size;
  const autoApproved = r.items.filter((i) => !i.reviewed_by).length;
  const human = r.sections.filter((s) => s.written_by === "writer").length;
  const aiStarted = r.sections.filter((s) => s.written_by === "ai_then_writer").length;
  const open = r.sections.length - human - aiStarted;
  const research = sources + insights === 0
    ? "Written without separate research."
    : autoApproved === r.items.length
    ? `Researched with AI from ${plural(sources, "source")}${insights ? ` and ${plural(insights, "internal insight")}` : ""}; research was not individually reviewed.`
    : autoApproved > 0
    ? `Researched with AI from ${plural(sources, "source")}${insights ? ` and ${plural(insights, "internal insight")}` : ""}; ${r.items.length - autoApproved} of ${r.items.length} items were approved by a person.`
    : `Researched with AI from ${plural(sources, "reviewed source")}${insights ? ` and ${plural(insights, "internal insight")}` : ""}, every one approved by a person.`;
  const parts = [
    research,
    `${human} of ${plural(r.sections.length, "section")} written by hand${aiStarted ? `; ${aiStarted} started from an AI draft and edited` : ""}${open ? `; ${open} not written yet` : ""}.`,
  ];
  if (signerName) parts.push(recipe.signoff.required || r.company.editorial_record ? `Approved by ${signerName}.` : `Marked done by ${signerName}, without a named sign-off.`);
  return parts.join(" ");
}

export function SignOffStep({ piece, onChanged }: { piece: Piece; onChanged: () => void }) {
  const company = useCompany();
  const { data, error, reload } = useLoad(() => load(piece, company.id), [piece.id, piece.signed_off_at, piece.final_check?.checked_at]);
  const [finalText, setFinalText] = useState(piece.final_text ?? "");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const done = piece.stage === "done";
  const unwritten = data.sections.filter((s) => s.status !== "written");
  const signerName = data.signer ? data.signer.display_name || data.signer.email : null;
  const recipe = normalise(piece.recipe);
  const summary = provenance(data, signerName, recipe);
  const formalSignOff = recipe.signoff.required || data.company.editorial_record;
  const needsEditor = (data.company.editorial_record || (recipe.signoff.required && recipe.signoff.editor_required)) && company.role !== "editor";
  const contractCheck = recipe.checks.contract && recipe.contract.mode !== "off";
  const needsApproval = recipe.checks.customer_approval && !piece.customer_approval;
  // A single section headed like the piece itself doesn't repeat the title.
  const shown = data.sections.map((s) => ({
    heading: data.sections.length === 1 && s.heading.trim().toLowerCase() === piece.title.trim().toLowerCase() ? "" : s.heading,
    content: s.content.trim(),
  }));
  const draft = shown.map((s) => (s.heading ? `## ${s.heading}\n\n${s.content}` : s.content)).join("\n\n");

  async function exportAudit() {
    try {
      const [events, contract, items, threads] = await Promise.all([
        supabase.from("piece_events").select("action, detail, created_at, actor").eq("piece_id", piece.id).order("created_at").then(must),
        supabase.from("piece_contracts").select("*").eq("piece_id", piece.id).single().then(must),
        supabase.from("research_items").select("*, sources(url, title, published)").eq("piece_id", piece.id).then(must),
        supabase.from("threads").select("subject, section_key, thread_messages(role, content, payload, created_at)").eq("piece_id", piece.id).then(must),
      ]);
      const blob = new Blob([JSON.stringify({
        exported_at: new Date().toISOString(),
        piece: { id: piece.id, title: piece.title, primary_keyword: piece.primary_keyword, signed_off_at: piece.signed_off_at, signed_off_by: signerName },
        provenance: summary,
        contract,
        final_check: piece.final_check,
        sections: data!.sections.map((s) => ({ heading: s.heading, written_by: s.written_by, brief: s.brief, content: s.content, ai_draft: s.ai_draft, contract_check: s.contract_check, fact_check: s.fact_check })),
        research_items: items,
        threads,
        events,
      }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${piece.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-audit.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <div className={`workbench signoff-bench${done ? " is-done" : ""}`}>
      <div className="stack-lg">
        <section className="doc-surface" aria-label="Full draft">
          <header>
            <strong>The piece</strong>
            <span className="small faint">{plural(draft.split(/\s+/).filter(Boolean).length, "word")}</span>
            <span className="spacer" />
            <CopyButton text={`# ${piece.title}\n\n${draft}`} label="Copy as Markdown" />
          </header>
          <article className="doc-render formatted">
            <h1>{piece.title}</h1>
            {shown.map((sec, i) => (
              <section key={i}>
                {sec.heading && <h2>{sec.heading}</h2>}
                <Prose text={sec.content} />
              </section>
            ))}
          </article>
        </section>

        {contractCheck && <section className="card stack">
          <div className="check-head">
            <strong>Final check</strong>
            <span className="small muted">Does the whole piece cover its scope? Sign-off needs it.</span>
          </div>
          <div className="row">
            {!done && (
              <AiAction label={piece.final_check ? "Check again" : "Run final check"} primary={!piece.final_check}
                disabled={unwritten.length > 0} reason="Write every section first" payload={{ task: "contract_check", piece_id: piece.id }} onDone={onChanged} />
            )}
          </div>
          {unwritten.length > 0 && <p className="notice info small">Still to write: {unwritten.map((s) => s.heading).join(", ")}.</p>}
          {piece.final_check ? <ContractResults results={piece.final_check.results} /> : <p className="small muted">Not run yet.</p>}
        </section>}
        {!contractCheck && unwritten.length > 0 && <p className="notice info small">Write every section first: {unwritten.map((s) => s.heading).join(", ")}.</p>}

        {(recipe.checks.seo || recipe.checks.geo) && (
          <SeoGeoPanel piece={piece} scope="final" result={piece.seo_geo_final} disabled={unwritten.length > 0 || done} reason={done ? undefined : "Write every section first"} onDone={onChanged} onEdited={() => { reload(); onChanged(); }} />
        )}

        <MemoryPanel piece={piece} disabled={!data.sections.some((s) => s.content.trim())} reason="Write something first" onDone={onChanged} />
      </div>

      <aside className="rail" aria-label="Sign-off">
        <div className="card stack" style={{ padding: 16 }}>
          <h3>{done ? (formalSignOff ? "Signed off" : "Done") : formalSignOff ? "Sign off" : "Finish"}</h3>
          {done ? (
            <p className="small">{formalSignOff ? "By" : "Marked done by"} <strong>{signerName}</strong> on {formatDate(piece.signed_off_at!)}.</p>
          ) : (
            <>
              <p className="small muted">
                {data.company.editorial_record
                  ? "This company keeps an editorial record: a named editor signs off every piece."
                  : formalSignOff
                  ? `Signing off records you as the person who approved this piece${needsEditor || recipe.signoff.editor_required ? " (an editor must sign this format)" : ""}.`
                  : "This format doesn't need a named sign-off. Marking it done records who finished it."}
              </p>
              {recipe.checks.customer_approval && <CustomerApproval piece={piece} onRecorded={onChanged} />}
              {recipe.signoff.final_paste && (
                <details className="helper">
                  <summary>Edit the whole piece to sound like a leader</summary>
                  <div className="helper-body">
                    <WriteLike text={draft} what="piece" />
                    <p className="small muted">Paste the edited version into the box below. The sections above stay as you wrote them.</p>
                  </div>
                </details>
              )}
              {recipe.signoff.final_paste && (
                <label className="field">
                  <span>Final published version (optional)</span>
                  <CleanTextarea rows={4} value={finalText} onChange={(e) => setFinalText(e.target.value)} style={{ minHeight: 90 }}
                    placeholder="Edited it elsewhere? Paste the version you publish. The difference teaches the tool your edits." />
                </label>
              )}
              <ErrorText>{actionError}</ErrorText>
              {needsEditor && <p className="small faint">Only an editor can sign off.</p>}
              <button type="button" className="btn btn-primary" disabled={busy || needsEditor || unwritten.length > 0 || (contractCheck && !piece.final_check) || needsApproval} onClick={async () => {
                setBusy(true);
                setActionError(null);
                const { error: err } = await supabase.rpc("sign_off", { target_piece: piece.id, final_version: finalText.trim() || null });
                setBusy(false);
                if (err) setActionError(err.message);
                else { reload(); onChanged(); }
              }}>
                {formalSignOff ? `Sign off as ${company.role === "editor" ? "editor" : "approver"}` : "Mark done"}
              </button>
              {!needsEditor && (unwritten.length > 0 || (contractCheck && !piece.final_check) || needsApproval) && (
                <span className="small muted disabled-reason">
                  {unwritten.length > 0 ? "Write every section first" : contractCheck && !piece.final_check ? "Run the final check first" : "Record the customer's approval first"}
                </span>
              )}
            </>
          )}
        </div>

        {done && <ExportPanel piece={piece} sections={data.sections.map((s) => ({ heading: s.heading, content: s.content }))} disclosure={data.company.disclosure_line} />}

        {done && recipe.signoff.learn && <LearnPanel piece={piece} />}

        <div className="card stack" style={{ padding: 16 }}>
          <h3>How this was made</h3>
          <p className="small">{summary}</p>
          <CopyButton text={summary} label="Copy summary" />
        </div>

        <div className="card stack" style={{ padding: 16 }}>
          <h3>Disclosure line</h3>
          <p className="small muted">Optional. Publish it if you want to; edit the default in Team settings.</p>
          <p className="small"><em>{data.company.disclosure_line}</em></p>
          <CopyButton text={data.company.disclosure_line} label="Copy line" />
        </div>

        <div className="card stack" style={{ padding: 16 }}>
          <h3>Audit trail</h3>
          <p className="small muted">Every source, approval, brief, check and conversation for this piece, as a file.</p>
          <button type="button" className="btn btn-small" onClick={exportAudit}>Export audit trail</button>
        </div>
      </aside>
    </div>
  );
}

function LearnPanel({ piece }: { piece: Piece }) {
  const { session } = useSession();
  const [rules, setRules] = useState<{ rule: string; evidence: string; kept?: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card stack" style={{ padding: 16 }}>
      <h3>Learn from this piece</h3>
      <p className="small muted">Suggests voice rules from your edits, the final version and your feedback. You choose what to keep.</p>
      <AiAction<{ rules: { rule: string; evidence: string }[] }>
        label="Suggest voice rules"
        primary={false}
        payload={{ task: "learn_voice", piece_id: piece.id }}
        onDone={(r) => setRules(r.rules)}
      />
      {rules && rules.length === 0 && <p className="small muted">Nothing new to learn from this piece.</p>}
      {rules?.map((r, i) => (
        <div key={i} className="source">
          <span className="small"><strong>{r.rule}</strong></span>
          <span className="small faint">{r.evidence}</span>
          <div>
            {r.kept ? <span className="tag ok">Kept</span> : (
              <button type="button" className="btn btn-small" onClick={async () => {
                const { error: err } = await supabase.from("voice_memory").insert({
                  company_id: piece.company_id, rule: r.rule, evidence: r.evidence, origin: "learned", source_piece: piece.id, created_by: session!.user.id,
                });
                if (err) setError(err.message);
                else setRules(rules.map((x, j) => (j === i ? { ...x, kept: true } : x)));
              }}>Keep</button>
            )}
          </div>
        </div>
      ))}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function CustomerApproval({ piece, onRecorded }: { piece: Piece; onRecorded: () => void }) {
  const [approver, setApprover] = useState(piece.brief_extra?.approval_contact ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (piece.customer_approval) {
    return (
      <p className="small ok-text">
        Customer approval: {piece.customer_approval.approver}, {formatDate(piece.customer_approval.recorded_at)}
        {piece.customer_approval.note ? ` (${piece.customer_approval.note})` : ""}.
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <strong className="small">Customer approval{piece.brief_extra?.customer ? ` (${piece.brief_extra.customer})` : ""}</strong>
      <input type="text" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="Who approved it" aria-label="Approver" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How and when, e.g. email of 1 Nov" aria-label="Approval note" />
      <ErrorText>{error}</ErrorText>
      <button type="button" className="btn btn-small" disabled={!approver.trim()} onClick={async () => {
        const { error: err } = await supabase.rpc("record_customer_approval", { target_piece: piece.id, approver, note });
        if (err) setError(err.message); else onRecorded();
      }}>Record approval</button>
    </div>
  );
}

/** A section's Markdown shown as formatted text: headings, lists, tables, bold, italic and links. No HTML is injected. */
function Prose({ text }: { text: string }) {
  if (!text) return <p className="faint">Not written yet.</p>;
  return <MarkdownView text={text} />;
}
