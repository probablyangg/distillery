import { describe, expect, it } from "vitest";
import type {
  ConflictGroup,
  MemoryWithEvidence,
  SynthesisCluster,
  SynthesisEnrichmentFacet,
} from "@distillery/contracts";
import {
  buildClusterDossier,
  discoverCorpusSynthesisClusters,
  evaluateClusterReadiness,
  scoreSynthesisOpportunity,
  SYNTHESIS_DOSSIER_LIMITS,
  validateSuggestedBriefDraft,
} from "./index";

describe("corpus-wide synthesis discovery", () => {
  it("forms a cluster from related memory across ingestions and sources", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    expect(cluster.memberships.map((member) => member.memoryItemId).sort()).toEqual(["mem_1", "mem_2", "mem_3"]);
    expect(cluster.sourceVersionIds).toEqual(["srcv_1", "srcv_2", "srcv_3"]);
  });

  it("excludes unrelated memory from an entity cluster", () => {
    const memory = [...launchMemory(), record("mem_weather", { entity: "Weather alerts", tag: "mobile", statement: "Weather alerts need a new color scale." })];
    expect(initiativeCluster(memory).memberships.some((member) => member.memoryItemId === "mem_weather")).toBe(false);
  });

  it("allows one memory to belong to several overlapping clusters", () => {
    const clusters = discoverCorpusSynthesisClusters({ tenantId: "stable", memory: launchMemory() });
    const containingFirst = clusters.filter((cluster) => cluster.memberships.some((member) => member.memoryItemId === "mem_1"));
    expect(containingFirst.map((cluster) => cluster.meaningKey)).toEqual(expect.arrayContaining(["entity:api launch", "tag:docs"]));
    expect(containingFirst.length).toBeGreaterThan(2);
  });

  it("uses bounded vector similarity as an explainable discovery signal", () => {
    const memory = [
      record("mem_vector_1", { ingestionId: "ing_vector_1", sourceVersionId: "srcv_vector_1", statement: "Prepare withdrawal controls for the bridge." }),
      record("mem_vector_2", { ingestionId: "ing_vector_2", sourceVersionId: "srcv_vector_2", statement: "Define emergency bridge exit safeguards." }),
    ].map((item) => ({
      ...item,
      memoryItem: { ...item.memoryItem, entities: [], relations: [], schemas: [], stableDomainTags: [] },
    }));
    const clusters = discoverCorpusSynthesisClusters({
      tenantId: "stable",
      memory,
      similarities: [{
        fromMemoryItemId: "mem_vector_1",
        toMemoryItemId: "mem_vector_2",
        vectorScore: 0.86,
        sparseScore: 0,
        reasons: ["Claim embeddings are close."],
      }],
    });

    const cluster = clusters.find((candidate) => candidate.meaningKey === "similarity:mem_vector_1|mem_vector_2");
    expect(cluster?.memberships).toHaveLength(2);
    expect(cluster?.memberships[0]?.reasons.join(" ")).toContain("Claim embeddings are close");
  });

  it("discovers narrow, initiative, and strategic-theme candidates", () => {
    const clusters = discoverCorpusSynthesisClusters({ tenantId: "stable", memory: launchMemory() });
    expect(new Set(clusters.map((cluster) => cluster.resolution))).toEqual(new Set(["narrow_decision", "initiative", "strategic_theme"]));
  });

  it("keeps cluster identity and version stable across no-op recomputation", () => {
    const memory = launchMemory();
    const first = initiativeCluster(memory);
    const second = initiativeCluster(memory, [first]);
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
    expect(second.lastMeaningfulChangeAt).toBe(first.lastMeaningfulChangeAt);
  });

  it("changes the cluster version when contradiction meaning changes", () => {
    const memory = launchMemory();
    const withoutConflict = initiativeCluster(memory);
    const withConflict = initiativeCluster(memory, [withoutConflict], [blockingConflict()]);

    expect(withConflict.id).toBe(withoutConflict.id);
    expect(withConflict.membershipHash).toBe(withoutConflict.membershipHash);
    expect(withConflict.version).not.toBe(withoutConflict.version);
  });

  it("changes only the version after material membership changes", () => {
    const firstMemory = launchMemory().slice(0, 2);
    const first = initiativeCluster(firstMemory);
    const second = initiativeCluster(launchMemory(), [first]);
    expect(second.id).toBe(first.id);
    expect(second.version).not.toBe(first.version);
    expect(second.memberships).toHaveLength(3);
  });

  it.each(["removed", "superseded"] as const)("excludes %s memory", (reviewState) => {
    const memory = launchMemory();
    memory[2]!.memoryItem.reviewState = reviewState;
    const cluster = initiativeCluster(memory);
    expect(cluster.memberships.map((member) => member.memoryItemId)).not.toContain("mem_3");
  });

  it("includes contradictions in the cluster and penalizes opportunity score", () => {
    const memory = launchMemory();
    const conflict = blockingConflict();
    const cluster = initiativeCluster(memory, [], [conflict]);
    expect(cluster.contradictionIds).toEqual([conflict.id]);
    const without = evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), readyThreshold: 0 });
    const withConflict = evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), conflicts: [conflict], readyThreshold: 0 });
    expect(withConflict.breakdown.contradictionPenalty).toBeGreaterThan(without.breakdown.contradictionPenalty);
    expect(withConflict.score).toBeLessThan(without.score);
    expect(withConflict.state).toBe("not_ready");
  });
});

describe("cluster readiness and bounded dossiers", () => {
  it("returns not_ready with reasons when the deterministic threshold is not met", () => {
    const memory = launchMemory().slice(0, 2);
    const cluster = initiativeCluster(memory);
    const result = evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), readyThreshold: 99 });
    expect(result.state).toBe("not_ready");
    expect(result.reasons.join(" ")).toContain("Deterministic opportunity score");
  });

  it("returns pending_enrichment instead of a false successful skip", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    const result = evaluateClusterReadiness({ cluster, memory, enrichment: [], readyThreshold: 0 });
    expect(result.state).toBe("pending_enrichment");
    expect(result.reasons[0]).toMatch(/Waiting for/);
  });

  it("reevaluates to ready after a later connection completion", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    const almost = enriched(memory).map((state) => ({ ...state, completedFacets: state.completedFacets.filter((facet) => facet !== "connections") }));
    expect(evaluateClusterReadiness({ cluster, memory, enrichment: almost, readyThreshold: 0 }).state).toBe("pending_enrichment");
    expect(evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), readyThreshold: 0 }).state).toBe("ready");
  });

  it("is invariant across every ordering permutation of enrichment completion", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    const facets: SynthesisEnrichmentFacet[] = ["connections", "contradictions", "embeddings", "graph"];
    for (const order of permutations(facets)) {
      const enrichment = enriched(memory).map((state) => ({ ...state, completedFacets: order }));
      expect(evaluateClusterReadiness({ cluster, memory, enrichment, readyThreshold: 0 }).state).toBe("ready");
    }
  });

  it("uses one deterministic readiness identity for one cluster version", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    const first = evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), readyThreshold: 0 });
    const second = evaluateClusterReadiness({ cluster, memory, enrichment: enriched(memory), readyThreshold: 0 });
    expect(second.id).toBe(first.id);
  });

  it("permits a new readiness and draft identity after a cluster version changes", () => {
    const firstMemory = launchMemory().slice(0, 2);
    const firstCluster = initiativeCluster(firstMemory);
    const nextMemory = launchMemory();
    const nextCluster = initiativeCluster(nextMemory, [firstCluster]);
    const first = evaluateClusterReadiness({ cluster: firstCluster, memory: firstMemory, enrichment: enriched(firstMemory), readyThreshold: 0 });
    const next = evaluateClusterReadiness({ cluster: nextCluster, memory: nextMemory, enrichment: enriched(nextMemory), readyThreshold: 0 });
    expect(next.id).not.toBe(first.id);
  });

  it("builds a capped dossier and reports inactive exclusions", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory);
    cluster.memberships.push({ memoryItemId: "mem_removed", score: 0.5, reasons: ["Old context."], role: "context" });
    memory.push(record("mem_removed", { reviewState: "removed", entity: "API launch" }));
    const dossier = buildClusterDossier({
      cluster,
      memory,
      limits: { maxMemoryItems: 2, maxEvidenceSpans: 2, maxCharacters: 10_000 },
    });
    expect(dossier.selectedMemory).toHaveLength(2);
    expect(dossier.selectedEvidenceSpans.length).toBeLessThanOrEqual(2);
    expect(dossier.excludedMemoryItemIds).toEqual(["mem_removed"]);
    expect(dossier.retrievalMetadata.limits).toMatchObject({ maxConnections: SYNTHESIS_DOSSIER_LIMITS.maxConnections });
  });

  it("keeps older related memory and excludes unrelated recent memory", () => {
    const old = record("mem_old", { entity: "API launch", tag: "docs", statement: "Older audit evidence defines the API launch gate." });
    const current = record("mem_current", { entity: "API launch", tag: "docs", statement: "Current launch work still depends on audit evidence." });
    const recentUnrelated = record("mem_recent", { entity: "Weather alerts", tag: "mobile", statement: "A recent weather alert color changed." });
    const memory = [old, current, recentUnrelated];
    const cluster = initiativeCluster(memory);
    const dossier = buildClusterDossier({ cluster, memory });
    expect(dossier.selectedMemory.map((record) => record.memoryItem.id)).toContain("mem_old");
    expect(dossier.selectedMemory.map((record) => record.memoryItem.id)).not.toContain("mem_recent");
  });

  it("rejects unsupported evidence and undisclosed contradictions", () => {
    const memory = launchMemory();
    const cluster = initiativeCluster(memory, [], [blockingConflict()]);
    const dossier = buildClusterDossier({ cluster, memory, conflicts: [blockingConflict()] });
    const result = validateSuggestedBriefDraft({
      dossier,
      draft: {
        title: "Launch",
        problem: "A launch problem.",
        proposal: "Act on the launch problem.",
        successMetric: "Launch criteria agreed.",
        memoryItemIds: dossier.selectedMemory.map((record) => record.memoryItem.id),
        evidenceSpanIds: [...dossier.selectedEvidenceSpans.map((span) => span.id), "ev_unknown"],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["draft_unsupported_evidence", "draft_omits_contradictions"]));
  });

  it("keeps all scoring constants deterministic and clamps the score", () => {
    expect(scoreSynthesisOpportunity({
      cohesion: 1, evidenceBreadth: 1, evidenceQuality: 1, sourceDiversity: 1,
      actionability: 1, strategicImportance: 1, recentMomentum: 1, urgency: 1,
      novelty: 1, completeness: 1, contradictionPenalty: 0, duplicationPenalty: 0,
      stalenessPenalty: 0, existingBriefPenalty: 0,
    })).toBe(100);
    expect(scoreSynthesisOpportunity({
      cohesion: 0, evidenceBreadth: 0, evidenceQuality: 0, sourceDiversity: 0,
      actionability: 0, strategicImportance: 0, recentMomentum: 0, urgency: 0,
      novelty: 0, completeness: 0, contradictionPenalty: 1, duplicationPenalty: 1,
      stalenessPenalty: 1, existingBriefPenalty: 1,
    })).toBe(0);
  });
});

function launchMemory(): MemoryWithEvidence[] {
  return [
    record("mem_1", { ingestionId: "ing_1", sourceVersionId: "srcv_1", claimType: "dependency", statement: "API launch depends on updated developer documentation." }),
    record("mem_2", { ingestionId: "ing_2", sourceVersionId: "srcv_2", claimType: "risk", statement: "API launch risk remains until documentation ownership is clear." }),
    record("mem_3", { ingestionId: "ing_3", sourceVersionId: "srcv_3", claimType: "metric", statement: "API launch readiness requires complete documentation checks." }),
  ];
}

function record(id: string, overrides: {
  ingestionId?: string;
  sourceVersionId?: string;
  claimType?: MemoryWithEvidence["memoryItem"]["claimType"];
  statement?: string;
  entity?: string;
  tag?: string;
  reviewState?: MemoryWithEvidence["memoryItem"]["reviewState"];
} = {}): MemoryWithEvidence {
  const sourceVersionId = overrides.sourceVersionId ?? `srcv_${id}`;
  const evidenceId = `ev_${id}`;
  return {
    memoryItem: {
      id,
      ingestionId: overrides.ingestionId ?? `ing_${id}`,
      sourceVersionId,
      claimType: overrides.claimType ?? "dependency",
      statement: overrides.statement ?? "API launch work needs a documented dependency decision.",
      evidenceSpanIds: [evidenceId],
      epistemicStatus: "reported",
      qualifiers: {},
      stableDomainTags: [overrides.tag ?? "docs"],
      entities: [{ name: overrides.entity ?? "API launch", entityType: "initiative" }],
      relations: [{ subject: "Developer docs", predicate: "blocks", object: "API launch", evidenceSpanIds: [evidenceId] }],
      schemas: [{ subjectType: "artifact", predicate: "blocks", objectType: "initiative", status: "candidate" }],
      reviewState: overrides.reviewState ?? "confirmed",
    },
    evidenceSpans: [{ id: evidenceId, sourceVersionId, startLine: 1, endLine: 1, startChar: 0, endChar: 30, text: overrides.statement ?? "Evidence for the memory statement." }],
  };
}

function initiativeCluster(
  memory: MemoryWithEvidence[],
  existingClusters: SynthesisCluster[] = [],
  conflicts: ConflictGroup[] = [],
): SynthesisCluster {
  const cluster = discoverCorpusSynthesisClusters({ tenantId: "stable", memory, existingClusters, conflicts, now: "2026-07-15T12:00:00.000Z" })
    .find((candidate) => candidate.meaningKey === "entity:api launch");
  if (!cluster) throw new Error("expected API launch initiative cluster");
  return cluster;
}

function enriched(memory: MemoryWithEvidence[]) {
  return memory.map((record) => ({
    memoryItemId: record.memoryItem.id,
    inputVersion: "v1",
    completedFacets: ["connections", "contradictions", "embeddings", "graph"] as SynthesisEnrichmentFacet[],
    failedFacets: [] as SynthesisEnrichmentFacet[],
    updatedAt: "2026-07-15T12:00:00.000Z",
  }));
}

function blockingConflict(): ConflictGroup {
  return {
    id: "conflict_1",
    tenantId: "stable",
    conflictType: "dependency",
    severity: "blocking",
    status: "open",
    summary: "The launch dependency is disputed.",
    members: [
      { conflictGroupId: "conflict_1", claimId: "mem_1", role: "claim", evidenceSpanIds: ["ev_mem_1"] },
      { conflictGroupId: "conflict_1", claimId: "mem_2", role: "counterclaim", evidenceSpanIds: ["ev_mem_2"] },
    ],
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}
