import {
  EVENT_TYPES,
  type ClaimConnection,
  type ConflictGroup,
  type EventOutboxRow,
  type EventType,
  type EvidenceSpan,
  type GeneratedMemoryBatch,
  type InitiativeBrief,
  type LedgerEvent,
  type MemoryWithEvidence,
  type PendingWorkItem,
  type PolicyName,
  type PolicyRun,
  type ProposedEvent,
  type ProposedEventType,
  type ValidationGateResult,
  type WorkSubjectType,
} from "@distillery/contracts";
import {
  MEMORY_GENERATION_VERSION,
  MEMORY_PROMPT_VERSION,
  MEMORY_SCHEMA_VERSION,
  type CommittableMemoryItem,
  type IngestionContext,
} from "@distillery/memory-generation";
import type { InitiativeBriefDraftModel, MemoryGenerationModel } from "@distillery/model-gateway";
import type { EmbeddingModel } from "@distillery/model-gateway";
import {
  MEMORY_SYNTHESIS_VERSION,
  buildSynthesisBundle,
  validateInitiativeBriefDraftTraceability,
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
  fallbackReason?: string;
  promptVersion?: string;
  schemaVersion?: string;
  outputSchemaVersion?: string;
  rawResponse?: unknown;
  validationEvidenceSpans?: EvidenceSpan[];
};

export type PolicyInputEnvelope<T> = {
  input: T;
  inputHash: string;
  inputSummary: Record<string, unknown>;
};

export type ExtractMemoryInput = PolicyInputEnvelope<{
  ingestionId: string;
  tenantId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
  existingRelatedMemory: unknown[];
  memoryGenerationSchema: string;
}>;

export type SynthesizeBriefInput = PolicyInputEnvelope<{
  tenantId: string;
  causedByEventId: string;
  seedMemoryItemIds: string[];
  synthesisBundle: SynthesisBundle;
  selectedMemory: MemoryWithEvidence[];
}>;

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

export type LoopPersistence = {
  commitLedgerEventWithOutbox(input: Omit<LedgerEvent, "createdAt"> & { createdAt?: string }): Promise<LedgerEvent>;
  claimEventOutboxRow(): Promise<EventOutboxRow | null>;
  loadLedgerEvent(id: string): Promise<LedgerEvent | null>;
  markEventOutboxProcessed(id: string): Promise<void>;
  markEventOutboxFailed(id: string, error: string): Promise<void>;
  enqueuePendingWork(input: {
    tenantId: string;
    policy: PolicyName;
    subjectType: WorkSubjectType;
    subjectId: string;
    causedByEventId: string;
    inputVersion: string;
  }): Promise<{ workItem: PendingWorkItem; inserted: boolean }>;
  claimPendingWork(workItemId?: string): Promise<PendingWorkItem | null>;
  completePendingWork(id: string): Promise<void>;
  failPendingWork(id: string, error: string): Promise<void>;
  cancelPendingWork(id: string, reason: string): Promise<void>;
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
  ): Promise<void>;
  failPolicyRun(id: string, error: string, issues?: ValidationGateResult["issues"]): Promise<void>;
  createProposedEvent(input: Omit<ProposedEvent, "createdAt" | "updatedAt" | "validationStatus" | "validationIssues" | "reviewStatus" | "committedLedgerEventId">): Promise<ProposedEvent>;
  markProposedEventValid(id: string): Promise<void>;
  markProposedEventInvalid(id: string, issues: ValidationGateResult["issues"]): Promise<void>;
  approveProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent>;
  rejectProposedEvent(id: string, decision: { reviewerLabel: string; rationale?: string }): Promise<ProposedEvent>;
  commitValidatedProposedEvent(id: string): Promise<LedgerEvent>;
  getIngestionContextBySourceVersionId(sourceVersionId: string): Promise<IngestionContext>;
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
};

export type QueueLike = {
  send(message: { workItemId: string }): Promise<unknown>;
};

export const eventRoutes: EventRoute[] = [
  route("source_committed", "extract_memory", "source"),
  route("memory_committed", "connect_memory", "memory"),
  route("memory_committed", "detect_contradiction", "memory"),
  route("memory_committed", "discover_candidate", "memory"),
  route("memory_committed", "check_freshness", "memory"),
  route("memory_committed", "synthesize_brief", "memory"),
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
}): Promise<PendingWorkItem[]> {
  const workItems: PendingWorkItem[] = [];
  const maxRows = args.maxRows ?? 10;

  for (let count = 0; count < maxRows; count += 1) {
    const outboxRow = await args.persistence.claimEventOutboxRow();
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
        if (routed.inserted) {
          workItems.push(routed.workItem);
          await args.queue?.send({ workItemId: routed.workItem.id });
        }
      }

      await args.persistence.markEventOutboxProcessed(outboxRow.id);
    } catch (error) {
      await args.persistence.markEventOutboxFailed(
        outboxRow.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return workItems;
}

export function createPolicies(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  embeddingModel?: EmbeddingModel;
  initiativeBriefDraftModel?: InitiativeBriefDraftModel;
  newId?: (prefix: string) => string;
}): Record<PolicyName, Policy<unknown, PolicyOutput>> {
  const extractMemory = createExtractMemoryPolicy(args);
  const connectMemory = createConnectMemoryPolicy(args);
  const detectContradiction = createDetectContradictionPolicy(args);
  const synthesizeBrief = createSynthesizeBriefPolicy(args);
  return {
    extract_memory: extractMemory as Policy<unknown, PolicyOutput>,
    connect_memory: connectMemory as Policy<unknown, PolicyOutput>,
    discover_candidate: deterministicNoopPolicy("discover_candidate", "candidate_proposed", "candidate_created"),
    check_freshness: deterministicNoopPolicy("check_freshness", "freshness_warning_proposed", "freshness_warning_committed"),
    detect_contradiction: detectContradiction as Policy<unknown, PolicyOutput>,
    synthesize_brief: synthesizeBrief as Policy<unknown, PolicyOutput>,
    rank_candidate: deterministicNoopPolicy("rank_candidate", "candidate_proposed", "candidate_created"),
    draft_artifact: deterministicNoopPolicy("draft_artifact", "artifact_draft_proposed", "artifact_drafted"),
    gate_output: deterministicNoopPolicy("gate_output", "decision_record_proposed", "decision_committed"),
    revise_artifact: deterministicNoopPolicy("revise_artifact", "artifact_draft_proposed", "artifact_drafted"),
  };
}

export async function executeWorkItem(args: {
  persistence: LoopPersistence;
  policies: Record<PolicyName, Policy<unknown, PolicyOutput>>;
  workItemId?: string;
  newId?: (prefix: string) => string;
}): Promise<{ workItem: PendingWorkItem; proposedEvents: ProposedEvent[] } | null> {
  const newId = args.newId ?? defaultNewId;
  const workItem = await args.persistence.claimPendingWork(args.workItemId);
  if (!workItem) return null;

  const shape = validateWorkItemShape(workItem);
  if (!shape.ok) {
    await args.persistence.failPendingWork(workItem.id, renderIssues(shape.issues));
    return { workItem, proposedEvents: [] };
  }

  const policy = args.policies[workItem.policy];
  if (!policy) {
    await args.persistence.failPendingWork(workItem.id, `unknown policy: ${workItem.policy}`);
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
      startedAt,
      createdAt: startedAt,
    });

    const runShape = validatePolicyRunMetadataShape(policyRun);
    if (!runShape.ok) throw new Error(renderIssues(runShape.issues));

    const output = await policy.run(builtInput);
    const validation = mergeValidationResults([
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
    const proposedEvents: ProposedEvent[] = [];

    for (const draft of output.proposedEvents) {
      const proposedEvent = await args.persistence.createProposedEvent({
        id: newId("pevt"),
        tenantId: workItem.tenantId,
        workItemId: workItem.id,
        policyRunId: policyRun.id,
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
      });
      proposedEvents.push(proposedEvent);

      if (!validation.ok) {
        await args.persistence.markProposedEventInvalid(proposedEvent.id, validation.issues);
      } else {
        await args.persistence.markProposedEventValid(proposedEvent.id);
        if (!proposedEvent.requiresHumanApproval) {
          await args.persistence.commitValidatedProposedEvent(proposedEvent.id);
        }
      }
    }

    if (!validation.ok) {
      await args.persistence.failPendingWork(workItem.id, renderIssues(validation.issues));
    } else {
      await args.persistence.completePendingWork(workItem.id);
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
    });

    return { workItem, proposedEvents };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (policyRun) await args.persistence.failPolicyRun(policyRun.id, message);
    await args.persistence.failPendingWork(workItem.id, message);
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
  readonly memorySynthesisContext = new Map<string, MemoryWithEvidence>();
  readonly initiativeBriefs = new Map<string, InitiativeBrief>();
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
      processedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (![...this.eventOutboxRows.values()].some((row) => row.ledgerEventId === event.id)) {
      this.eventOutboxRows.set(outbox.id, outbox);
    }
    return event;
  }

  async claimEventOutboxRow(): Promise<EventOutboxRow | null> {
    const row = [...this.eventOutboxRows.values()]
      .filter((candidate) => candidate.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!row) return null;
    row.status = "processing";
    row.attempts += 1;
    row.lockedAt = now();
    row.updatedAt = now();
    return { ...row };
  }

  async loadLedgerEvent(id: string): Promise<LedgerEvent | null> {
    return this.ledgerEvents.get(id) ?? null;
  }

  async markEventOutboxProcessed(id: string): Promise<void> {
    const row = this.mustGet(this.eventOutboxRows, id, "event outbox row");
    row.status = "processed";
    row.processedAt = now();
    row.updatedAt = now();
  }

  async markEventOutboxFailed(id: string, error: string): Promise<void> {
    const row = this.mustGet(this.eventOutboxRows, id, "event outbox row");
    row.status = "failed";
    row.lastError = error;
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
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.pendingWorkItems.set(workItem.id, workItem);
    return { workItem, inserted: true };
  }

  async claimPendingWork(workItemId?: string): Promise<PendingWorkItem | null> {
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
    item.updatedAt = now();
    return { ...item };
  }

  async completePendingWork(id: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    item.status = "completed";
    item.completedAt = now();
    item.updatedAt = now();
  }

  async failPendingWork(id: string, error: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    item.status = "failed";
    item.lastError = error;
    item.completedAt = now();
    item.updatedAt = now();
  }

  async cancelPendingWork(id: string, reason: string): Promise<void> {
    const item = this.mustGet(this.pendingWorkItems, id, "pending work");
    item.status = "cancelled";
    item.lastError = reason;
    item.cancelledAt = now();
    item.updatedAt = now();
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

  async completePolicyRun(id: string, input: Partial<PolicyRun>): Promise<void> {
    const run = this.mustGet(this.policyRuns, id, "policy run");
    Object.assign(run, input, {
      status: "completed",
      completedAt: input.completedAt ?? now(),
    });
  }

  async failPolicyRun(id: string, error: string, issues: ValidationGateResult["issues"] = []): Promise<void> {
    const run = this.mustGet(this.policyRuns, id, "policy run");
    run.status = "failed";
    run.failureReason = error;
    run.validationOk = false;
    run.validationIssues = issues;
    run.completedAt = now();
    run.latencyMs = Date.now() - Date.parse(run.startedAt);
  }

  async createProposedEvent(input: Omit<ProposedEvent, "createdAt" | "updatedAt" | "validationStatus" | "validationIssues" | "reviewStatus" | "committedLedgerEventId">): Promise<ProposedEvent> {
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
    }

    if (proposal.targetEventType === "artifact_drafted") {
      this.createInitiativeBriefDraftFromProposal(proposal);
    }

    if (proposal.targetEventType === "memory_connected") {
      this.createMemoryConnectionsFromProposal(proposal);
    }

    if (proposal.targetEventType === "contradiction_recorded") {
      this.createConflictGroupsFromProposal(proposal);
    }

    const event = await this.commitLedgerEventWithOutbox({
      id: this.nextId("levt"),
      tenantId: proposal.tenantId,
      eventType: proposal.targetEventType,
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      actorType: "policy",
      actorLabel: proposal.policyRunId ?? proposal.workItemId ?? null,
      causedByWorkItemId: proposal.workItemId ?? null,
      inputVersion: proposal.policyRunId ?? proposal.id,
      idempotencyKey: `proposal:${proposal.id}`,
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
    this.extractionRuns.push(input);
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

  seedIngestionContext(context: IngestionContext): void {
    this.ingestionContextsBySourceVersionId.set(context.sourceVersionId, context);
  }

  seedMemorySynthesisContext(records: MemoryWithEvidence[]): void {
    for (const record of records) {
      this.memorySynthesisContext.set(record.memoryItem.id, record);
    }
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

  private createInitiativeBriefDraftFromProposal(proposal: ProposedEvent): void {
    const briefId = String(proposal.payload.briefId ?? proposal.subjectId);
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
        scoreComponents: numericRecord(connection.scoreComponents),
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
}

function createExtractMemoryPolicy(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
  embeddingModel?: EmbeddingModel;
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
      const generated = await args.memoryModel.generateMemory({
        ingestionId: envelope.input.ingestionId,
        sourceVersionId: envelope.input.sourceVersionId,
        evidenceSpans: envelope.input.evidenceSpans,
      });
      const extractionRunId = newId("extr");
      await args.persistence.recordExtractionRun({
        id: extractionRunId,
        ingestionId: envelope.input.ingestionId,
        tenantId: envelope.input.tenantId,
        provider: "openrouter",
        model: generated.model,
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: generated.raw,
        status: "completed",
      });
      const generatedMemory = validateGeneratedMemory({
        generated: generated.parsed,
        allowedEvidenceSpans: envelope.input.evidenceSpans,
      });
      const items = generatedMemory.items.map((item) => ({
        id: newId("mem"),
        claimType: item.claimType,
        statement: item.statement,
        evidenceSpanIds: item.evidenceSpanIds,
        epistemicStatus: item.epistemicStatus,
        qualifiers: item.qualifiers,
        stableDomainTags: item.stableDomainTags,
        entities: item.entities,
        relations: item.relations,
        schemas: item.schemas,
      }));

      let embeddingMetadata: Record<string, unknown> | undefined;
      if (args.embeddingModel) {
        embeddingMetadata = await generateAndStoreEmbeddings({
          persistence: args.persistence,
          embeddingModel: args.embeddingModel,
          tenantId: envelope.input.tenantId,
          items,
          evidenceSpans: envelope.input.evidenceSpans,
          newId,
        });
      }

      return {
        proposedEvents: [{
          proposedEventType: "memory_proposed",
          targetEventType: "memory_committed",
          subjectType: "memory",
          subjectId: envelope.input.sourceVersionId,
          payload: {
            ingestionId: envelope.input.ingestionId,
            sourceVersionId: envelope.input.sourceVersionId,
            extractionRunId,
            memoryGenerationVersion: MEMORY_GENERATION_VERSION,
            items,
            ...(embeddingMetadata ? { embeddingMetadata } : {}),
          },
          evidenceSpanIds: [...new Set(items.flatMap((item) => item.evidenceSpanIds))],
          memoryItemIds: items.map((item) => item.id),
          requiresHumanApproval: false,
        }],
        provider: "openrouter",
        model: generated.model,
        promptVersion: MEMORY_PROMPT_VERSION,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        outputSchemaVersion: MEMORY_SCHEMA_VERSION,
        rawResponse: generated.raw,
        validationEvidenceSpans: envelope.input.evidenceSpans,
      };
    },
    async validate(output) {
      const draft = output.proposedEvents[0];
      if (!draft || draft.proposedEventType !== "memory_proposed") {
        return {
          ok: false,
          issues: [{ code: "missing_memory_proposal", message: "extract_memory must emit memory_proposed.", path: [] }],
        };
      }
      const parsed = GeneratedMemoryBatchFromPayload(draft.payload);
      return validateGeneratedMemory({
        generated: parsed,
        allowedEvidenceSpans: output.validationEvidenceSpans ?? [],
      }).result;
    },
  };
}

function createConnectMemoryPolicy(args: {
  persistence: LoopPersistence;
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
      const connections = buildDeterministicConnections(envelope.input.memory, newId);
      if (connections.length === 0) {
        return {
          proposedEvents: [],
          provider: "deterministic",
          model: "connect-memory-v0.1",
          fallbackReason: "No graph-grounded connection candidates crossed the pilot threshold.",
        };
      }
      return {
        proposedEvents: [{
          proposedEventType: "memory_connection_proposed",
          targetEventType: "memory_connected",
          subjectType: "memory",
          subjectId: envelope.input.seedMemoryItemIds[0] ?? envelope.input.causedByEventId,
          payload: {
            causedByEventId: envelope.input.causedByEventId,
            seedMemoryItemIds: envelope.input.seedMemoryItemIds,
            connections,
          },
          evidenceSpanIds: uniqueStrings(connections.flatMap((connection) => connection.evidenceSpanIds)),
          memoryItemIds: uniqueStrings(connections.flatMap((connection) => [connection.fromClaimId, connection.toClaimId])),
          requiresHumanApproval: false,
        }],
        provider: "deterministic",
        model: "connect-memory-v0.1",
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
      if (conflicts.length === 0) {
        return {
          proposedEvents: [],
          provider: "deterministic",
          model: "detect-contradiction-v0.1",
          fallbackReason: "No deterministic conflict candidates found.",
        };
      }
      return {
        proposedEvents: [{
          proposedEventType: "contradiction_proposed",
          targetEventType: "contradiction_recorded",
          subjectType: "memory",
          subjectId: envelope.input.seedMemoryItemIds[0] ?? envelope.input.causedByEventId,
          payload: {
            causedByEventId: envelope.input.causedByEventId,
            seedMemoryItemIds: envelope.input.seedMemoryItemIds,
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

function createSynthesizeBriefPolicy(args: {
  persistence: LoopPersistence;
  initiativeBriefDraftModel?: InitiativeBriefDraftModel;
  newId?: (prefix: string) => string;
}): Policy<SynthesizeBriefInput, PolicyOutput> {
  const newId = args.newId ?? defaultNewId;
  return {
    name: "synthesize_brief",
    version: "synthesize-brief-v0.1",
    async buildInput(workItem) {
      const ledgerEvent = await args.persistence.loadLedgerEvent(workItem.causedByEventId);
      if (!ledgerEvent) throw new Error(`causing ledger event not found: ${workItem.causedByEventId}`);

      const seedMemoryItemIds = extractSeedMemoryItemIds(ledgerEvent.payload);
      const context = await args.persistence.getMemorySynthesisContext({
        tenantId: ledgerEvent.tenantId,
        seedMemoryItemIds,
        limit: 100,
      });
      const { bundle, selectedMemory } = buildSynthesisBundle({
        seedMemoryItemIds,
        memory: context,
        maxMemoryItems: 8,
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
        },
      };
    },
    async run(envelope) {
      const selectedMemoryItems = envelope.input.selectedMemory.map((record) => record.memoryItem);
      const selectedEvidenceSpans = uniqueEvidenceSpans(envelope.input.selectedMemory.flatMap((record) => record.evidenceSpans));

      if (!envelope.input.synthesisBundle.readiness.ready) {
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

      const generated = await args.initiativeBriefDraftModel.generateInitiativeBriefDraft({
        memoryItems: selectedMemoryItems,
        evidenceSpans: selectedEvidenceSpans,
        intent: renderSynthesisIntent(envelope.input.synthesisBundle),
      });
      const validation = validateInitiativeBriefDraftTraceability({
        draft: generated.parsed,
        selectedMemoryItems,
        selectedEvidenceSpans,
      });

      if (!validation.ok) {
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
            selectedMemoryItemIds: selectedMemoryItems.map((item) => item.id),
            selectedEvidenceSpanIds: selectedEvidenceSpans.map((span) => span.id),
            synthesisBundle: envelope.input.synthesisBundle,
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
  scoreComponents: Record<string, number>;
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

async function generateAndStoreEmbeddings(args: {
  persistence: LoopPersistence;
  embeddingModel: EmbeddingModel;
  tenantId: string;
  items: CommittableMemoryItem[];
  evidenceSpans: EvidenceSpan[];
  newId: (prefix: string) => string;
}): Promise<Record<string, unknown>> {
  const targets = uniqueEmbeddingTargets([
    ...args.items.map((item) => ({
      targetType: "claim" as const,
      targetId: item.id,
      content: item.statement,
    })),
    ...args.evidenceSpans.map((span) => ({
      targetType: "evidence_span" as const,
      targetId: span.id,
      content: span.text,
    })),
    ...args.items.flatMap((item) =>
      item.entities.map((entity) => {
        const canonicalName = entity.canonicalName ?? entity.name;
        return {
          targetType: "entity" as const,
          targetId: stableEntityId(args.tenantId, canonicalName, entity.entityType),
          content: `${canonicalName} (${entity.entityType})`,
        };
      })
    ),
    ...args.items.flatMap((item) =>
      item.schemas.map((schema) => ({
        targetType: "schema_pattern" as const,
        targetId: stableSchemaId(args.tenantId, schema.subjectType, schema.predicate, schema.objectType),
        content: `${schema.subjectType} ${schema.predicate} ${schema.objectType}`,
      }))
    ),
  ]);

  const embeddings: Array<{
    id: string;
    targetType: "claim" | "evidence_span" | "entity" | "schema_pattern";
    targetId: string;
    embeddingModel: string;
    embedding: number[];
    contentHash: string;
  }> = [];

  for (const targetType of ["claim", "evidence_span", "entity", "schema_pattern"] as const) {
    const typedTargets = targets.filter((target) => target.targetType === targetType);
    if (typedTargets.length === 0) continue;
    const response = await args.embeddingModel.embed({
      targetType,
      input: typedTargets.map((target) => target.content),
    });
    for (const [index, vector] of response.vectors.entries()) {
      const target = typedTargets[index];
      if (!target) continue;
      embeddings.push({
        id: args.newId("emb"),
        targetType,
        targetId: target.targetId,
        embeddingModel: response.model,
        embedding: vector,
        contentHash: await sha256Hex(target.content),
      });
    }
  }

  await args.persistence.upsertMemoryEmbeddings({
    tenantId: args.tenantId,
    embeddings,
  });

  return {
    embeddingCount: embeddings.length,
    targetTypes: uniqueStrings(embeddings.map((embedding) => embedding.targetType)),
    models: uniqueStrings(embeddings.map((embedding) => embedding.embeddingModel)),
  };
}

function uniqueEmbeddingTargets<T extends {
  targetType: "claim" | "evidence_span" | "entity" | "schema_pattern";
  targetId: string;
  content: string;
}>(targets: T[]): T[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.targetType}:${target.targetId}:${target.content}`;
    if (seen.has(key) || target.content.trim().length === 0) return false;
    seen.add(key);
    return true;
  });
}

function stableEntityId(tenantId: string, canonicalName: string, entityType: string): string {
  return `entity_${syncHash(`${tenantId}:${canonicalName.toLowerCase()}:${entityType.toLowerCase()}`)}`;
}

function stableSchemaId(tenantId: string, subjectType: string, predicate: string, objectType: string): string {
  return `schema_${syncHash(`${tenantId}:${subjectType.toLowerCase()}:${predicate.toLowerCase()}:${objectType.toLowerCase()}`)}`;
}

function syncHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
  if (!Number.isFinite(confidence) || confidence < 0.55 || confidence > 1) {
    issues.push({ code: "invalid_connection_confidence", message: "Connection confidence must be between 0.55 and 1.", path: [`connections.${index}.confidence`] });
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

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function numericRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
  );
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

function renderSynthesisIntent(bundle: SynthesisBundle): string {
  return [
    "Draft an initiative brief only from the selected memory and evidence.",
    `Seed memory: ${bundle.seedMemoryItemIds.join(", ")}`,
    `Connection reasons: ${bundle.connections.map((connection) => `${connection.reason}(${connection.fromMemoryItemId}->${connection.toMemoryItemId})`).join(", ")}`,
    bundle.readiness.warningReasons.length > 0
      ? `Warnings to surface: ${bundle.readiness.warningReasons.join("; ")}`
      : "",
  ].filter(Boolean).join("\n");
}

function defaultNewId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
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
