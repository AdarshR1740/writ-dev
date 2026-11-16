# writ-mcp-server

Writ's method inside Claude. Claude reads a section's brief from Writ (talking points, approved research, the company's voice), drafts it on the writer's own Claude subscription, and saves the draft back to Writ for the writer to review. Version 0.1 is a thin test of the idea: it reads and saves through the same Supabase backend as the Writ web app, with the writer's own login, so Writ's access rules apply.

## Tools

The full, always-current reference (every tool, what it does, when it is used, its parameters) is [docs/TOOLS.md](docs/TOOLS.md), and the Writ app shows it on its **Writ in Claude** page. Both are generated: `npm run docs:update`. The table below is a summary.

| Tool | What it does |
|---|---|
| `writ_list_pieces` | The writer's pieces: code, title, stage |
| `writ_get_piece` | Brief, reader's question, outline with each section's id, status and whether it is prepared |
| `writ_get_section` | Everything needed to write one section: purpose, outline, talking points with evidence, numbered approved research with URLs, planned structure, current text |
| `writ_check_piece` | Read-only health check: what the writer will see on each step in Writ right now, and anything that looks wrong or stuck, each with what to do. Run it after saving an outline, reopening something, or finishing a step |
| `writ_get_voice` | Core voice, format profile, audience, positioning, learned voice rules |
| `writ_get_setup` | Where the writer stands: their companies, each with its formats, how much of the house file is filled in (and whether it is ready), and its piece count. An empty list means a brand-new writer |
| `writ_create_company` | Creates the writer's company through Writ's `create_company` (they become its editor). A company can't be deleted from here, so the name is confirmed first |
| `writ_add_formats` | Switches on Writ's standard formats for a company (blog, LinkedIn, case study, carousels, scripts, newsletter and more), each with its workflow recipe. Skips formats it already has. Style profiles start empty |
| `writ_get_context_documents` | The text of the house-file documents: ICP, core voice, positioning, strategy notes |
| `writ_save_context_document` | Saves one house-file document as Markdown. Refuses to replace existing text unless the writer agreed |
| `writ_start_piece` | Creates a new piece through Writ's `create_piece` (Writ assigns the code). A real change: only after the writer confirms the brief |
| `writ_save_scope` | Saves the scope draft: the one reader question and the points. Only while the scope step is open |
| `writ_confirm_scope` | Confirms the scope through Writ's `confirm_contract`, which moves the piece to research |
| `writ_get_research` | A piece's (or one section's) research items, with ids, status, sources and whether the quote was checked |
| `writ_add_research` | Saves findings Claude found as unreviewed items (quotes are **not** checked against the pages). Needs the `add_research_findings` migration in Writ |
| `writ_review_research` | Records the writer's approve / reject decisions, through Writ's `review_item` |
| `writ_complete_research` | Finishes the research step through Writ's `complete_piece_research` (moves the piece to the outline) |
| `writ_save_outline` | Saves the outline draft (headings, purposes, which scope points each serves). Open outlines only |
| `writ_confirm_outline` | Confirms the outline through Writ's `confirm_outline` (moves the piece to writing) |
| `writ_use_research` | Copies approved piece research into a section so its points can cite it |
| `writ_save_section_points` | Saves a section's talking points, then has Writ finish the section's research and confirm its brief so it is ready to draft |
| `writ_get_check_input` | Everything one check needs, numbered the way the save tools expect: the gap analysis, the outline's SEO/GEO check, one section's checks (with its `content_rev`), or the final checks on the whole piece |
| `writ_save_analysis` | Saves the gap analysis (verdict, drift, up to 4 gaps with an expert question each, scope suggestions) in the piece's own field, with the ids of the research and scope points it was run on |
| `writ_mark_findings` | Records the writer's decisions on analysis findings: ignored, resolved, or open again |
| `writ_apply_alignment_fixes` | Applies the writer's chosen fixes through Writ's `apply_alignment_fixes`: reject research, edit, remove or add scope points, add sections |
| `writ_add_expert_answer` | Saves the writer's own answer to a gap's expert question as an insight card and approved research (Writ's `add_answer_to_research`) |
| `writ_save_outline_checks` | Saves the outline's SEO and GEO check in `seo_geo_outline` |
| `writ_save_section_checks` | Saves a section's grammar, fact and scope check results in the app's fields, stamped with the text version they were run on |
| `writ_save_final_checks` | Saves the final scope check and the final SEO/GEO check (with meta title and description) |
| `writ_save_section_draft` | Saves a draft as the section's AI draft (and as its text if the writer has none yet). Never overwrites the writer's text |

Three prompts:

- `new_piece` (type `/writ:new_piece`, optionally followed by your idea): takes a piece from idea to a first draft: the brief, scope, research, outline, then each section's talking points and draft. Claude asks for your feedback at every step and only confirms a step when you approve. There is no sign-off: the draft stays in Writ for your review. Saving research needs the `add_research_findings` migration (`supabase/migrations/20261127000000_add_research_findings.sql` in the Writ app repo) to be applied first.
- `onboarding` (type `/writ:onboarding`; older Claude Code versions list it as `/mcp__writ__onboarding`): start here if you're new. It shows a skimmable guide to what you can do with Writ in Claude, then checks where you stand and takes you through what is left: create your company, then build your house file (ICP, core voice, positioning, optional strategy notes) from material you share, a link to your website or blog, or a short interview, saving each document only when you approve it. It ends by pointing you to `new_piece`. It mirrors the four-step setup in the web app, minus the AI key, which drafting in Claude doesn't need.
- `write_section` carries Writ's drafting rules (approved research only, sources linked in line, H3/H4 headings, the company's voice).

## Set up (Claude Desktop or Claude Code)

```bash
npm install
npm run build
```

Settings, the same project and login as the Writ web app (the anon key is in the web app's `.env.local` as `VITE_SUPABASE_ANON_KEY`; never use the service-role key):

- `WRIT_SUPABASE_URL`
- `WRIT_SUPABASE_ANON_KEY`
- `WRIT_EMAIL`
- `WRIT_PASSWORD`

**Claude Code**

```bash
claude mcp add writ -e WRIT_SUPABASE_URL=... -e WRIT_SUPABASE_ANON_KEY=... -e WRIT_EMAIL=... -e WRIT_PASSWORD=... -- node D:/projects/writ-dev/mcp-server/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "writ": {
      "command": "node",
      "args": ["D:/projects/writ-dev/mcp-server/dist/index.js"],
      "env": {
        "WRIT_SUPABASE_URL": "...",
        "WRIT_SUPABASE_ANON_KEY": "...",
        "WRIT_EMAIL": "...",
        "WRIT_PASSWORD": "..."
      }
    }
  }
}
```

Then run the `onboarding` prompt for a guided tour, or ask Claude, for example: *"Use the write_section prompt for section … of SI-0012"*, or *"Show my Writ pieces."*

## Formats and the workflow

Every format gets the full blog workflow, with every step switched on: scope, research (with web search and the SERP landscape), the gap analysis, the outline (with its SEO and GEO check), section research and talking points, writing, the grammar, fact and contract checks, and a review of the whole draft. The writer decides which steps to follow in each piece, and Claude fast-forwards when told to. Claude runs the gap analysis and the checks itself, and saves the results in the same fields the web app uses, in the same shapes, so Writ shows them. They are advisory: none of them moves a stage. A section check is stamped with the section's text version, so the web app shows it as out of date once the text changes. The standard formats are switched on during onboarding. They come from `src/format-presets.ts`, which is **generated** from the Writ app's own presets (`node scripts/export-format-presets.mjs <path to the app repo>`). Each format keeps only what makes it that format: its brief fields (a case study's customer, a promotion's offer), a fixed outline's sections (carousels, threads, scripts, case study, webinar), the customer-approval check and its sign-off settings. The one step a fixed-outline format loses is the outline's AI thread, because the app's own rules say that needs a free outline. The script checks every recipe with the app's own validation. Run it again when the app's presets change.

## What works today, and what doesn't yet

- A piece can go from idea to a first draft in chat (`new_piece`), or you can start from a piece that already exists and draft a prepared section with `write_section`. Sign-off, review, the alignment and SEO checks, and publishing stay in the web app.
- Research Claude finds is saved as unreviewed, with quotes that are **not** checked against the pages (the web app's own search verifies them). The writer approves each item, and Writ's rules still apply. Saving research needs the `add_research_findings` migration applied in Writ.
- The `new_piece` walkthrough works in the Claude Code terminal. The Claude desktop app currently fails to run MCP prompts from local servers (a reported app bug), so use it there only once that is fixed.
- Saved drafts are marked as AI drafts, so sign-off still says the section started from one. The separate editorial-record event Writ writes for its own AI drafts (`section_ai_drafted`) is **not** written yet: clients can't insert those rows. Adding it means one small edge function in Writ.
- The password sits in the client's config file on the writer's machine. Fine for a trial with friends; a real release should use a browser sign-in (OAuth) instead.
- Local (stdio) only. A hosted version for Claude's web connector comes later.

## Develop

```bash
npm run build && npm test
```
