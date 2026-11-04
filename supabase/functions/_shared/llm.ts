// One entry point for every model call: structured JSON in, usage out.
// The company's active provider and key are loaded server-side; keys never
// reach the browser.

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { admin } from "./supabase.ts";
import { decrypt } from "./crypto.ts";
import { UserError } from "./cors.ts";
import { costUsd, DEFAULT_MODELS, type Provider, type TaskType } from "./models.ts";
import { assertPublicHost } from "./web.ts";

export type JsonSchema = Record<string, unknown>;

export interface ModelCall {
  taskType: TaskType;
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName: string;
  maxTokens?: number;
}

export interface ModelResult<T> {
  data: T;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface Connection {
  provider: Provider;
  apiKey: string;
  model: string;
  /** Local (OpenAI-compatible) endpoints only. */
  baseUrl: string | null;
}

/** Loads the active provider's key and the model for this task type. */
export async function connect(companyId: string, taskType: TaskType): Promise<Connection> {
  const { data: key, error } = await admin
    .from("provider_keys")
    .select("id, provider, base_url, provider_key_secrets(ciphertext, iv)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!key) throw new UserError("Add an AI provider key in AI settings before running this.");
  const budget = await budgetState(companyId);
  if (budget.hardLimit && budget.budget !== null && budget.spent >= budget.budget) {
    throw new UserError(
      `This month's AI budget of ${usd(budget.budget)} is used up (${usd(budget.spent)} spent). An editor can raise it or lift the limit in AI settings.`,
      403,
    );
  }
  const secret = Array.isArray(key.provider_key_secrets) ? key.provider_key_secrets[0] : key.provider_key_secrets;
  if (!secret) throw new UserError("The active key is missing. Add it again in AI settings.");
  const provider = key.provider as Provider;

  const { data: override } = await admin
    .from("model_overrides")
    .select("model")
    .eq("company_id", companyId)
    .eq("provider", provider)
    .eq("task_type", taskType)
    .maybeSingle();
  const model = override?.model ?? DEFAULT_MODELS[provider][taskType];
  if (!model) {
    throw new UserError(`Choose a ${provider} model for "${taskType}" tasks in AI settings.`);
  }
  return { provider, apiKey: await decrypt(secret.ciphertext, secret.iv), model, baseUrl: key.base_url ?? null };
}

export async function runModel<T>(companyId: string, call: ModelCall): Promise<ModelResult<T>> {
  const conn = await connect(companyId, call.taskType);
  const out = conn.provider === "anthropic"
    ? await callAnthropic(conn, call)
    : conn.provider === "openai"
    ? await callOpenAI(conn, call)
    : conn.provider === "local"
    ? await callLocal(conn, call)
    : await callGemini(conn, call);
  let data: T;
  try {
    data = JSON.parse(out.text) as T;
  } catch {
    throw new UserError("The model returned an unreadable answer. Try again.", 502);
  }
  return {
    data,
    provider: conn.provider,
    model: conn.model,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    costUsd: costUsd(conn.model, out.inputTokens, out.outputTokens),
  };
}

export async function recordUsage(
  companyId: string,
  userId: string,
  task: string,
  taskType: TaskType,
  r: ModelResult<unknown>,
  pieceId: string | null = null,
): Promise<void> {
  const { error } = await admin.from("usage_events").insert({
    company_id: companyId,
    piece_id: pieceId,
    user_id: userId,
    task,
    task_type: taskType,
    provider: r.provider,
    model: r.model,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cost_usd: r.costUsd,
  });
  if (error) console.error("usage insert failed", error);
}

interface RawOut {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const EFFORT: Record<TaskType, "low" | "medium" | "high"> = {
  extract: "low",
  research: "medium",
  reason: "medium",
  write: "high",
};

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

async function callAnthropic(conn: Connection, call: ModelCall): Promise<RawOut> {
  const client = new Anthropic({ apiKey: conn.apiKey, maxRetries: 2 });
  const useFallbacks = FALLBACK_MODELS.has(conn.model);
  try {
    const stream = client.beta.messages.stream({
      model: conn.model,
      max_tokens: call.maxTokens ?? 32000,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      output_config: {
        effort: EFFORT[call.taskType],
        format: { type: "json_schema", schema: call.schema },
      },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      throw new UserError("The model declined this request. Rephrase the input and try again.", 422);
    }
    if (msg.stop_reason === "max_tokens") {
      throw new UserError("The answer was too long and got cut off. Try with less input at once.", 422);
    }
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new UserError("Anthropic rejected the API key. Check it in AI settings.", 401);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new UserError("Anthropic is rate-limiting this key. Wait a minute and try again.", 429);
    }
    if (err instanceof Anthropic.APIError) {
      throw new UserError(`Anthropic returned an error (${err.status}): ${err.message}`, 502);
    }
    throw err;
  }
}

// OpenAI and Gemini adapters use their REST APIs. They follow each
// provider's structured-output format but haven't been tested end to end yet.

async function callOpenAI(conn: Connection, call: ModelCall): Promise<RawOut> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: conn.model,
      input: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
      max_output_tokens: call.maxTokens ?? 32000,
      text: { format: { type: "json_schema", name: call.schemaName, schema: call.schema, strict: true } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new UserError("OpenAI rejected the API key. Check it in AI settings.", 401);
  if (!res.ok) throw new UserError(`OpenAI returned an error (${res.status}): ${body?.error?.message ?? ""}`, 502);
  const text = (body.output ?? [])
    .flatMap((o: { content?: { type: string; text?: string }[] }) => o.content ?? [])
    .filter((c: { type: string }) => c.type === "output_text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
  return { text, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}

/** Endpoint for a local model, e.g. https://my-tunnel.example.com/v1 (Ollama, LM Studio, vLLM). */
export function localEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function callLocal(conn: Connection, call: ModelCall): Promise<RawOut> {
  if (!conn.baseUrl) throw new UserError("The local model has no address. Add it again in AI settings.");
  await assertPublicHost(new URL(conn.baseUrl).hostname);
  let res: Response;
  try {
    res = await fetch(localEndpoint(conn.baseUrl, "/chat/completions"), {
      method: "POST",
      signal: AbortSignal.timeout(140_000),
      headers: {
        "Content-Type": "application/json",
        ...(conn.apiKey && conn.apiKey !== "none" ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: conn.model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        max_tokens: call.maxTokens ?? 16000,
        response_format: { type: "json_schema", json_schema: { name: call.schemaName, schema: call.schema, strict: true } },
      }),
    });
  } catch {
    throw new UserError("Couldn't reach your local model. Check it's running and reachable at the address in AI settings.", 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Your local model returned an error (${res.status}): ${body?.error?.message ?? body?.error ?? ""}`, 502);
  const text = body.choices?.[0]?.message?.content ?? "";
  if (body.choices?.[0]?.finish_reason === "length") {
    throw new UserError("The local model's answer was cut off. Use a model with a larger context, or less input.", 422);
  }
  return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
}

/**
 * OpenAI web search through the Responses API. Returns the model's text and
 * the URLs it cited. OpenAI citations point at the model's own text, not the
 * page, so quotes are verified against the page separately.
 */
export async function callOpenAISearch(conn: Connection, system: string, user: string, maxSearchCalls: number) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: conn.model,
      instructions: system,
      input: user,
      tools: [{ type: "web_search" }],
      max_tool_calls: maxSearchCalls,
      max_output_tokens: 16000,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new UserError("OpenAI rejected the API key. Check it in AI settings.", 401);
  if (!res.ok) throw new UserError(`OpenAI returned an error (${res.status}): ${body?.error?.message ?? ""}`, 502);
  let text = "";
  const urls: { url: string; title: string }[] = [];
  let searches = 0;
  for (const item of body.output ?? []) {
    if (item.type === "web_search_call") searches++;
    for (const c of item.content ?? []) {
      if (c.type !== "output_text") continue;
      text += c.text ?? "";
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && a.url) urls.push({ url: a.url, title: a.title ?? a.url });
      }
    }
  }
  return { text, urls, searches, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}

async function callGemini(conn: Connection, call: ModelCall): Promise<RawOut> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(conn.model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": conn.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: "user", parts: [{ text: call.user }] }],
        generationConfig: {
          maxOutputTokens: call.maxTokens ?? 32000,
          responseMimeType: "application/json",
          responseJsonSchema: call.schema,
        },
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && /API key/i.test(body?.error?.message ?? "")) {
    throw new UserError("Google rejected the API key. Check it in AI settings.", 401);
  }
  if (!res.ok) throw new UserError(`Gemini returned an error (${res.status}): ${body?.error?.message ?? ""}`, 502);
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  return {
    text,
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/** Anthropic-only call with server tools or citations: plain text out, pause_turn resumed. */
export async function callAnthropicCited(
  conn: Connection,
  req: {
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[];
    tools?: Anthropic.Beta.BetaToolUnion[];
    effort: "low" | "medium" | "high";
    maxTokens?: number;
  },
): Promise<{ content: Anthropic.Beta.BetaContentBlock[]; inputTokens: number; outputTokens: number; searches: number }> {
  if (conn.provider !== "anthropic") {
    throw new UserError("Research with quoted sources needs an Anthropic key for now. Make it the active provider in AI settings.");
  }
  const client = new Anthropic({ apiKey: conn.apiKey, maxRetries: 2 });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: req.content }];
  const collected: Anthropic.Beta.BetaContentBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let searches = 0;
  try {
    for (let turn = 0; turn < 4; turn++) {
      const stream = client.beta.messages.stream({
        model: conn.model,
        max_tokens: req.maxTokens ?? 32000,
        system: req.system,
        messages,
        output_config: { effort: req.effort },
        ...(req.tools ? { tools: req.tools } : {}),
        ...(FALLBACK_MODELS.has(conn.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const msg = await stream.finalMessage();
      inputTokens += msg.usage.input_tokens;
      outputTokens += msg.usage.output_tokens;
      searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
      collected.push(...msg.content);
      if (msg.stop_reason === "refusal") {
        throw new UserError("The model declined this request. Rephrase the brief and try again.", 422);
      }
      if (msg.stop_reason !== "pause_turn") break;
      // Resume: resend the conversation with the paused assistant turn.
      messages.splice(1, messages.length - 1, { role: "assistant", content: collected.slice() as Anthropic.Beta.BetaContentBlockParam[] });
    }
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new UserError("Anthropic rejected the API key. Check it in AI settings.", 401);
    if (err instanceof Anthropic.RateLimitError) throw new UserError("Anthropic is rate-limiting this key. Wait a minute and try again.", 429);
    if (err instanceof Anthropic.APIError) throw new UserError(`Anthropic returned an error (${err.status}): ${err.message}`, 502);
    throw err;
  }
  return { content: collected, inputTokens, outputTokens, searches };
}

/** Cheapest possible request, to confirm a key works before saving it. */
export async function verifyKey(provider: Provider, apiKey: string, baseUrl?: string | null): Promise<void> {
  if (provider === "local") {
    if (!baseUrl) throw new UserError("Enter the address of your local model's OpenAI-compatible API.");
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      throw new UserError("That address isn't valid. It should look like https://my-tunnel.example.com/v1");
    }
    await assertPublicHost(host);
    const res = await fetch(localEndpoint(baseUrl, "/models"), {
      signal: AbortSignal.timeout(15_000),
      headers: apiKey && apiKey !== "none" ? { Authorization: `Bearer ${apiKey}` } : {},
    }).catch(() => null);
    if (!res) throw new UserError("Couldn't reach your local model at that address. Our server needs to reach it over the internet.");
    if (res.status === 401 || res.status === 403) throw new UserError("Your local model rejected the key.");
    if (!res.ok) throw new UserError(`Your local model answered ${res.status} at /models. Check the address ends with /v1.`);
    return;
  }
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    try {
      await client.models.list({ limit: 1 });
      return;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new UserError("Anthropic rejected this key.");
      }
      throw new UserError("Couldn't reach Anthropic to check the key. Try again.", 502);
    }
  }
  const res = await (provider === "openai"
    ? fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
    : fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    })).catch(() => null);
  if (!res) throw new UserError(`Couldn't reach ${provider === "openai" ? "OpenAI" : "Google"} to check the key. Check your connection and try again.`, 502);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new UserError(`${provider === "openai" ? "OpenAI" : "Google"} rejected this key.`);
  }
  if (!res.ok) throw new UserError("Couldn't reach the provider to check the key. Try again.", 502);
}

/** The model IDs a key can use, from the provider's own list. Chat models only; newest first where the provider says. */
export async function listModels(provider: Provider, apiKey: string, baseUrl?: string | null): Promise<string[]> {
  const timeout = AbortSignal.timeout(20_000);
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return ids;
  }
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout });
    if (!res.ok) throw new UserError(`OpenAI answered ${res.status} when listing models.`, 502);
    const body = await res.json() as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|moderation|instruct|search)/.test(id))
      .sort().reverse();
  }
  if (provider === "gemini") {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": apiKey },
      signal: timeout,
    });
    if (!res.ok) throw new UserError(`Google answered ${res.status} when listing models.`, 502);
    const body = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .sort().reverse();
  }
  if (!baseUrl) throw new UserError("The local model has no address. Add it again in AI settings.");
  await assertPublicHost(new URL(baseUrl).hostname);
  const res = await fetch(localEndpoint(baseUrl, "/models"), {
    signal: timeout,
    headers: apiKey && apiKey !== "none" ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new UserError(`Your local model answered ${res.status} when listing models.`, 502);
  const body = await res.json() as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).sort();
}

// ---------------------------------------------------------------------------
// Spending controls
// ---------------------------------------------------------------------------

export interface BudgetState {
  budget: number | null;
  spent: number;
  alertPct: number;
  hardLimit: boolean;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The company's monthly budget and what it has spent this calendar month (UTC). */
export async function budgetState(companyId: string): Promise<BudgetState> {
  const [{ data: company, error }, { data: spent, error: spendError }] = await Promise.all([
    admin.from("companies").select("monthly_budget_usd, budget_alert_pct, budget_hard_limit").eq("id", companyId).single(),
    admin.rpc("month_spend", { target: companyId }),
  ]);
  if (error) throw error;
  if (spendError) throw spendError;
  return {
    budget: company.monthly_budget_usd === null ? null : Number(company.monthly_budget_usd),
    spent: Number(spent ?? 0),
    alertPct: company.budget_alert_pct,
    hardLimit: company.budget_hard_limit,
  };
}

/** Budget fields for an estimate: where this month stands, and where this run would take it. */
export async function budgetForEstimate(companyId: string, cost: number | null) {
  const b = await budgetState(companyId);
  return { month_spent: b.spent, month_budget: b.budget, budget_hard_limit: b.hardLimit, month_after: cost === null ? null : b.spent + cost };
}
