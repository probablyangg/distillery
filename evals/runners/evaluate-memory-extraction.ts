import fs from "node:fs";
import { z } from "zod";
import type { EvidenceSpan, GeneratedMemoryItem } from "@distillery/contracts";
import { OpenRouterMemoryGenerationModel } from "@distillery/model-gateway";
import { validateGeneratedMemory } from "@distillery/validation";

type LocalEnv = Record<string, string>;

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
    })),
  })),
});

type Fixture = z.infer<typeof FixtureFileSchema>["fixtures"][number];

function readLocalEnv(): LocalEnv {
  const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  const env: LocalEnv = {};

  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;

    let value = rawValue.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function requireEnv(env: LocalEnv, key: string): string {
  const value = process.env[key] ?? env[key];
  if (!value) throw new Error(`${key} is required for memory extraction evaluation.`);
  return value;
}

function spanText(fixture: Fixture, startLine: number, endLine: number): string {
  return fixture.inputLines.slice(startLine - 1, endLine).join("\n").trim();
}

function buildEvidenceSpans(fixture: Fixture): EvidenceSpan[] {
  return fixture.expectedSpans.map((span): EvidenceSpan => {
    const [startLine, endLine] = span.lines;
    return {
      id: span.id,
      sourceVersionId: `srcv_eval_${fixture.id}`,
      startLine,
      endLine,
      startChar: 0,
      endChar: spanText(fixture, startLine, endLine).length,
      text: spanText(fixture, startLine, endLine),
    };
  });
}

function supportKey(ids: string[]): string {
  return [...new Set(ids)].sort().join(",");
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function typeSupportMatched(expected: { claimType: string; support: string[] }, generated: GeneratedMemoryItem[]): boolean {
  const expectedSupport = supportKey(expected.support);
  return generated.some((item) => item.claimType === expected.claimType && supportKey(item.evidenceSpanIds) === expectedSupport);
}

function typeNearbyMatched(expected: { claimType: string; support: string[] }, generated: GeneratedMemoryItem[]): boolean {
  return generated.some((item) => item.claimType === expected.claimType && intersects(item.evidenceSpanIds, expected.support));
}

function supportMatched(expected: { support: string[] }, generated: GeneratedMemoryItem[]): boolean {
  const expectedSupport = supportKey(expected.support);
  return generated.some((item) => supportKey(item.evidenceSpanIds) === expectedSupport);
}

function generatedHasExpectedSupport(generated: GeneratedMemoryItem, fixture: Fixture): boolean {
  const generatedSupport = supportKey(generated.evidenceSpanIds);
  return fixture.expectedMemoryItems.some((item) => supportKey(item.support) === generatedSupport);
}

async function main(): Promise<void> {
  const env = readLocalEnv();
  const fixtureFile = FixtureFileSchema.parse(JSON.parse(fs.readFileSync("evals/fixtures/memory-generation/labeled-fixtures.v0.json", "utf8")));
  const only = new Set(process.argv.slice(2));
  const fixtures = only.size > 0
    ? fixtureFile.fixtures.filter((fixture) => only.has(fixture.id))
    : fixtureFile.fixtures;

  if (fixtures.length === 0) throw new Error("No fixtures matched.");

  const model = new OpenRouterMemoryGenerationModel({
    apiKey: requireEnv(env, "OPENROUTER_API_KEY"),
    baseUrl: requireEnv(env, "OPENROUTER_BASE_URL"),
    model: requireEnv(env, "OPENROUTER_MODEL"),
    fallbackModels: (env.OPENROUTER_FALLBACK_MODELS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    timeoutMs: Number.parseInt(env.OPENROUTER_TIMEOUT_MS ?? "10000", 10),
    fallbackTimeoutMs: Number.parseInt(env.OPENROUTER_FALLBACK_TIMEOUT_MS ?? "30000", 10),
  });

  const totals = {
    fixtures: 0,
    valid: 0,
    expectedItems: 0,
    generatedItems: 0,
    typeSupportHits: 0,
    typeNearbyHits: 0,
    supportHits: 0,
    generatedExpectedSupport: 0,
    failed: 0,
    totalMs: 0,
  };

  console.log(`memory_extraction_eval_version=${fixtureFile.version}`);
  console.log(`fixture_count=${fixtures.length}`);

  for (const fixture of fixtures) {
    const evidenceSpans = buildEvidenceSpans(fixture);
    const startedAt = Date.now();

    try {
      const response = await model.generateMemory({
        ingestionId: `ing_eval_${fixture.id}`,
        sourceVersionId: `srcv_eval_${fixture.id}`,
        evidenceSpans,
      });
      const ms = Date.now() - startedAt;
      const validation = validateGeneratedMemory({
        generated: response.parsed,
        allowedEvidenceSpans: evidenceSpans,
      });
      const generated = validation.items;
      const typeSupportHits = fixture.expectedMemoryItems.filter((item) => typeSupportMatched(item, generated)).length;
      const typeNearbyHits = fixture.expectedMemoryItems.filter((item) => typeNearbyMatched(item, generated)).length;
      const supportHits = fixture.expectedMemoryItems.filter((item) => supportMatched(item, generated)).length;
      const generatedExpectedSupport = generated.filter((item) => generatedHasExpectedSupport(item, fixture)).length;

      totals.fixtures += 1;
      totals.valid += validation.result.ok ? 1 : 0;
      totals.expectedItems += fixture.expectedMemoryItems.length;
      totals.generatedItems += generated.length;
      totals.typeSupportHits += typeSupportHits;
      totals.typeNearbyHits += typeNearbyHits;
      totals.supportHits += supportHits;
      totals.generatedExpectedSupport += generatedExpectedSupport;
      totals.totalMs += ms;

      const missCount = fixture.expectedMemoryItems.length - typeSupportHits;
      console.log([
        `fixture=${fixture.id}`,
        `valid=${validation.result.ok}`,
        `expected=${fixture.expectedMemoryItems.length}`,
        `generated=${generated.length}`,
        `type_support_recall=${typeSupportHits}/${fixture.expectedMemoryItems.length}`,
        `support_recall=${supportHits}/${fixture.expectedMemoryItems.length}`,
        `support_precision=${generatedExpectedSupport}/${generated.length}`,
        `ms=${ms}`,
        `model=${response.model}`,
        missCount > 0 ? `misses=${missCount}` : "misses=0",
      ].join(" "));

      if (!validation.result.ok) {
        console.log(`  validation_issues=${JSON.stringify(validation.result.issues)}`);
      }
    } catch (error) {
      const ms = Date.now() - startedAt;
      totals.fixtures += 1;
      totals.expectedItems += fixture.expectedMemoryItems.length;
      totals.failed += 1;
      totals.totalMs += ms;
      console.log(`fixture=${fixture.id} failed=true expected=${fixture.expectedMemoryItems.length} generated=0 ms=${ms} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
  }

  const expected = Math.max(1, totals.expectedItems);
  const generated = Math.max(1, totals.generatedItems);
  console.log("summary=" + JSON.stringify({
    fixtures: totals.fixtures,
    validFixtures: totals.valid,
    failedFixtures: totals.failed,
    expectedItems: totals.expectedItems,
    generatedItems: totals.generatedItems,
    avgGeneratedItemsPerFixture: Number((totals.generatedItems / Math.max(1, totals.fixtures)).toFixed(2)),
    typeSupportRecall: Number((totals.typeSupportHits / expected).toFixed(3)),
    typeNearbyRecall: Number((totals.typeNearbyHits / expected).toFixed(3)),
    supportRecall: Number((totals.supportHits / expected).toFixed(3)),
    supportPrecision: Number((totals.generatedExpectedSupport / generated).toFixed(3)),
    avgMsPerFixture: Math.round(totals.totalMs / Math.max(1, totals.fixtures)),
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
