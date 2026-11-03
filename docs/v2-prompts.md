# Writer v2: Prompt inventory

Every prompt in v2, in pipeline order: where it lives, which context blocks it
receives, which model tier runs it, and what changed in the review pass. Use this to
check that each step we discussed has a default prompt.

The model tiers are `extract`, `research`, `reason` and `write`. Each company's
provider picks the actual model per tier; see `_shared/models.ts`.

## A. Prompts teams run in their own AI tool (house file)

These live in `web/src/lib/sections.ts` and appear as "Get this from your AI tool" in each section.

| Step | Prompt | Review changes |
|---|---|---|
| ICP | `DOC_SECTIONS[icp].prompt` | Now also asks for the questions the ICP searches for, which feed SEO intent. |
| Positioning | `DOC_SECTIONS[positioning].prompt` | No change. |
| Other strategy notes | `DOC_SECTIONS[strategy_notes].prompt` | No change. |
| Core voice | `DOC_SECTIONS[core_voice].prompt` | Now names generic AI phrasing to ban ("delve", "it's not just X, it's Y"). |
| Format profile | `FORMAT_PROMPT(name)` | No change. |
| Insight cards, run once per call transcript | `INSIGHT_PROMPT` | The answer is now one line of JSON, so a spreadsheet column imports one array per row. |
| Proprietary data | `DATA_PROMPT` | Now skips figures with no clear source or period. |

## B. Server prompts, in pipeline order

The `ai` tasks live in `supabase/functions/ai/`. Research lives in `supabase/functions/research/index.ts`.

| # | Step | Task / prompt | Context blocks | Tier | Review changes |
|---|---|---|---|---|---|
| 1 | House file merge | `consolidate` / `consolidateSystem(kind)` | Current document plus new sources | write (format profiles: reason) | Format profiles now quote one or two real openings from the examples. |
| 2 | Insight extraction in the app | `extract_cards` / `EXTRACT_SYSTEM` | The transcript only | extract | No change. It matches the external prompt. |
| 3 | Reader contract | `contract_suggest` / `CONTRACT_SYSTEM` | Brief, contract, ICP, positioning, strategy notes, thread | reason | Reads the intent from the primary keyword (adds "X vs Y"), and notes that research may revise the contract. |
| 4 | Piece research | `research.search` / `SEARCH_SYSTEM` (Anthropic) or `SEARCH_SYSTEM_QUOTED` (OpenAI) | Brief, contract, ICP | research | **New:** a search-landscape pass (intent, what ranking pages cover and skip, questions people ask), tagged `[serp]`. This is §13.7: SEO feeds research, not scoring. |
| 5 | Section research | Same as #4, with a section prompt ("deeper, not wider") | Brief, contract, outline, section | research | No change. |
| 6 | Findings from your own sources | `research.extract_source` / `EXTRACT_SYSTEM` (Anthropic citations) or `EXTRACT_SYSTEM_QUOTED` (others) | Brief, contract, (section), the source | research | **New:** a quoted variant for non-Anthropic providers. The server checks each quote against the source text. |
| 7 | Analysis | `analysis` / `ANALYSIS_SYSTEM` | Brief, contract, approved piece research | reason | **New output:** `contract_suggestions` (§15.3: research can suggest contract changes; the writer decides). |
| 8 | Outline | `outline_suggest` / `OUTLINE_SYSTEM` | Brief, contract, analysis, approved research, format profile, thread | reason | No change. |
| 9 | SEO & GEO check, outline | `seo_geo_check` (scope `outline`) / `SEO_GEO_BASE` + `SEO_GEO_CHECKS.outline` | Brief, contract, approved `[serp]` items, outline | reason | **New** (adapted from v1's SEO and GEO guidelines). |
| 10 | Section brief | `section_brief` / `BRIEF_SYSTEM` | Section, outline, analysis, section research | reason | Now opens with an `answer:` bullet (answer-first for readers and AI answer engines). |
| 11 | AI draft (secondary) | `section_draft` / `DRAFT_SYSTEM` | Section, outline, section research, core voice, format profile, voice memory, brief | write | Opens with the `answer:` point and names the source of each figure in the text. |
| 12 | Grammar check | `grammar_check` / `GRAMMAR_SYSTEM` | The text only | extract | No change. |
| 13 | Fact check | `fact_check` / `FACT_SYSTEM` | Section research, the written section | reason | No change. |
| 14 | Contract check (section and final) | `contract_check` / `CONTRACT_CHECK_SYSTEM` | Expectations owed, the text | reason | No change. |
| 15 | SEO & GEO check, final | `seo_geo_check` (scope `final`) / `SEO_GEO_BASE` + `SEO_GEO_CHECKS.final` | Brief, contract, approved `[serp]` items, the full piece | reason | **New**, and it also writes a meta title and description. |
| 16 | Voice learning | `learn_voice` / `LEARN_SYSTEM` | Core voice, voice memory, AI drafts vs. kept text, published vs. assembled, writer messages | reason | No change. |

## B2. Prompt variants that follow the format's recipe (§19)

| Variant | Where | When |
|---|---|---|
| `CONTRACT_LITE` | `ai/prompts.ts` | The contract is "lite": one point, at most 2 expectations (also enforced in `confirm_contract`). |
| `BRIEF_SHORT` | `ai/writing.ts` | The outline is off: single-section brief built as hook / answer / proof / close, from piece research. |
| Analysis parts | `ai/writing.ts` | Parts the recipe switches off are told to return empty lists. |
| `searchSystem(withSerp, quoted)` | `research/index.ts` | The search landscape is included only when `research.serp` is on. The search count comes from `research.max_searches`. |
| SEO/GEO areas | `ai/writing.ts` | Only the SEO or GEO checks the recipe enables are requested and kept. |

Every AI task also refuses to run when its step is switched off in the piece's
recipe (`requireStep`), so a switched-off step can't be called through the API.

## B3. Repurposing

| Task / prompt | Context blocks | Tier |
|---|---|---|
| `repurpose_plan` / `REPURPOSE_BASE` + `REPURPOSE_SHAPES[split \| adapt \| combine]` (`ai/writing.ts`) | Each source piece's sections and approved research (numbered across sources), the target format (outline mode, contract mode, style profile), the specific requirements | reason |

The plan only proposes. The writer edits the entries, sections and carried items, and `create_from_plan` then creates the pieces.

## C. SEO and GEO: what came from v1 and what didn't

Kept from v1's `DEFAULT_BLOG_SEO_GUIDELINES`, `DEFAULT_BLOG_GEO_GUIDELINES` and outline rules:

- **Title:** primary keyword near the start, about 60 characters or fewer.
- **Meta description:** 140–155 characters.
- **Headings:** descriptive, entity-specific, never generic placeholders ("Introduction", "Conclusion").
- **Answer first:** the core answer in the opening, roughly the first 150 words.
- **Answer capsules:** standalone answers of about 40–60 words after key headings.
- **Named entities and attribution:** real companies, products and standards named; figures say where they come from.
- **Structure:** tables for comparisons, numbered steps for procedures.
- **Internal links:** linking opportunities, with suggested anchor text.

Changed to fit the v2 decisions (§13):

- **No score, no "mandatory" rewriting pass.** v1 rewrote the outline automatically. v2 returns a checklist (fine / improve / n/a) with evidence and a fix, and the writer decides.
- **No keyword density, repetition or term quotas.**
- **Intent and coverage come from approved search-landscape research,** not from invented SERP data (pain point #2).
- **Added a first-party check:** the company's own insight is what AI answer engines can't find elsewhere (§13.2, §15).

## D. Providers and research quotes

| Provider | Default models (extract / research / reason / write) | Web search | How research quotes are obtained |
|---|---|---|---|
| Anthropic (Claude) | `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5` | Yes | The citation API returns the passage (`cited`). |
| OpenAI (ChatGPT) | `gpt-5-nano` / `gpt-5-mini` / `gpt-5-mini` / `gpt-5` | Yes (Responses API) | The model quotes the passage; the server fetches the page and checks it (`verified` / `unverified`). |
| Google (Gemini) | none (set per task) | No | Quotes from your own sources are checked against the source text. |
| Local (OpenAI-compatible) | none (set per task) | No | Quotes from your own sources are checked against the source text. |

The OpenAI default model IDs and prices come from OpenAI's model pages, as seen during the build. Check them against your account, and override them in AI settings if you prefer newer models.

## E. Memory and Ask Writ (`supabase/functions/ai/memory.ts`)

Both receive numbered passages from `search_material` (the company's own material) and nothing else.

### E1. Ask Writ (task `ask`, reasoning model)
Output: `answer`, `covered` (yes/partly/no), `cited`. The server keeps only citations that point at a real
passage, renumbers them in order of use, and answers without a model call when nothing matches.

```
You are Writ's assistant for one company. You answer questions using ONLY
the numbered passages, which come from the company's own material: its finished
pieces, insight and data cards, house file (customer profile, positioning, voice)
and approved research.

Rules:
- Every statement in your answer must come from the passages. Cite each one with
  its passage number in square brackets, like [2] or [1][4].
- If the passages don't answer the question, or only partly, say so plainly in
  the first sentence. Then say where the answer would belong (for example "add it
  as an insight card" or "it isn't in the house file yet"). Never fill gaps with
  general knowledge, and never guess.
- Be brief and specific: a few sentences or a short list. Quote exact figures.
- You help people find and reuse what they already know. You don't write or
  rewrite content; if asked to, explain that writing happens in a piece, and
  offer the relevant passages instead.
- Earlier turns are context for follow-up questions; answer the latest question.
```

### E2. Against what you've published (task `memory_check`, reasoning model)
Output: `flags` of `contradiction` / `repeat` / `link`, each with the exact sentence, a passage number and a note.
The server drops flags pointing at no passage and marks sentences not found word for word in the piece.

```
You compare a new piece of B2B content with what the same company has
already published, shown as numbered passages from earlier finished pieces and
their approved research. Flag only what an editor would want to know before
publishing:

- "contradiction": the new piece states a fact, figure or position that conflicts
  with an earlier piece (for example a different number for the same statistic,
  or the opposite recommendation). The most important kind.
- "repeat": the new piece makes the same argument, uses the same story or example,
  or leads with the same angle as an earlier piece, so readers who saw that one
  get little new.
- "link": an earlier piece covers a point the new piece mentions in passing, so
  linking to it would help the reader.

For each flag give the exact sentence from the new piece (copied word for word),
the passage number it relates to, and one short note saying what the editor
should check or do. Flag nothing that is merely on the same topic. Fewer, better
flags; an empty list is a fine answer. No scores.
```
