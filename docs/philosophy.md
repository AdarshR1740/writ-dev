# Writ: philosophy, positioning and the reasoning behind the build

This document pulls the thinking behind Writ into one place. It is drawn from `docs/decisions.md` (the decision log),
`docs/brand.md`, `README.md`, `docs/design-critique.md`, `docs/hosting.md` and the MCP server's `COMPATIBILITY.md`.
Where a point is a decision you made, it says so. Where it is my reading of how the decisions fit together, it is
marked **(reading)**. Nothing here is new product direction.

---

## 1. The one-sentence version

**Writ is a workflow for producing content that a named expert stands behind. AI does the legwork; the company's
experts own the substance, the writing and the sign-off.**

Descriptor: *Expert content, AI-assisted.*
Sign-in line: *AI does the legwork. Your experts own the substance and the sign-off.*

Everything else in the tool is a consequence of taking that sentence literally.

---

## 2. The name, and why it is the product

A *writ* is a formal written document issued under someone's authority and seal. The name keeps the root of "write",
and the meaning is the product: a piece of content that a named person has reviewed and put their name to.

- Always "Writ". Never "Writ AI", "WRIT" or "writ.".
- AI is deliberately **not** in the name. It sits in the descriptor. The promise is expert-owned content; AI is how
  the legwork gets done, not the point.
- The logo is a written page with a seal breaking its lower-right corner: the document and the sign-off in one shape.
- Open item from the brand notes: a trademark search and a domain (a company named Writ exists in Cincinnati).

---

## 3. The problem: six pains, in the order they were worked through

Writ started from a list of six things that go wrong when teams use AI to produce content. Each became a design
principle.

| # | Pain | The principle it produced |
|---|---|---|
| 1 | Generic output that slides back into "AI speak" | Feed the AI only specific material from the company, and make the writer, not the model, the author |
| 2 | Unchecked or invented facts | Separate research from drafting, and make a human review every source |
| 3 | Chasing a score damages the writing | Replace scores with a *reader contract*: specific, testable expectations |
| 4 | Price versus value | Charge for the system, not for seats or credits; the customer brings their own AI key |
| 5 | Shallow research | Mix source types, analyse before outlining, turn gaps into questions for the expert |
| 6 | The climate is turning against AI content | Position as expert-owned, and keep an honest record of how each piece was made |

### 3.1 Pain 1: why AI writing sounds generic

The market's answers were studied first:

- **Dedicated apps (Jasper, Writer)** store a brand voice and knowledge base and inject them into every prompt. Strong
  for repeatable output, heavy to set up, and users report long pieces "revert to AI speak".
- **Chatbots (ChatGPT, Claude)** with Projects or custom GPTs: a voice guide, samples and banned phrases, AI drafts
  ~80%, a human edits. People choose them for about $20 a month and better prose.
- **Humanizers and banned-phrase lists** remove surface tells only. The text still reads as AI because it has no
  specifics.

Your diagnosis, which the log refines: chatbots feel "80% ready" because they seem to understand the user, through
memory and in-conversation corrections. The API is not the difference; every tool sends context to a model. The
difference is **which context is sent, and whether it grows from the user's behaviour.**

The combined root cause: **generic output = no specific material from the author + no accumulated understanding of
the writer.** Writ attacks both:

- *Specific material*: insight cards, proprietary data, a house file, approved research.
- *Understanding of the writer*: voice rules learned from edits, the pasted final version, and the writer's own words.

And a third move, which became the heart of the product: **let the human write the words.** If the human types the
text, it cannot be generic AI prose, and it is also the strongest possible voice signal to learn from.

### 3.2 Pain 2: invented and unsupported facts

Three failure modes, easiest to hardest to catch: invented statistics and quotes; real figures that are outdated or
out of context; and a real source that does not actually support the claim attached to it. Readers rarely open the
links. Competitor "fact-checks" mostly compare against whatever ranks on Google, which launders errors through
consensus.

Your decision: **"We are overthinking."** AI cannot yet reliably find the best sources, so Writ does not try to make
the AI verify itself. Instead:

- Research is **separate from drafting**.
- **A human reviews every data point before any drafting happens.** The review gate is mandatory.
- Each research item shows the **exact quoted passage** the search API cited (`cited_text`), never a quote the model
  wrote. Sources you add by URL or paste use the same citation mechanism.
- The item carries its source type, publication date (with a staleness flag), and, for secondary sources, a "trace to
  the original" note.
- Batches are kept small (about 8 to 15 per piece, 3 to 6 per section) so the gate does not get rubber-stamped, and
  there are one-key approve and reject shortcuts to keep the review fast.
- **No domain allowlist.** Restricting domains "significantly limits research". The process is strengthened instead.
- Your own insight cards are trusted as true; the writer reviews only whether each is relevant.
- The gate is enforced in SQL functions, not just the UI.

### 3.3 Pain 3: scores

SEO content scores (Surfer, Clearscope), readability scores and AI-detector scores all measure *resemblance to
something else*, not quality. They push toward keyword stuffing, sameness with the top ten results, and flattened
prose. Detectors are unreliable (and punish clear, structured writing).

My first proposal, a checklist of facts, originality, voice drift, coverage and format fit, was **rejected** by you
because it was still scoring, just decomposed. Counting facts is a target; "voice drift" is subjective; "coverage" is
keyword research by another name; "format fit" fixes length before research has found anything.

Your principle: **don't score; test whether the content answers the question the reader expects, and make that test
specific.** That became the **reader contract** (section 5 below). Keywords, competitors and coverage are kept, but as
*research input*, not as an optimisation target. AI detectors are linked out to with a note on their unreliability,
and no detector score appears in the app.

### 3.4 Pain 4: price versus value

Per-seat pricing charges for unused seats; credit pricing is opaque and has cliff-edge tier jumps; hybrids are
unpredictable. The real alternative to the tool is a freelancer ($250 to $400 for a mid-level B2B post, $600 to
$1,000+ for a specialist) or an agency, not another AI tool.

Decisions:

- **Tiers by number of companies**, matching the company model (one for a founder or in-house team, one per client for
  an agency). No per-seat charge inside a company, no credits or caps from Writ, plain billing where the shown price is
  the charged price and existing customers keep theirs. (Exact boundaries and prices are still open.)
- **Each company brings its own AI key.** Writ never pays for or marks up model usage; it charges for the system:
  workflow, memory, cards, review gates, the contract. The known cost is lost signups from asking for a key, judged
  smaller for B2B content teams who already use AI tools. It should be measured.
- **Several provider keys, one active at a time**, so a piece never mixes providers but a company can switch.
- **Model routing by task**: cheap models for extraction and classification, mid for search and contract work, strong
  for drafting and voice consolidation, with tested defaults and an advanced override.
- **Cost visibility without friction.** The original design showed an estimate before each run. That was dropped as
  friction: AI actions now run on one click, every run still records tokens and cost, and a **monthly budget with an
  optional hard limit** is enforced on the server when a run starts.

### 3.5 Pain 5: shallow research

Research feels shallow even when every source is real, because everyone searches the same open, English,
top-ranking pool; "deep research" means breadth, not analysis; articles are quotes stitched together; facts are
second-hand; and nothing is first-hand.

Depth mechanisms, all your decisions:

1. **A deliberate mix of source types** (original research, official docs and filings, practitioner sources, critical
   views, raw data). The mix is shown as information, never as a target.
2. **An analysis step before the outline**: tensions (where sources disagree), consensus versus company insight
   ("everyone says X; our 40 customer calls say Y", the strongest differentiator), and open gaps.
3. **Gaps become questions for the expert**, and the answers are saved as new insight cards, which feeds back into
   pain 1.
4. **The contract informs research but does not limit it.** Open exploration continues, and findings outside the
   contract can suggest revising it.
5. **Follow-up passes (tracing stats to the original, hunting counter-evidence) stay manual** because model APIs cannot
   do them reliably yet. The tool prompts the writer to do them and routes anything they find back through the review
   gate. Revisit when agentic browsing is available.

### 3.6 Pain 6: the climate

Readers expect disclosure (and trust "AI-assisted" far more than "fully AI-generated"); platforms are flagging "AI
slop" (the trigger is generic, empty output, not AI use itself); and the EU AI Act's Article 50 transparency rule has
applied since 2 August 2026, with an exemption where there is genuine human review, editorial control and a named
party holding editorial responsibility. The sources here are largely law-firm alerts, so this is direction, not legal
advice.

Pains 1 to 5 already make the tool produce what this climate rewards. What was missing was **showing the work**, and
keeping the writing in human hands. That is what pain 6 added: positioning, the section brief, manual-by-default
writing, and the editorial record.

---

## 4. Positioning

**"Expert-owned, AI-assisted."**

- *Expert-owned*: the substance comes from the company's own people (insights, data, voice), the writer writes the
  words, a named person signs off.
- *AI-assisted*: AI finds, summarises, checks, suggests and structures. It does not decide, and by default does not
  write.

This is both the marketing line and a rule for product wording. It also sets Writ apart:

| Alternative | What it optimises | Where Writ differs |
|---|---|---|
| Jasper / Writer / Copy.ai | Repeatable AI output at scale | Writ assumes the human writes; AI is upstream and downstream of the writing, not in it |
| Chatbots with a Project | Cheap, flexible drafting | No workflow, no review gates, no record, memory that stores facts rather than style |
| SEO scoring tools (Surfer, Clearscope) | Resemblance to what already ranks | Writ treats search as research input and tests against the reader's question |
| Humanizers / detectors | Surface tells | Writ addresses the cause (no specifics, no human authorship), not the symptom |
| A freelancer or agency | Human craft, at human cost | Writ keeps the expert's knowledge central and makes the process cheaper and auditable |

**Who it is for (reading):** B2B content teams, founders, and agencies who already use AI tools and have real
expertise and material (call transcripts, data, strategy docs) that generic tools never see. The "agency with one
client" model covers everyone from a solo founder to an agency.

---

## 5. The reader contract: Writ's central idea

A **reader contract** is a short list of specific, testable expectations for one piece, agreed before the outline. It
replaces the score.

Worked example (yours): "Emerging supply chain technologies."

- Core question: what are the emerging supply chain technologies?
- Expectations: they are listed up front; each gets a real deep dive (what it is, its role, who uses it, its limits);
  maturity claims match reality and are backed by approved research; the reader can act on it given the ICP.

Principles:

- **Every expectation must be concrete enough to fail.** "Covers the topic well" is not allowed. "Every technology has
  a named adopter" is.
- **Intent decides shape.** "What are X" calls for a list plus deep dives; "how to" for steps; "should I" for a
  decision framework.
- **Length is never planned in advance.** It falls out of the expectations and the research.
- **The writer writes the contract; the AI suggests.** They iterate in a conversation thread, which is kept so you can
  trace why an expectation was added or dropped. The writer confirms.
- **It is checked three times**: after the outline (structural gaps), after each section (only the expectations that
  section owes), and after the full draft. Results are **met / partly met / missing**, with a quote as evidence or a
  pointer to the gap. No number, no grade.
- Each outline section is linked to the expectations it owes, and expectations no section covers are flagged.

Why it works **(reading)**: it moves quality control from "does this resemble good content" to "did we do what we
promised this reader", which is something an expert can judge and a model can check with evidence.

---

## 6. How the flow works, and why each stage exists

1. **Brief**: working title, primary keyword (brought from the writer's own keyword tool; Writ does not do keyword
   research or volumes), format, topic, goal, and whether section research runs one at a time or all up front.
2. **Reader contract** (above).
3. **Piece research**: web search through the company's own key, guided by the contract, then a mandatory review gate.
4. **Analysis**: tensions, insight versus consensus, open gaps with expert questions.
5. **Outline**: owned by the writer, AI suggests in a thread. Optionally "Improve structure" plans each section as an
   ordered list of blocks (short answer, bullets, steps, table, example, takeaway and so on), added because pieces
   with little human input came out as heading, short paragraph, heading, short paragraph.
6. **Each section**: research, review, **section brief**, then writing.
7. **Checks while writing**: grammar, facts against approved research, section contract. All advisory.
8. **Final contract check, sign-off**, provenance summary, optional disclosure line, audit export.
9. **Learn from the piece**: voice rules suggested from edits, the pasted final version and the writer's messages.

### 6.1 Separate context blocks, wired per stage (decision #5)

You rejected an inheritance tree (workspace, profile, project). **Each context is a separate block, and Writ wires
exactly what each stage needs.** The reasoning: voice samples and learned memory are useless, and even harmful, during
pure research. The goal is to never send unwanted context.

| Stage | Gets | Never gets |
|---|---|---|
| Research | Brief, contract, ICP, strategy | Voice, memory, samples |
| Outline | Brief, angle, approved research, relevant insights | Samples |
| Drafting | Outline, approved research, core voice, the matching format profile, voice memory, relevant insights | Other formats' profiles |
| Audit | Draft, voice, research, cards | Samples |

The wiring is built in; users do not configure it. It also keeps requests small, which helps cost (pain 4).

### 6.2 The section brief and writing by hand (decision, pain 6)

Between each section's review gate and the writing sits a **section brief**: crisp bullet fragments, each fact linked
to its approved item. Your constraint: **fragments and keywords only; no full sentences, transitions, adjectives or
quotable phrasing**, because elaborate sentences would shape the writer's style and the draft could end up reading as
AI. Example:

- `what: virtual replica of network → [item 4]`
- `adopter: Unilever, 2023 → [item 7]`
- `our view: calls say SMEs stall at data prep → [card 12]`

Then **the writer writes the section by hand**. "Draft with AI" exists but is tucked away, and a section drafted that
way is recorded as AI-drafted (`ai_then_writer`).

Why: human-typed text is the best voice signal, it keeps the writing human, and it makes the provenance claim
honest.

### 6.3 "The AI never rewrites the writer's sentences"

While writing, AI only helps in bounded ways: a grammar check limited to what a Grammarly-style plugin would catch,
a fact check against approved items, a contract check, and answers in a section thread ("what exactly did item 7
say?"). Rewrite protection is on by default.

Related: **"Write like a leader"** is deliberately not an in-app restyle. The writer picks a leader voice (name, role,
how they write), copies a prompt plus their text into their own AI tool, and pastes the result back, where it goes
through the same checks. The writer owns the words.

### 6.4 Checks are advisory and honest about staleness

- A check never blocks the writer.
- A tick means "checked on this exact text": each section has a `content_rev` raised by a database trigger on every
  change, and checks store the revision they ran on. After an edit, the UI says "Edited since the last check".
- Writing is complete when every section is marked written; approval is sign-off's job, not writing's.

---

## 7. House file and onboarding: use the systems teams already have

Your principle: **assume every team already has some system for creating content. Classify those systems and make it
easy to share them with Writ. Do not invent a new capture process.**

- Every section ships with a **prompt to run in the team's own AI tool**, a **paste or upload box**, and a **format
  check**. A separate "prompt kit" feature was dropped as redundant.
- **Required**: ICP and positioning (most teams have at least these). Other strategy notes are optional and short.
- **Core voice** is a general document, built by AI from pasted and uploaded material. When new material arrives it
  is **merged as a proposal shown as a redline** that the writer accepts, edits or rejects. It is never silently
  regenerated, and a proposal made before a hand edit cannot overwrite that edit.
- **One style profile per format**, built from perfect examples the user supplies. Writing only ever sees the profile
  for the format at hand.
- **Offer only the input methods each section needs** (paste, upload, URL). URL fetching goes through a server-side
  proxy, falls back to paste, and is paste-only for domains known to block scraping (LinkedIn, X).
- Connectors (Notion, Drive, Slack, call recorders) wait until the basic version works.

### Insight cards and proprietary data

- **The insight test:** a statement only this company could make. *Could a competitor write this sentence?*
- A card has a type (story, opinion, data point, technical detail, customer quote, lesson), a one-sentence claim,
  2 to 5 sentences of detail, a source, a citation level, and tags.
- **Citation levels: public or internal.** Public cards can be quoted and attributed; internal cards shape the argument
  but are never named.
- The scale problem you raised: teams record sales calls and demos but reduce them to short summaries that lose the
  detail. Writ asks the team to keep a **separate column**, generated by a per-call prompt with fixed fields, so a
  spreadsheet import turns 1,000 calls into 1,000 cards. Each stage retrieves only the top-N relevant ones, and
  near-duplicates are grouped so **repetition becomes evidence** ("40 of our customer calls mention X").
- Extraction works both ways: an external prompt in the team's own tool, or paste a transcript into the app and review
  the cards before anything is saved.
- Proprietary data uses the same card format with value, unit, period, sample size and source. Most companies have
  little of it, so copy-paste comes first.

---

## 8. Learning from the writer, without a hidden profile

Four signals are captured: draft-versus-final edits; choices and rejections; the writer's feedback in their own words
(kept across pieces, not discarded); and past writing samples.

- The final text is captured two ways: edit in the app (short pieces) or paste the finished version back when it was
  finished elsewhere.
- **Learning is explicit.** Nothing learns in the background; the writer runs "Learn from this piece" and **chooses
  which suggested rules to keep.**
- **Voice memory is an editable list** the writer can see, correct and delete, the way Claude's own memory can be
  inspected.
- Only drafting reads voice memory. Research and outline never do.
- Memory across pieces means **what the company has already published**, not a profile of the person. Before sign-off
  a check flags contradictions (a different figure for the same statistic), repeated angles, and earlier pieces worth
  linking, each quoting the new sentence and the earlier passage.
- **Ask Writ** answers only from the company's own material, with numbered sources, and says plainly when something is
  not covered. It is **not a writing chat**: drafting stays inside a piece, behind the review gates, so the
  generic-output problem cannot return through a side door. It shows its cost once instead of before each question,
  an exception to the cost rule, with the budget still applying.
- Search is Postgres full-text to start; meaning-based search (pgvector) only if keyword matching proves too literal.

---

## 9. Workspace model: an agency with one client

The persona does not change the workflow, only how many of something is needed. So the default shape is **a single
company**, which works for everyone, and **adding a client means adding a whole new company**: a separate, isolated
system with its own blocks and memory. Nothing learned for client A reaches client B. A person can belong to several
companies. Row-level security on every table enforces this. Teams (invites, member and editor roles) were included
from the first slice because a named editor has to be able to sign off.

---

## 10. Workflows per format: recipes

A LinkedIn post should not go through a blog's full workflow. Each format carries a **recipe** where every step, and
the parts inside it, can be switched on or off.

| Template | Contract | Research | Outline | Checks | Sign-off |
|---|---|---|---|---|---|
| Long-form blog | Full | Web plus search landscape | Free, analysis | Grammar, fact, contract, SEO, GEO | Named |
| Thought leadership blog | Full | Same | Free, analysis | Same minus SEO | Named |
| Case study | Full | Internal sources | Fixed | All plus customer approval | Editor |
| LinkedIn thought leadership | Lite | Light web | Off | Grammar, fact, contract | Named |
| Promotional social | Off | Own sources | Off | Grammar, fact | Named |
| Short-form social | Off | Insight cards | Off | Grammar, fact | Named |

Plus Instagram caption and carousel, LinkedIn carousel, X thread, video scripts, newsletter, and webinar or talk
outline (fixed outlines where each slide or segment is a section).

Guardrails:

- **Dependencies are enforced** (analysis needs research, SEO checks need a primary keyword) and the editor says why a
  setting cannot be saved.
- **Editors only** change recipes.
- **A piece snapshots its recipe**, so the audit trail shows the exact process it followed.
- **Research is always available** in every format.
- **Loosening is allowed but honest.** Editors can turn off research review and named sign-off. When they do, the
  provenance summary says so plainly ("research wasn't individually reviewed", "no named sign-off"). The company's
  editorial-record setting overrides this and requires an editor.

---

## 11. History, revision and repurposing

- Every piece has a readable ID (`NL-0042`) and a version number. History lists versions, lineage, and what was made
  from what; any two versions can be compared as a redline.
- A **fixed review schedule** flags a piece for review a set time after sign-off. A due piece is confirmed "still
  accurate" or revised.
- **Revise**: the old version is tagged Revised and linked to the new one. The writer picks the original or current
  recipe and which approved research carries over.
- **Repurpose** is a planning step in front of the target format's normal workflow, in three shapes: **Split** (one to
  many), **Adapt** (one to one, new medium, flagging what does not translate), **Combine** (many to one, flagging
  gaps). Carried research stays approved; new research is reviewed as usual.
- **Source updated**: a piece made from a source that was later revised carries a banner, so derived posts do not
  silently drift from a corrected original.

---

## 12. Transparency: the editorial record

Optional per company (switch it on for EU audiences or regulated topics). Every decision (contract confirmed, item
approved or rejected, section written by a person or drafted by AI, edits applied, outline reopened, sign-off) is
written to `piece_events`. Three outputs, all generated from real records, never from a template:

- **Provenance summary**: e.g. "Drafted from 6 internal insights and 14 reviewed sources; 5 of 6 sections written by
  Jane Doe; approved by Jane Doe, Head of Content."
- **Disclosure line**: an optional, editable "AI-assisted, human-reviewed" statement. Never forced.
- **Audit export**: the full trail (sources, approvals, threads) as a file for compliance teams or clients.

Writ's own standard is the one it asks of content: **no claim the tool cannot back up.** That is why the brand voice
is plain and specific, with no hype or exclamation marks.

---

## 13. Control, trust and reversibility

A recurring thread: **the human is always able to see, undo and stop.**

- **Every confirmed step can be reopened** (scope, research, outline, each section). Nothing is deleted; reopening is
  allowed while the following step is still open, and each reopening is recorded. After sign-off you revise instead.
- Saving an outline matches sections by id, so reopening does not destroy text, briefs or research of sections that
  stay.
- **AI proposals land in editable drafts**, never directly (the outline "Fix with AI", structure planning, merged
  house-file documents). Accepted AI wording is recorded (`seo_fix_applied`).
- **Signed-off text is final**: the database itself refuses text and heading edits on a signed-off piece. Before
  sign-off, text can still be edited on the sign-off page, but a new final check is required afterwards.
- **Edit locks** stop two people (or a person and Claude) overwriting each other. One actor works on a step at a time,
  the lock frees itself after inactivity, and "Take over" is available. A second guard, step versions, refuses an AI
  write based on something it read before the step changed.
- **Pasted text is tidied** (blank-line runs collapsed, invisible characters stripped) so paste behaves predictably.
- **Provider keys** are checked with the provider, encrypted on the server, and never sent back to the browser.
  Because Writ holds customers' keys, encryption at rest and a narrow access policy are a stated responsibility.
- **Reliability over cleverness.** A streaming, model-driven chat was tried and reverted to the simple request/response
  conversation after it only worked with one provider and returned an empty reply once. The decision was reliability
  over live streaming; the earlier design stays in git history.

---

## 14. Writ in Claude (the MCP server)

A second front door: Writ's method inside Claude. Claude reads a section's brief, approved research and voice from
Writ, works on the **writer's own Claude subscription**, and saves results back to Writ for review, through the
same backend and the writer's own login, so Writ's access rules still apply.

Principles **(reading, from the design and COMPATIBILITY notes)**:

- **Same rules, different surface.** Claude saves checks and analyses in the app's own fields and shapes, so Writ
  shows them; it cannot approve for the writer. Writes that need approval take a `writer_approved` flag that must
  never default to true.
- **Claude never overwrites the writer.** A saved draft is stored as an AI draft and never replaces the writer's
  text. Research Claude finds is saved as *unreviewed*, with quotes flagged as not checked, and the writer approves
  each item.
- **Locks and versions apply to Claude too**, so a person and Claude can work on one piece without overwriting each
  other.
- **Compatibility is a promise.** People have the server in their config and habits built on tool names, so tools and
  parameters are never removed or renamed, required parameters are never added, and a contract test enforces it.
- **A screen shows data, never side-effect flags.** Screens show or hide things only as a function of the data
  underneath, so a piece built by Claude (without the app's side-effect flags) still renders correctly.
- A health check (`writ_check_piece`) tells the writer what they will see on each step and what looks stuck.
- Sign-off, review, publishing and the alignment checks stay in the web app: the final authority stays with the human
  in the product built for it.

---

## 15. Architecture decisions and their reasons

- **Written from scratch.** The workflow was designed fresh, not adapted from an earlier tool.
- **A backend is required**, because the browser alone cannot handle: fetching other sites (CORS), isolated companies
  and teams, thousands of cards with retrieval, large uploads, safe multi-provider key storage, long jobs that survive
  a closed tab, a trustworthy audit record, billing by company, and accurate cost tracking.
- **Supabase** (chosen first for free testing): relational data (companies, pieces, items, approvals, cards,
  threads), row-level security for company isolation, pgvector if needed later, and moving to a paid plan is a
  settings change. Firebase's free tier could not run the core.
- **All model and search calls run server-side** in edge functions using the company's active key: background work,
  accurate cost per task and company, and a single place for model routing. Long jobs run as small batches with saved
  progress because of execution limits.
- **Hosting:** the web app and a hosted MCP server run on a free Oracle VM behind a shared Caddy, with Supabase kept
  where it is. Deploys are manual, build into a new folder, run the tests and switch over only on a pass, keeping the
  last three releases for rollback. Writers add the hosted `/mcp` as a custom connector in claude.ai and sign in
  through Supabase's OAuth server.
- **Migration discipline:** never edit an applied migration; add a new later one. (Project rule in `CLAUDE.md`.)

---

## 16. Design and brand language

- **Feel:** an editor's desk, not a SaaS dashboard. Calm paper-and-ink palette, serif for the writing itself
  (Source Serif 4), sans for the interface (Geist), mono only for IDs, versions and citation numbers.
- **Colour has jobs:** green = done or approved, amber = act on this, pencil blue = a link or something to decide,
  neutral grey = advice.
- **Voice:** plain, direct, specific, like a good editor. Say what happened and what to do next.
- **Design priorities from the critique:** density and signal (the next action should stand out), flags placed beside
  the text they question, one consistent pattern per element, and accessibility (contrast, 44px touch targets, visible
  focus, text alternatives for status dots). The best-designed element is the fact-mismatch flag: amber, quoted text,
  the specific reason.
- **Recent Writing-page direction:** a compact checks card, a pinned "Send to sign-off" bar, an icon toolbar, Clear
  text moved into a menu, and a progress line, all serving the same idea of keeping the primary action obvious and
  the writer's text central.

---

## 17. What Writ deliberately does not do

- It does not score content, and shows no detector score.
- It does not pick keywords or show search volume.
- It does not let AI verify its own facts, nor restrict research to an allowlist; the human gate is the control.
- It does not rewrite the writer's sentences by default, or restyle text itself ("Write like a leader" happens in the
  writer's own tool).
- It does not make a chat the place where content is written; Ask Writ only answers from the company's material.
- It does not charge per seat, per credit, or mark up AI usage.
- It does not run hidden learning or keep a hidden profile.
- It does not ship an unconditional sign-off: the editorial record is optional, but if it is switched off, the
  provenance summary says so.
- Declined for now: the expert-question loop as a workflow, review requests and comments, and notifications. Deferred:
  connectors, a company-wide data-point library, import and export between companies.

---

## 18. Open questions recorded in the log

- Tier boundaries and prices, benchmarked against freelancer cost per piece.
- Default model per task per provider, and how those defaults are tested.
- Whether brief bullets leak style (compare output with and without the brief).
- Whether Article 50 applicability should be assisted by the tool or left to the company.
- Disclosure wording and localisation.
- Source-type classification reliability and how the writer corrects it.
- How expert questions reach the expert, and how answers become cards.
- Whether meaning-based search is needed.
- Which SerpApi tasks are worth the cost.
- Free-tier limits and background-job design.
- Trademark and domain.
- Known implementation limits: the OpenAI, Gemini and local adapters have not been run against real APIs, model prices
  exist only for some models, and invites produce a link rather than an email.
