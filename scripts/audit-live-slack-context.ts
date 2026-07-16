import fs from "node:fs";
import { spawnSync } from "node:child_process";

const env = readLocalEnv();
const databaseUrl = env.DATABASE_DIRECT_URL ?? process.env.DATABASE_DIRECT_URL?.trim();
if (!databaseUrl) throw new Error("Missing DATABASE_DIRECT_URL.");
const channelId = requiredFlag("--channel");
const messageTimestamp = requiredFlag("--message-ts");
if (!/^[CG][A-Z0-9]+$/u.test(channelId)) throw new Error("--channel must be a Slack channel ID.");
if (!/^\d+\.\d+$/u.test(messageTimestamp)) throw new Error("--message-ts must be a Slack timestamp.");

const sql = `
with target_bundle as (
  select bundle.* from slack_context_bundles bundle
  join connector_saves save on save.current_context_bundle_id = bundle.id
  where save.tenant_id = 'stable' and save.provider = 'slack'
    and save.channel_id = '${channelId}' and save.message_timestamp = '${messageTimestamp}'
), bundle_items as (
  select item.*, source.external_id, version.content, version.source_metadata
  from slack_context_bundle_items item
  join target_bundle bundle on bundle.id = item.bundle_id
  join source_items source on source.id = item.source_item_id
  join source_versions version on version.id = item.source_version_id
), bundle_spans as (
  select span.*, item.role, item.ordinal, item.source_metadata
  from evidence_spans span join bundle_items item on item.source_version_id = span.source_version_id
), bundle_memory as (
  select distinct memory.* from memory_items memory
  join memory_item_evidence binding on binding.memory_item_id = memory.id
  join bundle_spans span on span.id = binding.evidence_span_id
)
select jsonb_build_object(
  'bundle', (select jsonb_build_object(
    'id', id, 'version', version, 'previousBundleId', previous_bundle_id,
    'selectionStrategy', selection_strategy, 'classification', classification,
    'channelProfile', channel_profile, 'truncation', truncation,
    'externallyShared', externally_shared, 'skippedAttachments', skipped_attachments
  ) from target_bundle),
  'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'ordinal', item.ordinal, 'role', item.role, 'primary', item.is_primary,
      'externalId', item.external_id,
      'authorId', item.source_metadata->>'authorId',
      'authorLabel', item.source_metadata->>'authorLabel',
      'occurredAt', item.source_metadata->>'occurredAt',
      'messageTimestamp', item.source_metadata->>'messageTimestamp',
      'threadTimestamp', item.source_metadata->>'threadTimestamp',
      'edited', item.source_metadata->'edited',
      'permalink', item.source_metadata->>'permalink',
      'text', item.content
    ) order by item.ordinal)
    from bundle_items item where item.role <> 'channel_profile'
  ), '[]'::jsonb),
  'memory', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', memory.id, 'claimType', memory.claim_type, 'statement', memory.statement,
      'epistemicStatus', memory.epistemic_status, 'qualifiers', memory.qualifiers,
      'evidence', coalesce((
        select jsonb_agg(jsonb_build_object(
          'evidenceSpanId', span.id, 'role', span.role,
          'messageTimestamp', span.source_metadata->>'messageTimestamp',
          'permalink', span.locator->>'permalink', 'exactText', span.text
        ) order by span.ordinal, span.start_char)
        from memory_item_evidence binding join bundle_spans span on span.id = binding.evidence_span_id
        where binding.memory_item_id = memory.id
      ), '[]'::jsonb)
    ) order by memory.created_at, memory.id)
    from bundle_memory memory
  ), '[]'::jsonb)
);
`;
const result = spawnSync("psql", [
  "--dbname", databaseUrl, "--tuples-only", "--no-align",
  "--set", "ON_ERROR_STOP=1", "--command", sql,
], { encoding: "utf8" });
if (result.status !== 0) throw new Error(`Live context audit failed: ${(result.stderr || result.stdout).trim()}`);
console.log(JSON.stringify(JSON.parse(result.stdout.trim()), null, 2));

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`Missing required flag: ${name}`);
  return value;
}

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
