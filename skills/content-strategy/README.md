# content-strategy (template)

A templatized copy of a personal content-strategy skill, made reusable for any Writ company. It is a plan-and-draft
workflow: positioning, pillars, idea backlog, channel roles, repurposing, calendar and review. It never publishes.

## What changed from the personal version

| Personal version | Template |
|---|---|
| Hard-coded to one person and a private notes folder | Placeholders (`{{subject}}`, `{{icp}}`, `{{positioning}}`, `{{voice}}`, `{{proof}}`, `{{story_bank}}`, `{{off_limits}}`, `{{channels}}`, `{{hours_per_week}}`, `{{goal}}`) filled from the Writ house file |
| Named skill gaps and personal off-limits baked into guardrails | A confirmed `{{off_limits}}` list, stored in the strategy notes |
| Handoffs to personal skills (voice, AI-tell checker, outreach, research) | Writ's own steps: format profiles, grammar and fact checks, the research review gate, Repurpose, the editorial record |
| Weighted 0 to 10 scores for ideas, a 0 to 40 rubric for cuts | Plain ranking with a reason, and a four-question check in words. Writ does not score content (see `docs/decisions.md` section 13) |
| Fixed channels and a job-search goal | Channels and goal come from the company's formats and brief |

## Where it connects to Writ (no schema change needed for a first version)

- Positioning, ICP, core voice: house file documents.
- Off-limits list: the strategy notes document.
- Story bank and proof: insight cards (story, opinion, lesson, data point) and data cards, with public or internal
  citation level.
- Each idea that gets written: a normal piece in the right format, so it passes the contract, research review and
  sign-off.
- Atomization: Repurpose (split, adapt, combine).

## Later options

1. **Prompt in the catalog.** Add a "Content strategy" prompt to `supabase/functions/ai/catalog.ts`, so editors can see
   and override it per company on the Prompts page (`prompt_overrides`).
2. **Claude skill via the MCP server.** Add a prompt next to `new_piece` and `onboarding`. This is additive, so it does
   not break `mcp-server/COMPATIBILITY.md`.
3. **A strategy document kind.** If strategies should be stored per company, add a new migration (never edit an applied
   one) with a new `context_documents` kind. Not needed until the template is proven.
