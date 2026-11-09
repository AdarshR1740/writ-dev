// Every prompt Writ sends to a model, with where it runs and what it receives, for the prompt editor in
// Settings. Built from the same constants the tasks run on, so it can't drift. Each editable piece is a
// "unit" with a key; the company's saved version (if any) is merged in. A unit's `locked` parts are added
// by Writ after the editable text and can't be changed, because code depends on their exact shape.

import { admin } from "../_shared/supabase.ts";
import { consolidateTemplate, CONTRACT_LITE, CONTRACT_SYSTEM, EXTRACT_SYSTEM } from "./prompts.ts";
import { WEB_LOOKUP_SYSTEM } from "./chat.ts";
import {
  ANALYSIS_FIX_SYSTEM,
  ANALYSIS_VERIFY_SYSTEM,
  DRAFT_HEADINGS_NOTE,
  DRAFT_LINKS_NOTE,
  DRAFT_POINTS_NOTE,
  REVISE_SYSTEM,
  OUTLINE_BUILD_SYSTEM,
  RESEARCH_GAP_RULES,
  SECTION_POINTS_SYSTEM,
  ANALYSIS_SYSTEM,
  BRIEF_SHORT,
  BRIEF_SYSTEM,
  CONTRACT_CHECK_SYSTEM,
  DRAFT_SYSTEM,
  FACT_SYSTEM,
  GRAMMAR_SYSTEM,
  LEARN_SYSTEM,
  OUTLINE_SYSTEM,
  REPURPOSE_BASE,
  REPURPOSE_SHAPES,
  SEO_FIX_FINAL,
  SEO_FIX_OUTLINE,
  SEO_VERIFY_SYSTEM,
  SEO_GEO_BASE,
  SEO_GEO_CHECKS,
  STRUCTURE_SYSTEM,
} from "./writing.ts";
import { ASK_SYSTEM, MEMORY_SYSTEM } from "./memory.ts";
import { EXTRACT_BASE, EXTRACT_QUOTED, SEARCH_BASE, SERP } from "../_shared/research-prompts.ts";
import { FINDING_FORMAT, QUOTED_FORMAT } from "../_shared/citations.ts";

interface Unit {
  /** The key the company's version is saved under. */
  key: string;
  label: string;
  /** Writ's built-in text. */
  text: string;
  /** Parts Writ adds after this text. Shown, not editable. */
  locked?: { label: string; text: string }[];
  /** What to know before editing, in a sentence. */
  hint?: string;
}

interface Entry {
  id: string;
  group: string;
  title: string;
  /** Where in the app this runs, in plain words. */
  when: string;
  /** Which model tier runs it (the company's provider picks the actual model). */
  tier: "extract" | "research" | "reason" | "write";
  /** The context blocks it receives, and nothing else. */
  receives: string[];
  units: Unit[];
}

export const ENTRIES: Entry[] = [
  {
    id: "consolidate",
    group: "House file",
    title: "Merge new material into a house-file document",
    when: "When you add material to the ICP, positioning, strategy notes, core voice or a format's style profile and press merge.",
    tier: "write",
    receives: ["The current document", "The new sources you added"],
    units: [
      { key: "consolidate.icp", label: "Ideal customer profile", text: consolidateTemplate("icp") },
      { key: "consolidate.positioning", label: "Positioning", text: consolidateTemplate("positioning") },
      { key: "consolidate.strategy_notes", label: "Strategy notes", text: consolidateTemplate("strategy_notes") },
      { key: "consolidate.core_voice", label: "Core voice", text: consolidateTemplate("core_voice") },
      {
        key: "consolidate.format_profile",
        label: "Format style profile (runs on the reasoning tier)",
        text: consolidateTemplate("format_profile"),
        hint: "{FORMAT} is replaced with the format's name and description.",
      },
    ],
  },
  {
    id: "extract_cards",
    group: "House file",
    title: "Pull insight cards out of a transcript",
    when: "On the Insights and Data pages, when you paste a transcript or notes to extract cards from.",
    tier: "extract",
    receives: ["The transcript", "Who, where and when, if you gave them"],
    units: [{ key: "extract_cards", label: "Prompt", text: EXTRACT_SYSTEM }],
  },
  {
    id: "contract_suggest",
    group: "Scope and research",
    title: "Suggest the scope",
    when: "On a piece's Scope step, in the conversation with the AI.",
    tier: "reason",
    receives: ["Brief", "Current scope", "Ideal customer profile", "Positioning", "Strategy notes", "The conversation"],
    units: [
      { key: "contract.base", label: "Prompt", text: CONTRACT_SYSTEM },
      { key: "chat.web", label: "Web lookup in the conversation (scope and outline)", text: WEB_LOOKUP_SYSTEM, hint: "Runs when \"Search the web\" is ticked or the writer asks for a search in words. Needs an Anthropic or OpenAI key." },
      { key: "contract.lite", label: "Added for short formats (short-format scope)", text: CONTRACT_LITE },
    ],
  },
  {
    id: "research_search",
    group: "Scope and research",
    title: "Search the web for research",
    when: "On the Research step (piece and section), when you press Search; on the Outline step, when the AI searches for a gap in the benchmark; and on the Writing step, for each section when you press Prepare sections.",
    tier: "research",
    receives: ["Brief", "Scope", "Ideal customer profile (piece research)", "Outline and section (section research)"],
    units: [
      {
        key: "research.search",
        label: "Prompt",
        text: SEARCH_BASE,
        hint: "{SEARCHES} becomes the format's search limit. {SERP} becomes the search-landscape step when the format switches it on.",
        locked: [
          { label: "Output format added by Writ (Anthropic)", text: FINDING_FORMAT },
          { label: "Output format added by Writ (OpenAI, whose quotes Writ checks itself)", text: QUOTED_FORMAT },
          {
            label: "Added to the request when it searches for a gap (Outline step)",
            text: "The request names the gap and asks for published material that fills it only, skipping what the approved research already says. It returns at most 3 findings, one per source, best first, and uses at most 3 searches. With OpenAI, only findings whose quote was found on the page are kept.",
          },
        ],
      },
      { key: "research.serp", label: "Search-landscape step (goes where {SERP} is)", text: SERP },
    ],
  },
  {
    id: "research_extract",
    group: "Scope and research",
    title: "Pull findings from a source you add",
    when: "On the Research step, when you add links or pasted text, or reuse a library source.",
    tier: "research",
    receives: ["Brief", "Scope", "Section (section research)", "The source text"],
    units: [
      {
        key: "research.extract",
        label: "Prompt",
        text: EXTRACT_BASE,
        locked: [{ label: "Output format added by Writ", text: FINDING_FORMAT }],
      },
      { key: "research.extract_quoted", label: "Providers without document citations", text: EXTRACT_QUOTED },
    ],
  },
  {
    id: "analysis",
    group: "Outline and writing",
    title: "Check the plan against the topic",
    when: "Before the outline, once piece research is approved.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved piece research"],
    units: [{
      key: "analysis",
      label: "Prompt",
      text: ANALYSIS_SYSTEM,
      locked: [{ label: "Added when a format switches parts off", text: "This format doesn't use: (the parts switched off). Return empty lists for those." }],
    }],
  },
  {
    id: "analysis_fix",
    group: "Outline and writing",
    title: "Propose fixes for the alignment check",
    when: "When you ask for fixes after the alignment check, before the outline is confirmed.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved piece research (statements only)", "The alignment check", "The outline so far"],
    units: [{
      key: "analysis_fix",
      label: "Prompt",
      text: ANALYSIS_FIX_SYSTEM,
      locked: [
        { label: "Added when \"Use AI to address these\" is ticked", text: RESEARCH_GAP_RULES.trim() },
        { label: "Added when a format has no scope", text: "This format has no scope: do not propose edit_point, remove_point or add_point." },
        { label: "Added when a format has no outline sections", text: "This format has no outline sections: do not propose add_section, and leave heading and purpose empty." },
      ],
    }],
  },
  {
    id: "analysis_verify",
    group: "Outline and writing",
    title: "Check whether the fixes closed what was found",
    when: "Right after you apply fixes from the alignment check, before the outline is confirmed.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved piece research (statements only)", "The outline so far", "The findings still open from the alignment check"],
    units: [{ key: "analysis_verify", label: "Prompt", text: ANALYSIS_VERIFY_SYSTEM }],
  },
  {
    id: "outline_build",
    group: "Outline and writing",
    title: "Create the outline from the scope and research",
    when: "On the Outline step, when you press Create outline after the benchmark. It is followed by \"Improve section structure\" below.",
    tier: "reason",
    receives: ["Brief", "Scope", "Analysis", "Approved piece research", "Format style profile"],
    units: [{ key: "outline_build", label: "Prompt", text: OUTLINE_BUILD_SYSTEM }],
  },
  {
    id: "outline_suggest",
    group: "Outline and writing",
    title: "Suggest the outline",
    when: "On the Outline step, in the conversation with the AI.",
    tier: "reason",
    receives: ["Brief", "Scope", "Analysis", "Approved piece research", "Format style profile", "The conversation"],
    units: [{ key: "outline", label: "Prompt", text: OUTLINE_SYSTEM }],
  },
  {
    id: "section_points",
    group: "Outline and writing",
    title: "Prepare a section: talking points",
    when: "On the Writing step, when you press Prepare sections. For each section in turn, after its web search.",
    tier: "reason",
    receives: ["Brief", "Scope", "The section, its sub-sections and the points it owes", "The outline", "What earlier sections cover", "Approved research for the piece and the section"],
    units: [{ key: "section_points", label: "Prompt", text: SECTION_POINTS_SYSTEM }],
  },
  {
    id: "section_brief",
    group: "Outline and writing",
    title: "Write a section brief (bullets)",
    when: "Once a section's research is approved, before you write it.",
    tier: "reason",
    receives: ["Section and the expectations it owes", "Outline", "Analysis", "Approved section research"],
    units: [
      { key: "brief.base", label: "Prompt", text: BRIEF_SYSTEM },
      { key: "brief.short", label: "Added for single-section formats (posts)", text: BRIEF_SHORT },
    ],
  },
  {
    id: "section_draft",
    group: "Outline and writing",
    title: "Draft a section with AI (optional)",
    when: "Only if you choose \"Write using AI\" once the sections are prepared, or \"Draft with AI\" on a section. Writing by hand is the default.",
    tier: "write",
    receives: ["Section", "Outline", "Approved research", "Core voice", "Format style profile", "Voice memory", "The talking points (or the brief)"],
    units: [{
      key: "draft",
      label: "Prompt",
      text: DRAFT_SYSTEM,
      locked: [
        { label: "Always added: headings (H3 and H4) inside the section", text: DRAFT_HEADINGS_NOTE },
        { label: "Always added: sources are linked in the text", text: DRAFT_LINKS_NOTE },
        { label: "Added when the section has talking points", text: DRAFT_POINTS_NOTE },
      ],
    }],
  },
  {
    id: "section_revise",
    group: "Outline and writing",
    title: "Revise a section from your feedback",
    when: "When you press Revise on a section and say what should change. It proposes small edits, limited to the whole section, one part of it or a passage you selected; you accept or ignore each.",
    tier: "write",
    receives: ["Section", "Outline", "Approved research", "Core voice", "Format style profile", "Voice memory", "The talking points (or the brief)", "Your feedback", "The section's text"],
    units: [{
      key: "revise",
      label: "Prompt",
      text: REVISE_SYSTEM,
      locked: [{ label: "Always added: sources are linked in the text", text: DRAFT_LINKS_NOTE }],
    }],
  },
  {
    id: "grammar_check",
    group: "Checks while writing",
    title: "Grammar check",
    when: "On the Writing step, when you run Grammar.",
    tier: "extract",
    receives: ["Your text only"],
    units: [{ key: "grammar", label: "Prompt", text: GRAMMAR_SYSTEM }],
  },
  {
    id: "fact_check",
    group: "Checks while writing",
    title: "Fact check against approved research",
    when: "On the Writing step, when you run Facts.",
    tier: "reason",
    receives: ["Approved research", "Your section text"],
    units: [{ key: "fact", label: "Prompt", text: FACT_SYSTEM }],
  },
  {
    id: "contract_check",
    group: "Checks while writing",
    title: "Check against the scope",
    when: "After each section, and as the final check before sign-off.",
    tier: "reason",
    receives: ["The expectations owed", "Your text"],
    units: [{ key: "contract_check", label: "Prompt", text: CONTRACT_CHECK_SYSTEM }],
  },
  {
    id: "seo_geo_check",
    group: "Checks while writing",
    title: "SEO and answer-engine (GEO) check",
    when: "On the outline and on the finished piece, where the format switches it on.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved search-landscape findings", "The outline or the full piece"],
    units: [
      {
        key: "seo.base",
        label: "Prompt",
        text: SEO_GEO_BASE,
        locked: [{ label: "Added when a format uses only one of SEO or GEO", text: "This format only uses the SEO (or GEO) checks: return only those." }],
      },
      { key: "seo.outline", label: "Checks for an outline", text: SEO_GEO_CHECKS.outline, hint: "Keep each check's key (the word before the colon); the page shows results by it." },
      { key: "seo.final", label: "Checks for the finished piece", text: SEO_GEO_CHECKS.final, hint: "Keep each check's key (the word before the colon), and the meta title and description lines." },
    ],
  },
  {
    id: "outline_structure",
    group: "Outline and writing",
    title: "Improve section structure",
    when: "On the Outline step, when you press Improve structure, and right after Create outline. It plans what goes under each heading; the writer edits it.",
    tier: "reason",
    receives: ["Brief", "Scope", "Analysis", "Approved piece research", "Format style profile", "Approved search-landscape findings", "The outline"],
    units: [{
      key: "structure",
      label: "Prompt",
      text: STRUCTURE_SYSTEM,
      locked: [{
        label: "Added when only some sections need sub-sections (Define sub-sections)",
        text: "SOME SECTIONS ARE ALREADY PLANNED\nPlan only the sections marked [PLAN THIS ONE]. Sections marked [already planned] stay as they are: use them to avoid repeating the same shape, and return no entry for them.",
      }],
    }],
  },
  {
    id: "seo_fix",
    group: "Checks while writing",
    title: "Fix SEO and GEO gaps with AI",
    when: "After an SEO/GEO check finds things to improve. On the outline it makes small changes to the plan (edit, add or move sections, edit or add blocks; it never deletes); on the finished piece it proposes small edits you accept one by one.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved search-landscape findings", "The gaps the check found", "The outline or the finished piece"],
    units: [
      { key: "seo_fix.outline", label: "Prompt for the outline", text: SEO_FIX_OUTLINE },
      { key: "seo_fix.final", label: "Prompt for the finished piece", text: SEO_FIX_FINAL },
    ],
  },
  {
    id: "seo_geo_verify",
    group: "Checks while writing",
    title: "Check whether an outline fix closed the flagged issues",
    when: "Right after Fix it on the outline's SEO and GEO checks, and after Create outline fixes what the checks found. It looks only at the issues that were flagged.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved search-landscape findings", "The outline", "The issues the check flagged"],
    units: [{ key: "seo.verify", label: "Prompt", text: SEO_VERIFY_SYSTEM }],
  },
  {
    id: "learn_voice",
    group: "After the piece",
    title: "Learn voice rules from the piece",
    when: "On sign-off, when you press Learn from this piece.",
    tier: "reason",
    receives: ["Core voice", "Voice memory", "AI drafts vs. what you kept", "Assembled vs. published version", "Your messages"],
    units: [{ key: "learn", label: "Prompt", text: LEARN_SYSTEM }],
  },
  {
    id: "repurpose_plan",
    group: "After the piece",
    title: "Plan a repurpose (split, adapt or combine)",
    when: "When you repurpose finished pieces into another format.",
    tier: "reason",
    receives: ["Source pieces and their approved research", "Target format and its style profile", "Your specific requirements"],
    units: [
      { key: "repurpose.base", label: "Prompt", text: REPURPOSE_BASE },
      { key: "repurpose.split", label: "Split", text: REPURPOSE_SHAPES.split },
      { key: "repurpose.adapt", label: "Adapt", text: REPURPOSE_SHAPES.adapt },
      { key: "repurpose.combine", label: "Combine", text: REPURPOSE_SHAPES.combine },
    ],
  },
  {
    id: "ask",
    group: "Memory",
    title: "Ask Writ",
    when: "In the Ask Writ panel.",
    tier: "reason",
    receives: ["Numbered passages found in your own material", "Your earlier questions", "Your question"],
    units: [{ key: "ask", label: "Prompt", text: ASK_SYSTEM, hint: "Writ keeps only citations that point at a real passage, whatever the prompt says." }],
  },
  {
    id: "memory_check",
    group: "Memory",
    title: "Check against what you've published",
    when: "On the sign-off page.",
    tier: "reason",
    receives: ["Numbered passages from earlier finished pieces and their research", "The new piece"],
    units: [{ key: "memory_check", label: "Prompt", text: MEMORY_SYSTEM }],
  },
];

/** The catalog for one company: each unit carries the company's saved version, if it has one. */
export async function promptCatalog(companyId: string) {
  const { data } = await admin.from("prompt_overrides").select("prompt_key, text, updated_at").eq("company_id", companyId);
  const mine = new Map((data ?? []).map((r) => [r.prompt_key as string, r]));
  return ENTRIES.map((e) => ({
    ...e,
    units: e.units.map((u) => {
      const o = mine.get(u.key);
      return { ...u, override: (o?.text as string | undefined) ?? null, updated_at: (o?.updated_at as string | undefined) ?? null };
    }),
  }));
}
