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

export const CaptureModeSchema = z.enum(["remember", "ask"]);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

export const ClaimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const MemoryEntitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  entityType: z.string().trim().min(1).max(80),
  canonicalName: z.string().trim().min(1).max(200).optional(),
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
