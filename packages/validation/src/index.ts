import {
  GeneratedMemoryBatchSchema,
  type EvidenceSpan,
  type GeneratedMemoryBatch,
  type GeneratedMemoryItem,
  type ValidationIssue,
  type ValidationResult,
} from "@distillery/contracts";

export type ValidatedMemoryBatch = {
  result: ValidationResult;
  items: GeneratedMemoryItem[];
};

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

    for (const evidenceSpanId of item.evidenceSpanIds) {
      if (!allowedIds.has(evidenceSpanId)) {
        issues.push({
          code: "unknown_evidence_span",
          message: `Memory item references unknown evidence span: ${evidenceSpanId}`,
          path: [`items.${index}.evidenceSpanIds`],
        });
      }
    }

    if (item.epistemicStatus === "observed" && item.type === "reported_decision") {
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
