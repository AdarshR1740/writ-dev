import { useCallback, useEffect, useMemo, useState } from "react";
import { callFunction, errorMessage, supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { formatCost, plural } from "../lib/format";
import {
  SOURCE_TYPE_LABELS,
  type Card,
  type Piece,
  type Section,
  type ResearchItem,
  type Source,
  type SourceType,
} from "../lib/types";
import { AiAction, ErrorText, Loading, Tabs } from "./ui";
import { normalise } from "../lib/recipes";

interface Loaded {
  items: ResearchItem[];
  pieceItems: ResearchItem[];
  library: Source[];
  cards: Card[];
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

/** Research and its review gate, for the whole piece or one section. */
export function ResearchStep({ piece, section, blocked, onAdvanced }: {
  piece: Piece;
  section?: Section;
  blocked?: string | null;
  onAdvanced: () => void;
}) {
  const { data, error, reload, setData } = useLoad<Loaded>(async () => {
    const itemQuery = supabase.from("research_items").select("*, sources(id, url, title, published, in_library)")
      .eq("piece_id", piece.id);
    const [items, pieceItems, library, cards] = await Promise.all([
      (section ? itemQuery.eq("scope", "section").eq("section_key", section.id) : itemQuery.eq("scope", "piece"))
        .order("created_at").then(must<ResearchItem[]>),
      section
        ? supabase.from("research_items").select("*, sources(id, url, title, published, in_library)")
          .eq("piece_id", piece.id).eq("scope", "piece").eq("status", "approved").then(must<ResearchItem[]>)
        : Promise.resolve([] as ResearchItem[]),
      supabase.from("sources").select("id, url, title, published, origin, in_library, tags, last_checked")
        .eq("company_id", piece.company_id).eq("in_library", true).then(must<Source[]>),
      supabase.from("cards").select("*").eq("company_id", piece.company_id).then(must<Card[]>),
    ]);
    return { items, pieceItems, library, cards };
  }, [piece.id, section?.id]);

  const [focus, setFocus] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = section ? section.status !== "research" : piece.stage !== "research";
  const recipe = normalise(piece.recipe);
  const reviewing = recipe.research.review;
  const canSearch = recipe.research.web_search && (section ? recipe.sections.research : recipe.research.enabled);
  const scopePayload: Record<string, string> = section ? { section_id: section.id } : { piece_id: piece.id };

  const ordered = useMemo(() => {
    const rank = { unreviewed: 0, approved: 1, rejected: 2 } as const;
    return [...(data?.items ?? [])].sort((a, b) => rank[a.status] - rank[b.status]);
  }, [data?.items]);

  const review = useCallback(async (item: ResearchItem, decision: ResearchItem["status"], statement?: string) => {
    setActionError(null);
    // Optimistic: reviewing is the fast path, so don't wait for the round trip.
    setData((d) => d && { ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, status: decision, statement: statement ?? i.statement } : i)) });
    const { error: err } = await supabase.rpc("review_item", { item: item.id, decision, new_statement: statement ?? null });
    if (err) {
      setActionError(err.message);
      reload();
    }
  }, [setData, reload]);

  // Keyboard review: j/k to move, a to approve, r to reject, u to undo.
  useEffect(() => {
    if (locked || !reviewing) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const item = ordered[focus];
      if (e.key === "j") setFocus((f) => Math.min(f + 1, ordered.length - 1));
      else if (e.key === "k") setFocus((f) => Math.max(f - 1, 0));
      else if (item && e.key === "a") review(item, "approved");
      else if (item && e.key === "r") review(item, "rejected");
      else if (item && e.key === "u") review(item, "unreviewed");
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ordered, focus, review, locked, reviewing]);

  useEffect(() => {
    document.getElementById(`item-${ordered[focus]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [focus, ordered]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;

  const counts = {
    unreviewed: data.items.filter((i) => i.status === "unreviewed").length,
    approved: data.items.filter((i) => i.status === "approved").length,
    rejected: data.items.filter((i) => i.status === "rejected").length,
  };
  const mix = Object.entries(
    data.items.filter((i) => i.status !== "rejected").reduce<Record<string, number>>((acc, i) => {
      acc[i.source_type] = (acc[i.source_type] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  const usedStatements = new Set(data.items.map((i) => i.statement));
  const unusedPieceItems = data.pieceItems.filter((i) => !usedStatements.has(i.statement));
  const pieceWords = words(`${piece.title} ${piece.primary_keyword} ${piece.topic} ${section?.heading ?? ""}`);
  const usedSources = new Set(data.items.map((i) => i.source_id));
  const usedCards = new Set(data.items.map((i) => i.card_id));
  const librarySuggestions = data.library
    .filter((s) => !usedSources.has(s.id))
    .map((s) => ({ s, score: [...words(`${s.title} ${s.tags.join(" ")}`)].filter((w) => pieceWords.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const cardSuggestions = data.cards
    .filter((c) => !usedCards.has(c.id))
    .map((c) => ({ c, score: [...words(`${c.claim} ${c.tags.join(" ")}`)].filter((w) => pieceWords.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const addCard = (c: Card) => act(async () => {
    must(await supabase.from("research_items").insert({
      company_id: piece.company_id,
      piece_id: piece.id,
      scope: section ? "section" : "piece",
      section_key: section?.id ?? null,
      card_id: c.id,
      statement: c.claim,
      quote: c.detail,
      source_type: "card",
    }).select("id"));
  });

  return (
    <div className="workbench">
      <div className="stack-lg">
        <div className="gate">
          <div className="stack" style={{ gap: 4 }}>
            <strong>
              {data.items.length === 0
                ? "No research yet"
                : !reviewing
                ? `${plural(counts.approved, "item")}, approved automatically`
                : counts.unreviewed > 0
                ? `${plural(counts.unreviewed, "item")} to review`
                : `${counts.approved} approved, ${counts.rejected} rejected`}
            </strong>
            <span className="small muted">
              {reviewing
                ? <>Every item needs your decision before {section ? "the brief" : "the next step"}. AI found these; it can't vouch for them.</>
                : "This format's workflow skips item-by-item review. Reject anything that looks wrong; the summary will say research wasn't individually reviewed."}
            </span>
          </div>
          <span className="spacer" />
          {!locked && reviewing && counts.unreviewed > 0 && <span className="small muted disabled-reason">{counts.unreviewed} still to decide</span>}
          {!locked && (
            <button type="button" className="btn btn-primary" disabled={busy || (reviewing && counts.unreviewed > 0)}
              onClick={() => act(async () => {
                const { error: err } = section
                  ? await supabase.rpc("complete_section_research", { target_section: section.id })
                  : await supabase.rpc("complete_piece_research", { target_piece: piece.id });
                if (err) throw err;
                onAdvanced();
              })}>
              {counts.approved === 0 ? "Continue without research" : "Finish research"}
            </button>
          )}
          {locked && <span className="tag ok">Locked</span>}
        </div>

        {mix.length > 0 && (
          <div className="mix" aria-label="Source mix">
            {mix.map(([type, n]) => (
              <span key={type} className="tag">{SOURCE_TYPE_LABELS[type as SourceType]} · {n}</span>
            ))}
            {!mix.some(([t]) => t === "critical") && <span className="small faint">No critical views yet.</span>}
          </div>
        )}

        <ErrorText>{actionError}</ErrorText>
        {note && <p className="notice">{note}</p>}

        {!locked && reviewing && data.items.length > 0 && (
          <p className="small faint">Keys: <span className="mono">j</span>/<span className="mono">k</span> move, <span className="mono">a</span> approve, <span className="mono">r</span> reject, <span className="mono">u</span> undo.</p>
        )}

        <div className="card-list">
          {ordered.map((item, i) => (
            <ItemView
              key={item.id}
              item={item}
              focused={!locked && i === focus}
              locked={locked}
              onFocus={() => setFocus(i)}
              onReview={(d, s) => review(item, d, s)}
              onLibrary={(inLibrary) => item.source_id && act(async () => {
                const r = await callFunction<{ in_library: boolean; saved_text?: boolean }>("research", {
                  action: "library", source_id: item.source_id, in_library: inLibrary,
                });
                if (r.in_library && r.saved_text === false) {
                  setNote("Added to the library, but the page couldn't be saved. When you use it later, you'll be asked to paste its text.");
                }
              })}
            />
          ))}
        </div>
      </div>

      {!locked && (
        <aside className="rail" aria-label="Find research">
          {blocked && <p className="notice info">{blocked}</p>}
          {section && recipe.sections.reuse_piece_items && unusedPieceItems.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <h3>From piece research</h3>
              <p className="small muted">Already approved for the piece. Reuse what this section needs.</p>
              {unusedPieceItems.slice(0, 8).map((i) => (
                <div key={i.id} className="source">
                  <span className="small">{i.statement}</span>
                  <div className="row"><span className="tag">{SOURCE_TYPE_LABELS[i.source_type]}</span><span className="spacer" />
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => {
                      const { error: err } = await supabase.rpc("use_piece_item", { item: i.id, target_section: section.id });
                      if (err) throw err;
                    })}>Use</button></div>
                </div>
              ))}
            </div>
          )}
          {canSearch && <div className="card stack" style={{ padding: 16 }}>
            <h3>Search the web</h3>
            <p className="small muted">
              Searches across original research, official sources, practitioners, critical views, data and the search
              landscape for your keyword, guided by your reader contract. Each finding comes with the passage that
              supports it, and quotes are checked against the source. Needs an Anthropic or OpenAI key.
            </p>
            <AiAction<{ added: number; unverified?: number; cost_usd: number | null }>
              fn="research"
              label={data.items.length ? "Search again" : "Search"}
              disabled={Boolean(blocked)}
              reason="Not yet: see the note above"
              payload={{ action: "search", ...scopePayload }}
              onDone={(r) => { setNote(`${plural(r.added, "new item")} to review.${r.unverified ? ` ${r.unverified} quote${r.unverified === 1 ? "" : "s"} couldn't be found on the page; check those first.` : ""} ${r.cost_usd !== null ? `This search cost ${formatCost(r.cost_usd)}.` : ""}`); reload(); }}
            />
          </div>}

          {recipe.research.manual && <AddSource piece={piece} scope={scopePayload} onAdded={(n) => { setNote(`${plural(n, "new item")} from your source.`); reload(); }} />}

          {recipe.research.cards && cardSuggestions.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <h3>Your insights</h3>
              {cardSuggestions.map(({ c }) => (
                <div key={c.id} className="source">
                  <span className="small"><strong>{c.claim}</strong></span>
                  <div className="row"><span className="tag">{c.citation}</span><span className="spacer" />
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => addCard(c)}>Add</button></div>
                </div>
              ))}
            </div>
          )}

          {recipe.research.library && librarySuggestions.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <h3>From your library</h3>
              {librarySuggestions.map(({ s }) => (
                <div key={s.id} className="source">
                  <strong className="small">{s.title}</strong>
                  <AiAction<{ added: number }>
                    fn="research"
                    primary={false}
                    label="Use"
                    payload={{ action: "extract_source", ...scopePayload, source_id: s.id }}
                    onDone={(r) => { setNote(`${plural(r.added, "new item")} from your library.`); reload(); }}
                  />
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function ItemView({ item, focused, locked, onFocus, onReview, onLibrary }: {
  item: ResearchItem;
  focused: boolean;
  locked: boolean;
  onFocus: () => void;
  onReview: (d: ResearchItem["status"], statement?: string) => void;
  onLibrary: (inLibrary: boolean) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const src = item.sources;
  const link = src?.url && item.quote
    ? `${src.url}#:~:text=${encodeURIComponent(item.quote.split(" … ")[0].slice(0, 120))}`
    : src?.url ?? null;
  return (
    <article id={`item-${item.id}`} className={`research ${item.status}${focused ? " focused" : ""}`} onClick={onFocus}>
      <div className="row" style={{ gap: 6 }}>
        <span className="tag">{SOURCE_TYPE_LABELS[item.source_type]}</span>
        {item.status !== "unreviewed" && <span className={`tag ${item.status === "approved" ? "ok" : ""}`}>{item.status}</span>}
        {item.edited && <span className="tag">edited</span>}
        <span className="spacer" />
        {!locked && editing === null && (
          <>
            <button type="button" className="btn btn-small" onClick={() => setEditing(item.statement)}>Edit</button>
            {item.status !== "rejected" && <button type="button" className="btn btn-small" onClick={() => onReview("rejected")}>Reject</button>}
            {item.status !== "approved" && <button type="button" className="btn btn-small btn-primary" onClick={() => onReview("approved")}>Approve</button>}
            {item.status !== "unreviewed" && <button type="button" className="btn btn-quiet btn-small" onClick={() => onReview("unreviewed")}>Undo</button>}
          </>
        )}
      </div>
      {editing === null ? (
        <p className="claim">{item.statement}</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <textarea rows={3} value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Statement" autoFocus />
          <div className="row">
            <button type="button" className="btn btn-small btn-primary" onClick={() => { onReview("approved", editing); setEditing(null); }}>Save and approve</button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {item.quote && <blockquote className="quote">{item.quote}</blockquote>}
      {item.quote_status === "unverified" && (
        <p className="small flag-text">This quote wasn't found word for word in the source. Open the source and check before approving.</p>
      )}
      <div className="meta">
        {item.card_id ? <span>From your insight cards</span> : link ? <a href={link} target="_blank" rel="noreferrer">{src?.title || src?.url}</a> : <span>{src?.title}</span>}
        {src?.published && <span>· {src.published}</span>}
        {item.secondary && <span className="tag flag">secondary: trace it to the original</span>}
        {item.quote_status === "verified" && <span className="tag ok" title="The model quoted it and we found it word for word in the source">quote checked</span>}
        {item.quote_status === "cited" && item.source_id && <span className="tag" title="The provider's citation API returned this passage">cited passage</span>}
        {src && !locked && (
          <button type="button" className="btn btn-quiet btn-small" onClick={(e) => { e.stopPropagation(); onLibrary(!src.in_library); }}>
            {src.in_library ? "In library ✓" : "Add source to library"}
          </button>
        )}
      </div>
    </article>
  );
}

function AddSource({ piece, scope, onAdded }: { piece: Piece; scope: Record<string, string>; onAdded: (n: number) => void }) {
  const [tab, setTab] = useState<"url" | "paste">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [fetched, setFetched] = useState<{ url: string; title: string; text: string; published: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage() {
    setBusy(true);
    setError(null);
    try {
      const r = await callFunction<{ ok: boolean; paste?: boolean; reason?: string; url?: string; title?: string; text?: string; published?: string }>(
        "fetch-url", { company_id: piece.company_id, url },
      );
      if (r.ok && r.text) setFetched({ url: r.url!, title: r.title ?? "", text: r.text, published: r.published ?? "" });
      else {
        setError(r.reason ?? "Couldn't fetch that page.");
        if (r.paste) { setTab("paste"); setTitle(url); }
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const payload = tab === "url" && fetched
    ? { action: "extract_source", ...scope, origin: "url", url: fetched.url, title: fetched.title, text: fetched.text, published: fetched.published }
    : { action: "extract_source", ...scope, origin: "paste", url: title.startsWith("http") ? title : null, title, text };

  return (
    <div className="card stack" style={{ padding: 16 }}>
      <h3>Add a source yourself</h3>
      <Tabs value={tab} onChange={(t) => { setTab(t); setError(null); }} options={[{ value: "url", label: "URL" }, { value: "paste", label: "Paste" }]} />
      {tab === "url" ? (
        fetched ? (
          <p className="small"><strong>{fetched.title || fetched.url}</strong> · {plural(fetched.text.split(/\s+/).length, "word")}</p>
        ) : (
          <div className="row">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Source URL" style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={busy || !url.trim()} onClick={fetchPage}>{busy ? "Fetching…" : "Fetch"}</button>
          </div>
        )
      ) : (
        <>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title or URL" aria-label="Source title" />
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the article or report text" aria-label="Source text" style={{ minHeight: 100 }} />
        </>
      )}
      <ErrorText>{error}</ErrorText>
      {(fetched || (tab === "paste" && text.trim().length >= 200)) && (
        <AiAction<{ added: number }>
          fn="research"
          label="Pull findings"
          payload={payload}
          onDone={(r) => { setFetched(null); setUrl(""); setText(""); setTitle(""); onAdded(r.added); }}
        />
      )}
    </div>
  );
}
