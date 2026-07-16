import fs from "node:fs";
import { SupabaseRpcClient } from "@distillery/db";

const localEnv = readLocalEnv();

async function main(): Promise<void> {
  const rpc = new SupabaseRpcClient({
    supabaseUrl: requiredEnv("SUPABASE_URL"),
    secretKey: requiredEnv("SUPABASE_SECRET_KEY"),
  });
  const [briefs, connectorWork, extractionComplete, reactionWork] = await Promise.all([
    rpc.rpc<unknown[]>("distillery_list_leadership_briefs", {
      p_tenant_id: "stable",
      p_limit: 1,
    }),
    rpc.rpc<unknown[]>("distillery_list_pending_connector_work", {
      p_tenant_id: "stable",
      p_limit: 1,
    }),
    rpc.rpc<boolean>("distillery_is_slack_connector_extraction_complete", {
      p_save_id: "csave_schema_probe_not_found",
    }),
    rpc.rpc<unknown[]>("distillery_list_slack_reaction_work_for_completed_work", {
      p_work_item_id: "work_schema_probe_not_found",
    }),
  ]);
  if (!Array.isArray(briefs) || !Array.isArray(connectorWork) || extractionComplete !== false || !Array.isArray(reactionWork)) {
    throw new Error("Pilot schema verification returned an unexpected response shape.");
  }
  console.log("migration_0018=ok");
  console.log("migration_0019=ok");
  console.log(`generated_brief_projection=ok (sample_count=${briefs.length})`);
  console.log(`connector_recovery_projection=ok (sample_count=${connectorWork.length})`);
}

function requiredEnv(name: string): string {
  const value = localEnv[name] ?? process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
