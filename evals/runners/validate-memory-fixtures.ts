import fs from "node:fs";
import { z } from "zod";
import { EPISTEMIC_STATUSES, MEMORY_TYPES } from "@distillery/contracts";

const FixtureFileSchema = z.object({
  version: z.string(),
  system: z.literal("memory-generation"),
  company: z.literal("Stable"),
  inputModality: z.literal("text_braindump_only"),
  fixtures: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      title: z.string(),
      mode: z.literal("remember"),
      stableDomainTags: z.array(z.string()),
      inputLines: z.array(z.string()).min(1),
      expectedSpans: z.array(
        z.object({
          id: z.string(),
          lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
        }),
      ),
      expectedMemoryItems: z.array(
        z.object({
          id: z.string(),
          type: z.enum(MEMORY_TYPES),
          statement: z.string().min(1),
          support: z.array(z.string()).min(1),
          epistemicStatus: z.enum(EPISTEMIC_STATUSES),
        }),
      ),
      expectedConflicts: z.array(
        z.object({
          type: z.string(),
          description: z.string(),
          support: z.array(z.string()),
        }),
      ),
      negativeExpectations: z.array(z.string()),
    }),
  ),
});

const path = "evals/fixtures/memory-generation/labeled-fixtures.v0.json";
const parsed = FixtureFileSchema.parse(JSON.parse(fs.readFileSync(path, "utf8")));
const errors: string[] = [];
const fixtureIds = new Set<string>();

for (const fixture of parsed.fixtures) {
  if (fixtureIds.has(fixture.id)) errors.push(`duplicate fixture id ${fixture.id}`);
  fixtureIds.add(fixture.id);

  const spanIds = new Set<string>();
  for (const span of fixture.expectedSpans) {
    if (spanIds.has(span.id)) errors.push(`${fixture.id}: duplicate span ${span.id}`);
    spanIds.add(span.id);

    const [start, end] = span.lines;
    if (end < start || end > fixture.inputLines.length) {
      errors.push(`${fixture.id}:${span.id}: invalid line range ${span.lines.join("-")}`);
    }
  }

  const itemIds = new Set<string>();
  for (const item of fixture.expectedMemoryItems) {
    if (itemIds.has(item.id)) errors.push(`${fixture.id}: duplicate memory item ${item.id}`);
    itemIds.add(item.id);

    for (const support of item.support) {
      if (!spanIds.has(support)) errors.push(`${fixture.id}:${item.id}: missing support ${support}`);
    }
  }

  for (const conflict of fixture.expectedConflicts) {
    for (const support of conflict.support) {
      if (!spanIds.has(support)) errors.push(`${fixture.id}:conflict:${conflict.type}: missing support ${support}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`fixtures=ok count=${parsed.fixtures.length} version=${parsed.version}`);

