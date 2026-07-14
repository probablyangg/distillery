import fs from "node:fs";
import { SupabaseRpcClient } from "@distillery/db";
import { OpenRouterEmbeddingModel } from "@distillery/model-gateway";
import type { EmbeddingTargetType } from "@distillery/contracts";

type MissingEmbeddingTarget = {
  targetType: EmbeddingTargetType;
  targetId: string;
  content: string;
};

const localEnv = readLocalEnv();
const tenantId = envValue("TENANT_ID") || "stable";
const embeddingModelName = envValue("EMBEDDING_MODEL") || "google/gemini-embedding-001";
const embeddingDimensions = positiveInteger(envValue("EMBEDDING_DIMENSIONS")) ?? 1536;
const batchSize = positiveInteger(flagValue("--batch-size")) ?? 64;
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY");
  const apiKey = requiredEnv("OPENROUTER_API_KEY");
  const baseUrl = envValue("EMBEDDING_BASE_URL") || envValue("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1";

  const rpcClient = new SupabaseRpcClient({ supabaseUrl, secretKey });
  const targets = await rpcClient.rpc<MissingEmbeddingTarget[]>("distillery_list_missing_memory_embedding_targets", {
    p_tenant_id: tenantId,
    p_embedding_model: embeddingModelName,
    p_limit: batchSize,
  });

  const byType = countBy(targets.map((target) => target.targetType));
  console.log(`tenant=${tenantId}`);
  console.log(`embedding_model=${embeddingModelName}`);
  console.log(`missing_targets=${targets.length}`);
  console.log(`missing_by_type=${JSON.stringify(byType)}`);

  if (dryRun || targets.length === 0) {
    console.log(dryRun ? "dry_run=ok" : "backfill=noop");
    return;
  }

  const embeddingModel = new OpenRouterEmbeddingModel({
    apiKey,
    baseUrl,
    model: embeddingModelName,
    dimensions: embeddingDimensions,
    ...(envValue("EMBEDDING_ENCODING_FORMAT") === "float" ? { encodingFormat: "float" as const } : {}),
    timeoutMs: positiveInteger(envValue("OPENROUTER_TIMEOUT_MS")) ?? 30_000,
  });

  const embeddings: Array<{
    id: string;
    targetType: EmbeddingTargetType;
    targetId: string;
    embeddingModel: string;
    embedding: number[];
    contentHash: string;
  }> = [];

  for (const targetType of ["claim", "evidence_span", "entity", "schema_pattern"] as const) {
    const typedTargets = targets.filter((target) => target.targetType === targetType);
    if (typedTargets.length === 0) continue;
    const response = await embeddingModel.embed({
      targetType,
      input: typedTargets.map((target) => target.content),
    });
    for (const [index, vector] of response.vectors.entries()) {
      const target = typedTargets[index];
      if (!target) continue;
      embeddings.push({
        id: `emb_${globalThis.crypto.randomUUID()}`,
        targetType,
        targetId: target.targetId,
        embeddingModel: response.model,
        embedding: vector,
        contentHash: await sha256Hex(target.content),
      });
    }
  }

  await rpcClient.rpc("distillery_upsert_memory_embeddings", {
    p_tenant_id: tenantId,
    p_embeddings: embeddings,
  });

  console.log(`embeddings_upserted=${embeddings.length}`);
  console.log(`upserted_by_type=${JSON.stringify(countBy(embeddings.map((embedding) => embedding.targetType)))}`);
  console.log("backfill=ok");
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function envValue(name: string): string | undefined {
  return localEnv[name] ?? process.env[name]?.trim();
}

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};

  const envText = fs.readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};

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

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
