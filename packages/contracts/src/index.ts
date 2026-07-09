import { z } from "zod";

export const CLAIM_TYPES = [
  "fact",
  "user_signal",
  "reported_decision",
  "metric",
  "risk",
  "dependency",
  "constraint",
  "strategic_statement",
  "ownership_statement",
  "scope_statement",
] as const;

export const MEMORY_SCHEMA_STATUSES = [
  "candidate",
  "stable",
  "rejected",
] as const;

export const EPISTEMIC_STATUSES = [
  "observed",
  "reported",
  "inferred",
  "assumption",
  "decision_reported",
] as const;

export const INGESTION_STATUSES = [
  "received",
  "evidence_stored",
  "generating",
  "validating",
  "memory_stored",
  "ready",
  "failed",
] as const;

export const MEMORY_REVIEW_STATES = [
  "unreviewed",
  "confirmed",
  "removed",
  "superseded",
] as const;

export const MEMORY_ITEM_ACTIONS = [
  "confirm",
  "edit",
  "remove",
] as const;

export const INITIATIVE_BRIEF_STATUSES = [
  "draft",
  "approved",
  "rejected",
] as const;

export const INITIATIVE_BRIEF_DECISIONS = [
  "approve",
  "reject",
] as const;

export const POLICY_NAMES = [
  "extract_memory",
  "connect_memory",
  "discover_candidate",
  "check_freshness",
  "detect_contradiction",
  "synthesize_brief",
  "rank_candidate",
  "draft_artifact",
  "gate_output",
  "revise_artifact",
] as const;

export const EVENT_TYPES = [
  "source_committed",
  "memory_committed",
  "memory_connected",
  "memory_confirmed",
  "memory_edited",
  "memory_removed",
  "candidate_created",
  "candidate_approved",
  "candidate_rejected",
  "artifact_drafted",
  "artifact_approved",
  "artifact_rejected",
  "artifact_delivered",
  "decision_committed",
  "freshness_warning_committed",
  "contradiction_recorded",
  "policy_run_recorded",
] as const;

export const PROPOSED_EVENT_TYPES = [
  "memory_proposed",
  "memory_connection_proposed",
  "candidate_proposed",
  "artifact_draft_proposed",
  "freshness_warning_proposed",
  "contradiction_proposed",
  "decision_record_proposed",
] as const;

export const ACTOR_TYPES = [
  "human",
  "policy",
  "router",
  "system",
  "connector",
] as const;

export const WORK_SUBJECT_TYPES = [
  "source",
  "memory",
  "candidate",
  "artifact",
  "decision",
  "system",
] as const;

export const WORK_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const OUTBOX_STATUSES = [
  "pending",
  "processing",
  "processed",
  "failed",
] as const;

export const POLICY_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const PROPOSED_EVENT_VALIDATION_STATUSES = [
  "pending",
  "valid",
  "invalid",
] as const;

export const PROPOSED_EVENT_REVIEW_STATUSES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
] as const;

export const LOOP_STAGE_KEYS = [
  "source_committed",
  "routed",
  "work_queued",
  "policy_running",
  "proposed_event",
  "validated",
  "ledger_committed",
  "human_review",
] as const;

export const LOOP_STAGE_STATUSES = [
  "not_started",
  "pending",
  "running",
  "completed",
  "failed",
  "waiting",
] as const;

export const LOOP_TIMELINE_ITEM_KINDS = [
  "ledger_event",
  "outbox",
  "work",
  "policy_run",
  "proposed_event",
  "system",
] as const;

export const LOOP_TIMELINE_SEVERITIES = [
  "info",
  "success",
  "warning",
  "error",
] as const;

export const CLAIM_CONNECTION_TYPES = [
  "same_initiative_signal",
  "supports",
  "depends_on",
  "blocks",
  "duplicates",
  "refines",
  "motivates",
  "related_context",
] as const;

export const CLAIM_CONNECTION_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
] as const;

export const CONFLICT_TYPES = [
  "mutual",
  "temporal",
  "granularity",
  "scope",
  "decision",
  "ownership",
  "dependency",
  "metric_definition",
] as const;

export const CONFLICT_SEVERITIES = ["blocking", "warning"] as const;
export const CONFLICT_STATUSES = ["open", "resolved", "dismissed"] as const;
export const GRAPH_NODE_TYPES = ["claim", "entity", "schema", "evidence", "conflict"] as const;

export const CaptureModeSchema = z.enum(["remember", "ask"]);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

export const ClaimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const MemoryEntitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  entityType: z.string().trim().min(1).max(80),
  canonicalName: z.string().trim().min(1).max(200).nullable().optional(),
});
export type MemoryEntity = z.infer<typeof MemoryEntitySchema>;

export const MemoryRelationSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(120),
  object: z.string().trim().min(1).max(300),
  evidenceSpanIds: z.array(z.string().min(1)).min(1).max(12),
});
export type MemoryRelation = z.infer<typeof MemoryRelationSchema>;

export const MemorySchemaStatusSchema = z.enum(MEMORY_SCHEMA_STATUSES);
export type MemorySchemaStatus = z.infer<typeof MemorySchemaStatusSchema>;

export const MemorySchemaCandidateSchema = z.object({
  subjectType: z.string().trim().min(1).max(80),
  predicate: z.string().trim().min(1).max(120),
  objectType: z.string().trim().min(1).max(80),
  status: MemorySchemaStatusSchema.default("candidate"),
});
export type MemorySchemaCandidate = z.infer<typeof MemorySchemaCandidateSchema>;

export const EpistemicStatusSchema = z.enum(EPISTEMIC_STATUSES);
export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

export const IngestionStatusSchema = z.enum(INGESTION_STATUSES);
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;

export const MemoryReviewStateSchema = z.enum(MEMORY_REVIEW_STATES);
export type MemoryReviewState = z.infer<typeof MemoryReviewStateSchema>;

export const MemoryItemActionSchema = z.enum(MEMORY_ITEM_ACTIONS);
export type MemoryItemAction = z.infer<typeof MemoryItemActionSchema>;

export const InitiativeBriefStatusSchema = z.enum(INITIATIVE_BRIEF_STATUSES);
export type InitiativeBriefStatus = z.infer<typeof InitiativeBriefStatusSchema>;

export const InitiativeBriefDecisionSchema = z.enum(INITIATIVE_BRIEF_DECISIONS);
export type InitiativeBriefDecision = z.infer<typeof InitiativeBriefDecisionSchema>;

export const PolicyNameSchema = z.enum(POLICY_NAMES);
export type PolicyName = z.infer<typeof PolicyNameSchema>;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const ProposedEventTypeSchema = z.enum(PROPOSED_EVENT_TYPES);
export type ProposedEventType = z.infer<typeof ProposedEventTypeSchema>;

export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const WorkSubjectTypeSchema = z.enum(WORK_SUBJECT_TYPES);
export type WorkSubjectType = z.infer<typeof WorkSubjectTypeSchema>;

export const WorkStatusSchema = z.enum(WORK_STATUSES);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

export const EventOutboxStatusSchema = z.enum(OUTBOX_STATUSES);
export type EventOutboxStatus = z.infer<typeof EventOutboxStatusSchema>;

export const PolicyRunStatusSchema = z.enum(POLICY_RUN_STATUSES);
export type PolicyRunStatus = z.infer<typeof PolicyRunStatusSchema>;

export const ProposedEventValidationStatusSchema = z.enum(PROPOSED_EVENT_VALIDATION_STATUSES);
export type ProposedEventValidationStatus = z.infer<typeof ProposedEventValidationStatusSchema>;

export const ProposedEventReviewStatusSchema = z.enum(PROPOSED_EVENT_REVIEW_STATUSES);
export type ProposedEventReviewStatus = z.infer<typeof ProposedEventReviewStatusSchema>;

export const LoopStageKeySchema = z.enum(LOOP_STAGE_KEYS);
export type LoopStageKey = z.infer<typeof LoopStageKeySchema>;

export const LoopStageStatusSchema = z.enum(LOOP_STAGE_STATUSES);
export type LoopStageStatus = z.infer<typeof LoopStageStatusSchema>;

export const LoopTimelineItemKindSchema = z.enum(LOOP_TIMELINE_ITEM_KINDS);
export type LoopTimelineItemKind = z.infer<typeof LoopTimelineItemKindSchema>;

export const LoopTimelineSeveritySchema = z.enum(LOOP_TIMELINE_SEVERITIES);
export type LoopTimelineSeverity = z.infer<typeof LoopTimelineSeveritySchema>;

export const ClaimConnectionTypeSchema = z.enum(CLAIM_CONNECTION_TYPES);
export type ClaimConnectionType = z.infer<typeof ClaimConnectionTypeSchema>;

export const ClaimConnectionStatusSchema = z.enum(CLAIM_CONNECTION_STATUSES);
export type ClaimConnectionStatus = z.infer<typeof ClaimConnectionStatusSchema>;

export const ConflictTypeSchema = z.enum(CONFLICT_TYPES);
export type ConflictType = z.infer<typeof ConflictTypeSchema>;

export const ConflictSeveritySchema = z.enum(CONFLICT_SEVERITIES);
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;

export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

export const GraphNodeTypeSchema = z.enum(GRAPH_NODE_TYPES);
export type GraphNodeType = z.infer<typeof GraphNodeTypeSchema>;

export const IsoDateTimeStringSchema = z.string().min(1);

export const ValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.string()).default([]),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssueSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const LedgerEventSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  eventType: EventTypeSchema,
  subjectType: WorkSubjectTypeSchema,
  subjectId: z.string().min(1),
  actorType: ActorTypeSchema,
  actorLabel: z.string().nullable().optional(),
  causedByEventId: z.string().nullable().optional(),
  causedByWorkItemId: z.string().nullable().optional(),
  inputVersion: z.string().nullable().optional(),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateTimeStringSchema,
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export const EventOutboxRowSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  ledgerEventId: z.string().min(1),
  status: EventOutboxStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().nullable().optional(),
  lockedAt: IsoDateTimeStringSchema.nullable().optional(),
  processedAt: IsoDateTimeStringSchema.nullable().optional(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});
export type EventOutboxRow = z.infer<typeof EventOutboxRowSchema>;

export const PendingWorkItemSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  policy: PolicyNameSchema,
  subjectType: WorkSubjectTypeSchema,
  subjectId: z.string().min(1),
  causedByEventId: z.string().min(1),
  inputVersion: z.string().min(1),
  status: WorkStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().nullable().optional(),
  lockedAt: IsoDateTimeStringSchema.nullable().optional(),
  startedAt: IsoDateTimeStringSchema.nullable().optional(),
  completedAt: IsoDateTimeStringSchema.nullable().optional(),
  cancelledAt: IsoDateTimeStringSchema.nullable().optional(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});
export type PendingWorkItem = z.infer<typeof PendingWorkItemSchema>;

export const PolicyRunSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workItemId: z.string().min(1),
  causedByEventId: z.string().nullable().optional(),
  policyName: PolicyNameSchema,
  policyVersion: z.string().min(1),
  status: PolicyRunStatusSchema,
  inputVersion: z.string().min(1),
  inputHash: z.string().min(1),
  inputSummary: z.record(z.string(), z.unknown()).default({}),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  fallbackUsed: z.boolean().default(false),
  fallbackReason: z.string().nullable().optional(),
  promptVersion: z.string().nullable().optional(),
  schemaVersion: z.string().nullable().optional(),
  outputSchemaVersion: z.string().nullable().optional(),
  validationOk: z.boolean().nullable().optional(),
  validationIssues: z.array(ValidationIssueSchema).default([]),
  failureReason: z.string().nullable().optional(),
  retryCount: z.number().int().min(0).default(0),
  rawResponseHash: z.string().nullable().optional(),
  rawResponseRef: z.string().nullable().optional(),
  promptTokens: z.number().int().min(0).nullable().optional(),
  completionTokens: z.number().int().min(0).nullable().optional(),
  totalTokens: z.number().int().min(0).nullable().optional(),
  estimatedCostUsd: z.number().nullable().optional(),
  startedAt: IsoDateTimeStringSchema,
  completedAt: IsoDateTimeStringSchema.nullable().optional(),
  latencyMs: z.number().int().min(0).nullable().optional(),
  createdAt: IsoDateTimeStringSchema,
});
export type PolicyRun = z.infer<typeof PolicyRunSchema>;

export const ProposedEventSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workItemId: z.string().nullable().optional(),
  policyRunId: z.string().nullable().optional(),
  proposedEventType: ProposedEventTypeSchema,
  targetEventType: EventTypeSchema,
  subjectType: WorkSubjectTypeSchema,
  subjectId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  evidenceSpanIds: z.array(z.string().min(1)).default([]),
  memoryItemIds: z.array(z.string().min(1)).default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
  requiresHumanApproval: z.boolean(),
  validationStatus: ProposedEventValidationStatusSchema.default("pending"),
  validationIssues: z.array(ValidationIssueSchema).default([]),
  reviewStatus: ProposedEventReviewStatusSchema.default("not_required"),
  reviewerLabel: z.string().nullable().optional(),
  reviewRationale: z.string().nullable().optional(),
  committedLedgerEventId: z.string().nullable().optional(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});
export type ProposedEvent = z.infer<typeof ProposedEventSchema>;

export const ValidationGateResultSchema = ValidationResultSchema;
export type ValidationGateResult = z.infer<typeof ValidationGateResultSchema>;

export const HumanReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reviewerLabel: z.string().trim().min(1).max(160),
  rationale: z.string().trim().max(2_000).optional(),
});
export type HumanReviewDecision = z.infer<typeof HumanReviewDecisionSchema>;

export const LoopTechnicalReferenceSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
}).strict();
export type LoopTechnicalReference = z.infer<typeof LoopTechnicalReferenceSchema>;

export const LoopStageSchema = z.object({
  key: LoopStageKeySchema,
  label: z.string().min(1),
  status: LoopStageStatusSchema,
  description: z.string().optional(),
  occurredAt: IsoDateTimeStringSchema.nullable().optional(),
  detail: z.string().nullable().optional(),
}).strict();
export type LoopStage = z.infer<typeof LoopStageSchema>;

export const LoopTimelineItemSchema = z.object({
  id: z.string().min(1),
  kind: LoopTimelineItemKindSchema,
  label: z.string().min(1),
  status: z.string().min(1),
  occurredAt: IsoDateTimeStringSchema,
  summary: z.string().min(1),
  severity: LoopTimelineSeveritySchema.default("info"),
  technical: z.array(LoopTechnicalReferenceSchema).default([]),
}).strict();
export type LoopTimelineItem = z.infer<typeof LoopTimelineItemSchema>;

export const LoopStatusSubjectSchema = z.object({
  ingestionId: z.string().min(1).optional(),
  subjectType: WorkSubjectTypeSchema.optional(),
  subjectId: z.string().min(1).optional(),
}).strict();
export type LoopStatusSubject = z.infer<typeof LoopStatusSubjectSchema>;

export const LoopStatusResponseSchema = z.object({
  mode: z.enum(["current", "activity"]),
  subject: LoopStatusSubjectSchema.nullable(),
  summary: z.string().min(1),
  isTerminal: z.boolean(),
  lastUpdatedAt: IsoDateTimeStringSchema,
  stages: z.array(LoopStageSchema),
  timeline: z.array(LoopTimelineItemSchema),
  activity: z.array(LoopTimelineItemSchema),
}).strict();
export type LoopStatusResponse = z.infer<typeof LoopStatusResponseSchema>;

export const StableDomainTagSchema = z.string().min(1).max(64);

export const CaptureInputSchema = z.object({
  mode: CaptureModeSchema.default("remember"),
  text: z.string().trim().min(1).max(50_000),
  submittedByLabel: z.string().trim().max(160).optional(),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
});
export type CaptureInput = z.infer<typeof CaptureInputSchema>;

export const RecallQueryInputSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(20).default(8),
});
export type RecallQueryInput = z.infer<typeof RecallQueryInputSchema>;

export const EvidenceSpanSchema = z.object({
  id: z.string().min(1),
  sourceVersionId: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  text: z.string(),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const GeneratedMemoryItemSchema = z.object({
  temporaryId: z.string().min(1).max(80),
  claimType: ClaimTypeSchema,
  statement: z.string().trim().min(1).max(2_000),
  evidenceSpanIds: z.array(z.string().min(1)).min(1).max(12),
  epistemicStatus: EpistemicStatusSchema,
  qualifiers: z.record(z.string(), z.unknown()).default({}),
  stableDomainTags: z.array(StableDomainTagSchema).default([]),
  entities: z.array(MemoryEntitySchema).default([]),
  relations: z.array(MemoryRelationSchema).default([]),
  schemas: z.array(MemorySchemaCandidateSchema).default([]),
});
export type GeneratedMemoryItem = z.infer<typeof GeneratedMemoryItemSchema>;

export const GeneratedMemoryBatchSchema = z.object({
  items: z.array(GeneratedMemoryItemSchema).max(30),
});
export type GeneratedMemoryBatch = z.infer<typeof GeneratedMemoryBatchSchema>;

export const MemoryItemSchema = GeneratedMemoryItemSchema.omit({
  temporaryId: true,
}).extend({
  id: z.string().min(1),
  ingestionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  reviewState: MemoryReviewStateSchema.default("unreviewed"),
  supersedesMemoryItemId: z.string().min(1).nullable().optional(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const MemoryItemActionInputSchema = z.object({
  action: MemoryItemActionSchema,
  reviewerLabel: z.string().trim().min(1).max(160),
  rationale: z.string().trim().max(2_000).optional(),
  replacement: GeneratedMemoryItemSchema.omit({
    temporaryId: true,
  }).optional(),
}).superRefine((value, context) => {
  if (value.action === "edit" && !value.replacement) {
    context.addIssue({
      code: "custom",
      path: ["replacement"],
      message: "Edit actions require a replacement memory item.",
    });
  }

  if (value.action !== "edit" && value.replacement) {
    context.addIssue({
      code: "custom",
      path: ["replacement"],
      message: "Only edit actions may include a replacement memory item.",
    });
  }
});
export type MemoryItemActionInput = z.infer<typeof MemoryItemActionInputSchema>;

export const MemoryItemHistoryEventSchema = z.object({
  id: z.string().min(1),
  memoryItemId: z.string().min(1),
  eventType: MemoryItemActionSchema,
  reviewerLabel: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  replacementMemoryItemId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type MemoryItemHistoryEvent = z.infer<typeof MemoryItemHistoryEventSchema>;

export const MemoryItemHistorySchema = z.object({
  memoryItem: MemoryItemSchema,
  events: z.array(MemoryItemHistoryEventSchema),
  replacements: z.array(MemoryItemSchema).default([]),
});
export type MemoryItemHistory = z.infer<typeof MemoryItemHistorySchema>;

export const IngestionReceiptSchema = z.object({
  ingestionId: z.string().min(1),
  status: IngestionStatusSchema,
  sourceVersionId: z.string().min(1).optional(),
});
export type IngestionReceipt = z.infer<typeof IngestionReceiptSchema>;

export const IngestionResultSchema = z.object({
  ingestionId: z.string().min(1),
  status: IngestionStatusSchema,
  sourceVersionId: z.string().min(1).optional(),
  evidenceSpans: z.array(EvidenceSpanSchema).default([]),
  memoryItems: z.array(MemoryItemSchema).default([]),
  errorMessage: z.string().nullable().optional(),
});
export type IngestionResult = z.infer<typeof IngestionResultSchema>;

export const MemoryReadyEventSchema = z.object({
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  ingestionId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  memoryItemIds: z.array(z.string().min(1)),
  memoryGenerationVersion: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type MemoryReadyEvent = z.infer<typeof MemoryReadyEventSchema>;

export const RecallMatchSchema = z.object({
  memoryItem: MemoryItemSchema,
  evidenceSpans: z.array(EvidenceSpanSchema),
  rank: z.number().default(0),
});
export type RecallMatch = z.infer<typeof RecallMatchSchema>;

export const MemoryWithEvidenceSchema = z.object({
  memoryItem: MemoryItemSchema,
  evidenceSpans: z.array(EvidenceSpanSchema),
});
export type MemoryWithEvidence = z.infer<typeof MemoryWithEvidenceSchema>;

export const GraphRetrievalClaimSchema = z.object({
  claim: MemoryItemSchema,
  evidenceSpans: z.array(EvidenceSpanSchema),
  rank: z.number().default(0),
  graphScore: z.number().default(0),
  lexicalScore: z.number().default(0),
  vectorScore: z.number().default(0),
  connectionIds: z.array(z.string().min(1)).default([]),
});
export type GraphRetrievalClaim = z.infer<typeof GraphRetrievalClaimSchema>;

export const ClaimConnectionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  fromClaimId: z.string().min(1),
  toClaimId: z.string().min(1),
  connectionType: ClaimConnectionTypeSchema,
  status: ClaimConnectionStatusSchema.default("proposed"),
  confidence: z.number().min(0).max(1),
  scoreComponents: z.record(z.string(), z.number()).default({}),
  evidenceSpanIds: z.array(z.string().min(1)).default([]),
  rationale: z.string().nullable().optional(),
  createdByPolicyRunId: z.string().nullable().optional(),
  reviewerLabel: z.string().nullable().optional(),
  reviewRationale: z.string().nullable().optional(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});
export type ClaimConnection = z.infer<typeof ClaimConnectionSchema>;

export const ConflictMemberSchema = z.object({
  conflictGroupId: z.string().min(1),
  claimId: z.string().min(1),
  role: z.string().min(1),
  evidenceSpanIds: z.array(z.string().min(1)).default([]),
});
export type ConflictMember = z.infer<typeof ConflictMemberSchema>;

export const ConflictGroupSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  conflictType: ConflictTypeSchema,
  severity: ConflictSeveritySchema,
  status: ConflictStatusSchema.default("open"),
  summary: z.string().min(1),
  createdByPolicyRunId: z.string().nullable().optional(),
  members: z.array(ConflictMemberSchema).default([]),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});
export type ConflictGroup = z.infer<typeof ConflictGroupSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  nodeType: GraphNodeTypeSchema,
  refId: z.string().min(1),
  label: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  edgeType: z.string().min(1),
  weight: z.number().default(1),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphClusterSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  claimCount: z.number().int().min(0),
  connectionCount: z.number().int().min(0),
  openConflictCount: z.number().int().min(0),
});
export type GraphClusterSummary = z.infer<typeof GraphClusterSummarySchema>;

export const GraphClusterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  claims: z.array(GraphRetrievalClaimSchema),
  connections: z.array(ClaimConnectionSchema),
  conflicts: z.array(ConflictGroupSchema),
});
export type GraphCluster = z.infer<typeof GraphClusterSchema>;

export const GraphRecallContextSchema = z.object({
  question: z.string().min(1),
  claims: z.array(GraphRetrievalClaimSchema),
  conflicts: z.array(ConflictGroupSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type GraphRecallContext = z.infer<typeof GraphRecallContextSchema>;

export const GroundedAnswerCitationSchema = z.object({
  evidenceSpanId: z.string().min(1),
  claimIds: z.array(z.string().min(1)).min(1),
});
export type GroundedAnswerCitation = z.infer<typeof GroundedAnswerCitationSchema>;

export const GroundedAnswerResponseSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(GroundedAnswerCitationSchema).default([]),
  usedClaimIds: z.array(z.string().min(1)).default([]),
  usedEvidenceSpanIds: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string()).default([]),
  gap: z.string().optional(),
  model: z.string().min(1),
});
export type GroundedAnswerResponse = z.infer<typeof GroundedAnswerResponseSchema>;

export const EmbeddingTargetTypeSchema = z.enum(["claim", "evidence_span", "entity", "schema_pattern"]);
export type EmbeddingTargetType = z.infer<typeof EmbeddingTargetTypeSchema>;

export const EmbeddingRequestSchema = z.object({
  input: z.array(z.string().min(1)).min(1).max(128),
  targetType: EmbeddingTargetTypeSchema,
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;

export const EmbeddingResponseSchema = z.object({
  vectors: z.array(z.array(z.number())),
  model: z.string().min(1),
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;

export const RecallCitationSchema = z.object({
  evidenceSpanId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  lineRange: z.string().min(1),
  text: z.string(),
});
export type RecallCitation = z.infer<typeof RecallCitationSchema>;

export const CitedAnswerSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
  evidenceSpanIds: z.array(z.string()).default([]),
  citations: z.array(RecallCitationSchema).default([]),
  matches: z.array(RecallMatchSchema).default([]),
  gap: z.string().optional(),
  conflicts: z.array(ConflictGroupSchema).default([]),
  warnings: z.array(z.string()).default([]),
  retrievalMetadata: z.record(z.string(), z.unknown()).default({}),
  answerMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type CitedAnswer = z.infer<typeof CitedAnswerSchema>;

export const CreateInitiativeBriefInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  problem: z.string().trim().min(1).max(4_000),
  proposal: z.string().trim().min(1).max(4_000),
  successMetric: z.string().trim().min(1).max(2_000),
  risksAndDependencies: z.string().trim().max(3_000).optional(),
  memoryItemIds: z.array(z.string().min(1)).min(1).max(50),
  createdByLabel: z.string().trim().min(1).max(160),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, memoryItemId] of value.memoryItemIds.entries()) {
    if (seen.has(memoryItemId)) {
      context.addIssue({
        code: "custom",
        path: [`memoryItemIds.${index}`],
        message: `Duplicate memory item id: ${memoryItemId}`,
      });
    }
    seen.add(memoryItemId);
  }
});
export type CreateInitiativeBriefInput = z.infer<typeof CreateInitiativeBriefInputSchema>;

export const InitiativeBriefDraftInputSchema = z.object({
  memoryItemIds: z.array(z.string().min(1)).min(1).max(8),
  intent: z.string().trim().max(1_000).optional(),
  expandRelatedMemory: z.boolean().default(false),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, memoryItemId] of value.memoryItemIds.entries()) {
    if (seen.has(memoryItemId)) {
      context.addIssue({
        code: "custom",
        path: [`memoryItemIds.${index}`],
        message: `Duplicate memory item id: ${memoryItemId}`,
      });
    }
    seen.add(memoryItemId);
  }
});
export type InitiativeBriefDraftInput = z.infer<typeof InitiativeBriefDraftInputSchema>;

export const InitiativeBriefDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  problem: z.string().trim().min(1).max(4_000),
  proposal: z.string().trim().min(1).max(4_000),
  successMetric: z.string().trim().min(1).max(2_000),
  risksAndDependencies: z.string().trim().max(3_000).optional(),
  memoryItemIds: z.array(z.string().min(1)).min(1).max(50),
  evidenceSpanIds: z.array(z.string().min(1)).min(1),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, memoryItemId] of value.memoryItemIds.entries()) {
    if (seen.has(memoryItemId)) {
      context.addIssue({
        code: "custom",
        path: [`memoryItemIds.${index}`],
        message: `Duplicate memory item id: ${memoryItemId}`,
      });
    }
    seen.add(memoryItemId);
  }
});
export type InitiativeBriefDraft = z.infer<typeof InitiativeBriefDraftSchema>;

export const InitiativeBriefDecisionInputSchema = z.object({
  decision: InitiativeBriefDecisionSchema,
  reviewerLabel: z.string().trim().min(1).max(160),
  rationale: z.string().trim().max(2_000).optional(),
});
export type InitiativeBriefDecisionInput = z.infer<typeof InitiativeBriefDecisionInputSchema>;

export const InitiativeBriefDecisionRecordSchema = z.object({
  id: z.string().min(1),
  briefId: z.string().min(1),
  decision: InitiativeBriefDecisionSchema,
  reviewerLabel: z.string().min(1),
  rationale: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type InitiativeBriefDecisionRecord = z.infer<typeof InitiativeBriefDecisionRecordSchema>;

export const InitiativeBriefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: InitiativeBriefStatusSchema,
  problem: z.string().min(1),
  proposal: z.string().min(1),
  successMetric: z.string().min(1),
  risksAndDependencies: z.string().nullable().optional(),
  memoryItemIds: z.array(z.string().min(1)).min(1),
  evidenceSpanIds: z.array(z.string().min(1)).min(1),
  memoryItems: z.array(MemoryItemSchema).min(1),
  evidenceSpans: z.array(EvidenceSpanSchema).min(1),
  createdByLabel: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  decisions: z.array(InitiativeBriefDecisionRecordSchema).default([]),
});
export type InitiativeBrief = z.infer<typeof InitiativeBriefSchema>;
