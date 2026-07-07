import fs from "node:fs";
import { z } from "zod";
import {
  EpistemicStatusSchema,
  MemoryTypeSchema,
  type EvidenceSpan,
  type MemoryItem,
} from "@distillery/contracts";
import { SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "@distillery/db";
import { sha256Hex } from "@distillery/evidence";
import {
  MEMORY_GENERATION_VERSION,
  MEMORY_PROMPT_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "@distillery/memory-generation";

const TENANT_ID = "stable";
const SEED_ACTOR = "Distillery seed data";
const FIXTURE_PATH = "evals/fixtures/memory-generation/labeled-fixtures.v0.json";

const STARTER_FIXTURE_IDS = [
  "stable-mg-001",
  "stable-mg-002",
  "stable-mg-003",
  "stable-mg-005",
  "stable-mg-006",
  "stable-mg-007",
  "stable-mg-009",
  "stable-mg-010",
  "stable-mg-013",
  "stable-mg-014",
] as const;

type LocalEnv = Record<string, string>;

const FixtureSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  title: z.string().min(1),
  stableDomainTags: z.array(z.string().min(1)),
  inputLines: z.array(z.string()),
  expectedSpans: z.array(
    z.object({
      id: z.string().min(1),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    }),
  ),
  expectedMemoryItems: z.array(
    z.object({
      id: z.string().min(1),
      type: MemoryTypeSchema,
      statement: z.string().min(1),
      support: z.array(z.string().min(1)).min(1),
      epistemicStatus: EpistemicStatusSchema,
    }),
  ),
});

type Fixture = z.infer<typeof FixtureSchema>;

const FixturesFileSchema = z.object({
  version: z.string().min(1),
  company: z.literal("Stable"),
  fixtures: z.array(FixtureSchema),
});

type SeedBrief = {
  id: string;
  title: string;
  problem: string;
  proposal: string;
  successMetric: string;
  risksAndDependencies: string;
  memoryItemIds: string[];
};

function readLocalEnv(): LocalEnv {
  const envText = fs.readFileSync(".env.local", "utf8");
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
  const value = env[key] ?? process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function idFor(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map(slug)].join("_");
}

function memoryItemId(fixtureId: string, itemId: string): string {
  return idFor("mem_seed", fixtureId, itemId);
}

function spanId(fixtureId: string, fixtureSpanId: string): string {
  return idFor("evspan_seed", fixtureId, fixtureSpanId);
}

function sourceVersionId(fixtureId: string): string {
  return idFor("srcv_seed", fixtureId);
}

function buildSeedEvidenceSpans(fixture: Fixture): EvidenceSpan[] {
  const sourceVersion = sourceVersionId(fixture.id);
  const lineStartOffsets: number[] = [];
  let offset = 0;

  for (const line of fixture.inputLines) {
    lineStartOffsets.push(offset);
    offset += line.length + 1;
  }

  return fixture.expectedSpans.map((span) => {
    const [startLine, endLine] = span.lines;
    const startOffset = lineStartOffsets[startLine - 1];
    const endLineText = fixture.inputLines[endLine - 1];
    const endLineStartOffset = lineStartOffsets[endLine - 1];

    if (startOffset === undefined || endLineStartOffset === undefined || endLineText === undefined) {
      throw new Error(`${fixture.id}:${span.id}: span references a missing input line`);
    }

    return {
      id: spanId(fixture.id, span.id),
      sourceVersionId: sourceVersion,
      startLine,
      endLine,
      startChar: startOffset,
      endChar: endLineStartOffset + endLineText.length,
      text: fixture.inputLines.slice(startLine - 1, endLine).join("\n"),
    };
  });
}

function loadFixtures(): Fixture[] {
  const parsed = FixturesFileSchema.parse(JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")));
  const byId = new Map(parsed.fixtures.map((fixture) => [fixture.id, fixture]));
  const fixtureIds = process.argv.includes("--all") ? parsed.fixtures.map((fixture) => fixture.id) : STARTER_FIXTURE_IDS;

  return fixtureIds.map((fixtureId) => {
    const fixture = byId.get(fixtureId);
    if (!fixture) throw new Error(`Fixture not found: ${fixtureId}`);
    return fixture;
  });
}

async function seedFixture(args: {
  repository: SupabaseMemoryGenerationRepository;
  fixture: Fixture;
}): Promise<{ fixtureId: string; memoryItems: MemoryItem[]; createdMemory: boolean; confirmedCount: number }> {
  const { repository, fixture } = args;
  const fixtureSlug = slug(fixture.id);
  const ingestionId = idFor("ing_seed", fixture.id);
  const sourceItemId = idFor("src_seed", fixture.id);
  const sourceVersion = sourceVersionId(fixture.id);
  const extractionRunId = idFor("extr_seed", fixture.id);
  const content = fixture.inputLines.join("\n").trim();
  const evidenceSpans = buildSeedEvidenceSpans(fixture);
  const contentHash = await sha256Hex(content);

  await repository.createTextIngestionWithEvidence({
    tenantId: TENANT_ID,
    ingestionId,
    sourceItemId,
    sourceVersionId: sourceVersion,
    idempotencyKey: `seed:${fixture.id}`,
    appSessionId: "app_session_seed_stable",
    submittedByLabel: SEED_ACTOR,
    content,
    contentHash,
    evidenceSpans,
  });

  let result = await repository.getIngestionResult(ingestionId);
  const expectedMemoryIds = new Set(fixture.expectedMemoryItems.map((item) => memoryItemId(fixture.id, item.id)));
  const existingSeedItems = result.memoryItems.filter((item) => expectedMemoryIds.has(item.id));
  let createdMemory = false;

  if (existingSeedItems.length === 0) {
    await repository.recordExtractionRun({
      id: extractionRunId,
      ingestionId,
      tenantId: TENANT_ID,
      provider: "seed",
      model: "approved-stable-fixtures",
      promptVersion: MEMORY_PROMPT_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      rawResponse: {
        seed: true,
        fixtureId: fixture.id,
        fixtureTitle: fixture.title,
        fixtureCategory: fixture.category,
        expectedMemoryItems: fixture.expectedMemoryItems,
      },
      status: "completed",
    });

    await repository.commitGeneratedMemory({
      ingestionId,
      tenantId: TENANT_ID,
      sourceVersionId: sourceVersion,
      extractionRunId,
      memoryGenerationVersion: `${MEMORY_GENERATION_VERSION}:seed:${fixtureSlug}`,
      items: fixture.expectedMemoryItems.map((item) => ({
        id: memoryItemId(fixture.id, item.id),
        type: item.type,
        statement: item.statement,
        evidenceSpanIds: item.support.map((supportId) => spanId(fixture.id, supportId)),
        epistemicStatus: item.epistemicStatus,
        qualifiers: {
          seed: true,
          fixtureId: fixture.id,
          fixtureTitle: fixture.title,
          fixtureCategory: fixture.category,
          source: "approved Stable v0 fixture",
        },
        stableDomainTags: fixture.stableDomainTags,
      })),
    });
    createdMemory = true;
    result = await repository.getIngestionResult(ingestionId);
  } else if (existingSeedItems.length !== fixture.expectedMemoryItems.length) {
    throw new Error(
      `${fixture.id}: partial seed exists (${existingSeedItems.length}/${fixture.expectedMemoryItems.length}). Resolve manually before reseeding.`,
    );
  }

  let confirmedCount = 0;
  for (const item of result.memoryItems.filter((memoryItem) => expectedMemoryIds.has(memoryItem.id))) {
    if (item.reviewState === "confirmed") continue;
    await repository.applyMemoryItemAction({
      memoryItemId: item.id,
      action: {
        action: "confirm",
        reviewerLabel: SEED_ACTOR,
        rationale: "Seeded from approved Stable v0 fixture data.",
      },
    });
    confirmedCount += 1;
  }

  const finalResult = await repository.getIngestionResult(ingestionId);
  return {
    fixtureId: fixture.id,
    memoryItems: finalResult.memoryItems.filter((memoryItem) => expectedMemoryIds.has(memoryItem.id)),
    createdMemory,
    confirmedCount,
  };
}

function seedBriefs(): SeedBrief[] {
  return [
    {
      id: "brief_seed_payments_reliability_dashboard",
      title: "Merchant payments reliability dashboard gate",
      problem:
        "Stable wants to scale merchant payments messaging, but the current evidence says leadership does not trust the instant-payments claim until reliability metrics are visible and boring for two straight weeks.",
      proposal:
        "Create a daily merchant payments reliability dashboard covering p95 confirmation time, failed transfers, RPC error rate, indexer freshness, and webhook reliability before scaling the merchant campaign.",
      successMetric:
        "Leadership can review the dashboard daily, and the tracked reliability metrics remain acceptable for two consecutive weeks before campaign scale-up.",
      risksAndDependencies:
        "Protocol owns confirmation-time metrics; DevRel owns RPC error reporting; merchant analytics readiness depends on indexer freshness and webhook reliability.",
      memoryItemIds: [
        memoryItemId("stable-mg-001", "m1"),
        memoryItemId("stable-mg-001", "m2"),
        memoryItemId("stable-mg-001", "m3"),
        memoryItemId("stable-mg-010", "m1"),
        memoryItemId("stable-mg-010", "m2"),
        memoryItemId("stable-mg-010", "m3"),
      ],
    },
    {
      id: "brief_seed_gas_waiver_checkout_pilot",
      title: "Gas waiver checkout pilot boundaries",
      problem:
        "Gas waiver is viewed as a major UX unlock for users who only have USDT, but Stable has not settled governance approval, compliance limits, or external wording.",
      proposal:
        "Define a v1 gas waiver pilot limited to merchant checkout and wallet activation, excluding arbitrary DeFi interactions and high-risk corridors until governance and compliance boundaries are approved.",
      successMetric:
        "Pilot scope, waiver-address approval path, excluded categories, and public messaging are documented and accepted before any public gasless launch claim.",
      risksAndDependencies:
        "Requires governance approval for waiver addresses, compliance agreement on excluded corridors/categories, and leadership decision on gasless wording.",
      memoryItemIds: [
        memoryItemId("stable-mg-002", "m1"),
        memoryItemId("stable-mg-002", "m2"),
        memoryItemId("stable-mg-002", "m3"),
      ],
    },
    {
      id: "brief_seed_merchant_partner_readiness",
      title: "Merchant partner readiness pack",
      problem:
        "Merchant and wallet partners are asking for clearer routing, checkout quoting, reconciliation exports, and simple messaging before committing to deeper Stable distribution.",
      proposal:
        "Ship a partner readiness pack with default routing guidance, quote API or SDK helper, reconciliation export requirements, and a simple 'why Stable' explanation that avoids chain jargon.",
      successMetric:
        "At least one wallet partner and one merchant processor can complete integration review without keeping Stable in research mode due to routing, quote, or reconciliation gaps.",
      risksAndDependencies:
        "Custody compliance export has no committed engineering capacity; wallet homepage placement depends on settled routing and messaging; merchant processor support depends on quote support.",
      memoryItemIds: [
        memoryItemId("stable-mg-005", "m1"),
        memoryItemId("stable-mg-005", "m2"),
        memoryItemId("stable-mg-005", "m3"),
        memoryItemId("stable-mg-006", "m1"),
        memoryItemId("stable-mg-006", "m2"),
        memoryItemId("stable-mg-006", "m3"),
        memoryItemId("stable-mg-007", "m1"),
        memoryItemId("stable-mg-007", "m2"),
        memoryItemId("stable-mg-007", "m3"),
      ],
    },
  ];
}

async function maybeCreateBrief(args: {
  repository: SupabaseMemoryGenerationRepository;
  brief: SeedBrief;
}): Promise<"created" | "exists"> {
  const { repository, brief } = args;

  try {
    await repository.getInitiativeBrief(brief.id);
    return "exists";
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) {
      throw error;
    }
  }

  await repository.createInitiativeBrief({
    briefId: brief.id,
    brief: {
      title: brief.title,
      problem: brief.problem,
      proposal: brief.proposal,
      successMetric: brief.successMetric,
      risksAndDependencies: brief.risksAndDependencies,
      memoryItemIds: brief.memoryItemIds,
      createdByLabel: SEED_ACTOR,
    },
  });
  return "created";
}

async function main(): Promise<void> {
  const env = readLocalEnv();
  const repository = new SupabaseMemoryGenerationRepository(
    new SupabaseRpcClient({
      supabaseUrl: requireEnv(env, "SUPABASE_URL"),
      secretKey: requireEnv(env, "SUPABASE_SECRET_KEY"),
    }),
  );

  const fixtures = loadFixtures();
  let createdFixtures = 0;
  let createdMemoryItems = 0;
  let confirmedItems = 0;

  for (const fixture of fixtures) {
    const seeded = await seedFixture({ repository, fixture });
    if (seeded.createdMemory) {
      createdFixtures += 1;
      createdMemoryItems += seeded.memoryItems.length;
    }
    confirmedItems += seeded.confirmedCount;
    console.log(
      `fixture_${fixture.id}=${seeded.createdMemory ? "created" : "exists"} memory_items=${seeded.memoryItems.length} confirmed=${seeded.confirmedCount}`,
    );
  }

  let createdBriefs = 0;
  for (const brief of seedBriefs()) {
    const status = await maybeCreateBrief({ repository, brief });
    if (status === "created") createdBriefs += 1;
    console.log(`brief_${brief.id}=${status}`);
  }

  const activeMemory = await repository.listActiveMemory({ limit: 100 });
  const briefs = await repository.listInitiativeBriefs({ limit: 50 });
  console.log(`seed_fixtures_created=${createdFixtures}`);
  console.log(`seed_memory_items_created=${createdMemoryItems}`);
  console.log(`seed_memory_items_confirmed=${confirmedItems}`);
  console.log(`active_memory_total=${activeMemory.length}`);
  console.log(`initiative_briefs_total=${briefs.length}`);
  console.log("seed=ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
