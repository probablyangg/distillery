import type {
  ConflictGroup,
  EmbeddingTargetType,
  GraphEdge,
  GraphNode,
  GraphRecallContext,
  GraphRetrievalClaim,
} from "@distillery/contracts";
import type { EmbeddingModel, RetrievalRerankerModel } from "@distillery/model-gateway";

export type RetrievalProfile = "ask" | "synthesis";

export type RetrievalCandidateSource = "vector" | "sparse" | "seed";

export type RetrievalCandidate = {
  source: RetrievalCandidateSource;
  targetType: EmbeddingTargetType;
  targetId: string;
  nodeId: string;
  claimId?: string | undefined;
  score: number;
  label?: string | undefined;
};

export type RetrievalGraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type RankedClaimInput = {
  claimId: string;
  rank: number;
  graphScore: number;
  vectorScore: number;
  lexicalScore: number;
};

export type HydratedRetrievalClaims = {
  claims: GraphRetrievalClaim[];
  conflicts: ConflictGroup[];
};

export type MemoryRetrievalPersistence = {
  getRetrievalVectorCandidates(input: {
    tenantId: string;
    queryEmbedding: number[];
    targetTypes: EmbeddingTargetType[];
    limit: number;
    embeddingModel?: string;
  }): Promise<RetrievalCandidate[]>;
  getRetrievalSparseCandidates(input: {
    tenantId: string;
    queryText: string;
    limit: number;
  }): Promise<RetrievalCandidate[]>;
  getRetrievalGraphSnapshot(input: {
    tenantId: string;
    seedNodeIds: string[];
    maxNodes: number;
    maxEdges: number;
  }): Promise<RetrievalGraphSnapshot>;
  hydrateRetrievalClaims(input: {
    tenantId: string;
    rankedClaims: RankedClaimInput[];
  }): Promise<HydratedRetrievalClaims>;
};

export type RetrieveMemoryContextInput = {
  tenantId: string;
  profile: RetrievalProfile;
  queryText: string;
  seedMemoryItemIds?: string[] | undefined;
  embeddingModel?: EmbeddingModel | undefined;
  rerankerModel?: RetrievalRerankerModel | undefined;
  persistence: MemoryRetrievalPersistence;
};

export type RetrievalProfileConfig = {
  vectorTopKPerLayer: number;
  sparseTopKPerLayer: number;
  maxGraphNodes: number;
  maxGraphEdges: number;
  pprIterations: number;
  pprRestart: number;
  pprTolerance: number;
  rerankCandidateClaims: number;
  finalClaims: number;
};

export const RETRIEVAL_PROFILE_CONFIG: Record<RetrievalProfile, RetrievalProfileConfig> = {
  ask: {
    vectorTopKPerLayer: 64,
    sparseTopKPerLayer: 32,
    maxGraphNodes: 1000,
    maxGraphEdges: 4000,
    pprIterations: 30,
    pprRestart: 0.5,
    pprTolerance: 0.000001,
    rerankCandidateClaims: 10,
    finalClaims: 10,
  },
  synthesis: {
    vectorTopKPerLayer: 96,
    sparseTopKPerLayer: 64,
    maxGraphNodes: 2500,
    maxGraphEdges: 10000,
    pprIterations: 40,
    pprRestart: 0.5,
    pprTolerance: 0.000001,
    rerankCandidateClaims: 60,
    finalClaims: 32,
  },
};

const VECTOR_TARGET_TYPES: EmbeddingTargetType[] = ["claim", "evidence_span", "entity", "schema_pattern"];

export async function retrieveMemoryContext(input: RetrieveMemoryContextInput): Promise<GraphRecallContext> {
  const queryText = input.queryText.trim();
  if (!queryText) {
    return emptyContext(input.profile, input.queryText, "empty_query");
  }

  const config = RETRIEVAL_PROFILE_CONFIG[input.profile];
  const metadata: Record<string, unknown> = {
    strategy: "hybrid-graph-ppr-rerank",
    profile: input.profile,
    degraded: false,
  };

  let queryEmbedding: number[] | undefined;
  let embeddingModelName: string | undefined;
  if (input.embeddingModel) {
    try {
      const response = await input.embeddingModel.embed({ targetType: "claim", input: [queryText] });
      queryEmbedding = response.vectors[0];
      embeddingModelName = response.model;
      metadata.embeddingModel = response.model;
    } catch (error) {
      metadata.degraded = true;
      metadata.embeddingFailureReason = errorMessage(error);
    }
  } else {
    metadata.degraded = true;
    metadata.embeddingFailureReason = "embedding model not configured";
  }

  const vectorCandidates = queryEmbedding
    ? await input.persistence.getRetrievalVectorCandidates({
      tenantId: input.tenantId,
      queryEmbedding,
      targetTypes: VECTOR_TARGET_TYPES,
      limit: config.vectorTopKPerLayer,
      ...(embeddingModelName ? { embeddingModel: embeddingModelName } : {}),
    })
    : [];

  const sparseCandidates = await input.persistence.getRetrievalSparseCandidates({
    tenantId: input.tenantId,
    queryText,
    limit: config.sparseTopKPerLayer,
  });

  const seedCandidates = (input.seedMemoryItemIds ?? []).map((claimId): RetrievalCandidate => ({
    source: "seed",
    targetType: "claim",
    targetId: claimId,
    nodeId: `claim:${claimId}`,
    claimId,
    score: 1,
  }));

  const candidates = normalizeCandidates([...vectorCandidates, ...sparseCandidates, ...seedCandidates]);
  metadata.seedCounts = countCandidates(candidates);

  if (candidates.length === 0) {
    return {
      question: input.queryText,
      claims: [],
      conflicts: [],
      metadata: {
        ...metadata,
        gap: "No retrieval candidates were available.",
      },
    };
  }

  const seedNodeIds = uniqueStrings(candidates.map((candidate) => candidate.nodeId));
  const graph = await input.persistence.getRetrievalGraphSnapshot({
    tenantId: input.tenantId,
    seedNodeIds,
    maxNodes: config.maxGraphNodes,
    maxEdges: config.maxGraphEdges,
  });

  const resetWeights = buildResetWeights(candidates, graph.nodes);
  const ppr = runPersonalizedPageRank({
    nodes: graph.nodes,
    edges: graph.edges,
    resetWeights,
    iterations: config.pprIterations,
    restartProbability: config.pprRestart,
    tolerance: config.pprTolerance,
  });

  metadata.graph = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    pprIterations: ppr.iterations,
    converged: ppr.converged,
    hitNodeCap: graph.nodes.length >= config.maxGraphNodes,
    hitEdgeCap: graph.edges.length >= config.maxGraphEdges,
  };

  const claimNodes = new Map(graph.nodes.filter((node) => node.nodeType === "claim").map((node) => [node.id, node]));
  const scoreByClaim = scoreClaims({
    claimNodes,
    pprScores: ppr.scores,
    candidates,
  });

  if (scoreByClaim.length === 0) {
    return {
      question: input.queryText,
      claims: [],
      conflicts: [],
      metadata: {
        ...metadata,
        gap: "Retrieval candidates did not map to active claim nodes.",
      },
    };
  }

  const prerank = scoreByClaim
    .sort((left, right) =>
      right.graphScore - left.graphScore ||
      right.vectorScore - left.vectorScore ||
      right.lexicalScore - left.lexicalScore ||
      left.claimId.localeCompare(right.claimId)
    )
    .slice(0, config.rerankCandidateClaims)
    .map((claim, index) => ({ ...claim, rank: index + 1 }));

  let hydrated = await input.persistence.hydrateRetrievalClaims({
    tenantId: input.tenantId,
    rankedClaims: prerank,
  });

  if (input.rerankerModel && hydrated.claims.length > 1) {
    try {
      const reranked = await input.rerankerModel.rerankRetrieval({
        question: queryText,
        profile: input.profile,
        candidates: hydrated.claims.map((claim) => ({
          claimId: claim.claim.id,
          statement: claim.claim.statement,
          evidenceSpanTexts: claim.evidenceSpans.map((span) => span.text),
          graphScore: claim.graphScore,
          vectorScore: claim.vectorScore,
          sparseScore: claim.lexicalScore,
          conflictWarningCount: hydrated.conflicts.filter((conflict) =>
            conflict.members.some((member) => member.claimId === claim.claim.id)
          ).length,
        })),
      });
      hydrated = {
        ...hydrated,
        claims: reorderClaims(hydrated.claims, reranked.rankedClaimIds),
      };
      metadata.reranker = { model: reranked.model, used: true };
    } catch (error) {
      metadata.degraded = true;
      metadata.reranker = { used: false, fallbackReason: errorMessage(error) };
    }
  } else {
    metadata.reranker = { used: false, fallbackReason: input.rerankerModel ? "not_enough_candidates" : "reranker not configured" };
  }

  const finalClaims = hydrated.claims.slice(0, config.finalClaims).map((claim, index) => ({
    ...claim,
    rank: index + 1,
  }));
  const finalClaimIds = new Set(finalClaims.map((claim) => claim.claim.id));

  return {
    question: input.queryText,
    claims: finalClaims,
    conflicts: hydrated.conflicts.filter((conflict) =>
      conflict.members.some((member) => finalClaimIds.has(member.claimId))
    ),
    metadata: {
      ...metadata,
      returnedClaimCount: finalClaims.length,
    },
  };
}

export function runPersonalizedPageRank(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  resetWeights: Map<string, number>;
  iterations: number;
  restartProbability: number;
  tolerance: number;
}): { scores: Map<string, number>; iterations: number; converged: boolean } {
  const nodeIds = input.nodes.map((node) => node.id);
  if (nodeIds.length === 0) return { scores: new Map(), iterations: 0, converged: true };

  const reset = normalizeMap(input.resetWeights, nodeIds);
  let scores = new Map(reset);
  const adjacency = buildAdjacency(nodeIds, input.edges);

  for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
    const next = new Map<string, number>();
    for (const nodeId of nodeIds) {
      next.set(nodeId, input.restartProbability * (reset.get(nodeId) ?? 0));
    }

    for (const nodeId of nodeIds) {
      const outgoing = adjacency.get(nodeId) ?? [];
      const score = scores.get(nodeId) ?? 0;
      if (outgoing.length === 0) {
        next.set(nodeId, (next.get(nodeId) ?? 0) + (1 - input.restartProbability) * score);
        continue;
      }
      const totalWeight = outgoing.reduce((sum, edge) => sum + edge.weight, 0) || 1;
      for (const edge of outgoing) {
        next.set(edge.to, (next.get(edge.to) ?? 0) + (1 - input.restartProbability) * score * (edge.weight / totalWeight));
      }
    }

    const normalizedNext = normalizeMap(next, nodeIds);
    const delta = nodeIds.reduce((sum, nodeId) => sum + Math.abs((scores.get(nodeId) ?? 0) - (normalizedNext.get(nodeId) ?? 0)), 0);
    scores = normalizedNext;
    if (delta <= input.tolerance) {
      return { scores, iterations: iteration, converged: true };
    }
  }

  return { scores, iterations: input.iterations, converged: false };
}

function emptyContext(profile: RetrievalProfile, question: string, reason: string): GraphRecallContext {
  return {
    question,
    claims: [],
    conflicts: [],
    metadata: {
      strategy: "hybrid-graph-ppr-rerank",
      profile,
      gap: reason,
    },
  };
}

function normalizeCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  const maxBySource = new Map<RetrievalCandidateSource, number>();
  for (const candidate of candidates) {
    maxBySource.set(candidate.source, Math.max(maxBySource.get(candidate.source) ?? 0, candidate.score));
  }

  const byKey = new Map<string, RetrievalCandidate>();
  for (const candidate of candidates) {
    const sourceMax = maxBySource.get(candidate.source) || 1;
    const score = Math.max(0, Math.min(1, candidate.score / sourceMax));
    const key = `${candidate.source}:${candidate.nodeId}:${candidate.targetType}:${candidate.targetId}`;
    const existing = byKey.get(key);
    if (!existing || score > existing.score) byKey.set(key, { ...candidate, score });
  }
  return [...byKey.values()];
}

function buildResetWeights(candidates: RetrievalCandidate[], nodes: GraphNode[]): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const weights = new Map<string, number>();
  for (const candidate of candidates) {
    if (!nodeIds.has(candidate.nodeId)) continue;
    const sourceWeight = candidate.source === "seed" ? 1 : candidate.source === "vector" ? 0.75 : 0.6;
    const node = nodes.find((record) => record.id === candidate.nodeId);
    const degreePenalty = node?.nodeType === "schema" || node?.nodeType === "entity"
      ? 0.75
      : 1;
    weights.set(candidate.nodeId, Math.max(weights.get(candidate.nodeId) ?? 0, candidate.score * sourceWeight * degreePenalty));
  }
  return weights;
}

function scoreClaims(input: {
  claimNodes: Map<string, GraphNode>;
  pprScores: Map<string, number>;
  candidates: RetrievalCandidate[];
}): RankedClaimInput[] {
  const vectorByClaim = new Map<string, number>();
  const sparseByClaim = new Map<string, number>();
  for (const candidate of input.candidates) {
    if (candidate.targetType !== "claim") continue;
    const claimId = candidate.claimId ?? candidate.targetId;
    if (candidate.source === "vector") vectorByClaim.set(claimId, Math.max(vectorByClaim.get(claimId) ?? 0, candidate.score));
    if (candidate.source === "sparse" || candidate.source === "seed") {
      sparseByClaim.set(claimId, Math.max(sparseByClaim.get(claimId) ?? 0, candidate.score));
    }
  }

  return [...input.claimNodes.values()]
    .map((node) => {
      const claimId = node.refId;
      return {
        claimId,
        rank: 0,
        graphScore: input.pprScores.get(node.id) ?? 0,
        vectorScore: vectorByClaim.get(claimId) ?? 0,
        lexicalScore: sparseByClaim.get(claimId) ?? 0,
      };
    })
    .filter((claim) => claim.graphScore > 0 || claim.vectorScore > 0 || claim.lexicalScore > 0);
}

function reorderClaims(claims: GraphRetrievalClaim[], rankedClaimIds: string[]): GraphRetrievalClaim[] {
  const byId = new Map(claims.map((claim) => [claim.claim.id, claim]));
  const ordered: GraphRetrievalClaim[] = [];
  const seen = new Set<string>();
  for (const claimId of rankedClaimIds) {
    const claim = byId.get(claimId);
    if (!claim || seen.has(claimId)) continue;
    ordered.push(claim);
    seen.add(claimId);
  }
  for (const claim of claims) {
    if (!seen.has(claim.claim.id)) ordered.push(claim);
  }
  return ordered;
}

function buildAdjacency(nodeIds: string[], edges: GraphEdge[]): Map<string, Array<{ to: string; weight: number }>> {
  const nodeSet = new Set(nodeIds);
  const adjacency = new Map<string, Array<{ to: string; weight: number }>>();
  for (const edge of edges) {
    if (!nodeSet.has(edge.fromNodeId) || !nodeSet.has(edge.toNodeId)) continue;
    const weight = Math.max(0.01, edge.weight);
    adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) ?? []), { to: edge.toNodeId, weight }]);
    adjacency.set(edge.toNodeId, [...(adjacency.get(edge.toNodeId) ?? []), { to: edge.fromNodeId, weight }]);
  }
  return adjacency;
}

function normalizeMap(values: Map<string, number>, nodeIds: string[]): Map<string, number> {
  const total = nodeIds.reduce((sum, nodeId) => sum + Math.max(0, values.get(nodeId) ?? 0), 0);
  if (total <= 0) {
    const uniform = 1 / Math.max(1, nodeIds.length);
    return new Map(nodeIds.map((nodeId) => [nodeId, uniform]));
  }
  return new Map(nodeIds.map((nodeId) => [nodeId, Math.max(0, values.get(nodeId) ?? 0) / total]));
}

function countCandidates(candidates: RetrievalCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.targetType}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
