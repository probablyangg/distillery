import { z } from "zod";
import {
  type ConflictGroup,
  type EvidenceSpan,
  type GraphEdge,
  type GraphNode,
  type GraphRetrievalClaim,
  type MemoryItem,
} from "@distillery/contracts";
import {
  retrieveMemoryContext,
  type MemoryRetrievalPersistence,
  type RankedClaimInput,
  type RetrievalCandidate,
  type RetrievalGraphSnapshot,
  type RetrievalProfile,
} from "@distillery/memory-retrieval";
import fixture from "../fixtures/retrieval/hybrid-retrieval.v1.json" with { type: "json" };

const CaseSchema = z.object({
  id: z.string().min(1),
  profile: z.enum(["ask", "synthesis"]),
  query: z.string().min(1),
  seedMemoryItemIds: z.array(z.string()).default([]),
  vectorCandidates: z.array(z.string()).default([]),
  sparseCandidates: z.array(z.string()).default([]),
  expectedClaimIds: z.array(z.string()).default([]),
  forbiddenClaimIds: z.array(z.string()).default([]),
  forbiddenTopClaimIds: z.array(z.string()).default([]),
  expectedConflictIds: z.array(z.string()).default([]),
  expectedEvidenceSpanIds: z.array(z.string()).default([]),
  expectedVectorClaimIds: z.array(z.string()).default([]),
  expectedGraphClaimIds: z.array(z.string()).default([]),
  expectedMetadata: z.array(z.string()).default([]),
  minReturnedClaims: z.number().int().min(0).default(0),
});

const FixtureSchema = z.object({
  version: z.literal("hybrid-retrieval.v1"),
  tenantId: z.string().min(1),
  evidenceSpans: z.array(z.object({
    id: z.string(),
    sourceVersionId: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    startChar: z.number(),
    endChar: z.number(),
    text: z.string(),
  })),
  claims: z.array(z.object({
    id: z.string(),
    claimType: z.string(),
    statement: z.string(),
    evidenceSpanIds: z.array(z.string()),
    entities: z.array(z.object({
      name: z.string(),
      entityType: z.string(),
      canonicalName: z.string().optional(),
    })),
    schemas: z.array(z.object({
      subjectType: z.string(),
      predicate: z.string(),
      objectType: z.string(),
      status: z.enum(["candidate", "stable", "rejected"]),
    })),
  })),
  graphEdges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.string(),
    weight: z.number(),
  })),
  conflicts: z.array(z.unknown()),
  cases: z.array(CaseSchema),
});

const parsed = FixtureSchema.parse(fixture);
const evidenceById = new Map(parsed.evidenceSpans.map((span) => [span.id, span as EvidenceSpan]));
const memoryById = new Map(parsed.claims.map((claim) => [claim.id, toMemoryItem(claim)]));
const conflicts = parsed.conflicts as ConflictGroup[];

async function main(): Promise<void> {
  const requiredCases = new Set([
    "exact_identifier_recall",
    "semantic_paraphrase_recall",
    "multi_hop_graph_recall",
    "conflict_aware_retrieval",
    "irrelevant_neighborhood_resistance",
    "synthesis_breadth_and_diversity",
    "stale_or_low_authority_suppression",
    "citation_validity",
  ]);
  const seenCases = new Set(parsed.cases.map((item) => item.id));
  for (const required of requiredCases) {
    if (!seenCases.has(required)) throw new Error(`Missing retrieval fixture case: ${required}`);
  }

  for (const testCase of parsed.cases) {
    const context = await retrieveMemoryContext({
      tenantId: parsed.tenantId,
      profile: testCase.profile as RetrievalProfile,
      queryText: testCase.query,
      seedMemoryItemIds: testCase.seedMemoryItemIds,
      embeddingModel: {
        async embed() {
          return { vectors: [[1, 0, 0]], model: "mock-embedding" };
        },
      },
      persistence: buildPersistence(testCase),
    });

    const returnedIds = context.claims.map((claim) => claim.claim.id);
    for (const expected of testCase.expectedClaimIds) {
      if (!returnedIds.includes(expected)) {
        throw new Error(`${testCase.id}: missing expected claim ${expected}; returned=${returnedIds.join(",")}`);
      }
    }
    for (const forbidden of testCase.forbiddenClaimIds) {
      if (returnedIds.includes(forbidden)) {
        throw new Error(`${testCase.id}: returned forbidden claim ${forbidden}`);
      }
    }
    for (const forbiddenTop of testCase.forbiddenTopClaimIds) {
      if (returnedIds[0] === forbiddenTop) {
        throw new Error(`${testCase.id}: forbidden top claim ${forbiddenTop}`);
      }
    }
    if (context.claims.length < testCase.minReturnedClaims) {
      throw new Error(`${testCase.id}: expected at least ${testCase.minReturnedClaims} claims, got ${context.claims.length}`);
    }
    for (const expectedConflict of testCase.expectedConflictIds) {
      if (!context.conflicts.some((conflict) => conflict.id === expectedConflict)) {
        throw new Error(`${testCase.id}: missing expected conflict ${expectedConflict}`);
      }
    }
    for (const expectedEvidence of testCase.expectedEvidenceSpanIds) {
      const returnedEvidence = new Set(context.claims.flatMap((claim) => claim.evidenceSpans.map((span) => span.id)));
      if (!returnedEvidence.has(expectedEvidence)) {
        throw new Error(`${testCase.id}: missing expected evidence ${expectedEvidence}`);
      }
    }
    for (const expectedVectorClaim of testCase.expectedVectorClaimIds) {
      const claim = context.claims.find((candidate) => candidate.claim.id === expectedVectorClaim);
      if (!claim || claim.vectorScore <= 0) throw new Error(`${testCase.id}: expected vector score for ${expectedVectorClaim}`);
    }
    for (const expectedGraphClaim of testCase.expectedGraphClaimIds) {
      const claim = context.claims.find((candidate) => candidate.claim.id === expectedGraphClaim);
      if (!claim || claim.graphScore <= 0) throw new Error(`${testCase.id}: expected graph score for ${expectedGraphClaim}`);
    }
    for (const metadataKey of testCase.expectedMetadata) {
      const seedCounts = context.metadata.seedCounts as Record<string, number> | undefined;
      if (!seedCounts || !seedCounts[metadataKey]) throw new Error(`${testCase.id}: missing metadata seed count ${metadataKey}`);
    }
  }

  console.log(`retrieval_fixture_version=${parsed.version}`);
  console.log(`retrieval_fixture_cases=${parsed.cases.length}`);
  console.log("retrieval_fixtures=ok");
}

function buildPersistence(testCase: z.infer<typeof CaseSchema>): MemoryRetrievalPersistence {
  const graph = buildGraph();
  return {
    async getRetrievalVectorCandidates(): Promise<RetrievalCandidate[]> {
      return testCase.vectorCandidates.map((claimId, index) => ({
        source: "vector",
        targetType: "claim",
        targetId: claimId,
        claimId,
        nodeId: `claim:${claimId}`,
        score: 1 - index * 0.05,
      }));
    },
    async getRetrievalSparseCandidates(): Promise<RetrievalCandidate[]> {
      return testCase.sparseCandidates.map((claimId, index) => ({
        source: "sparse",
        targetType: "claim",
        targetId: claimId,
        claimId,
        nodeId: `claim:${claimId}`,
        score: 1 - index * 0.05,
      }));
    },
    async getRetrievalGraphSnapshot(input): Promise<RetrievalGraphSnapshot> {
      const selected = new Set(input.seedNodeIds);
      for (let depth = 0; depth < 2; depth += 1) {
        for (const edge of graph.edges) {
          if (selected.has(edge.fromNodeId)) selected.add(edge.toNodeId);
          if (selected.has(edge.toNodeId)) selected.add(edge.fromNodeId);
        }
      }
      const nodes = graph.nodes.filter((node) => selected.has(node.id)).slice(0, input.maxNodes);
      const nodeIds = new Set(nodes.map((node) => node.id));
      const edges = graph.edges
        .filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
        .slice(0, input.maxEdges);
      return { nodes, edges };
    },
    async hydrateRetrievalClaims(input: { rankedClaims: RankedClaimInput[] }) {
      const claims: GraphRetrievalClaim[] = [];
      for (const ranked of input.rankedClaims) {
          const memoryItem = memoryById.get(ranked.claimId);
          if (!memoryItem) continue;
          claims.push({
            claim: memoryItem,
            evidenceSpans: memoryItem.evidenceSpanIds.map((id) => evidenceById.get(id)).filter((span): span is EvidenceSpan => Boolean(span)),
            rank: ranked.rank,
            graphScore: ranked.graphScore,
            vectorScore: ranked.vectorScore,
            lexicalScore: ranked.lexicalScore,
            connectionIds: [],
          });
        }
      const claimIds = new Set(claims.map((claim) => claim.claim.id));
      return {
        claims,
        conflicts: conflicts.filter((conflict) => conflict.members.some((member) => claimIds.has(member.claimId))),
      };
    },
  };
}

function buildGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  for (const claim of parsed.claims) {
    nodes.set(`claim:${claim.id}`, {
      id: `claim:${claim.id}`,
      tenantId: parsed.tenantId,
      nodeType: "claim",
      refId: claim.id,
      label: claim.statement,
      properties: {},
    });
    for (const entity of claim.entities) {
      const nodeId = `entity:${slug(entity.canonicalName ?? entity.name)}`;
      nodes.set(nodeId, {
        id: nodeId,
        tenantId: parsed.tenantId,
        nodeType: "entity",
        refId: entity.canonicalName ?? entity.name,
        label: entity.canonicalName ?? entity.name,
        properties: { entityType: entity.entityType },
      });
    }
  }
  const edges: GraphEdge[] = parsed.graphEdges.map((edge, index) => ({
    id: `edge_${index}`,
    tenantId: parsed.tenantId,
    fromNodeId: edge.from,
    toNodeId: edge.to,
    edgeType: edge.type,
    weight: edge.weight,
    properties: {},
  }));
  return { nodes: [...nodes.values()], edges };
}

function toMemoryItem(claim: z.infer<typeof FixtureSchema>["claims"][number]): MemoryItem {
  return {
    id: claim.id,
    ingestionId: "ing_eval",
    sourceVersionId: "srcv_eval",
    claimType: claim.claimType as MemoryItem["claimType"],
    statement: claim.statement,
    evidenceSpanIds: claim.evidenceSpanIds,
    epistemicStatus: "reported",
    stableDomainTags: [],
    entities: claim.entities,
    relations: [],
    schemas: claim.schemas,
    qualifiers: {},
    reviewState: "confirmed",
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
