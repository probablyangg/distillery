import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "@distillery/db";
import { OpenRouterMemoryGenerationModel } from "@distillery/model-gateway";
import { runMemoryGenerationWorkflow, submitTextCapture } from "@distillery/memory-generation";

type LocalEnv = Record<string, string>;

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
  const value = process.env[key] ?? env[key];
  if (!value) throw new Error(`${key} is required for live v0 smoke.`);
  return value;
}

async function main(): Promise<void> {
  const env = readLocalEnv();
  const repository = new SupabaseMemoryGenerationRepository(
    new SupabaseRpcClient({
      supabaseUrl: requireEnv(env, "SUPABASE_URL"),
      secretKey: requireEnv(env, "SUPABASE_SECRET_KEY"),
    }),
  );
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

  const nonce = Date.now().toString(36);
  const ids: Record<string, string[]> = {};
  const newId = (prefix: string) => {
    const next = `${prefix}_live_e2e_${nonce}_${(ids[prefix]?.length ?? 0) + 1}`;
    ids[prefix] = [...(ids[prefix] ?? []), next];
    return next;
  };

  let smokeResult: unknown = null;
  try {
    const receipt = await submitTextCapture({
      repository,
      newId,
      command: {
        mode: "remember",
        text: [
          "Stable leadership reported that checkout public launch depends on relayer reliability review.",
          "The approval metric is seven consecutive days above the internal relayer success-rate threshold.",
        ].join("\n"),
        idempotencyKey: `live-e2e-${nonce}`,
        appSessionId: `sess_live_e2e_${nonce}`,
        submittedByLabel: "live e2e smoke",
      },
    });

    const startedAt = Date.now();
    const generated = await runMemoryGenerationWorkflow({
      ingestionId: receipt.ingestionId,
      repository,
      model,
      newId,
    });

    if (generated.status !== "ready") {
      throw new Error(`live memory generation failed: ${generated.errorMessage ?? generated.status}`);
    }

    if (generated.memoryItems.length === 0) {
      throw new Error("live model produced no memory items");
    }

    const briefId = newId("brief");
    const brief = await repository.createInitiativeBrief({
      briefId,
      brief: {
        title: "Checkout relayer reliability launch gate",
        problem: "Stable should not publicly launch checkout until relayer reliability has been reviewed.",
        proposal: "Use relayer reliability review and seven-day success-rate performance as the v0 launch gate.",
        successMetric: "Seven consecutive days above the internal relayer success-rate threshold.",
        risksAndDependencies: "Depends on protocol review and GTM discipline around launch messaging.",
        memoryItemIds: generated.memoryItems.map((item) => item.id),
        createdByLabel: "live e2e smoke",
      },
    });
    const approved = await repository.recordInitiativeBriefDecision({
      briefId: brief.id,
      decisionId: newId("bdec"),
      decision: {
        decision: "approve",
        reviewerLabel: "live e2e smoke",
        rationale: "Smoke-test approval verifies live v0 path.",
      },
    });

    smokeResult = {
      live_e2e_smoke: "ok",
      ingestionId: receipt.ingestionId,
      memoryItems: generated.memoryItems.length,
      evidenceSpans: approved.evidenceSpanIds.length,
      briefStatus: approved.status,
      ms: Date.now() - startedAt,
    };
  } finally {
    cleanupSmokeRows(env, nonce);
  }

  console.log(JSON.stringify(smokeResult));
}

function cleanupSmokeRows(env: LocalEnv, nonce: string): void {
  const databaseDirectUrl = requireEnv(env, "DATABASE_DIRECT_URL");
  const cleanupSql = `
    delete from initiative_briefs where id like $$brief_live_e2e_${nonce}_%$$;
    delete from proposed_events where payload->>$$ingestionId$$ like $$ing_live_e2e_${nonce}_%$$;
    delete from policy_runs where work_item_id in (
      select id from pending_work where subject_id like $$srcv_live_e2e_${nonce}_%$$
    );
    delete from pending_work where subject_id like $$srcv_live_e2e_${nonce}_%$$;
    delete from event_outbox where ledger_event_id in (
      select id from ledger_events where payload->>$$ingestionId$$ like $$ing_live_e2e_${nonce}_%$$
    );
    delete from ledger_events where payload->>$$ingestionId$$ like $$ing_live_e2e_${nonce}_%$$;
    delete from memory_item_events where memory_item_id like $$mem_live_e2e_${nonce}_%$$;
    delete from outbox_events where payload->>$$ingestionId$$ like $$ing_live_e2e_${nonce}_%$$;
    delete from memory_item_evidence where memory_item_id like $$mem_live_e2e_${nonce}_%$$;
    delete from memory_items where id like $$mem_live_e2e_${nonce}_%$$;
    delete from extraction_runs where id like $$extr_live_e2e_${nonce}_%$$;
    delete from evidence_spans where id like $$evspan_live_e2e_${nonce}_%$$;
    delete from source_versions where id like $$srcv_live_e2e_${nonce}_%$$;
    delete from source_items where id like $$src_live_e2e_${nonce}_%$$;
    delete from ingestions where id like $$ing_live_e2e_${nonce}_%$$;
    delete from app_sessions where id = $$sess_live_e2e_${nonce}$$;
  `;
  const cleanup = spawnSync("psql", [databaseDirectUrl, "--set", "ON_ERROR_STOP=1", "-c", cleanupSql], {
    stdio: "pipe",
  });

  if (cleanup.status !== 0) {
    process.stderr.write(cleanup.stderr.toString());
    process.exitCode = cleanup.status ?? 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
