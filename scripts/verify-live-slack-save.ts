import fs from "node:fs";
import { spawnSync } from "node:child_process";

const env = readLocalEnv();
const databaseUrl = env.DATABASE_DIRECT_URL ?? process.env.DATABASE_DIRECT_URL?.trim();
if (!databaseUrl) throw new Error("Missing DATABASE_DIRECT_URL.");

const teamId = requiredFlag("--team");
const channelId = requiredFlag("--channel");
const messageTimestamp = requiredFlag("--message-ts");
const expectedAttachments = Number(flagValue("--expected-attachments") ?? "0");
const expectedPdfSources = Number(flagValue("--expected-pdf-sources") ?? "0");
const expectedDocxSources = Number(flagValue("--expected-docx-sources") ?? "0");

if (!/^T[A-Z0-9]+$/u.test(teamId)) throw new Error("--team must be a Slack team ID.");
if (!/^[CG][A-Z0-9]+$/u.test(channelId)) throw new Error("--channel must be a Slack channel ID.");
if (!/^\d+\.\d+$/u.test(messageTimestamp)) throw new Error("--message-ts must be a Slack timestamp.");
if (!Number.isSafeInteger(expectedAttachments) || expectedAttachments < 0) {
  throw new Error("--expected-attachments must be a non-negative integer.");
}
if (!Number.isSafeInteger(expectedPdfSources) || expectedPdfSources < 0) {
  throw new Error("--expected-pdf-sources must be a non-negative integer.");
}
if (!Number.isSafeInteger(expectedDocxSources) || expectedDocxSources < 0) {
  throw new Error("--expected-docx-sources must be a non-negative integer.");
}
if (expectedPdfSources + expectedDocxSources !== expectedAttachments) {
  throw new Error("Expected PDF and DOCX source counts must add up to --expected-attachments.");
}

const externalSourceId = `slack:${teamId}:${channelId}:${messageTimestamp}`;
const sql = `
with target_save as (
  select * from connector_saves
  where tenant_id = 'stable'
    and provider = 'slack'
    and external_source_id = '${externalSourceId}'
), source_ids as (
  select message_source_id as id from target_save where message_source_id is not null
  union all
  select value as id
  from target_save cross join lateral jsonb_array_elements_text(attachment_source_ids)
), version_ids as (
  select sv.id
  from source_versions sv join source_ids si on si.id = sv.source_item_id
)
select jsonb_build_object(
  'saveCount', (select count(*) from target_save),
  'saveId', (select id from target_save limit 1),
  'workItemId', (select work_item_id from target_save limit 1),
  'status', (select status from target_save limit 1),
  'reactionStatus', (select reaction_status from target_save limit 1),
  'retryCount', (select retry_count from target_save limit 1),
  'reactionRetryCount', (select reaction_retry_count from target_save limit 1),
  'sourceCount', (select count(*) from source_items s join source_ids si on si.id = s.id),
  'pdfSourceCount', (
    select count(*) from source_items s join source_ids si on si.id = s.id
    where s.source_type = 'slack_file_pdf'
  ),
  'docxSourceCount', (
    select count(*) from source_items s join source_ids si on si.id = s.id
    where s.source_type = 'slack_file_docx'
  ),
  'sourceVersionCount', (select count(*) from version_ids),
  'evidenceSpanCount', (
    select count(*) from evidence_spans es join version_ids vi on vi.id = es.source_version_id
  ),
  'pdfEvidenceCount', (
    select count(*)
    from evidence_spans es
    join source_versions sv on sv.id = es.source_version_id
    join source_items si on si.id = sv.source_item_id
    join source_ids selected on selected.id = si.id
    where si.source_type = 'slack_file_pdf'
  ),
  'pdfPageLocatedCount', (
    select count(*)
    from evidence_spans es
    join source_versions sv on sv.id = es.source_version_id
    join source_items si on si.id = sv.source_item_id
    join source_ids selected on selected.id = si.id
    where si.source_type = 'slack_file_pdf'
      and (es.locator->>'pageNumber')::integer >= 1
      and (es.locator->>'startChar')::integer >= 0
      and (es.locator->>'endChar')::integer > (es.locator->>'startChar')::integer
  ),
  'docxEvidenceCount', (
    select count(*)
    from evidence_spans es
    join source_versions sv on sv.id = es.source_version_id
    join source_items si on si.id = sv.source_item_id
    join source_ids selected on selected.id = si.id
    where si.source_type = 'slack_file_docx'
  ),
  'docxParagraphLocatedCount', (
    select count(*)
    from evidence_spans es
    join source_versions sv on sv.id = es.source_version_id
    join source_items si on si.id = sv.source_item_id
    join source_ids selected on selected.id = si.id
    where si.source_type = 'slack_file_docx'
      and (es.locator->>'paragraphNumber')::integer >= 1
      and (es.locator->>'blockNumber')::integer >= 1
      and (es.locator->>'startChar')::integer >= 0
      and (es.locator->>'endChar')::integer > (es.locator->>'startChar')::integer
  ),
  'sourceCommittedEventCount', (
    select count(*) from ledger_events le join version_ids vi on vi.id = le.subject_id
    where le.event_type = 'source_committed'
  ),
  'ingestionWorkCount', (
    select count(*) from pending_work pw join target_save ts on ts.id = pw.subject_id
    where pw.policy = 'ingest_slack_source'
  ),
  'ingestionWorkStatus', (
    select pw.status from pending_work pw join target_save ts on ts.id = pw.subject_id
    where pw.policy = 'ingest_slack_source' limit 1
  ),
  'extractionWorkCount', (
    select count(*) from pending_work pw join version_ids vi on vi.id = pw.subject_id
    where pw.policy = 'extract_memory'
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
  throw new Error(`Live Slack save query failed: ${(result.stderr || result.stdout).trim()}`);
}

const snapshot = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
if (process.argv.includes("--report-only")) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}
const expectedSources = expectedAttachments + 1;
assertEqual(snapshot, "saveCount", 1);
assertEqual(snapshot, "status", "completed");
assertEqual(snapshot, "reactionStatus", "added");
assertEqual(snapshot, "sourceCount", expectedSources);
assertEqual(snapshot, "pdfSourceCount", expectedPdfSources);
assertEqual(snapshot, "docxSourceCount", expectedDocxSources);
assertEqual(snapshot, "sourceVersionCount", expectedSources);
assertAtLeast(snapshot, "evidenceSpanCount", expectedSources);
assertEqual(snapshot, "pdfPageLocatedCount", snapshot.pdfEvidenceCount);
assertEqual(snapshot, "docxParagraphLocatedCount", snapshot.docxEvidenceCount);
assertEqual(snapshot, "sourceCommittedEventCount", expectedSources);
assertAtLeast(snapshot, "ingestionWorkCount", 1);
assertEqual(snapshot, "extractionWorkCount", expectedSources);

console.log(`save=ok (${String(snapshot.saveId)})`);
console.log(`canonical_sources=ok (${expectedSources})`);
console.log(`source_versions=ok (${expectedSources})`);
console.log(`evidence_spans=ok (${String(snapshot.evidenceSpanCount)})`);
if (expectedPdfSources > 0) console.log(`pdf_page_locators=ok (${String(snapshot.pdfPageLocatedCount)})`);
if (expectedDocxSources > 0) console.log(`docx_paragraph_locators=ok (${String(snapshot.docxParagraphLocatedCount)})`);
console.log(`source_committed_events=ok (${expectedSources})`);
console.log(`extraction_work=ok (${expectedSources})`);
console.log("reaction=ok (:hourglass_flowing_sand: replaced by :factory: after extraction completed)");
console.log("live_slack_save=ok");

function requiredFlag(name: string): string {
  const value = flagValue(name);
  if (!value) throw new Error(`Missing required flag: ${name}`);
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
