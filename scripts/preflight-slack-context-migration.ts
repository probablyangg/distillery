import fs from "node:fs";
import { spawnSync } from "node:child_process";

const databaseUrl = readLocalEnv().DATABASE_DIRECT_URL ?? process.env.DATABASE_DIRECT_URL?.trim();
if (!databaseUrl) throw new Error("Missing DATABASE_DIRECT_URL.");

const sql = `
select jsonb_build_object(
  'contextMigrationApplied', to_regclass('public.slack_context_bundles') is not null
    and to_regprocedure('distillery_commit_slack_context_bundle(jsonb)') is not null,
  'unchangedRefreshReactionSyncApplied', case
    when to_regprocedure('distillery_ensure_slack_reaction_sync_for_work(text)') is null then false
    else position(
      '''slack-extraction-complete:'' || save_row.id || '':'' || save_row.current_context_bundle_id || '':'' || completed_work.id'
      in pg_get_functiondef(to_regprocedure('distillery_ensure_slack_reaction_sync_for_work(text)'))
    ) > 0
  end,
  'reactionLifecycleApplied', to_regprocedure('distillery_is_slack_connector_extraction_complete(text)') is not null,
  'duplicateSourceVersionHashes', (
    select count(*) from (
      select source_item_id, content_hash from source_versions
      group by source_item_id, content_hash having count(*) > 1
    ) duplicates
  ),
  'duplicateConnectorMessages', (
    select count(*) from (
      select tenant_id, provider, workspace_id, channel_id, message_timestamp
      from connector_saves group by tenant_id, provider, workspace_id, channel_id, message_timestamp
      having count(*) > 1
    ) duplicates
  ),
  'existingSlackSaveCount', (select count(*) from connector_saves where provider = 'slack'),
  'existingSlackSourceVersionCount', (
    select count(*) from source_versions version join source_items item on item.id = version.source_item_id
    where item.source_type like 'slack_%'
  )
);
`;
const result = spawnSync("psql", [
  "--dbname", databaseUrl,
  "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql,
], { encoding: "utf8" });
if (result.status !== 0) throw new Error(`Migration preflight failed: ${(result.stderr || result.stdout).trim()}`);
const snapshot = JSON.parse(result.stdout.trim()) as {
  contextMigrationApplied: boolean;
  unchangedRefreshReactionSyncApplied: boolean;
  reactionLifecycleApplied: boolean;
  duplicateSourceVersionHashes: number;
  duplicateConnectorMessages: number;
  existingSlackSaveCount: number;
  existingSlackSourceVersionCount: number;
};
if (!snapshot.reactionLifecycleApplied) throw new Error("Migration 0019 is not applied; apply missing migrations in filename order.");
if (snapshot.duplicateSourceVersionHashes > 0 || snapshot.duplicateConnectorMessages > 0) {
  throw new Error("Migration 0020 unique-index preflight found duplicate canonical rows; inspect them before applying the migration.");
}
console.log(JSON.stringify(snapshot, null, 2));
console.log("slack_context_migration_preflight=ok");

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
