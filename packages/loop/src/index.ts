import {
  EVENT_TYPES,
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
  initiativeBriefDraftModel?: InitiativeBriefDraftModel;
  newId?: (prefix: string) => string;
}): Record<PolicyName, Policy<unknown, PolicyOutput>> {
  const extractMemory = createExtractMemoryPolicy(args);
  const synthesizeBrief = createSynthesizeBriefPolicy(args);
  return {
    extract_memory: extractMemory as Policy<unknown, PolicyOutput>,
    discover_candidate: deterministicNoopPolicy("discover_candidate", "candidate_proposed", "candidate_created"),
    check_freshness: deterministicNoopPolicy("check_freshness", "freshness_warning_proposed", "freshness_warning_committed"),
    detect_contradiction: deterministicNoopPolicy("detect_contradiction", "contradiction_proposed", "contradiction_recorded"),
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
  readonly ingestionContextsBySourceVersionId = new Map<string, IngestionContext>();
  readonly memorySynthesisContext = new Map<string, MemoryWithEvidence>();
  readonly initiativeBriefs = new Map<string, InitiativeBrief>();
  readonly committedMemory: CommittableMemoryItem[] = [];
  readonly extractionRuns: unknown[] = [];
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
}

function createExtractMemoryPolicy(args: {
  persistence: LoopPersistence;
  memoryModel: MemoryGenerationModel;
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
