// Workflow recipes: which steps (and sub-steps) a format's pieces go through.
// Presets ship with the product; editors adjust them per format. Each piece
// keeps a snapshot of the recipe it started with.

export type Base = "long_form" | "short_form" | "case_study";

export interface Recipe {
  base: Base;
  brief: { keyword: boolean; goal: boolean; audience: boolean; customer: boolean; offer: boolean };
  contract: { mode: "off" | "lite" | "full"; ai_thread: boolean };
  research: {
    enabled: boolean;
    web_search: boolean;
    max_searches: number;
    serp: boolean;
    cards: boolean;
    library: boolean;
    manual: boolean;
    review: boolean;
  };
  analysis: { enabled: boolean; tensions: boolean; insight_vs_consensus: boolean; gaps: boolean; contract_suggestions: boolean };
  outline: { mode: "off" | "fixed" | "free"; template: string[]; ai_thread: boolean; seo_geo_check: boolean };
  sections: { research: boolean; timing: "just_in_time" | "up_front"; reuse_piece_items: boolean; brief: boolean };
  writing: { ai_draft: boolean };
  checks: { grammar: boolean; fact: boolean; contract: boolean; seo: boolean; geo: boolean; customer_approval: boolean };
  signoff: { required: boolean; editor_required: boolean; final_paste: boolean; learn: boolean };
}

// Keep in sync with public.default_recipe() in the recipes migration (a test checks it).
export const LONG_FORM: Recipe = {
  base: "long_form",
  brief: { keyword: true, goal: true, audience: true, customer: false, offer: false },
  contract: { mode: "full", ai_thread: true },
  research: { enabled: true, web_search: true, max_searches: 6, serp: true, cards: true, library: true, manual: true, review: true },
  analysis: { enabled: true, tensions: true, insight_vs_consensus: true, gaps: true, contract_suggestions: true },
  outline: { mode: "free", template: [], ai_thread: true, seo_geo_check: true },
  sections: { research: true, timing: "just_in_time", reuse_piece_items: true, brief: true },
  writing: { ai_draft: true },
  checks: { grammar: true, fact: true, contract: true, seo: true, geo: true, customer_approval: false },
  signoff: { required: true, editor_required: false, final_paste: true, learn: true },
};

const clone = (r: Recipe): Recipe => JSON.parse(JSON.stringify(r));

const SHORT_FORM: Recipe = {
  base: "short_form",
  brief: { keyword: false, goal: true, audience: false, customer: false, offer: false },
  contract: { mode: "lite", ai_thread: true },
  research: { enabled: true, web_search: true, max_searches: 3, serp: false, cards: true, library: true, manual: true, review: true },
  analysis: { enabled: false, tensions: false, insight_vs_consensus: false, gaps: false, contract_suggestions: false },
  outline: { mode: "off", template: [], ai_thread: false, seo_geo_check: false },
  sections: { research: false, timing: "just_in_time", reuse_piece_items: true, brief: true },
  writing: { ai_draft: true },
  checks: { grammar: true, fact: true, contract: true, seo: false, geo: false, customer_approval: false },
  signoff: { required: true, editor_required: false, final_paste: true, learn: true },
};

const CASE_STUDY: Recipe = {
  base: "case_study",
  brief: { keyword: true, goal: true, audience: true, customer: true, offer: false },
  contract: { mode: "full", ai_thread: true },
  research: { enabled: true, web_search: false, max_searches: 3, serp: false, cards: true, library: true, manual: true, review: true },
  analysis: { enabled: false, tensions: false, insight_vs_consensus: false, gaps: false, contract_suggestions: false },
  outline: { mode: "fixed", template: ["The challenge", "The approach", "The result", "In their words"], ai_thread: false, seo_geo_check: false },
  sections: { research: false, timing: "just_in_time", reuse_piece_items: true, brief: true },
  writing: { ai_draft: true },
  checks: { grammar: true, fact: true, contract: true, seo: true, geo: true, customer_approval: true },
  signoff: { required: true, editor_required: true, final_paste: true, learn: true },
};

export const BASES: Record<Base, { label: string; recipe: Recipe }> = {
  long_form: { label: "Long-form (full workflow)", recipe: LONG_FORM },
  short_form: { label: "Short-form (single section, light research)", recipe: SHORT_FORM },
  case_study: { label: "Case study (internal sources, fixed outline, customer approval)", recipe: CASE_STUDY },
};

/** Preset recipe for each format template. */
export function presetFor(templateKey: string | null): Recipe {
  switch (templateKey) {
    case "tl_blog":
      return { ...clone(LONG_FORM), checks: { ...LONG_FORM.checks, seo: false } };
    case "longform_blog":
      return clone(LONG_FORM);
    case "case_study":
      return clone(CASE_STUDY);
    case "tl_linkedin":
      return clone(SHORT_FORM);
    case "promo_social": {
      const r = clone(SHORT_FORM);
      r.brief = { ...r.brief, offer: true };
      r.contract = { mode: "off", ai_thread: false };
      r.research = { ...r.research, web_search: false, cards: false, library: false };
      r.checks.contract = false;
      return r;
    }
    case "short_social": {
      const r = clone(SHORT_FORM);
      r.contract = { mode: "off", ai_thread: false };
      r.research = { ...r.research, web_search: false, library: false, manual: false };
      r.checks.contract = false;
      return r;
    }
    case "instagram_caption": {
      const r = clone(SHORT_FORM);
      r.research = { ...r.research, web_search: false, library: false };
      return r;
    }
    case "instagram_carousel":
    case "linkedin_carousel":
      return slides(["Slide 1: hook", "Slide 2", "Slide 3", "Slide 4", "Slide 5", "Last slide: takeaway"]);
    case "x_thread":
      return slides(["Post 1: hook", "Post 2", "Post 3", "Post 4", "Last post: takeaway"]);
    case "short_video_script": {
      const r = slides(["Hook", "Point", "Proof", "Call to action"]);
      r.research = { ...r.research, web_search: false };
      return r;
    }
    case "video_script": {
      const r = clone(LONG_FORM);
      r.research = { ...r.research, serp: false, max_searches: 4 };
      r.analysis = { ...r.analysis, enabled: false, tensions: false, insight_vs_consensus: false, gaps: false, contract_suggestions: false };
      r.outline = { mode: "fixed", template: ["Hook", "Setup", "Segment 1", "Segment 2", "Segment 3", "Call to action"], ai_thread: false, seo_geo_check: false };
      r.sections = { ...r.sections, research: false };
      r.checks = { ...r.checks, seo: false, geo: false };
      return r;
    }
    case "newsletter": {
      const r = clone(SHORT_FORM);
      r.outline = { mode: "free", template: [], ai_thread: true, seo_geo_check: false };
      return r;
    }
    case "webinar_outline": {
      const r = clone(LONG_FORM);
      r.research = { ...r.research, serp: false, max_searches: 4 };
      r.analysis = { ...r.analysis, contract_suggestions: false };
      r.outline = { mode: "fixed", template: ["Opening", "Agenda", "Part 1", "Part 2", "Part 3", "Q&A", "Close"], ai_thread: false, seo_geo_check: false };
      r.sections = { ...r.sections, research: false };
      // Talking points, not prose: no grammar or SEO/GEO checks.
      r.checks = { ...r.checks, grammar: false, seo: false, geo: false };
      return r;
    }
    default:
      return clone(LONG_FORM);
  }
}

/** Short formats built from a fixed sequence of slides, posts or beats. */
function slides(template: string[]): Recipe {
  const r = clone(SHORT_FORM);
  r.outline = { mode: "fixed", template, ai_thread: false, seo_geo_check: false };
  r.research = { ...r.research, library: false };
  return r;
}

export interface Issue {
  path: string;
  message: string;
}

/**
 * Dependency rules. Returns the problems with a recipe; an empty list means
 * it can be saved. The same rules decide which switches the editor greys out.
 */
export function validate(r: Recipe): Issue[] {
  const out: Issue[] = [];
  const need = (cond: boolean, path: string, message: string) => { if (cond) out.push({ path, message }); };
  const anySource = r.research.web_search || r.research.cards || r.research.library || r.research.manual;

  need(r.research.enabled && !anySource, "research.enabled", "Research needs at least one source: web search, insight cards, library or your own sources.");
  need(r.research.serp && !(r.research.enabled && r.research.web_search), "research.serp", "The search landscape needs web search.");
  need(r.research.serp && !r.brief.keyword, "research.serp", "The search landscape needs a primary keyword in the brief.");
  need(r.research.max_searches < 1 || r.research.max_searches > 10, "research.max_searches", "Max searches must be between 1 and 10.");
  need(r.analysis.enabled && !r.research.enabled, "analysis.enabled", "Analysis needs research.");
  need(r.analysis.enabled && !(r.analysis.tensions || r.analysis.insight_vs_consensus || r.analysis.gaps || r.analysis.contract_suggestions),
    "analysis.enabled", "Turn on at least one part of the analysis, or switch it off.");
  need(r.analysis.contract_suggestions && r.contract.mode === "off", "analysis.contract_suggestions", "Scope suggestions need a scope.");
  need(r.contract.ai_thread && r.contract.mode === "off", "contract.ai_thread", "The scope conversation needs a scope.");
  need(r.outline.mode === "fixed" && r.outline.template.filter((h) => h.trim()).length === 0, "outline.template", "A fixed outline needs at least one heading.");
  need(r.outline.ai_thread && r.outline.mode !== "free", "outline.ai_thread", "Outline suggestions need a free outline.");
  need(r.outline.seo_geo_check && r.outline.mode === "off", "outline.seo_geo_check", "The outline check needs an outline.");
  need(r.outline.seo_geo_check && !r.brief.keyword, "outline.seo_geo_check", "The outline SEO/GEO check needs a primary keyword.");
  need(r.sections.research && !anySource, "sections.research", "Section research needs at least one research source.");
  need(r.checks.seo && !r.brief.keyword, "checks.seo", "The SEO check needs a primary keyword in the brief.");
  need(r.checks.contract && r.contract.mode === "off", "checks.contract", "The scope check needs a scope.");
  need(r.checks.fact && !r.research.enabled && !r.sections.research, "checks.fact", "The fact check compares against approved research, so it needs research.");
  need(r.checks.customer_approval && !r.brief.customer, "checks.customer_approval", "Customer approval needs the customer field in the brief.");
  need(r.signoff.editor_required && !r.signoff.required, "signoff.editor_required", "An editor can only be required when sign-off is required.");
  need(r.signoff.learn && !r.signoff.required && !r.signoff.final_paste && !r.writing.ai_draft, "signoff.learn",
    "Learning needs something to learn from: AI drafts you edited or a pasted final version.");
  return out;
}

/** Fill in any fields missing from older saved recipes. */
export function normalise(raw: unknown): Recipe {
  const r0 = normaliseRaw(raw);
  // Research is available in every format; its sources and review stay configurable.
  r0.research.enabled = true;
  if (!r0.research.web_search && !r0.research.cards && !r0.research.library && !r0.research.manual) r0.research.manual = true;
  return r0;
}

function normaliseRaw(raw: unknown): Recipe {
  const base = (raw as Recipe | null)?.base ?? "long_form";
  const preset = BASES[base]?.recipe ?? LONG_FORM;
  const r = (raw ?? {}) as Partial<Recipe>;
  const merge = <K extends keyof Recipe>(k: K) => ({ ...(preset[k] as object), ...((r[k] as object) ?? {}) }) as Recipe[K];
  return {
    base,
    brief: merge("brief"),
    contract: merge("contract"),
    research: merge("research"),
    analysis: merge("analysis"),
    outline: merge("outline"),
    sections: merge("sections"),
    writing: merge("writing"),
    checks: merge("checks"),
    signoff: merge("signoff"),
  };
}

/** Which piece stages a recipe uses, in order. */
export function stagesFor(r: Recipe): ("contract" | "research" | "outline" | "writing" | "done")[] {
  return [
    ...(r.contract.mode !== "off" ? ["contract" as const] : []),
    ...(r.research.enabled ? ["research" as const] : []),
    ...(r.outline.mode !== "off" ? ["outline" as const] : []),
    "writing" as const,
    "done" as const,
  ];
}
