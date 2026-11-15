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
2. If the Writ app's presets changed, regenerate `src/format-presets.ts` (see the README).
3. Bump `version` in `package.json` and in `src/index.ts`; refresh the snapshot as above.
