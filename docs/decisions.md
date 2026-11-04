# Writ: Decision log

## 1. Purpose and status
- This is Writ's living decision log. It records what was decided, why, and what is still open. It is not a build spec.

## 2. The six pain points we are solving
| # | Pain point | Status |
|---|---|---|
| 1 | Generic output that slides back into "AI speak" | **Decided (§3–§9)** |
| 2 | Unchecked or invented facts | **Decided (§12)** |
| 3 | Chasing the score damages the writing | **Decided (§13)** |
| 4 | Price versus value | **Decided (§14)** |
| 5 | Shallow research | **Decided (§15)** |
| 6 | The wider climate is turning against AI content | **Decided (§16)** |

## 3. Pain point #1: how the market handles it today
- **Dedicated apps (Jasper, Writer):**
  - Brand Voice, Knowledge Base and Style Guides are stored once and injected into every prompt.
  - They are strong for repeatable team output, and weak because setup is heavy.
  - Users report the output "reverts back to AI speak" in long pieces.
  - The lower plan tiers cap these features.
- **Chatbots (ChatGPT, Claude):**
  - Users build Projects or Custom GPTs that hold a voice guide, 10–20 samples and banned phrases. The AI drafts about 80%, then a human edits.
  - **Why people choose them:** about $20/month, better prose, one tool for everything.
- **Humanizers and banned-phrase lists:** these remove surface tells only. Even their makers say the text still reads as AI without specifics.

## 4. Diagnosis (the user's view, refined together)
- **The user's insight:** chatbots feel 80% ready because of behavioural understanding of the user. Memory across chats, plus corrections inside the conversation ("too formal", "cut that intro"), shapes style, tone and intent.
- **Refinement:**
  - The API isn't the difference. Every tool sends context to a model through an API.
  - The difference is *which* context is sent, and whether it **grows from the user's behaviour**.
  - Chatbot memory is also shallow: it stores facts, not style. It also leaks across topics.
- **Combined root cause:** generic output = (1) no specific material from the author, plus (2) no accumulated understanding of the writer.
- **Our advantage:** a dedicated tool sees signals chatbots never get, such as the final published text and which options the user rejected.

## 5. Decision: separate context blocks, wired to each stage explicitly
- **User decision:** no inheritance tree (workspace → profile → project). "Each context should be separate, and we manually connect what is needed in each stage as required."
  - The user's example: projects, pieces and learned memory are not useful during pure research.
  - The goal is to never send unwanted context.
- **Blocks:**
  - Strategy (ICP, positioning)
  - Core voice
  - Format style profile (one per format)
  - Learned voice memory
  - Feedback log
  - Edit patterns
  - Choice history
  - Insights
  - Proprietary data
  - Brief, angle and outline
  - Research
- **Example wiring:**

  | Stage | Gets | Never gets |
  |---|---|---|
  | Research | Brief, angle, strategy | Voice, memory, samples |
  | Outline | Brief, angle, research, relevant insights, choice history | Samples |
  | Drafting | Outline, research, core voice + *matching* format profile, voice memory, edit patterns, relevant insights/data | Choice history, other formats' profiles |
  | Audit | Draft, core voice, format profile, research, insight/data cards (to check claims) | Samples |

- **Update from #2:** research now runs at two levels, the piece and each section (see §12.4). Outline and drafting receive only research items the writer has *approved*.

- **Who sets the wiring:** the wiring is built into the product so it works for most users without any setup. Users don't have to configure defaults or overrides.

## 6. Decision: workspace model, from a solo founder to an agency
- **User decision:** the persona doesn't change the workflow. It only changes how many of something a user needs. A content marketer has a few voices; an agency needs a few per client.
- **The default shape is "an agency with one client":** a single company, which works for every type of user.
- **Adding a client means adding a whole new company,** a separate, isolated system with its own blocks and memory. Nothing learned for client A reaches client B.
- **Later:** import and export between company profiles.

## 7. Decision: learn from the writer's behaviour
- **All four signals are captured:**
  1. **Draft vs. final edits.** The diff between the AI draft and the final text feeds the edit patterns block.
  2. **Choices and rejections.** Which angles, outlines and sections the user picked or discarded.
  3. **Feedback in the user's own words.** Editorial feedback notes are kept across pieces, instead of being thrown away after each piece.
  4. **Past writing samples.** See §8.
- **Capturing the final text uses both routes (user decision):**
  - **Edit in the app:** for short pieces.
  - **Paste the final version back:** when the user copies the piece to another word processor, we ask them to paste the finished version back to close the piece.
- **Learned memory is an editable list** the user can see, correct and delete, "just like the Claude tools have it".

## 8. Decision: onboarding through the systems teams already have
- **User principle:** assume every team already has some system for creating content. Classify what those systems are, then make it easy to share them with the tool. Don't invent a new capture process.
- **Every section ships with:**
  - a prompt the user pastes into their own AI tool, which returns the material in our format
  - a paste or upload box
  - a format check

  A separate "prompt kit" feature isn't needed, because each section already covers it.

### 8.1 Strategy and briefs
- Most teams have at least an **ICP and positioning**, so those are required.
- Other supporting documents are optional, and are likely to be very short.

### 8.2 Brand and voice rules, plus core voice
- Almost every team has these in some form, for example an organisation-wide skill or a Project used to treat text.
- The **core voice** is a general document with general guidelines on voice and philosophy, and it lives here.
- **Input:** paste, and **upload any files they have**.
- **AI combines** everything into one consolidated doc that the user can edit.
- When new material is added later, it is merged in, with a diff for approval. It is never silently regenerated.

### 8.3 Published archive and format style profiles
- **The problem the user raised:** writing style differs by format. A short post, a long-form blog, thought leadership and promotional social all read differently.
- **Solution:** core voice (§8.2) + **one style profile per format**, built from **perfect examples the user uploads**. Drafting receives only the profile for the format being written.
- **Templates to start from:**
  - Thought Leadership Blog
  - Thought Leadership LinkedIn Post
  - Long-form blog
  - Promotional social
  - Short-form social
  - Case study

  Users can also add a **custom format** they define themselves.
- **Input:** paste, upload, and URL.
- **URL handling:**
  - A server-side proxy fetches from domains that allow scraping.
  - If a fetch fails, the user is asked to paste the content and save.
  - **Paste only** for domains that obviously block scraping (e.g. LinkedIn, X).

### 8.4 Raw expert insight
- **Insight test:** a statement only this company could make. Could a competitor write this sentence?
- **Insight card schema:**
  - type: story, opinion, data point, technical detail, customer quote, or lesson
  - a one-sentence claim
  - 2–5 sentences of detail
  - source: who said it, where, and when
  - **citation level**
  - tags
- **Citation levels (user decision): public / internal only.**
  - Public cards can be quoted and attributed.
  - Internal cards shape the argument but are never named.
- **The workflow problem the user raised:**
  - Teams record demos and sales calls, but turn the transcripts into short summaries that lose the details we need.
  - **Required workflow change:** the team keeps a **separate column**. Our prompt analyses each transcript and produces that column.
  - 1,000 calls give 1,000 insight entries, which the user considers good information.
- **What this scale implies for the build:**
  - The per-call prompt must output fixed fields, so a CSV or spreadsheet column can be imported in bulk.
  - Each stage retrieves only the **top-N relevant cards**. Tags come first; relevance search may come later.
  - Near-duplicate cards are grouped, so **repetition becomes evidence** ("40 of our customer calls mention X"). This feeds pain points #2 and #5.
- **Extraction (user decision): both routes.**
  - The external prompt, run in the team's own AI tool.
  - In-app: paste a transcript and get cards back.

### 8.5 Proprietary data
- Most companies have little proprietary data; only a few do.
- **Copy-paste first**, with a supporting prompt.
- Uses the same card format (type = data point), plus these fields:
  - value
  - unit
  - period
  - sample size
  - source

### 8.6 Dropped
- **Saved research:** not needed.
- **Separate prompt kits:** covered by each section's prompt.

## 9. Ingestion summary
| Section | Paste | Upload | URL |
|---|---|---|---|
| Strategy (ICP, positioning) | ✓ | ✓ | – |
| Brand rules / core voice | ✓ | ✓ | – |
| Format examples | ✓ | ✓ | ✓ (proxy; paste fallback; paste only for blocked domains) |
| Insights | ✓ (prompt output, transcript) | ✓ (CSV/column) | – |
| Proprietary data | ✓ (primary) | – | – |

- **Principle:** offer only the input methods each section actually needs.
- **Connectors** (Notion, Drive, Slack, call recorders) wait until the basic version works.

## 10. Open questions
- ~~**Backend vs. browser**~~: **decided in §17**: Supabase, with server-side LLM calls.
- The exact wording of each section's extraction prompt, including the per-call insight prompt.
- How retrieval ranks cards: tags vs. relevance search, and the top-N size.
- How AI consolidation shows changes and resolves conflicts.
- The starting list of paste-only domains.
- How profiles are imported and exported between companies.
- **From #2:** see §12.9 (provider search behaviour, gate batch sizes, passage deep links, snapshot storage, post-draft number check).
- **From #3:** see §13.8 (where the chat-based pattern applies, contract quality bar, SerpApi tasks).
- **From #4:** see §14.6 (tier boundaries and prices, default model per task, cost estimation accuracy).
- **From #5:** see §15.6 (source-type classification, analysis-step output format, expert-question routing).
- **From #6:** see §16.7 (brief bullet format, grammar-check scope, record storage, disclosure wording, Article 50 applicability).
- **From architecture:** see §17.6 (batch job design, key-encryption policy, roles beyond member/editor, free-tier limits).

## 11. (Retired)
This section pointed into an earlier prototype's code, which isn't part of Writ.

## 12. Pain point #2: unchecked or invented facts

### 12.1 How the market handles it today
- **Writesonic:** advertises a "citations verified" step, but doesn't say what it checks.
- **Jasper:** doesn't fact-check drafts. Citations appear only in Research Agent reports.
- **Frase:** shows no citations.
- **Perplexity:** used as a separate research layer; teams draft elsewhere.
- **Ahrefs' warning:** tools "fact-check" by comparing against whatever ranks on Google, which launders errors through consensus.
- **Careful teams:**
  - Extract every claim, then check it against the primary source.
  - Run the fact audit *before* line editing, and keep fact review separate from language editing.
  - Scale the review to the risk.
  - Keep a living list of trusted sources.
  - Editing costs an estimated 30–50% of writing time.

### 12.2 Failure modes, from easiest to hardest to catch
1. Invented statistics, quotes and named sources.
2. Real figures that are outdated or taken out of context.
3. A real source that doesn't support the claim attached to it. A Stanford-led study (Nature Communications, 2025) found 50–90% of responses weren't fully supported by their cited sources. Readers rarely open the links.

Tools that invent their search research and never audit claims sit at the worst end of all three.

### 12.3 Diagnosis and principle (user decision)
- "We are overthinking." AI can't yet reliably find the best sources, so **we don't try to make the AI verify itself.**
- **The user manually verifies every data point before drafting.**
- **Research is separated from drafting.**
- The part that matters most is **a good workflow for reviewing sources**.

### 12.4 Research at two levels
- Research happens at every step, but the scope changes:
  - the **outline** needs research on the piece as a whole;
  - **drafting a sub-section** needs research specific to that sub-topic.
- **Flow:**
  - Intake → Angle
  - → ① **Piece research** → ✋ review gate
  - → Outline, built only from approved items
  - → for each section: ② **Section research** (reuses approved piece items, plus targeted new search) → ✋ review gate → draft that section, using only that section's approved items.
- **Section timing (user decision): the writer chooses for each piece.**
  - **Just-in-time:** research → review → draft, one section at a time.
  - **Up front:** research all sections, review in one sitting, then draft them all.
- **Update from #6:** a **section brief** step now sits between each section's review gate and the draft, and drafting is manual by default (see §16.4).

### 12.5 The research item and the review gate
- **Each item has:**
  - the statement or data point (one sentence);
  - the **exact quoted passage**, shown beside it, with a link that jumps to the passage;
  - the source type: our card / primary / credible web page;
  - the publication date, with a staleness flag;
  - for secondary sources, a "trace to the original" note;
  - a status: unreviewed / approved / edited / rejected.
- **The review is mandatory:** you can't continue until every item in scope is approved or rejected.
  - Batches are kept small (about 8–15 per piece, 3–6 per section), so the gate doesn't get rubber-stamped.
  - One-key approve/reject, and the statement can be edited inline.
- **Allowed sources (user decision):** our cards, primary sources, and credible web pages.
  - **No allowlist.** Restricting domains "significantly limits research". Instead, the process inside the tool is strengthened and review is mandatory. Source type and age are made obvious instead.
- **Own cards (user decision):** trusted as true; the writer reviews only whether each card is relevant to the piece or section.

### 12.6 Search provider (user decision)
- **Default:** the search built into the company's own LLM key. No extra account or setup, and the cost lands on each company's own bill.
  - Claude's web search tool costs $10 per 1,000 searches plus tokens, and returns the cited passage, which a research item needs.
  - Gemini grounding is an alternative; its pricing is still to be confirmed.
- **Optional fallback:** the company's own search key (Tavily, Brave, SerpApi).
- **Why not a shared SerpApi account:** about 20–30 searches per piece means the free 250 searches a month cover roughly 10 pieces. A shared paid account makes us carry every customer's cost and rate limits, which is a pricing (#4) decision.

### 12.7 Manual sources (user decision)
- Users can add sources **by URL** (the #1 proxy, with a paste fallback) **or by paste**, at both the piece and section level.
- The source itself is trusted. The AI extracts items with quoted passages, and **those items go through the normal review gate**, because extraction can misread or misquote.

### 12.8 Source library (user decision)
- **The first proposal**, a company-wide library of approved data points, was judged overkill. Open problems: how the AI would look items up quickly, and how to handle many data points per page.
- **Adopted instead:** a manual **"Add to library" button on sources**, where the user picks highly interesting pieces.
- **Stored once per source:**
  - URL
  - title
  - publication date
  - saved text snapshot (survives page changes)
  - tags
  - date added
  - last checked
- **Use:** at research time, library sources with matching tags appear as suggestions. Items are **re-extracted from the snapshot for the current scope**, then reviewed. A page with 12 data points contributes only what each new piece needs.
- Tag matching only; no relevance search.

### 12.9 Open questions for #2
- Gemini grounding pricing, and the behaviour of each provider's search across Claude, Gemini and OpenAI.
- Exact batch-size limits per gate, and what happens when research returns too few approved items.
- How text-fragment deep links to the quoted passage behave across sites.
- Storage for library snapshots, which feeds the backend decision.
- Whether a post-draft check should flag numbers that don't come from approved items.

## 13. Pain point #3: chasing the score damages the writing

### 13.1 How the scores work today
- **SEO content scores (Surfer 0–100, Clearscope letter grades).**
  - Surfer crawls the pages that currently rank and extracts the terms related to the keyword. It then blends four things: how well you cover those terms (the heaviest weight), your length compared with the top results, your heading and paragraph structure, and your images.
  - The score measures how closely a piece resembles what already ranks, not how good it is.
  - The tools disagree with each other. One article scored 92 in Surfer and B+ in Clearscope, and another scored 67 and A.
  - We found no independent study showing that either score predicts rankings.
- **Readability scores (Hemingway grade level, Grammarly).** These push every sentence toward plainness, whatever the format.
- **AI-detector scores.**
  - They are unreliable. Turnitin admits a 1% false-positive rate, and Vanderbilt dropped its detector.
  - They flag clear, well-structured writing as "predictable".
  - Writers chasing "0% AI" report that clarity suffers and forced edits break the meaning.

### 13.2 What goes wrong when writers chase a score
- **Keyword stuffing.** One Surfer user admits to "sentences that made no sense just to reach a 100".
- **Sameness by design.** A score built from the top 10 results rewards repeating them. That works directly against pain point #1.
- **Diminishing returns.** Reviewers say pushing B2B content past roughly 80–85 makes it worse.
- **Fake scores exist.** One tool we looked at starts every piece at 96, subtracts points for banned words and long sentences, and clamps the result to 70–99.
- **The wider shift.** AI search engines increasingly cite pages outside Google's top 10; one reported figure is 38% of AI Overview citations. The strongest reported signal is data or insight the engine can't find elsewhere. These are vendor studies, but the direction supports #1 and #2.

### 13.3 The first proposal, and why it was rejected (user feedback)
- **The proposal:** replace the score with a checklist of facts, originality, voice drift, coverage and format fit.
- **Why the user rejected it:** it was still scoring, just broken into its underlying parts.
  - Counting facts and original facts is a target.
  - "Drift from core voice" is subjective, and there is no sound way to calculate it.
  - "Coverage" is keyword research by another name.
  - "Format fit" fixes the word count in advance, instead of letting the length come from what research actually finds.
- **The user's principle:** avoid scoring in the conventional sense. Instead, test whether the content actually answers the question the reader expects it to answer, and make that test specific.

### 13.4 Decision: the reader contract
- **What it is:** a short list of specific, testable expectations for one piece, agreed before the outline.
- **Worked example (the user's): "Emerging supply chain technologies".**
  - **Core question:** what are the emerging supply chain technologies?
  - **Expectations:**
    1. The technologies are listed up front.
    2. Each technology gets a real deep dive: what it is, its role in the supply chain, who uses it, and its limits.
    3. The maturity claims match reality, and are backed by approved research items (§12).
    4. The reader can act on it: which technologies matter, given the ICP.
- **The quality bar:** every expectation must be concrete enough to fail. "Covers the topic well" is not allowed. "Every technology has a named adopter" is.
- **Intent decides the shape of the piece.** "What are X" calls for a list plus deep dives. "How to" calls for steps. "Should I" calls for a decision framework.
- **Length is not planned in advance.** It comes out of the expectations and the research.

### 13.5 Decision: how the contract is written (user decision)
- **The writer writes and the AI suggests.**
  - The AI's first suggestion is drafted from the intent, what ranking pages cover and skip, and the ICP.
  - The writer spots what's missing and asks the AI to revise. They iterate a few times, then the writer **confirms**.
- **It works like a chat conversation.** Each round is a message in a thread attached to the contract. That makes it easier for users to follow, and they can trace back why an expectation was added or dropped.
- **Possible broader use:** the same pattern (AI proposes, writer critiques in a thread, writer confirms) could apply to other gates (research items, outline, sections). That will be **decided stage by stage later**.
  - The writer's messages would also feed the feedback log (§7).

### 13.6 Decision: checking against the contract (user decision)
- **The check runs three times:**
  1. **After the outline:** catches structural gaps, such as a missing deep dive, before any drafting.
  2. **After each section:** checks only the expectations that section is responsible for.
  3. **After the full draft:** a final pass over every expectation.
- **The result for each expectation** is **met / partly met / missing**. It comes with a quote from the draft as evidence, or a pointer to the gap. There is no number and no overall grade.
- **How a gap gets fixed:** the writer adds or extends a section, or runs more research (§12.4).

### 13.7 Decision: SEO as research input, plus external detectors (user decisions)
- **Keywords, competitors and coverage are kept.** They are "excellent indicators of what is currently working". They are part of research (§12, piece level), not a separate optimisation step.
- **Search and user intent** ultimately decide what a piece should be.
- **The primary keyword is an input.** By the time writers reach our tool, they have usually already done keyword research in a tool like Semrush.
  - They enter the primary keyword in the brief at intake.
  - The tool does not select keywords, and search volume data is out of scope.
- **SerpApi's role:** search-specific research for particular tasks (for example ranking pages, "People also ask" and related searches). These tasks will be defined as we go.
- **AI detectors: link out, don't build.**
  - A small panel links to well-known detectors, for example GPTZero, Originality.ai and Copyleaks, with a one-line note on their unreliability.
  - No integration, and no detector score inside the app.

### 13.8 Open questions for #3
- Whether the chat-thread pattern applies to the research, outline and section gates.
- How to keep AI-suggested expectations concrete: templates by intent type, and examples.
- Which SerpApi tasks are worth the cost, and whether they need the optional search key from §12.6.
- What happens when an expectation can't be met because research found too little. Drop it, flag it, or narrow the piece?
- Which external detectors to list, and how often to review the list.

## 14. Pain point #4: price versus value

### 14.1 How the market charges today
| Model | Who uses it | Typical price | What users dislike |
|---|---|---|---|
| **Per seat** | Jasper, Writer, Grammarly | Jasper Pro about $59–69 per seat per month | You pay for seats nobody uses. Five Jasper seats cost about $4,140 a year even in months with zero use. |
| **Per credit / usage** | Copy.ai (workflow credits), Anyword | Copy.ai $29/month, then a jump to $1,000/month for the next tier | The cost is opaque: Jasper publishes no per-credit rate. The jump between tiers is where buyers stall. |
| **Hybrid** | Copy.ai, Writer Starter | Seats plus credit caps | The bill is hard to predict. |
| **Generic chatbot** | ChatGPT, Claude | About $20/month | No workflow, but this is the price everyone compares against. |

Billing complaints from the research in §3:
- The annual rate is displayed, but users are billed the monthly rate.
- Users get locked into annual terms.
- Existing customers are not kept on their old price.
- The cost is hard to justify below about 10 pieces a month.

### 14.2 The real alternative is people, not software
- Freelance writer: about $250–400 for a mid-level 1,500-word B2B post.
- Specialist or subject-matter writer: $600–1,000+.
- Agency retainer: about $900–20,000 a month, averaging around $3,500.

These figures come from rate-guide blogs, so they are rough. The buyer's real question is "is this cheaper than a freelancer, and better?", not "is this cheaper than Jasper?"

### 14.3 Decision: pricing is tiered by number of companies (user decision)
- Pricing follows the company model in §6. A solo founder or in-house team needs one company. An agency needs one company per client.
- Tiers are set by how many companies are included (for example 1 / several / many). The exact boundaries and prices are still open.
- Proposed with this decision:
  - No per-seat charge inside a company.
  - No credits or usage caps from us.
  - Plain billing: the monthly price shown is the price charged, and existing customers keep their price. These come straight from the complaints in §14.1.

### 14.4 Decision: each company brings its own AI key (user decision)
- **Own key only to start.** We never pay for or mark up model costs. We charge for the system: workflow, memory, cards, review gates and the reader contract. An all-inclusive (managed AI) option may be added later if customers need it.
- **Several providers, one active at a time (user decision).**
  - A company can store keys for more than one provider, for example Claude and Gemini.
  - Only one provider is active at any moment, and all task types run on that provider's models.
  - This avoids mixing providers within a piece, but still lets a company switch.
- **Known trade-off.** One builder estimates that asking for a key loses 30–50% of signups on consumer tools. Our buyers are B2B content teams who already use AI tools (§8), so the cost should be lower for us. We should still measure it.
- **Search runs on the same key** by default (§12.6).

### 14.5 Decision: cost visibility and model routing by task (user decisions)
- **Estimate and actual.** ~~Before each step runs, the tool shows an estimated cost.~~ **Changed (user decision):** AI actions now run on one click, with no estimate step, because the extra click was friction. Every run still records its tokens and cost, and the monthly budget (including the hard limit) is still enforced on the server when a run starts. The usage section shows actual cost per piece, expandable to a per-task breakdown. Ask Writ still shows its per-question cost in the panel.
- **The main lever is choosing models by task type**, so that each task uses the cheapest model that does it well. Proposed starting mapping:

  | Task type | Needs | Model tier |
  |---|---|---|
  | Extracting and classifying: insight cards, research items, tagging, format checks | Accuracy on structure, little reasoning | Small and cheap |
  | Search plus source summaries | Search tool support, faithful quoting | Mid |
  | Contract suggestions, outline, checking against the contract | Reasoning | Mid to strong |
  | Drafting sections, voice consolidation | Best prose and voice-following | Strong |

- **Defaults plus advanced override (user decision).** We ship tested defaults for each task type and each provider. An advanced setting lets a company change the model for any task type.
- **Context blocks keep requests small.** The separate blocks and top-N retrieval from §5 and §8.4 reduce token use alongside the routing.
- **No per-piece cost figure is promised yet.** Measure real token use once the pipeline runs.
- The full design of routing comes later, along with the rest of the architecture.

### 14.6 Open questions for #4
- Tier boundaries (number of companies per tier) and prices, compared against freelancer cost per piece.
- The default model for each task type for each supported provider, and how we test those defaults.
- How accurate cost estimates can be before a step runs, given chat rounds and variable research volume.
- What happens to the stored keys of a company's inactive providers (security and storage), which links to the backend decision.
- Whether teams need spending alerts or limits on their own key.

## 15. Pain point #5: shallow research

### 15.1 What earlier decisions already cover
- **#1:** first-party substance, through insight cards and proprietary data cards (§8.4–8.5).
- **#2:** real search, research at the piece and section level, a mandatory review gate, manual sources and the source library (§12).
- **#3:** the reader contract defines what the piece must deliver (§13.4).

This section covers the remaining problem: **depth**. Research can feel shallow even when every source is real.

### 15.2 Why research feels shallow
1. **Everyone uses the same pool of sources.** AI research tools mostly read open, English, top-ranking pages, and can't get past paywalls. Every tool finds the same articles, so every piece says the same things.
2. **Breadth instead of depth.** "Deep research" mostly means following links from page to page, not analysing what is found. A JMIR review calls the analysis shallow and rarely new. Reviewers say Perplexity misses the strongest sources on broad topics.
3. **Quotes stitched together with no analysis.** Writing guides warn against "a multitude of quotes strung together by the occasional original sentence".
4. **Second-hand facts.** A blog quotes a news article that quotes a study. Experts go back to the original.
5. **Nothing first-hand.** No interviews, surveys or hands-on testing. This is the gap #1's insight cards fill.

### 15.3 Decision: the contract informs research but doesn't limit it (user decision)
- The reader contract's expectations shape the research questions. For example, "each technology has a named adopter" leads to a search for adopters.
- **Research isn't confined to the contract.** Open exploration of the topic, intent and competing coverage (§13.7) still happens. Findings outside the contract can suggest revising it.
- Research items are not mapped to expectations, and nothing is counted per expectation. The contract check (§13.6) is where gaps show up.

### 15.4 Decision: the depth mechanisms we build (user decisions)
1. **A mix of source types.**
   - Research deliberately searches for different kinds of source:
     - original research and reports
     - official docs and filings
     - practitioner sources (case studies, engineering blogs, conference talks)
     - critical or contrary views
     - raw data
   - Each research item's source type (§12.5) is extended to these categories.
   - The piece shows its mix, so "everything came from vendor blogs" is visible.
   - This is shown as information, not a target.
2. **An analysis step before the outline.** After piece research has been reviewed, the AI suggests where the real substance is:
   - **Tensions:** where sources disagree.
   - **Consensus vs. company insight:** where the company's cards confirm or contradict what everyone else says. "Everyone says X; our 40 customer calls say Y" is the strongest differentiator, and a piece no competitor can write.
   - **Open gaps:** what no source answers.

   The writer reviews this before outlining. It could use the chat-thread pattern (§13.5), decided per stage.
3. **Gaps become questions for the expert.**
   - Open gaps turn into specific questions for the subject-matter expert. For example: "No source covers how mid-market teams handle X. Do you have an internal view?"
   - The answers are saved as new insight cards (§8.4), which feeds back into #1.

### 15.5 Decision: follow-up passes stay manual (user decision)
- Tracing statistics to their original study, hunting for counter-evidence and finding named examples are passes that need an agentic browser to do well. The model APIs can't do them reliably today.
- **They are manual for now.** The tool supports the writer doing them:
  - The "trace to the original" note on secondary sources (§12.5) prompts the check.
  - Originals the writer finds are added as manual sources (§12.7) and go through the normal review gate.
- **Revisit when agentic browsing is available** through the API.

### 15.6 Open questions for #5
- How the AI classifies source type reliably, and how the writer corrects it.
- The output format of the analysis step: a list, a short memo, or a chat thread.
- How expert questions reach the expert (export, a share link, or pasting answers back) and how answers become cards.
- Whether contract revisions suggested by research need their own confirmation step.

## 16. Pain point #6: the wider climate is turning against AI content

### 16.1 What's changing
- **Readers.**
  - In a 2026 survey, 91% of consumers expect brands to disclose AI use. Only 7% say visible AI content raises their trust, while 31% say it lowers it.
  - Research adds a nuance: content labelled "AI-assisted" is trusted much more than content labelled "fully AI-generated", and misleading readers about AI use damages trust over time.
  - Disclosure helps, but on its own it doesn't win over sceptical audiences.
- **Platforms.**
  - LinkedIn added a "seems like AI slop" flag (about 1M reports, as reported) and dropped its own AI writer.
  - Flagged posts reportedly lose reach. LinkedIn hasn't published any penalty figures.
  - Commentators agree that the trigger is generic, empty output, not AI use itself.
- **Regulation.**
  - The transparency rule in Article 50 of the EU AI Act has applied since **2 August 2026**.
  - AI-generated text published to inform the public on matters of public interest (for example health, finance, legal or politics) must be disclosed.
  - **Exemption:** no label is needed when the text has had genuine human review or editorial control, and a named person or company holds editorial responsibility. Light edits or spell-checks don't qualify.
  - Law firms advise keeping a documented process: AI draft, then substantial review, then sign-off by a named person.
  - These sources are mostly law-firm alerts and blogs. Treat this as direction, not legal advice.

### 16.2 How earlier decisions already answer it
- #1–#5 make the tool produce what the climate rewards: first-party insight, reviewed facts, real expertise, and human approval at every stage.
- What was missing is **showing** that work, and keeping the writing itself in human hands.

### 16.3 Decision: positioning (user decision)
- **"Expert-owned, AI-assisted."** AI does the legwork. The company's experts own the substance, the writing and the sign-off.
- This positioning guides both the marketing and the wording inside the product.

### 16.4 Decision: section brief, then manual writing (user decision)
- **The new step.** Within each section:
  1. section research
  2. review gate (the writer confirms sources and data points)
  3. **section brief**
  4. draft
- **What the AI uses to write the brief** (everything gathered so far):
  - the approved items for that section
  - the reader-contract expectations the section owes (§13)
  - the analysis step: tensions, consensus vs. company insight, and gaps (§15.4)
  - the outline
- **What it is:** bullet points for what the section should contain, which work as an outline for the sub-section. The writer then **writes the section manually from these bullets**, rather than relying on AI-generated prose.
- **Bullet rules (user constraint).** Keep them crisp, short and as simple as possible. Elaborate sentences would influence the writer's style, and the draft could end up flagged as AI-generated.
  - Fragments and keywords only. No full sentences, transitions, adjectives or quotable phrasing.
  - One idea per bullet, in a sensible order.
  - Every bullet that rests on a fact links to its research item or card.
  - Example, from a section on digital twins:
    - `what: virtual replica of network → [item 4]`
    - `use: disruption sims; inventory planning`
    - `adopter: Unilever, 2023 → [item 7]`
    - `limit: data integration cost → [item 9]`
    - `our view: calls say SMEs stall at data prep → [card 12]`
- **AI drafting: manual by default (user decision).**
  - Writing manually from the brief is the default.
  - Letting the AI draft from the brief remains a secondary option. When it's used, the drafting wiring from §5 applies.
  - The editorial record (§16.6) notes which sections were written by a person and which were drafted by the AI.
- **Benefits.**
  - Human-typed text is the strongest voice signal for learning (§7).
  - The contract check (§13.6) still runs after each section, whoever wrote it.

### 16.5 Decision: AI help while the writer writes (user decisions)
- **Contract check.** The existing met / partly met / missing check after each section.
- **Fact check against items.** Flags numbers or claims in the writer's text that don't match an approved research item or card.
- **Ask in the thread.** The writer can ask questions in the section's chat, for example "what exactly did item 7 say?"
- **Grammar check.** Only the kind of corrections a conventional Grammarly-style plugin suggests: spelling, grammar and punctuation. No elaborate changes to the text and no full editing.
- **No rewriting, on by default.** The AI never rewrites the writer's sentences. A setting can turn this protection off.

### 16.6 Decision: editorial record and transparency outputs (user decisions)
- **The editorial record is optional, per company.** A company switches it on when needed, for example for EU audiences or regulated topics. It records:
  - who approved the research items, and when (§12.5)
  - the confirmed reader contract (§13.5)
  - each section, and whether a person wrote it or the AI drafted it
  - the final sign-off by a named editor

  The chat threads supply the reasoning behind these decisions.
- **Transparency outputs (all three adopted):**
  - **Provenance summary.** Generated from the real records, not a template. For example: "Drafted from 6 internal insights and 14 reviewed sources; 5 of 6 sections written by Jane Doe; approved by Jane Doe, Head of Content."
  - **Disclosure line.** An optional "AI-assisted, human-reviewed" statement the company can publish. The wording is editable, and it is never forced.
  - **Audit export.** The full trail (sources, approvals and threads) as a file, for compliance teams or clients.

### 16.7 Open questions for #6
- The exact bullet format for briefs, and how we test that briefs don't leak style. For example, compare the writer's output with and without the brief.
- The scope of the grammar check, which model it uses (the cheap tier, §14.5), and how suggestions are shown and accepted.
- Where the editorial record and exports are stored. This ties to the backend decision.
- The default wording of the disclosure line, plus localisation.
- Whether the tool should help a company decide when Article 50 applies to a piece, or leave that to the company's own judgement.

## 17. Architecture decisions

### 17.1 Written from scratch (user decision)
- Writ's workflow is designed and built fresh, not adapted from an earlier tool's stages.

### 17.2 Why Writ needs a backend
| Need | Source | Can the browser alone handle it? |
|---|---|---|
| Fetching URLs from other sites (blocked by CORS) | §8.3, §12.7 | No |
| Isolated companies, with teams | §6, §14.3 | No (needs accounts) |
| Thousands of insight cards, bulk import, retrieval | §8.4 | Only partly (IndexedDB is slow and tied to one device) |
| Uploaded files and source snapshots | §8, §12.8 | Only partly (size limits, one device) |
| Safe storage of customer keys for several providers | §14.4 | Only partly (a browser-only app keeps them in plain text in `localStorage`) |
| Long jobs, such as extracting cards from 1,000 transcripts | §8.4 | No (the job dies when the tab closes) |
| Editorial record and audit export | §16.6 | Only partly (a record kept only in the writer's browser can't be trusted) |
| Billing by number of companies | §14.3 | No |
| Cost estimates and actual costs | §14.5 | Only partly |

### 17.3 Decision: Supabase (user decision, for free testing)
- **Comparison of free tiers:**
  - **Firebase Spark** can't run the core of Writ. Cloud Functions need the paid Blaze plan, and Spark functions can't call external APIs. Blaze has a free allowance but requires a billing card.
  - **Supabase Free** covers everything:
    - Postgres, with 500 MB per project and no backups
    - 1 GB of file storage, with a 50 MB maximum per upload
    - about 500K Edge Function calls per month
    - authentication
    - row-level security
    - 5 GB of data transfer per month
- **Why it fits beyond price:**
  - The data is relational: companies, pieces, research items, approvals, cards and threads.
  - Row-level security keeps each company isolated (§6).
  - pgvector is available if relevance search is needed later (§8.4).
- **Free-tier caveats during testing:**
  - The project pauses after 1 week of inactivity and has to be resumed manually.
  - There are 2 active projects.
  - Keep test data small, because snapshots and uploads fill the 1 GB quickly.
  - Moving to a paid plan is a settings change, with no code changes.
- These figures come from third-party pricing guides, dated May–October 2026. Check supabase.com/pricing before relying on them.

### 17.4 Decision: LLM calls run on the server (user decision)
- All model and search calls go through Supabase Edge Functions, using the company's active key (§14.4).
- Keys are stored encrypted on the server and are never sent back to the browser.
- **Benefits:**
  - background jobs (bulk card extraction, batch research)
  - accurate cost tracking per step and per company (§14.5)
  - one place for model routing (§14.5)
- **Responsibility:** we hold customers' keys. That requires encryption at rest, a narrow set of people with access, and a published key-handling policy.
- **Limit:** Edge Functions have execution time limits, so bulk jobs run as small batches with progress saved between them, not as one long call.

### 17.5 Decision: teams from day one (user decision)
- The first slice includes:
  - logins
  - invitations for each company
  - roles: at least **member** and **editor**, so a named editor can sign off on a piece (§16.6)
- Row-level security means a person sees only the companies they belong to.
- One person can belong to several companies. This covers the agency case in §6.

### 17.6 Open questions for architecture
- How background jobs are designed: batch size, retries, and how progress is shown.
- The key-encryption approach (Supabase Vault vs. app-level encryption) and the access policy.
- Whether roles beyond member and editor are needed (for example admin or billing owner).
- What we do when a test project reaches the free-tier limits.

## 18. Build status

All six pain points and the architecture decisions are implemented in this repository. The
build follows the decisions above, with these specifics:

| Decision | Where it lives |
|---|---|
| Separate context blocks, wired per stage (§5) | `supabase/functions/_shared/context.ts`. Each task asks only for its blocks. Research never receives voice or memory; only drafting receives voice memory. |
| One company per client, teams, roles (§6, §17.5) | `companies`, `memberships` and `invitations`, with row-level security on every table |
| Learning from behaviour (§7) | Thread messages, edited AI drafts and pasted final versions feed "Learn from this piece". The suggested rules go into the editable `voice_memory` list. |
| Onboarding through existing systems (§8) | Each house-file section has a prompt to copy, paste/upload/URL input, AI merges reviewed as a redline, and bulk card import |
| Research separate from drafting, mandatory review (§12) | Piece and section scopes, quoted `cited_text` passages, and review gates enforced in SQL functions |
| Reader contract instead of a score (§13) | Owned by the writer, with suggestions in a thread. Checks run per section and on the final piece (met / partly / missing). |
| Own key, routing by task, cost visible (§14) | Encrypted keys, a default model per task type plus overrides, an estimate before every run, and logged cost |
| Depth (§15) | A deliberate mix of source types, the analysis step, and gaps turned into expert questions; follow-up passes stay manual |
| Section brief and manual writing (§16) | Fragment-only bullets linked to items, manual writing by default, grammar-only checks, and the AI draft recorded as such |
| Editorial record and outputs (§16.6) | `piece_events`, an optional editor sign-off, a provenance summary, the disclosure line and the audit export |
| Supabase, server-side calls (§17) | Migrations plus the edge functions `ai`, `research`, `provider-keys` and `fetch-url` |

**Not yet verified against live services:** nothing has run against a real Supabase
project or model API. See `README.md` for setup and known limits.

## 19. Workflows per format (modular recipes)

### 19.1 The problem (user)
A LinkedIn post doesn't need the full workflow of a blog post or a case study.

### 19.2 Decision: modular steps, with modular sub-steps (user)
Each format carries a **workflow recipe**: every step can be switched on or off, and so can the parts inside each step.

| Step | Sub-steps and settings |
|---|---|
| Brief | Fields: primary keyword, goal, audience notes, customer and approval contact, offer and call to action |
| Reader contract | Off / Lite (core point plus up to 2 expectations) / Full; AI thread on/off |
| Research | Web search (max searches) · search landscape · insight cards · source library · own sources · review step |
| Analysis | Tensions · insight vs. consensus · gaps and expert questions · contract suggestions |
| Outline | Off (single section) / Fixed template (headings) / Free; SEO/GEO outline check |
| Sections | Per-section research (one at a time or up front) · reuse piece research · section brief |
| Writing | By hand (always available) · AI draft allowed |
| Checks | Grammar · fact · contract · SEO · GEO · customer approval |
| Sign-off | Required · editor required · paste final version · learn from the piece |

- **Presets.** The six format templates ship as presets. A custom format starts from a base (long-form, short-form or case study) and is adjusted from there.
- **Who changes recipes (user decision).** Editors only, set per format.
- **LinkedIn thought leadership (user decision).** Keeps a *lite* reader contract.
- **Case studies (user decision).** A recorded customer-approval step comes before sign-off.

### 19.3 Guardrails
- **Dependencies are enforced.** For example: analysis needs research, section research needs an outline, SEO checks need a primary keyword, and a contract check needs a contract. The editor explains why something can't be switched on.
- **Loosened (user decision).** Editors may also switch off the research review step and the named sign-off. When they do:
  - research items are approved automatically, and marked as such;
  - the piece is "marked done" rather than signed off;
  - the provenance summary says plainly that research wasn't individually reviewed, or that there was no named sign-off.

  The company's "editorial record" setting still overrides this and requires an editor's sign-off.
- **Snapshot per piece (user decision).** A piece keeps the recipe it started with. Editing a format's recipe affects new pieces only. The audit trail shows the exact process each piece followed.

### 19.4 What comes next
- **History and revisions.** Signed-off pieces can be traced back, reviewed and revised.
- **Repurposing.** A new piece in a target format uses a source piece's approved research instead of new research. Its recipe decides the rest.

## 20. History, revisions and repurposing

### 20.1 Identity and history (user decisions)
- **IDs.** Every piece gets a unique, readable ID per company (for example `NW-0042`), and every version has a number (`v1`, `v2`).
- **Starting point.** Any version can be revised or repurposed.
- **Review schedule.** Pieces are flagged for review on a **fixed schedule**: a review date set at sign-off, from a company-wide interval. A due piece can be marked reviewed (which sets the next date) or revised.

### 20.2 Revisions (user decisions)
- **Old version.** Revising tags the old version **Revised** and links it to the new version.
- **Workflow.** The writer chooses whether the revision follows the **original recipe** or the format's **current recipe**.
- **Carried content.** The writer chooses which of the old version's approved research carries over. The contract, outline and section text are copied in for editing rather than rewritten.

### 20.3 Repurposing: three shapes (user decision)
Repurposing is a **planning step in front of the target format's normal workflow**, not a separate workflow.

| Shape | Example | Planning step | Produces |
|---|---|---|---|
| Split (1 → many) | Blog → 5 LinkedIn posts | AI proposes key points, each with its supporting approved research and source sections. The writer edits them. | N pieces in the target format |
| Adapt (1 → 1, new medium) | Blog → video script | AI maps source sections onto the target's structure and flags what doesn't translate | 1 piece, outline pre-filled |
| Combine (many → 1) | Posts → long-form guide | AI groups the sources' points into themes and flags gaps none of them covers | 1 piece, outline pre-filled; new research for the gaps |

- **Specific requirements.** Every repurpose has a free-text field where the writer explains anything the shapes don't capture (user decision).
- **Carried research (user decision).** The plan shows which approved items belong to each point. The writer can drop or add items, and carried items stay approved without a second review. New research goes through review as usual.
- **Lineage.** Each piece records `revision of`, `split from`, `adapted from` or `combined from`, with the exact source versions.

### 20.4 New format templates (user decision)
Instagram caption, Instagram carousel, LinkedIn carousel, X thread, video script, short video script, newsletter, and webinar or talk outline. Each one is a preset recipe. Carousels and scripts use fixed outlines, where each slide or segment is a section.

### 20.5 Follow-ups (user decisions)
- **Research is always available in every format.** The recipe can no longer switch research off; its sources and review step stay configurable. If no source is enabled, "add your own sources" is switched on. A piece or section can move on with no approved research, and the provenance summary says it was written without separate research.
- **Combined pieces carry the plan's gaps.** They're written into the piece's notes, which research and the other stages read as part of the brief.
- **Source updated.** A piece made from a version that has since been revised shows a banner with the newer version, and History flags it "source updated", so derived posts don't silently drift from a corrected source.

## 21. Memory across pieces, Ask Writ, export and spending (user decisions)

- **Chosen:** export (files, formatted copy, WordPress drafts), a monthly budget per company, memory across
  pieces and an "Ask Writ" panel. **Declined for now:** the expert question loop, review requests and comments,
  and notifications.
- **Memory** means what the company has already published, not a hidden profile: a check before sign-off flags
  contradictions, repeated angles and pieces worth linking, each with the earlier passage.
- **Ask Writ answers only from the company's own material, with numbered sources**, and says plainly when
  something isn't there. It is not a writing chat: drafting stays inside a piece, behind the review gates, so the
  generic-output problem from §2 doesn't come back through a side door.
- **Cost:** Ask Writ shows the cost of a question once in the panel rather than a confirmation before each
  question (an exception to §14's two-step rule, made for conversation); the monthly budget and hard limit apply.
- **Search** is Postgres full-text search to start; meaning-based search (pgvector) if keyword matching proves too
  literal.

## 22. Writing stage: pasted text, checks, leader voices and when writing is done (user requests)

- **Pasted text is tidied.** Every text box that takes pasted text collapses runs of blank lines into one blank
  line and strips trailing spaces, non-breaking spaces and invisible characters (`web/src/lib/paste.ts`). A single
  line break is kept, so a paragraph break (blank line) is always a bigger gap than a line break inside a
  paragraph. Prompt texts on the Prompts page are exempt, since their spacing is meaningful.
- **A tick means "checked on this exact text".** Each section has a `content_rev` that a database trigger raises on
  every change to its text. Grammar, fact and contract checks store the revision they ran on, and the Writing step
  shows "✓ Checked" only while that revision is still current. The next edit, saved or not, turns it into "Edited
  since the last check". Checks stay advisory: they never block marking a section written.
- **Write like a leader.** Editors define leader voices (name, role and a description of how the person writes) on
  the Leader voices page, in the house file. In the Writing step, and for the whole piece at sign-off, a writer
  picks a voice and copies a prompt plus their text into their own AI tool, then pastes the result back. Like the
  humanizer (§14.5), Writ does not restyle text itself: the writer owns the words, and the edited text goes through
  the same checks. Research and drafting never see these voices.
- **Writing is complete when every section is marked written.** The Writing step then shows as done, Sign-off
  becomes the current step, and a banner offers "Continue to sign-off". Approval is sign-off's job, not writing's.
  Reopening a section makes Writing current again. The stored stage stays `writing` until sign-off, so no data
  changes: only what the stage bar shows.

## 23. Section structure and AI fixes for SEO/GEO gaps (user requests)

- **Problem:** with little human input, a piece came out as heading, short paragraph, heading, short paragraph.
  The outline only held a heading and a one-line purpose, the brief was fragments, and drafting was told to write
  plain prose, so nothing asked for lists, tables, steps or short standalone answers that search and answer engines
  reward.
- **Improve structure (Outline step).** After the headings are in, "Improve structure" plans each section as an
  ordered list of blocks (short answer, paragraph, bullets, steps, table, example, figure, subheading, question and
  answer, expert quote, takeaway), each with a one-line note about what goes in it. The AI reads the brief,
  contract, analysis, approved research, format profile and the search landscape, and does not touch headings or
  order. The writer edits every block and saves; nothing is stored until they do (`piece_sections.structure`).
- **The structure is used downstream.** The section brief covers each planned block; the optional AI draft builds
  the section from the blocks (lists, numbered steps, markdown tables, `###` subheads) instead of plain prose; the
  Writing step shows the planned structure beside the section. Sections without a structure behave as before.
- **Fix gaps with AI.** After an SEO/GEO check finds "improve" items: on the outline, "Fix with AI" proposes a
  revised outline (headings, purposes, order, blocks) that lands in the editable draft for review and saving, never
  directly. On the finished piece, "Suggest edits with AI" proposes small, minimal edits (replace a passage, or add
  text at the start or end of a section) using only facts already in the text; the writer accepts or ignores each
  one. Gaps no text edit can fix (internal links, title and meta) are skipped and the reply says so.
- **Provenance.** An accepted edit is written to the section and recorded as `seo_fix_applied` in the editorial
  record, because the text now contains AI-suggested wording. Editing the text also makes the section's checks
  stale (§22). Accepting is disabled once the piece is signed off.
- **Known limit:** the export renders paragraphs, subheads and bullet lists; a markdown table from a drafted section
  is exported as plain text.
