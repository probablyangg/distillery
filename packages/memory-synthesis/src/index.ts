import type {
  ClaimConnection,
  ConflictGroup,
  EvidenceSpan,
  InitiativeBriefDraft,
  InitiativeBrief,
  MemoryItem,
  MemoryWithEvidence,
  SynthesisCluster,
  SynthesisClusterDossier,
  SynthesisClusterMembership,
  SynthesisEnrichmentState,
  SynthesisOpportunityBreakdown,
  SynthesisReadinessEvaluation,
  SynthesisSimilaritySignal,
  ValidationIssue,
  ValidationResult,
} from "@distillery/contracts";

export const MEMORY_SYNTHESIS_VERSION = "memory-synthesis-v0.1";
export const SYNTHESIS_BUNDLE_VERSION = "synthesis-bundle-v0.1";
export const CORPUS_SYNTHESIS_VERSION = "corpus-synthesis-v1";

export const SYNTHESIS_DOSSIER_LIMITS = Object.freeze({
  maxMemoryItems: 16,
  maxEvidenceSpans: 24,
  maxConnections: 32,
  maxContradictions: 12,
  maxEntities: 16,
  maxTopics: 16,
  maxCharacters: 30_000,
});
export type SynthesisDossierLimits = {
  [Key in keyof typeof SYNTHESIS_DOSSIER_LIMITS]: number;
};

export const SYNTHESIS_OPPORTUNITY_WEIGHTS = Object.freeze({
  cohesion: 0.2,
  evidenceBreadth: 0.14,
  evidenceQuality: 0.1,
  sourceDiversity: 0.1,
  actionability: 0.14,
  strategicImportance: 0.08,
  recentMomentum: 0.1,
  urgency: 0.06,
  novelty: 0.05,
  completeness: 0.08,
  contradictionPenalty: 0.08,
  duplicationPenalty: 0.05,
  stalenessPenalty: 0.05,
  existingBriefPenalty: 0.12,
});

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

export function discoverCorpusSynthesisClusters(args: {
  tenantId: string;
  memory: MemoryWithEvidence[];
  connections?: ClaimConnection[];
  similarities?: SynthesisSimilaritySignal[];
  conflicts?: ConflictGroup[];
  existingClusters?: SynthesisCluster[];
  now?: string;
}): SynthesisCluster[] {
  const changedAt = args.now ?? new Date().toISOString();
  const active = args.memory.filter((record) => isActiveMemory(record.memoryItem));
  const byId = new Map(active.map((record) => [record.memoryItem.id, record]));
  const groups = new Map<string, {
    resolution: SynthesisCluster["resolution"];
    label: string;
    members: Map<string, SynthesisClusterMembership>;
    entities: Set<string>;
    topics: Set<string>;
  }>();

  const add = (
    meaningKey: string,
    resolution: SynthesisCluster["resolution"],
    label: string,
    record: MemoryWithEvidence,
    score: number,
    reason: string,
  ) => {
    const group = groups.get(meaningKey) ?? {
      resolution,
      label,
      members: new Map<string, SynthesisClusterMembership>(),
      entities: new Set<string>(),
      topics: new Set<string>(),
    };
    const current = group.members.get(record.memoryItem.id);
    group.members.set(record.memoryItem.id, {
      memoryItemId: record.memoryItem.id,
      score: Math.max(current?.score ?? 0, score),
      reasons: unique([...(current?.reasons ?? []), reason]),
      role: score >= 0.82 ? "core" : score >= 0.62 ? "supporting" : "context",
    });
    for (const entity of record.memoryItem.entities) {
      group.entities.add(entity.canonicalName ?? entity.name);
    }
    for (const tag of record.memoryItem.stableDomainTags) group.topics.add(tag);
    groups.set(meaningKey, group);
  };

  for (const record of active) {
    const item = record.memoryItem;
    for (const entity of item.entities) {
      const name = entity.canonicalName ?? entity.name;
      const key = normalizeKey(name);
      add(`entity:${key}`, "initiative", name, record, 0.9, `Shares the entity “${name}”.`);
    }
    for (const relation of item.relations) {
      const key = normalizeKey(`${relation.subject}|${relation.predicate}|${relation.object}`);
      add(`relation:${key}`, "narrow_decision", `${relation.subject}: ${relation.predicate}`, record, 0.92, `Participates in the typed relationship “${relation.predicate}”.`);
    }
    for (const tag of item.stableDomainTags) {
      add(`tag:${normalizeKey(tag)}`, "initiative", tag, record, 0.82, `Shares the project or domain tag “${tag}”.`);
    }
    for (const schema of item.schemas) {
      const topic = `${schema.subjectType} ${schema.predicate} ${schema.objectType}`;
      add(`schema:${normalizeKey(topic)}`, "strategic_theme", topic, record, 0.7, `Matches the semantic pattern “${topic}”.`);
    }
    for (const token of significantTopicTokens(item.statement).slice(0, 6)) {
      add(`topic:${token}`, "strategic_theme", titleCase(token), record, 0.58, `Shares the lexical topic “${token}”.`);
    }
  }

  for (const connection of args.connections ?? []) {
    if (connection.status === "rejected" || connection.confidence < 0.55) continue;
    const left = byId.get(connection.fromClaimId);
    const right = byId.get(connection.toClaimId);
    if (!left || !right) continue;
    const pair = [left.memoryItem.id, right.memoryItem.id].sort().join("|");
    const meaningKey = connection.connectionType === "depends_on" || connection.connectionType === "blocks"
      ? `dependency:${pair}`
      : `connection:${connection.connectionType}:${pair}`;
    const label = connection.rationale?.trim() || `${connection.connectionType.replaceAll("_", " ")} opportunity`;
    const score = Math.min(0.98, 0.55 + connection.confidence * 0.4);
    add(meaningKey, "narrow_decision", label, left, score, `Durable ${connection.connectionType.replaceAll("_", " ")} connection (${connection.confidence.toFixed(2)}).`);
    add(meaningKey, "narrow_decision", label, right, score, `Durable ${connection.connectionType.replaceAll("_", " ")} connection (${connection.confidence.toFixed(2)}).`);
  }

  for (const similarity of args.similarities ?? []) {
    const left = byId.get(similarity.fromMemoryItemId);
    const right = byId.get(similarity.toMemoryItemId);
    const similarityScore = Math.max(similarity.vectorScore, similarity.sparseScore);
    if (!left || !right || similarityScore < 0.55) continue;
    const pair = [left.memoryItem.id, right.memoryItem.id].sort().join("|");
    const meaningKey = `similarity:${pair}`;
    const label = sharedClusterLabel(left.memoryItem, right.memoryItem);
    const membershipScore = Math.min(0.9, 0.5 + similarityScore * 0.4);
    const reason = `${similarity.reasons.join(" ")} Combined similarity ${similarityScore.toFixed(2)}.`;
    add(meaningKey, "narrow_decision", label, left, membershipScore, reason);
    add(meaningKey, "narrow_decision", label, right, membershipScore, reason);
  }

  const existingById = new Map((args.existingClusters ?? []).map((cluster) => [cluster.id, cluster]));
  return [...groups.entries()]
    .filter(([, group]) => group.members.size >= 2)
    .map(([meaningKey, group]) => {
      const memberships = [...group.members.values()]
        .sort((left, right) => right.score - left.score || left.memoryItemId.localeCompare(right.memoryItemId));
      const id = `scluster_${stableHash(`${args.tenantId}|${group.resolution}|${meaningKey}`)}`;
      const membershipHash = stableHash(memberships.map((member) => `${member.memoryItemId}:${member.score.toFixed(3)}:${member.reasons.slice().sort().join("|")}`).join(";"));
      const existing = existingById.get(id);
      const selected = memberships.map((membership) => byId.get(membership.memoryItemId)!).filter(Boolean);
      const selectedIds = new Set(memberships.map((membership) => membership.memoryItemId));
      const relevantConflicts = (args.conflicts ?? [])
        .filter((conflict) => conflict.members.some((member) => selectedIds.has(member.claimId)))
        .sort((left, right) => left.id.localeCompare(right.id));
      const contradictionIds = relevantConflicts.map((conflict) => conflict.id);
      const meaningStateHash = stableHash([
        meaningKey,
        [...group.entities].sort().join("|"),
        [...group.topics].sort().join("|"),
        relevantConflicts.map((conflict) => `${conflict.id}:${conflict.status}:${conflict.severity}`).join("|"),
      ].join(";"));
      const version = `scv_${stableHash(`${meaningKey}|${membershipHash}|${meaningStateHash}`)}`;
      return {
        id,
        tenantId: args.tenantId,
        resolution: group.resolution,
        meaningKey,
        label: group.label,
        version,
        membershipHash,
        memberships,
        coreEntities: [...group.entities].sort(),
        coreTopics: [...group.topics].sort(),
        evidenceSpanIds: unique(selected.flatMap((record) => record.evidenceSpans.map((span) => span.id))),
        sourceVersionIds: unique(selected.map((record) => record.memoryItem.sourceVersionId)),
        contradictionIds: unique(contradictionIds),
        lastMeaningfulChangeAt: existing?.version === version
          ? existing.lastMeaningfulChangeAt
          : changedAt,
        ...(existing?.version === version && existing.readiness ? { readiness: existing.readiness } : {}),
      } satisfies SynthesisCluster;
    })
    .sort((left, right) => resolutionRank(left.resolution) - resolutionRank(right.resolution) || left.id.localeCompare(right.id));
}

export function evaluateClusterReadiness(args: {
  cluster: SynthesisCluster;
  memory: MemoryWithEvidence[];
  enrichment: SynthesisEnrichmentState[];
  connections?: ClaimConnection[];
  conflicts?: ConflictGroup[];
  equivalentBriefExists?: boolean;
  now?: string;
  readyThreshold?: number;
}): SynthesisReadinessEvaluation {
  const evaluatedAt = args.now ?? new Date().toISOString();
  const activeById = new Map(args.memory.filter((record) => isActiveMemory(record.memoryItem)).map((record) => [record.memoryItem.id, record]));
  const selected = args.cluster.memberships.map((membership) => activeById.get(membership.memoryItemId)).filter((record): record is MemoryWithEvidence => Boolean(record));
  const enrichmentById = new Map(args.enrichment.map((state) => [state.memoryItemId, state]));
  const requiredFacets = ["connections", "contradictions", "embeddings", "graph"] as const;
  const missingFacets = args.cluster.memberships.flatMap((membership) => {
    const state = enrichmentById.get(membership.memoryItemId);
    return requiredFacets
      .filter((facet) => !state?.completedFacets.includes(facet))
      .map((facet) => `${membership.memoryItemId}:${facet}`);
  });
  const memberIds = new Set(selected.map((record) => record.memoryItem.id));
  const relevantConnections = (args.connections ?? []).filter((connection) =>
    memberIds.has(connection.fromClaimId) && memberIds.has(connection.toClaimId) && connection.status !== "rejected"
  );
  const relevantConflicts = (args.conflicts ?? []).filter((conflict) =>
    conflict.members.some((member) => memberIds.has(member.claimId)) && conflict.status === "open"
  );
  const breakdown = buildOpportunityBreakdown({
    cluster: args.cluster,
    selected,
    connections: relevantConnections,
    conflicts: relevantConflicts,
    equivalentBriefExists: args.equivalentBriefExists ?? false,
    now: evaluatedAt,
  });
  const score = scoreSynthesisOpportunity(breakdown);
  const reasons = [
    `${selected.length} active memories contribute to this ${args.cluster.resolution.replaceAll("_", " ")} cluster.`,
    `${unique(selected.map((record) => record.memoryItem.sourceVersionId)).length} source versions and ${unique(selected.flatMap((record) => record.evidenceSpans.map((span) => span.id))).length} evidence spans are represented.`,
    `Deterministic opportunity score: ${score.toFixed(1)}/100.`,
  ];
  const warnings: string[] = [];
  const missingInformation: string[] = [];
  if (relevantConflicts.length > 0) warnings.push(`${relevantConflicts.length} unresolved contradiction${relevantConflicts.length === 1 ? "" : "s"} must be disclosed.`);
  if (args.equivalentBriefExists) warnings.push("An equivalent brief already exists; novelty is reduced.");
  if (selected.length < 3) missingInformation.push("A complete opportunity normally needs at least three active memories.");
  if (args.cluster.sourceVersionIds.length < 2) missingInformation.push("Evidence currently comes from only one source version.");
  if (!selected.some((record) => ["risk", "dependency", "constraint"].includes(record.memoryItem.claimType))) {
    missingInformation.push("No explicit risk, dependency, or constraint is present.");
  }

  let state: SynthesisReadinessEvaluation["state"];
  if (missingFacets.length > 0) {
    state = "pending_enrichment";
    reasons.unshift(`Waiting for ${missingFacets.length} enrichment result${missingFacets.length === 1 ? "" : "s"}.`);
  } else if (selected.length < 2 || score < (args.readyThreshold ?? 62) || relevantConflicts.some((conflict) => conflict.severity === "blocking")) {
    state = "not_ready";
    if (relevantConflicts.some((conflict) => conflict.severity === "blocking")) reasons.unshift("A blocking contradiction prevents generation.");
  } else {
    state = "ready";
  }

  return {
    id: `sready_${stableHash(`${args.cluster.id}|${args.cluster.version}|initiative_brief`)}`,
    clusterId: args.cluster.id,
    clusterVersion: args.cluster.version,
    generationIntent: "initiative_brief",
    state,
    score,
    breakdown,
    reasons,
    warnings,
    missingInformation,
    evaluatedAt,
  };
}

export function scoreSynthesisOpportunity(breakdown: SynthesisOpportunityBreakdown): number {
  const positive =
    breakdown.cohesion * SYNTHESIS_OPPORTUNITY_WEIGHTS.cohesion +
    breakdown.evidenceBreadth * SYNTHESIS_OPPORTUNITY_WEIGHTS.evidenceBreadth +
    breakdown.evidenceQuality * SYNTHESIS_OPPORTUNITY_WEIGHTS.evidenceQuality +
    breakdown.sourceDiversity * SYNTHESIS_OPPORTUNITY_WEIGHTS.sourceDiversity +
    breakdown.actionability * SYNTHESIS_OPPORTUNITY_WEIGHTS.actionability +
    breakdown.strategicImportance * SYNTHESIS_OPPORTUNITY_WEIGHTS.strategicImportance +
    breakdown.recentMomentum * SYNTHESIS_OPPORTUNITY_WEIGHTS.recentMomentum +
    breakdown.urgency * SYNTHESIS_OPPORTUNITY_WEIGHTS.urgency +
    breakdown.novelty * SYNTHESIS_OPPORTUNITY_WEIGHTS.novelty +
    breakdown.completeness * SYNTHESIS_OPPORTUNITY_WEIGHTS.completeness;
  const penalty =
    breakdown.contradictionPenalty * SYNTHESIS_OPPORTUNITY_WEIGHTS.contradictionPenalty +
    breakdown.duplicationPenalty * SYNTHESIS_OPPORTUNITY_WEIGHTS.duplicationPenalty +
    breakdown.stalenessPenalty * SYNTHESIS_OPPORTUNITY_WEIGHTS.stalenessPenalty +
    breakdown.existingBriefPenalty * SYNTHESIS_OPPORTUNITY_WEIGHTS.existingBriefPenalty;
  const positiveWeight = Object.entries(SYNTHESIS_OPPORTUNITY_WEIGHTS)
    .filter(([key]) => !key.endsWith("Penalty"))
    .reduce((sum, [, weight]) => sum + weight, 0);
  return Math.max(0, Math.min(100, ((positive / positiveWeight) - penalty) * 100));
}

export function buildClusterDossier(args: {
  cluster: SynthesisCluster;
  memory: MemoryWithEvidence[];
  connections?: ClaimConnection[];
  conflicts?: ConflictGroup[];
  retrievalMetadata?: Record<string, unknown>;
  limits?: Partial<SynthesisDossierLimits>;
}): SynthesisClusterDossier {
  const limits = { ...SYNTHESIS_DOSSIER_LIMITS, ...(args.limits ?? {}) };
  const allById = new Map(args.memory.map((record) => [record.memoryItem.id, record]));
  const excludedMemoryItemIds = args.cluster.memberships
    .map((membership) => allById.get(membership.memoryItemId))
    .filter((record): record is MemoryWithEvidence => Boolean(record))
    .filter((record) => !isActiveMemory(record.memoryItem))
    .map((record) => record.memoryItem.id);
  let characterCount = 0;
  const selectedMemory = args.cluster.memberships
    .map((membership) => allById.get(membership.memoryItemId))
    .filter((record): record is MemoryWithEvidence => record !== undefined && isActiveMemory(record.memoryItem))
    .filter((record) => {
      const cost = record.memoryItem.statement.length + record.evidenceSpans.reduce((sum, span) => sum + span.text.length, 0);
      if (characterCount + cost > limits.maxCharacters) return false;
      characterCount += cost;
      return true;
    })
    .slice(0, limits.maxMemoryItems);
  const selectedIds = new Set(selectedMemory.map((record) => record.memoryItem.id));
  const selectedEvidenceSpans = uniqueEvidenceSpans(selectedMemory.flatMap((record) => record.evidenceSpans)).slice(0, limits.maxEvidenceSpans);
  const relationships = (args.connections ?? []).filter((connection) =>
    selectedIds.has(connection.fromClaimId) && selectedIds.has(connection.toClaimId) && connection.status !== "rejected"
  ).slice(0, limits.maxConnections);
  const contradictions = (args.conflicts ?? []).filter((conflict) =>
    conflict.members.some((member) => selectedIds.has(member.claimId))
  ).slice(0, limits.maxContradictions);
  const dependencies = selectedMemory
    .filter((record) => record.memoryItem.claimType === "dependency" || record.memoryItem.claimType === "constraint")
    .map((record) => record.memoryItem.statement);
  const risks = selectedMemory.filter((record) => record.memoryItem.claimType === "risk").map((record) => record.memoryItem.statement);
  const temporalSignals = selectedMemory.flatMap((record) => {
    const qualifiers = record.memoryItem.qualifiers;
    return [qualifiers.validTimeStart, qualifiers.validTimeEnd, qualifiers.deadline, qualifiers.date]
      .filter((value): value is string => typeof value === "string");
  });
  return {
    clusterId: args.cluster.id,
    clusterVersion: args.cluster.version,
    resolution: args.cluster.resolution,
    label: args.cluster.label,
    selectedMemory,
    selectedEvidenceSpans,
    entities: args.cluster.coreEntities.slice(0, limits.maxEntities),
    topics: args.cluster.coreTopics.slice(0, limits.maxTopics),
    relationships,
    dependencies,
    contradictions,
    decisions: selectedMemory.flatMap((record) => decisionReferenceIds(record.memoryItem).map((decisionId) => ({ decisionId }))),
    risks,
    temporalSignals: unique(temporalSignals),
    membershipReasons: Object.fromEntries(args.cluster.memberships.map((membership) => [membership.memoryItemId, membership.reasons])),
    excludedMemoryItemIds,
    missingInformation: args.cluster.readiness?.missingInformation ?? [],
    retrievalMetadata: {
      corpusWide: true,
      bounded: true,
      limits,
      selectedMemoryCount: selectedMemory.length,
      selectedEvidenceCount: selectedEvidenceSpans.length,
      ...(args.retrievalMetadata ?? {}),
    },
  };
}

export function validateSuggestedBriefDraft(args: {
  draft: InitiativeBriefDraft;
  dossier: SynthesisClusterDossier;
}): ValidationResult {
  const traceability = validateInitiativeBriefDraftTraceability({
    draft: args.draft,
    selectedMemoryItems: args.dossier.selectedMemory.map((record) => record.memoryItem),
    selectedEvidenceSpans: args.dossier.selectedEvidenceSpans,
  });
  const issues = [...traceability.issues];
  const evidenceById = new Map(args.dossier.selectedEvidenceSpans.map((span) => [span.id, span]));
  for (const record of args.dossier.selectedMemory) {
    if (!isActiveMemory(record.memoryItem)) {
      issues.push({ code: "draft_inactive_memory", message: `Inactive memory cannot support a suggested brief: ${record.memoryItem.id}`, path: ["memoryItemIds"] });
    }
    for (const evidenceSpanId of record.memoryItem.evidenceSpanIds) {
      const evidence = evidenceById.get(evidenceSpanId);
      if (!evidence || evidence.sourceVersionId !== record.memoryItem.sourceVersionId) {
        issues.push({ code: "draft_evidence_binding_invalid", message: `Evidence ${evidenceSpanId} does not support memory ${record.memoryItem.id}.`, path: ["evidenceSpanIds"] });
      }
    }
  }
  if (!args.draft.scope?.trim()) {
    issues.push({ code: "draft_missing_scope", message: "A suggested brief must state its scope.", path: ["scope"] });
  }
  if (!args.draft.contradictionsOrUncertainties) {
    issues.push({ code: "draft_missing_uncertainty_section", message: "A suggested brief must include an explicit contradictions or uncertainties list.", path: ["contradictionsOrUncertainties"] });
  }
  if (args.dossier.contradictions.length > 0 && (args.draft.contradictionsOrUncertainties?.length ?? 0) === 0) {
    issues.push({ code: "draft_omits_contradictions", message: "The dossier contains contradictions, but the draft does not disclose them.", path: ["contradictionsOrUncertainties"] });
  }
  return { ok: issues.length === 0, issues };
}

function buildOpportunityBreakdown(args: {
  cluster: SynthesisCluster;
  selected: MemoryWithEvidence[];
  connections: ClaimConnection[];
  conflicts: ConflictGroup[];
  equivalentBriefExists: boolean;
  now: string;
}): SynthesisOpportunityBreakdown {
  const count = Math.max(1, args.selected.length);
  const evidenceCount = unique(args.selected.flatMap((record) => record.evidenceSpans.map((span) => span.id))).length;
  const sourceCount = unique(args.selected.map((record) => record.memoryItem.sourceVersionId)).length;
  const reviewed = args.selected.filter((record) => record.memoryItem.reviewState === "confirmed").length;
  const actionable = args.selected.filter((record) => ["risk", "dependency", "constraint", "reported_decision", "scope_statement", "ownership_statement"].includes(record.memoryItem.claimType)).length;
  const strategic = args.selected.filter((record) => ["strategic_statement", "reported_decision", "metric"].includes(record.memoryItem.claimType)).length;
  const urgency = args.selected.filter((record) => record.memoryItem.qualifiers.urgent === true || typeof record.memoryItem.qualifiers.deadline === "string").length;
  const duplicates = args.connections.filter((connection) => connection.connectionType === "duplicates").length;
  const openConflictRatio = Math.min(1, args.conflicts.length / count);
  const nowMs = Date.parse(args.now);
  const temporalTimestamps = args.selected.flatMap((record) => [
    record.memoryItem.qualifiers.validTimeStart,
    record.memoryItem.qualifiers.validTimeEnd,
    record.memoryItem.qualifiers.date,
    record.memoryItem.qualifiers.deadline,
  ]).filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const newestTemporalSignal = Math.max(...temporalTimestamps, 0);
  const newestAgeDays = newestTemporalSignal > 0 && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - newestTemporalSignal) / (24 * 60 * 60 * 1_000))
    : 0;
  const recencyFactor = temporalTimestamps.length > 0 ? clamp01(1 - newestAgeDays / 180) : 1;
  return {
    cohesion: clamp01((args.connections.reduce((sum, connection) => sum + connection.confidence, 0) + args.cluster.memberships.reduce((sum, member) => sum + member.score, 0)) / Math.max(1, args.connections.length + count)),
    evidenceBreadth: clamp01(evidenceCount / 8),
    evidenceQuality: clamp01((reviewed + count * 0.65) / count),
    sourceDiversity: clamp01(sourceCount / 4),
    actionability: clamp01(actionable / Math.max(2, count * 0.6)),
    strategicImportance: clamp01(strategic / Math.max(1, count * 0.5)),
    recentMomentum: clamp01(count / 6) * recencyFactor,
    urgency: clamp01(urgency / Math.max(1, count * 0.4)),
    novelty: args.equivalentBriefExists ? 0.2 : 1,
    completeness: clamp01(Math.min(count / 4, evidenceCount / 6) * (actionable > 0 ? 1 : 0.6)),
    contradictionPenalty: openConflictRatio,
    duplicationPenalty: clamp01(duplicates / count),
    stalenessPenalty: temporalTimestamps.length > 0 ? clamp01((newestAgeDays - 90) / 275) : 0,
    existingBriefPenalty: args.equivalentBriefExists ? 1 : 0,
  };
}

function significantTopicTokens(statement: string): string[] {
  const stop = new Set(["about", "after", "again", "could", "from", "have", "into", "more", "should", "their", "there", "these", "those", "through", "using", "with", "would", "needs"]);
  return unique((statement.toLowerCase().match(/[a-z0-9][a-z0-9_-]{4,}/g) ?? []).filter((token) => !stop.has(token)));
}

function sharedClusterLabel(left: MemoryItem, right: MemoryItem): string {
  const rightEntities = new Set(right.entities.map((entity) => normalizeKey(entity.canonicalName ?? entity.name)));
  const sharedEntity = left.entities.find((entity) => rightEntities.has(normalizeKey(entity.canonicalName ?? entity.name)));
  return sharedEntity ? `${sharedEntity.canonicalName ?? sharedEntity.name} related evidence` : "Semantically related evidence";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function resolutionRank(resolution: SynthesisCluster["resolution"]): number {
  return resolution === "narrow_decision" ? 0 : resolution === "initiative" ? 1 : 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}
