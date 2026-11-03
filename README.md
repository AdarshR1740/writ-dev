# Writ

*Expert content, AI-assisted.* Brand notes: `docs/brand.md`.

The full pipeline is built end to end. See `docs/decisions.md` for the reasoning
behind each piece, and §18 there for how each decision was implemented.

## The flow

1. **Brief.**
2. **Reader contract.** Written by the writer, with AI suggestions in a conversation.
3. **Piece research.** Web search with quoted passages, then a review step.
4. **Analysis.** Where sources disagree, where your own insight differs from the
   consensus, and open gaps (each turned into a question for your expert).
5. **Outline.** Each section is linked to the contract expectations it owes.
6. **Each section, in four steps:**
   1. Research.
   2. Review.
   3. A bullet-point brief: fragments only, each fact linked to its source.
   4. Writing by hand.
7. **Checks while writing:** grammar, facts against your approved research, and the
   section's contract expectations.
8. **Final contract check, then sign-off,** with a summary of how the piece was
   made, an optional disclosure line, and an audit export.
9. **Learn from the piece.** Voice rules learned from your edits, the final version you
   paste back, and your messages. You choose which rules to keep.

## Memory across pieces, and Ask Writ

Both answer only from the company's own material, found by one database search
(`search_material`): finished pieces (current versions, by paragraph), insight and data cards, the house
file, approved research and library sources. Every answer or flag points back to a passage you can open.

- **Against what you've published** (sign-off page): compares the piece with earlier finished pieces and
  their research. It flags contradictions (a different figure for the same statistic, an opposite position),
  repeated angles or stories, and earlier pieces worth linking to. Each flag quotes the sentence and the earlier
  passage; a sentence the model didn't copy word for word is marked for you to check. Earlier versions of the same
  piece don't count. No scores.
- **Ask Writ** (sidebar, or "Ask" on phones): questions like "what have we said about pricing?" or "which figures
  have we published?". Answers cite numbered sources; when your material doesn't cover something, Writ says so
  and where it would belong, instead of guessing. If nothing matches, it answers without a model call. It doesn't
  write or rewrite content. The conversation is private to each person and can be cleared. The panel shows the
  cost of a question once, instead of asking before each one; the monthly budget still applies.

Search is keyword-based (Postgres full-text search, words OR-ed and ranked), not meaning-based, so it finds
"pricing" but not "what we charge". Meaning-based search (pgvector) is the next step if that proves limiting.

## Export and spending

**Export.** A finished piece has an Export panel on its sign-off page:

- **Copy formatted**: headings, lists and links survive a paste into Google Docs, WordPress, Webflow or any editor.
- **Word (.docx)**: opens in Word; upload it to Google Drive to edit it as a Google Doc.
- **HTML** (with the meta title and description from the SEO check) and **Markdown**.
- **WordPress**: an editor connects the site once in Team & settings with an application password, which is
  checked, encrypted and never shown again. Any member can then send a finished piece as a draft post. The `publish`
  function only calls public https addresses and doesn't follow redirects.
- Optional sources list and disclosure line. Every export is recorded in the piece's history.

**Spending.** Under AI provider & models, editors set a monthly budget (USD, calendar month in UTC), a warning
level, and optionally a hard limit that stops AI runs once the budget is used up. Every cost check shows where the
month stands and warns before a run that would cross the budget. The Write page shows a notice past the warning
level. Usage is broken down by piece. Costs are Writ's estimates from token counts; runs on models without a known
price don't count towards the budget.

## History, revisions and repurposing

- **IDs and versions.** Every piece has a readable ID (for example `NL-0042`) and a
  version number. The **History** page lists every piece with its versions, where it
  came from and what was made from it. Any two versions can be compared as a redline.
- **Review schedule.** Finished pieces get a review date (set the interval under
  Team). Due pieces show under History → Review due, where they can be confirmed as
  "still accurate" or revised.
- **Revise.** Any finished version can be revised. The old version is tagged
  "Revised" and linked to the new one. You choose the original or the current
  workflow, and which approved research carries over. Text, outline and contract come
  across to edit.
- **Repurpose.** There are three shapes, each with a "specific requirements" field.
  Each is a planning step in front of the target format's normal workflow, and carried
  research stays approved.

  | Shape | What happens |
  |---|---|
  | Split | One piece becomes several. AI proposes key points, each with its angle and research. |
  | Adapt | One piece becomes one in a new medium. The source is mapped onto the target's structure, and what doesn't translate is flagged. |
  | Combine | Several pieces become one. Themes become sections, and gaps are flagged for new research. |

- **More templates.** Instagram caption and carousel, LinkedIn carousel, X thread,
  short and long video scripts, newsletter, and webinar or talk outline.

## Workflows per format (recipes)

Each format has a **workflow recipe**. Every step can be switched on or off, and so can
the parts inside it. Editors change recipes on the format's **Workflow** tab. The six
templates are presets:

| Template | Contract | Research | Outline | Checks | Sign-off |
|---|---|---|---|---|---|
| Long-form blog | Full | Web plus search landscape, reviewed | Free, analysis | Grammar, fact, contract, SEO, GEO | Named |
| Thought leadership blog | Full | Same | Free, analysis | Same, minus SEO | Named |
| Case study | Full | Internal: cards, library, your own sources | Fixed: challenge, approach, result, quote | All, plus customer approval | Editor |
| Thought leadership LinkedIn post | Lite | Light web (3 searches) | Off (single section) | Grammar, fact, contract | Named |
| Promotional social | Off | Your own sources (offer facts), no review | Off | Grammar, fact | Named |
| Short-form social | Off | Insight cards | Off | Grammar, fact | Named |

- **Dependencies are enforced.** The editor shows why a setting can't be saved.
- **Review and sign-off can be switched off.** Editors can turn off research review
  and the named sign-off. The provenance summary then says so plainly.
- **Recipes are snapshotted.** A piece keeps the recipe it started with.

## Slice 3: analysis, outline, sections, writing, sign-off, voice memory

- **Analysis** of the approved research before outlining. Each gap comes with an
  expert question, and the answer can be saved as an insight card.
- **Outline.** The writer owns it and the AI suggests in a thread. Each section ticks
  the expectations it owes, and expectations no section covers are flagged.
- **Section research.** One section at a time, or every section up front (chosen per
  piece in the brief).
  - *One at a time:* a section's research waits until the earlier sections are written.
  - *Up front:* no briefs until every section's research is reviewed.
  - Approved piece-level items can be reused without a second review.
- **Section brief.** Crisp "label: content" bullets, each fact linked to its approved
  item. You edit, then confirm.
- **Writing.** Writing by hand is the default, with autosave.
  - **Grammar check:** spelling, grammar and punctuation only. Each suggestion can be
    accepted or ignored.
  - **Fact check:** flags claims that aren't supported, or don't match, the approved
    items.
  - **Section contract check:** met / partly / missing, with evidence. No score.
  - **"Draft with AI"** is tucked away. A section drafted that way is recorded as
    `ai_then_writer`.
- **Sign-off.**
  - The full piece, and a final contract check.
  - An optional pasted final version.
  - Sign-off by a named person (an editor is required when the company turns on
    "editorial record" in Team).
  - A provenance summary built from the records.
  - The company's disclosure line.
  - An audit-trail export in JSON.
- **Voice memory.** An editable list of rules, learned or added by hand. Only AI drafting
  reads it.

## Slice 2: pieces, reader contract, research

- **Pieces.** Start one with a brief: working title, the primary keyword you bring
  from your keyword tool, format, topic, goal, and whether section research happens
  one section at a time or all up front.
- **Reader contract.** The writer owns it. The AI suggests in a conversation thread
  that is kept for traceability, and "Use this suggestion" copies its proposal in.
  Confirming needs a core question and at least one expectation. Editing the contract
  later reopens it.
- **Piece research.**
  - Web search through Claude's web search tool, across original research, official
    sources, practitioners, critical views and data, guided by the contract.
  - Every item shows the exact passage the API cited (`cited_text`), never a quote the
    model wrote. Sources you add by URL or paste use document citations the same way.
  - Your own insight cards are suggested by topic, and so are library sources.
  - Review is mandatory: approve, reject or edit each item. The keys `j`/`k`/`a`/`r`/`u`
    also work. The outline unlocks only when every item is decided and at least one is
    approved.
  - "Add source to library" keeps a source and its saved text for later pieces.
- **Editorial record.** Every decision (contract confirmed, item approved or rejected,
  sources added) is written to `piece_events`.
- **Wiring.** The contract stage receives the brief, ICP, positioning and strategy
  notes. Research receives the brief, contract and ICP. Neither stage receives voice
  or memory.

**Providers.** Each company stores keys for several providers and makes one active. All
prompts are listed in `docs/prompts.md`.

| Provider | Default models | Web search | Research quotes |
|---|---|---|---|
| Anthropic (Claude) | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | Yes ($0.01 per search, included in estimates) | Exact passages from Claude's citation API |
| OpenAI (ChatGPT) | GPT-5 nano / mini / GPT-5 | Yes (search fees aren't included in estimates) | The model quotes the passage; the server fetches the page and marks the quote checked, or "not found, check before approving" |
| Google (Gemini) | None, so set a model per task | No | Quotes from your own sources are checked against the source text |
| Local model (Ollama, LM Studio, vLLM) | None, so set your installed model names | No | Quotes from your own sources are checked against the source text |

A local model must be reachable from Supabase's servers over the internet, for example
through a tunnel such as Cloudflare Tunnel or ngrok. `localhost` won't work. Enter the
OpenAI-compatible base URL, ending in `/v1`, plus a key if your server needs one.

## Slice 1: house file

This slice sets up everything the writing pipeline will draw on.

- **Accounts, companies and teams.** Each company is an isolated system. People join
  with an invite link, as an editor or a member. A person can belong to several
  companies, which covers the agency case.
- **AI provider keys.** Keys are checked with the provider, then encrypted on the
  server and never sent back to the browser. A company can store keys for Anthropic,
  OpenAI and Gemini, with one active at a time. Each task type routes to a default
  model, and editors can override the model per task. Every run is logged with its
  tokens and cost.
- **House file.** ICP, positioning, other strategy notes, core voice, and one style
  profile per format. Each one is a context document built from raw material: pasted
  text, uploaded files (.txt, .md, .docx, .pdf) or fetched URLs. AI merges new
  material into the document as a proposal. You review it as a redline, then accept,
  edit or reject it. A proposal made before a hand edit can't overwrite that edit.
- **Insight and proprietary-data cards.** Add cards by importing CSV, JSON or a
  spreadsheet column, by extracting them from a transcript (you review before
  anything is saved), or by hand. Each card is marked public or internal. Every
  section includes a prompt you can run in your own AI tool.

## Layout

```
supabase/migrations/   database schema, row-level security, RPCs
supabase/functions/    edge functions: provider-keys, ai, fetch-url, research, publish (+ _shared)
web/                   React + TypeScript + Vite app
scripts/cloud-setup.sh set up and update your Supabase cloud project
scripts/dev.sh         optional: run everything locally in Docker
docs/                  decisions, prompts, feature audit, design critique, brand
```

## Get started (Supabase cloud)

You need Node 18 or newer and a free project at [supabase.com](https://supabase.com). No Docker.

1. Create a project in the Supabase dashboard. Its ref is in the URL:
   `supabase.com/dashboard/project/<project-ref>`.
2. From this folder, run the setup for your system:

   ```bash
   ./scripts/cloud-setup.sh <project-ref>
   ```

   On Windows, in PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\cloud-setup.ps1 <project-ref>
   ```

   It signs you in to Supabase (a browser opens the first time), links the folder, applies the
   database migrations, sets the key-encryption secret once, deploys every Edge Function, and writes
   `web/.env.local` with your project's URL and public key. Run it again after pulling changes:
   it applies new migrations and redeploys the functions, and keeps the existing secret.
3. In the dashboard, under **Authentication → URL Configuration**, set the Site URL to
   `http://localhost:5173` and add `http://localhost:5173/**` to the redirect URLs. New accounts get a
   confirmation email, and the link needs to come back to the app.
4. Start the app:

   ```bash
   cd web && npm run dev
   ```

   Open http://localhost:5173, create your account, confirm the email, and add your company.

**The encryption secret.** AI keys and WordPress passwords are encrypted with `KEY_ENCRYPTION_SECRET`,
which lives only in the project's secrets. Never change it: if it changes, every saved key has to be
added again.

**Day to day:** changes in `web/` show up in the browser as you save. Changes to
`supabase/functions/` or new files in `supabase/migrations/` reach the cloud project when you run
the setup script again.

On Windows, use `cloud-setup.ps1` in PowerShell (or `cloud-setup.sh` in Git Bash). `npm run dev` checks first that the packages are installed and the project is set up, and says what to run if not.

## Optional: run everything locally

To work offline, `./scripts/dev.sh` runs a separate local Supabase in Docker (needs Docker Desktop)
plus the web app at http://localhost:5173. It keeps its own settings in `web/.env.localdb.local` and
its own data, so it never touches your cloud project or `web/.env.local`. Locally, sign-up needs no
email confirmation. Stop it with Ctrl+C; wipe its data with `npx supabase stop --no-backup`.

The functions run inside Docker and only call public web addresses, so an Ollama or LM Studio server
on `localhost` isn't reachable; use a cloud key, or expose the local model through a tunnel.

## Checks

```bash
cd web && npm run typecheck && npm test && npm run build
```

## Known limits of this slice

- The OpenAI, Gemini and local adapters follow each provider's REST structured-output
  format, but haven't been run against the real APIs. Local models need
  OpenAI-compatible `json_schema` structured output, which recent Ollama and LM Studio
  provide.
- Model prices exist for the Claude defaults, GPT-5 nano and GPT-5 mini. Other models
  record tokens but no cost.
- Invites produce a link to copy. No email is sent.
- Card and library suggestions match on words in the title, keyword and tags. There is no relevance search yet.
- On the free tier, the project pauses after 7 days of inactivity.
- A web search run (up to 6 searches) can take a minute or more. If it hits the Edge
  Function time limit on your plan, lower `MAX_SEARCHES` in
  `supabase/functions/research/index.ts`.
- Partly verified: every migration applies on the local Supabase stack
  (`scripts/dev.sh`). Sign-up, creating a company, starting a piece and the History,
  Team and AI settings pages were run in a browser against it with no errors. The Edge
  Functions type-check but haven't been run against a real model API yet, and nothing
  has run on a hosted Supabase project.
- Edit patterns from draft-vs-final edits are learned only when you run "Learn from this
  piece". Nothing learns in the background.
