import { describe, expect, it } from "vitest";
import type { EvidenceSpan, GraphEdge, GraphNode, MemoryItem } from "@distillery/contracts";
import {
  RETRIEVAL_PROFILE_CONFIG,
  retrieveMemoryContext,
  runPersonalizedPageRank,
  type MemoryRetrievalPersistence,
  type RankedClaimInput,
  type RetrievalCandidate,
  type RetrievalGraphSnapshot,
} from "./index";

const evidence: EvidenceSpan = {
  id: "ev_1",
  sourceVersionId: "srcv_1",
  startLine: 1,
  endLine: 1,
  startChar: 0,
  endChar: 20,
  text: "Relayer review blocks launch.",
};

function memoryItem(id: string, statement: string): MemoryItem {
  return {
    id,
    ingestionId: "ing_1",
    sourceVersionId: "srcv_1",
    claimType: "dependency",
    statement,
    evidenceSpanIds: ["ev_1"],
    epistemicStatus: "reported",
    stableDomainTags: [],
    entities: [],
    relations: [],
    schemas: [],
    qualifiers: {},
    reviewState: "confirmed",
  };
}

describe("runPersonalizedPageRank", () => {
  it("propagates seed weight through weighted graph edges", () => {
    const nodes: GraphNode[] = [
      { id: "claim:a", tenantId: "stable", nodeType: "claim", refId: "a", label: "A", properties: {} },
      { id: "entity:x", tenantId: "stable", nodeType: "entity", refId: "x", label: "X", properties: {} },
      { id: "claim:b", tenantId: "stable", nodeType: "claim", refId: "b", label: "B", properties: {} },
    ];
    const edges: GraphEdge[] = [
      { id: "e1", tenantId: "stable", fromNodeId: "claim:a", toNodeId: "entity:x", edgeType: "mentions", weight: 1, properties: {} },
      { id: "e2", tenantId: "stable", fromNodeId: "entity:x", toNodeId: "claim:b", edgeType: "mentions", weight: 1, properties: {} },
    ];

    const result = runPersonalizedPageRank({
      nodes,
      edges,
      resetWeights: new Map([["claim:a", 1]]),
      iterations: 20,
      restartProbability: 0.5,
      tolerance: 0.000001,
    });

    expect(result.scores.get("claim:a")).toBeGreaterThan(0);
    expect(result.scores.get("claim:b")).toBeGreaterThan(0);
  });
});

describe("retrieveMemoryContext", () => {
  it("hydrates PPR-ranked claims from hybrid seeds", async () => {
    const nodes: GraphNode[] = [
      { id: "claim:mem_1", tenantId: "stable", nodeType: "claim", refId: "mem_1", label: "Relayer", properties: {} },
      { id: "entity:relayer", tenantId: "stable", nodeType: "entity", refId: "relayer", label: "relayer", properties: {} },
      { id: "claim:mem_2", tenantId: "stable", nodeType: "claim", refId: "mem_2", label: "Launch", properties: {} },
    ];
    const edges: GraphEdge[] = [
      { id: "e1", tenantId: "stable", fromNodeId: "claim:mem_1", toNodeId: "entity:relayer", edgeType: "mentions", weight: 1, properties: {} },
      { id: "e2", tenantId: "stable", fromNodeId: "entity:relayer", toNodeId: "claim:mem_2", edgeType: "mentions", weight: 1, properties: {} },
    ];
    const persistence: MemoryRetrievalPersistence = {
      async getRetrievalVectorCandidates(): Promise<RetrievalCandidate[]> {
        return [{
          source: "vector",
          targetType: "claim",
          targetId: "mem_1",
          claimId: "mem_1",
          nodeId: "claim:mem_1",
          score: 0.9,
        }];
      },
      async getRetrievalSparseCandidates(): Promise<RetrievalCandidate[]> {
        return [];
      },
      async getRetrievalGraphSnapshot(): Promise<RetrievalGraphSnapshot> {
        return { nodes, edges };
      },
      async hydrateRetrievalClaims(input: { rankedClaims: RankedClaimInput[] }) {
        return {
          claims: input.rankedClaims.map((ranked) => ({
            claim: memoryItem(ranked.claimId, ranked.claimId === "mem_1"
              ? "Relayer review blocks launch."
              : "Launch messaging depends on relayer review."),
            evidenceSpans: [evidence],
            rank: ranked.rank,
            graphScore: ranked.graphScore,
            vectorScore: ranked.vectorScore,
            lexicalScore: ranked.lexicalScore,
            connectionIds: [],
          })),
          conflicts: [],
        };
      },
    };

    const context = await retrieveMemoryContext({
      tenantId: "stable",
      profile: "ask",
      queryText: "What blocks launch?",
      persistence,
      embeddingModel: {
        async embed() {
          return { vectors: [[1, 0, 0]], model: "test-embedding" };
        },
      },
    });

    expect(context.metadata.strategy).toBe("hybrid-graph-ppr-rerank");
    expect(context.claims.map((claim) => claim.claim.id)).toContain("mem_1");
    expect(context.claims.some((claim) => claim.graphScore > 0)).toBe(true);
  });

  it("continues with sparse graph seeds and degraded metadata when query embedding fails", async () => {
    let vectorCalled = false;
    const persistence: MemoryRetrievalPersistence = {
      async getRetrievalVectorCandidates(): Promise<RetrievalCandidate[]> {
        vectorCalled = true;
        return [];
      },
      async getRetrievalSparseCandidates(): Promise<RetrievalCandidate[]> {
        return [{
          source: "sparse",
          targetType: "claim",
          targetId: "mem_1",
          claimId: "mem_1",
          nodeId: "claim:mem_1",
          score: 1,
        }];
      },
      async getRetrievalGraphSnapshot(): Promise<RetrievalGraphSnapshot> {
        return {
          nodes: [{ id: "claim:mem_1", tenantId: "stable", nodeType: "claim", refId: "mem_1", label: "Launch", properties: {} }],
          edges: [],
        };
      },
      async hydrateRetrievalClaims(input: { rankedClaims: RankedClaimInput[] }) {
        return {
          claims: input.rankedClaims.map((ranked) => ({
            claim: memoryItem(ranked.claimId, "Relayer review blocks launch."),
            evidenceSpans: [evidence],
            rank: ranked.rank,
            graphScore: ranked.graphScore,
            vectorScore: ranked.vectorScore,
            lexicalScore: ranked.lexicalScore,
            connectionIds: [],
          })),
          conflicts: [],
        };
      },
    };

    const context = await retrieveMemoryContext({
      tenantId: "stable",
      profile: "ask",
      queryText: "What blocks launch?",
      persistence,
      embeddingModel: {
        async embed() {
          throw new Error("embedding unavailable");
        },
      },
    });

    expect(vectorCalled).toBe(false);
    expect(context.claims.map((claim) => claim.claim.id)).toEqual(["mem_1"]);
    expect(context.claims[0]?.lexicalScore).toBeGreaterThan(0);
    expect(context.metadata.degraded).toBe(true);
    expect(context.metadata.embeddingFailureReason).toBe("embedding unavailable");
    expect(context.metadata.seedCounts).toMatchObject({ "sparse:claim": 1 });
  });

  it("falls back to deterministic ranking when the reranker returns invalid IDs", async () => {
    const persistence: MemoryRetrievalPersistence = {
      async getRetrievalVectorCandidates(): Promise<RetrievalCandidate[]> {
        return [
          { source: "vector", targetType: "claim", targetId: "mem_1", claimId: "mem_1", nodeId: "claim:mem_1", score: 1 },
          { source: "vector", targetType: "claim", targetId: "mem_2", claimId: "mem_2", nodeId: "claim:mem_2", score: 0.9 },
        ];
      },
      async getRetrievalSparseCandidates(): Promise<RetrievalCandidate[]> {
        return [];
      },
      async getRetrievalGraphSnapshot(): Promise<RetrievalGraphSnapshot> {
        return {
          nodes: [
            { id: "claim:mem_1", tenantId: "stable", nodeType: "claim", refId: "mem_1", label: "A", properties: {} },
            { id: "claim:mem_2", tenantId: "stable", nodeType: "claim", refId: "mem_2", label: "B", properties: {} },
          ],
          edges: [],
        };
      },
      async hydrateRetrievalClaims(input: { rankedClaims: RankedClaimInput[] }) {
        return {
          claims: input.rankedClaims.map((ranked) => ({
            claim: memoryItem(ranked.claimId, `${ranked.claimId} blocks launch.`),
            evidenceSpans: [evidence],
            rank: ranked.rank,
            graphScore: ranked.graphScore,
            vectorScore: ranked.vectorScore,
            lexicalScore: ranked.lexicalScore,
            connectionIds: [],
          })),
          conflicts: [],
        };
      },
    };

    const context = await retrieveMemoryContext({
      tenantId: "stable",
      profile: "ask",
      queryText: "What blocks launch?",
      persistence,
      embeddingModel: {
        async embed() {
          return { vectors: [[1, 0, 0]], model: "test-embedding" };
        },
      },
      rerankerModel: {
        async rerankRetrieval() {
          throw new Error("Retrieval reranker returned unknown claim ID: mem_missing");
        },
      },
    });

    expect(context.claims.map((claim) => claim.claim.id)).toEqual(["mem_1", "mem_2"]);
    expect(context.metadata.degraded).toBe(true);
    expect(context.metadata.reranker).toMatchObject({ used: false });
  });
});

describe("RETRIEVAL_PROFILE_CONFIG", () => {
  it("keeps synthesis broader than Ask while Ask reranks only returned claims", () => {
    expect(RETRIEVAL_PROFILE_CONFIG.ask.finalClaims).toBe(10);
    expect(RETRIEVAL_PROFILE_CONFIG.ask.rerankCandidateClaims).toBe(RETRIEVAL_PROFILE_CONFIG.ask.finalClaims);
    expect(RETRIEVAL_PROFILE_CONFIG.synthesis.maxGraphNodes).toBeGreaterThan(RETRIEVAL_PROFILE_CONFIG.ask.maxGraphNodes);
    expect(RETRIEVAL_PROFILE_CONFIG.synthesis.maxGraphEdges).toBeGreaterThan(RETRIEVAL_PROFILE_CONFIG.ask.maxGraphEdges);
    expect(RETRIEVAL_PROFILE_CONFIG.synthesis.rerankCandidateClaims).toBeGreaterThan(RETRIEVAL_PROFILE_CONFIG.ask.rerankCandidateClaims);
    expect(RETRIEVAL_PROFILE_CONFIG.synthesis.finalClaims).toBeGreaterThan(RETRIEVAL_PROFILE_CONFIG.ask.finalClaims);
  });
});
