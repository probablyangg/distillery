import type {
  EvidenceSpan,
  InitiativeBriefDraft,
  InitiativeBrief,
  MemoryItem,
  ValidationIssue,
  ValidationResult,
} from "@distillery/contracts";

export const MEMORY_SYNTHESIS_VERSION = "memory-synthesis-v0.1";

export type BriefEvidenceSet = {
  memoryItemIds: string[];
  evidenceSpanIds: string[];
  evidenceSpans: EvidenceSpan[];
};

export function buildBriefEvidenceSet(args: {
  memoryItems: MemoryItem[];
  evidenceSpans: EvidenceSpan[];
}): BriefEvidenceSet {
  const memoryItemIds = unique(args.memoryItems.map((item) => item.id));
  const evidenceSpanIds = unique(args.memoryItems.flatMap((item) => item.evidenceSpanIds));
  const availableSpansById = new Map(args.evidenceSpans.map((span) => [span.id, span]));
  const evidenceSpans = evidenceSpanIds
    .map((id) => availableSpansById.get(id))
    .filter((span): span is EvidenceSpan => Boolean(span));

  return {
    memoryItemIds,
    evidenceSpanIds,
    evidenceSpans,
  };
}

export function validateInitiativeBriefTraceability(
  brief: InitiativeBrief,
  options: { requireActiveMemory?: boolean } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (brief.memoryItemIds.length === 0) {
    issues.push({
      code: "brief_missing_memory",
      message: "Initiative brief must be backed by at least one memory item.",
      path: ["memoryItemIds"],
    });
  }

  if (brief.evidenceSpanIds.length === 0) {
    issues.push({
      code: "brief_missing_evidence",
      message: "Initiative brief must be backed by at least one evidence span.",
      path: ["evidenceSpanIds"],
    });
  }

  const selectedMemoryIds = new Set(brief.memoryItemIds);
  for (const memoryItem of brief.memoryItems) {
    if (!selectedMemoryIds.has(memoryItem.id)) {
      issues.push({
        code: "brief_memory_mismatch",
        message: `Returned memory item is not part of the brief: ${memoryItem.id}`,
        path: ["memoryItems"],
      });
    }

    if (
      options.requireActiveMemory
      && (memoryItem.reviewState === "removed" || memoryItem.reviewState === "superseded")
    ) {
      issues.push({
        code: "brief_inactive_memory",
        message: `Inactive memory item cannot support a new brief: ${memoryItem.id}`,
        path: ["memoryItems"],
      });
    }
  }

  const selectedEvidenceIds = new Set(brief.evidenceSpanIds);
  for (const memoryItem of brief.memoryItems) {
    for (const evidenceSpanId of memoryItem.evidenceSpanIds) {
      if (!selectedEvidenceIds.has(evidenceSpanId)) {
        issues.push({
          code: "brief_evidence_mismatch",
          message: `Selected memory evidence is missing from the brief evidence set: ${evidenceSpanId}`,
          path: ["evidenceSpanIds"],
        });
      }
    }
  }

  for (const decision of brief.decisions) {
    if (decision.reviewerLabel.trim().length === 0) {
      issues.push({
        code: "brief_decision_missing_reviewer",
        message: "Decision records must include a reviewer label.",
        path: ["decisions"],
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function validateInitiativeBriefDraftTraceability(args: {
  draft: InitiativeBriefDraft;
  selectedMemoryItems: MemoryItem[];
  selectedEvidenceSpans: EvidenceSpan[];
}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const selectedMemoryIds = new Set(args.selectedMemoryItems.map((item) => item.id));
  const selectedEvidenceIds = new Set(args.selectedEvidenceSpans.map((span) => span.id));
  const requiredMemoryIds = new Set(args.selectedMemoryItems.map((item) => item.id));
  const requiredEvidenceIds = new Set(args.selectedMemoryItems.flatMap((item) => item.evidenceSpanIds));

  if (args.draft.memoryItemIds.length === 0) {
    issues.push({
      code: "draft_missing_memory",
      message: "Draft must be backed by at least one selected memory item.",
      path: ["memoryItemIds"],
    });
  }

  if (args.draft.evidenceSpanIds.length === 0) {
    issues.push({
      code: "draft_missing_evidence",
      message: "Draft must cite at least one evidence span.",
      path: ["evidenceSpanIds"],
    });
  }

  for (const memoryItemId of args.draft.memoryItemIds) {
    if (!selectedMemoryIds.has(memoryItemId)) {
      issues.push({
        code: "draft_unsupported_memory",
        message: `Draft referenced memory that was not selected: ${memoryItemId}`,
        path: ["memoryItemIds"],
      });
    }
  }

  for (const memoryItemId of requiredMemoryIds) {
    if (!args.draft.memoryItemIds.includes(memoryItemId)) {
      issues.push({
        code: "draft_missing_selected_memory",
        message: `Draft omitted selected memory: ${memoryItemId}`,
        path: ["memoryItemIds"],
      });
    }
  }

  for (const evidenceSpanId of args.draft.evidenceSpanIds) {
    if (!selectedEvidenceIds.has(evidenceSpanId)) {
      issues.push({
        code: "draft_unsupported_evidence",
        message: `Draft referenced evidence that was not selected: ${evidenceSpanId}`,
        path: ["evidenceSpanIds"],
      });
    }
  }

  for (const evidenceSpanId of requiredEvidenceIds) {
    if (!args.draft.evidenceSpanIds.includes(evidenceSpanId)) {
      issues.push({
        code: "draft_missing_selected_memory_evidence",
        message: `Draft omitted evidence from selected memory: ${evidenceSpanId}`,
        path: ["evidenceSpanIds"],
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
