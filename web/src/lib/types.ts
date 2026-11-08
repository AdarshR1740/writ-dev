export type Role = "editor" | "member";
export type Provider = "anthropic" | "openai" | "gemini" | "local";
export type TaskType = "extract" | "research" | "reason" | "write";
export type DocKind = "icp" | "positioning" | "strategy_notes" | "core_voice" | "format_profile";
export type CardType = "story" | "opinion" | "data_point" | "technical_detail" | "customer_quote" | "lesson";
export type Citation = "public" | "internal";

export interface Company {
  id: string;
  name: string;
  role: Role;
}

export interface Member {
  user_id: string;
  role: Role;
  profiles: { email: string; display_name: string | null } | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  token: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface ContextDocument {
  id: string;
  company_id: string;
  kind: DocKind;
  format_id: string | null;
  content: string;
  version: number;
  updated_at: string;
}

export interface ContextInput {
  id: string;
  document_id: string;
  origin: "paste" | "upload" | "url";
  label: string;
  source_url: string | null;
  content: string;
  created_at: string;
  merged_at: string | null;
}

export interface Proposal {
  id: string;
  document_id: string;
  base_version: number;
  proposed_content: string;
  summary: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

export interface Format {
  id: string;
  name: string;
  template_key: string | null;
  description: string;
  recipe: unknown;
}

export interface CardFields {
  type: CardType;
  claim: string;
  detail: string;
  source_who: string;
  source_where: string;
  source_date: string;
  citation: Citation;
  tags: string[];
  value: string | null;
  unit: string | null;
  period: string | null;
  sample_size: string | null;
}

export interface Card extends CardFields {
  id: string;
  origin: "manual" | "import" | "extraction";
  created_at: string;
  updated_at: string;
}

export interface ProviderKey {
  provider: Provider;
  key_hint: string;
  base_url: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Estimate {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  month_spent?: number;
  month_budget?: number | null;
  month_after?: number | null;
  budget_hard_limit?: boolean;
}

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  story: "Story",
  opinion: "Opinion",
  data_point: "Data point",
  technical_detail: "Technical detail",
  customer_quote: "Customer quote",
  lesson: "Lesson",
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  gemini: "Google (Gemini)",
  local: "Local model (OpenAI-compatible)",
};

export const TASK_TYPE_LABELS: Record<TaskType, { name: string; detail: string }> = {
  extract: { name: "Extracting", detail: "Insight cards, tagging, format checks" },
  research: { name: "Research", detail: "Search and source summaries" },
  reason: { name: "Reasoning", detail: "Style profiles, contracts, outlines, analysis" },
  write: { name: "Writing", detail: "Consolidating documents, drafting" },
};

// Must match supabase/functions/_shared/models.ts
export const DEFAULT_MODELS: Record<Provider, Partial<Record<TaskType, string>>> = {
  anthropic: {
    extract: "claude-haiku-5-5",
    research: "claude-sonnet-5-5",
    reason: "claude-sonnet-5-5",
    write: "claude-opus-5-5",
  },
  openai: {
    extract: "gpt-5-nano",
    research: "gpt-5-mini",
    reason: "gpt-5-mini",
    write: "gpt-5",
  },
  gemini: {},
  local: {},
};

export type Stage = "contract" | "research" | "outline" | "writing" | "done";
export type SourceType = "card" | "original_research" | "official" | "practitioner" | "critical" | "data" | "serp" | "web";

export interface Piece {
  id: string;
  company_id: string;
  code: string;
  version: number;
  lineage_id: string;
  revised_by: string | null;
  review_due_at: string | null;
  last_reviewed_at: string | null;
  origin_notes: string;
  title: string;
  topic: string;
  primary_keyword: string;
  format_id: string | null;
  goal: string;
  audience_notes: string;
  section_timing: "just_in_time" | "up_front";
  stage: Stage;
  analysis: Analysis | null;
  recipe: unknown;
  brief_extra: { customer?: string; approval_contact?: string; offer?: string; cta?: string };
  customer_approval: { approver: string; note: string; recorded_at: string } | null;
  outline_confirmed_at: string | null;
  final_check: { checked_at: string; results: CheckResult[] } | null;
  final_text: string | null;
  seo_geo_outline: import("../components/SeoGeoPanel").SeoGeoResult | null;
  seo_geo_final: import("../components/SeoGeoPanel").SeoGeoResult | null;
  memory_check: import("../components/MemoryPanel").MemoryResult | null;
  signed_off_by: string | null;
  signed_off_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Expectation {
  id: string;
  text: string;
}

export interface Contract {
  piece_id: string;
  core_question: string;
  expectations: Expectation[];
  confirmed_at: string | null;
}

export interface ThreadMessage {
  id: string;
  role: "writer" | "ai";
  content: string;
  payload: {
    core_question?: string;
    expectations?: string[];
    sections?: { heading: string; purpose: string; expectations: number[] }[];
    /** What a web lookup found for this reply, and the pages it came from. */
    web?: { findings?: string; sources: { url: string; title: string }[] };
  } | null;
  created_at: string;
}

export interface Source {
  id: string;
  url: string | null;
  title: string;
  published: string;
  origin: "search" | "url" | "paste";
  in_library: boolean;
  tags: string[];
  last_checked: string;
  snapshot?: string | null;
}

export interface ResearchItem {
  id: string;
  piece_id: string;
  scope: "piece" | "section";
  source_id: string | null;
  card_id: string | null;
  statement: string;
  quote: string;
  source_type: SourceType;
  secondary: boolean;
  quote_status: "cited" | "verified" | "unverified";
  status: "unreviewed" | "approved" | "rejected";
  edited: boolean;
  created_at: string;
  sources: Pick<Source, "id" | "url" | "title" | "published" | "in_library"> | null;
}

export const STAGES: { key: Stage; label: string }[] = [
  { key: "contract", label: "Scope" },
  { key: "research", label: "Research" },
  { key: "outline", label: "Outline" },
  { key: "writing", label: "Writing" },
  { key: "done", label: "Sign-off" },
];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  card: "Your insight",
  original_research: "Original research",
  official: "Official",
  practitioner: "Practitioner",
  critical: "Critical view",
  data: "Data",
  serp: "Search landscape",
  web: "Web",
};

export interface BriefBullet {
  text: string;
  refs: string[];
}

export interface CheckResult {
  expectation_id: string;
  text: string;
  status: "met" | "partly" | "missing";
  evidence: string;
  gap: string;
}

export interface FactFlag {
  sentence: string;
  kind: "unsupported" | "mismatch";
  issue: string;
  item_id: string | null;
}

export interface Section {
  id: string;
  piece_id: string;
  position: number;
  heading: string;
  purpose: string;
  expectation_ids: string[];
  status: "research" | "brief" | "writing" | "written";
  brief: BriefBullet[] | null;
  content: string;
  ai_draft: string | null;
  written_by: "writer" | "ai_then_writer" | null;
  contract_check: { checked_at: string; rev?: number | null; results: CheckResult[] } | null;
  fact_check: { checked_at: string; rev?: number; flags: FactFlag[] } | null;
  grammar_check: { checked_at: string; rev: number; found: number } | null;
  /** Goes up by one each time the text changes; a check is current only while its rev matches. */
  content_rev: number;
  /** What the section is made of, planned in the outline. */
  structure: Block[] | null;
  updated_at: string;
}

export interface Analysis {
  /** Whether the scope and research still match the topic the piece started with. Missing on results from before this check. */
  alignment?: { verdict: "aligned" | "partly" | "drifted"; summary: string };
  /** `ignored`: the writer dismissed this point as not relevant. */
  drift?: { text: string; items: number[]; points?: number[]; ignored?: boolean }[];
  gaps: { text: string; expert_question: string; points?: number[]; ignored?: boolean }[];
  contract_suggestions?: { change: string; why: string }[];
  /** The ids behind the item and point numbers above, as they were when the check ran. Missing on older results. */
  item_ids?: string[];
  point_ids?: string[];
}

/** One change the AI proposed after the alignment check, with the ids the screen needs to apply it. */
export interface FixProposal {
  id: string;
  type: "reject_item" | "edit_point" | "remove_point" | "add_point" | "add_section";
  why: string;
  item_id?: string;
  item_text?: string;
  point_id?: string;
  point_text?: string;
  /** New wording for edit_point, or the text of the point add_point creates. */
  text?: string;
  /** add_point: the id the new point will have. */
  new_point_id?: string;
  /** A new outline section, for add_section or add_point. */
  heading?: string;
  purpose?: string;
  point_ids?: string[];
}

export interface PieceLink {
  from_piece: string;
  to_piece: string;
  kind: "revision" | "split" | "adapt" | "combine";
  created_at: string;
}

export type Shape = "split" | "adapt" | "combine";

export interface PlanEntry {
  heading: string;
  angle: string;
  notes: string;
  item_ids: string[];
  sections: { heading: string; purpose: string }[];
}

export interface RepurposePlan {
  id: string;
  shape: Shape;
  target_format_id: string;
  source_piece_ids: string[];
  instructions: string;
  proposal: { entries: PlanEntry[]; not_translated: string[]; gaps: string[] } | null;
  status: "draft" | "created";
  created_pieces: string[];
}

export interface LeaderVoice {
  id: string;
  name: string;
  role: string;
  profile: string;
  updated_at: string;
}

export type BlockType = "answer" | "paragraph" | "bullets" | "steps" | "table" | "example" | "data" | "subheading" | "faq" | "quote" | "takeaway";

export interface Block {
  type: BlockType;
  note: string;
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  answer: "Short answer",
  paragraph: "Paragraph",
  bullets: "Bullet list",
  steps: "Numbered steps",
  table: "Table",
  example: "Example or case",
  data: "Figure or finding",
  subheading: "Subheading",
  faq: "Question and answer",
  quote: "Expert quote",
  takeaway: "Takeaway",
};
