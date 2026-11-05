// Every prompt Writ sends to a model, with where it runs and what it receives, for the prompt editor in
// Settings. Built from the same constants the tasks run on, so it can't drift. Each editable piece is a
// "unit" with a key; the company's saved version (if any) is merged in. A unit's `locked` parts are added
// by Writ after the editable text and can't be changed, because code depends on their exact shape.

import { admin } from "../_shared/supabase.ts";
import { consolidateTemplate, CONTRACT_LITE, CONTRACT_SYSTEM, EXTRACT_SYSTEM } from "./prompts.ts";
import {
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
      { key: "contract.lite", label: "Added for short formats (short-format scope)", text: CONTRACT_LITE },
    ],
  },
  {
    id: "research_search",
    group: "Scope and research",
    title: "Search the web for research",
    when: "On the Research step (piece and section), when you press Search.",
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
    title: "Analyse the approved research",
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
    id: "outline_suggest",
    group: "Outline and writing",
    title: "Suggest the outline",
    when: "On the Outline step, in the conversation with the AI.",
    tier: "reason",
    receives: ["Brief", "Scope", "Analysis", "Approved piece research", "Format style profile", "The conversation"],
    units: [{ key: "outline", label: "Prompt", text: OUTLINE_SYSTEM }],
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
    when: "Only if you choose \"Draft with AI\" on a section. Writing by hand is the default.",
    tier: "write",
    receives: ["Section", "Outline", "Approved research", "Core voice", "Format style profile", "Voice memory", "The brief"],
    units: [{ key: "draft", label: "Prompt", text: DRAFT_SYSTEM }],
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
    when: "On the Outline step, when you press Improve structure. It plans what goes under each heading; the writer edits it.",
    tier: "reason",
    receives: ["Brief", "Scope", "Analysis", "Approved piece research", "Format style profile", "Approved search-landscape findings", "The outline"],
    units: [{ key: "structure", label: "Prompt", text: STRUCTURE_SYSTEM }],
  },
  {
    id: "seo_fix",
    group: "Checks while writing",
    title: "Fix SEO and GEO gaps with AI",
    when: "After an SEO/GEO check finds things to improve. On the outline it revises the plan; on the finished piece it proposes small edits you accept one by one.",
    tier: "reason",
    receives: ["Brief", "Scope", "Approved search-landscape findings", "The gaps the check found", "The outline or the finished piece"],
    units: [
      { key: "seo_fix.outline", label: "Prompt for the outline", text: SEO_FIX_OUTLINE },
      { key: "seo_fix.final", label: "Prompt for the finished piece", text: SEO_FIX_FINAL },
    ],
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
