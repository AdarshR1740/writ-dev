# Design Critique: Writ

Scope: every screen of the web app (`web/`), checked against 34 renders with mocked data:
- desktop at 1440px, mobile at 390px, and dark mode;
- every piece stage, the workflow editor, modals, auth and keyboard focus.

Stage: first full build, before real users. The feedback is aimed at refinement, not exploration.

Contrast ratios were computed from the tokens in `web/src/styles/app.css`.

**Status: all fixes below are applied** (see "Applied" at the end). Mock-data artifacts are not reported as bugs, for example "By on Jan 1, 1970" on the sign-off card.

---

### Overall Impression

The app looks like an editor's desk, not a SaaS dashboard, which is right for "expert-owned, AI-assisted":
- calm paper-and-ink palette;
- serif document text against a sans-serif UI;
- quoted source passages shown next to every claim.

The biggest opportunity is **density and signal**:
- Long pages stack notices, explanations and check panels top to bottom.
- Secondary text is set in a grey that fails contrast.

So the important thing on each screen (the next action, or the flag that needs attention) doesn't always stand out.

---

### Usability

| Finding | Severity | Recommendation |
|---|---|---|
| History is a six-column table that overflows on mobile. The "Came from / made into" column is cut off mid-word, and the IDs wrap ("NL-" / "0001"). | 🔴 Critical | Below 720px, render each piece as a card: ID and title, then format and stage, then version chips, then lineage. Keep the table for desktop. |
| On the Writing stage, the Grammar / Facts / Reader contract checks sit **below** a tall editor. A writer only sees the fact mismatch ("approved item says 23%, not 30%") after scrolling past the text it refers to. | 🔴 Critical | Move the checks into the right rail under the brief as collapsible panels, or add a sticky "3 flags" count to the editor header that jumps to them. Flags should sit beside the text they question. |
| The sign-off preview shows raw Markdown (`#`, `##`). When the section heading matches the title, the heading appears twice. | 🟡 Moderate | Render the preview as formatted text with the Markdown export behind "Copy as Markdown". Skip the H2 when the piece has a single section with the same heading as the title. |
| Up to three notices can stack above the stage tabs before any work appears: review due, the lineage row, and "source updated". Origin notes can add more on repurposed pieces. On mobile this pushes the stage content below the first screen. | 🟡 Moderate | Merge them into one "About this version" strip that collapses to a single line, for example "v2 · review due · split into 2". Show the full banner only for "review due" and "source updated". |
| Disabled primary buttons ("Run check", "Save workflow", "Start piece") use 50% opacity and give no reason. "Save workflow" looks broken when nothing has changed. | 🟡 Moderate | Show a one-line reason next to the button ("No changes yet", "Write every section first"). Give disabled primaries a neutral grey fill, not a faded blue. |
| The workflow editor shows 9 module boxes and about 30 checkboxes at equal weight. It's hard to see what a preset changed, or which switches matter. | 🟡 Moderate | Mark modules that differ from the base preset ("changed" tag, or a dot on the legend). Collapse switched-off modules to their title row. The "Max searches" number field also sits outside the checkbox grid; align it as an indented sub-control. |
| The sidebar status dots (filled green, blue, hollow) carry meaning (done / changes to review / not started), but nothing explains them, and "Voice memory" has no dot, so it looks misaligned. | 🟡 Moderate | Add a `title`/`aria-label` on each dot ("Done", "Changes to review"). Give Voice memory an indent so its alignment looks intentional, or a neutral dot. |
| On mobile, the stage tabs wrap onto two rows (3 + 2), so "Outline" looks like the start of a second group. | 🟢 Minor | Make the tab row scroll sideways on narrow screens with the current tab kept in view, or show a compact "Stage 5 of 5: Sign-off ▾" picker. |
| The New piece modal has both "Close" in the header and "Cancel" in the footer. | 🟢 Minor | Keep one: an × icon button with `aria-label="Close"`, and drop the duplicate. |
| On mobile, the sign-off rail drops below the full piece, so the "Signed off" state and the export actions are last on the page. | 🟢 Minor | On narrow screens, put the sign-off status card first, above the preview. |

---

### Visual Hierarchy

- **What draws the eye first:** the serif page title, then the amber "review due" banner.
  - On the piece page the banner wins, ahead of the stage tabs and the work itself. That's right when a review is overdue and wrong otherwise. The quiet variant (`notice quiet`) for "next review…" is good; keep amber for overdue only.
  - On the Pieces list, the house-file warning outranks "Start a piece". That's acceptable while setup is incomplete.
- **Reading flow:**
  - Desktop piece pages read top to bottom:
    - title
    - notices
    - stage tabs
    - main column, with a right rail for the brief, research and sign-off
  - The rail works well on Writing: brief, numbered approved research, source links.
  - The flow breaks below the editor, where three full-width check cards repeat the same layout (title, explanation, button, results). The eye has nothing to anchor on.
- **Emphasis:**
  - Correctly emphasised: the research cards. The statement is in bold serif, the quoted passage is in an italic sunken block, and the source is on the meta line. The fact-mismatch flag (amber, quoted text, the specific reason) is the best-designed element in the app.
  - Over-emphasised:
    - Uppercase monospace eyebrows ("NORTHWIND LOGISTICS", "SECTION 1", rail headings) and mono tags appear on nearly every block, so they stop signalling anything.
    - Mono brief bullets read as code, not notes.
  - Under-emphasised: the house-file Overview status words ("Done", "Not started", "Changes to review") are right-aligned in faint grey. "Changes to review" is an action and should look like one.
- **Whitespace:** generous and consistent on list pages. Explanatory ledes run to 2–3 lines on almost every page; once a user knows the app, these are noise above the fold. Cap them at one line and move the rest behind a "How this works" disclosure.

---

### Consistency

| Element | Issue | Recommendation |
|---|---|---|
| Monospace | Used for IDs (good), but also for eyebrows, tags, brief bullets, keywords in piece meta, and verdict chips (`partly`, `met`). | Keep mono for IDs, versions and citation numbers `[1]` only. Set brief bullets in the UI sans, and tags in sans at 12px/600. |
| Button sizes | Rail buttons are stretched to full width ("Copy summary", "Export audit trail") while the same-weight "Suggest voice rules" button is content-width; header buttons are 34px and "Still accurate" is 28px. | One rule: rail actions are content-width and left-aligned. Use `.btn-small` only inside dense rows such as tables and notices. |
| Card titles | Check cards mix a serif H2 ("Final check against the reader contract", "Search & answer engines") with a sans-bold inline title ("Grammar", "Facts", "Reader contract"). | Use one card-header pattern: sans 600 15px title, with the explanation inline in muted text, as on Writing. |
| Status colour | Green numbered circles on the stage tabs mean "reachable/done", green tags mean "approved" or "this version", and blue "pencil" tags mean "linked piece" or "current version" (History). The same blue also marks the active nav dot ("changes to review"). | Write down the mapping: green = done/approved, amber = needs attention, pencil blue = link/interactive only. Recolour the "changes to review" dot amber. |
| Notices | Amber left-border notices are used for "review due" (an action), "write every section first" (a blocker) and "house file isn't finished" (advice). | Keep amber for action needed. Use a neutral sunken notice for advice and blockers that explain a disabled button. |
| Version chips | On the piece page the current version is a green "v2 (this)"; in History the current version is a blue "v2". | Use the same treatment in both: current = outlined ink chip, older = plain. |

---

### Accessibility

**Colour contrast** (WCAG AA: 4.5:1 for body text, 3:1 for UI component boundaries)

| Token pair | Ratio | Result |
|---|---|---|
| `--faint` #8a93a2 on white | 3.10 | ❌ Fails for text. It's used for word counts, "updated…", hints, sidebar counts and overview statuses (15 uses) |
| `--faint` on paper #f5f6f8 | 2.87 | ❌ Fails |
| `--muted` #5e6878 on white / paper | 5.63 / 5.21 | ✅ |
| `--pencil` #2f4bd8 (links) on white; white on pencil (primary button) | 6.73 | ✅ |
| flag #94570a on #fbf0dc | 5.13 | ✅ |
| ins / del text on their tints | 6.89 / 6.24 | ✅ |
| danger #a3321f on white | 6.92 | ✅ |
| `--rule-strong` #c6cdd6 input border on white | 1.60 | ❌ Fails 1.4.11 (non-text contrast 3:1); text fields barely show against white cards |
| Dark `--faint` #737d8d on surface / paper | 3.97 / 4.36 | ❌ Fails for small text |
| Dark `--muted`, dark pencil | 6.97 / 7.14 | ✅ |

Fix:
- Darken `--faint` to about #6b7483 (≈4.6:1 on paper) and the dark-mode faint to about #8b95a5.
- Give inputs their own border token, about #8d96a5 (≥3:1).
- The 50%-opacity disabled state also drops text below 3:1. Acceptable under WCAG for disabled controls, but pair it with the visible reason (see Usability).

**Touch targets**
- `.btn` is 34px tall, `.btn-small` 28px, the tabs are about 32px, and the version and lineage chips are about 20px links. All are below 44×44 on mobile.
- Add `@media (pointer: coarse)` to raise buttons and tabs to 44px minimum height, and pad chip links to a 44px hit area.
- Radio buttons and checkboxes in forms are native size (about 13px); wrapping labels make them clickable, which helps.

**Text readability**
- Document text (16px Source Serif, line-height 1.65) and research statements read well.
- Nine rules set text at 12px and one at 11.5px (eyebrows, tags, meta lines); none go below that. *(Corrected: an earlier draft said 10px, which was a grep for padding values.)*
- Long uppercase mono strings ("SECONDARY: TRACE IT TO THE ORIGINAL") are slow to read. Use sentence-case sans.

**Other**
- Keyboard focus is visible: 2px pencil outline on inputs and buttons. ✅
- The stage tabs use `aria-selected`. ✅
- The status dots and the Overview status icons (✓, !, ○) need text alternatives for screen readers.
- The editor textarea in `.doc-surface` removes the focus outline (`outline: none`). Show focus on the surrounding card instead (`:focus-within`).

---

### What Works Well

- **The research card** shows the claim, the verbatim quoted passage, and the source with date and source type. It makes the "AI found it, you approve it" model obvious without any explanation, and is the product's clearest expression of its promise.
- **The fact-mismatch flag** quotes the writer's sentence, names the conflict ("23%, not 30%") and points to item [1]. It's specific and actionable, and there's no score.
- **Writing layout:** the editor sits beside the brief and the numbered approved research, so writers write from evidence without leaving the page.
- **Typography split:** serif for the reader-facing text and sans for the tool chrome keeps "my writing" visually distinct from "the app".
- **Honest copy:**
  - "AI found these; it can't vouch for them"
  - "Never rewrites your sentences"
  - "Rather have AI draft it? (not recommended)"
  - "A checklist with fixes, not a score"

  These lines carry the product's stance consistently.
- **Dark mode:** a real palette rather than an inversion. The tints stay distinguishable and the amber notices keep their meaning.
- **House file overview:** a clear checklist with a status for each part. It doubles as onboarding.

---

### Priority Recommendations

1. **Fix contrast tokens:** `--faint`, the input border, and dark-mode faint.
   - Three token changes in `app.css` lift every caption, hint, count and form field to AA.
   - Cheapest change, widest effect.
2. **Bring check results next to the writing.**
   - Move the Grammar / Facts / Contract panels into the Writing rail, or add a sticky flag count in the editor header.
   - Flags are the product's core value, and today they sit below the fold.
3. **Make History and the stage tabs work on mobile.**
   - History becomes cards below 720px; the stage tabs scroll sideways or become a picker.
   - Raise touch targets to 44px under `pointer: coarse`.
4. **Pull back on monospace and uppercase.**
   - Keep mono for IDs and citation numbers only.
   - Tags, brief bullets and verdicts move to the sans font.
   - Emphasis then means something again.
5. **Calm the piece header.**
   - Merge versions, lineage and next-review into one collapsible strip.
   - Keep amber banners for overdue reviews and updated sources.
   - Cut page ledes to one line.
6. **Explain disabled actions.**
   - Every disabled primary gets a one-line reason next to it.
   - Disabled styling becomes neutral grey instead of faded blue.

---

### Applied

Re-rendered all 34 screens afterwards (desktop, phone width, dark mode); no page errors.

| Recommendation | What changed |
|---|---|
| Contrast tokens | `--faint` #8a93a2 → #636c7b (4.5:1+ on paper, 4.9:1 on white). Dark faint → #8b95a5 (5.5:1). New `--field-border` #848c9b (3.4:1) / dark #636d7d (3.2:1) for inputs, selects and textareas. |
| Checks next to the writing | The editor header shows an amber "N to look at ↓" count (grammar fixes, fact flags, unmet contract items) that jumps to the checks. |
| Mobile | History rows become labelled cards under 720px; IDs never wrap. Stage tabs scroll sideways and keep the current stage in view. Buttons, tabs and stages are 44px on touch screens; chip links get a 44px hit area. A signed-off piece shows the sign-off rail first on narrow screens. |
| Type | **Geist** (as on jobdeck) for the app and headings, with tight heading tracking; **Geist Mono** for IDs, versions and citation numbers only; **Source Serif 4** kept for the writing itself (documents, research claims, quotes, the sign-off preview). Eyebrows, tags, table headers, brief bullets, keywords and verdict chips moved off monospace and uppercase. |
| Piece header | The next review date moved into the meta line. The amber banner shows only when a review is overdue. Repurposing notes collapse into a "Notes from repurposing" strip, open during contract and research. |
| Page intros | New `Lede` component: one line, with the rest behind "How this works" (10 pages). |
| Disabled actions | Neutral grey disabled style. `AiAction` takes a `reason` shown beside the button; reasons were added to final check, SEO/GEO, grammar/facts/contract checks, brief, research, outline/contract threads, insight extraction, sign-off, research continue, Start piece and Save workflow ("No changes yet"). |
| Sign-off preview | Rendered as formatted text (title, subheads, paragraphs, lists) with no HTML injection. A single section headed like the title is not repeated. Markdown stays behind "Copy as Markdown". |
| Workflow editor | Modules that differ from their base show a "changed" tag. Switched-off modules (contract, analysis, outline) sit on a grey background at their natural height. Sub-settings are indented, and "Max searches" is aligned. |
| Sidebar | The dots have titles, and amber now means "to review". A small legend sits under the house-file group. Voice memory is indented as a child of Core voice. |
| Consistency | One check-card header pattern (bold title + inline muted line) across Writing, Final check and SEO/GEO. Rail buttons are content-width. Version chips match everywhere: current = outlined ink, older = blue link. Advice and blockers use a neutral notice; amber is for action needed only. Overview statuses: "Changes to review" is an amber tag and "Done" is green. |
| Modal | The header "Close" text became an × icon button (`aria-label="Close"`). The duplicate Cancel in the New piece modal was removed. |
| Focus | The writing card shows a focus ring (`:focus-within`), since the textarea inside it has none. |
