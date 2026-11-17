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

One person (or one Claude) at a time works on each step of a piece. A lock is taken on the first edit, renewed while work goes on, and frees itself a few minutes after the last activity. The database enforces it (migrations `20261129000000_edit_locks.sql`, `20261130000000_lock_every_step.sql` and `20261201000000_call_locks_and_versions.sql`); the app shows a banner with "Take over".

| Lock | What it covers | Tools that take it |
|---|---|---|
| `scope` | the reader contract (core question, points, confirming), the piece's setup (topic, goal, audience, format, recipe, brief) | `writ_save_scope`, `writ_confirm_scope`, `writ_apply_alignment_fixes` |
| `research` | a piece's research items: adding, reviewing, finishing | `writ_add_research`, `writ_review_research`, `writ_complete_research`, `writ_use_research`, `writ_add_expert_answer` |
| `outline` | sections' structure, title, keyword, benchmark, the outline's SEO/GEO check, confirming | `writ_save_outline`, `writ_confirm_outline`, `writ_save_analysis`, `writ_mark_findings`, `writ_apply_alignment_fixes`, `writ_add_expert_answer`, `writ_save_outline_checks` |
| `section` | one section's text, heading, brief, points, and its grammar/fact/contract check results | `writ_save_section_draft`, `writ_save_section_points`, `writ_save_section_checks` |
| `final` | the final check, the final SEO/GEO check, customer approval, final text, sign-off | `writ_save_final_checks` |

**What changes for this server**
- Those write tools can be **refused** while someone else holds the lock. The message says who is editing and what to do; nothing is saved. Their parameters and results are unchanged. A tool that touches two kinds (for example `writ_add_expert_answer`: outline and research) needs both to be free.
- Each Claude connection sends `x-writ-client` (a per-process id) with every request. After a write it **keeps the lock for 60 seconds** (renewed by each further write on that step), so a writer cannot start typing in the middle of Claude's work; it expires by itself once Claude stops.
- `writ_get_section` and `writ_get_check_input` also take the lock for 2 minutes (Claude reads them in order to write). When someone else already holds it, the read still works and the result carries a `notice` saying who is editing and not to start drafting.
- `writ_check_piece` reports who is editing (a note, never a problem).
- A Writ database without the lock functions behaves as before: the tools detect that and write normally. Apply the migration first or last; both orders are safe.

**Step versions (a second check, for what a lock cannot catch)**
- The database keeps, for each step and each section, when it last changed and who changed it (`step_versions`, migration `20261201000000_call_locks_and_versions.sql`). Writes by the writer, by Claude and by Writ's own AI all move it.
- The read tools (`writ_get_piece`, `writ_get_section`, `writ_get_research`, `writ_get_check_input`) remember, per connection, the version they showed. A write tool that replaces or decides something is **refused** when Claude has not read that step in this connection, or when the step changed after it was read (even if the other writer's lock has long expired). The message names who changed it and when, and tells Claude not to merge or overwrite, but to read it again, tell the writer what changed, and ask how to combine the two. Tools that only add (`writ_add_research`, `writ_use_research`, `writ_add_expert_answer`) need no read. A piece Claude started with `writ_start_piece` counts as read.
- No parameter changed: the server does the remembering. A restarted server has read nothing, so the first save after a restart asks for a read.
- A database without `step_versions` behaves as before.

**Writ's own server functions** (the "Write using AI" buttons, the AI checks, research search) take the same locks, as the person who asked and from that person's tab (the web app sends its client id in the request body). They refuse before spending anything on the AI when someone else holds the lock, and check again right before writing. If the lock was taken over meanwhile, nothing is written, and the result goes back to the writer to copy.

**Rule:** any new tool that writes to a step must run inside the matching helper in `src/writ.ts` (`lockedPiece` for scope, research and final; `lockedOutline`; `lockedSection`; `lockedResearchOf` when it only has research item or section ids; pass `{ append: true }` only for a tool that merely adds), and the matching read tool must call `noteReadPiece` or `noteReadSection` before it returns content. The database refuses a write that does not hold the lock. A new browser-side write goes through `useEditLock` (a step that stays open) or `withShortLock` (a one-off write from another step) in `web/src/lib/locks.ts`. A new server function that writes a guarded step must be listed in `aiLockPlan` (`supabase/functions/_shared/call-locks.ts`) or call `takeCallLocks` itself.
