/**
 * What each tool and prompt does, in plain words for a person (the descriptions Claude reads are written for Claude).
 * Parameters come from the tools themselves, so they can't go stale. This file is the only part written by hand, and a test
 * fails when a tool or prompt exists without an entry here, so the reference stays complete as the server grows.
 *
 * `npm run docs:update` regenerates docs/TOOLS.md and the page in the Writ app ("Writ in Claude") from the live server.
 */

/** reads: changes nothing. saves: writes data the writer can still edit. creates: makes something new. moves the piece on: ends a step. */
export type Effect = "reads" | "saves" | "creates" | "moves the piece on";

export interface ToolDoc {
  group: string;
  /** One sentence: what it does. */
  summary: string;
  /** When Claude uses it. */
  when: string;
  effect: Effect;
}

/** The order the groups are shown in: the order of the work. */
export const GROUPS = [
  "Look things up",
  "Set up the company",
  "Start a piece and its scope",
  "Research",
  "Gap analysis (benchmark)",
  "Outline",
  "Sections",
  "Final checks",
] as const;

export const TOOL_DOCS: Record<string, ToolDoc> = {
  // --- Look things up
  writ_list_pieces: { group: "Look things up", effect: "reads", summary: "Lists your pieces with their code, title and stage, most recently updated first.", when: "At the start of a chat, or when you name a piece." },
  writ_get_piece: { group: "Look things up", effect: "reads", summary: "A piece's brief, its scope, and its outline with each section's id, level, status and word count.", when: "Before working on a piece, and after changing it, to see where it stands." },
  writ_get_section: { group: "Look things up", effect: "reads", summary: "Everything needed to write one section: its purpose, the outline around it, the talking points with evidence, the approved research with links, and the current text.", when: "Before drafting or checking a section." },
  writ_get_voice: { group: "Look things up", effect: "reads", summary: "How the company writes: core voice, the format's style profile, audience, positioning and the rules learned from past edits.", when: "Before drafting, so the text sounds like the company." },
  writ_get_setup: { group: "Look things up", effect: "reads", summary: "Where you stand: your companies, their formats, how much of the house file is filled in, and how many pieces each has.", when: "At the start of onboarding or a new piece." },
  writ_get_context_documents: { group: "Look things up", effect: "reads", summary: "The text of the house-file documents: ideal customer, core voice, positioning and strategy notes.", when: "To read or improve the house file." },
  writ_get_research: { group: "Look things up", effect: "reads", summary: "A piece's (or one section's) research items with their status, sources and whether the quote was checked.", when: "When reviewing or reusing research." },
  writ_get_check_input: { group: "Look things up", effect: "reads", summary: "Everything one check needs, numbered the way the save tools expect: the gap analysis, the outline's SEO/GEO check, a section's checks, or the final checks.", when: "Right before running a check." },
  writ_check_piece: { group: "Look things up", effect: "reads", summary: "A health check: what you will see on each step of the piece in Writ right now, and anything that looks wrong or stuck.", when: "After saving an outline, reopening something or finishing a step. Claude tells you about every problem it reports." },

  // --- Set up the company
  writ_create_company: { group: "Set up the company", effect: "creates", summary: "Creates your company in Writ and makes you its editor. A company can't be deleted from here, so the name is confirmed first.", when: "During onboarding, after you approve the name." },
  writ_add_formats: { group: "Set up the company", effect: "saves", summary: "Switches on Writ's standard formats (blog, LinkedIn, case study, carousels, scripts, newsletter and more). Formats you already have are skipped.", when: "During onboarding, with the company." },
  writ_save_context_document: { group: "Set up the company", effect: "saves", summary: "Saves one house-file document (ideal customer, core voice, positioning, strategy notes). It will not replace existing text unless you agreed.", when: "When you approve a house-file document drafted in chat." },

  // --- Start a piece and its scope
  writ_start_piece: { group: "Start a piece and its scope", effect: "creates", summary: "Creates a new piece from the brief; Writ assigns its code.", when: "After you confirm the brief." },
  writ_save_scope: { group: "Start a piece and its scope", effect: "saves", summary: "Saves the scope draft: the one question the piece answers and the points it should include. Works only while the scope step is open.", when: "When you have agreed the scope in chat." },
  writ_confirm_scope: { group: "Start a piece and its scope", effect: "moves the piece on", summary: "Confirms the scope, which moves the piece on to research.", when: "Only after you approve the scope." },

  // --- Research
  writ_add_research: { group: "Research", effect: "saves", summary: "Saves findings Claude found as unreviewed research items with their sources. Quotes are not checked against the pages.", when: "After searching the web for the piece or for one section." },
  writ_review_research: { group: "Research", effect: "saves", summary: "Records your approve or reject decision on each research item.", when: "When you have reviewed the findings." },
  writ_complete_research: { group: "Research", effect: "moves the piece on", summary: "Finishes the research step, which moves the piece on to the outline.", when: "Only after you approve." },

  // --- Gap analysis (benchmark)
  writ_save_analysis: { group: "Gap analysis (benchmark)", effect: "saves", summary: "Saves the gap analysis: whether the scope and research still match the topic, the gaps, and suggestions for the scope. Refused, with a clear message, while the writer is editing it in Writ.", when: "After Claude runs the analysis." },
  writ_mark_findings: { group: "Gap analysis (benchmark)", effect: "saves", summary: "Records your decisions on the analysis findings: ignored, resolved or open again. Refused, with a clear message, while the writer is editing it in Writ.", when: "When you go through the findings." },
  writ_apply_alignment_fixes: { group: "Gap analysis (benchmark)", effect: "saves", summary: "Applies the fixes you chose: reject research, edit, remove or add scope points, and add sections. Works only while the outline is open, and Writ can undo the fixes afterwards. Refused, with a clear message, while the writer is editing it in Writ.", when: "After you pick which fixes to apply." },
  writ_add_expert_answer: { group: "Gap analysis (benchmark)", effect: "saves", summary: "Saves your own answer to a gap's expert question as an insight card and approved research. Refused, with a clear message, while the writer is editing it in Writ.", when: "When you answer a question only you can answer." },

  // --- Outline
  writ_save_outline: { group: "Outline", effect: "saves", summary: "Saves the outline: sections in order, each with a heading, a one-line purpose and the scope points it serves, and (for free outlines) sub-headings. Sections you keep keep their text and research. Refused, with a clear message, while the writer is editing it in Writ.", when: "When you have agreed the outline." },
  writ_confirm_outline: { group: "Outline", effect: "moves the piece on", summary: "Confirms the outline, which moves the piece on to writing. Refused, with a clear message, while the writer is editing it in Writ.", when: "Only after you approve the outline." },
  writ_save_outline_checks: { group: "Outline", effect: "saves", summary: "Saves the outline's SEO and GEO check results.", when: "After Claude checks the outline." },

  // --- Sections
  writ_use_research: { group: "Sections", effect: "saves", summary: "Copies approved piece research into a section so its talking points can cite it.", when: "Before preparing a section." },
  writ_save_section_points: { group: "Sections", effect: "saves", summary: "Saves a section's talking points, then has Writ finish the section's research step and confirm its brief. That moves the section to writing, so it is ready to draft. Refused, with a clear message, while the writer is editing it in Writ.", when: "When the points for a section are agreed." },
  writ_save_section_draft: { group: "Sections", effect: "saves", summary: "Saves a drafted section as an AI draft for you to review in Writ. It becomes the section's text only if you have written none (or the text is still exactly the previous AI draft, untouched), and never overwrites text you wrote. Refused, with a clear message, while the writer is editing it in Writ.", when: "After Claude drafts a section." },
  writ_save_section_checks: { group: "Sections", effect: "saves", summary: "Saves a section's grammar, fact and scope check results, stamped with the text version they were run on.", when: "After Claude checks a section." },

  // --- Final checks
  writ_save_final_checks: { group: "Final checks", effect: "saves", summary: "Saves the final scope check and the final SEO/GEO check for the whole piece, with the meta title and description.", when: "After the last section, before your review." },
};

export interface PromptDoc {
  /** How you start it in Claude. */
  command: string;
  summary: string;
  how: string;
}

export const PROMPT_DOCS: Record<string, PromptDoc> = {
  new_piece: {
    command: "/writ:new_piece",
    summary: "Takes a piece from idea to a first draft: the brief, scope, research, outline, then each section's talking points and draft.",
    how: "Claude asks for your feedback at every step and only confirms a step when you approve. There is no sign-off in chat: the draft stays in Writ for your review.",
  },
  onboarding: {
    command: "/writ:onboarding",
    summary: "A guide to what you can do with Writ in Claude, then a walk through creating your company and building your house file.",
    how: "Start here if you're new. It checks where you stand and takes you through what is left, saving each document only when you approve it.",
  },
  write_section: {
    command: "/writ:write_section",
    summary: "Drafts one prepared section from its talking points and approved research, in the company's voice, and saves it to Writ.",
    how: "Give it the piece code and the section id. It follows Writ's drafting rules: approved research only, sources linked in line, headings that organise the section.",
  },
};
