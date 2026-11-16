# Compatibility rules

People have this server in their Claude config, saved prompts, and habits built on the tool names. Writ's database is shared with the web app. Three surfaces must not break by accident. A change that has to break one needs a deliberate decision, a new version and a note here.

## 1. What Claude sees: tools and prompts

Snapshot of the released surface: `contract/mcp-contract.json` (29 tools, 3 prompts at v0.1). `src/contract.test.ts` compares the live server with it on every test run.

**Allowed:** new tools, new prompts, new **optional** parameters, wider enums, looser limits, better descriptions.

**Not allowed (the test fails):**
- Removing or renaming a tool, a prompt, a parameter or a prompt argument.
- Changing a parameter's type, or narrowing an enum, a minimum or a maximum.
- Making an existing parameter required, or adding a new required one.
- Turning a read-only tool into one that writes.

**Needs care the test can't see:**
- **Result shapes.** The prompts (`new_piece`, `onboarding`, `write_section`) tell Claude to read named fields in tool results (for example `house_file_ready`, `content_rev`, a piece's `stage`, section `id`s). Keep existing keys and meanings; add keys freely.
- **Approval flags.** Every write that needs the writer's go-ahead takes `writer_approved`. Never loosen that into a default of true.
- **Prompt text.** Changing wording is fine, but `new_piece` and `onboarding` name tools and steps. Rename nothing they refer to.
- **Safe replacement:** to retire a tool, keep the old name working (same parameters) and mark it deprecated in its description for at least one release.

After a release, refresh the snapshot: `npm run contract:update`, review the diff, commit it. Never refresh it to make a failing test pass.

## 2. What the server needs from Writ's database

The server calls Writ's functions by **name and argument names**. The Writ app repo may add arguments only if they have defaults. It must not rename or drop any of these:

| Function | Arguments the server sends |
|---|---|
| `create_company` | `company_name` |
| `create_piece` | `target_company, piece_title, piece_topic, keyword, format, piece_goal, audience, timing, extra` |
| `confirm_contract` | `target_piece` |
| `add_research_findings` | `target_piece, findings, target_section, auto, gap_search` |
| `review_item` | `item, decision, new_statement` |
| `complete_piece_research` | `target_piece` |
| `save_outline` | `target_piece, sections` |
| `confirm_outline` | `target_piece` |
| `use_piece_item` | `item, target_section` |
| `complete_section_research` | `target_section` |
| `confirm_brief` | `target_section, bullets` |
| `apply_alignment_fixes` | `target_piece, fixes` |
| `add_answer_to_research` | `target_piece, card, item_quote` |

It also reads and writes these tables directly, so their columns and row-level security must keep allowing it: `pieces`, `piece_contracts`, `piece_sections`, `research_items`, `cards`, `companies`, `formats`, `context_documents`, `document_proposals`, `voice_memory`.

**Migration dependency:** `writ_add_research` needs `20261127000000_add_research_findings.sql` in the Writ app repo (it is not committed there yet). Anyone whose Writ project lacks it gets a clear message, but nothing else is affected.

**Fields the server writes in the app's own shapes** (analysis, `seo_geo_outline`, `seo_geo_final`, section checks, talking points): if the app changes one of these shapes, change the server in the same release, and keep reading the old shape.

## 3. Settings and install

`WRIT_SUPABASE_URL`, `WRIT_SUPABASE_ANON_KEY`, `WRIT_EMAIL` and `WRIT_PASSWORD` stay valid. A new sign-in method (browser sign-in, a hosted connector) is added **beside** them, not instead. The entry point stays `dist/index.js`, and the server name stays `writ`, since users' Claude config and the `/writ:` prompt names depend on both.

## Before every release

1. `npm run build && npm test` (the contract test is part of it).
2. If the Writ app's presets changed, regenerate `src/format-presets.ts` (see the README). If `web/src/lib/stepViews.ts` changed, regenerate `src/step-views.ts` (section 4).
3. Bump `version` in `package.json` and in `src/index.ts`; refresh the snapshot as above.
4. Add an entry for every new tool or prompt in `src/tool-docs.ts` (the tests fail without one), then run `npm run docs:update`. It rewrites `docs/TOOLS.md` and the data behind the "Writ in Claude" page in the app; commit both repos.

## 4. State the app sets by itself

The app's screens change things in the database directly from the browser, outside the database functions this server calls. Anything in this list is state the MCP server does not get for free. **When a change adds a browser-side write, ask: does the MCP server need to do the same? Add the answer here.**

| What the app writes | From | The MCP server |
|---|---|---|
| `pieces.analysis.benchmark_done` (the benchmark was finished) | "Create outline" | Sets it on save when a gap analysis exists. **The screens no longer depend on it**: an outline that exists is always shown (`outlineView`). |
| `pieces.analysis` flags: ignored, resolved, researched, sectioned, fixes_applied, verify_note | The benchmark panel | `writ_mark_findings`, `writ_apply_alignment_fixes`, `writ_add_expert_answer` |
| `pieces.title`, `primary_keyword` | The outline's title fields | Plain data; `writ_start_piece` sets them at creation |
| `piece_contracts` (core question, points) | The scope editor and the benchmark's scope modals | `writ_save_scope`, `writ_confirm_scope` |
| `research_items` insert (a card or manual finding) | The research step | `writ_add_research`, `writ_add_expert_answer` |
| `piece_sections.content`, `heading` | The Writing step | `writ_save_section_draft` (never overwrites the writer's text); headings through `writ_save_outline` |
| `piece_sections.status` back to `writing` on reopening a written section | The Writing step | Not offered: the writer reopens in Writ |
| Checks (`seo_geo_outline`, `seo_geo_final`, section checks) | The check panels | `writ_save_outline_checks`, `writ_save_section_checks`, `writ_save_final_checks`, in the app's own shapes |

### The rule for screens

A screen shows or hides something only as a function of the data underneath, never of a flag the app sets as a side effect of its own buttons. A piece with the data but without the flag must still show the data. The rules live in `web/src/lib/stepViews.ts` in the app (`outlineView`, `writingState`, `researchLocked`, `describePiece`) and are tested there against pieces built the way this server builds them.

### The health check

`writ_check_piece` describes what the writer will see on each step and lists what looks wrong. It runs those same rules: `src/step-views.ts` is **generated** from the app's `stepViews.ts`:

```bash
node scripts/export-step-views.mjs     # the app repo is the parent folder
```

Run it again whenever `stepViews.ts` changes in the app, and commit the result. The `new_piece` prompt tells Claude to call the check after changing the outline or finishing a step, and to tell the writer about every problem it reports.

## 5. Edit locks

One person (or one Claude) at a time edits the outline, and each section's text. A lock is taken on the first edit, renewed while work goes on, and frees itself a few minutes after the last activity. The database enforces it (migration `20261129000000_edit_locks.sql`); the app shows a banner with "Take over".

**What changes for this server**
- Eight write tools can now be **refused** while the writer holds the lock: `writ_save_outline`, `writ_confirm_outline`, `writ_save_analysis`, `writ_mark_findings`, `writ_apply_alignment_fixes`, `writ_add_expert_answer` (outline), and `writ_save_section_points`, `writ_save_section_draft` (a section). The message says who is editing and what to do; nothing is saved. Their parameters and results are unchanged.
- Each Claude connection sends `x-writ-client` (a per-process id) with every request, and takes the lock only for the length of a write, so it never keeps the writer out.
- `writ_check_piece` reports who is editing (a note, never a problem).
- A Writ database without the lock functions behaves as before: the tools detect that and write normally. Apply the migration first or last; both orders are safe.

**Rule:** any new tool that changes the outline's structure or a section's text must run inside `lockedOutline` or `lockedSection` (see `src/writ.ts`), and the database will refuse it if it does not hold the lock. Writes made by Writ's own server functions (the service role) are not checked.
