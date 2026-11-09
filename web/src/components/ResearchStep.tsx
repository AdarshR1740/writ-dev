import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
} from "../lib/types";
import { AiAction, ErrorText, Loading, Tabs, CleanTextarea } from "./ui";
import { normalise } from "../lib/recipes";
import { cardDetail } from "../lib/cards";
import { MAX_LINKS, parseLinks } from "../lib/links";
import { useShowCosts } from "../lib/showCosts";

interface Loaded {
  items: ResearchItem[];
  pieceItems: ResearchItem[];
  library: Source[];
  cards: Card[];
}

/** The site an item's source came from (e.g. "jasper.ai"), or "Your insights" for items from the insight cards. */
function publisherOf(item: ResearchItem): string {
  const url = item.sources?.url;
  if (!url) return "Your insights";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
  const [addOpen, setAddOpen] = useState(false);
  const showCosts = useShowCosts();
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

  const onSearchDone = (r: { added: number; unverified?: number; cost_usd: number | null }) => {
    setNote(`${plural(r.added, "new item")} to review.${r.unverified ? ` ${r.unverified} quote${r.unverified === 1 ? "" : "s"} couldn't be found on the page; check those first.` : ""} ${showCosts && r.cost_usd !== null ? `This search cost ${formatCost(r.cost_usd)}.` : ""}`.trim());
    reload();
  };

  // `refresh: false` for actions that move to another step, where this step's own data is about to go away.
  async function act(fn: () => Promise<void>, refresh = true) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      if (refresh) await reload();
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
      quote: cardDetail(c.claim, c.detail),
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
                ? `${counts.unreviewed}/${data.items.length} items to review`
                : `${counts.approved} approved, ${counts.rejected} rejected`}
            </strong>
          </div>
          <span className="spacer" />
          {!locked && canSearch && (
            <AiAction<{ added: number; unverified?: number; cost_usd: number | null }>
              fn="research"
              label={data.items.length ? "Search again" : "Do automated research"}
              disabled={Boolean(blocked)}
              reason="Not yet: see the note in this step"
              payload={{ action: "search", ...scopePayload }}
              onDone={onSearchDone}
            />
          )}
          {!locked && (
            <button type="button" className={`btn ${canSearch && data.items.length === 0 ? "" : "btn-primary"}`} disabled={busy || (reviewing && counts.unreviewed > 0)}
              onClick={() => act(async () => {
                const { error: err } = section
                  ? await supabase.rpc("complete_section_research", { target_section: section.id })
                  : await supabase.rpc("complete_piece_research", { target_piece: piece.id });
                if (err) throw err;
                onAdvanced();
              }, false)}>
              {counts.approved === 0 ? "Continue without research" : "Finish research"}
            </button>
          )}
          {locked && <span className="tag ok">Locked</span>}
          {locked && (section ? section.status === "brief" : piece.stage !== "contract" && piece.stage !== "done") && (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => {
              void act(async () => {
                const { error: err } = section
                  ? await supabase.rpc("reopen_section_research", { target_section: section.id })
                  : await supabase.rpc("reopen_piece_research", { target_piece: piece.id });
                if (err) throw err;
                onAdvanced();
              }, false);
            }}>Reopen research</button>
          )}
        </div>

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
            <details className="side-group" open>
              <summary>From piece research <span className="muted">· {unusedPieceItems.length}</span></summary>
              <div className="stack" style={{ gap: 8 }}>
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
            </details>
          )}
          {recipe.research.manual && (
            <details className="side-group" open={addOpen} onToggle={(e) => setAddOpen(e.currentTarget.open)}>
              <summary>Add your own sources</summary>
              <AddSource piece={piece} scope={scopePayload} onAdded={(n) => { setAddOpen(false); setNote(`${plural(n, "new item")} from your source.`); reload(); }} />
            </details>
          )}

          {recipe.research.cards && cardSuggestions.length > 0 && (
            <details className="side-group">
              <summary>Your insights <span className="muted">· {cardSuggestions.length}</span></summary>
              <div className="stack" style={{ gap: 8 }}>
              {cardSuggestions.map(({ c }) => (
                <div key={c.id} className="source">
                  <span className="small"><strong>{c.claim}</strong></span>
                  <div className="row"><span className="tag">{c.citation}</span><span className="spacer" />
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => addCard(c)}>Add</button></div>
                </div>
              ))}
              </div>
            </details>
          )}

          {recipe.research.library && librarySuggestions.length > 0 && (
            <details className="side-group">
              <summary>From your library <span className="muted">· {librarySuggestions.length}</span></summary>
              <div className="stack" style={{ gap: 8 }}>
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
            </details>
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
  // Compact unless the card is the one being reviewed (focused) or being edited.
  const expanded = focused || editing !== null;
  const src = item.sources;
  // Items from cards added earlier may still carry a quote that repeats the statement.
  const shownQuote = item.card_id ? cardDetail(item.statement, item.quote) : item.quote;
  const link =src?.url && item.quote
    ? `${src.url}#:~:text=${encodeURIComponent(item.quote.split(" … ")[0].slice(0, 120))}`
    : src?.url ?? null;
  return (
    <article id={`item-${item.id}`} className={`research ${item.status}${focused ? " focused" : ""}`} onClick={onFocus}>
      <div className="row" style={{ gap: 6 }}>
        <span className="tag">{publisherOf(item)}</span>
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
        <p className={`claim${expanded ? "" : " clamp"}`}>{item.statement}</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <CleanTextarea rows={3} value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Statement" autoFocus />
          <div className="row">
            <button type="button" className="btn btn-small btn-primary" onClick={() => { onReview("approved", editing); setEditing(null); }}>Save and approve</button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {expanded && shownQuote && <blockquote className="quote">{shownQuote}</blockquote>}
      {item.quote_status === "unverified" && (
        <p className="small flag-text">This quote wasn't found word for word in the source. Open the source and check before approving.</p>
      )}
      {expanded && <div className="meta">
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
      </div>}
    </article>
  );
}

function AddSource({ piece, scope, onAdded }: { piece: Piece; scope: Record<string, string>; onAdded: (n: number) => void }) {
  const [tab, setTab] = useState<"url" | "paste">("url");
  const [urls, setUrls] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [fetched, setFetched] = useState<FetchedPage[]>([]);
  const [failed, setFailed] = useState<{ url: string; reason: string }[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The links box rewrites its own text (numbering), which clears the browser's undo history,
  // so keep our own. Typing within a second counts as one step.
  const history = useRef({ past: [] as string[], future: [] as string[], last: 0 });
  // Where the cursor goes after the numbering rewrites the text, so editing mid-list doesn't throw it to the end.
  const box = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && box.current) box.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [urls]);
  const changeUrls = (next: string) => {
    if (next === urls) return;
    const h = history.current;
    if (Date.now() - h.last > 1000) h.past.push(urls);
    h.last = Date.now();
    h.future = [];
    setUrls(next);
  };
  const undoUrls = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (prev === undefined) return;
    h.future.push(urls);
    h.last = 0;
    setUrls(prev);
  };
  const redoUrls = () => {
    const h = history.current;
    const next = h.future.pop();
    if (next === undefined) return;
    h.past.push(urls);
    h.last = 0;
    setUrls(next);
  };

  const links = parseLinks(urls.replace(/^\s*\d+\.\s?/gm, ""));

  // One link per line. Each page is fetched on its own so one blocked site doesn't stop the rest.
  async function fetchPages() {
    setProgress("Fetching…");
    setError(null);
    setFailed([]);
    const got: FetchedPage[] = [];
    const missed: { url: string; reason: string }[] = [];
    const batch = links.slice(0, MAX_LINKS);
    for (const [i, url] of batch.entries()) {
      setProgress(`Fetching ${i + 1} of ${batch.length}…`);
      try {
        const r = await callFunction<{ ok: boolean; paste?: boolean; reason?: string; url?: string; title?: string; text?: string; published?: string }>(
          "fetch-url", { company_id: piece.company_id, url },
        );
        if (r.ok && r.text) got.push({ url: r.url ?? url, title: r.title ?? "", text: r.text, published: r.published ?? "" });
        else missed.push({ url, reason: r.reason ?? "Couldn't fetch that page." });
      } catch (err) {
        missed.push({ url, reason: errorMessage(err) });
      }
    }
    setFetched(got);
    setFailed(missed);
    setProgress(null);
  }

  function reset() {
    setFetched([]);
    setFailed([]);
    setUrls("");
    setText("");
    setTitle("");
  }

  const pasted = { action: "extract_source", ...scope, origin: "paste", url: title.startsWith("http") ? title : null, title, text };
  const payloads = fetched.map((f) => ({
    action: "extract_source", ...scope, origin: "url", url: f.url, title: f.title, text: f.text, published: f.published,
  }));

  return (
    <div className="stack">
      <Tabs value={tab} onChange={(t) => { setTab(t); setError(null); }} options={[{ value: "url", label: "Links" }, { value: "paste", label: "Paste" }]} />
      {tab === "url" ? (
        <>
          {fetched.length === 0 && (
            <>
              <CleanTextarea
                rows={4}
                value={urls}
                ref={box}
                onChange={(e) => {
                  caret.current = null;
                  const raw = e.target.value;
                  const next = numberLines(raw);
                  if (next !== raw) caret.current = caretAfterNumbering(raw, next, e.target.selectionStart);
                  changeUrls(next);
                }}
                onKeyDown={(e) => {
                  const mod = e.ctrlKey || e.metaKey;
                  const key = e.key.toLowerCase();
                  if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); undoUrls(); }
                  else if (mod && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); redoUrls(); }
                  else if (!mod && (key === "backspace" || key === "delete") && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                    // Deleting across a line break takes the number with it, so lines join instead of the number coming back.
                    const pos = e.currentTarget.selectionStart;
                    const prefix = /^\s*\d+\.\s?/;
                    if (key === "backspace") {
                      const lineStart = urls.lastIndexOf("\n", pos - 1) + 1;
                      const len = urls.slice(lineStart).match(prefix)?.[0].length ?? 0;
                      if (lineStart > 0 && pos === lineStart + len) {
                        e.preventDefault();
                        caret.current = lineStart - 1;
                        changeUrls(numberLines(urls.slice(0, lineStart - 1) + urls.slice(lineStart + len)));
                      }
                    } else if (urls[pos] === "\n") {
                      e.preventDefault();
                      const len = urls.slice(pos + 1).match(prefix)?.[0].length ?? 0;
                      caret.current = pos;
                      changeUrls(numberLines(urls.slice(0, pos) + urls.slice(pos + 1 + len)));
                    }
                  }
                }}
                placeholder={"One link per line\nhttps://…\nhttps://…"}
                aria-label="Source links, one per line"
                style={{ minHeight: 90 }}
              />
              <div className="row">
                <button type="button" className="btn" disabled={progress !== null || links.length === 0} onClick={fetchPages}>
                  {progress ?? (links.length > 1 ? `Fetch ${links.length} links` : "Fetch")}
                </button>
                {links.length > MAX_LINKS && <span className="small muted">Only the first {MAX_LINKS} are fetched.</span>}
              </div>
            </>
          )}
          {fetched.length > 0 && (
            <ul className="small stack" style={{ gap: 4, paddingLeft: 18 }}>
              {fetched.map((f) => (
                <li key={f.url}><strong>{f.title || f.url}</strong> · {plural(f.text.split(/\s+/).length, "word")}</li>
              ))}
            </ul>
          )}
          {failed.length > 0 && (
            <div className="notice small stack" style={{ gap: 4 }}>
              <span>{plural(failed.length, "link")} couldn't be fetched. Paste their text on the Paste tab instead:</span>
              {failed.map((f) => <span key={f.url} className="muted">{f.url}: {f.reason}</span>)}
            </div>
          )}
        </>
      ) : (
        <>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title or URL" aria-label="Source title" />
          <CleanTextarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the article or report text" aria-label="Source text" style={{ minHeight: 100 }} />
        </>
      )}
      <ErrorText>{error}</ErrorText>
      {tab === "url" && fetched.length > 0 && (
        <div className="row">
          <AiAction<{ added: number }>
            fn="research"
            label={fetched.length > 1 ? `Pull findings from ${fetched.length} sources` : "Pull findings"}
            payload={payloads[0]}
            payloads={payloads}
            merge={(rs) => ({ added: rs.reduce((n, r) => n + r.added, 0) })}
            onDone={(r) => { reset(); onAdded(r.added); }}
          />
          <button type="button" className="btn btn-quiet btn-small" onClick={reset}>Start over</button>
        </div>
      )}
      {tab === "paste" && text.trim().length >= 200 && (
        <AiAction<{ added: number }>
          fn="research"
          label="Pull findings"
          payload={pasted}
          onDone={(r) => { reset(); onAdded(r.added); }}
        />
      )}
    </div>
  );
}

interface FetchedPage { url: string; title: string; text: string; published: string }

/** Where the cursor belongs once `raw` has been renumbered into `next`: same line, same place in its text. */
function caretAfterNumbering(raw: string, next: string, pos: number): number {
  const before = raw.slice(0, pos).split("\n");
  const line = before.length - 1;
  const prefix = before[line].match(/^\s*\d+\.\s?/)?.[0].length ?? 0;
  const col = Math.max(0, before[line].length - prefix);
  const out = next.split("\n");
  let at = 0;
  for (let i = 0; i < line; i++) at += out[i].length + 1;
  return Math.min(at + `${line + 1}. `.length + col, next.length);
}

/** Keeps the links box numbered: "1. ", "2. ", … one per line. Empty stays empty so the placeholder shows. */
function numberLines(text: string) {
  if (text === "") return "";
  return text.split("\n").map((line, i) => `${i + 1}. ${line.replace(/^\s*\d+\.\s?/, "")}`).join("\n");
}

