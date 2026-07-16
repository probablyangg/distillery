import {
  EvidenceSpanSchema,
  IngestionReceiptSchema,
  IngestionResultSchema,
  MemoryItemActionInputSchema,
  MemoryItemHistorySchema,
  CreateInitiativeBriefInputSchema,
  InitiativeBriefDecisionInputSchema,
  InitiativeBriefSchema,
  EventOutboxRowSchema,
  ClaimConnectionSchema,
  ConflictGroupSchema,
  GraphClusterSchema,
  GraphClusterSummarySchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  GraphRetrievalClaimSchema,
  GraphRecallContextSchema,
  LedgerEventSchema,
  LoopStatusResponseSchema,
  MemoryWithEvidenceSchema,
  PendingWorkItemSchema,
  PolicyRunSchema,
  ProposedEventSchema,
  CitedAnswerSchema,
  RecallMatchSchema,
  UpdateInitiativeBriefInputSchema,
  SynthesisClusterSchema,
  SynthesisEnrichmentStateSchema,
  SynthesisSimilaritySignalSchema,
  SuggestedBriefSchema,
  StoredMemorySectionPlanSchema,
  MemorySectionSchema,
  type EvidenceSpan,
  type IngestionReceipt,
  type IngestionResult,
  type CitedAnswer,
  type ClaimConnection,
  type ConflictGroup,
  type CreateInitiativeBriefInput,
  type GraphCluster,
  type GraphClusterSummary,
  type GraphEdge,
  type GraphNode,
  type GraphRecallContext,
  type InitiativeBrief,
  type InitiativeBriefDecisionInput,
  type MemoryWithEvidence,
  type MemoryItemActionInput,
  type MemoryItemHistory,
  type MemoryItem,
  type EventOutboxRow,
  type LedgerEvent,
  type LoopStatusResponse,
  type PendingWorkItem,
  type PolicyRun,
  type PolicyName,
  type ProposedEvent,
  type UpdateInitiativeBriefInput,
  type WorkSubjectType,
  type StoredMemorySectionPlan,
  type MemorySection,
  type GeneratedMemoryItem,
} from "@distillery/contracts";
import type { CorpusSynthesisState, LoopPersistence, LoopRecoveryResult } from "@distillery/loop";
import type {
  HydratedRetrievalClaims,
  RetrievalCandidate,
  RetrievalGraphSnapshot,
} from "@distillery/memory-retrieval";
import { buildDeterministicCitedAnswer } from "@distillery/memory-generation";
import { validateInitiativeBriefTraceability } from "@distillery/memory-synthesis";
import { z } from "zod";
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
    routeSource?: boolean;
  }): Promise<IngestionReceipt> {
    const result = await this.rpcClient.rpc<unknown>("distillery_create_text_ingestion_with_evidence_v2", {
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
      p_route_source: input.routeSource ?? true,
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

  async updateInitiativeBrief(input: {
    briefId: string;
    brief: UpdateInitiativeBriefInput;
  }): Promise<InitiativeBrief> {
    const brief = UpdateInitiativeBriefInputSchema.parse(input.brief);
    const result = await this.rpcClient.rpc<unknown>("distillery_update_initiative_brief", {
      p_tenant_id: "stable",
      p_brief_id: input.briefId,
      p_title: brief.title,
      p_problem: brief.problem,
      p_proposal: brief.proposal,
      p_success_metric: brief.successMetric,
      p_risks_and_dependencies: brief.risksAndDependencies ?? null,
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

export class SupabaseLoopPersistence implements LoopPersistence {
  constructor(private readonly rpcClient: SupabaseRpcClient) {}

  async commitLedgerEventWithOutbox(input: Omit<LedgerEvent, "createdAt"> & { createdAt?: string }): Promise<LedgerEvent> {
    const result = await this.rpcClient.rpc<unknown>("distillery_commit_ledger_event_with_outbox", {
      p_event: input,
    });
    return LedgerEventSchema.parse(result);
  }

  async claimEventOutboxRow(leaseSeconds?: number, preferredSubjectId?: string): Promise<EventOutboxRow | null> {
    const result = await this.rpcClient.rpc<unknown>("distillery_claim_event_outbox_row_v2", {
      p_lease_seconds: leaseSeconds ?? 120,
      p_preferred_subject_id: preferredSubjectId ?? null,
    });
    return result ? EventOutboxRowSchema.parse(result) : null;
  }

  async loadLedgerEvent(id: string): Promise<LedgerEvent | null> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_ledger_event", {
      p_id: id,
    });
    return result ? LedgerEventSchema.parse(result) : null;
  }

  async markEventOutboxProcessed(id: string, leaseToken?: string): Promise<void> {
    await this.rpcClient.rpc("distillery_mark_event_outbox_processed", {
      p_id: id,
      p_lease_token: leaseToken ?? null,
    });
  }

  async markEventOutboxFailed(id: string, error: string, leaseToken?: string): Promise<void> {
    await this.rpcClient.rpc("distillery_mark_event_outbox_failed", {
      p_id: id,
      p_error: error,
      p_lease_token: leaseToken ?? null,
    });
  }

  async enqueuePendingWork(input: {
    tenantId: string;
    policy: PolicyName;
    subjectType: WorkSubjectType;
    subjectId: string;
    causedByEventId: string;
    inputVersion: string;
  }): Promise<{ workItem: PendingWorkItem; inserted: boolean }> {
    const result = await this.rpcClient.rpc<unknown>("distillery_enqueue_pending_work", {
      p_tenant_id: input.tenantId,
      p_policy: input.policy,
      p_subject_type: input.subjectType,
      p_subject_id: input.subjectId,
      p_caused_by_event_id: input.causedByEventId,
      p_input_version: input.inputVersion,
    });
    const parsed = PendingWorkEnqueueResponseSchema.parse(result);
    return {
      workItem: PendingWorkItemSchema.parse(parsed.workItem),
      inserted: parsed.inserted,
    };
  }

  async claimPendingWork(workItemId?: string, leaseSeconds?: number): Promise<PendingWorkItem | null> {
    const result = await this.rpcClient.rpc<unknown>("distillery_claim_pending_work", {
      p_work_item_id: workItemId ?? null,
      p_lease_seconds: leaseSeconds ?? 900,
    });
    return result ? PendingWorkItemSchema.parse(result) : null;
  }

  async renewPendingWorkLease(id: string, leaseToken: string, leaseSeconds?: number): Promise<PendingWorkItem | null> {
    const result = await this.rpcClient.rpc<unknown>("distillery_renew_pending_work_lease", {
      p_id: id,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds ?? 900,
    });
    return result ? PendingWorkItemSchema.parse(result) : null;
  }

  async completePendingWork(id: string, leaseToken?: string): Promise<void> {
    await this.rpcClient.rpc("distillery_complete_pending_work", {
      p_id: id,
      p_lease_token: leaseToken ?? null,
    });
  }

  async failPendingWork(id: string, error: string, leaseToken?: string): Promise<void> {
    await this.rpcClient.rpc("distillery_fail_pending_work", {
      p_id: id,
      p_error: error,
      p_lease_token: leaseToken ?? null,
    });
  }

  async cancelPendingWork(id: string, reason: string): Promise<void> {
    await this.rpcClient.rpc("distillery_cancel_pending_work", { p_id: id, p_reason: reason });
  }

  async recoverExpiredLoopClaims(input: {
    tenantId: string;
    now?: string;
    maxOutboxAttempts?: number;
    maxWorkAttempts?: number;
  }): Promise<LoopRecoveryResult> {
    const result = await this.rpcClient.rpc<unknown>("distillery_recover_expired_loop_claims", {
      p_tenant_id: input.tenantId,
      p_now: input.now ?? null,
      p_max_outbox_attempts: input.maxOutboxAttempts ?? 5,
      p_max_work_attempts: input.maxWorkAttempts ?? 3,
    });
    return LoopRecoveryResponseSchema.parse(result);
  }

  async listRecoveredPendingWork(input: { tenantId: string; limit: number }): Promise<PendingWorkItem[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_list_recovered_pending_work", {
      p_tenant_id: input.tenantId,
      p_limit: input.limit,
    });
    return PendingWorkItemSchema.array().parse(result);
  }

  async createPolicyRun(input: Omit<PolicyRun, "createdAt"> & { createdAt?: string }): Promise<PolicyRun> {
    const result = await this.rpcClient.rpc<unknown>("distillery_create_policy_run", {
      p_policy_run: input,
    });
    return PolicyRunSchema.parse(result);
  }

  async completePolicyRun(id: string, input: Partial<PolicyRun>, leaseToken?: string): Promise<void> {
    await this.rpcClient.rpc("distillery_complete_policy_run", {
      p_id: id,
      p_patch: input,
      p_lease_token: leaseToken ?? null,
    });
  }

  async failPolicyRun(
    id: string,
    error: string,
    issues: PolicyRun["validationIssues"] = [],
    leaseToken?: string,
  ): Promise<void> {
    await this.rpcClient.rpc("distillery_fail_policy_run", {
      p_id: id,
      p_error: error,
      p_issues: issues,
      p_lease_token: leaseToken ?? null,
    });
  }

  async createProposedEvent(input: Omit<ProposedEvent, "createdAt" | "updatedAt" | "validationStatus" | "validationIssues" | "reviewStatus" | "committedLedgerEventId">): Promise<ProposedEvent> {
    const result = await this.rpcClient.rpc<unknown>("distillery_create_proposed_event", {
      p_proposed_event: input,
    });
    return ProposedEventSchema.parse(result);
  }

  async commitAutoApprovedProposedEvents(
    inputs: Array<Omit<ProposedEvent, "createdAt" | "updatedAt" | "validationStatus" | "validationIssues" | "reviewStatus" | "committedLedgerEventId">>,
  ): Promise<ProposedEvent[]> {
    if (inputs.length === 0) return [];
    const result = await this.rpcClient.rpc<unknown>("distillery_commit_auto_proposed_events", {
      p_proposed_events: inputs,
    });
    return ProposedEventSchema.array().parse(result);
  }

  async markProposedEventValid(id: string): Promise<void> {
    await this.rpcClient.rpc("distillery_mark_proposed_event_valid", { p_id: id });
  }

  async markProposedEventInvalid(id: string, issues: ProposedEvent["validationIssues"]): Promise<void> {
    await this.rpcClient.rpc("distillery_mark_proposed_event_invalid", {
      p_id: id,
      p_issues: issues,
    });
  }

  async approveProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent> {
    const result = await this.rpcClient.rpc<unknown>("distillery_approve_proposed_event", {
      p_id: id,
      p_reviewer_label: decision.reviewerLabel,
      p_rationale: decision.rationale ?? null,
    });
    return ProposedEventSchema.parse(result);
  }

  async rejectProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent> {
    const result = await this.rpcClient.rpc<unknown>("distillery_reject_proposed_event", {
      p_id: id,
      p_reviewer_label: decision.reviewerLabel,
      p_rationale: decision.rationale ?? null,
    });
    return ProposedEventSchema.parse(result);
  }

  async commitValidatedProposedEvent(id: string): Promise<LedgerEvent> {
    const result = await this.rpcClient.rpc<unknown>("distillery_commit_validated_proposed_event", {
      p_id: id,
    });
    return LedgerEventSchema.parse(result);
  }

  async getIngestionContextBySourceVersionId(sourceVersionId: string): Promise<IngestionContext> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_ingestion_context_by_source_version", {
      p_source_version_id: sourceVersionId,
    });
    return IngestionContextResponseSchema.parse(result);
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
  }): Promise<string[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_commit_generated_memory", {
      p_ingestion_id: input.ingestionId,
      p_tenant_id: input.tenantId,
      p_source_version_id: input.sourceVersionId,
      p_extraction_run_id: input.extractionRunId,
      p_memory_generation_version: input.memoryGenerationVersion,
      p_items: input.items,
    });
    return IngestionResultSchema.parse(result).memoryItems.map((item) => item.id);
  }

  async upsertMemoryEmbeddings(input: {
    tenantId: string;
    embeddings: Array<{
      id: string;
      targetType: "claim" | "evidence_span" | "entity" | "schema_pattern";
      targetId: string;
      embeddingModel: string;
      embedding: number[];
      contentHash: string;
    }>;
  }): Promise<void> {
    if (input.embeddings.length === 0) return;
    await this.rpcClient.rpc("distillery_upsert_memory_embeddings", {
      p_tenant_id: input.tenantId,
      p_embeddings: input.embeddings,
    });
  }

  async getMemorySynthesisContext(input: {
    tenantId: string;
    seedMemoryItemIds: string[];
    limit: number;
  }): Promise<MemoryWithEvidence[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_memory_synthesis_context", {
      p_tenant_id: input.tenantId,
      p_seed_memory_item_ids: input.seedMemoryItemIds,
      p_limit: input.limit,
    });
    return MemoryWithEvidenceSchema.array().parse(result);
  }

  async getCorpusSynthesisState(input: { tenantId: string; limit: number; seedMemoryItemIds?: string[] }): Promise<CorpusSynthesisState> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_corpus_synthesis_state", {
      p_tenant_id: input.tenantId,
      p_limit: input.limit,
      p_seed_memory_item_ids: input.seedMemoryItemIds ?? [],
    });
    return CorpusSynthesisStateResponseSchema.parse(result);
  }

  async scheduleSynthesisScanEvents(input: { tenantId: string; limit: number }): Promise<number> {
    const result = await this.rpcClient.rpc<unknown>("distillery_schedule_synthesis_scan_events", {
      p_tenant_id: input.tenantId,
      p_limit: input.limit,
    });
    return z.number().int().min(0).parse(result);
  }

  async getRetrievalVectorCandidates(input: {
    tenantId: string;
    queryEmbedding: number[];
    targetTypes: Array<"claim" | "evidence_span" | "entity" | "schema_pattern">;
    limit: number;
    embeddingModel?: string;
  }): Promise<RetrievalCandidate[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_retrieval_vector_candidates", {
      p_tenant_id: input.tenantId,
      p_query_embedding: input.queryEmbedding,
      p_target_types: input.targetTypes,
      p_limit: input.limit,
      p_embedding_model: input.embeddingModel ?? null,
    });
    return RetrievalCandidateSchema.array().parse(result);
  }

  async getRetrievalSparseCandidates(input: {
    tenantId: string;
    queryText: string;
    limit: number;
  }): Promise<RetrievalCandidate[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_retrieval_sparse_candidates", {
      p_tenant_id: input.tenantId,
      p_query: input.queryText,
      p_limit: input.limit,
    });
    return RetrievalCandidateSchema.array().parse(result);
  }

  async getRetrievalGraphSnapshot(input: {
    tenantId: string;
    seedNodeIds: string[];
    maxNodes: number;
    maxEdges: number;
  }): Promise<RetrievalGraphSnapshot> {
    const result = await this.rpcClient.rpc<unknown>("distillery_retrieval_graph_snapshot", {
      p_tenant_id: input.tenantId,
      p_seed_node_ids: input.seedNodeIds,
      p_max_nodes: input.maxNodes,
      p_max_edges: input.maxEdges,
    });
    return RetrievalGraphSnapshotSchema.parse(result);
  }

  async hydrateRetrievalClaims(input: {
    tenantId: string;
    rankedClaims: Array<{
      claimId: string;
      rank: number;
      graphScore: number;
      vectorScore: number;
      lexicalScore: number;
    }>;
  }): Promise<HydratedRetrievalClaims> {
    const result = await this.rpcClient.rpc<unknown>("distillery_hydrate_retrieval_claims", {
      p_tenant_id: input.tenantId,
      p_ranked_claims: input.rankedClaims,
    });
    return HydratedRetrievalClaimsSchema.parse(result);
  }

  async getLoopStatus(input: {
    tenantId?: string;
    ingestionId?: string;
    limit?: number;
  } = {}): Promise<LoopStatusResponse> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_loop_status_v3", {
      p_tenant_id: input.tenantId ?? "stable",
      p_ingestion_id: input.ingestionId ?? null,
      p_limit: input.limit ?? 25,
    });
    return LoopStatusResponseSchema.parse(result);
  }

  async getMemorySectionPlan(sourceVersionId: string): Promise<StoredMemorySectionPlan | null> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_memory_section_plan", {
      p_source_version_id: sourceVersionId,
    });
    return result ? StoredMemorySectionPlanSchema.parse(result) : null;
  }

  async createMemorySectionPlan(input: Record<string, unknown>): Promise<StoredMemorySectionPlan> {
    const result = await this.rpcClient.rpc<unknown>("distillery_create_memory_section_plan", { p_plan: input });
    return StoredMemorySectionPlanSchema.parse(result);
  }

  async getMemorySectionContext(sectionId: string): Promise<{
    section: MemorySection;
    plan: StoredMemorySectionPlan;
    evidenceSpans: EvidenceSpan[];
  }> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_memory_section_context", { p_section_id: sectionId });
    return MemorySectionContextResponseSchema.parse(result);
  }

  async startMemorySection(input: { sectionId: string; workItemId: string; leaseToken: string }): Promise<MemorySection> {
    const result = await this.rpcClient.rpc<unknown>("distillery_start_memory_section", {
      p_section_id: input.sectionId,
      p_work_item_id: input.workItemId,
      p_lease_token: input.leaseToken,
    });
    return MemorySectionSchema.parse(result);
  }

  async completeMemorySection(input: {
    sectionId: string;
    workItemId: string;
    leaseToken: string;
    extractionRunId: string;
    candidateCount: number;
    autoItems: GeneratedMemoryItem[];
    reviewItems: GeneratedMemoryItem[];
  }): Promise<MemorySection> {
    const result = await this.rpcClient.rpc<unknown>("distillery_complete_memory_section", {
      p_section_id: input.sectionId,
      p_work_item_id: input.workItemId,
      p_lease_token: input.leaseToken,
      p_extraction_run_id: input.extractionRunId,
      p_candidate_count: input.candidateCount,
      p_auto_items: input.autoItems,
      p_review_items: input.reviewItems,
    });
    return MemorySectionSchema.parse(result);
  }

  async markMemorySectionPlanConsolidating(sourceVersionId: string): Promise<void> {
    await this.rpcClient.rpc("distillery_mark_memory_section_plan_consolidating", { p_source_version_id: sourceVersionId });
  }

  async retryMemorySectionIngestion(ingestionId: string): Promise<string[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_retry_memory_section_ingestion", { p_ingestion_id: ingestionId });
    return z.array(z.string().min(1)).parse(result);
  }

  async getGraphRecallContext(input: {
    tenantId: string;
    question: string;
    limit: number;
  }): Promise<GraphRecallContext> {
    const result = await this.rpcClient.rpc<unknown>("distillery_graph_recall_context", {
      p_tenant_id: input.tenantId,
      p_query: input.question,
      p_limit: input.limit,
    });
    return GraphRecallContextSchema.parse(result);
  }

  async listGraphClusters(input: {
    tenantId: string;
    limit?: number;
  }): Promise<GraphClusterSummary[]> {
    const result = await this.rpcClient.rpc<unknown>("distillery_list_graph_clusters", {
      p_tenant_id: input.tenantId,
      p_limit: input.limit ?? 50,
    });
    return GraphClusterSummarySchema.array().parse(result);
  }

  async getGraphCluster(input: {
    tenantId: string;
    clusterId: string;
  }): Promise<GraphCluster> {
    const result = await this.rpcClient.rpc<unknown>("distillery_get_graph_cluster", {
      p_tenant_id: input.tenantId,
      p_cluster_id: input.clusterId,
    });
    return GraphClusterSchema.parse(result);
  }

  async getGraphClaim(input: {
    tenantId: string;
    claimId: string;
  }): Promise<unknown> {
    return this.rpcClient.rpc<unknown>("distillery_get_graph_claim", {
      p_tenant_id: input.tenantId,
      p_claim_id: input.claimId,
    });
  }

  async reviewClaimConnection(input: {
    tenantId: string;
    connectionId: string;
    status: "accepted" | "rejected";
    reviewerLabel: string;
    rationale?: string;
  }): Promise<ClaimConnection> {
    const result = await this.rpcClient.rpc<unknown>("distillery_review_claim_connection", {
      p_tenant_id: input.tenantId,
      p_connection_id: input.connectionId,
      p_status: input.status,
      p_reviewer_label: input.reviewerLabel,
      p_rationale: input.rationale ?? null,
    });
    return ClaimConnectionSchema.parse(result);
  }

  async resolveConflict(input: {
    tenantId: string;
    conflictGroupId: string;
    resolutionId: string;
    resolutionType: string;
    winningClaimId?: string;
    reviewerLabel: string;
    rationale: string;
  }): Promise<ConflictGroup> {
    const result = await this.rpcClient.rpc<unknown>("distillery_resolve_conflict", {
      p_tenant_id: input.tenantId,
      p_conflict_group_id: input.conflictGroupId,
      p_resolution_id: input.resolutionId,
      p_resolution_type: input.resolutionType,
      p_winning_claim_id: input.winningClaimId ?? null,
      p_reviewer_label: input.reviewerLabel,
      p_rationale: input.rationale,
    });
    return ConflictGroupSchema.parse(result);
  }

  async setGraphClaimPreference(input: {
    tenantId: string;
    claimId: string;
    pinned?: boolean;
    excludeFromSynthesis?: boolean;
    reviewerLabel?: string;
    rationale?: string;
  }): Promise<unknown> {
    return this.rpcClient.rpc<unknown>("distillery_set_graph_claim_preference", {
      p_tenant_id: input.tenantId,
      p_claim_id: input.claimId,
      p_pinned: input.pinned ?? null,
      p_exclude_from_synthesis: input.excludeFromSynthesis ?? null,
      p_reviewer_label: input.reviewerLabel ?? null,
      p_rationale: input.rationale ?? null,
    });
  }

  async rebuildGraphProjection(input: { tenantId: string }): Promise<unknown> {
    return this.rpcClient.rpc<unknown>("distillery_rebuild_graph_projection", {
      p_tenant_id: input.tenantId,
    });
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

const MemorySectionContextResponseSchema = z.object({
  section: MemorySectionSchema,
  plan: StoredMemorySectionPlanSchema,
  evidenceSpans: EvidenceSpanSchema.array().min(1),
});

const PendingWorkEnqueueResponseSchema = z.object({
  workItem: PendingWorkItemSchema,
  inserted: z.boolean(),
});

const LoopRecoveryResponseSchema = z.object({
  recoveredWorkItems: PendingWorkItemSchema.array().default([]),
  recoveredOutboxCount: z.number().int().min(0),
  terminalOutboxCount: z.number().int().min(0),
  recoveredWorkCount: z.number().int().min(0),
  terminalWorkCount: z.number().int().min(0),
  suppressedSeedOutboxCount: z.number().int().min(0),
  cancelledSeedWorkCount: z.number().int().min(0),
});

const RetrievalCandidateSchema = z.object({
  source: z.enum(["vector", "sparse", "seed"]),
  targetType: z.enum(["claim", "evidence_span", "entity", "schema_pattern"]),
  targetId: z.string().min(1),
  nodeId: z.string().min(1),
  claimId: z.string().min(1).nullable().optional().transform((value) => value ?? undefined),
  score: z.number(),
  label: z.string().optional(),
});

const RetrievalGraphSnapshotSchema = z.object({
  nodes: GraphNodeSchema.array(),
  edges: GraphEdgeSchema.array(),
});

const HydratedRetrievalClaimsSchema = z.object({
  claims: GraphRetrievalClaimSchema.array(),
  conflicts: ConflictGroupSchema.array().default([]),
});

const CorpusSynthesisStateResponseSchema = z.object({
  memory: MemoryWithEvidenceSchema.array(),
  connections: ClaimConnectionSchema.array().default([]),
  similarities: SynthesisSimilaritySignalSchema.array().default([]),
  conflicts: ConflictGroupSchema.array().default([]),
  clusters: SynthesisClusterSchema.array().default([]),
  enrichment: SynthesisEnrichmentStateSchema.array().default([]),
  suggestedBriefs: SuggestedBriefSchema.array().default([]),
});
