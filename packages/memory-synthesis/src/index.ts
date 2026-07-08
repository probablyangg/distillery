import type {
  EvidenceSpan,
  InitiativeBriefDraft,
  InitiativeBrief,
  MemoryItem,
  MemoryWithEvidence,
  ValidationIssue,
  ValidationResult,
} from "@distillery/contracts";

export const MEMORY_SYNTHESIS_VERSION = "memory-synthesis-v0.1";
export const SYNTHESIS_BUNDLE_VERSION = "synthesis-bundle-v0.1";

export type BriefEvidenceSet = {
  memoryItemIds: string[];
  evidenceSpanIds: string[];
  evidenceSpans: EvidenceSpan[];
};

export type SynthesisConnectionReason =
  | "shared_entity"
  | "compatible_relation"
  | "matching_schema_candidate"
  | "complementary_claim_type"
  | "shared_evidence"
  | "shared_source_context"
  | "edit_supersession_lineage"
  | "decision_reference"
  | "contradiction_warning"
  | "blocking_contradiction";

export type SynthesisConnection = {
  fromMemoryItemId: string;
  toMemoryItemId: string;
  reason: SynthesisConnectionReason;
  detail: string;
  strength: "weak" | "strong" | "blocking";
};

export type SynthesisReadiness = {
  ready: boolean;
  skipReasons: string[];
  warningReasons: string[];
};

export type SynthesisBundle = {
  version: typeof SYNTHESIS_BUNDLE_VERSION;
  seedMemoryItemIds: string[];
  selectedMemoryItemIds: string[];
  selectedEvidenceSpanIds: string[];
  connections: SynthesisConnection[];
  readiness: SynthesisReadiness;
};

export function buildSynthesisBundle(args: {
  seedMemoryItemIds: string[];
  memory: MemoryWithEvidence[];
  maxMemoryItems?: number;
}): {
  bundle: SynthesisBundle;
  selectedMemory: MemoryWithEvidence[];
  selectedEvidenceSpans: EvidenceSpan[];
} {
  const seedIds = unique(args.seedMemoryItemIds);
  const maxMemoryItems = args.maxMemoryItems ?? 8;
  const activeMemory = args.memory.filter((record) => isActiveMemory(record.memoryItem));
  const activeById = new Map(activeMemory.map((record) => [record.memoryItem.id, record]));
  const seedRecords = seedIds
    .map((id) => activeById.get(id))
    .filter((record): record is MemoryWithEvidence => Boolean(record));

  const seedSet = new Set(seedRecords.map((record) => record.memoryItem.id));
  const connectionByPair = new Map<string, SynthesisConnection[]>();

  for (let leftIndex = 0; leftIndex < activeMemory.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeMemory.length; rightIndex += 1) {
      const left = activeMemory[leftIndex]!;
      const right = activeMemory[rightIndex]!;
      const connections = deriveConnections(left.memoryItem, right.memoryItem);
      if (connections.length === 0) continue;
      connectionByPair.set(pairKey(left.memoryItem.id, right.memoryItem.id), connections);
    }
  }

  const related = activeMemory
    .filter((record) => !seedSet.has(record.memoryItem.id))
    .map((record) => ({
      record,
      score: scoreConnections(seedRecords.flatMap((seed) =>
        connectionByPair.get(pairKey(seed.memoryItem.id, record.memoryItem.id)) ?? []
      )),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.record.memoryItem.id.localeCompare(right.record.memoryItem.id))
    .map((candidate) => candidate.record);

  const selectedMemory = [...seedRecords, ...related].slice(0, maxMemoryItems);
  const selectedIds = new Set(selectedMemory.map((record) => record.memoryItem.id));
  const selectedConnections = [...connectionByPair.values()]
    .flat()
    .filter((connection) =>
      selectedIds.has(connection.fromMemoryItemId) && selectedIds.has(connection.toMemoryItemId)
    );
  const selectedEvidenceSpans = uniqueEvidenceSpans(selectedMemory.flatMap((record) => record.evidenceSpans));
  const readiness = evaluateSynthesisReadiness({
    selectedMemory,
    selectedEvidenceSpans,
    connections: selectedConnections,
    missingSeedMemoryItemIds: seedIds.filter((id) => !activeById.has(id)),
  });

  return {
    bundle: {
      version: SYNTHESIS_BUNDLE_VERSION,
      seedMemoryItemIds: seedIds,
      selectedMemoryItemIds: selectedMemory.map((record) => record.memoryItem.id),
      selectedEvidenceSpanIds: selectedEvidenceSpans.map((span) => span.id),
      connections: selectedConnections,
      readiness,
    },
    selectedMemory,
    selectedEvidenceSpans,
  };
}

export function evaluateSynthesisReadiness(args: {
  selectedMemory: MemoryWithEvidence[];
  selectedEvidenceSpans: EvidenceSpan[];
  connections: SynthesisConnection[];
  missingSeedMemoryItemIds?: string[];
}): SynthesisReadiness {
  const skipReasons: string[] = [];
  const warningReasons: string[] = [];

  if ((args.missingSeedMemoryItemIds ?? []).length > 0) {
    skipReasons.push(`Seed memory is inactive or missing: ${(args.missingSeedMemoryItemIds ?? []).join(", ")}`);
  }

  if (args.selectedMemory.length < 2) {
    skipReasons.push("At least 2 active memory items are required.");
  }

  if (args.selectedEvidenceSpans.length < 2) {
    skipReasons.push("At least 2 evidence spans are required.");
  }

  if (!args.connections.some((connection) => connection.strength === "strong")) {
    skipReasons.push("At least 1 connection stronger than same source/context is required.");
  }

  const inactiveIds = args.selectedMemory
    .filter((record) => !isActiveMemory(record.memoryItem))
    .map((record) => record.memoryItem.id);
  if (inactiveIds.length > 0) {
    skipReasons.push(`Selected memory must be active: ${inactiveIds.join(", ")}`);
  }

  const blocking = args.connections.filter((connection) => connection.strength === "blocking");
  if (blocking.length > 0) {
    skipReasons.push("Unresolved blocking contradiction exists.");
  }

  const warnings = args.connections.filter((connection) => connection.reason === "contradiction_warning");
  if (warnings.length > 0) {
    warningReasons.push("Potential contradiction should be surfaced in the draft.");
  }

  return {
    ready: skipReasons.length === 0,
    skipReasons,
    warningReasons,
  };
}

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

function deriveConnections(left: MemoryItem, right: MemoryItem): SynthesisConnection[] {
  const connections: SynthesisConnection[] = [];

  for (const entity of intersection(memoryEntityKeys(left), memoryEntityKeys(right))) {
    connections.push(connection(left, right, "shared_entity", `Shared entity: ${entity}`, "strong"));
  }

  for (const relation of intersection(memoryRelationKeys(left), memoryRelationKeys(right))) {
    connections.push(connection(left, right, "compatible_relation", `Compatible relation: ${relation}`, "strong"));
  }

  for (const schema of intersection(memorySchemaKeys(left), memorySchemaKeys(right))) {
    connections.push(connection(left, right, "matching_schema_candidate", `Matching schema candidate: ${schema}`, "strong"));
  }

  if (isComplementaryClaimType(left.claimType, right.claimType)) {
    connections.push(connection(left, right, "complementary_claim_type", `${left.claimType} complements ${right.claimType}`, "strong"));
  }

  for (const evidenceSpanId of intersection(left.evidenceSpanIds, right.evidenceSpanIds)) {
    connections.push(connection(left, right, "shared_evidence", `Shared evidence span: ${evidenceSpanId}`, "weak"));
  }

  if (left.sourceVersionId === right.sourceVersionId) {
    connections.push(connection(left, right, "shared_source_context", `Shared source version: ${left.sourceVersionId}`, "weak"));
  }

  if (
    left.supersedesMemoryItemId === right.id ||
    right.supersedesMemoryItemId === left.id
  ) {
    connections.push(connection(left, right, "edit_supersession_lineage", "Edit/supersession lineage", "strong"));
  }

  const decisionIds = intersection(decisionReferenceIds(left), decisionReferenceIds(right));
  for (const decisionId of decisionIds) {
    connections.push(connection(left, right, "decision_reference", `Shared decision reference: ${decisionId}`, "strong"));
  }

  const contradiction = contradictionSeverity(left, right);
  if (contradiction === "blocking") {
    connections.push(connection(left, right, "blocking_contradiction", "Blocking contradiction between selected memory", "blocking"));
  } else if (contradiction === "warning") {
    connections.push(connection(left, right, "contradiction_warning", "Potential contradiction between selected memory", "strong"));
  }

  return dedupeConnections(connections);
}

function connection(
  left: MemoryItem,
  right: MemoryItem,
  reason: SynthesisConnectionReason,
  detail: string,
  strength: SynthesisConnection["strength"],
): SynthesisConnection {
  return {
    fromMemoryItemId: left.id,
    toMemoryItemId: right.id,
    reason,
    detail,
    strength,
  };
}

function isActiveMemory(item: MemoryItem): boolean {
  return item.reviewState !== "removed" && item.reviewState !== "superseded";
}

function memoryEntityKeys(item: MemoryItem): string[] {
  return item.entities.map((entity) =>
    normalizeKey(`${entity.entityType}:${entity.canonicalName ?? entity.name}`)
  );
}

function memoryRelationKeys(item: MemoryItem): string[] {
  return item.relations.map((relation) =>
    normalizeKey(`${relation.subject}:${relation.predicate}:${relation.object}`)
  );
}

function memorySchemaKeys(item: MemoryItem): string[] {
  return item.schemas.map((schema) =>
    normalizeKey(`${schema.subjectType}:${schema.predicate}:${schema.objectType}:${schema.status}`)
  );
}

function decisionReferenceIds(item: MemoryItem): string[] {
  const value = item.qualifiers.decisionIds ?? item.qualifiers.decisionId;
  if (Array.isArray(value)) return value.filter((candidate): candidate is string => typeof candidate === "string");
  return typeof value === "string" ? [value] : [];
}

function contradictionSeverity(left: MemoryItem, right: MemoryItem): "none" | "warning" | "blocking" {
  const leftSeverity = severityFromQualifiers(left);
  const rightSeverity = severityFromQualifiers(right);
  if (leftSeverity === "blocking" || rightSeverity === "blocking") return "blocking";
  if (leftSeverity === "warning" || rightSeverity === "warning") return "warning";
  return "none";
}

function severityFromQualifiers(item: MemoryItem): "none" | "warning" | "blocking" {
  if (item.qualifiers.blockingContradiction === true || item.qualifiers.contradictionSeverity === "blocking") {
    return "blocking";
  }
  if (item.qualifiers.contradictionSeverity === "warning") return "warning";
  return "none";
}

function isComplementaryClaimType(left: string, right: string): boolean {
  const pair = new Set([left, right]);
  return (
    pair.has("risk") && pair.has("dependency") ||
    pair.has("metric") && pair.has("strategic_statement") ||
    pair.has("constraint") && pair.has("scope_statement") ||
    pair.has("reported_decision") && pair.has("ownership_statement") ||
    pair.has("fact") && pair.has("user_signal")
  );
}

function scoreConnections(connections: SynthesisConnection[]): number {
  return connections.reduce((score, connection) => {
    if (connection.strength === "blocking") return score + 4;
    if (connection.strength === "strong") return score + 3;
    return score + 1;
  }, 0);
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map(normalizeKey));
  return unique(left.map(normalizeKey).filter((value) => rightSet.has(value)));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeConnections(connections: SynthesisConnection[]): SynthesisConnection[] {
  const seen = new Set<string>();
  return connections.filter((candidate) => {
    const key = [
      candidate.fromMemoryItemId,
      candidate.toMemoryItemId,
      candidate.reason,
      candidate.detail,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueEvidenceSpans(spans: EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    if (seen.has(span.id)) return false;
    seen.add(span.id);
    return true;
  });
}
