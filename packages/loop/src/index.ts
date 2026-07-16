import {
  EVENT_TYPES,
  type ClaimConnection,
  type ConflictGroup,
  type EventOutboxRow,
  type EventType,
  type EvidenceSpan,
  type GeneratedMemoryBatch,
  type GeneratedMemoryItem,
  type GraphEdge,
  type GraphNode,
  type InitiativeBrief,
  type LedgerEvent,
  type MemoryEntity,
  type MemoryWithEvidence,
  type MemorySection,
  type StoredMemorySectionPlan,
  type PendingWorkItem,
  type PolicyName,
  type PolicyRun,
  type ProposedEvent,
  type ProposedEventType,
  type SynthesisCluster,
  type SynthesisClusterDossier,
  type SynthesisEnrichmentState,
  type SynthesisReadinessEvaluation,
  type SynthesisSimilaritySignal,
  type SuggestedBrief,
  type SlackContextBundle,
  type ValidationGateResult,
  type WorkSubjectType,
} from "@distillery/contracts";
import {
  MEMORY_GENERATION_VERSION,
  MEMORY_PROMPT_VERSION,
  MEMORY_SCHEMA_VERSION,
  type CommittableMemoryItem,
  type IngestionContext,
  consolidateSectionCandidates,
  decideMemorySectioning,
  deterministicMemorySectionPlan,
  resolveMemorySectioningConfig,
  subdivideSaturatedSection,
  validateMemorySectionPlan,
  type MemorySectioningConfig,
} from "@distillery/memory-generation";
import type {
  InitiativeBriefDraftModel,
  MemoryCandidateVerifierModel,
  MemoryConnectionScorerModel,
  MemoryConnectionScoringCandidate,
  MemoryConnectionScoringDecision,
  MemoryGenerationModel,
  MemorySectionPlannerModel,
  RetrievalRerankerModel,
} from "@distillery/model-gateway";
import type { EmbeddingModel } from "@distillery/model-gateway";
import {
  retrieveMemoryContext,
  type MemoryRetrievalPersistence,
  type RetrievalCandidate,
  type RetrievalGraphSnapshot,
} from "@distillery/memory-retrieval";
import { renderSynthesisIntent } from "@distillery/prompts";
import { MEMORY_SECTION_PROMPT_VERSION } from "@distillery/prompts";
import {
  MEMORY_SYNTHESIS_VERSION,
  CORPUS_SYNTHESIS_VERSION,
  buildClusterDossier,
  buildSynthesisBundle,
  discoverCorpusSynthesisClusters,
  evaluateClusterReadiness,
  validateInitiativeBriefDraftTraceability,
  validateSuggestedBriefDraft,
  type SynthesisBundle,
} from "@distillery/memory-synthesis";
import {
  mergeValidationResults,
  validateGeneratedMemory,
  validateHumanApprovalRequirement,
  validateLedgerEventShape,
  validatePolicyRunMetadataShape,
  validateProposedEventShape,
  validateWorkItemShape,
} from "@distillery/validation";

export type Policy<I, O> = {
  name: PolicyName;
  version: string;
  buildInput(workItem: PendingWorkItem): Promise<I>;
  run(input: I): Promise<O>;
  validate(output: O): Promise<ValidationGateResult>;
};

export type EventRoute = {
  eventType: EventType;
  policy: PolicyName;
  subjectType: WorkSubjectType;
  getSubjectId(event: LedgerEvent): string;
  getInputVersion(event: LedgerEvent): string;
  guard(event: LedgerEvent): Promise<boolean>;
};

export type ProposedEventDraft = {
  id?: string;
  proposedEventType: ProposedEventType;
  targetEventType: EventType;
  subjectType: WorkSubjectType;
  subjectId: string;
  payload: Record<string, unknown>;
  evidenceSpanIds?: string[];
  memoryItemIds?: string[];
  decisionIds?: string[];
  requiresHumanApproval: boolean;
};

export type PolicyOutput = {
  proposedEvents: ProposedEventDraft[];
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string | undefined;
  promptVersion?: string;
  schemaVersion?: string;
  outputSchemaVersion?: string;
  rawResponse?: unknown;
  validationEvidenceSpans?: EvidenceSpan[];
  policyValidationIssues?: ValidationGateResult["issues"] | undefined;
};

export type PolicyInputEnvelope<T> = {
  input: T;
  inputHash: string;
  inputSummary: Record<string, unknown>;
};

export type ConnectorPolicyRunner = {
  ingestSlackSource(saveId: string): Promise<Record<string, unknown> | void>;
  syncSlackReaction(saveId: string): Promise<Record<string, unknown> | void>;
};

export type ExtractMemoryInput = PolicyInputEnvelope<{
  ingestionId: string;
  tenantId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
  existingRelatedMemory: unknown[];
  memoryGenerationSchema: string;
}>;

export type ExtractSlackContextInput = PolicyInputEnvelope<{
  bundle: SlackContextBundle;
}>;

export type ExtractMemorySectionInput = PolicyInputEnvelope<{
  section: MemorySection;
  plan: StoredMemorySectionPlan;
  evidenceSpans: EvidenceSpan[];
  workItemId: string;
  leaseToken: string;
}>;

export type ConsolidateMemoryInput = PolicyInputEnvelope<{
  plan: StoredMemorySectionPlan;
  causedByEventId: string;
}>;

export type SynthesizeBriefInput = PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
  synthesisBundle: SynthesisBundle;
  selectedMemory: MemoryWithEvidence[];
  cluster?: SynthesisCluster;
  dossier?: SynthesisClusterDossier;
  generationIntent?: string;
}>;

export type CorpusSynthesisState = {
  memory: MemoryWithEvidence[];
  connections: ClaimConnection[];
  similarities: SynthesisSimilaritySignal[];
  conflicts: ConflictGroup[];
  clusters: SynthesisCluster[];
  enrichment: SynthesisEnrichmentState[];
  suggestedBriefs: SuggestedBrief[];
};

export type ConnectMemoryInput = PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
  memory: MemoryWithEvidence[];
}>;

export type DetectContradictionInput = PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
  memory: MemoryWithEvidence[];
}>;

type ProposedEventCreateInput = Omit<
  ProposedEvent,
  "createdAt" | "updatedAt" | "validationStatus" | "validationIssues" | "reviewStatus" | "committedLedgerEventId"
>;

export type LoopPersistence = MemoryRetrievalPersistence & {
  commitLedgerEventWithOutbox(input: Omit<LedgerEvent, "createdAt"> & { createdAt?: string }): Promise<LedgerEvent>;
  claimEventOutboxRow(leaseSeconds?: number, preferredSubjectId?: string): Promise<EventOutboxRow | null>;
  loadLedgerEvent(id: string): Promise<LedgerEvent | null>;
  markEventOutboxProcessed(id: string, leaseToken?: string): Promise<void>;
  markEventOutboxFailed(id: string, error: string, leaseToken?: string): Promise<void>;
  enqueuePendingWork(input: {
    tenantId: string;
    policy: PolicyName;
    subjectType: WorkSubjectType;
    subjectId: string;
    causedByEventId: string;
    inputVersion: string;
  }): Promise<{ workItem: PendingWorkItem; inserted: boolean }>;
  claimPendingWork(workItemId?: string, leaseSeconds?: number): Promise<PendingWorkItem | null>;
  renewPendingWorkLease(id: string, leaseToken: string, leaseSeconds?: number): Promise<PendingWorkItem | null>;
  completePendingWork(id: string, leaseToken?: string): Promise<void>;
  failPendingWork(id: string, error: string, leaseToken?: string): Promise<void>;
  cancelPendingWork(id: string, reason: string): Promise<void>;
  recoverExpiredLoopClaims(input: {
    tenantId: string;
    now?: string;
    maxOutboxAttempts?: number;
    maxWorkAttempts?: number;
  }): Promise<LoopRecoveryResult>;
  listRecoveredPendingWork(input: { tenantId: string; limit: number }): Promise<PendingWorkItem[]>;
  listPendingConnectorWork(input: { tenantId: string; limit: number }): Promise<PendingWorkItem[]>;
  createPolicyRun(input: Omit<PolicyRun, "createdAt"> & { createdAt?: string }): Promise<PolicyRun>;
  completePolicyRun(
    id: string,
    input: Partial<Pick<
      PolicyRun,
      | "provider"
      | "model"
      | "fallbackUsed"
      | "fallbackReason"
      | "promptVersion"
      | "schemaVersion"
      | "outputSchemaVersion"
      | "validationOk"
      | "validationIssues"
      | "rawResponseHash"
      | "rawResponseRef"
      | "promptTokens"
      | "completionTokens"
      | "totalTokens"
      | "estimatedCostUsd"
      | "completedAt"
      | "latencyMs"
    >>,
    leaseToken?: string,
  ): Promise<void>;
  failPolicyRun(id: string, error: string, issues?: ValidationGateResult["issues"], leaseToken?: string): Promise<void>;
  createProposedEvent(input: ProposedEventCreateInput): Promise<ProposedEvent>;
  commitAutoApprovedProposedEvents(inputs: ProposedEventCreateInput[]): Promise<ProposedEvent[]>;
  markProposedEventValid(id: string): Promise<void>;
  markProposedEventInvalid(id: string, issues: ValidationGateResult["issues"]): Promise<void>;
  approveProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent>;
  rejectProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent>;
  commitValidatedProposedEvent(id: string): Promise<LedgerEvent>;
  getIngestionContextBySourceVersionId(sourceVersionId: string): Promise<IngestionContext>;
  getSlackContextBundle(bundleId: string): Promise<SlackContextBundle>;
  recordExtractionRun(input: {
    id: string;
    ingestionId: string;
    tenantId: string;
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: string;
    rawResponse: unknown;
    status: "completed" | "failed";
  }): Promise<void>;
  commitGeneratedMemory(input: {
    ingestionId: string;
    tenantId: string;
    sourceVersionId: string;
    extractionRunId: string;
    memoryGenerationVersion: string;
    items: CommittableMemoryItem[];
  }): Promise<string[]>;
  upsertMemoryEmbeddings(input: {
    tenantId: string;
    embeddings: Array<{
      id: string;
      targetType: "claim" | "evidence_span" | "entity" | "schema_pattern";
      targetId: string;
      embeddingModel: string;
      embedding: number[];
      contentHash: string;
    }>;
  }): Promise<void>;
  getMemorySynthesisContext(input: {
    tenantId: string;
    seedMemoryItemIds: string[];
    limit: number;
  }): Promise<MemoryWithEvidence[]>;
  getCorpusSynthesisState(input: { tenantId: string; limit: number; seedMemoryItemIds?: string[] }): Promise<CorpusSynthesisState>;
  rebuildGraphProjection(input: { tenantId: string }): Promise<unknown>;
  scheduleSynthesisScanEvents(input: { tenantId: string; limit: number }): Promise<number>;
  getMemorySectionPlan(sourceVersionId: string): Promise<StoredMemorySectionPlan | null>;
  createMemorySectionPlan(input: Record<string, unknown>): Promise<StoredMemorySectionPlan>;
  getMemorySectionContext(sectionId: string): Promise<{ section: MemorySection; plan: StoredMemorySectionPlan; evidenceSpans: EvidenceSpan[] }>;
  startMemorySection(input: { sectionId: string; workItemId: string; leaseToken: string }): Promise<MemorySection>;
  completeMemorySection(input: {
    sectionId: string;
    workItemId: string;
    leaseToken: string;
    extractionRunId: string;
    candidateCount: number;
    autoItems: GeneratedMemoryItem[];
    reviewItems: GeneratedMemoryItem[];
  }): Promise<MemorySection>;
  markMemorySectionPlanConsolidating(sourceVersionId: string): Promise<void>;
};

export type QueueLike = {
  send(message: { workItemId: string }): Promise<unknown>;
};

export type LoopRecoveryResult = {
  recoveredWorkItems: PendingWorkItem[];
  recoveredOutboxCount: number;
  terminalOutboxCount: number;
  recoveredWorkCount: number;
  terminalWorkCount: number;
  suppressedSeedOutboxCount: number;
  cancelledSeedWorkCount: number;
};

export type LoopMaintenanceResult = LoopRecoveryResult & {
  routedWorkItems: PendingWorkItem[];
  scheduledScanCount: number;
};

export const DEFAULT_OUTBOX_LEASE_SECONDS = 120;
export const DEFAULT_WORK_LEASE_SECONDS = 15 * 60;
export const DEFAULT_ROUTER_BATCH_SIZE = 25;

export const eventRoutes: EventRoute[] = [
  route("slack_context_committed", "extract_slack_context", "context_bundle"),
  route("source_committed", "extract_memory", "source"),
  route("memory_section_ready", "extract_memory_section", "section"),
  {
    ...route("memory_section_completed", "consolidate_memory", "source"),
    getSubjectId: (event) => String(event.payload.sourceVersionId ?? event.subjectId),
    getInputVersion: (event) => `${String(event.payload.planId ?? event.inputVersion ?? event.id)}:${String(event.payload.completedSectionOrdinal ?? event.id)}`,
  },
  route("memory_committed", "connect_memory", "memory"),
  route("memory_committed", "detect_contradiction", "memory"),
  route("memory_committed", "update_embeddings", "memory"),
  route("memory_committed", "update_graph", "memory"),
  route("memory_committed", "discover_candidate", "memory"),
  route("memory_committed", "check_freshness", "memory"),
  route("memory_committed", "recompute_cluster", "memory"),
  route("memory_connected", "recompute_cluster", "memory"),
  route("connections_updated", "update_graph", "memory"),
  route("connections_updated", "recompute_cluster", "memory"),
  route("contradiction_recorded", "recompute_cluster", "memory"),
  route("contradictions_updated", "update_graph", "memory"),
  route("contradictions_updated", "recompute_cluster", "memory"),
  route("embeddings_updated", "recompute_cluster", "memory"),
  route("graph_updated", "recompute_cluster", "memory"),
  route("memory_confirmed", "recompute_cluster", "memory"),
  route("memory_confirmed", "update_graph", "memory"),
  route("memory_edited", "connect_memory", "memory"),
  route("memory_edited", "detect_contradiction", "memory"),
  route("memory_edited", "update_embeddings", "memory"),
  route("memory_edited", "update_graph", "memory"),
  route("memory_edited", "discover_candidate", "memory"),
  route("memory_edited", "check_freshness", "memory"),
  route("memory_edited", "recompute_cluster", "memory"),
  route("memory_removed", "update_graph", "memory"),
  route("memory_removed", "recompute_cluster", "memory"),
  route("memory_review_changed", "update_graph", "memory"),
  route("memory_review_changed", "recompute_cluster", "memory"),
  route("synthesis_neighborhood_dirty", "recompute_cluster", "memory"),
  route("cluster_changed", "evaluate_synthesis_readiness", "cluster"),
  {
    ...route("synthesis_ready", "synthesize_brief", "cluster"),
    getInputVersion: (event) => `${String(event.payload.clusterVersion ?? event.inputVersion ?? event.id)}:${String(event.payload.generationIntent ?? "initiative_brief")}`,
  },
  route("candidate_created", "rank_candidate", "candidate"),
  route("candidate_approved", "draft_artifact", "candidate"),
  route("artifact_drafted", "gate_output", "artifact"),
  route("artifact_rejected", "revise_artifact", "artifact"),
  route("decision_committed", "check_freshness", "decision"),
];

export async function routeCommittedEvents(args: {
  persistence: LoopPersistence;
  queue?: QueueLike;
  maxRows?: number;
  outboxLeaseSeconds?: number;
  preferredSubjectId?: string;
}): Promise<PendingWorkItem[]> {
  const workItems: PendingWorkItem[] = [];
  const maxRows = args.maxRows ?? DEFAULT_ROUTER_BATCH_SIZE;

  for (let count = 0; count < maxRows; count += 1) {
    const outboxRow = await args.persistence.claimEventOutboxRow(
      args.outboxLeaseSeconds ?? DEFAULT_OUTBOX_LEASE_SECONDS,
      count === 0 ? args.preferredSubjectId : undefined,
    );
    if (!outboxRow) break;

    try {
      const event = await args.persistence.loadLedgerEvent(outboxRow.ledgerEventId);
      if (!event) throw new Error(`ledger event not found: ${outboxRow.ledgerEventId}`);

      for (const routeRule of eventRoutes.filter((candidate) => candidate.eventType === event.eventType)) {
        if (!await routeRule.guard(event)) continue;
        const routed = await args.persistence.enqueuePendingWork({
          tenantId: event.tenantId,
          policy: routeRule.policy,
          subjectType: routeRule.subjectType,
          subjectId: routeRule.getSubjectId(event),
          causedByEventId: event.id,
          inputVersion: routeRule.getInputVersion(event),
        });
        if (routed.workItem.status === "pending") {
          workItems.push(routed.workItem);
          await args.queue?.send({ workItemId: routed.workItem.id });
        }
      }

      await args.persistence.markEventOutboxProcessed(outboxRow.id, outboxRow.leaseToken ?? undefined);
    } catch (error) {
      await args.persistence.markEventOutboxFailed(
        outboxRow.id,
        error instanceof Error ? error.message : String(error),
        outboxRow.leaseToken ?? undefined,
      );
      break;
    }
  }

  return workItems;
}

export async function maintainLoop(args: {
  persistence: LoopPersistence;
  queue: QueueLike;
  tenantId: string;
  maxRows?: number;
  recoveredWorkLimit?: number;
  now?: string;
  maxOutboxAttempts?: number;
  maxWorkAttempts?: number;
}): Promise<LoopMaintenanceResult> {
  const recovery = await args.persistence.recoverExpiredLoopClaims({
    tenantId: args.tenantId,
    ...(args.now ? { now: args.now } : {}),
    ...(args.maxOutboxAttempts ? { maxOutboxAttempts: args.maxOutboxAttempts } : {}),
    ...(args.maxWorkAttempts ? { maxWorkAttempts: args.maxWorkAttempts } : {}),
  });

  const recoveredPendingWork = await args.persistence.listRecoveredPendingWork({
    tenantId: args.tenantId,
    limit: args.recoveredWorkLimit ?? args.maxRows ?? DEFAULT_ROUTER_BATCH_SIZE,
  });
  const pendingConnectorWork = await args.persistence.listPendingConnectorWork({
    tenantId: args.tenantId,
    limit: args.recoveredWorkLimit ?? args.maxRows ?? DEFAULT_ROUTER_BATCH_SIZE,
  });
  const wakeups = new Map(
    [...recoveredPendingWork, ...pendingConnectorWork].map((workItem) => [workItem.id, workItem]),
  );
  for (const workItem of wakeups.values()) {
    await args.queue.send({ workItemId: workItem.id });
  }

  const scheduledScanCount = await args.persistence.scheduleSynthesisScanEvents({
    tenantId: args.tenantId,
    limit: Math.max(1, Math.min(10, args.maxRows ?? DEFAULT_ROUTER_BATCH_SIZE)),
  });

  const routedWorkItems = await routeCommittedEvents({
    persistence: args.persistence,
    queue: args.queue,
    maxRows: args.maxRows ?? DEFAULT_ROUTER_BATCH_SIZE,
  });

  return { ...recovery, routedWorkItems, scheduledScanCount };
}

export function createPolicies(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  memorySectionPlannerModel?: MemorySectionPlannerModel;
  memorySectioningConfig?: Partial<MemorySectioningConfig>;
  memoryVerifierModel?: MemoryCandidateVerifierModel;
  memoryConnectionScorerModel?: MemoryConnectionScorerModel;
  embeddingModel?: EmbeddingModel;
  retrievalRerankerModel?: RetrievalRerankerModel;
  initiativeBriefDraftModel?: InitiativeBriefDraftModel;
  connectorPolicyRunner?: ConnectorPolicyRunner;
  newId?: (prefix: string) => string;
}): Record<PolicyName, Policy<unknown, PolicyOutput>> {
  const extractMemory = createExtractMemoryPolicy({
    persistence: args.persistence,
    memoryModel: args.memoryModel,
    ...(args.memorySectionPlannerModel ? { memorySectionPlannerModel: args.memorySectionPlannerModel } : {}),
    memorySectioningConfig: resolveMemorySectioningConfig(args.memorySectioningConfig),
    ...(args.memoryVerifierModel ? { memoryVerifierModel: args.memoryVerifierModel } : {}),
    ...(args.newId ? { newId: args.newId } : {}),
  });
  const extractSlackContext = createExtractSlackContextPolicy({
    persistence: args.persistence,
    memoryModel: args.memoryModel,
    ...(args.memoryVerifierModel ? { memoryVerifierModel: args.memoryVerifierModel } : {}),
    ...(args.newId ? { newId: args.newId } : {}),
  });
  const extractMemorySection = createExtractMemorySectionPolicy({
    persistence: args.persistence,
    memoryModel: args.memoryModel,
    ...(args.memoryVerifierModel ? { memoryVerifierModel: args.memoryVerifierModel } : {}),
    ...(args.newId ? { newId: args.newId } : {}),
  });
  const consolidateMemory = createConsolidateMemoryPolicy({
    persistence: args.persistence,
    ...(args.newId ? { newId: args.newId } : {}),
  });
  const connectMemory = createConnectMemoryPolicy(args);
  const detectContradiction = createDetectContradictionPolicy(args);
  const updateEmbeddings = createUpdateEmbeddingsPolicy(args);
  const updateGraph = createUpdateGraphPolicy(args);
  const recomputeCluster = createRecomputeClusterPolicy(args);
  const evaluateReadiness = createEvaluateSynthesisReadinessPolicy(args);
  const synthesizeBrief = createSynthesizeBriefPolicy(args);
  return {
    ingest_slack_source: connectorSideEffectPolicy("ingest_slack_source", args.connectorPolicyRunner?.ingestSlackSource),
    extract_slack_context: extractSlackContext as Policy<unknown, PolicyOutput>,
    sync_slack_reaction: connectorSideEffectPolicy("sync_slack_reaction", args.connectorPolicyRunner?.syncSlackReaction),
    extract_memory: extractMemory as Policy<unknown, PolicyOutput>,
    extract_memory_section: extractMemorySection as Policy<unknown, PolicyOutput>,
    consolidate_memory: consolidateMemory as Policy<unknown, PolicyOutput>,
    connect_memory: connectMemory as Policy<unknown, PolicyOutput>,
    discover_candidate: deterministicNoopPolicy("discover_candidate", "candidate_proposed", "candidate_created"),
    check_freshness: deterministicNoopPolicy("check_freshness", "freshness_warning_proposed", "freshness_warning_committed"),
    detect_contradiction: detectContradiction as Policy<unknown, PolicyOutput>,
    update_embeddings: updateEmbeddings as Policy<unknown, PolicyOutput>,
    update_graph: updateGraph as Policy<unknown, PolicyOutput>,
    recompute_cluster: recomputeCluster as Policy<unknown, PolicyOutput>,
    evaluate_synthesis_readiness: evaluateReadiness as Policy<unknown, PolicyOutput>,
    synthesize_brief: synthesizeBrief as Policy<unknown, PolicyOutput>,
    rank_candidate: deterministicNoopPolicy("rank_candidate", "candidate_proposed", "candidate_created"),
    draft_artifact: deterministicNoopPolicy("draft_artifact", "artifact_draft_proposed", "artifact_drafted"),
    gate_output: deterministicNoopPolicy("gate_output", "decision_record_proposed", "decision_committed"),
    revise_artifact: deterministicNoopPolicy("revise_artifact", "artifact_draft_proposed", "artifact_drafted"),
  };
}

function connectorSideEffectPolicy(
  name: "ingest_slack_source" | "sync_slack_reaction",
  runner: ((saveId: string) => Promise<Record<string, unknown> | void>) | undefined,
): Policy<PolicyInputEnvelope<{ saveId: string }>, PolicyOutput> {
  return {
    name,
    version: `${name}-v1`,
    async buildInput(workItem) {
      const input = { saveId: workItem.subjectId };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify(input)),
        inputSummary: { connectorSaveId: workItem.subjectId },
      };
    },
    async run(envelope) {
      if (!runner) throw new Error(`${name} requires a connector policy runner.`);
      const result = await runner(envelope.input.saveId);
      return {
        proposedEvents: [],
        provider: "slack",
        model: name,
        promptVersion: "slack-connector-v1",
        schemaVersion: "slack-connector-v1",
        outputSchemaVersion: "slack-connector-v1",
        ...(result ? { rawResponse: result } : {}),
      };
    },
    async validate() {
      return { ok: true, issues: [] };
    },
  };
}

function sectionReadyDraft(plan: StoredMemorySectionPlan, section: MemorySection): ProposedEventDraft {
  return {
    id: `pevt_section_ready_${section.id}`,
    proposedEventType: "section_update_proposed",
    targetEventType: "memory_section_ready",
    subjectType: "section",
    subjectId: section.id,
    payload: {
      planId: plan.id,
      ingestionId: plan.ingestionId,
      sourceVersionId: plan.sourceVersionId,
      sectionId: section.id,
      sectionOrdinal: section.ordinal,
      sectionTitle: section.title,
      sectionCount: plan.sections.length,
    },
    evidenceSpanIds: [section.startEvidenceSpanId, section.endEvidenceSpanId],
    requiresHumanApproval: false,
  };
}

function createExtractMemorySectionPolicy(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  memoryVerifierModel?: MemoryCandidateVerifierModel;
  newId?: (prefix: string) => string;
}): Policy<ExtractMemorySectionInput, PolicyOutput> {
  return {
    name: "extract_memory_section",
    version: "extract-memory-section-v0.1",
    async buildInput(workItem) {
      if (!workItem.leaseToken) throw new Error("Section work requires a lease token.");
      const context = await args.persistence.getMemorySectionContext(workItem.subjectId);
      const section = await args.persistence.startMemorySection({
        sectionId: workItem.subjectId,
        workItemId: workItem.id,
        leaseToken: workItem.leaseToken,
      });
      const input = {
        ...context,
        section,
        workItemId: workItem.id,
        leaseToken: workItem.leaseToken,
      };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify({
          sectionId: section.id,
          evidenceSpanIds: context.evidenceSpans.map((span) => span.id),
          sourceVersionId: section.sourceVersionId,
        })),
        inputSummary: {
          ingestionId: section.ingestionId,
          sourceVersionId: section.sourceVersionId,
          sectionId: section.id,
          sectionOrdinal: section.ordinal,
          sectionCount: context.plan.sections.length,
          evidenceSpanCount: context.evidenceSpans.length,
        },
      };
    },
    async run(envelope) {
      if (envelope.input.section.status === "completed") {
        return sectionCompletedOutput(envelope.input.plan, envelope.input.section);
      }

      structuredSectionLog("memory_section_extraction_started", {
        ingestionId: envelope.input.section.ingestionId,
        sourceVersionId: envelope.input.section.sourceVersionId,
        sectionId: envelope.input.section.id,
        sectionOrdinal: envelope.input.section.ordinal,
        sectionCount: envelope.input.plan.sections.length,
      });

      const extracted = await extractSectionCandidatesWithSubdivision({
        ingestionId: envelope.input.section.ingestionId,
        sourceVersionId: envelope.input.section.sourceVersionId,
        evidenceSpans: envelope.input.evidenceSpans,
        memoryModel: args.memoryModel,
        ...(args.memoryVerifierModel ? { memoryVerifierModel: args.memoryVerifierModel } : {}),
        maxSubdivisionDepth: 3,
      });
      const extractionRunId = `extr_${envelope.input.section.id}`;
      await args.persistence.recordExtractionRun({
        id: extractionRunId,
        ingestionId: envelope.input.section.ingestionId,
        tenantId: envelope.input.section.tenantId,
        provider: "openrouter",
        model: extracted.models.join("+") || "deterministic-fallback",
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: extracted.raw,
        status: "completed",
      });
      const completed = await args.persistence.completeMemorySection({
        sectionId: envelope.input.section.id,
        workItemId: envelope.input.workItemId,
        leaseToken: envelope.input.leaseToken,
        extractionRunId,
        candidateCount: extracted.candidateCount,
        autoItems: extracted.autoItems,
        reviewItems: extracted.reviewItems,
      });
      structuredSectionLog("memory_section_extraction_completed", {
        ingestionId: completed.ingestionId,
        sourceVersionId: completed.sourceVersionId,
        sectionId: completed.id,
        sectionOrdinal: completed.ordinal,
        sectionCount: envelope.input.plan.sections.length,
        candidateCount: completed.candidateCount,
      });
      return {
        ...sectionCompletedOutput(envelope.input.plan, completed),
        provider: "openrouter",
        model: extracted.models.join("+") || "deterministic-fallback",
        fallbackUsed: extracted.fallbackReasons.length > 0,
        fallbackReason: extracted.fallbackReasons.join(" | ") || undefined,
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: extracted.raw,
      };
    },
    async validate(output) {
      const event = output.proposedEvents[0];
      if (output.proposedEvents.length !== 1 || event?.proposedEventType !== "section_update_proposed" || event.targetEventType !== "memory_section_completed") {
        return { ok: false, issues: [{ code: "invalid_section_completion", message: "Section extraction must emit one completion event.", path: ["proposedEvents"] }] };
      }
      return { ok: true, issues: [] };
    },
  };
}

function sectionCompletedOutput(plan: StoredMemorySectionPlan, section: MemorySection): PolicyOutput {
  return {
    proposedEvents: [{
      id: `pevt_section_completed_${section.id}`,
      proposedEventType: "section_update_proposed",
      targetEventType: "memory_section_completed",
      subjectType: "section",
      subjectId: section.id,
      payload: {
        planId: plan.id,
        ingestionId: plan.ingestionId,
        sourceVersionId: plan.sourceVersionId,
        sectionId: section.id,
        completedSectionOrdinal: section.ordinal,
        sectionTitle: section.title,
        sectionCount: plan.sections.length,
        candidateCount: section.candidateCount,
      },
      evidenceSpanIds: [section.startEvidenceSpanId, section.endEvidenceSpanId],
      requiresHumanApproval: false,
    }],
    validationEvidenceSpans: [],
  };
}

async function extractSectionCandidatesWithSubdivision(args: {
  ingestionId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
  memoryModel: MemoryGenerationModel;
  memoryVerifierModel?: MemoryCandidateVerifierModel;
  maxSubdivisionDepth: number;
  depth?: number;
}): Promise<{
  autoItems: GeneratedMemoryItem[];
  reviewItems: GeneratedMemoryItem[];
  candidateCount: number;
  models: string[];
  fallbackReasons: string[];
  raw: unknown;
}> {
  const depth = args.depth ?? 0;
  let generated;
  let fallbackReason: string | undefined;
  try {
    generated = await args.memoryModel.generateMemory({
      ingestionId: args.ingestionId,
      sourceVersionId: args.sourceVersionId,
      evidenceSpans: args.evidenceSpans,
    });
  } catch (error) {
    fallbackReason = sanitizeError(error);
    generated = deterministicMemoryGenerationFallback({ evidenceSpans: args.evidenceSpans, error: fallbackReason });
  }

  if (generated.parsed.items.length >= 30) {
    const split = subdivideSaturatedSection({ evidenceSpans: args.evidenceSpans, depth, maxDepth: args.maxSubdivisionDepth });
    if (split) {
      const children = await Promise.all(split.map((evidenceSpans) => extractSectionCandidatesWithSubdivision({
        ...args,
        evidenceSpans,
        depth: depth + 1,
      })));
      return {
        autoItems: children.flatMap((child) => child.autoItems),
        reviewItems: children.flatMap((child) => child.reviewItems),
        candidateCount: children.reduce((sum, child) => sum + child.candidateCount, 0),
        models: uniqueStrings(children.flatMap((child) => child.models)),
        fallbackReasons: children.flatMap((child) => child.fallbackReasons),
        raw: { strategy: "saturation_subdivision", depth, children: children.map((child) => child.raw) },
      };
    }
  }

  const routed = await routeGeneratedMemoryCandidates({
    candidates: generated.parsed.items,
    allowedEvidenceSpans: args.evidenceSpans,
    verifierModel: args.memoryVerifierModel,
  });
  return {
    autoItems: routed.autoItems,
    reviewItems: routed.reviewItems,
    candidateCount: generated.parsed.items.length,
    models: uniqueStrings([generated.model, ...(routed.verifierModel ? [routed.verifierModel] : [])]),
    fallbackReasons: [fallbackReason, routed.verifierFallbackReason].filter((value): value is string => Boolean(value)),
    raw: {
      extractor: generated.raw,
      verifier: routed.rawVerifierResponse ?? null,
      audit: {
        rejectedCandidates: routed.rejectedCandidates,
        duplicateCandidates: routed.duplicateCandidates,
        deterministicIssues: routed.deterministicIssues,
      },
    },
  };
}

function createConsolidateMemoryPolicy(args: {
  persistence: LoopPersistence;
  newId?: (prefix: string) => string;
}): Policy<ConsolidateMemoryInput, PolicyOutput> {
  return {
    name: "consolidate_memory",
    version: "consolidate-memory-v0.1",
    async buildInput(workItem) {
      const event = await requiredLedgerEvent(args.persistence, workItem.causedByEventId);
      const sourceVersionId = String(event.payload.sourceVersionId ?? workItem.subjectId);
      const plan = await args.persistence.getMemorySectionPlan(sourceVersionId);
      if (!plan) throw new Error(`Memory section plan not found for source version: ${sourceVersionId}`);
      const input = { plan, causedByEventId: event.id };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify({
          planId: plan.id,
          sectionStates: plan.sections.map((section) => [section.id, section.status, section.candidateCount]),
        })),
        inputSummary: {
          ingestionId: plan.ingestionId,
          sourceVersionId: plan.sourceVersionId,
          sectionCount: plan.sections.length,
          completedSectionCount: plan.sections.filter((section) => section.status === "completed").length,
        },
      };
    },
    async run(envelope) {
      const incomplete = envelope.input.plan.sections.filter((section) => section.status !== "completed");
      if (incomplete.length > 0) {
        return {
          proposedEvents: [],
          provider: "deterministic",
          model: "section-completion-gate",
          promptVersion: MEMORY_SECTION_PROMPT_VERSION,
          schemaVersion: "memory-section-plan-v0.1",
          outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        };
      }

      await args.persistence.markMemorySectionPlanConsolidating(envelope.input.plan.sourceVersionId);
      const candidates = envelope.input.plan.sections.flatMap((section) => [
        ...section.autoItems.map((item) => ({ sectionOrdinal: section.ordinal, reviewRequired: false, item })),
        ...section.reviewItems.map((item) => ({ sectionOrdinal: section.ordinal, reviewRequired: true, item })),
      ]);
      const consolidated = consolidateSectionCandidates(candidates);
      const toCommittable = (item: GeneratedMemoryItem, category: "auto" | "review", index: number) => ({
        ...toCommittableMemoryItem(item, () => `mem_${envelope.input.plan.id}_${category}_${index + 1}`),
      });
      const autoItems = consolidated.autoItems.map((item, index) => toCommittable(item, "auto", index));
      const reviewItems = consolidated.reviewItems.map((item, index) => toCommittable(item, "review", index));
      const extractionRunId = `extr_${envelope.input.plan.id}_consolidated`;
      await args.persistence.recordExtractionRun({
        id: extractionRunId,
        ingestionId: envelope.input.plan.ingestionId,
        tenantId: envelope.input.plan.tenantId,
        provider: "deterministic",
        model: "cross-section-consolidation-v0.1",
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: {
          sectionCount: envelope.input.plan.sections.length,
          candidateCount: candidates.length,
          duplicateCount: consolidated.duplicateCount,
          finalCandidateCount: autoItems.length + reviewItems.length,
        },
        status: "completed",
      });

      const proposedEvents: ProposedEventDraft[] = [];
      const autoChunks = chunk(autoItems, 30);
      const reviewChunks = chunk(reviewItems, 30);
      if (autoChunks.length === 0) autoChunks.push([]);
      for (const [index, items] of autoChunks.entries()) {
        proposedEvents.push(memoryProposedDraft({
          id: `pevt_memory_${envelope.input.plan.id}_auto_${index + 1}`,
          sourceVersionId: envelope.input.plan.sourceVersionId,
          ingestionId: envelope.input.plan.ingestionId,
          extractionRunId,
          items,
          requiresHumanApproval: false,
        }));
      }
      for (const [index, items] of reviewChunks.entries()) {
        proposedEvents.push(memoryProposedDraft({
          id: `pevt_memory_${envelope.input.plan.id}_review_${index + 1}`,
          sourceVersionId: envelope.input.plan.sourceVersionId,
          ingestionId: envelope.input.plan.ingestionId,
          extractionRunId,
          items,
          requiresHumanApproval: true,
        }));
      }

      structuredSectionLog("memory_sections_consolidated", {
        ingestionId: envelope.input.plan.ingestionId,
        sourceVersionId: envelope.input.plan.sourceVersionId,
        sectionCount: envelope.input.plan.sections.length,
        candidateCount: candidates.length,
        duplicateCount: consolidated.duplicateCount,
        committedCandidateCount: autoItems.length,
        reviewCandidateCount: reviewItems.length,
      });
      return {
        proposedEvents,
        provider: "deterministic",
        model: "cross-section-consolidation-v0.1",
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: {
          sectionCount: envelope.input.plan.sections.length,
          candidateCount: candidates.length,
          duplicateCount: consolidated.duplicateCount,
          finalCandidateCount: autoItems.length + reviewItems.length,
        },
      };
    },
    async validate(output) {
      const issues = output.proposedEvents.flatMap((draft) => {
        if (draft.proposedEventType !== "memory_proposed" || draft.targetEventType !== "memory_committed") {
          return [{ code: "invalid_consolidation_proposal", message: "Consolidation may only emit memory proposals.", path: [] }];
        }
        return GeneratedMemoryBatchFromPayload(draft.payload).items.length > 30
          ? [{ code: "too_many_candidates", message: "A memory proposal may contain at most 30 candidates.", path: ["items"] }]
          : [];
      });
      return { ok: issues.length === 0, issues };
    },
  };
}

export async function executeWorkItem(args: {
  persistence: LoopPersistence;
  policies: Record<PolicyName, Policy<unknown, PolicyOutput>>;
  workItemId?: string;
  leaseSeconds?: number;
  newId?: (prefix: string) => string;
}): Promise<{ workItem: PendingWorkItem; proposedEvents: ProposedEvent[] } | null> {
  const newId = args.newId ?? defaultNewId;
  const workItem = await args.persistence.claimPendingWork(
    args.workItemId,
    args.leaseSeconds ?? DEFAULT_WORK_LEASE_SECONDS,
  );
  if (!workItem) return null;
  const leaseToken = workItem.leaseToken ?? undefined;

  const shape = validateWorkItemShape(workItem);
  if (!shape.ok) {
    await args.persistence.failPendingWork(workItem.id, renderIssues(shape.issues), leaseToken);
    return { workItem, proposedEvents: [] };
  }

  const policy = args.policies[workItem.policy];
  if (!policy) {
    await args.persistence.failPendingWork(workItem.id, `unknown policy: ${workItem.policy}`, leaseToken);
    return { workItem, proposedEvents: [] };
  }

  const startedAt = now();
  let policyRun: PolicyRun | undefined;

  try {
    const builtInput = await policy.buildInput(workItem);
    const inputEnvelope = normalizeInputEnvelope(builtInput);
    policyRun = await args.persistence.createPolicyRun({
      id: newId("polrun"),
      tenantId: workItem.tenantId,
      workItemId: workItem.id,
      causedByEventId: workItem.causedByEventId,
      policyName: policy.name,
      policyVersion: policy.version,
      status: "running",
      inputVersion: workItem.inputVersion,
      inputHash: inputEnvelope.inputHash,
      inputSummary: inputEnvelope.inputSummary,
      fallbackUsed: false,
      validationIssues: [],
      retryCount: Math.max(0, workItem.attempts - 1),
      leaseToken: workItem.leaseToken ?? null,
      leaseExpiresAt: workItem.leaseExpiresAt ?? null,
      startedAt,
      createdAt: startedAt,
    });

    const runShape = validatePolicyRunMetadataShape(policyRun);
    if (!runShape.ok) throw new Error(renderIssues(runShape.issues));

    const activeWork = leaseToken
      ? await args.persistence.renewPendingWorkLease(
        workItem.id,
        leaseToken,
        args.leaseSeconds ?? DEFAULT_WORK_LEASE_SECONDS,
      )
      : workItem;
    if (!activeWork) throw new Error(`work lease lost before policy execution: ${workItem.id}`);

    const output = await policy.run(builtInput);
    if (leaseToken && !await args.persistence.renewPendingWorkLease(
      workItem.id,
      leaseToken,
      args.leaseSeconds ?? DEFAULT_WORK_LEASE_SECONDS,
    )) {
      throw new Error(`work lease lost before output commit: ${workItem.id}`);
    }
    const validation = mergeValidationResults([
      ...(output.policyValidationIssues?.length ? [{ ok: false, issues: output.policyValidationIssues }] : []),
      await policy.validate(output),
      ...output.proposedEvents.map((draft) =>
        validateHumanApprovalRequirement(toProposedEventForValidation({
          draft,
          tenantId: workItem.tenantId,
          workItemId: workItem.id,
          policyRunId: policyRun!.id,
        }))
      ),
    ]);
    const proposedEventInputs = output.proposedEvents.map((draft) => ({
        id: draft.id ?? newId("pevt"),
        tenantId: workItem.tenantId,
        workItemId: workItem.id,
        policyRunId: policyRun!.id,
        proposedEventType: draft.proposedEventType,
        targetEventType: draft.targetEventType,
        subjectType: draft.subjectType,
        subjectId: draft.subjectId,
        payload: draft.payload,
        evidenceSpanIds: draft.evidenceSpanIds ?? [],
        memoryItemIds: draft.memoryItemIds ?? [],
        decisionIds: draft.decisionIds ?? [],
        requiresHumanApproval: draft.requiresHumanApproval,
        reviewerLabel: null,
        reviewRationale: null,
      } satisfies ProposedEventCreateInput));
    const proposedEvents: ProposedEvent[] = [];

    if (!validation.ok) {
      for (const input of proposedEventInputs) {
        const proposedEvent = await args.persistence.createProposedEvent(input);
        proposedEvents.push(proposedEvent);
        await args.persistence.markProposedEventInvalid(proposedEvent.id, validation.issues);
      }
    } else {
      const byId = new Map<string, ProposedEvent>();
      const autoApproved = await args.persistence.commitAutoApprovedProposedEvents(
        proposedEventInputs.filter((input) => !input.requiresHumanApproval),
      );
      for (const proposedEvent of autoApproved) byId.set(proposedEvent.id, proposedEvent);

      for (const input of proposedEventInputs.filter((candidate) => candidate.requiresHumanApproval)) {
        const proposedEvent = await args.persistence.createProposedEvent(input);
        await args.persistence.markProposedEventValid(proposedEvent.id);
        byId.set(proposedEvent.id, proposedEvent);
      }

      for (const input of proposedEventInputs) {
        const proposedEvent = byId.get(input.id);
        if (!proposedEvent) throw new Error(`persisted proposed event missing: ${input.id}`);
        proposedEvents.push(proposedEvent);
      }
    }

    await args.persistence.completePolicyRun(policyRun.id, {
      provider: output.provider,
      model: output.model,
      fallbackUsed: output.fallbackUsed ?? false,
      fallbackReason: output.fallbackReason,
      promptVersion: output.promptVersion,
      schemaVersion: output.schemaVersion,
      outputSchemaVersion: output.outputSchemaVersion,
      validationOk: validation.ok,
      validationIssues: validation.issues,
      rawResponseHash: output.rawResponse ? await sha256Hex(JSON.stringify(output.rawResponse)) : undefined,
      completedAt: now(),
      latencyMs: Date.now() - Date.parse(startedAt),
    }, leaseToken);

    if (!validation.ok) {
      const failure = renderIssues(validation.issues);
      await args.persistence.failPendingWork(workItem.id, failure, leaseToken);
      if (workItem.policy === "extract_memory_section") {
        structuredSectionLog("memory_section_terminal_failure", {
          workItemId: workItem.id,
          sectionId: workItem.subjectId,
          reason: sanitizeError(failure),
        });
      }
    } else {
      await args.persistence.completePendingWork(workItem.id, leaseToken);
    }

    return { workItem, proposedEvents };
  } catch (error) {
    const message = sanitizeError(error);
    if (policyRun) await args.persistence.failPolicyRun(policyRun.id, message, [], leaseToken);
    await args.persistence.failPendingWork(workItem.id, message, leaseToken);
    if (workItem.policy === "extract_memory_section") {
      structuredSectionLog("memory_section_terminal_failure", {
        workItemId: workItem.id,
        sectionId: workItem.subjectId,
        reason: message,
      });
    }
    return { workItem, proposedEvents: [] };
  }
}

export class InMemoryLoopPersistence implements LoopPersistence {
  readonly ledgerEvents = new Map<string, LedgerEvent>();
  readonly eventOutboxRows = new Map<string, EventOutboxRow>();
  readonly pendingWorkItems = new Map<string, PendingWorkItem>();
  readonly policyRuns = new Map<string, PolicyRun>();
  readonly proposedEvents = new Map<string, ProposedEvent>();
  readonly claimConnections = new Map<string, ClaimConnection>();
  readonly conflictGroups = new Map<string, ConflictGroup>();
  readonly ingestionContextsBySourceVersionId = new Map<string, IngestionContext>();
  readonly slackContextBundles = new Map<string, SlackContextBundle>();
  readonly memorySectionPlansBySourceVersionId = new Map<string, StoredMemorySectionPlan>();
  readonly memorySections = new Map<string, MemorySection>();
  readonly memorySynthesisContext = new Map<string, MemoryWithEvidence>();
  readonly retrievalGraphNodes = new Map<string, GraphNode>();
  readonly retrievalGraphEdges = new Map<string, GraphEdge>();
  readonly initiativeBriefs = new Map<string, InitiativeBrief>();
  readonly synthesisClusters = new Map<string, SynthesisCluster>();
  readonly synthesisEnrichment = new Map<string, SynthesisEnrichmentState>();
  readonly synthesisReadiness = new Map<string, SynthesisReadinessEvaluation>();
  readonly suggestedBriefKeys = new Map<string, string>();
  readonly committedMemory: CommittableMemoryItem[] = [];
  readonly extractionRuns: unknown[] = [];
  readonly memoryEmbeddings: Array<{
    id: string;
    tenantId: string;
    targetType: "claim" | "evidence_span" | "entity" | "schema_pattern";
    targetId: string;
    embeddingModel: string;
    embedding: number[];
    contentHash: string;
  }> = [];
  private synthesisSweepCursor: string | null = null;
  private synthesisSweepCycle = 0;
  private id = 0;

  async commitLedgerEventWithOutbox(input: Omit<LedgerEvent, "createdAt"> & { createdAt?: string }): Promise<LedgerEvent> {
    const existing = [...this.ledgerEvents.values()].find((event) =>
      event.tenantId === input.tenantId && event.idempotencyKey === input.idempotencyKey
    );
    if (existing) return existing;

    const event = {
      ...input,
      actorLabel: input.actorLabel ?? null,
      causedByEventId: input.causedByEventId ?? null,
      causedByWorkItemId: input.causedByWorkItemId ?? null,
      inputVersion: input.inputVersion ?? null,
      createdAt: input.createdAt ?? now(),
    };
    const shape = validateLedgerEventShape(event);
    if (!shape.ok) throw new Error(renderIssues(shape.issues));
    this.ledgerEvents.set(event.id, event);

    const outbox: EventOutboxRow = {
      id: this.nextId("eout"),
      tenantId: event.tenantId,
      ledgerEventId: event.id,
      status: "pending",
      attempts: 0,
      lastError: null,
      lockedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      recoveryCount: 0,
      lastRecoveredAt: null,
      resolutionReason: null,
      processedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (![...this.eventOutboxRows.values()].some((row) => row.ledgerEventId === event.id)) {
      this.eventOutboxRows.set(outbox.id, outbox);
    }
    return event;
  }

  async claimEventOutboxRow(
    leaseSeconds = DEFAULT_OUTBOX_LEASE_SECONDS,
    preferredSubjectId?: string,
  ): Promise<EventOutboxRow | null> {
    const row = [...this.eventOutboxRows.values()]
      .filter((candidate) => candidate.status === "pending")
      .sort((left, right) => {
        const leftPreferred = preferredSubjectId && this.ledgerEvents.get(left.ledgerEventId)?.subjectId === preferredSubjectId ? 0 : 1;
        const rightPreferred = preferredSubjectId && this.ledgerEvents.get(right.ledgerEventId)?.subjectId === preferredSubjectId ? 0 : 1;
        return leftPreferred - rightPreferred || left.createdAt.localeCompare(right.createdAt);
      })[0];
    if (!row) return null;
    row.status = "processing";
    row.attempts += 1;
    row.lockedAt = now();
    row.leaseToken = globalThis.crypto.randomUUID();
    row.leaseExpiresAt = addSeconds(row.lockedAt, leaseSeconds);
    row.updatedAt = now();
    return { ...row };
  }

  async loadLedgerEvent(id: string): Promise<LedgerEvent | null> {
    return this.ledgerEvents.get(id) ?? null;
  }

  async markEventOutboxProcessed(id: string, leaseToken?: string): Promise<void> {
    const row = this.mustGet(this.eventOutboxRows, id, "event outbox row");
    if (!leaseMatches(row.leaseToken, leaseToken)) return;
    row.status = "processed";
    row.processedAt = now();
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.updatedAt = now();
  }

  async markEventOutboxFailed(id: string, error: string, leaseToken?: string): Promise<void> {
    const row = this.mustGet(this.eventOutboxRows, id, "event outbox row");
    if (!leaseMatches(row.leaseToken, leaseToken)) return;
    row.status = row.attempts >= 5 ? "failed" : "pending";
    row.lastError = error;
    row.lockedAt = null;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.updatedAt = now();
  }

  async enqueuePendingWork(input: {
    tenantId: string;
    policy: PolicyName;
    subjectType: WorkSubjectType;
    subjectId: string;
    causedByEventId: string;
    inputVersion: string;
  }): Promise<{ workItem: PendingWorkItem; inserted: boolean }> {
    const existing = [...this.pendingWorkItems.values()].find((item) =>
      item.tenantId === input.tenantId &&
      item.policy === input.policy &&
      item.subjectType === input.subjectType &&
      item.subjectId === input.subjectId &&
      (item.causedByEventId === input.causedByEventId || item.inputVersion === input.inputVersion)
    );
    if (existing) return { workItem: existing, inserted: false };

    const workItem: PendingWorkItem = {
      id: this.nextId("work"),
      ...input,
      status: "pending",
      attempts: 0,
      lastError: null,
      lockedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      recoveryCount: 0,
      lastRecoveredAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.pendingWorkItems.set(workItem.id, workItem);
    return { workItem, inserted: true };
  }

  async claimPendingWork(workItemId?: string, leaseSeconds = DEFAULT_WORK_LEASE_SECONDS): Promise<PendingWorkItem | null> {
    const item = workItemId
      ? this.pendingWorkItems.get(workItemId)
      : [...this.pendingWorkItems.values()]
        .filter((candidate) => candidate.status === "pending")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!item || item.status !== "pending") return null;
    item.status = "running";
    item.attempts += 1;
    item.startedAt = now();
    item.lockedAt = now();
    item.leaseToken = globalThis.crypto.randomUUID();
    item.leaseExpiresAt = addSeconds(item.lockedAt, leaseSeconds);
    item.updatedAt = now();
    return { ...item };
  }

  async renewPendingWorkLease(
    id: string,
    leaseToken: string,
    leaseSeconds = DEFAULT_WORK_LEASE_SECONDS,
  ): Promise<PendingWorkItem | null> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    const current = now();
    if (
      item.status !== "running" ||
      item.leaseToken !== leaseToken ||
      !item.leaseExpiresAt ||
      Date.parse(item.leaseExpiresAt) <= Date.parse(current)
    ) return null;
    item.leaseExpiresAt = addSeconds(current, leaseSeconds);
    item.updatedAt = current;
    for (const run of this.policyRuns.values()) {
      if (run.workItemId === id && run.status === "running" && run.leaseToken === leaseToken) {
        run.leaseExpiresAt = item.leaseExpiresAt;
      }
    }
    return { ...item };
  }

  async completePendingWork(id: string, leaseToken?: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    if (!leaseMatches(item.leaseToken, leaseToken)) return;
    item.status = "completed";
    item.completedAt = now();
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.updatedAt = now();
  }

  async failPendingWork(id: string, error: string, leaseToken?: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    if (!leaseMatches(item.leaseToken, leaseToken)) return;
    item.status = "failed";
    item.lastError = error;
    item.completedAt = now();
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.updatedAt = now();
    if (item.policy === "extract_memory_section") {
      const section = this.memorySections.get(item.subjectId);
      if (section) {
        section.status = "failed";
        section.errorMessage = error.slice(0, 1_000);
        section.updatedAt = now();
        const plan = this.memorySectionPlansBySourceVersionId.get(section.sourceVersionId);
        if (plan && plan.status !== "completed") {
          plan.status = "failed";
          plan.updatedAt = now();
        }
      }
    }
  }

  async retryMemorySectionIngestion(ingestionId: string): Promise<string[]> {
    const failedSectionIds = new Set<string>();
    let sourceVersionId: string | undefined;
    for (const section of this.memorySections.values()) {
      if (section.ingestionId !== ingestionId || section.status !== "failed") continue;
      failedSectionIds.add(section.id);
      sourceVersionId = section.sourceVersionId;
      section.status = "pending";
      section.errorMessage = null;
      section.updatedAt = now();
    }
    const workIds: string[] = [];
    for (const work of this.pendingWorkItems.values()) {
      const retryable = work.status === "failed" && (
        (work.policy === "extract_memory_section" && failedSectionIds.has(work.subjectId)) ||
        ((work.policy === "extract_memory" || work.policy === "consolidate_memory") && work.subjectId === sourceVersionId)
      );
      if (!retryable) continue;
      work.status = "pending";
      work.attempts = 0;
      work.lastError = null;
      work.startedAt = null;
      work.completedAt = null;
      work.lockedAt = null;
      work.leaseToken = null;
      work.leaseExpiresAt = null;
      work.updatedAt = now();
      workIds.push(work.id);
    }
    if (sourceVersionId) {
      const plan = this.memorySectionPlansBySourceVersionId.get(sourceVersionId);
      if (plan) {
        plan.status = plan.sections.some((section) => section.status === "completed") ? "extracting" : "planned";
        plan.updatedAt = now();
      }
    }
    return workIds;
  }

  async cancelPendingWork(id: string, reason: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    item.status = "cancelled";
    item.lastError = reason;
    item.cancelledAt = now();
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.updatedAt = now();
  }

  async recoverExpiredLoopClaims(input: {
    tenantId: string;
    now?: string;
    maxOutboxAttempts?: number;
    maxWorkAttempts?: number;
  }): Promise<LoopRecoveryResult> {
    const recoveredAt = input.now ?? now();
    const maxOutboxAttempts = input.maxOutboxAttempts ?? 5;
    const maxWorkAttempts = input.maxWorkAttempts ?? 3;
    const recoveredWorkItems: PendingWorkItem[] = [];
    let recoveredOutboxCount = 0;
    let terminalOutboxCount = 0;
    let recoveredWorkCount = 0;
    let terminalWorkCount = 0;

    for (const row of this.eventOutboxRows.values()) {
      if (
        row.tenantId !== input.tenantId ||
        row.status !== "processing" ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) > Date.parse(recoveredAt)
      ) continue;
      row.recoveryCount += 1;
      row.lastRecoveredAt = recoveredAt;
      row.lastError = appendRecoveryError(row.lastError, `Router lease expired at ${row.leaseExpiresAt}.`);
      row.lockedAt = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
      row.updatedAt = recoveredAt;
      if (row.attempts >= maxOutboxAttempts) {
        row.status = "failed";
        terminalOutboxCount += 1;
      } else {
        row.status = "pending";
        recoveredOutboxCount += 1;
      }
    }

    for (const item of this.pendingWorkItems.values()) {
      if (
        item.tenantId !== input.tenantId ||
        item.status !== "running" ||
        !item.leaseExpiresAt ||
        Date.parse(item.leaseExpiresAt) > Date.parse(recoveredAt)
      ) continue;
      const expiredLeaseToken = item.leaseToken;
      for (const run of this.policyRuns.values()) {
        if (run.workItemId !== item.id || run.status !== "running") continue;
        if (expiredLeaseToken && run.leaseToken !== expiredLeaseToken) continue;
        run.status = "failed";
        run.failureKind = "lease_expired";
        run.failureReason = appendRecoveryError(run.failureReason, `Worker lease expired at ${item.leaseExpiresAt}.`);
        run.validationOk = false;
        run.completedAt = recoveredAt;
        run.leaseExpiresAt = null;
      }
      item.recoveryCount += 1;
      item.lastRecoveredAt = recoveredAt;
      item.lastError = appendRecoveryError(item.lastError, `Worker lease expired at ${item.leaseExpiresAt}.`);
      item.lockedAt = null;
      item.leaseToken = null;
      item.leaseExpiresAt = null;
      item.updatedAt = recoveredAt;
      if (item.attempts >= maxWorkAttempts) {
        item.status = "failed";
        item.completedAt = recoveredAt;
        terminalWorkCount += 1;
      } else {
        item.status = "pending";
        recoveredWorkCount += 1;
        recoveredWorkItems.push({ ...item });
      }
    }

    return {
      recoveredWorkItems,
      recoveredOutboxCount,
      terminalOutboxCount,
      recoveredWorkCount,
      terminalWorkCount,
      suppressedSeedOutboxCount: 0,
      cancelledSeedWorkCount: 0,
    };
  }

  async listRecoveredPendingWork(input: { tenantId: string; limit: number }): Promise<PendingWorkItem[]> {
    return [...this.pendingWorkItems.values()]
      .filter((item) => item.tenantId === input.tenantId && item.status === "pending" && item.recoveryCount > 0)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, input.limit)
      .map((item) => ({ ...item }));
  }

  async createPolicyRun(input: Omit<PolicyRun, "createdAt"> & { createdAt?: string }): Promise<PolicyRun> {
    const run: PolicyRun = {
      ...input,
      fallbackUsed: input.fallbackUsed ?? false,
      validationIssues: input.validationIssues ?? [],
      retryCount: input.retryCount ?? 0,
      createdAt: input.createdAt ?? now(),
    };
    this.policyRuns.set(run.id, run);
    return run;
  }

  async completePolicyRun(id: string, input: Partial<PolicyRun>, leaseToken?: string): Promise<void> {
    const run = this.mustGet(this.policyRuns, id, "policy run");
    if (!leaseMatches(run.leaseToken, leaseToken)) return;
    Object.assign(run, input, {
      status: "completed",
      completedAt: input.completedAt ?? now(),
      leaseExpiresAt: null,
    });
  }

  async failPolicyRun(
    id: string,
    error: string,
    issues: ValidationGateResult["issues"] = [],
    leaseToken?: string,
  ): Promise<void> {
    const run = this.mustGet(this.policyRuns, id, "policy run");
    if (!leaseMatches(run.leaseToken, leaseToken)) return;
    run.status = "failed";
    run.failureReason = error;
    run.validationOk = false;
    run.validationIssues = issues;
    run.completedAt = now();
    run.leaseExpiresAt = null;
    run.latencyMs = Date.now() - Date.parse(run.startedAt);
  }

  async createProposedEvent(input: ProposedEventCreateInput): Promise<ProposedEvent> {
    const existing = this.proposedEvents.get(input.id);
    if (existing) return existing;
    const proposal: ProposedEvent = {
      ...input,
      workItemId: input.workItemId ?? null,
      policyRunId: input.policyRunId ?? null,
      validationStatus: "pending",
      validationIssues: [],
      reviewStatus: input.requiresHumanApproval ? "pending" : "not_required",
      committedLedgerEventId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    const shape = validateProposedEventShape(proposal);
    if (!shape.ok) throw new Error(renderIssues(shape.issues));
    this.proposedEvents.set(proposal.id, proposal);
    return proposal;
  }

  async commitAutoApprovedProposedEvents(inputs: ProposedEventCreateInput[]): Promise<ProposedEvent[]> {
    const proposals: ProposedEvent[] = [];
    for (const input of inputs) {
      if (input.requiresHumanApproval) throw new Error(`auto-commit batch cannot include approval-required event: ${input.id}`);
      const proposal = await this.createProposedEvent(input);
      await this.markProposedEventValid(proposal.id);
      await this.commitValidatedProposedEvent(proposal.id);
      proposals.push(proposal);
    }
    return proposals;
  }

  async markProposedEventValid(id: string): Promise<void> {
    const proposal = this.mustGet(this.proposedEvents, id, "proposed event");
    proposal.validationStatus = "valid";
    proposal.validationIssues = [];
    proposal.updatedAt = now();
  }

  async markProposedEventInvalid(id: string, issues: ValidationGateResult["issues"]): Promise<void> {
    const proposal = this.mustGet(this.proposedEvents, id, "proposed event");
    proposal.validationStatus = "invalid";
    proposal.validationIssues = issues;
    proposal.updatedAt = now();
  }

  async approveProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent> {
    const proposal = this.mustGet(this.proposedEvents, id, "proposed event");
    proposal.reviewStatus = "approved";
    proposal.reviewerLabel = decision.reviewerLabel;
    proposal.reviewRationale = decision.rationale ?? null;
    proposal.updatedAt = now();
    return proposal;
  }

  async rejectProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent> {
    const proposal = this.mustGet(this.proposedEvents, id, "proposed event");
    proposal.reviewStatus = "rejected";
    proposal.reviewerLabel = decision.reviewerLabel;
    proposal.reviewRationale = decision.rationale ?? null;
    proposal.updatedAt = now();
    return proposal;
  }

  async commitValidatedProposedEvent(id: string): Promise<LedgerEvent> {
    const proposal = this.mustGet(this.proposedEvents, id, "proposed event");
    if (proposal.validationStatus !== "valid") throw new Error(`proposal is not valid: ${id}`);
    if (proposal.requiresHumanApproval && proposal.reviewStatus !== "approved") {
      throw new Error(`proposal requires approval before commit: ${id}`);
    }
    if (proposal.committedLedgerEventId) {
      const existing = this.ledgerEvents.get(proposal.committedLedgerEventId);
      if (!existing) throw new Error(`committed ledger event missing: ${proposal.committedLedgerEventId}`);
      return existing;
    }

    if (proposal.targetEventType === "memory_committed") {
      const items = GeneratedMemoryPayloadSchema(proposal.payload);
      await this.commitGeneratedMemory({
        ingestionId: String(proposal.payload.ingestionId),
        tenantId: proposal.tenantId,
        sourceVersionId: String(proposal.payload.sourceVersionId),
        extractionRunId: String(proposal.payload.extractionRunId),
        memoryGenerationVersion: String(proposal.payload.memoryGenerationVersion),
        items,
      });
      const plan = this.memorySectionPlansBySourceVersionId.get(String(proposal.payload.sourceVersionId));
      if (plan) {
        plan.status = "completed";
        plan.updatedAt = now();
      }
    }

    const suggestedDraftKey = proposal.targetEventType === "artifact_drafted" &&
      typeof proposal.payload.clusterId === "string" &&
      typeof proposal.payload.clusterVersion === "string"
      ? `${proposal.tenantId}|${proposal.payload.clusterId}|${proposal.payload.clusterVersion}|${String(proposal.payload.generationIntent ?? "initiative_brief")}`
      : null;

    if (proposal.targetEventType === "artifact_drafted") {
      this.createInitiativeBriefDraftFromProposal(proposal);
    }

    if (proposal.targetEventType === "memory_connected" || proposal.targetEventType === "connections_updated") {
      this.createMemoryConnectionsFromProposal(proposal);
    }

    if (proposal.targetEventType === "contradiction_recorded" || proposal.targetEventType === "contradictions_updated") {
      this.createConflictGroupsFromProposal(proposal);
    }

    if (["connections_updated", "contradictions_updated", "embeddings_updated", "graph_updated"].includes(proposal.targetEventType)) {
      this.recordEnrichmentCompletion(proposal);
    }

    if (proposal.targetEventType === "cluster_changed") {
      this.upsertSynthesisClusterFromProposal(proposal);
    }

    if (proposal.targetEventType === "cluster_readiness_changed" || proposal.targetEventType === "synthesis_ready") {
      this.upsertSynthesisReadinessFromProposal(proposal);
    }

    const canonicalBriefId = suggestedDraftKey
      ? this.suggestedBriefKeys.get(suggestedDraftKey) ?? proposal.subjectId
      : proposal.subjectId;
    const event = await this.commitLedgerEventWithOutbox({
      id: this.nextId("levt"),
      tenantId: proposal.tenantId,
      eventType: proposal.targetEventType,
      subjectType: proposal.subjectType,
      subjectId: canonicalBriefId,
      actorType: "policy",
      actorLabel: proposal.policyRunId ?? proposal.workItemId ?? null,
      causedByWorkItemId: proposal.workItemId ?? null,
      inputVersion: proposal.policyRunId ?? proposal.id,
      idempotencyKey: suggestedDraftKey
        ? `suggested-brief:${String(proposal.payload.clusterId)}:${String(proposal.payload.clusterVersion)}:${String(proposal.payload.generationIntent ?? "initiative_brief")}`
        : `proposal:${proposal.id}`,
      payload: proposal.payload,
    });
    proposal.committedLedgerEventId = event.id;
    proposal.updatedAt = now();
    return event;
  }

  async getIngestionContextBySourceVersionId(sourceVersionId: string): Promise<IngestionContext> {
    const context = this.ingestionContextsBySourceVersionId.get(sourceVersionId);
    if (!context) throw new Error(`ingestion context not found for source version: ${sourceVersionId}`);
    return context;
  }

  async getSlackContextBundle(bundleId: string): Promise<SlackContextBundle> {
    return this.mustGet(this.slackContextBundles, bundleId, "Slack context bundle");
  }

  async getMemorySectionPlan(sourceVersionId: string): Promise<StoredMemorySectionPlan | null> {
    return this.memorySectionPlansBySourceVersionId.get(sourceVersionId) ?? null;
  }

  async createMemorySectionPlan(input: Record<string, unknown>): Promise<StoredMemorySectionPlan> {
    const sourceVersionId = String(input.sourceVersionId);
    const existing = this.memorySectionPlansBySourceVersionId.get(sourceVersionId);
    if (existing) return existing;
    const createdAt = now();
    const sectionInputs = Array.isArray(input.sections) ? input.sections as Array<Record<string, unknown>> : [];
    const sections: MemorySection[] = sectionInputs.map((section) => ({
      id: String(section.id),
      planId: String(input.id),
      ingestionId: String(input.ingestionId),
      tenantId: String(input.tenantId),
      sourceVersionId,
      ordinal: Number(section.ordinal),
      title: String(section.title),
      startEvidenceSpanId: String(section.startEvidenceSpanId),
      endEvidenceSpanId: String(section.endEvidenceSpanId),
      startSpanIndex: Number(section.startSpanIndex),
      endSpanIndex: Number(section.endSpanIndex),
      charCount: Number(section.charCount),
      status: "pending",
      extractionRunId: null,
      candidateCount: 0,
      autoItems: [],
      reviewItems: [],
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
    }));
    const plan: StoredMemorySectionPlan = {
      id: String(input.id),
      ingestionId: String(input.ingestionId),
      tenantId: String(input.tenantId),
      sourceVersionId,
      usedSectioning: Boolean(input.usedSectioning),
      strategy: String(input.strategy) as StoredMemorySectionPlan["strategy"],
      status: "planned",
      triggerChars: Number(input.triggerChars),
      triggerSpans: Number(input.triggerSpans),
      targetChars: Number(input.targetChars),
      maxChars: Number(input.maxChars),
      maxSections: Number(input.maxSections),
      plannerModel: typeof input.plannerModel === "string" ? input.plannerModel : null,
      fallbackReason: typeof input.fallbackReason === "string" ? input.fallbackReason : null,
      sections,
      createdAt,
      updatedAt: createdAt,
    };
    this.memorySectionPlansBySourceVersionId.set(sourceVersionId, plan);
    for (const section of sections) this.memorySections.set(section.id, section);
    return plan;
  }

  async getMemorySectionContext(sectionId: string): Promise<{ section: MemorySection; plan: StoredMemorySectionPlan; evidenceSpans: EvidenceSpan[] }> {
    const section = this.mustGet(this.memorySections, sectionId, "memory section");
    const plan = this.mustGet(this.memorySectionPlansBySourceVersionId, section.sourceVersionId, "memory section plan");
    const context = await this.getIngestionContextBySourceVersionId(section.sourceVersionId);
    return { section, plan, evidenceSpans: context.evidenceSpans.slice(section.startSpanIndex, section.endSpanIndex + 1) };
  }

  async startMemorySection(input: { sectionId: string; workItemId: string; leaseToken: string }): Promise<MemorySection> {
    const work = this.mustGet(this.pendingWorkItems, input.workItemId, "pending work");
    if (work.status !== "running" || work.leaseToken !== input.leaseToken) throw new Error("active section work lease is required");
    const section = this.mustGet(this.memorySections, input.sectionId, "memory section");
    if (section.status !== "completed") {
      section.status = "processing";
      section.errorMessage = null;
      section.updatedAt = now();
    }
    const plan = this.mustGet(this.memorySectionPlansBySourceVersionId, section.sourceVersionId, "memory section plan");
    if (plan.status === "planned") {
      plan.status = "extracting";
      plan.updatedAt = now();
    }
    return section;
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
    const work = this.mustGet(this.pendingWorkItems, input.workItemId, "pending work");
    if (work.status !== "running" || work.leaseToken !== input.leaseToken) throw new Error("active section work lease is required");
    const section = this.mustGet(this.memorySections, input.sectionId, "memory section");
    section.status = "completed";
    section.extractionRunId = input.extractionRunId;
    section.candidateCount = input.candidateCount;
    section.autoItems = input.autoItems;
    section.reviewItems = input.reviewItems;
    section.errorMessage = null;
    section.updatedAt = now();
    return section;
  }

  async markMemorySectionPlanConsolidating(sourceVersionId: string): Promise<void> {
    const plan = this.mustGet(this.memorySectionPlansBySourceVersionId, sourceVersionId, "memory section plan");
    if (plan.status !== "completed" && plan.sections.every((section) => section.status === "completed")) {
      plan.status = "consolidating";
      plan.updatedAt = now();
    }
  }

  async recordExtractionRun(input: {
    id: string;
    ingestionId: string;
    tenantId: string;
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: string;
    rawResponse: unknown;
    status: "completed" | "failed";
  }): Promise<void> {
    const existing = this.extractionRuns.findIndex((record) =>
      typeof record === "object" && record !== null && "id" in record && record.id === input.id
    );
    if (existing >= 0) this.extractionRuns[existing] = input;
    else this.extractionRuns.push(input);
  }

  async commitGeneratedMemory(input: {
    ingestionId: string;
    tenantId: string;
    sourceVersionId: string;
    extractionRunId: string;
    memoryGenerationVersion: string;
    items: CommittableMemoryItem[];
  }): Promise<string[]> {
    this.committedMemory.push(...input.items);
    return input.items.map((item) => item.id);
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
    for (const embedding of input.embeddings) {
      const existingIndex = this.memoryEmbeddings.findIndex((candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.targetType === embedding.targetType &&
        candidate.targetId === embedding.targetId &&
        candidate.embeddingModel === embedding.embeddingModel &&
        candidate.contentHash === embedding.contentHash
      );
      const record = { ...embedding, tenantId: input.tenantId };
      if (existingIndex >= 0) {
        this.memoryEmbeddings[existingIndex] = record;
      } else {
        this.memoryEmbeddings.push(record);
      }
    }
  }

  async getMemorySynthesisContext(input: {
    tenantId: string;
    seedMemoryItemIds: string[];
    limit: number;
  }): Promise<MemoryWithEvidence[]> {
    const seedSet = new Set(input.seedMemoryItemIds);
    return [...this.memorySynthesisContext.values()]
      .sort((left, right) => {
        const leftSeed = seedSet.has(left.memoryItem.id) ? 0 : 1;
        const rightSeed = seedSet.has(right.memoryItem.id) ? 0 : 1;
        return leftSeed - rightSeed || left.memoryItem.id.localeCompare(right.memoryItem.id);
      })
      .slice(0, input.limit);
  }

  async listPendingConnectorWork(input: { tenantId: string; limit: number }): Promise<PendingWorkItem[]> {
    return [...this.pendingWorkItems.values()]
      .filter((work) =>
        work.tenantId === input.tenantId &&
        work.status === "pending" &&
        (work.policy === "ingest_slack_source" || work.policy === "sync_slack_reaction")
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit);
  }

  async getCorpusSynthesisState(input: { tenantId: string; limit: number; seedMemoryItemIds?: string[] }): Promise<CorpusSynthesisState> {
    const seeds = new Set(input.seedMemoryItemIds ?? []);
    return {
      memory: [...this.memorySynthesisContext.values()]
        .filter((record) => record.memoryItem.reviewState !== "removed" && record.memoryItem.reviewState !== "superseded")
        .sort((left, right) => Number(seeds.has(right.memoryItem.id)) - Number(seeds.has(left.memoryItem.id)) || left.memoryItem.id.localeCompare(right.memoryItem.id))
        .slice(0, input.limit),
      connections: [...this.claimConnections.values()].filter((connection) => connection.tenantId === input.tenantId),
      similarities: [],
      conflicts: [...this.conflictGroups.values()].filter((conflict) => conflict.tenantId === input.tenantId),
      clusters: [...this.synthesisClusters.values()].filter((cluster) => cluster.tenantId === input.tenantId),
      enrichment: [...this.synthesisEnrichment.values()],
      suggestedBriefs: [],
    };
  }

  async rebuildGraphProjection(input: { tenantId: string }): Promise<unknown> {
    this.ensureDefaultRetrievalGraph(input.tenantId);
    return {
      nodeCount: this.retrievalGraphNodes.size,
      edgeCount: this.retrievalGraphEdges.size,
    };
  }

  async scheduleSynthesisScanEvents(input: { tenantId: string; limit: number }): Promise<number> {
    const activeIds = [...this.memorySynthesisContext.values()]
      .filter((record) => record.memoryItem.reviewState !== "removed" && record.memoryItem.reviewState !== "superseded")
      .map((record) => record.memoryItem.id)
      .sort();
    if (activeIds.length === 0) return 0;
    let start = this.synthesisSweepCursor
      ? activeIds.findIndex((id) => id > this.synthesisSweepCursor!)
      : 0;
    if (start < 0) {
      start = 0;
      this.synthesisSweepCycle += 1;
    }
    const selected = activeIds.slice(start, start + Math.max(1, input.limit));
    for (const memoryItemId of selected) {
      await this.commitLedgerEventWithOutbox({
        id: this.nextId("levt"),
        tenantId: input.tenantId,
        eventType: "synthesis_neighborhood_dirty",
        subjectType: "memory",
        subjectId: memoryItemId,
        actorType: "system",
        actorLabel: "global_synthesis_sweep",
        inputVersion: `sweep:${this.synthesisSweepCycle}:${memoryItemId}`,
        idempotencyKey: `synthesis-sweep:${this.synthesisSweepCycle}:${memoryItemId}`,
        payload: { memoryItemIds: [memoryItemId], sweepCycle: this.synthesisSweepCycle },
      });
    }
    if (selected.length > 0) this.synthesisSweepCursor = selected[selected.length - 1]!;
    return selected.length;
  }

  async getRetrievalVectorCandidates(input: {
    tenantId: string;
    queryEmbedding: number[];
    targetTypes: Array<"claim" | "evidence_span" | "entity" | "schema_pattern">;
    limit: number;
    embeddingModel?: string;
  }): Promise<RetrievalCandidate[]> {
    const candidates = this.memoryEmbeddings
      .filter((embedding) =>
        embedding.tenantId === input.tenantId &&
        input.targetTypes.includes(embedding.targetType) &&
        (!input.embeddingModel || embedding.embeddingModel === input.embeddingModel)
      )
      .map((embedding): RetrievalCandidate => ({
        source: "vector",
        targetType: embedding.targetType,
        targetId: embedding.targetId,
        nodeId: nodeIdForEmbeddingTarget(embedding.targetType, embedding.targetId),
        ...(embedding.targetType === "claim" ? { claimId: embedding.targetId } : {}),
        score: cosineSimilarity(input.queryEmbedding, embedding.embedding),
      }))
      .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
      .slice(0, input.limit);
    return candidates;
  }

  async getRetrievalSparseCandidates(input: {
    tenantId: string;
    queryText: string;
    limit: number;
  }): Promise<RetrievalCandidate[]> {
    const tokens = tokenize(input.queryText);
    return [...this.memorySynthesisContext.values()]
      .filter((record) => record.memoryItem.reviewState !== "removed" && record.memoryItem.reviewState !== "superseded")
      .map((record): RetrievalCandidate => {
        const haystack = normalizeText([
          record.memoryItem.statement,
          ...record.evidenceSpans.map((span) => span.text),
          ...record.memoryItem.entities.map((entity) => entity.canonicalName ?? entity.name),
          ...record.memoryItem.schemas.map((schema) => schema.predicate),
        ].join(" "));
        const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        return {
          source: "sparse",
          targetType: "claim",
          targetId: record.memoryItem.id,
          nodeId: `claim:${record.memoryItem.id}`,
          claimId: record.memoryItem.id,
          score,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.targetId.localeCompare(right.targetId))
      .slice(0, input.limit);
  }

  async getRetrievalGraphSnapshot(input: {
    tenantId: string;
    seedNodeIds: string[];
    maxNodes: number;
    maxEdges: number;
  }): Promise<RetrievalGraphSnapshot> {
    this.ensureDefaultRetrievalGraph(input.tenantId);
    const selected = new Set(input.seedNodeIds);
    for (let depth = 0; depth < 2; depth += 1) {
      for (const edge of this.retrievalGraphEdges.values()) {
        if (edge.tenantId !== input.tenantId) continue;
        if (selected.has(edge.fromNodeId)) selected.add(edge.toNodeId);
        if (selected.has(edge.toNodeId)) selected.add(edge.fromNodeId);
        if (selected.size >= input.maxNodes) break;
      }
    }
    const nodes = [...selected]
      .map((id) => this.retrievalGraphNodes.get(id))
      .filter((node): node is GraphNode => Boolean(node))
      .slice(0, input.maxNodes);
    const nodeSet = new Set(nodes.map((node) => node.id));
    const edges = [...this.retrievalGraphEdges.values()]
      .filter((edge) => edge.tenantId === input.tenantId && nodeSet.has(edge.fromNodeId) && nodeSet.has(edge.toNodeId))
      .slice(0, input.maxEdges);
    return { nodes, edges };
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
  }): Promise<{ claims: Array<{
    claim: MemoryWithEvidence["memoryItem"];
    evidenceSpans: EvidenceSpan[];
    rank: number;
    graphScore: number;
    lexicalScore: number;
    vectorScore: number;
    connectionIds: string[];
  }>; conflicts: ConflictGroup[] }> {
    const claims = input.rankedClaims
      .map((ranked) => {
        const record = this.memorySynthesisContext.get(ranked.claimId);
        if (!record) return null;
        return {
          claim: record.memoryItem,
          evidenceSpans: record.evidenceSpans,
          rank: ranked.rank,
          graphScore: ranked.graphScore,
          lexicalScore: ranked.lexicalScore,
          vectorScore: ranked.vectorScore,
          connectionIds: [...this.claimConnections.values()]
            .filter((connection) => connection.fromClaimId === ranked.claimId || connection.toClaimId === ranked.claimId)
            .map((connection) => connection.id),
        };
      })
      .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
    const claimIds = new Set(claims.map((claim) => claim.claim.id));
    return {
      claims,
      conflicts: [...this.conflictGroups.values()].filter((conflict) =>
        conflict.status === "open" && conflict.members.some((member) => claimIds.has(member.claimId))
      ),
    };
  }

  seedIngestionContext(context: IngestionContext): void {
    this.ingestionContextsBySourceVersionId.set(context.sourceVersionId, context);
  }

  seedMemorySynthesisContext(records: MemoryWithEvidence[]): void {
    for (const record of records) {
      this.memorySynthesisContext.set(record.memoryItem.id, record);
    }
  }

  seedRetrievalGraph(input: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    for (const node of input.nodes) this.retrievalGraphNodes.set(node.id, node);
    for (const edge of input.edges) this.retrievalGraphEdges.set(edge.id, edge);
  }

  nextId(prefix: string): string {
    this.id += 1;
    return `${prefix}_${this.id}`;
  }

  private mustGet<T>(map: Map<string, T>, id: string, label: string): T {
    const value = map.get(id);
    if (!value) throw new Error(`${label} not found: ${id}`);
    return value;
  }

  private ensureDefaultRetrievalGraph(tenantId: string): void {
    for (const record of this.memorySynthesisContext.values()) {
      const claimNodeId = `claim:${record.memoryItem.id}`;
      if (!this.retrievalGraphNodes.has(claimNodeId)) {
        this.retrievalGraphNodes.set(claimNodeId, {
          id: claimNodeId,
          tenantId,
          nodeType: "claim",
          refId: record.memoryItem.id,
          label: record.memoryItem.statement.slice(0, 120),
          properties: { claimType: record.memoryItem.claimType },
        });
      }

      for (const span of record.evidenceSpans) {
        const evidenceNodeId = `evidence:${span.id}`;
        this.retrievalGraphNodes.set(evidenceNodeId, {
          id: evidenceNodeId,
          tenantId,
          nodeType: "evidence",
          refId: span.id,
          label: span.id,
          properties: {},
        });
        this.retrievalGraphEdges.set(`edge:${record.memoryItem.id}:evidence:${span.id}`, {
          id: `edge:${record.memoryItem.id}:evidence:${span.id}`,
          tenantId,
          fromNodeId: claimNodeId,
          toNodeId: evidenceNodeId,
          edgeType: "supported_by",
          weight: 1,
          properties: {},
        });
      }

      for (const entity of record.memoryItem.entities) {
        const entityNodeId = `entity:${normalizeText(entity.canonicalName ?? entity.name).replaceAll(" ", "_")}`;
        this.retrievalGraphNodes.set(entityNodeId, {
          id: entityNodeId,
          tenantId,
          nodeType: "entity",
          refId: entity.canonicalName ?? entity.name,
          label: entity.canonicalName ?? entity.name,
          properties: { entityType: entity.entityType },
        });
        this.retrievalGraphEdges.set(`edge:${record.memoryItem.id}:entity:${entityNodeId}`, {
          id: `edge:${record.memoryItem.id}:entity:${entityNodeId}`,
          tenantId,
          fromNodeId: claimNodeId,
          toNodeId: entityNodeId,
          edgeType: "mentions",
          weight: 0.8,
          properties: {},
        });
      }

      for (const schema of record.memoryItem.schemas) {
        const schemaNodeId = `schema:${normalizeText(`${schema.subjectType}:${schema.predicate}:${schema.objectType}`).replaceAll(" ", "_")}`;
        this.retrievalGraphNodes.set(schemaNodeId, {
          id: schemaNodeId,
          tenantId,
          nodeType: "schema",
          refId: `${schema.subjectType}:${schema.predicate}:${schema.objectType}`,
          label: `${schema.subjectType} ${schema.predicate} ${schema.objectType}`,
          properties: { status: schema.status },
        });
        this.retrievalGraphEdges.set(`edge:${record.memoryItem.id}:schema:${schemaNodeId}`, {
          id: `edge:${record.memoryItem.id}:schema:${schemaNodeId}`,
          tenantId,
          fromNodeId: claimNodeId,
          toNodeId: schemaNodeId,
          edgeType: "matches_schema",
          weight: 0.65,
          properties: {},
        });
      }
    }

    for (const connection of this.claimConnections.values()) {
      if (connection.tenantId !== tenantId || connection.status === "rejected") continue;
      this.retrievalGraphEdges.set(`edge:connection:${connection.id}`, {
        id: `edge:connection:${connection.id}`,
        tenantId,
        fromNodeId: `claim:${connection.fromClaimId}`,
        toNodeId: `claim:${connection.toClaimId}`,
        edgeType: connection.connectionType,
        weight: Math.max(0.1, connection.confidence),
        properties: { connectionId: connection.id, status: connection.status },
      });
    }
  }

  private createInitiativeBriefDraftFromProposal(proposal: ProposedEvent): void {
    const briefId = String(proposal.payload.briefId ?? proposal.subjectId);
    const clusterId = typeof proposal.payload.clusterId === "string" ? proposal.payload.clusterId : null;
    const clusterVersion = typeof proposal.payload.clusterVersion === "string" ? proposal.payload.clusterVersion : null;
    const generationIntent = typeof proposal.payload.generationIntent === "string"
      ? proposal.payload.generationIntent
      : "initiative_brief";
    const suggestedKey = clusterId && clusterVersion
      ? `${proposal.tenantId}|${clusterId}|${clusterVersion}|${generationIntent}`
      : null;
    if (suggestedKey && this.suggestedBriefKeys.has(suggestedKey)) return;
    if (this.initiativeBriefs.has(briefId)) return;

    const memoryItemIds = stringArray(proposal.payload.memoryItemIds ?? proposal.payload.selectedMemoryItemIds);
    const evidenceSpanIds = stringArray(proposal.payload.evidenceSpanIds ?? proposal.payload.selectedEvidenceSpanIds);
    const memoryItems = memoryItemIds
      .map((id) => this.memorySynthesisContext.get(id)?.memoryItem)
      .filter((item): item is InitiativeBrief["memoryItems"][number] => Boolean(item));
    const evidenceSpans = evidenceSpanIds
      .map((id) => [...this.memorySynthesisContext.values()]
        .flatMap((record) => record.evidenceSpans)
        .find((span) => span.id === id))
      .filter((span): span is EvidenceSpan => Boolean(span));

    this.initiativeBriefs.set(briefId, {
      id: briefId,
      title: String(proposal.payload.title ?? "Untitled initiative brief"),
      status: "draft",
      problem: String(proposal.payload.problem ?? ""),
      proposal: String(proposal.payload.proposal ?? ""),
      successMetric: String(proposal.payload.successMetric ?? ""),
      risksAndDependencies: typeof proposal.payload.risksAndDependencies === "string"
        ? proposal.payload.risksAndDependencies
        : null,
      memoryItemIds,
      evidenceSpanIds,
      memoryItems,
      evidenceSpans,
      createdByLabel: "synthesize_brief",
      createdAt: now(),
      updatedAt: now(),
      decisions: [],
    });
    if (suggestedKey) {
      this.suggestedBriefKeys.set(suggestedKey, briefId);
      const readiness = this.synthesisReadiness.get(`${clusterId}|${clusterVersion}|${generationIntent}`);
      if (readiness) readiness.state = "draft_generated";
      const cluster = clusterId ? this.synthesisClusters.get(clusterId) : undefined;
      if (cluster?.readiness && cluster.readiness.clusterVersion === clusterVersion) {
        cluster.readiness.state = "draft_generated";
      }
    }
  }

  private createMemoryConnectionsFromProposal(proposal: ProposedEvent): void {
    const connections = Array.isArray(proposal.payload.connections) ? proposal.payload.connections : [];
    for (const connection of connections) {
      if (!isRecord(connection)) continue;
      const id = String(connection.id);
      if (this.claimConnections.has(id)) continue;
      this.claimConnections.set(id, {
        id,
        tenantId: proposal.tenantId,
        fromClaimId: String(connection.fromClaimId),
        toClaimId: String(connection.toClaimId),
        connectionType: String(connection.connectionType) as ClaimConnection["connectionType"],
        status: String(connection.status ?? "proposed") as ClaimConnection["status"],
        confidence: Number(connection.confidence),
        scoreComponents: metadataRecord(connection.scoreComponents),
        evidenceSpanIds: stringArray(connection.evidenceSpanIds),
        rationale: typeof connection.rationale === "string" ? connection.rationale : null,
        createdByPolicyRunId: proposal.policyRunId ?? null,
        reviewerLabel: null,
        reviewRationale: null,
        createdAt: now(),
        updatedAt: now(),
      });
    }
  }

  private createConflictGroupsFromProposal(proposal: ProposedEvent): void {
    const conflicts = Array.isArray(proposal.payload.conflicts) ? proposal.payload.conflicts : [];
    for (const conflict of conflicts) {
      if (!isRecord(conflict)) continue;
      const id = String(conflict.id);
      if (this.conflictGroups.has(id)) continue;
      const rawMembers = Array.isArray(conflict.members) ? conflict.members : [];
      this.conflictGroups.set(id, {
        id,
        tenantId: proposal.tenantId,
        conflictType: String(conflict.conflictType) as ConflictGroup["conflictType"],
        severity: String(conflict.severity) as ConflictGroup["severity"],
        status: "open",
        summary: String(conflict.summary),
        createdByPolicyRunId: proposal.policyRunId ?? null,
        members: rawMembers.filter(isRecord).map((member) => ({
          conflictGroupId: id,
          claimId: String(member.claimId),
          role: String(member.role ?? "conflicts"),
          evidenceSpanIds: stringArray(member.evidenceSpanIds),
        })),
        createdAt: now(),
        updatedAt: now(),
      });
    }
  }

  private recordEnrichmentCompletion(proposal: ProposedEvent): void {
    const facetByEvent = {
      connections_updated: "connections",
      contradictions_updated: "contradictions",
      embeddings_updated: "embeddings",
      graph_updated: "graph",
    } as const;
    const facet = facetByEvent[proposal.targetEventType as keyof typeof facetByEvent];
    if (!facet) return;
    const ids = stringArray(proposal.payload.memoryItemIds ?? proposal.payload.seedMemoryItemIds);
    for (const memoryItemId of ids) {
      const existing = this.synthesisEnrichment.get(memoryItemId);
      const priorCompletedFacets = (existing?.completedFacets ?? []).filter((candidate) =>
        !(facet === "connections" || facet === "contradictions") || candidate !== "graph"
      );
      this.synthesisEnrichment.set(memoryItemId, {
        memoryItemId,
        inputVersion: String(proposal.payload.inputVersion ?? proposal.policyRunId ?? proposal.id),
        completedFacets: [...new Set([...priorCompletedFacets, facet])],
        failedFacets: (existing?.failedFacets ?? []).filter((candidate) => candidate !== facet),
        updatedAt: now(),
      });
    }
  }

  private upsertSynthesisClusterFromProposal(proposal: ProposedEvent): void {
    if (!isRecord(proposal.payload.cluster)) return;
    const cluster = proposal.payload.cluster as SynthesisCluster;
    const existing = this.synthesisClusters.get(cluster.id);
    if (existing?.version === cluster.version) return;
    this.synthesisClusters.set(cluster.id, cluster);
  }

  private upsertSynthesisReadinessFromProposal(proposal: ProposedEvent): void {
    if (!isRecord(proposal.payload.evaluation)) return;
    const evaluation = proposal.payload.evaluation as SynthesisReadinessEvaluation;
    const key = `${evaluation.clusterId}|${evaluation.clusterVersion}|${evaluation.generationIntent}`;
    this.synthesisReadiness.set(key, evaluation);
    const cluster = this.synthesisClusters.get(evaluation.clusterId);
    if (cluster?.version === evaluation.clusterVersion) cluster.readiness = evaluation;
  }
}

function createExtractSlackContextPolicy(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  memoryVerifierModel?: MemoryCandidateVerifierModel;
  newId?: (prefix: string) => string;
}): Policy<ExtractSlackContextInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "extract_slack_context",
    version: "extract-slack-context-v1",
    async buildInput(workItem) {
      const bundle = await args.persistence.getSlackContextBundle(workItem.subjectId);
      return {
        input: { bundle },
        inputHash: await sha256Hex(JSON.stringify({ bundleId: bundle.id, contentHash: bundle.contentHash })),
        inputSummary: {
          contextBundleId: bundle.id,
          contextVersion: bundle.version,
          selectedMessageTimestamp: bundle.selectedMessageTimestamp,
          itemCount: bundle.items.length,
          evidenceSpanCount: bundle.items.reduce((sum, item) => sum + item.evidenceSpans.length, 0),
          classification: bundle.classification.category,
        },
      };
    },
    async run(envelope) {
      const bundle = envelope.input.bundle;
      const evidenceSpans = bundle.items
        .filter((item) => item.role !== "channel_profile")
        .flatMap((item) => item.evidenceSpans);
      let generated;
      let extractorFallbackReason: string | undefined;
      try {
        generated = await args.memoryModel.generateMemory({
          ingestionId: bundle.selectedIngestionId,
          sourceVersionId: bundle.selectedSourceVersionId,
          evidenceSpans,
          slackContext: {
            selectedMessageTimestamp: bundle.selectedMessageTimestamp,
            channelProfile: bundle.channelProfile,
            classification: bundle.classification,
            items: bundle.items.map((item) => ({
              role: item.role,
              ...(typeof item.sourceMetadata.messageTimestamp === "string"
                ? { messageTimestamp: item.sourceMetadata.messageTimestamp }
                : {}),
              ...(item.authorId ? { authorId: item.authorId } : {}),
              ...(item.authorLabel ? { authorLabel: item.authorLabel } : {}),
              occurredAt: item.occurredAt,
              ...(item.permalink ? { permalink: item.permalink } : {}),
              evidenceSpanIds: item.evidenceSpans.map((span) => span.id),
            })),
          },
        });
      } catch (error) {
        extractorFallbackReason = sanitizeError(error);
        generated = {
          parsed: { items: [] },
          raw: { strategy: "deterministic_context_only", reason: extractorFallbackReason },
          model: "deterministic-context-only",
        };
      }

      const extractionRunId = newId("extr");
      const candidateRouting = await routeGeneratedMemoryCandidates({
        candidates: generated.parsed.items,
        allowedEvidenceSpans: evidenceSpans,
        verifierModel: args.memoryVerifierModel,
      });
      const autoItems = candidateRouting.autoItems.map((item) => toCommittableMemoryItem(item, newId));
      const reviewItems = candidateRouting.reviewItems.map((item) => toCommittableMemoryItem(item, newId));
      const rawResponse = {
        contextBundleId: bundle.id,
        contextVersion: bundle.version,
        classification: bundle.classification,
        extractor: generated.raw,
        verifier: candidateRouting.rawVerifierResponse ?? null,
        audit: {
          extractorFallbackReason: extractorFallbackReason ?? null,
          verifierFallbackReason: candidateRouting.verifierFallbackReason ?? null,
          rejectedCandidates: candidateRouting.rejectedCandidates,
          duplicateCandidates: candidateRouting.duplicateCandidates,
          deterministicIssues: candidateRouting.deterministicIssues,
        },
      };
      await args.persistence.recordExtractionRun({
        id: extractionRunId,
        ingestionId: bundle.selectedIngestionId,
        tenantId: bundle.tenantId,
        provider: extractorFallbackReason ? "deterministic" : "openrouter",
        model: candidateRouting.verifierModel
          ? `${generated.model}+${candidateRouting.verifierModel}`
          : generated.model,
        promptVersion: `${MEMORY_PROMPT_VERSION}+slack-context-v1`,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse,
        status: "completed",
      });

      const proposedEvents: ProposedEventDraft[] = [];
      if (autoItems.length > 0) {
        proposedEvents.push(memoryProposedDraft({
          sourceVersionId: bundle.selectedSourceVersionId,
          ingestionId: bundle.selectedIngestionId,
          extractionRunId,
          items: autoItems,
          requiresHumanApproval: false,
        }));
      }
      if (reviewItems.length > 0) {
        proposedEvents.push(memoryProposedDraft({
          sourceVersionId: bundle.selectedSourceVersionId,
          ingestionId: bundle.selectedIngestionId,
          extractionRunId,
          items: reviewItems,
          requiresHumanApproval: true,
        }));
      }
      return {
        proposedEvents,
        provider: extractorFallbackReason ? "deterministic" : "openrouter",
        model: candidateRouting.verifierModel
          ? `${generated.model}+${candidateRouting.verifierModel}`
          : generated.model,
        fallbackUsed: Boolean(extractorFallbackReason || candidateRouting.verifierFallbackReason),
        fallbackReason: extractorFallbackReason ?? candidateRouting.verifierFallbackReason,
        promptVersion: `${MEMORY_PROMPT_VERSION}+slack-context-v1`,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse,
        validationEvidenceSpans: evidenceSpans,
        policyValidationIssues: proposedEvents.length === 0 && !extractorFallbackReason && candidateRouting.deterministicIssues.length > 0
          ? candidateRouting.deterministicIssues
          : undefined,
      };
    },
    async validate(output) {
      const issues = output.proposedEvents.flatMap((draft) => {
        if (draft.proposedEventType !== "memory_proposed" || draft.targetEventType !== "memory_committed") {
          return [{ code: "invalid_slack_context_proposal", message: "Slack context extraction may only emit memory proposals.", path: [] }];
        }
        return validateGeneratedMemory({
          generated: GeneratedMemoryBatchFromPayload(draft.payload),
          allowedEvidenceSpans: output.validationEvidenceSpans ?? [],
        }).result.issues;
      });
      return { ok: issues.length === 0, issues };
    },
  };
}

function createExtractMemoryPolicy(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  memorySectionPlannerModel?: MemorySectionPlannerModel;
  memorySectioningConfig: MemorySectioningConfig;
  memoryVerifierModel?: MemoryCandidateVerifierModel;
  newId?: (prefix: string) => string;
}): Policy<ExtractMemoryInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "extract_memory",
    version: "extract-memory-v0.1",
    async buildInput(workItem) {
      const ledgerEvent = await args.persistence.loadLedgerEvent(workItem.causedByEventId);
      if (!ledgerEvent) throw new Error(`causing ledger event not found: ${workItem.causedByEventId}`);
      const sourceVersionId = ledgerEvent.subjectId;
      const context = await args.persistence.getIngestionContextBySourceVersionId(sourceVersionId);
      const input = {
        ingestionId: context.ingestionId,
        tenantId: context.tenantId,
        sourceVersionId: context.sourceVersionId,
        evidenceSpans: context.evidenceSpans,
        existingRelatedMemory: [],
        memoryGenerationSchema: MEMORY_SCHEMA_VERSION,
      };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify(input)),
        inputSummary: {
          ingestionId: context.ingestionId,
          sourceVersionId: context.sourceVersionId,
          evidenceSpanCount: context.evidenceSpans.length,
        },
      };
    },
    async run(envelope) {
      const existingPlan = await args.persistence.getMemorySectionPlan(envelope.input.sourceVersionId);
      const decision = decideMemorySectioning(envelope.input.evidenceSpans, args.memorySectioningConfig);
      structuredSectionLog("memory_sectioning_decision", {
        ingestionId: envelope.input.ingestionId,
        sourceVersionId: envelope.input.sourceVersionId,
        shouldSection: decision.shouldSection,
        charCount: decision.normalizedCharCount,
        evidenceSpanCount: decision.evidenceSpanCount,
        reasons: decision.reasons,
      });

      if (decision.shouldSection || existingPlan?.usedSectioning) {
        let storedPlan = existingPlan;
        let strategy: StoredMemorySectionPlan["strategy"] = storedPlan?.strategy ?? "model";
        let plannerModel = storedPlan?.plannerModel ?? undefined;
        let fallbackReason = storedPlan?.fallbackReason ?? undefined;
        let plannerRaw: unknown;

        if (!storedPlan) {
          let planned;
          try {
            if (!args.memorySectionPlannerModel) throw new Error("No memory section planner model is configured.");
            const response = await args.memorySectionPlannerModel.planMemorySections({
              sourceVersionId: envelope.input.sourceVersionId,
              evidenceSpans: envelope.input.evidenceSpans,
              targetChars: args.memorySectioningConfig.targetChars,
              maxChars: args.memorySectioningConfig.maxChars,
              maxSections: args.memorySectioningConfig.maxSections,
            });
            const validation = validateMemorySectionPlan({
              plan: response.parsed,
              evidenceSpans: envelope.input.evidenceSpans,
              maxChars: args.memorySectioningConfig.maxChars,
              maxSections: args.memorySectioningConfig.maxSections,
            });
            if (!validation.ok) throw new Error(renderIssues(validation.issues));
            planned = response.parsed;
            plannerModel = response.model;
            plannerRaw = response.raw;
            strategy = "model";
          } catch (error) {
            fallbackReason = sanitizeError(error);
            planned = deterministicMemorySectionPlan({
              evidenceSpans: envelope.input.evidenceSpans,
              targetChars: args.memorySectioningConfig.targetChars,
              maxChars: args.memorySectioningConfig.maxChars,
              maxSections: args.memorySectioningConfig.maxSections,
            });
            strategy = "deterministic_fallback";
          }

          const indexes = new Map(envelope.input.evidenceSpans.map((span, index) => [span.id, index]));
          storedPlan = await args.persistence.createMemorySectionPlan({
            id: newId("mplan"),
            ingestionId: envelope.input.ingestionId,
            tenantId: envelope.input.tenantId,
            sourceVersionId: envelope.input.sourceVersionId,
            usedSectioning: true,
            strategy,
            triggerChars: args.memorySectioningConfig.triggerChars,
            triggerSpans: args.memorySectioningConfig.triggerSpans,
            targetChars: args.memorySectioningConfig.targetChars,
            maxChars: args.memorySectioningConfig.maxChars,
            maxSections: args.memorySectioningConfig.maxSections,
            plannerModel: plannerModel ?? null,
            fallbackReason: fallbackReason ?? null,
            sections: planned.sections.map((section, index) => {
              const startSpanIndex = indexes.get(section.startEvidenceSpanId)!;
              const endSpanIndex = indexes.get(section.endEvidenceSpanId)!;
              return {
                id: newId("msec"),
                ordinal: index + 1,
                title: section.title,
                startEvidenceSpanId: section.startEvidenceSpanId,
                endEvidenceSpanId: section.endEvidenceSpanId,
                startSpanIndex,
                endSpanIndex,
                charCount: envelope.input.evidenceSpans[endSpanIndex]!.endChar - envelope.input.evidenceSpans[startSpanIndex]!.startChar,
              };
            }),
          });
        }

        structuredSectionLog("memory_sections_planned", {
          ingestionId: envelope.input.ingestionId,
          sourceVersionId: envelope.input.sourceVersionId,
          strategy: storedPlan.strategy,
          sectionCount: storedPlan.sections.length,
        });
        return {
          proposedEvents: storedPlan.sections.map((section) => sectionReadyDraft(storedPlan!, section)),
          provider: strategy === "model" ? "openrouter" : "deterministic",
          model: plannerModel ?? strategy,
          fallbackUsed: strategy === "deterministic_fallback",
          fallbackReason,
          promptVersion: MEMORY_SECTION_PROMPT_VERSION,
          schemaVersion: "memory-section-plan-v0.1",
          outputSchemaVersion: "memory-section-plan-v0.1",
          rawResponse: plannerRaw ?? { strategy, sectionCount: storedPlan.sections.length },
        };
      }

      if (!existingPlan) {
        await args.persistence.createMemorySectionPlan({
          id: newId("mplan"), ingestionId: envelope.input.ingestionId, tenantId: envelope.input.tenantId,
          sourceVersionId: envelope.input.sourceVersionId, usedSectioning: false, strategy: "single",
          triggerChars: args.memorySectioningConfig.triggerChars, triggerSpans: args.memorySectioningConfig.triggerSpans,
          targetChars: args.memorySectioningConfig.targetChars, maxChars: args.memorySectioningConfig.maxChars,
          maxSections: args.memorySectioningConfig.maxSections, plannerModel: null, fallbackReason: null, sections: [],
        });
      }

      let generated;
      let extractorFallbackReason: string | undefined;
      try {
        generated = await args.memoryModel.generateMemory({
          ingestionId: envelope.input.ingestionId,
          sourceVersionId: envelope.input.sourceVersionId,
          evidenceSpans: envelope.input.evidenceSpans,
        });
      } catch (error) {
        extractorFallbackReason = sanitizeError(error);
        generated = deterministicMemoryGenerationFallback({
          evidenceSpans: envelope.input.evidenceSpans,
          error: extractorFallbackReason,
        });
      }
      const extractionRunId = newId("extr");
      const candidateRouting = await routeGeneratedMemoryCandidates({
        candidates: generated.parsed.items,
        allowedEvidenceSpans: envelope.input.evidenceSpans,
        verifierModel: args.memoryVerifierModel,
      });
      const autoItems = candidateRouting.autoItems.map((item) => toCommittableMemoryItem(item, newId));
      const reviewItems = candidateRouting.reviewItems.map((item) => toCommittableMemoryItem(item, newId));
      const rawResponse = {
        extractor: generated.raw,
        verifier: candidateRouting.rawVerifierResponse ?? null,
        audit: {
          extractorFallbackReason: extractorFallbackReason ?? null,
          verifierFallbackReason: candidateRouting.verifierFallbackReason ?? null,
          rejectedCandidates: candidateRouting.rejectedCandidates,
          duplicateCandidates: candidateRouting.duplicateCandidates,
          deterministicIssues: candidateRouting.deterministicIssues,
        },
      };
      await args.persistence.recordExtractionRun({
        id: extractionRunId,
        ingestionId: envelope.input.ingestionId,
        tenantId: envelope.input.tenantId,
        provider: "openrouter",
        model: candidateRouting.verifierModel
          ? `${generated.model}+${candidateRouting.verifierModel}`
          : generated.model,
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse,
        status: "completed",
      });

      const proposedEvents: ProposedEventDraft[] = [];
      if (autoItems.length > 0) {
        proposedEvents.push(memoryProposedDraft({
          sourceVersionId: envelope.input.sourceVersionId,
          ingestionId: envelope.input.ingestionId,
          extractionRunId,
          items: autoItems,
          requiresHumanApproval: false,
        }));
      }
      if (reviewItems.length > 0) {
        proposedEvents.push(memoryProposedDraft({
          sourceVersionId: envelope.input.sourceVersionId,
          ingestionId: envelope.input.ingestionId,
          extractionRunId,
          items: reviewItems,
          requiresHumanApproval: true,
        }));
      }

      return {
        proposedEvents,
        provider: "openrouter",
        model: candidateRouting.verifierModel
          ? `${generated.model}+${candidateRouting.verifierModel}`
          : generated.model,
        fallbackUsed: Boolean(extractorFallbackReason || candidateRouting.verifierFallbackReason),
        fallbackReason: extractorFallbackReason ?? candidateRouting.verifierFallbackReason,
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse,
        validationEvidenceSpans: envelope.input.evidenceSpans,
        policyValidationIssues: proposedEvents.length === 0 && candidateRouting.deterministicIssues.length > 0
          ? candidateRouting.deterministicIssues
          : undefined,
      };
    },
    async validate(output) {
      const issues = output.proposedEvents.flatMap((draft) => {
        if (draft.proposedEventType === "section_update_proposed") {
          return draft.targetEventType === "memory_section_ready" && typeof draft.payload.sectionId === "string"
            ? []
            : [{ code: "invalid_section_dispatch", message: "Section dispatch must target memory_section_ready with a section ID.", path: [] }];
        }
        if (draft.proposedEventType !== "memory_proposed") {
          return [{ code: "invalid_memory_proposal", message: "extract_memory may only emit memory or section proposals.", path: [] }];
        }
        const parsed = GeneratedMemoryBatchFromPayload(draft.payload);
        return validateGeneratedMemory({
          generated: parsed,
          allowedEvidenceSpans: output.validationEvidenceSpans ?? [],
        }).result.issues;
      });
      return { ok: issues.length === 0, issues };
    },
  };
}

type RoutedGeneratedMemoryCandidates = {
  autoItems: GeneratedMemoryItem[];
  reviewItems: GeneratedMemoryItem[];
  rejectedCandidates: Array<{ temporaryId: string; reason: string }>;
  duplicateCandidates: Array<{ temporaryId: string; reason: string }>;
  deterministicIssues: ValidationGateResult["issues"];
  rawVerifierResponse?: unknown;
  verifierModel?: string;
  verifierFallbackReason?: string;
};

async function routeGeneratedMemoryCandidates(args: {
  candidates: GeneratedMemoryItem[];
  allowedEvidenceSpans: EvidenceSpan[];
  verifierModel?: MemoryCandidateVerifierModel | undefined;
}): Promise<RoutedGeneratedMemoryCandidates> {
  const deterministicIssues: ValidationGateResult["issues"] = [];
  const deterministicValid: GeneratedMemoryItem[] = [];
  const rejectedCandidates: Array<{ temporaryId: string; reason: string }> = [];
  const duplicateCandidates: Array<{ temporaryId: string; reason: string }> = [];
  const seenStatements = new Set<string>();

  for (const candidate of args.candidates) {
    const normalizedStatement = normalizeText(candidate.statement);
    if (seenStatements.has(normalizedStatement)) {
      duplicateCandidates.push({ temporaryId: candidate.temporaryId, reason: "Duplicate generated memory statement." });
      continue;
    }
    seenStatements.add(normalizedStatement);

    const validation = validateGeneratedMemory({
      generated: { items: [candidate] },
      allowedEvidenceSpans: args.allowedEvidenceSpans,
    });
    if (!validation.result.ok) {
      deterministicIssues.push(...validation.result.issues.map((issue) => ({
        ...issue,
        path: [candidate.temporaryId, ...issue.path],
      })));
      rejectedCandidates.push({
        temporaryId: candidate.temporaryId,
        reason: validation.result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
      continue;
    }
    deterministicValid.push(validation.items[0] ?? candidate);
  }

  if (deterministicValid.length === 0) {
    return { autoItems: [], reviewItems: [], rejectedCandidates, duplicateCandidates, deterministicIssues };
  }

  if (!args.verifierModel) {
    return {
      autoItems: deterministicValid.map((item) => annotateMemoryCandidate(item, "verified", "No verifier model configured; deterministic validation passed.", "deterministic")),
      reviewItems: [],
      rejectedCandidates,
      duplicateCandidates,
      deterministicIssues,
    };
  }

  let verifierResponse;
  try {
    verifierResponse = await args.verifierModel.verifyMemoryCandidates({
      evidenceSpans: args.allowedEvidenceSpans,
      candidates: deterministicValid,
    });
  } catch (error) {
    return {
      autoItems: [],
      reviewItems: deterministicValid.map((item) =>
        annotateMemoryCandidate(
          item,
          "needs_review",
          `Verifier unavailable; deterministic validation passed. ${error instanceof Error ? error.message : String(error)}`,
          "verifier_unavailable",
        )
      ),
      rejectedCandidates,
      duplicateCandidates,
      deterministicIssues,
      verifierFallbackReason: sanitizeError(error),
    };
  }

  const decisionsById = new Map(verifierResponse.decisions.map((decision) => [decision.temporaryId, decision]));
  const autoItems: GeneratedMemoryItem[] = [];
  const reviewItems: GeneratedMemoryItem[] = [];

  for (const candidate of deterministicValid) {
    const decision = decisionsById.get(candidate.temporaryId);
    if (!decision) {
      reviewItems.push(annotateMemoryCandidate(candidate, "needs_review", "Verifier did not return a decision for this candidate.", verifierResponse.model));
      continue;
    }

    if (decision.decision === "verified") {
      autoItems.push(annotateMemoryCandidate(candidate, "verified", decision.rationale, verifierResponse.model));
      continue;
    }

    if (decision.decision === "needs_review") {
      reviewItems.push(annotateMemoryCandidate(candidate, "needs_review", decision.rationale, verifierResponse.model));
      continue;
    }

    if (decision.decision === "corrected" && decision.correctedItem) {
      const correctedValidation = validateGeneratedMemory({
        generated: { items: [decision.correctedItem] },
        allowedEvidenceSpans: args.allowedEvidenceSpans,
      });
      if (correctedValidation.result.ok) {
        autoItems.push(annotateMemoryCandidate(
          correctedValidation.items[0] ?? decision.correctedItem,
          "corrected",
          decision.rationale,
          verifierResponse.model,
          candidate.temporaryId,
        ));
      } else {
        reviewItems.push(annotateMemoryCandidate(candidate, "needs_review", `Verifier correction failed validation: ${decision.rationale}`, verifierResponse.model));
      }
      continue;
    }

    if (decision.decision === "duplicate") {
      duplicateCandidates.push({ temporaryId: candidate.temporaryId, reason: decision.rationale });
      continue;
    }

    rejectedCandidates.push({ temporaryId: candidate.temporaryId, reason: decision.rationale || decision.decision });
  }

  return {
    autoItems,
    reviewItems,
    rejectedCandidates,
    duplicateCandidates,
    deterministicIssues,
    rawVerifierResponse: verifierResponse.raw,
    verifierModel: verifierResponse.model,
  };
}

function annotateMemoryCandidate(
  item: GeneratedMemoryItem,
  verificationStatus: string,
  rationale: string,
  verifiedBy: string,
  originalTemporaryId?: string,
): GeneratedMemoryItem {
  return {
    ...item,
    qualifiers: {
      ...item.qualifiers,
      verificationStatus,
      verificationRationale: rationale,
      verifiedBy,
      ...(originalTemporaryId ? { originalTemporaryId } : {}),
    },
  };
}

function toCommittableMemoryItem(
  item: GeneratedMemoryItem,
  newId: (prefix: string) => string,
): CommittableMemoryItem {
  return {
    id: newId("mem"),
    claimType: item.claimType,
    statement: item.statement,
    evidenceSpanIds: item.evidenceSpanIds,
    epistemicStatus: item.epistemicStatus,
    qualifiers: item.qualifiers,
    stableDomainTags: item.stableDomainTags,
    entities: sanitizeMemoryEntities(item.entities),
    relations: item.relations,
    schemas: item.schemas,
  };
}

function memoryProposedDraft(args: {
  id?: string;
  sourceVersionId: string;
  ingestionId: string;
  extractionRunId: string;
  items: CommittableMemoryItem[];
  requiresHumanApproval: boolean;
}): ProposedEventDraft {
  return {
    ...(args.id ? { id: args.id } : {}),
    proposedEventType: "memory_proposed",
    targetEventType: "memory_committed",
    subjectType: "memory",
    subjectId: args.sourceVersionId,
    payload: {
      ingestionId: args.ingestionId,
      sourceVersionId: args.sourceVersionId,
      extractionRunId: args.extractionRunId,
      memoryGenerationVersion: MEMORY_GENERATION_VERSION,
      items: args.items,
    },
    evidenceSpanIds: [...new Set(args.items.flatMap((item) => item.evidenceSpanIds))],
    memoryItemIds: args.items.map((item) => item.id),
    requiresHumanApproval: args.requiresHumanApproval,
  };
}

function createConnectMemoryPolicy(args: {
  persistence: LoopPersistence;
  memoryConnectionScorerModel?: MemoryConnectionScorerModel;
  newId?: (prefix: string) => string;
}): Policy<ConnectMemoryInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "connect_memory",
    version: "connect-memory-v0.1",
    async buildInput(workItem) {
      const ledgerEvent = await args.persistence.loadLedgerEvent(workItem.causedByEventId);
      if (!ledgerEvent) throw new Error(`causing ledger event not found: ${workItem.causedByEventId}`);
      const seedMemoryItemIds = extractSeedMemoryItemIds(ledgerEvent.payload);
      const memory = await args.persistence.getMemorySynthesisContext({
        tenantId: workItem.tenantId,
        seedMemoryItemIds,
        limit: 80,
      });
      const input = {
        tenantId: workItem.tenantId,
        causedByEventId: ledgerEvent.id,
        seedMemoryItemIds,
        memory,
      };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify(input)),
        inputSummary: {
          seedMemoryItemIds,
          candidateMemoryCount: memory.length,
        },
      };
    },
    async run(envelope) {
      const scoringResult = args.memoryConnectionScorerModel
        ? await buildLlmScoredConnections({
          memory: envelope.input.memory,
          scorerModel: args.memoryConnectionScorerModel,
          newId,
        })
        : {
          connections: buildDeterministicConnections(envelope.input.memory, newId),
          rawResponse: null,
          model: "connect-memory-v0.1",
          fallbackReason: undefined,
        };
      const connections = scoringResult.connections;
      return {
        proposedEvents: [{
          proposedEventType: "enrichment_update_proposed",
          targetEventType: "connections_updated",
          subjectType: "memory",
          subjectId: envelope.input.seedMemoryItemIds[0] ?? envelope.input.causedByEventId,
          payload: {
            causedByEventId: envelope.input.causedByEventId,
            seedMemoryItemIds: envelope.input.seedMemoryItemIds,
            memoryItemIds: envelope.input.seedMemoryItemIds,
            connections,
          },
          evidenceSpanIds: uniqueStrings(connections.flatMap((connection) => connection.evidenceSpanIds)),
          memoryItemIds: uniqueStrings(connections.flatMap((connection) => [connection.fromClaimId, connection.toClaimId])),
          requiresHumanApproval: false,
        }],
        provider: args.memoryConnectionScorerModel ? "openrouter" : "deterministic",
        model: scoringResult.model,
        fallbackUsed: Boolean(scoringResult.fallbackReason),
        fallbackReason: scoringResult.fallbackReason,
        rawResponse: scoringResult.rawResponse,
        ...(connections.length === 0
          ? { fallbackReason: scoringResult.fallbackReason ?? "No graph-grounded connection candidates crossed the threshold; completion was still recorded." }
          : {}),
      };
    },
    async validate(output) {
      const issues = output.proposedEvents
        .flatMap((event) => {
          const connections = Array.isArray(event.payload.connections) ? event.payload.connections : [];
          return connections.flatMap((connection, index) => validateConnectionPayload(connection, index));
        });
      return { ok: issues.length === 0, issues };
    },
  };
}

function createDetectContradictionPolicy(args: {
  persistence: LoopPersistence;
  newId?: (prefix: string) => string;
}): Policy<DetectContradictionInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "detect_contradiction",
    version: "detect-contradiction-v0.1",
    async buildInput(workItem) {
      const ledgerEvent = await args.persistence.loadLedgerEvent(workItem.causedByEventId);
      if (!ledgerEvent) throw new Error(`causing ledger event not found: ${workItem.causedByEventId}`);
      const seedMemoryItemIds = extractSeedMemoryItemIds(ledgerEvent.payload);
      const memory = await args.persistence.getMemorySynthesisContext({
        tenantId: workItem.tenantId,
        seedMemoryItemIds,
        limit: 80,
      });
      const input = {
        tenantId: workItem.tenantId,
        causedByEventId: ledgerEvent.id,
        seedMemoryItemIds,
        memory,
      };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify(input)),
        inputSummary: {
          seedMemoryItemIds,
          candidateMemoryCount: memory.length,
        },
      };
    },
    async run(envelope) {
      const conflicts = buildDeterministicConflicts(envelope.input.memory, newId);
      return {
        proposedEvents: [{
          proposedEventType: "enrichment_update_proposed",
          targetEventType: "contradictions_updated",
          subjectType: "memory",
          subjectId: envelope.input.seedMemoryItemIds[0] ?? envelope.input.causedByEventId,
          payload: {
            causedByEventId: envelope.input.causedByEventId,
            seedMemoryItemIds: envelope.input.seedMemoryItemIds,
            memoryItemIds: envelope.input.seedMemoryItemIds,
            conflicts,
          },
          evidenceSpanIds: uniqueStrings(conflicts.flatMap((conflict) =>
            conflict.members.flatMap((member) => member.evidenceSpanIds)
          )),
          memoryItemIds: uniqueStrings(conflicts.flatMap((conflict) =>
            conflict.members.map((member) => member.claimId)
          )),
          requiresHumanApproval: false,
        }],
        provider: "deterministic",
        model: "detect-contradiction-v0.1",
        ...(conflicts.length === 0 ? { fallbackReason: "No deterministic conflict candidates found; completion was still recorded." } : {}),
      };
    },
    async validate(output) {
      const issues = output.proposedEvents.flatMap((event) => {
        const conflicts = Array.isArray(event.payload.conflicts) ? event.payload.conflicts : [];
        return conflicts.flatMap((conflict, index) => validateConflictPayload(conflict, index));
      });
      return { ok: issues.length === 0, issues };
    },
  };
}

function createUpdateEmbeddingsPolicy(args: {
  persistence: LoopPersistence;
  embeddingModel?: EmbeddingModel;
  newId?: (prefix: string) => string;
}): Policy<PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
  memory: MemoryWithEvidence[];
}>, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "update_embeddings",
    version: "update-embeddings-v1",
    async buildInput(workItem) {
      const event = await requiredLedgerEvent(args.persistence, workItem.causedByEventId);
      const seedMemoryItemIds = extractSeedMemoryItemIds(event.payload);
      const memory = await args.persistence.getMemorySynthesisContext({
        tenantId: workItem.tenantId,
        seedMemoryItemIds,
        limit: Math.max(32, seedMemoryItemIds.length),
      });
      const selected = memory.filter((record) => seedMemoryItemIds.includes(record.memoryItem.id));
      const input = { tenantId: workItem.tenantId, causedByEventId: event.id, seedMemoryItemIds, memory: selected };
      return { input, inputHash: await sha256Hex(JSON.stringify(input)), inputSummary: { seedMemoryItemIds, memoryCount: selected.length } };
    },
    async run(envelope) {
      if (!args.embeddingModel) throw new Error("update_embeddings requires the configured embedding model.");
      const targets = [
        {
          targetType: "claim" as const,
          values: envelope.input.memory.map((record) => ({ id: record.memoryItem.id, text: record.memoryItem.statement })),
        },
        {
          targetType: "evidence_span" as const,
          values: uniqueEvidenceSpans(envelope.input.memory.flatMap((record) => record.evidenceSpans)).map((span) => ({ id: span.id, text: span.text })),
        },
        {
          targetType: "entity" as const,
          values: dedupeTextTargets(envelope.input.memory.flatMap((record) => record.memoryItem.entities.map((entity) => ({ id: `${entity.entityType}:${entity.canonicalName ?? entity.name}`, text: `${entity.entityType}: ${entity.canonicalName ?? entity.name}` })))),
        },
        {
          targetType: "schema_pattern" as const,
          values: dedupeTextTargets(envelope.input.memory.flatMap((record) => record.memoryItem.schemas.map((schema) => ({ id: `${schema.subjectType}:${schema.predicate}:${schema.objectType}`, text: `${schema.subjectType} ${schema.predicate} ${schema.objectType}` })))),
        },
      ];
      let model = "";
      for (const target of targets) {
        if (target.values.length === 0) continue;
        const response = await args.embeddingModel.embed({ targetType: target.targetType, input: target.values.map((value) => value.text) });
        model = response.model;
        if (response.vectors.length !== target.values.length) throw new Error(`embedding count mismatch for ${target.targetType}`);
        await args.persistence.upsertMemoryEmbeddings({
          tenantId: envelope.input.tenantId,
          embeddings: await Promise.all(target.values.map(async (value, index) => ({
            id: newId("emb"),
            targetType: target.targetType,
            targetId: value.id,
            embeddingModel: response.model,
            embedding: response.vectors[index]!,
            contentHash: await sha256Hex(value.text),
          }))),
        });
      }
      return enrichmentCompletionOutput({
        targetEventType: "embeddings_updated",
        tenantId: envelope.input.tenantId,
        causedByEventId: envelope.input.causedByEventId,
        memoryItemIds: envelope.input.seedMemoryItemIds,
        provider: "openrouter",
        model,
      });
    },
    async validate(output) {
      return validateSingleEnrichmentCompletion(output, "embeddings_updated");
    },
  };
}

function createUpdateGraphPolicy(args: {
  persistence: LoopPersistence;
}): Policy<PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
}>, PolicyOutput> {
  return {
    name: "update_graph",
    version: "update-graph-v1",
    async buildInput(workItem) {
      const event = await requiredLedgerEvent(args.persistence, workItem.causedByEventId);
      const input = { tenantId: workItem.tenantId, causedByEventId: event.id, seedMemoryItemIds: extractSeedMemoryItemIds(event.payload) };
      return { input, inputHash: await sha256Hex(JSON.stringify(input)), inputSummary: input };
    },
    async run(envelope) {
      const projection = await args.persistence.rebuildGraphProjection({ tenantId: envelope.input.tenantId });
      const output = enrichmentCompletionOutput({
        targetEventType: "graph_updated",
        tenantId: envelope.input.tenantId,
        causedByEventId: envelope.input.causedByEventId,
        memoryItemIds: envelope.input.seedMemoryItemIds,
        provider: "deterministic",
        model: "graph-projection-v1",
      });
      output.rawResponse = projection;
      return output;
    },
    async validate(output) {
      return validateSingleEnrichmentCompletion(output, "graph_updated");
    },
  };
}

function createRecomputeClusterPolicy(args: {
  persistence: LoopPersistence;
}): Policy<PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  causedByEventType: EventType;
  seedMemoryItemIds: string[];
  corpus: CorpusSynthesisState;
}>, PolicyOutput> {
  return {
    name: "recompute_cluster",
    version: CORPUS_SYNTHESIS_VERSION,
    async buildInput(workItem) {
      const event = await requiredLedgerEvent(args.persistence, workItem.causedByEventId);
      const seedMemoryItemIds = extractSeedMemoryItemIds(event.payload).length > 0
        ? extractSeedMemoryItemIds(event.payload)
        : [event.subjectId];
      const corpus = await args.persistence.getCorpusSynthesisState({ tenantId: workItem.tenantId, limit: 500, seedMemoryItemIds });
      const input = { tenantId: workItem.tenantId, causedByEventId: event.id, causedByEventType: event.eventType, seedMemoryItemIds, corpus };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify({ seedMemoryItemIds, memory: corpus.memory.map((record) => record.memoryItem.id), connections: corpus.connections.map((connection) => connection.id), similarities: corpus.similarities.map((signal) => `${signal.fromMemoryItemId}:${signal.toMemoryItemId}:${signal.vectorScore}:${signal.sparseScore}`), conflicts: corpus.conflicts.map((conflict) => `${conflict.id}:${conflict.status}`) })),
        inputSummary: { seedMemoryItemIds, corpusMemoryCount: corpus.memory.length, existingClusterCount: corpus.clusters.length },
      };
    },
    async run(envelope) {
      const discovered = discoverCorpusSynthesisClusters({
        tenantId: envelope.input.tenantId,
        memory: envelope.input.corpus.memory,
        connections: envelope.input.corpus.connections,
        similarities: envelope.input.corpus.similarities,
        conflicts: envelope.input.corpus.conflicts,
        existingClusters: envelope.input.corpus.clusters,
      });
      const seeds = new Set(envelope.input.seedMemoryItemIds);
      const affected = discovered.filter((cluster) => cluster.memberships.some((membership) => seeds.has(membership.memoryItemId)));
      const existingAffected = envelope.input.corpus.clusters.filter((cluster) => cluster.memberships.some((membership) => seeds.has(membership.memoryItemId)));
      const currentIds = new Set(affected.map((cluster) => cluster.id));
      const reevaluateWithoutMaterialChange = [
        "connections_updated", "contradictions_updated", "embeddings_updated", "graph_updated",
        "memory_confirmed", "memory_edited", "memory_removed", "memory_review_changed",
      ].includes(envelope.input.causedByEventType);
      const proposedEvents: ProposedEventDraft[] = affected
        .filter((cluster) => reevaluateWithoutMaterialChange || envelope.input.corpus.clusters.find((existing) => existing.id === cluster.id)?.version !== cluster.version)
        .map((cluster) => ({
          proposedEventType: "cluster_projection_proposed",
          targetEventType: "cluster_changed",
          subjectType: "cluster",
          subjectId: cluster.id,
          payload: { cluster, clusterId: cluster.id, clusterVersion: cluster.version, seedMemoryItemIds: envelope.input.seedMemoryItemIds },
          evidenceSpanIds: cluster.evidenceSpanIds,
          memoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
          requiresHumanApproval: false,
        }));
      for (const cluster of existingAffected.filter((existing) => !currentIds.has(existing.id))) {
        proposedEvents.push({
          proposedEventType: "cluster_projection_proposed",
          targetEventType: "cluster_changed",
          subjectType: "cluster",
          subjectId: cluster.id,
          payload: { supersededClusterId: cluster.id, priorClusterVersion: cluster.version, seedMemoryItemIds: envelope.input.seedMemoryItemIds },
          memoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
          requiresHumanApproval: false,
        });
      }
      return { proposedEvents, provider: "deterministic", model: CORPUS_SYNTHESIS_VERSION };
    },
    async validate(output) {
      const issues = output.proposedEvents.flatMap((event) =>
        event.targetEventType === "cluster_changed" && (isRecord(event.payload.cluster) || typeof event.payload.supersededClusterId === "string")
          ? []
          : [{ code: "invalid_cluster_projection", message: "Cluster projection must include a cluster or superseded cluster ID.", path: ["payload"] }]
      );
      return { ok: issues.length === 0, issues };
    },
  };
}

function createEvaluateSynthesisReadinessPolicy(args: {
  persistence: LoopPersistence;
}): Policy<PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  cluster: SynthesisCluster;
  corpus: CorpusSynthesisState;
}>, PolicyOutput> {
  return {
    name: "evaluate_synthesis_readiness",
    version: CORPUS_SYNTHESIS_VERSION,
    async buildInput(workItem) {
      const event = await requiredLedgerEvent(args.persistence, workItem.causedByEventId);
      const clusterId = typeof event.payload.clusterId === "string" ? event.payload.clusterId : event.subjectId;
      let corpus = await args.persistence.getCorpusSynthesisState({ tenantId: workItem.tenantId, limit: 500 });
      let cluster = corpus.clusters.find((candidate) => candidate.id === clusterId);
      if (!cluster) throw new Error(`synthesis cluster not found: ${clusterId}`);
      const loadedIds = new Set(corpus.memory.map((record) => record.memoryItem.id));
      if (cluster.memberships.some((membership) => !loadedIds.has(membership.memoryItemId))) {
        corpus = await args.persistence.getCorpusSynthesisState({
          tenantId: workItem.tenantId,
          limit: 500,
          seedMemoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
        });
        cluster = corpus.clusters.find((candidate) => candidate.id === clusterId) ?? cluster;
      }
      const input = { tenantId: workItem.tenantId, causedByEventId: event.id, cluster, corpus };
      return { input, inputHash: await sha256Hex(JSON.stringify({ clusterId, clusterVersion: cluster.version, enrichment: corpus.enrichment })), inputSummary: { clusterId, clusterVersion: cluster.version, memberCount: cluster.memberships.length } };
    },
    async run(envelope) {
      const evaluation = evaluateClusterReadiness({
        cluster: envelope.input.cluster,
        memory: envelope.input.corpus.memory,
        enrichment: envelope.input.corpus.enrichment,
        connections: envelope.input.corpus.connections,
        conflicts: envelope.input.corpus.conflicts,
        equivalentBriefExists: envelope.input.corpus.suggestedBriefs.some((suggestion) =>
          suggestion.clusterId === envelope.input.cluster.id && suggestion.status !== "rejected"
        ),
      });
      const previous = envelope.input.cluster.readiness;
      if (
        previous?.clusterVersion === evaluation.clusterVersion &&
        (previous.state === "draft_generated" || previous.state === "failed")
      ) {
        return {
          proposedEvents: [],
          provider: "deterministic",
          model: CORPUS_SYNTHESIS_VERSION,
          fallbackReason: previous.state === "draft_generated"
            ? "This cluster version already has a suggested draft."
            : "Generation failed for this cluster version; use a new intent or wait for a material cluster version change.",
        };
      }
      if (
        previous?.clusterVersion === evaluation.clusterVersion &&
        previous.state === evaluation.state &&
        Math.abs(previous.score - evaluation.score) < 0.001 &&
        JSON.stringify(previous.reasons) === JSON.stringify(evaluation.reasons) &&
        JSON.stringify(previous.warnings) === JSON.stringify(evaluation.warnings)
      ) {
        return {
          proposedEvents: [],
          provider: "deterministic",
          model: CORPUS_SYNTHESIS_VERSION,
          fallbackReason: "Readiness state is unchanged for this cluster version.",
        };
      }
      return {
        proposedEvents: [{
          proposedEventType: "readiness_evaluation_proposed",
          targetEventType: evaluation.state === "ready" ? "synthesis_ready" : "cluster_readiness_changed",
          subjectType: "cluster",
          subjectId: envelope.input.cluster.id,
          payload: { evaluation, clusterId: envelope.input.cluster.id, clusterVersion: envelope.input.cluster.version, generationIntent: evaluation.generationIntent },
          evidenceSpanIds: envelope.input.cluster.evidenceSpanIds,
          memoryItemIds: envelope.input.cluster.memberships.map((membership) => membership.memoryItemId),
          requiresHumanApproval: false,
        }],
        provider: "deterministic",
        model: CORPUS_SYNTHESIS_VERSION,
      };
    },
    async validate(output) {
      if (output.proposedEvents.length === 0) {
        return { ok: true, issues: [] };
      }
      const evaluation = output.proposedEvents[0]?.payload.evaluation;
      return isRecord(evaluation) && typeof evaluation.state === "string"
        ? { ok: true, issues: [] }
        : { ok: false, issues: [{ code: "invalid_readiness_evaluation", message: "Readiness output is missing its explicit state.", path: ["payload", "evaluation"] }] };
    },
  };
}

function createSynthesizeBriefPolicy(args: {
  persistence: LoopPersistence;
  embeddingModel?: EmbeddingModel;
  retrievalRerankerModel?: RetrievalRerankerModel;
  initiativeBriefDraftModel?: InitiativeBriefDraftModel;
  newId?: (prefix: string) => string;
}): Policy<SynthesizeBriefInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "synthesize_brief",
    version: "synthesize-brief-v1",
    async buildInput(workItem) {
      const ledgerEvent = await args.persistence.loadLedgerEvent(workItem.causedByEventId);
      if (!ledgerEvent) throw new Error(`causing ledger event not found: ${workItem.causedByEventId}`);

      const clusterId = typeof ledgerEvent.payload.clusterId === "string" ? ledgerEvent.payload.clusterId : null;
      if (clusterId) {
        let corpus = await args.persistence.getCorpusSynthesisState({ tenantId: ledgerEvent.tenantId, limit: 500 });
        let cluster = corpus.clusters.find((candidate) => candidate.id === clusterId);
        if (!cluster) throw new Error(`synthesis cluster not found: ${clusterId}`);
        const loadedIds = new Set(corpus.memory.map((record) => record.memoryItem.id));
        if (cluster.memberships.some((membership) => !loadedIds.has(membership.memoryItemId))) {
          corpus = await args.persistence.getCorpusSynthesisState({
            tenantId: ledgerEvent.tenantId,
            limit: 500,
            seedMemoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
          });
          cluster = corpus.clusters.find((candidate) => candidate.id === clusterId) ?? cluster;
        }
        const requestedVersion = typeof ledgerEvent.payload.clusterVersion === "string"
          ? ledgerEvent.payload.clusterVersion
          : cluster.version;
        if (cluster.version !== requestedVersion) throw new Error(`synthesis cluster version changed: expected ${requestedVersion}, found ${cluster.version}`);
        const dossier = buildClusterDossier({
          cluster,
          memory: corpus.memory,
          connections: corpus.connections,
          conflicts: corpus.conflicts,
          retrievalMetadata: { causedByEventId: ledgerEvent.id, trigger: "synthesis_ready" },
        });
        const { bundle, selectedMemory } = buildSynthesisBundle({
          seedMemoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
          memory: dossier.selectedMemory,
          maxMemoryItems: dossier.selectedMemory.length,
        });
        const input = {
          tenantId: ledgerEvent.tenantId,
          causedByEventId: ledgerEvent.id,
          seedMemoryItemIds: cluster.memberships.map((membership) => membership.memoryItemId),
          synthesisBundle: bundle,
          selectedMemory,
          cluster,
          dossier,
          generationIntent: typeof ledgerEvent.payload.generationIntent === "string"
            ? ledgerEvent.payload.generationIntent
            : "initiative_brief",
        };
        return {
          input,
          inputHash: await sha256Hex(JSON.stringify({ clusterId, clusterVersion: cluster.version, memoryItemIds: dossier.selectedMemory.map((record) => record.memoryItem.id), evidenceSpanIds: dossier.selectedEvidenceSpans.map((span) => span.id) })),
          inputSummary: {
            clusterId,
            clusterVersion: cluster.version,
            selectedMemoryItemIds: dossier.selectedMemory.map((record) => record.memoryItem.id),
            selectedEvidenceSpanIds: dossier.selectedEvidenceSpans.map((span) => span.id),
            contradictions: dossier.contradictions.map((conflict) => conflict.id),
            retrievalMetadata: dossier.retrievalMetadata,
          },
        };
      }

      const seedMemoryItemIds = extractSeedMemoryItemIds(ledgerEvent.payload);
      const retrievalContext = await retrieveMemoryContext({
        tenantId: ledgerEvent.tenantId,
        profile: "synthesis",
        queryText: seedMemoryItemIds.length > 0
          ? `Synthesize initiative context around memory ${seedMemoryItemIds.join(", ")}.`
          : "Synthesize initiative context from recently committed memory.",
        seedMemoryItemIds,
        ...(args.embeddingModel ? { embeddingModel: args.embeddingModel } : {}),
        ...(args.retrievalRerankerModel ? { rerankerModel: args.retrievalRerankerModel } : {}),
        persistence: args.persistence,
      });
      const context = retrievalContext.claims.map((claim) => ({
        memoryItem: claim.claim,
        evidenceSpans: claim.evidenceSpans,
      }));
      const { bundle, selectedMemory } = buildSynthesisBundle({
        seedMemoryItemIds,
        memory: context,
        maxMemoryItems: 32,
      });
      const input = {
        tenantId: ledgerEvent.tenantId,
        causedByEventId: ledgerEvent.id,
        seedMemoryItemIds,
        synthesisBundle: bundle,
        selectedMemory,
      };

      return {
        input,
        inputHash: await sha256Hex(JSON.stringify({
          seedMemoryItemIds,
          selectedMemoryItemIds: bundle.selectedMemoryItemIds,
          selectedEvidenceSpanIds: bundle.selectedEvidenceSpanIds,
          connections: bundle.connections,
        })),
        inputSummary: {
          causedByEventId: ledgerEvent.id,
          seedMemoryItemIds,
          selectedMemoryItemIds: bundle.selectedMemoryItemIds,
          selectedEvidenceSpanIds: bundle.selectedEvidenceSpanIds,
          connectionReasons: bundle.connections.map((connection) => connection.reason),
          readiness: bundle.readiness,
          retrievalMetadata: retrievalContext.metadata,
        },
      };
    },
    async run(envelope) {
      const selectedMemoryItems = envelope.input.selectedMemory.map((record) => record.memoryItem);
      const selectedEvidenceSpans = envelope.input.dossier?.selectedEvidenceSpans
        ?? uniqueEvidenceSpans(envelope.input.selectedMemory.flatMap((record) => record.evidenceSpans));

      if (!envelope.input.cluster && !envelope.input.synthesisBundle.readiness.ready) {
        return {
          proposedEvents: [],
          fallbackReason: envelope.input.synthesisBundle.readiness.skipReasons.join("; "),
          promptVersion: MEMORY_SYNTHESIS_VERSION,
          schemaVersion: MEMORY_SYNTHESIS_VERSION,
          outputSchemaVersion: MEMORY_SYNTHESIS_VERSION,
        };
      }

      if (!args.initiativeBriefDraftModel) {
        throw new Error("synthesize_brief requires an initiative brief draft model.");
      }

      let generated: Awaited<ReturnType<InitiativeBriefDraftModel["generateInitiativeBriefDraft"]>>;
      try {
        generated = await args.initiativeBriefDraftModel.generateInitiativeBriefDraft({
          memoryItems: selectedMemoryItems,
          evidenceSpans: selectedEvidenceSpans,
          intent: envelope.input.dossier
            ? JSON.stringify({
              instruction: "Draft one evidence-backed initiative brief from this bounded cluster dossier. Disclose contradictions and missing information.",
              generationIntent: envelope.input.generationIntent,
              clusterId: envelope.input.dossier.clusterId,
              clusterVersion: envelope.input.dossier.clusterVersion,
              resolution: envelope.input.dossier.resolution,
              label: envelope.input.dossier.label,
              dependencies: envelope.input.dossier.dependencies,
              risks: envelope.input.dossier.risks,
              contradictions: envelope.input.dossier.contradictions.map((conflict) => ({ id: conflict.id, severity: conflict.severity, summary: conflict.summary })),
              missingInformation: envelope.input.dossier.missingInformation,
              membershipReasons: envelope.input.dossier.membershipReasons,
            })
            : renderSynthesisIntent(envelope.input.synthesisBundle),
        });
      } catch (error) {
        if (envelope.input.cluster) {
          return failedSynthesisOutput(envelope, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
      const validation = envelope.input.dossier
        ? validateSuggestedBriefDraft({ draft: generated.parsed, dossier: envelope.input.dossier })
        : validateInitiativeBriefDraftTraceability({ draft: generated.parsed, selectedMemoryItems, selectedEvidenceSpans });

      if (!validation.ok) {
        if (envelope.input.cluster) {
          return failedSynthesisOutput(
            envelope,
            validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
            { model: generated.model, rawResponse: generated.raw },
          );
        }
        return {
          proposedEvents: [],
          provider: "openrouter",
          model: generated.model,
          fallbackReason: validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
          promptVersion: MEMORY_SYNTHESIS_VERSION,
          schemaVersion: MEMORY_SYNTHESIS_VERSION,
          outputSchemaVersion: MEMORY_SYNTHESIS_VERSION,
          rawResponse: generated.raw,
        };
      }

      const briefId = newId("brief");
      return {
        proposedEvents: [{
          proposedEventType: "artifact_draft_proposed",
          targetEventType: "artifact_drafted",
          subjectType: "artifact",
          subjectId: briefId,
          payload: {
            briefId,
            ...generated.parsed,
            ...(envelope.input.cluster ? {
              clusterId: envelope.input.cluster.id,
              clusterVersion: envelope.input.cluster.version,
              generationIntent: envelope.input.generationIntent ?? "initiative_brief",
              suggestedBrief: true,
            } : {}),
            selectedMemoryItemIds: selectedMemoryItems.map((item) => item.id),
            selectedEvidenceSpanIds: selectedEvidenceSpans.map((span) => span.id),
            synthesisBundle: envelope.input.synthesisBundle,
            ...(envelope.input.dossier ? { clusterDossier: envelope.input.dossier } : {}),
            modelMetadata: {
              provider: "openrouter",
              model: generated.model,
              promptVersion: MEMORY_SYNTHESIS_VERSION,
              schemaVersion: MEMORY_SYNTHESIS_VERSION,
            },
            validationMetadata: {
              ok: validation.ok,
              issues: validation.issues,
            },
          },
          evidenceSpanIds: generated.parsed.evidenceSpanIds,
          memoryItemIds: generated.parsed.memoryItemIds,
          requiresHumanApproval: false,
        }],
        provider: "openrouter",
        model: generated.model,
        promptVersion: MEMORY_SYNTHESIS_VERSION,
        schemaVersion: MEMORY_SYNTHESIS_VERSION,
        outputSchemaVersion: MEMORY_SYNTHESIS_VERSION,
        rawResponse: generated.raw,
      };
    },
    async validate(output) {
      if (output.proposedEvents.length === 0) return { ok: true, issues: [] };
      const draft = output.proposedEvents[0];
      if (
        draft?.proposedEventType === "readiness_evaluation_proposed" &&
        draft.targetEventType === "cluster_readiness_changed" &&
        isRecord(draft.payload.evaluation) &&
        draft.payload.evaluation.state === "failed"
      ) {
        return { ok: true, issues: [] };
      }
      if (!draft || draft.proposedEventType !== "artifact_draft_proposed" || draft.targetEventType !== "artifact_drafted") {
        return {
          ok: false,
          issues: [{ code: "missing_artifact_draft_proposal", message: "synthesize_brief must emit artifact_draft_proposed targeting artifact_drafted.", path: [] }],
        };
      }
      return { ok: true, issues: [] };
    },
  };
}

function failedSynthesisOutput(
  envelope: SynthesizeBriefInput,
  reason: string,
  metadata: { model?: string; rawResponse?: unknown } = {},
): PolicyOutput {
  const cluster = envelope.input.cluster;
  if (!cluster) throw new Error(reason);
  const previous = cluster.readiness;
  const zeroBreakdown = {
    cohesion: 0,
    evidenceBreadth: 0,
    evidenceQuality: 0,
    sourceDiversity: 0,
    actionability: 0,
    strategicImportance: 0,
    recentMomentum: 0,
    urgency: 0,
    novelty: 0,
    completeness: 0,
    contradictionPenalty: 0,
    duplicationPenalty: 0,
    stalenessPenalty: 0,
    existingBriefPenalty: 0,
  };
  const generationIntent = envelope.input.generationIntent ?? "initiative_brief";
  const evaluation: SynthesisReadinessEvaluation = {
    id: previous?.id ?? `sready_failed_${cluster.id}_${cluster.version}_${generationIntent}`,
    clusterId: cluster.id,
    clusterVersion: cluster.version,
    generationIntent,
    state: "failed",
    score: previous?.score ?? 0,
    breakdown: previous?.breakdown ?? zeroBreakdown,
    reasons: [`Suggested brief generation failed: ${reason}`],
    warnings: previous?.warnings ?? [],
    missingInformation: previous?.missingInformation ?? [],
    evaluatedAt: now(),
  };
  return {
    proposedEvents: [{
      proposedEventType: "readiness_evaluation_proposed",
      targetEventType: "cluster_readiness_changed",
      subjectType: "cluster",
      subjectId: cluster.id,
      payload: { evaluation, clusterId: cluster.id, clusterVersion: cluster.version, generationIntent },
      evidenceSpanIds: envelope.input.dossier?.selectedEvidenceSpans.map((span) => span.id) ?? [],
      memoryItemIds: envelope.input.dossier?.selectedMemory.map((record) => record.memoryItem.id) ?? [],
      requiresHumanApproval: false,
    }],
    provider: "openrouter",
    ...(metadata.model ? { model: metadata.model } : {}),
    fallbackReason: reason,
    promptVersion: MEMORY_SYNTHESIS_VERSION,
    schemaVersion: MEMORY_SYNTHESIS_VERSION,
    outputSchemaVersion: MEMORY_SYNTHESIS_VERSION,
    ...(metadata.rawResponse !== undefined ? { rawResponse: metadata.rawResponse } : {}),
  };
}

function deterministicNoopPolicy(
  name: PolicyName,
  proposedEventType: ProposedEventType,
  targetEventType: EventType,
): Policy<PolicyInputEnvelope<Record<string, unknown>>, PolicyOutput> {
  return {
    name,
    version: `${name}-v0.1`,
    async buildInput(workItem) {
      const input = {
        workItemId: workItem.id,
        subjectType: workItem.subjectType,
        subjectId: workItem.subjectId,
        causedByEventId: workItem.causedByEventId,
      };
      return {
        input,
        inputHash: await sha256Hex(JSON.stringify(input)),
        inputSummary: input,
      };
    },
    async run(envelope) {
      const requiresHumanApproval = targetEventType === "candidate_created" || targetEventType === "decision_committed";
      return {
        proposedEvents: [{
          proposedEventType,
          targetEventType,
          subjectType: String(envelope.input.subjectType) as WorkSubjectType,
          subjectId: String(envelope.input.subjectId),
          payload: {
            status: "not_enough_context",
            reason: `${name} policy is installed but no domain-specific generator is configured for this route yet.`,
            causedByEventId: envelope.input.causedByEventId,
          },
          requiresHumanApproval,
        }],
      };
    },
    async validate() {
      return { ok: true, issues: [] };
    },
  };
}

function route(eventType: EventType, policy: PolicyName, subjectType: WorkSubjectType): EventRoute {
  return {
    eventType,
    policy,
    subjectType,
    getSubjectId: (event) => subjectType === event.subjectType ? event.subjectId : String(event.payload[`${subjectType}Id`] ?? event.subjectId),
    getInputVersion: (event) => event.inputVersion ?? `${event.id}:${event.createdAt}`,
    guard: async (event) => EVENT_TYPES.includes(event.eventType),
  };
}

function normalizeInputEnvelope(input: unknown): PolicyInputEnvelope<unknown> {
  if (
    typeof input === "object" &&
    input !== null &&
    "inputHash" in input &&
    "inputSummary" in input
  ) {
    return input as PolicyInputEnvelope<unknown>;
  }

  return {
    input,
    inputHash: "unknown",
    inputSummary: {},
  };
}

function toProposedEventForValidation(args: {
  tenantId: string;
  workItemId: string;
  policyRunId: string;
  draft: ProposedEventDraft;
}): ProposedEvent {
  const timestamp = now();
  return {
    id: "validation_only",
    tenantId: args.tenantId,
    workItemId: args.workItemId,
    policyRunId: args.policyRunId,
    proposedEventType: args.draft.proposedEventType,
    targetEventType: args.draft.targetEventType,
    subjectType: args.draft.subjectType,
    subjectId: args.draft.subjectId,
    payload: args.draft.payload,
    evidenceSpanIds: args.draft.evidenceSpanIds ?? [],
    memoryItemIds: args.draft.memoryItemIds ?? [],
    decisionIds: args.draft.decisionIds ?? [],
    requiresHumanApproval: args.draft.requiresHumanApproval,
    validationStatus: "pending",
    validationIssues: [],
    reviewStatus: args.draft.requiresHumanApproval ? "pending" : "not_required",
    reviewerLabel: null,
    reviewRationale: null,
    committedLedgerEventId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function GeneratedMemoryBatchFromPayload(payload: Record<string, unknown>): GeneratedMemoryBatch {
  return {
    items: GeneratedMemoryPayloadSchema(payload).map((item, index) => ({
      temporaryId: item.id || `item_${index}`,
      ...item,
    })),
  };
}

function GeneratedMemoryPayloadSchema(payload: Record<string, unknown>): CommittableMemoryItem[] {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  return rawItems.map((item) => item as CommittableMemoryItem);
}

function extractSeedMemoryItemIds(payload: Record<string, unknown>): string[] {
  if (Array.isArray(payload.memoryItemIds)) {
    return stringArray(payload.memoryItemIds);
  }

  if (Array.isArray(payload.items)) {
    return payload.items
      .map((item) => typeof item === "object" && item !== null && "id" in item ? String(item.id) : "")
      .filter(Boolean);
  }

  return [];
}

function buildDeterministicConnections(
  memory: MemoryWithEvidence[],
  newId: (prefix: string) => string,
): Array<{
  id: string;
  fromClaimId: string;
  toClaimId: string;
  connectionType: ClaimConnection["connectionType"];
  status: ClaimConnection["status"];
  confidence: number;
  scoreComponents: Record<string, unknown>;
  evidenceSpanIds: string[];
  rationale: string;
}> {
  const connections: ReturnType<typeof buildDeterministicConnections> = [];

  for (let leftIndex = 0; leftIndex < memory.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memory.length; rightIndex += 1) {
      const left = memory[leftIndex]!;
      const right = memory[rightIndex]!;
      const score = scoreConnection(left, right);
      if (score.confidence < 0.55) continue;

      connections.push({
        id: newId("conn"),
        fromClaimId: left.memoryItem.id,
        toClaimId: right.memoryItem.id,
        connectionType: score.connectionType,
        status: score.confidence >= 0.95 && score.connectionType === "duplicates" ? "accepted" : "proposed",
        confidence: score.confidence,
        scoreComponents: score.scoreComponents,
        evidenceSpanIds: uniqueStrings([
          ...left.memoryItem.evidenceSpanIds,
          ...right.memoryItem.evidenceSpanIds,
        ]),
        rationale: score.rationale,
      });
    }
  }

  return connections;
}

async function buildLlmScoredConnections(args: {
  memory: MemoryWithEvidence[];
  scorerModel: MemoryConnectionScorerModel;
  newId: (prefix: string) => string;
}): Promise<{
  connections: ReturnType<typeof buildDeterministicConnections>;
  rawResponse: unknown;
  model: string;
  fallbackReason?: string;
}> {
  const candidates = buildBroadConnectionCandidates(args.memory).slice(0, 120);
  if (candidates.length === 0) {
    return { connections: [], rawResponse: null, model: "connect-memory-v0.1" };
  }

  try {
    const response = await args.scorerModel.scoreMemoryConnections({
      memory: args.memory,
      candidates,
    });
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const connections = response.decisions
      .map((decision) => {
        const candidate = candidateById.get(decision.candidateId);
        if (!candidate) return null;
        return connectionFromScoringDecision({
          decision,
          candidate,
          model: response.model,
          newId: args.newId,
        });
      })
      .filter((connection): connection is ReturnType<typeof buildDeterministicConnections>[number] => Boolean(connection));
    return { connections, rawResponse: response.raw, model: response.model };
  } catch (error) {
    return {
      connections: buildDeterministicConnections(args.memory, args.newId),
      rawResponse: null,
      model: "connect-memory-v0.1",
      fallbackReason: `Connection scorer unavailable; used deterministic fallback. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildBroadConnectionCandidates(memory: MemoryWithEvidence[]): MemoryConnectionScoringCandidate[] {
  const candidates: MemoryConnectionScoringCandidate[] = [];
  for (let leftIndex = 0; leftIndex < memory.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memory.length; rightIndex += 1) {
      const left = memory[leftIndex]!;
      const right = memory[rightIndex]!;
      const score = scoreConnection(left, right);
      const hasGrounding = score.rationale !== "No grounding signal; claim-type compatibility was ignored.";
      if (!hasGrounding && score.confidence < 0.12) continue;
      if (score.confidence < 0.12 && !hasDirectWorkSignal(left, right)) continue;

      candidates.push({
        id: `ccand:${left.memoryItem.id}:${right.memoryItem.id}`,
        fromClaimId: left.memoryItem.id,
        toClaimId: right.memoryItem.id,
        connectionType: score.connectionType,
        confidence: score.confidence,
        scoreComponents: score.scoreComponents,
        evidenceSpanIds: uniqueStrings([
          ...left.memoryItem.evidenceSpanIds,
          ...right.memoryItem.evidenceSpanIds,
        ]),
        rationale: score.rationale,
      });
    }
  }

  return candidates.sort((left, right) =>
    right.confidence - left.confidence ||
    left.fromClaimId.localeCompare(right.fromClaimId) ||
    left.toClaimId.localeCompare(right.toClaimId)
  );
}

function hasDirectWorkSignal(left: MemoryWithEvidence, right: MemoryWithEvidence): boolean {
  const claimTypes = new Set([left.memoryItem.claimType, right.memoryItem.claimType]);
  return claimTypes.has("dependency") ||
    claimTypes.has("risk") ||
    claimTypes.has("constraint") ||
    claimTypes.has("ownership_statement") ||
    claimTypes.has("reported_decision");
}

function connectionFromScoringDecision(args: {
  decision: MemoryConnectionScoringDecision;
  candidate: MemoryConnectionScoringCandidate;
  model: string;
  newId: (prefix: string) => string;
}): ReturnType<typeof buildDeterministicConnections>[number] {
  return {
    id: args.newId("conn"),
    fromClaimId: args.candidate.fromClaimId,
    toClaimId: args.candidate.toClaimId,
    connectionType: args.decision.connectionType as ClaimConnection["connectionType"],
    status: "proposed",
    confidence: Number(Math.max(0, Math.min(1, args.decision.confidence)).toFixed(3)),
    scoreComponents: {
      ...args.candidate.scoreComponents,
      llm_confidence: args.decision.confidence,
      tier: args.decision.tier,
      connectionReason: args.decision.connectionReason,
      llmModel: args.model,
      reviewRequired: args.decision.reviewRequired,
    },
    evidenceSpanIds: uniqueStrings(args.decision.evidenceSpanIds.length > 0
      ? args.decision.evidenceSpanIds
      : args.candidate.evidenceSpanIds),
    rationale: args.decision.rationale || args.candidate.rationale,
  };
}

function deterministicMemoryGenerationFallback(args: {
  evidenceSpans: EvidenceSpan[];
  error: string;
}): {
  parsed: GeneratedMemoryBatch;
  raw: unknown;
  model: string;
} {
  const spanGroups = chunk(args.evidenceSpans, 12).slice(0, 30);

  return {
    model: "deterministic-fallback",
    raw: {
      fallbackReason: args.error,
      strategy: "evidence_text_as_user_signal",
    },
    parsed: {
      items: spanGroups.flatMap((spans, index) => {
        const statement = spans.map((span) => span.text.trim()).filter(Boolean).join("\n\n").slice(0, 2_000).trim();
        return statement ? [{
          temporaryId: `fallback_${index + 1}`,
          claimType: "user_signal",
          statement,
          evidenceSpanIds: spans.map((span) => span.id),
          epistemicStatus: "reported",
          qualifiers: { extractionFallback: true, fallbackReason: args.error },
          stableDomainTags: [],
          entities: [],
          relations: [],
          schemas: [],
        } as GeneratedMemoryItem] : [];
      }),
    },
  };
}

const GENERIC_ENTITY_NAMES = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "be",
  "but",
  "four",
  "here",
  "in",
  "it",
  "many",
  "no",
  "of",
  "one",
  "or",
  "some",
  "that",
  "the",
  "there",
  "this",
  "three",
  "to",
  "two",
  "yes",
]);

const SHORT_ENTITY_ALLOWLIST = new Set([
  "api",
  "rpc",
  "sdk",
  "ux",
  "ui",
  "usdc",
  "usdt",
  "defi",
]);

function sanitizeMemoryEntities(entities: MemoryEntity[]): MemoryEntity[] {
  const seen = new Set<string>();
  const sanitized: MemoryEntity[] = [];

  for (const entity of entities) {
    const name = entity.name.trim();
    const canonicalName = entity.canonicalName?.trim() || null;
    const entityType = entity.entityType.trim();
    const label = canonicalName ?? name;
    const normalizedLabel = normalizeEntityLabel(label);

    if (!name || !entityType || isGenericEntityLabel(normalizedLabel)) continue;

    const normalizedName = normalizeEntityLabel(name);
    if (isGenericEntityLabel(normalizedName)) continue;

    const key = `${normalizedLabel}:${entityType.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sanitized.push({
      name,
      entityType,
      ...(canonicalName ? { canonicalName } : {}),
    });
  }

  return sanitized;
}

function normalizeEntityLabel(value: string): string {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function isGenericEntityLabel(label: string): boolean {
  if (!label) return true;
  if (GENERIC_ENTITY_NAMES.has(label)) return true;

  const tokens = label.split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  if (tokens.every((token) => GENERIC_ENTITY_NAMES.has(token))) return true;
  if (tokens.length === 1) {
    const token = tokens[0] ?? "";
    if (token.length <= 1) return true;
    if (token.length <= 3 && !SHORT_ENTITY_ALLOWLIST.has(token)) return true;
  }

  return false;
}

function scoreConnection(
  left: MemoryWithEvidence,
  right: MemoryWithEvidence,
): {
  confidence: number;
  connectionType: ClaimConnection["connectionType"];
  scoreComponents: Record<string, number>;
  rationale: string;
} {
  const leftStatement = normalizeText(left.memoryItem.statement);
  const rightStatement = normalizeText(right.memoryItem.statement);
  const duplicate = leftStatement === rightStatement ? 1 : 0;
  const entityOverlap = jaccard(
    left.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
    right.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
  );
  const schemaOverlap = jaccard(
    left.memoryItem.schemas.map((schema) => normalizeText(`${schema.subjectType}:${schema.predicate}:${schema.objectType}`)),
    right.memoryItem.schemas.map((schema) => normalizeText(`${schema.subjectType}:${schema.predicate}:${schema.objectType}`)),
  );
  const evidenceOverlap = jaccard(left.memoryItem.evidenceSpanIds, right.memoryItem.evidenceSpanIds);
  const sourceContextOverlap = left.memoryItem.sourceVersionId === right.memoryItem.sourceVersionId ? 1 : 0;
  const relationCompatibility = jaccard(
    left.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}:${relation.object}`)),
    right.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}:${relation.object}`)),
  );
  const tokenOverlap = jaccard(tokenize(left.memoryItem.statement), tokenize(right.memoryItem.statement));
  const claimTypeCompatibility = complementaryClaimTypes(left.memoryItem.claimType, right.memoryItem.claimType) ? 0.1 : 0;
  const hasGrounding = duplicate > 0 || entityOverlap > 0 || schemaOverlap > 0 || evidenceOverlap > 0 ||
    sourceContextOverlap > 0 || relationCompatibility > 0 || tokenOverlap >= 0.22;
  const scoreComponents = {
    entity_overlap: entityOverlap,
    schema_overlap: schemaOverlap,
    evidence_overlap: evidenceOverlap,
    source_context_overlap: sourceContextOverlap,
    relation_compatibility: relationCompatibility,
    embedding_similarity: tokenOverlap,
    temporal_compatibility: 0.5,
    claim_type_compatibility: hasGrounding ? claimTypeCompatibility : 0,
    model_confidence: 0,
    review_prior: 0,
  };
  const confidence = duplicate === 1
    ? 0.97
    : Math.min(0.94, (
      entityOverlap * 0.24 +
      schemaOverlap * 0.2 +
      evidenceOverlap * 0.2 +
      sourceContextOverlap * 0.12 +
      relationCompatibility * 0.14 +
      tokenOverlap * 0.2 +
      scoreComponents.claim_type_compatibility
    ));
  const connectionType = duplicate === 1
    ? "duplicates"
    : left.memoryItem.claimType === "dependency" || right.memoryItem.claimType === "dependency"
      ? "depends_on"
      : left.memoryItem.claimType === "risk" || right.memoryItem.claimType === "risk"
        ? "blocks"
        : confidence >= 0.72
          ? "supports"
          : "related_context";

  return {
    confidence: Number(confidence.toFixed(3)),
    connectionType,
    scoreComponents,
    rationale: hasGrounding
      ? "Deterministic graph signals crossed the pilot connection threshold."
      : "No grounding signal; claim-type compatibility was ignored.",
  };
}

function buildDeterministicConflicts(
  memory: MemoryWithEvidence[],
  newId: (prefix: string) => string,
): Array<{
  id: string;
  conflictType: ConflictGroup["conflictType"];
  severity: ConflictGroup["severity"];
  summary: string;
  members: Array<{
    claimId: string;
    role: string;
    evidenceSpanIds: string[];
  }>;
  rationale: string;
}> {
  const conflicts: ReturnType<typeof buildDeterministicConflicts> = [];

  for (let leftIndex = 0; leftIndex < memory.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memory.length; rightIndex += 1) {
      const left = memory[leftIndex]!;
      const right = memory[rightIndex]!;
      if (!sameConflictSubject(left, right)) continue;
      const polarity = polarityConflict(left.memoryItem.statement, right.memoryItem.statement);
      if (!polarity) continue;

      const conflictType = inferConflictType(left, right);
      conflicts.push({
        id: newId("conflict"),
        conflictType,
        severity: conflictType === "decision" || conflictType === "ownership" || conflictType === "dependency" ? "blocking" : "warning",
        summary: `Potential ${conflictType} conflict between ${left.memoryItem.id} and ${right.memoryItem.id}.`,
        members: [
          { claimId: left.memoryItem.id, role: "side_a", evidenceSpanIds: left.memoryItem.evidenceSpanIds },
          { claimId: right.memoryItem.id, role: "side_b", evidenceSpanIds: right.memoryItem.evidenceSpanIds },
        ],
        rationale: "Deterministic polarity and shared subject signals indicate incompatible memory.",
      });
    }
  }

  return conflicts;
}

function sameConflictSubject(left: MemoryWithEvidence, right: MemoryWithEvidence): boolean {
  const entityOverlap = jaccard(
    left.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
    right.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
  );
  const relationSubjectOverlap = jaccard(
    left.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}`)),
    right.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}`)),
  );
  return entityOverlap > 0 || relationSubjectOverlap > 0 || jaccard(tokenize(left.memoryItem.statement), tokenize(right.memoryItem.statement)) >= 0.35;
}

function polarityConflict(left: string, right: string): boolean {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const positive = ["approved", "clear", "ready", "unblocked", "owned", "included", "enabled", "launched"];
  const negative = ["not", "no", "blocked", "unresolved", "unclear", "rejected", "excluded", "disabled", "delayed"];
  const leftPositive = positive.some((token) => leftTokens.has(token));
  const rightPositive = positive.some((token) => rightTokens.has(token));
  const leftNegative = negative.some((token) => leftTokens.has(token));
  const rightNegative = negative.some((token) => rightTokens.has(token));
  return (leftPositive && rightNegative) || (leftNegative && rightPositive);
}

function inferConflictType(left: MemoryWithEvidence, right: MemoryWithEvidence): ConflictGroup["conflictType"] {
  const claimTypes = new Set([left.memoryItem.claimType, right.memoryItem.claimType]);
  const text = normalizeText(`${left.memoryItem.statement} ${right.memoryItem.statement}`);
  if (claimTypes.has("reported_decision") || text.includes("approved") || text.includes("rejected")) return "decision";
  if (claimTypes.has("ownership_statement") || text.includes("owner") || text.includes("owned")) return "ownership";
  if (claimTypes.has("dependency") || text.includes("blocked") || text.includes("unblocked")) return "dependency";
  if (claimTypes.has("metric")) return "metric_definition";
  if (claimTypes.has("scope_statement")) return "scope";
  return "mutual";
}

function validateConnectionPayload(connection: unknown, index: number): ValidationGateResult["issues"] {
  if (!isRecord(connection)) {
    return [{ code: "invalid_connection", message: "Connection payload must be an object.", path: [`connections.${index}`] }];
  }
  const evidenceSpanIds = stringArray(connection.evidenceSpanIds);
  const confidence = Number(connection.confidence);
  const issues: ValidationGateResult["issues"] = [];
  if (!connection.fromClaimId || !connection.toClaimId || connection.fromClaimId === connection.toClaimId) {
    issues.push({ code: "invalid_connection_claims", message: "Connection requires two distinct claim ids.", path: [`connections.${index}`] });
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push({ code: "invalid_connection_confidence", message: "Connection confidence must be between 0 and 1.", path: [`connections.${index}.confidence`] });
  }
  if (evidenceSpanIds.length === 0) {
    issues.push({ code: "connection_missing_evidence", message: "Connection must carry evidence span ids.", path: [`connections.${index}.evidenceSpanIds`] });
  }
  return issues;
}

function validateConflictPayload(conflict: unknown, index: number): ValidationGateResult["issues"] {
  if (!isRecord(conflict)) {
    return [{ code: "invalid_conflict", message: "Conflict payload must be an object.", path: [`conflicts.${index}`] }];
  }
  const members = Array.isArray(conflict.members) ? conflict.members : [];
  const issues: ValidationGateResult["issues"] = [];
  if (members.length < 2) {
    issues.push({ code: "conflict_requires_members", message: "Conflict requires at least two members.", path: [`conflicts.${index}.members`] });
  }
  for (const [memberIndex, member] of members.entries()) {
    if (!isRecord(member) || stringArray(member.evidenceSpanIds).length === 0) {
      issues.push({ code: "conflict_member_missing_evidence", message: "Conflict members must cite evidence.", path: [`conflicts.${index}.members.${memberIndex}`] });
    }
  }
  return issues;
}

function complementaryClaimTypes(left: string, right: string): boolean {
  const pair = new Set([left, right]);
  return (pair.has("risk") && pair.has("dependency")) ||
    (pair.has("ownership_statement") && pair.has("reported_decision")) ||
    (pair.has("scope_statement") && pair.has("strategic_statement"));
}

function tokenize(value: string): string[] {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "on", "in", "is", "are", "be", "we", "this", "that"]);
  return normalizeText(value).split(" ").filter((token) => token.length > 2 && !stop.has(token));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

function nodeIdForEmbeddingTarget(
  targetType: "claim" | "evidence_span" | "entity" | "schema_pattern",
  targetId: string,
): string {
  if (targetType === "claim") return `claim:${targetId}`;
  if (targetType === "evidence_span") return `evidence:${targetId}`;
  if (targetType === "entity") return `entity:${targetId}`;
  return `schema:${targetId}`;
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/\b(?:sk|pk|eyJ)[A-Za-z0-9._-]{16,}\b/gu, "[redacted]")
    .slice(0, 1_000);
}

function structuredSectionLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function uniqueEvidenceSpans(spans: EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    if (seen.has(span.id)) return false;
    seen.add(span.id);
    return true;
  });
}

function dedupeTextTargets(values: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

async function requiredLedgerEvent(persistence: LoopPersistence, id: string): Promise<LedgerEvent> {
  const event = await persistence.loadLedgerEvent(id);
  if (!event) throw new Error(`causing ledger event not found: ${id}`);
  return event;
}

function enrichmentCompletionOutput(args: {
  targetEventType: "embeddings_updated" | "graph_updated";
  tenantId: string;
  causedByEventId: string;
  memoryItemIds: string[];
  provider: string;
  model: string;
}): PolicyOutput {
  return {
    proposedEvents: [{
      proposedEventType: "enrichment_update_proposed",
      targetEventType: args.targetEventType,
      subjectType: "memory",
      subjectId: args.memoryItemIds[0] ?? args.causedByEventId,
      payload: {
        causedByEventId: args.causedByEventId,
        seedMemoryItemIds: args.memoryItemIds,
        memoryItemIds: args.memoryItemIds,
      },
      memoryItemIds: args.memoryItemIds,
      requiresHumanApproval: false,
    }],
    provider: args.provider,
    model: args.model,
    promptVersion: CORPUS_SYNTHESIS_VERSION,
    schemaVersion: CORPUS_SYNTHESIS_VERSION,
    outputSchemaVersion: CORPUS_SYNTHESIS_VERSION,
  };
}

function validateSingleEnrichmentCompletion(
  output: PolicyOutput,
  targetEventType: "embeddings_updated" | "graph_updated",
): ValidationGateResult {
  const event = output.proposedEvents[0];
  if (output.proposedEvents.length !== 1 || event?.targetEventType !== targetEventType || event.memoryItemIds?.length === 0) {
    return {
      ok: false,
      issues: [{ code: "invalid_enrichment_completion", message: `${targetEventType} must identify at least one memory item.`, path: ["proposedEvents"] }],
    };
  }
  return { ok: true, issues: [] };
}

function defaultNewId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function leaseMatches(current: string | null | undefined, expected: string | undefined): boolean {
  return expected === undefined || current === expected;
}

function appendRecoveryError(existing: string | null | undefined, message: string): string {
  return existing ? `${existing}\n${message}` : message;
}

function renderIssues(issues: ValidationGateResult["issues"]): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
