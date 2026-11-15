# Handoff: Writ MCP server (continue in a new chat)

## Goal
Offer Writ's method as an MCP server for Claude, so writers use their own Claude subscription instead of Writ's AI API credits (about $1 per piece is too costly for small and mid-size teams). Plan: sell two things, the full Writ app (teams that need review, roles, audit) and the MCP server (writers who live in Claude). Start with Claude only. Step 1, now: a thin server over the existing Writ backend, tested by friends. Later: a hosted version, a provider layer for the full app, the user's own approach to web research.

## Locations
- App: `D:\projects\writ-dev` (React 19 + Vite web, Supabase edge functions `ai`, `research`, Postgres migrations). Branch `main`, last commit `e48f4a6`, pushed to origin.
- MCP server: `D:\projects\writ-mcp-server` (this repo). Git initialised, nothing committed yet.
- Untracked and left alone on purpose: `D:\projects\writ-dev\video\`.

## Done
- Writ app: Writing step (section prep with research and talking points, start by hand or Write using AI, rich editor, H3/H4 headings in AI drafts, per-section Revise with scoped edits) committed and pushed.
- MCP server v0.1 built: stdio transport, signs in to Supabase as the writer, five tools (`writ_list_pieces`, `writ_get_piece`, `writ_get_section`, `writ_get_voice`, `writ_save_section_draft`) and a `write_section` prompt carrying Writ's drafting rules.
- Build passes; 4 tests pass (save rules with a stub client, protocol listing over stdio).

## In progress / not verified
- Never run against live Writ data or inside Claude (needs the user's Writ login and the Supabase URL and anon key).
- The `ai` and `research` edge functions and migrations `20261125000000_remove_gap_research.sql`, `20261126000000_section_points.sql` may still need deploying (`scripts\cloud-setup.ps1 plqzeqaswtokfsgudmld`). Sections must be prepared (talking points) in the app for the MCP flow to have good input.

## Files (MCP repo)
- `src/index.ts`: MCP server wiring, tools, prompt, error handling.
- `src/writ.ts`: all Writ reads and the draft save, over a signed-in Supabase client.
- `src/client.ts`: email/password sign-in from environment settings.
- `src/prompts.ts`: drafting rules given to Claude.
- `src/writ.test.ts`, `src/protocol.test.ts`: tests.
- `README.md`, `.env.example`, `package.json`, `tsconfig.json`, `.gitignore`: setup and config.

## Failing tests
None.

## Decisions and why
- MCP route over "log in with a subscription": providers don't allow third-party apps to spend subscription quota, and borrowed CLI tokens would break and risk accounts.
- Segment by workflow, not company size: the full app is for teams needing governance and audit; MCP for writers who want the method in their own chat.
- Writes are proposals: a draft saves as the section's AI draft (and as its text only if empty), never over the writer's text, so the human still reviews and the app's sign-off still records AI use.
- Uses the writer's own login and the public anon key so existing row-level security applies; never the service-role key.
- Claude Desktop or Claude Code recommended so files can be generated. The user will handle web research their own way later.

## Known gaps
- Clients cannot insert `piece_events`, so the `section_ai_drafted` editorial-record event is not written. Needs a small Writ edge function.
- Password sits in the client config: fine for friends, not for release (use browser OAuth).
- Local only; no hosted connector yet.

## Next step
Run it for real: put the Supabase URL, anon key (from `D:\projects\writ-dev\web\.env.local`, `VITE_SUPABASE_ANON_KEY`) and the user's Writ login into Claude Code or Claude Desktop as in the README, then use `write_section` on a prepared section of a real piece and report what breaks. After that, add the edge function that records the AI draft event, and commit this repo.
