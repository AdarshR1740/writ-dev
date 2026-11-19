---
name: content-strategy
description: Build and run a cross-channel content strategy for one named expert or one company, from the company's own Writ house file. Use whenever someone asks what to publish, wants pillars, positioning, a weekly or monthly calendar, an idea backlog, a repurposing plan across channels, or a review of what is working. Plans and drafts only. Never publishes.
---

# Content strategy (Writ template)

Template version of a personal-brand strategy skill. Everything specific to one person is a `{{placeholder}}` filled from
the company's Writ house file. Nothing here is hard-coded to a person, a channel list or a goal.

## Where the inputs come from

Read these first and do not ask the user for what is already there.

| Placeholder | Meaning | Writ source |
|---|---|---|
| `{{subject}}` | The expert or company the strategy is for | Company name, or a named leader voice |
| `{{goal}}` | The one job the content has (authority for outreach, inbound leads, hiring, product launch) | Strategy notes; ask if missing |
| `{{icp}}` | Who the content is for | House file: ICP |
| `{{positioning}}` | What the subject stands for | House file: Positioning |
| `{{voice}}` | How the subject writes | House file: Core voice, plus the format profile for each channel |
| `{{proof}}` | Real work and numbers that can be cited | Data cards, and insight cards of type data point or customer quote |
| `{{story_bank}}` | Stories, turning points, scars, positions | Insight cards of type story, opinion, lesson, technical detail |
| `{{off_limits}}` | Claims and topics never to make | Strategy notes (see `references/foundation.md`, section 4) |
| `{{channels}}` | Channels in scope | Brief, or the company's formats (LinkedIn post, X thread, carousel, video script, newsletter) |
| `{{hours_per_week}}` | Capacity | Ask. Never skip this. |
| `{{current_priorities}}` | This month's priorities | Ask |

Cards marked *internal* shape the argument but are never named or quoted in a public draft. Cards marked *public* can be
quoted and attributed.

## Why the rules below exist

- **Proof beats opinion.** Content that shows real work earns trust. Generic takes do not.
- **One idea, many cuts.** One person cannot feed every channel with fresh ideas. Pick a home channel; the rest carry
  rewritten cuts of the same ideas.
- **Nothing is invented.** A made-up number is a retraction later. If a fact is missing, ask or leave it blank and
  mark it *needs input*.
- **The expert writes and decides.** The skill plans and drafts. A named person approves and publishes.
- **No score.** Judge an idea by what it must do for the reader and for `{{goal}}`, using specific, testable
  questions, never a single number that stands for "quality".

## Workflow

Run the stages in order for a full strategy. For a narrow request ("plan this week", "turn this into posts"), jump to
the stage that fits and keep the guardrails.

| Stage | Output | Read |
|---|---|---|
| 1. Foundation | Positioning line, 3 to 4 pillars, off-limits list, proof inventory, story bank | `references/foundation.md` |
| 2. Ideas | Ranked backlog from a pillars by formats matrix | `references/ideation.md` |
| 3. Channels | Role, cadence and format per channel, sized to `{{hours_per_week}}` | `references/channels.md` |
| 4. Atomization | One idea turned into native cuts per channel | `references/atomization.md` |
| 5. Calendar and measurement | Batch schedule, status ladder, weekly review | `references/calendar-metrics.md` |

Read a reference only when you reach its stage.

### Intake (stage 0)

Gather, skipping what the house file answers: `{{hours_per_week}}`, which `{{channels}}` will actually be kept up,
current profile state, proof the subject can point to, and `{{current_priorities}}`. Capacity decides everything
downstream.

Ask **one question at a time**, with numbered options and a recommendation when options exist. Mark any gap you fill
yourself *(assumed, confirm)*.

## Output format

For a full strategy, save one markdown file with a new, dated filename (never overwrite an existing plan):

1. Goal and assumptions
2. Positioning line and off-limits list
3. Pillars (share of content, what each proves)
4. Channel roles and cadence
5. Top 10 ideas, with the reasoning behind each ranking
6. Four-week calendar (date, channel, pillar, format, hook, source, status)
7. Measurement plan
8. Open questions

Tables for decisions, no filler, plain language.

## Guardrails

- Never publish, schedule or send. Draft and hand over.
- Never claim anything on `{{off_limits}}`. If a draft implies it, remove it and say why.
- Facts and numbers come only from `{{proof}}`, `{{story_bank}}` or approved research. Each one should trace to a card
  or source. No unsourced statistics.
- Disclose ghostwritten bylines and AI-generated media as each platform currently requires. Check the platform's
  current policy before advising; rules change.
- Platform tactics (posting times, algorithm claims, character limits) are unverified starting points. Say so and test
  them against the subject's own results.
- No client, customer or colleague names unless a public card or the subject says they may appear.
- Give an honest assessment once, then execute the user's decision. Do not repeat caveats.
- A durable decision (positioning line, pillar choice, new off-limits item) is suggested as a one-line save to the
  house file at the end of the turn. Write nothing until the user approves.

## How this maps to Writ

- Drafting a post is a normal Writ piece in that channel's format. It gets its own reader contract, research review,
  and sign-off, so the strategy never bypasses the review gates.
- Atomization is Writ's **Repurpose**: Split (one idea to several posts), Adapt (new medium), Combine (several posts
  to one guide).
- The writer writes the words. Use the section brief and the format profile; do not write posts for them unless they
  ask for an AI draft.
- Trend and competitor research goes through Writ's research step so every item is reviewed.
