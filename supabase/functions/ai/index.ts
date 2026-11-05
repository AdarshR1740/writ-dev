// Onboarding AI tasks. Every task can be estimated first (no model call),
// then run. Runs record their real token use and cost.
//
//   consolidate    merge new inputs into a context document -> pending proposal
//   extract_cards  pull insight cards out of a transcript -> drafts for review (not saved)

import { handle, json, UserError } from "../_shared/cors.ts";
import { admin, requireRole, requireUser } from "../_shared/supabase.ts";
import { budgetForEstimate, connect, recordUsage, runModel } from "../_shared/llm.ts";
import { costUsd, estimateTokens, type TaskType } from "../_shared/models.ts";
import { contextFor, loadPiece, logEvent, requireStep, setting } from "../_shared/context.ts";
import {
  CONTRACT_LITE,
  CONTRACT_SYSTEM,
  contractSchema,
  consolidateSchema,
  consolidateSystem,
  consolidateTemplate,
  consolidateUser,
  type DocKind,
  EXTRACT_SYSTEM,
  extractSchema,
  extractUser,
} from "./prompts.ts";

const MAX_INPUT_CHARS = 400_000;

import type { Prepared } from "./prepared.ts";
import { applySeoFix, WRITING_TASKS } from "./writing.ts";
import { MEMORY_TASKS } from "./memory.ts";
import { promptCatalog } from "./catalog.ts";
import { promptSet } from "../_shared/prompt-overrides.ts";
import { describeThread, type ThreadRow, wantsWeb, webBlock, webLookup } from "./chat.ts";

async function prepareConsolidate(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const documentId = String(body.document_id ?? "");
  const { data: doc, error } = await admin
    .from("context_documents")
    .select("id, company_id, kind, content, version, format_id, formats(name, description)")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) throw new UserError("Document not found.", 404);
  await requireRole(userId, doc.company_id, "member");

  const { data: inputs, error: inputsError } = await admin
    .from("context_inputs")
    .select("id, label, origin, content")
    .eq("document_id", doc.id)
    .is("merged_at", null)
    .order("created_at");
  if (inputsError) throw inputsError;
  if (!inputs?.length) throw new UserError("Add some material first. Everything here is already merged.");

  const format = Array.isArray(doc.formats) ? doc.formats[0] : doc.formats;
  const prompts = await promptSet(doc.company_id);
  const system = consolidateSystem(
    prompts(`consolidate.${doc.kind}`, consolidateTemplate(doc.kind as DocKind)), format?.name, format?.description,
  );
  const user = consolidateUser(doc.content, inputs);
  if (user.length > MAX_INPUT_CHARS) {
    throw new UserError("That's too much material to merge at once. Remove some sources and merge in two rounds.");
  }
  const taskType: TaskType = doc.kind === "format_profile" ? "reason" : "write";

  return {
    companyId: doc.company_id,
    taskType,
    system,
    user,
    expectedOutputTokens: estimateTokens(doc.content.length) + 1500,
    run: async () => {
      const r = await runModel<{ document: string; summary: string; conflicts: string[] }>(doc.company_id, {
        taskType,
        system,
        user,
        schema: consolidateSchema,
        schemaName: "consolidated_document",
      });
      await recordUsage(doc.company_id, userId, "consolidate", taskType, r);
      const summary = [r.data.summary, ...r.data.conflicts.map((c) => `Conflict: ${c}`)].join("\n");
      const { data: proposal, error: insertError } = await admin
        .from("document_proposals")
        .insert({
          company_id: doc.company_id,
          document_id: doc.id,
          base_version: doc.version,
          proposed_content: r.data.document,
          summary,
          input_ids: inputs.map((i) => i.id),
          created_by: userId,
        })
        .select()
        .single();
      if (insertError) throw insertError;
      return { proposal, cost_usd: r.costUsd, model: r.model };
    },
  };
}

async function prepareExtract(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const companyId = String(body.company_id ?? "");
  await requireRole(userId, companyId, "member");
  const text = String(body.text ?? "").trim();
  if (text.length < 200) throw new UserError("Paste the full transcript or notes. This is too short to extract from.");
  if (text.length > MAX_INPUT_CHARS) throw new UserError("That transcript is too long. Split it into parts.");
  const user = extractUser(text, {
    who: String(body.source_who ?? ""),
    where: String(body.source_where ?? ""),
    date: String(body.source_date ?? ""),
  });
  const taskType: TaskType = "extract";
  const system = (await promptSet(companyId))("extract_cards", EXTRACT_SYSTEM);
  return {
    companyId,
    taskType,
    system,
    user,
    expectedOutputTokens: 3000,
    run: async () => {
      const r = await runModel<{ cards: unknown[] }>(companyId, {
        taskType,
        system,
        user,
        schema: extractSchema,
        schemaName: "insight_cards",
        maxTokens: 16000,
      });
      await recordUsage(companyId, userId, "extract_cards", taskType, r);
      return { cards: r.data.cards, cost_usd: r.costUsd, model: r.model };
    },
  };
}

async function prepareContract(userId: string, body: Record<string, unknown>): Promise<Prepared> {
  const piece = await loadPiece(String(body.piece_id ?? ""));
  await requireRole(userId, piece.company_id, "member");
  const mode = setting<string>(piece, "contract.mode");
  requireStep(piece, mode !== "off" && setting<boolean>(piece, "contract.ai_thread"), "The contract conversation");
  const retry = body.retry === true;
  const message = retry ? "" : String(body.message ?? "").trim();
  const { data: thread } = await admin.from("threads").select("id").eq("piece_id", piece.id).eq("subject", "contract")
    .single();
  const { data: all } = await admin.from("thread_messages").select("id, role, content, payload").eq("thread_id", thread!.id)
    .order("created_at");
  // Retrying drops the last AI reply and answers the writer's last message again.
  const lastAi = retry && all?.length && all[all.length - 1].role === "ai" ? all[all.length - 1] : null;
  const history = ((lastAi ? all!.slice(0, -1) : all) ?? []) as ThreadRow[];
  const askedFor = message || (retry ? [...history].reverse().find((m) => m.role === "writer")?.content ?? "" : "");
  // A lookup runs when the writer ticked "Search the web", asked for one in words, or the reply being retried had one.
  const lookup = askedFor !== "" && (body.web === true || wantsWeb(askedFor) || Boolean((lastAi?.payload as { web?: unknown } | null)?.web));
  // Wiring: the contract stage gets the brief, the current contract and strategy. No voice or memory.
  const context = await contextFor(piece, ["brief", "contract", "icp", "positioning", "strategy_notes"]);
  const conversation = describeThread(history, message ? { role: "writer", content: message } : undefined);
  const user = `${context}\n\n<conversation>\n${conversation || "(The writer hasn't said anything yet. Suggest a first contract.)"}\n</conversation>`;
  const taskType: TaskType = "reason";
  const prompts = await promptSet(piece.company_id);
  const system = mode === "lite"
    ? `${prompts("contract.base", CONTRACT_SYSTEM)}\n\n${prompts("contract.lite", CONTRACT_LITE)}`
    : prompts("contract.base", CONTRACT_SYSTEM);
  return {
    companyId: piece.company_id,
    taskType,
    system,
    user,
    expectedOutputTokens: 1200,
    run: async () => {
      if (lastAi) await admin.from("thread_messages").delete().eq("id", lastAi.id);
      if (message) {
        const { error } = await admin.from("thread_messages").insert({
          company_id: piece.company_id, thread_id: thread!.id, role: "writer", content: message, created_by: userId,
        });
        if (error) throw error;
      }
      // Looked up only when the writer asks for it; what it finds is kept with the reply and carried forward.
      const found = lookup ? await webLookup(piece, userId, askedFor, piece.topic || piece.title, conversation) : null;
      const r = await runModel<{ reply: string; core_question: string; expectations: string[] }>(piece.company_id, {
        taskType,
        system,
        user: lookup ? `${user}\n\n${webBlock(found)}` : user,
        schema: contractSchema,
        schemaName: "reader_contract",
        maxTokens: 8000,
      });
      await recordUsage(piece.company_id, userId, "contract_suggest", taskType, r, piece.id);
      const { data: aiMessage, error } = await admin.from("thread_messages").insert({
        company_id: piece.company_id,
        thread_id: thread!.id,
        role: "ai",
        content: r.data.reply,
        payload: { core_question: r.data.core_question, expectations: r.data.expectations, ...(found ? { web: found } : {}) },
      }).select().single();
      if (error) throw error;
      await logEvent(piece, userId, "contract_suggested", { message: aiMessage.id });
      return { message: aiMessage, cost_usd: r.costUsd, model: r.model };
    },
  };
}

const TASKS: Record<string, (userId: string, body: Record<string, unknown>) => Promise<Prepared>> = {
  consolidate: prepareConsolidate,
  extract_cards: prepareExtract,
  contract_suggest: prepareContract,
  ...WRITING_TASKS,
  ...MEMORY_TASKS,
};

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Read-only list of every prompt, for the prompt viewer in Settings. No model call, no cost.
  if (body.task === "prompts") {
    await requireRole(user.id, String(body.company_id ?? ""), "member");
    return json({ prompts: await promptCatalog(String(body.company_id)) });
  }
  // Applies one accepted SEO/GEO edit to a section. No model call, no cost.
  if (body.task === "seo_fix_apply") return json(await applySeoFix(user.id, body));
  const prepare = TASKS[String(body.task ?? "")];
  if (!prepare) throw new UserError("Unknown task.");
  const prepared = await prepare(user.id, body);

  if (body.mode === "estimate") {
    const { model } = await connect(prepared.companyId, prepared.taskType);
    const inputTokens = estimateTokens(prepared.system.length + prepared.user.length);
    const cost = costUsd(model, inputTokens, prepared.expectedOutputTokens);
    return json({
      model,
      input_tokens: inputTokens,
      output_tokens: prepared.expectedOutputTokens,
      cost_usd: cost,
      ...(await budgetForEstimate(prepared.companyId, cost)),
    });
  }
  return json(await prepared.run());
}));
