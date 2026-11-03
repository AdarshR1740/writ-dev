// Model routing: each task type uses the cheapest model that does it well.
// Companies can override any default in AI settings (model_overrides table).

export type Provider = "anthropic" | "openai" | "gemini" | "local";
export type TaskType = "extract" | "research" | "reason" | "write";

export const TASK_TYPES: Record<TaskType, string> = {
  extract: "Extracting and classifying (cards, tagging, format checks)",
  research: "Search and source summaries",
  reason: "Reasoning (contract, outline, analysis, style profiles)",
  write: "Writing and consolidating documents",
};

// Defaults per provider. Gemini and local models have none: a company sets a
// model per task type in AI settings (local model names depend on what's installed).
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

// USD per million tokens. Only models we can price are listed; anything else
// records token counts with no cost.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// Anthropic web search: $10 per 1,000 searches, on top of tokens.
export const SEARCH_COST_USD = 0.01;

/** Rough pre-run estimate: ~4 characters per token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
