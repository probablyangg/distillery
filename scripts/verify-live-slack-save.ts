import fs from "node:fs";
import { spawnSync } from "node:child_process";

const env = readLocalEnv();
const databaseUrl = env.DATABASE_DIRECT_URL ?? process.env.DATABASE_DIRECT_URL?.trim();
if (!databaseUrl) throw new Error("Missing DATABASE_DIRECT_URL.");

const teamId = flagValue("--team");
const channelId = requiredFlag("--channel");
const messageTimestamp = flagValue("--message-ts");
const useLatest = process.argv.includes("--latest");
const minimumMessages = integerFlag("--minimum-messages", 1);
const expectedSupportedAttachments = integerFlag("--expected-supported-attachments", 0);
const expectedSkippedAttachments = integerFlag("--expected-skipped-attachments", 0);
const expectedContextVersion = integerFlag("--expected-context-version", 1);
const expectExternal = process.argv.includes("--expect-external");

if (teamId && !/^T[A-Z0-9]+$/u.test(teamId)) throw new Error("--team must be a Slack team ID.");
if (!/^[CG][A-Z0-9]+$/u.test(channelId)) throw new Error("--channel must be a Slack channel ID.");
if (!messageTimestamp && !useLatest) throw new Error("Provide --message-ts or --latest.");
if (messageTimestamp && !/^\d+\.\d+$/u.test(messageTimestamp)) throw new Error("--message-ts must be a Slack timestamp.");

const sql = `
with target_save as (
  select * from connector_saves
  where tenant_id = 'stable' and provider = 'slack'
    ${teamId ? `and workspace_id = '${teamId}'` : ""}
    and channel_id = '${channelId}'
    ${messageTimestamp ? `and message_timestamp = '${messageTimestamp}'` : ""}
  order by updated_at desc
  limit 1
), target_bundle as (
  select bundle.* from slack_context_bundles bundle
  join target_save save on save.current_context_bundle_id = bundle.id
), bundle_items as (
  select item.*, source.source_type, source.external_id, version.source_metadata
  from slack_context_bundle_items item
  join target_bundle bundle on bundle.id = item.bundle_id
  join source_items source on source.id = item.source_item_id
  join source_versions version on version.id = item.source_version_id
), bundle_versions as (
  select distinct source_version_id as id from bundle_items
), bundle_spans as (
  select span.* from evidence_spans span join bundle_versions version on version.id = span.source_version_id
)
select jsonb_build_object(
  'saveCount', (select count(*) from target_save),
  'saveId', (select id from target_save limit 1),
  'messageTimestamp', (select message_timestamp from target_save limit 1),
  'createdAt', (select created_at from target_save limit 1),
  'updatedAt', (select updated_at from target_save limit 1),
  'workItemId', (select work_item_id from target_save limit 1),
  'status', (select status from target_save limit 1),
  'lastError', (select last_error from target_save limit 1),
  'reactionStatus', (select reaction_status from target_save limit 1),
  'contextVersion', (select context_version from target_save limit 1),
  'bundleId', (select id from target_bundle limit 1),
  'previousBundleId', (select previous_bundle_id from target_bundle limit 1),
  'externallyShared', (select externally_shared from target_bundle limit 1),
  'selectionStrategy', (select selection_strategy from target_bundle limit 1),
  'classification', (select classification->>'category' from target_bundle limit 1),
  'truncated', (select (truncation->>'truncated')::boolean from target_bundle limit 1),
  'skippedAttachmentCount', (select jsonb_array_length(skipped_attachments) from target_bundle limit 1),
  'itemCount', (select count(*) from bundle_items),
  'messageCount', (select count(*) from bundle_items where source_type = 'slack_message'),
  'channelProfileCount', (select count(*) from bundle_items where role = 'channel_profile'),
  'selectedMessageCount', (select count(*) from bundle_items where role = 'selected_message' and is_primary),
  'threadRootCount', (select count(*) from bundle_items where role = 'thread_root'),
  'threadReplyCount', (select count(*) from bundle_items where role = 'thread_reply'),
  'nearbyContextCount', (select count(*) from bundle_items where role = 'nearby_context'),
  'supportedAttachmentCount', (select count(*) from bundle_items where role = 'supported_attachment'),
  'sourceVersionCount', (select count(*) from bundle_versions),
  'evidenceSpanCount', (select count(*) from bundle_spans),
  'messagePermalinkEvidenceCount', (
    select count(*) from bundle_spans span
    join bundle_items item on item.source_version_id = span.source_version_id
    where item.source_type = 'slack_message' and span.locator->>'permalink' like 'https://%.slack.com/%'
  ),
  'contextEventCount', (
    select count(*) from ledger_events event
    join slack_context_bundles bundle on bundle.id = event.subject_id
    join target_save save on save.id = bundle.connector_save_id
    where event.event_type = 'slack_context_committed'
  ),
  'ingestionWorkCount', (
    select count(*) from pending_work work join target_save save on save.id = work.subject_id
    where work.policy = 'ingest_slack_source'
  ),
  'reactionSyncWorkCount', (
    select count(*) from pending_work work join target_save save on save.id = work.subject_id
    where work.policy = 'sync_slack_reaction'
  ),
  'reactionCompletionEventCount', (
    select count(*) from ledger_events event join target_save save on save.id = event.subject_id
    where event.event_type = 'slack_extraction_completed'
  ),
  'latestReactionWorkStatus', (
    select work.status from pending_work work join target_save save on save.id = work.subject_id
    where work.policy = 'sync_slack_reaction' order by work.created_at desc limit 1
  ),
  'currentExtractionWorkCount', (
    select count(*) from pending_work work join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context'
  ),
  'currentExtractionStatus', (
    select work.status from pending_work work join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by work.created_at desc limit 1
  ),
  'currentExtractionAttempts', (
    select work.attempts from pending_work work join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by work.created_at desc limit 1
  ),
  'currentExtractionLastError', (
    select work.last_error from pending_work work join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by work.created_at desc limit 1
  ),
  'currentExtractionLeaseExpiresAt', (
    select work.lease_expires_at from pending_work work join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by work.created_at desc limit 1
  ),
  'currentPolicyRunStatus', (
    select run.status from policy_runs run
    join pending_work work on work.id = run.work_item_id
    join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by run.created_at desc limit 1
  ),
  'currentPolicyRunProvider', (
    select run.provider from policy_runs run
    join pending_work work on work.id = run.work_item_id
    join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by run.created_at desc limit 1
  ),
  'currentPolicyRunModel', (
    select run.model from policy_runs run
    join pending_work work on work.id = run.work_item_id
    join target_bundle bundle on bundle.id = work.subject_id
    where work.policy = 'extract_slack_context' order by run.created_at desc limit 1
  ),
  'contextOutboxStatus', (
    select outbox.status from event_outbox outbox
    join ledger_events event on event.id = outbox.ledger_event_id
    join target_bundle bundle on bundle.id = event.subject_id
    where event.event_type = 'slack_context_committed' order by outbox.created_at desc limit 1
  ),
  'currentMemoryCount', (
    select count(distinct binding.memory_item_id)
    from memory_item_evidence binding join bundle_spans span on span.id = binding.evidence_span_id
  )
);
`;

const result = spawnSync("psql", [
  "--dbname", databaseUrl,
  "--tuples-only",
  "--no-align",
  "--set", "ON_ERROR_STOP=1",
  "--command", sql,
], { encoding: "utf8" });

if (result.status !== 0) {
  throw new Error(`Live Slack context query failed: ${(result.stderr || result.stdout).trim()}`);
}

const snapshot = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
if (process.argv.includes("--report-only")) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

assertEqual(snapshot, "saveCount", 1);
assertEqual(snapshot, "status", "completed");
assertEqual(snapshot, "reactionStatus", "added");
assertEqual(snapshot, "contextVersion", expectedContextVersion);
assertEqual(snapshot, "externallyShared", expectExternal);
assertEqual(snapshot, "channelProfileCount", 1);
assertEqual(snapshot, "selectedMessageCount", 1);
assertAtLeast(snapshot, "messageCount", minimumMessages);
assertEqual(snapshot, "supportedAttachmentCount", expectedSupportedAttachments);
assertEqual(snapshot, "skippedAttachmentCount", expectedSkippedAttachments);
assertAtLeast(snapshot, "sourceVersionCount", minimumMessages + 1 + expectedSupportedAttachments);
assertAtLeast(snapshot, "evidenceSpanCount", minimumMessages);
assertAtLeast(snapshot, "messagePermalinkEvidenceCount", minimumMessages);
assertEqual(snapshot, "contextEventCount", expectedContextVersion);
assertAtLeast(snapshot, "ingestionWorkCount", expectedContextVersion);
assertEqual(snapshot, "currentExtractionWorkCount", 1);
assertEqual(snapshot, "currentExtractionStatus", "completed");

console.log(`save=ok (${String(snapshot.saveId)})`);
console.log(`context_bundle=ok (${String(snapshot.bundleId)}, version=${String(snapshot.contextVersion)})`);
console.log(`roles=ok (messages=${String(snapshot.messageCount)}, strategy=${String(snapshot.selectionStrategy)})`);
console.log(`source_versions=ok (${String(snapshot.sourceVersionCount)})`);
console.log(`evidence_spans=ok (${String(snapshot.evidenceSpanCount)})`);
console.log(`classification=ok (${String(snapshot.classification)})`);
console.log(`attachments=ok (supported=${String(snapshot.supportedAttachmentCount)}, skipped=${String(snapshot.skippedAttachmentCount)})`);
console.log(`extraction=ok (memory=${String(snapshot.currentMemoryCount)})`);
console.log("reaction=ok (:hourglass_flowing_sand: replaced by :factory: after context extraction completed)");
console.log("live_slack_context=ok");

function requiredFlag(name: string): string {
  const value = flagValue(name);
  if (!value) throw new Error(`Missing required flag: ${name}`);
  return value;
}

function integerFlag(name: string, fallback: number): number {
  const value = Number(flagValue(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function assertEqual(snapshot: Record<string, unknown>, key: string, expected: unknown): void {
  if (snapshot[key] !== expected) {
    throw new Error(`${key} expected ${String(expected)}, received ${String(snapshot[key])}.`);
  }
}

function assertAtLeast(snapshot: Record<string, unknown>, key: string, expected: number): void {
  const actual = Number(snapshot[key]);
  if (!Number.isFinite(actual) || actual < expected) {
    throw new Error(`${key} expected at least ${expected}, received ${String(snapshot[key])}.`);
  }
}

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}
