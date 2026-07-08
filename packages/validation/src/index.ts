import {
  LedgerEventSchema,
  PendingWorkItemSchema,
  PolicyRunSchema,
  ProposedEventSchema,
  GeneratedMemoryBatchSchema,
  type EvidenceSpan,
  type GeneratedMemoryBatch,
  type GeneratedMemoryItem,
  type LedgerEvent,
  type MemoryItem,
  type PendingWorkItem,
  type PolicyRun,
  type ProposedEvent,
  type ValidationIssue,
  type ValidationResult,
} from "@distillery/contracts";

export type ValidatedMemoryBatch = {
  result: ValidationResult;
  items: GeneratedMemoryItem[];
};

export function validateLedgerEventShape(event: unknown): ValidationResult {
  return zodValidationResult(LedgerEventSchema.safeParse(event));
}

export function validateProposedEventShape(event: unknown): ValidationResult {
  return zodValidationResult(ProposedEventSchema.safeParse(event));
}

export function validateWorkItemShape(workItem: unknown): ValidationResult {
  return zodValidationResult(PendingWorkItemSchema.safeParse(workItem));
}

export function validatePolicyRunMetadataShape(policyRun: unknown): ValidationResult {
  return zodValidationResult(PolicyRunSchema.safeParse(policyRun));
}

export function validateHumanApprovalRequirement(proposal: ProposedEvent): ValidationResult {
  const humanRequiredTargets = new Set([
    "memory_confirmed",
    "memory_edited",
    "memory_removed",
    "candidate_approved",
    "candidate_rejected",
    "artifact_approved",
    "artifact_rejected",
    "artifact_delivered",
    "decision_committed",
  ]);

  if (humanRequiredTargets.has(proposal.targetEventType) && !proposal.requiresHumanApproval) {
    return {
      ok: false,
      issues: [{
        code: "human_approval_required",
        message: `${proposal.targetEventType} requires human approval.`,
        path: ["requiresHumanApproval"],
      }],
    };
  }

  return ok();
}

export function validateEvidenceSpanExistence(args: {
  referencedEvidenceSpanIds: string[];
  availableEvidenceSpans: EvidenceSpan[];
}): ValidationResult {
  const available = new Set(args.availableEvidenceSpans.map((span) => span.id));
  const issues = unique(args.referencedEvidenceSpanIds)
    .filter((id) => !available.has(id))
    .map((id): ValidationIssue => ({
      code: "unknown_evidence_span",
      message: `Referenced evidence span does not exist: ${id}`,
      path: ["evidenceSpanIds"],
    }));

  return { ok: issues.length === 0, issues };
}

export function validateMemoryToEvidenceBindings(args: {
  memoryItems: MemoryItem[];
  availableEvidenceSpans: EvidenceSpan[];
}): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const [index, memoryItem] of args.memoryItems.entries()) {
    if (memoryItem.evidenceSpanIds.length === 0) {
      issues.push({
        code: "memory_missing_evidence",
        message: `Memory item ${memoryItem.id} must cite at least one evidence span.`,
        path: [`memoryItems.${index}.evidenceSpanIds`],
      });
    }

    issues.push(
      ...validateEvidenceSpanExistence({
        referencedEvidenceSpanIds: memoryItem.evidenceSpanIds,
        availableEvidenceSpans: args.availableEvidenceSpans,
      }).issues.map((issue) => ({
        ...issue,
        path: [`memoryItems.${index}`, ...issue.path],
      })),
    );
  }

  return { ok: issues.length === 0, issues };
}

export function validateArtifactToEvidenceBindings(args: {
  artifact: { evidenceSpanIds?: string[] };
  availableEvidenceSpans: EvidenceSpan[];
}): ValidationResult {
  return validateEvidenceSpanExistence({
    referencedEvidenceSpanIds: args.artifact.evidenceSpanIds ?? [],
    availableEvidenceSpans: args.availableEvidenceSpans,
  });
}

export function validateArtifactToMemoryBindings(args: {
  artifact: { memoryItemIds?: string[] };
  availableMemoryItems: Array<{ id: string }>;
}): ValidationResult {
  const available = new Set(args.availableMemoryItems.map((item) => item.id));
  const issues = unique(args.artifact.memoryItemIds ?? [])
    .filter((id) => !available.has(id))
    .map((id): ValidationIssue => ({
      code: "unknown_memory_item",
      message: `Referenced memory item does not exist: ${id}`,
      path: ["memoryItemIds"],
    }));

  return { ok: issues.length === 0, issues };
}

export function validateDecisionReferences(args: {
  referencedDecisionIds: string[];
  availableDecisionIds: string[];
}): ValidationResult {
  const available = new Set(args.availableDecisionIds);
  const issues = unique(args.referencedDecisionIds)
    .filter((id) => !available.has(id))
    .map((id): ValidationIssue => ({
      code: "unknown_decision",
      message: `Referenced decision does not exist: ${id}`,
      path: ["decisionIds"],
    }));

  return { ok: issues.length === 0, issues };
}

export function validateSourceVersionCurrentness(args: {
  expectedSourceVersionId: string;
  actualSourceVersionId: string;
}): ValidationResult {
  if (args.expectedSourceVersionId !== args.actualSourceVersionId) {
    return {
      ok: false,
      issues: [{
        code: "source_version_not_current",
        message: "The proposal was built from a stale source version.",
        path: ["sourceVersionId"],
      }],
    };
  }

  return ok();
}

export function validateKnownContradictionSurfacing(args: {
  blockingContradictionIds: string[];
  surfacedContradictionIds: string[];
}): ValidationResult {
  const surfaced = new Set(args.surfacedContradictionIds);
  const issues = args.blockingContradictionIds
    .filter((id) => !surfaced.has(id))
    .map((id): ValidationIssue => ({
      code: "blocking_contradiction_not_surfaced",
      message: `Blocking contradiction must be surfaced before commit: ${id}`,
      path: ["contradictionIds"],
    }));

  return { ok: issues.length === 0, issues };
}

export function validateGeneratedMemory(args: {
  generated: unknown;
  allowedEvidenceSpans: EvidenceSpan[];
}): ValidatedMemoryBatch {
  const issues: ValidationIssue[] = [];
  const parsed = GeneratedMemoryBatchSchema.safeParse(args.generated);

  if (!parsed.success) {
    return {
      result: {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          code: "schema_invalid",
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
      items: [],
    };
  }

  const allowedIds = new Set(args.allowedEvidenceSpans.map((span) => span.id));
  const normalizedStatements = new Set<string>();

  for (const [index, item] of parsed.data.items.entries()) {
    const normalizedStatement = item.statement.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalizedStatements.has(normalizedStatement)) {
      issues.push({
        code: "duplicate_statement",
        message: "Duplicate generated memory statement.",
        path: [`items.${index}.statement`],
      });
    }
    normalizedStatements.add(normalizedStatement);

    const itemEvidenceIds = new Set(item.evidenceSpanIds);

    for (const evidenceSpanId of item.evidenceSpanIds) {
      if (!allowedIds.has(evidenceSpanId)) {
        issues.push({
          code: "unknown_evidence_span",
          message: `Memory item references unknown evidence span: ${evidenceSpanId}`,
          path: [`items.${index}.evidenceSpanIds`],
        });
      }
    }

    for (const [relationIndex, relation] of item.relations.entries()) {
      for (const evidenceSpanId of relation.evidenceSpanIds) {
        if (!allowedIds.has(evidenceSpanId)) {
          issues.push({
            code: "unknown_relation_evidence_span",
            message: `Memory relation references unknown evidence span: ${evidenceSpanId}`,
            path: [`items.${index}.relations.${relationIndex}.evidenceSpanIds`],
          });
        }

        if (!itemEvidenceIds.has(evidenceSpanId)) {
          issues.push({
            code: "relation_evidence_outside_claim",
            message: `Memory relation evidence must be included in the parent memory item's evidenceSpanIds: ${evidenceSpanId}`,
            path: [`items.${index}.relations.${relationIndex}.evidenceSpanIds`],
          });
        }
      }
    }

    if (item.epistemicStatus === "observed" && item.claimType === "reported_decision") {
      issues.push({
        code: "decision_status_invalid",
        message: "Reported decisions must use decision_reported or reported epistemic status.",
        path: [`items.${index}.epistemicStatus`],
      });
    }
  }

  return {
    result: {
      ok: issues.length === 0,
      issues,
    },
    items: parsed.data.items,
  };
}

export function mergeValidationResults(results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((result) => result.issues);
  return {
    ok: results.every((result) => result.ok) && issues.length === 0,
    issues,
  };
}

function ok(): ValidationResult {
  return { ok: true, issues: [] };
}

function zodValidationResult(result: { success: true } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } }): ValidationResult {
  if (result.success) return ok();

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      code: "schema_invalid",
      message: issue.message,
      path: issue.path.map(String),
    })),
  };
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}
