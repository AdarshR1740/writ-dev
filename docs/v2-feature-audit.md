# Writer v2: Feature audit

I traced each feature from the screen, through the database calls, server functions and
prompts, to what gets saved, and back to the screen. Bugs found were fixed before moving
to the next feature.

## How it was checked

No local Supabase stack was available: there's no Docker, and downloading PostgREST was
blocked. Each layer was verified separately instead:

1. **Schema check, mechanical.** A script compares every `.from()`, `.select()`
   (including embedded relations), filter, `insert`/`update`/`upsert` key and `.rpc()`
   call in the web app and edge functions against the migrated schema in a local
   Postgres. Result: no mismatches. I confirmed it catches planted mistakes first.
2. **Database rules, executed.** All migrations were applied to a fresh Postgres with a
   Supabase auth shim. Every write the web app makes was then run *as a plain member*:
   materials, edits, formats, cards, piece, contract, thread, research review, outline,
   section research, brief, writing, reopen, voice memory and sign-off. Company
   isolation and role checks were run as well.
3. **Server code.** All four edge functions type-check with Deno. The citation and quote
   parsers have unit tests.
4. **UI.** The production build was rendered in Chromium against mocked API responses,
   with no page errors.

**Not verified:** calls to real model APIs and real Supabase Auth.

## Features and status

| # | Feature | Wiring traced | Result |
|---|---|---|---|
| F1 | Sign up, sign in, sign out | `AuthPage` → Supabase Auth → `handle_new_user` → `SessionProvider` | **Fixed:** the company list loaded every visible membership, including other members', so companies repeated and could show someone else's role. It now filters to your own. **Fixed:** a blank name at sign-up stored an empty display name. |
| F2 | Create a company, switch company | `NewCompanyPage` → `create_company` → membership + documents | OK |
| F3 | Team: members, roles, remove/leave, invites, accept | `TeamPage`, `InvitePage` → `memberships`/`invitations` RLS, `accept_invitation`, last-editor trigger | OK |
| F4 | Editorial record setting, disclosure line | `TeamPage` → `companies` update (editors only) | OK |
| F5 | Provider keys: save/verify/encrypt, activate, remove (4 providers) | `AiSettingsPage` → `provider-keys` → `verifyKey`, `encrypt` | **Fixed:** replacing the active provider's key switched it off, so every AI action then failed. A replaced key now keeps its active status. |
| F6 | Model per task: defaults and overrides | `AiSettingsPage` → `model_overrides` → `connect()` | OK |
| F7 | Usage and cost log | `recordUsage` / research `recordUsage` → `usage_events` → `AiSettingsPage` | OK |
| F8 | House-file overview and status | `Layout.loadStatus` → `OverviewPage` | OK |
| F9 | Add material: paste, upload, URL | `AddMaterial` → `readFileText` / `fetch-url` → `context_inputs` | OK |
| F10 | AI merge → redline → accept / edit / reject | `DocumentWorkbench` → `ai.consolidate` → `document_proposals` → `accept_proposal` | OK (stale proposals blocked) |
| F11 | Hand edits to documents | `DocumentWorkbench` → update → version trigger | OK |
| F12 | Formats and style profiles | `FormatsPage` → `formats` → profile document trigger | OK |
| F13 | Insight cards: list, filter, add, edit, delete, export | `CardsPage` → `cards` | OK |
| F14 | Card import: CSV, JSON, spreadsheet column | `parseCards` (unit tested) → bulk insert | OK |
| F15 | Extract cards from a transcript | `ai.extract_cards` → review → insert | OK |
| F16 | Proprietary data cards | `CardsPage` (data mode) | OK |
| F17 | Pieces and the brief | `PiecesPage` → `create_piece` | OK |
| F18 | Reader contract: editor, AI thread, confirm | `ContractStep` → `ai.contract_suggest` → `thread_messages`; `confirm_contract` | OK |
| F19 | Piece research: web search | `ResearchStep` → `research.search` (Anthropic citations / OpenAI + quote check) | OK (live APIs not run) |
| F20 | Add a source by URL or paste | `AddSource` → `fetch-url` → `research.extract_source` | OK |
| F21 | Card and library suggestions | `ResearchStep` → card insert policy / `extract_source` with `source_id` | OK |
| F22 | Review step: approve, reject, edit, undo, keys, finish | `review_item`, `complete_piece_research` | OK |
| F23 | Source library | `ResearchStep` / `LibraryPage` → `research.library` | **Fixed:** sources found by search were added to the library without their text, so "Use" on a later piece always failed. Adding a source now fetches and saves the page, and the library flags any source whose text couldn't be saved. |
| F24 | Analysis, expert questions, contract suggestions | `OutlineStep` → `ai.analysis` → `pieces.analysis`; answer → `cards` | OK |
| F25 | Outline: editor, AI thread, confirm | `save_outline`, `ai.outline_suggest`, `confirm_outline` (needs a confirmed contract) | OK |
| F26 | SEO and GEO checks, outline and final | `SeoGeoPanel` → `ai.seo_geo_check` → `pieces.seo_geo_*` | OK |
| F27 | Section research, one at a time or up front | `WritingStep` → `ResearchStep(section)` → `research` (order enforced on the server), `use_piece_item`, `complete_section_research` | OK. Added a guard for pieces with no sections. |
| F28 | Section brief | `ai.section_brief` → edit → `confirm_brief` | OK |
| F29 | Writing: autosave, mark written, reopen | `Writer` → `piece_sections` update, `complete_section`, status guard | OK |
| F30 | Grammar check | `ai.grammar_check` → accept / ignore | OK |
| F31 | Fact check | `ai.fact_check` → `piece_sections.fact_check` | OK |
| F32 | Section contract check | `ai.contract_check` (section) | OK |
| F33 | AI draft (secondary) | `ai.section_draft` → `ai_draft`, recorded in sign-off | OK |
| F34 | Final check and sign-off | `ai.contract_check` (piece) → `sign_off` (editor-only if required) | OK |
| F35 | How-this-was-made summary, disclosure line, audit export | `SignOffStep` | OK (the miscount was fixed earlier) |
| F36 | Voice memory and "Learn from this piece" | `VoiceMemoryPage`, `ai.learn_voice` → `voice_memory` → draft wiring | OK |
| F37 | Editorial event log | `piece_events` from every SQL function and server task | OK |
| F38 | Cost estimate before each AI run | `AiAction` → `mode: "estimate"` in `ai` and `research` | OK |
| F39 | Workflow recipes per format | `RecipeEditor` → `formats.recipe` (editors only, enforced by trigger) → `create_piece` snapshot → `enter_stage` skips switched-off stages → `requireStep` in every AI task → recipe-aware screens | **New.** SQL-tested for LinkedIn (lite contract, single section), promotional (no contract, review off) and case study (fixed outline, customer approval, editor sign-off). Recipe rules are unit-tested, and the test caught a preset bug that has been fixed. |
| F40 | Piece IDs, versions, History page, version compare | `assign_piece_code` trigger → `pieces.code/version/lineage_id` → `HistoryPage` / `LineagePanel` | **New.** SQL-tested. |
| F41 | Revise from any finished version | `ReviseDialog` → `revise_piece` (original or current recipe, carried items) → `enter_stage` uses the outline seed | **New.** SQL-tested, including single-section pieces keeping their text. **Fixed during testing:** an alias clash in `enter_stage` broke single-section pieces. |
| F42 | Repurpose: split, adapt, combine, with specific requirements | `NewRepurposePage` → `repurpose_plans` → `ai.repurpose_plan` → `RepurposePlanPage` → `create_from_plan` (carried items, outline seed, links) | **New.** SQL-tested for split and adapt; plans can't be reused. |
| F43 | Review schedule | `set_review_due` on sign-off → `ReviewDue` / History "Review due" → `mark_reviewed`; interval in Team | **New.** SQL-tested. |
| F44 | Eight more format templates | `presetFor` + `FORMAT_TEMPLATES` | **New.** Every preset passes the dependency rules (unit-tested). |
| F45 | Research always on; continue without research; gaps into the brief; "source updated" flags | `force_research` trigger, `complete_piece_research` / `complete_section_research`, `create_from_plan`, `contextFor` (origin notes), `LineagePanel`, `HistoryPage` | **New.** SQL-tested. All earlier SQL suites re-run, with only the expected rejections. |

