import {
  EvidenceSpanSchema,
  IngestionReceiptSchema,
  IngestionResultSchema,
  MemoryItemActionInputSchema,
  MemoryItemHistorySchema,
  CreateInitiativeBriefInputSchema,
  InitiativeBriefDecisionInputSchema,
  InitiativeBriefSchema,
  MemoryWithEvidenceSchema,
  CitedAnswerSchema,
  RecallMatchSchema,
  type EvidenceSpan,
  type IngestionReceipt,
  type IngestionResult,
  type CitedAnswer,
  type CreateInitiativeBriefInput,
  type InitiativeBrief,
  type InitiativeBriefDecisionInput,
  type MemoryWithEvidence,
  type MemoryItemActionInput,
  type MemoryItemHistory,
  type MemoryItem,
} from "@distillery/contracts";
import { buildDeterministicCitedAnswer } from "@distillery/memory-generation";
import { validateInitiativeBriefTraceability } from "@distillery/memory-synthesis";
import type {
  CommittableMemoryItem,
  ExtractionRunRecord,
  IngestionContext,
  MemoryGenerationRepository,
} from "@distillery/memory-generation";

export type SupabaseRpcConfig = {
  supabaseUrl: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
};

export class SupabaseRpcClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SupabaseRpcConfig) {
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async rpc<T>(functionName: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(
      `${this.config.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${functionName}`,
      {
        method: "POST",
        headers: {
          apikey: this.config.secretKey,
          Authorization: `Bearer ${this.config.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase RPC ${functionName} failed: ${response.status} ${text.slice(0, 500)}`);
    }

    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  }
}

export class SupabaseMemoryGenerationRepository implements MemoryGenerationRepository {
  constructor(private readonly rpcClient: SupabaseRpcClient) {}

  async createTextIngestionWithEvidence(input: {
    tenantId: string;
    ingestionId: string;
    sourceItemId: string;
    sourceVersionId: string;
    idempotencyKey: string;
    appSessionId: string;
    submittedByLabel?: string;
    content: string;
    contentHash: string;
    evidenceSpans: EvidenceSpan[];
  }): Promise<IngestionReceipt> {
    const result = await this.rpcClient.rpc<unknown>("distillery_create_text_ingestion_with_evidence", {
      p_tenant_id: input.tenantId,
      p_ingestion_id: input.ingestionId,
      p_source_item_id: input.sourceItemId,
      p_source_version_id: input.sourceVersionId,
      p_idempotency_key: input.idempotencyKey,
      p_app_session_id: input.appSessionId,
      p_submitted_by_label: input.submittedByLabel ?? null,
      p_content: input.content,
      p_content_hash: input.contentHash,
      p_evidence_spans: input.evidenceSpans,
    });

    return IngestionReceiptSchema.parse(result);
  }

  async getIngestionContext(ingestionId: string): Promise<IngestionContext> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_ingestion_context", {
      p_ingestion_id: ingestionId,
    });

    const parsed = IngestionContextResponseSchema.parse(result);
    return parsed;
  }

  async markIngestionStatus(
    ingestionId: string,
    status: "generating" | "validating" | "memory_stored",
  ): Promise<void> {
    await this.rpcClient.rpc("distillery_update_ingestion_status", {
      p_ingestion_id: ingestionId,
      p_status: status,
    });
  }

  async recordExtractionRun(record: ExtractionRunRecord): Promise<void> {
    await this.rpcClient.rpc("distillery_record_extraction_run", {
      p_id: record.id,
      p_ingestion_id: record.ingestionId,
      p_tenant_id: record.tenantId,
      p_provider: record.provider,
      p_model: record.model,
      p_prompt_version: record.promptVersion,
      p_schema_version: record.schemaVersion,
      p_raw_response: record.rawResponse,
      p_status: record.status,
    });
  }

  async commitGeneratedMemory(input: {
    ingestionId: string;
    tenantId: string;
    sourceVersionId: string;
    extractionRunId: string;
    memoryGenerationVersion: string;
    items: CommittableMemoryItem[];
  }): Promise<MemoryItem[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_commit_generated_memory", {
      p_ingestion_id: input.ingestionId,
      p_tenant_id: input.tenantId,
      p_source_version_id: input.sourceVersionId,
      p_extraction_run_id: input.extractionRunId,
      p_memory_generation_version: input.memoryGenerationVersion,
      p_items: input.items,
    });

    return IngestionResultSchema.parse(result).memoryItems;
  }

  async failIngestion(ingestionId: string, message: string): Promise<void> {
    await this.rpcClient.rpc("distillery_fail_ingestion", {
      p_ingestion_id: ingestionId,
      p_error_message: message,
    });
  }

  async getIngestionResult(ingestionId: string): Promise<IngestionResult> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_ingestion_result", {
      p_ingestion_id: ingestionId,
    });

    return IngestionResultSchema.parse(result);
  }

  async applyMemoryItemAction(input: {
    memoryItemId: string;
    action: MemoryItemActionInput;
    replacementMemoryItemId?: string;
  }): Promise<IngestionResult> {
    const action = MemoryItemActionInputSchema.parse(input.action);
    const result = await this.rpcClient.rpc<unknown>("distillery_apply_memory_item_action", {
      p_memory_item_id: input.memoryItemId,
      p_action: action.action,
      p_reviewer_label: action.reviewerLabel,
      p_rationale: action.rationale ?? null,
      p_replacement_memory_item_id: input.replacementMemoryItemId ?? null,
      p_replacement: action.replacement ?? null,
    });

    return IngestionResultSchema.parse(result);
  }

  async getMemoryItemHistory(memoryItemId: string): Promise<MemoryItemHistory> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_memory_item_history", {
      p_memory_item_id: memoryItemId,
    });

    return MemoryItemHistorySchema.parse(result);
  }

  async recallMemory(input: { question: string; limit: number }): Promise<CitedAnswer> {
    const result = await this.rpcClient.rpc<unknown>("distillery_recall_memory_lexical", {
      p_tenant_id: "stable",
      p_query: input.question,
      p_limit: input.limit,
    });

    const matches = RecallMatchSchema.array().parse(result);
    return CitedAnswerSchema.parse(
      buildDeterministicCitedAnswer({
        question: input.question,
        matches,
      }),
    );
  }

  async listActiveMemory(input: { limit?: number } = {}): Promise<MemoryWithEvidence[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_list_active_memory", {
      p_tenant_id: "stable",
      p_limit: input.limit ?? 100,
    });

    return MemoryWithEvidenceSchema.array().parse(result);
  }

  async createInitiativeBrief(input: {
    briefId: string;
    brief: CreateInitiativeBriefInput;
  }): Promise<InitiativeBrief> {
    const brief = CreateInitiativeBriefInputSchema.parse(input.brief);
    const result = await this.rpcClient.rpc<unknown>("distillery_create_initiative_brief", {
      p_tenant_id: "stable",
      p_brief_id: input.briefId,
      p_title: brief.title,
      p_problem: brief.problem,
      p_proposal: brief.proposal,
      p_success_metric: brief.successMetric,
      p_risks_and_dependencies: brief.risksAndDependencies ?? null,
      p_memory_item_ids: brief.memoryItemIds,
      p_created_by_label: brief.createdByLabel,
    });

    return parseTraceableBrief(result);
  }

  async listInitiativeBriefs(input: { limit?: number } = {}): Promise<InitiativeBrief[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_list_initiative_briefs", {
      p_tenant_id: "stable",
      p_limit: input.limit ?? 50,
    });

    return InitiativeBriefSchema.array().parse(result).map((brief) => {
      assertTraceableBrief(brief);
      return brief;
    });
  }

  async getInitiativeBrief(briefId: string): Promise<InitiativeBrief> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_initiative_brief", {
      p_brief_id: briefId,
    });

    return parseTraceableBrief(result);
  }

  async recordInitiativeBriefDecision(input: {
    briefId: string;
    decisionId: string;
    decision: InitiativeBriefDecisionInput;
  }): Promise<InitiativeBrief> {
    const decision = InitiativeBriefDecisionInputSchema.parse(input.decision);
    const result = await this.rpcClient.rpc<unknown>("distillery_record_initiative_brief_decision", {
      p_brief_id: input.briefId,
      p_decision_id: input.decisionId,
      p_decision: decision.decision,
      p_reviewer_label: decision.reviewerLabel,
      p_rationale: decision.rationale ?? null,
    });

    return parseTraceableBrief(result);
  }
}

function parseTraceableBrief(result: unknown): InitiativeBrief {
  const brief = InitiativeBriefSchema.parse(result);
  assertTraceableBrief(brief);
  return brief;
}

function assertTraceableBrief(brief: InitiativeBrief): void {
  const validation = validateInitiativeBriefTraceability(brief);
  if (!validation.ok) {
    throw new Error(
      `Initiative brief traceability validation failed: ${
        validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")
      }`,
    );
  }
}

const IngestionContextResponseSchema = IngestionResultSchema.pick({
  ingestionId: true,
  sourceVersionId: true,
  evidenceSpans: true,
}).extend({
  tenantId: EvidenceSpanSchema.shape.id,
  sourceVersionId: EvidenceSpanSchema.shape.sourceVersionId,
});
