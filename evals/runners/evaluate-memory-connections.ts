import fs from "node:fs";
import { z } from "zod";
import type { ClaimConnection, MemoryWithEvidence } from "@distillery/contracts";

const FixtureFileSchema = z.object({
  version: z.string(),
  fixtures: z.array(z.object({
    id: z.string(),
    title: z.string(),
    inputLines: z.array(z.string()).min(1),
    expectedSpans: z.array(z.object({
      id: z.string(),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    })),
    expectedMemoryItems: z.array(z.object({
      id: z.string(),
      claimType: z.string(),
      statement: z.string(),
      support: z.array(z.string()).min(1),
      epistemicStatus: z.string(),
      entities: z.array(z.object({
        name: z.string(),
        entityType: z.string(),
        canonicalName: z.string().optional(),
      })).default([]),
      relations: z.array(z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        evidenceSpanIds: z.array(z.string()),
      })).default([]),
      schemas: z.array(z.object({
        subjectType: z.string(),
        predicate: z.string(),
        objectType: z.string(),
        status: z.string(),
      })).default([]),
    })),
  })),
});

type Fixture = z.infer<typeof FixtureFileSchema>["fixtures"][number];
type FixtureMemoryItem = Fixture["expectedMemoryItems"][number];

type ScoredConnection = {
  fixtureId: string;
  fromClaimId: string;
  toClaimId: string;
  connectionType: ClaimConnection["connectionType"];
  status: ClaimConnection["status"];
  confidence: number;
  scoreComponents: Record<string, number>;
};

function spanText(fixture: Fixture, startLine: number, endLine: number): string {
  return fixture.inputLines.slice(startLine - 1, endLine).join("\n").trim();
}

function toMemoryRecord(fixture: Fixture, item: FixtureMemoryItem): MemoryWithEvidence {
  const sourceVersionId = `srcv_eval_${fixture.id}`;
  const spanById = new Map(fixture.expectedSpans.map((span) => {
    const [startLine, endLine] = span.lines;
    return [span.id, {
      id: span.id,
      sourceVersionId,
      startLine,
      endLine,
      startChar: 0,
      endChar: spanText(fixture, startLine, endLine).length,
      text: spanText(fixture, startLine, endLine),
    }];
  }));

  return {
    memoryItem: {
      id: item.id,
      ingestionId: `ing_eval_${fixture.id}`,
      sourceVersionId,
      claimType: item.claimType as MemoryWithEvidence["memoryItem"]["claimType"],
      statement: item.statement,
      evidenceSpanIds: item.support,
      epistemicStatus: item.epistemicStatus as MemoryWithEvidence["memoryItem"]["epistemicStatus"],
      qualifiers: {},
      stableDomainTags: [],
      entities: item.entities,
      relations: item.relations,
      schemas: item.schemas as MemoryWithEvidence["memoryItem"]["schemas"],
      reviewState: "confirmed",
    },
    evidenceSpans: item.support.map((id) => spanById.get(id)).filter((span): span is NonNullable<typeof span> => Boolean(span)),
  };
}

function scoreFixture(fixture: Fixture): ScoredConnection[] {
  const memory = fixture.expectedMemoryItems.map((item) => toMemoryRecord(fixture, item));
  const connections: ScoredConnection[] = [];

  for (let leftIndex = 0; leftIndex < memory.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memory.length; rightIndex += 1) {
      const left = memory[leftIndex]!;
      const right = memory[rightIndex]!;
      const score = scoreConnection(left, right);
      if (score.confidence < 0.55) continue;

      connections.push({
        fixtureId: fixture.id,
        fromClaimId: left.memoryItem.id,
        toClaimId: right.memoryItem.id,
        connectionType: score.connectionType,
        status: score.confidence >= 0.95 && score.connectionType === "duplicates" ? "accepted" : "proposed",
        confidence: score.confidence,
        scoreComponents: score.scoreComponents,
      });
    }
  }

  return connections;
}

function scoreConnection(
  left: MemoryWithEvidence,
  right: MemoryWithEvidence,
): {
  confidence: number;
  connectionType: ClaimConnection["connectionType"];
  scoreComponents: Record<string, number>;
} {
  const leftStatement = normalizeText(left.memoryItem.statement);
  const rightStatement = normalizeText(right.memoryItem.statement);
  const duplicate = leftStatement === rightStatement ? 1 : 0;
  const entityOverlap = jaccard(
    left.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
    right.memoryItem.entities.map((entity) => normalizeText(entity.canonicalName ?? entity.name)),
  );
  const schemaOverlap = jaccard(
    left.memoryItem.schemas.map((schema) => normalizeText(`${schema.subjectType}:${schema.predicate}:${schema.objectType}`)),
    right.memoryItem.schemas.map((schema) => normalizeText(`${schema.subjectType}:${schema.predicate}:${schema.objectType}`)),
  );
  const evidenceOverlap = jaccard(left.memoryItem.evidenceSpanIds, right.memoryItem.evidenceSpanIds);
  const sourceContextOverlap = left.memoryItem.sourceVersionId === right.memoryItem.sourceVersionId ? 1 : 0;
  const relationCompatibility = jaccard(
    left.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}:${relation.object}`)),
    right.memoryItem.relations.map((relation) => normalizeText(`${relation.subject}:${relation.predicate}:${relation.object}`)),
  );
  const tokenOverlap = jaccard(tokenize(left.memoryItem.statement), tokenize(right.memoryItem.statement));
  const claimTypeCompatibility = complementaryClaimTypes(left.memoryItem.claimType, right.memoryItem.claimType) ? 0.1 : 0;
  const hasGrounding = duplicate > 0 || entityOverlap > 0 || schemaOverlap > 0 || evidenceOverlap > 0 ||
    sourceContextOverlap > 0 || relationCompatibility > 0 || tokenOverlap >= 0.22;
  const scoreComponents = {
    entity_overlap: entityOverlap,
    schema_overlap: schemaOverlap,
    evidence_overlap: evidenceOverlap,
    source_context_overlap: sourceContextOverlap,
    relation_compatibility: relationCompatibility,
    embedding_similarity: tokenOverlap,
    temporal_compatibility: 0.5,
    claim_type_compatibility: hasGrounding ? claimTypeCompatibility : 0,
    model_confidence: 0,
    review_prior: 0,
  };
  const confidence = duplicate === 1
    ? 0.97
    : Math.min(0.94, (
      entityOverlap * 0.24 +
      schemaOverlap * 0.2 +
      evidenceOverlap * 0.2 +
      sourceContextOverlap * 0.12 +
      relationCompatibility * 0.14 +
      tokenOverlap * 0.2 +
      scoreComponents.claim_type_compatibility
    ));
  const connectionType = duplicate === 1
    ? "duplicates"
    : left.memoryItem.claimType === "dependency" || right.memoryItem.claimType === "dependency"
      ? "depends_on"
      : left.memoryItem.claimType === "risk" || right.memoryItem.claimType === "risk"
        ? "blocks"
        : confidence >= 0.72
          ? "supports"
          : "related_context";

  return {
    confidence: Number(confidence.toFixed(3)),
    connectionType,
    scoreComponents,
  };
}

function complementaryClaimTypes(left: string, right: string): boolean {
  const pair = new Set([left, right]);
  return (pair.has("risk") && pair.has("dependency")) ||
    (pair.has("ownership_statement") && pair.has("reported_decision")) ||
    (pair.has("scope_statement") && pair.has("strategic_statement"));
}

function tokenize(value: string): string[] {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "on", "in", "is", "are", "be", "we", "this", "that"]);
  return normalizeText(value).split(" ").filter((token) => token.length > 2 && !stop.has(token));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bucketBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(buckets).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function averageComponent(connections: ScoredConnection[], component: string): number {
  return Number(average(connections.map((connection) => connection.scoreComponents[component] ?? 0)).toFixed(3));
}

const parsed = FixtureFileSchema.parse(JSON.parse(fs.readFileSync("evals/fixtures/memory-generation/labeled-fixtures.v0.json", "utf8")));
const allConnections = parsed.fixtures.flatMap(scoreFixture);
const possiblePairs = parsed.fixtures.reduce((sum, fixture) => {
  const count = fixture.expectedMemoryItems.length;
  return sum + (count * (count - 1)) / 2;
}, 0);

console.log(`memory_connection_eval_version=${parsed.version}`);
console.log(`fixture_count=${parsed.fixtures.length}`);

for (const fixture of parsed.fixtures) {
  const connections = allConnections.filter((connection) => connection.fixtureId === fixture.id);
  const possible = (fixture.expectedMemoryItems.length * (fixture.expectedMemoryItems.length - 1)) / 2;
  console.log([
    `fixture=${fixture.id}`,
    `items=${fixture.expectedMemoryItems.length}`,
    `possible_pairs=${possible}`,
    `connections=${connections.length}`,
    `density=${possible === 0 ? 0 : Number((connections.length / possible).toFixed(3))}`,
    `avg_confidence=${Number(average(connections.map((connection) => connection.confidence)).toFixed(3))}`,
    `types=${JSON.stringify(bucketBy(connections, (connection) => connection.connectionType))}`,
  ].join(" "));
}

console.log("summary=" + JSON.stringify({
  fixtures: parsed.fixtures.length,
  items: parsed.fixtures.reduce((sum, fixture) => sum + fixture.expectedMemoryItems.length, 0),
  possiblePairs,
  connections: allConnections.length,
  density: Number((allConnections.length / Math.max(1, possiblePairs)).toFixed(3)),
  proposed: allConnections.filter((connection) => connection.status === "proposed").length,
  accepted: allConnections.filter((connection) => connection.status === "accepted").length,
  avgConfidence: Number(average(allConnections.map((connection) => connection.confidence)).toFixed(3)),
  minConfidence: Math.min(...allConnections.map((connection) => connection.confidence)),
  maxConfidence: Math.max(...allConnections.map((connection) => connection.confidence)),
  byType: bucketBy(allConnections, (connection) => connection.connectionType),
  avgComponents: {
    entity_overlap: averageComponent(allConnections, "entity_overlap"),
    schema_overlap: averageComponent(allConnections, "schema_overlap"),
    evidence_overlap: averageComponent(allConnections, "evidence_overlap"),
    source_context_overlap: averageComponent(allConnections, "source_context_overlap"),
    relation_compatibility: averageComponent(allConnections, "relation_compatibility"),
    embedding_similarity: averageComponent(allConnections, "embedding_similarity"),
    claim_type_compatibility: averageComponent(allConnections, "claim_type_compatibility"),
  },
}));
