import fs from "node:fs";
import { execFile, spawnSync } from "node:child_process";

const container = `distillery-slack-db-test-${process.pid}`;
const image = "pgvector/pgvector:pg16";
const workspaceId = "T12345678";
const channelId = "C12345678";

async function main(): Promise<void> {
  requireCommand("docker", ["version"]);
  const started = run("docker", [
    "run", "--detach", "--rm", "--name", container,
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    image,
  ]);
  if (!started.trim()) throw new Error("Disposable PostgreSQL container did not start.");

  try {
    await waitForPostgres();
    const migrations = fs.readdirSync("packages/db/migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const contextMigration = "0020_context_aware_slack_ingestion.sql";
    const contextMigrationIndex = migrations.indexOf(contextMigration);
    if (contextMigrationIndex < 0) throw new Error(`Missing ${contextMigration}.`);
    for (const migration of migrations.slice(0, contextMigrationIndex)) applyMigration(migration);

    // Prove that migration 0020 upgrades an existing pilot database without rewriting history.
    const legacy = JSON.parse(psql(
      `select distillery_create_or_get_slack_save('stable', repeat('0', 64), '${workspaceId}', '${channelId}', '1752623999.000001', null, 'U12345678', null, 'slack:${workspaceId}:${channelId}:1752623999.000001')`,
    )) as Registration;
    const legacySaveId = saveId(legacy);
    psql(`select distillery_commit_slack_connector_sources('${legacySaveId}', '${sqlLiteral(JSON.stringify([
      source({
        prefix: "legacy",
        sourceType: "slack_message",
        externalId: `slack:${workspaceId}:${channelId}:1752623999.000001`,
        content: "Legacy pilot evidence remains immutable.",
        contentHash: "1".repeat(64),
        timestamp: "1752623999.000001",
      }),
    ]))}'::jsonb)`);
    applyMigration(contextMigration);
    for (const migration of migrations.slice(contextMigrationIndex + 1)) applyMigration(migration);
    assertScalar("select count(*) from source_versions where id = 'srcv_legacy'", "1", "legacy source history after additive migration");
    assertScalar("select content from source_versions where id = 'srcv_legacy'", "Legacy pilot evidence remains immutable.", "legacy source content after additive migration");
    console.log("additive_migration=ok");
    console.log("fresh_migrations=ok");

    const timestamp = "1752624000.000001";
    const first = register("a", timestamp);
    assert(first.created === true && first.replayed === false && typeof first.workItemId === "string", "first save did not create canonical work");
    const replay = register("a", timestamp);
    assert(replay.replayed === true && replay.workItemId === null, "exact replay created work");
    const invalidIdentity = runAllowFailure("docker", psqlArgs(
      `select distillery_create_or_get_slack_save('stable', repeat('9', 64), '${workspaceId}', '${channelId}', '1752624999.000001', null, 'U12345678', null, 'slack:forged')`,
    ));
    assert(invalidIdentity.status !== 0, "forged external identity was accepted");

    const [concurrentOne, concurrentTwo] = await Promise.all([
      psqlAsync(registerSql("c", "1752624001.000001")),
      psqlAsync(registerSql("d", "1752624001.000001")),
    ]);
    const concurrentRegistrationOne = JSON.parse(concurrentOne) as Registration;
    const concurrentRegistrationTwo = JSON.parse(concurrentTwo) as Registration;
    assert(concurrentRegistrationOne.workItemId === concurrentRegistrationTwo.workItemId, "concurrent clicks returned different active ingestion work");
    assertScalar("select count(*) from connector_saves where message_timestamp = '1752624001.000001'", "1", "concurrent connector count");
    assertScalar(`select count(*) from pending_work where policy = 'ingest_slack_source' and subject_id = '${saveId(concurrentRegistrationOne)}'`, "1", "concurrent ingestion work count");
    console.log("registration_idempotency=ok");

    const firstSaveId = saveId(first);
    const firstContext = context({
      saveId: firstSaveId,
      suffix: "v1",
      timestamp,
      contentHash: "b".repeat(64),
      selectedText: "Checkout failures started after release 2.7.0.",
    });
    const firstCommit = commit(firstContext);
    assert(firstCommit.created === true && firstCommit.changed === true, "first context bundle was not created");
    assertScalar(`select context_version from connector_saves where id = '${firstSaveId}'`, "1", "first context version");
    assertScalar("select count(*) from slack_context_bundles where connector_save_id = '" + firstSaveId + "'", "1", "first context bundle count");
    assertScalar("select count(*) from ledger_events where event_type = 'slack_context_committed' and subject_id = 'bundle_v1'", "1", "first context event count");
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${firstSaveId}'`, "0", "reaction scheduled before context extraction existed");

    completeWork(first.workItemId!);
    const extractionV1 = createExtractionWork("extract_v1", "bundle_v1");
    assertScalar(`select distillery_is_slack_connector_extraction_complete('${firstSaveId}')`, "f", "readiness before context extraction");
    completeWork(extractionV1);
    assertScalar(`select distillery_is_slack_connector_extraction_complete('${firstSaveId}')`, "t", "readiness after context extraction");
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${firstSaveId}' and status = 'pending'`, "1", "reaction work after context extraction");
    console.log("reaction_lifecycle=ok");

    const initialReactionWorkId = psql(`select id from pending_work where policy = 'sync_slack_reaction' and subject_id = '${firstSaveId}' and status = 'pending'`);
    completeWork(initialReactionWorkId);
    psql(`update connector_saves set reaction_status = 'added' where id = '${firstSaveId}'`);

    // A later click always refreshes Slack. An unchanged snapshot reuses the same bundle and source versions.
    const unchanged = register("e", timestamp);
    assert(typeof unchanged.workItemId === "string", "unchanged refresh did not create ingestion work");
    const unchangedCommit = commit({ ...firstContext, id: "bundle_v1_retry", capturedAt: "2026-07-16T12:05:00.000Z" });
    assert(unchangedCommit.created === false && unchangedCommit.changed === false, "unchanged context created a new bundle");
    assertScalar(`select count(*) from slack_context_bundles where connector_save_id = '${firstSaveId}'`, "1", "unchanged context bundle count");
    assertScalar("select count(*) from source_versions where source_item_id in (select id from source_items where external_id in ('slack_channel_profile:T12345678:C12345678', 'slack_message:T12345678:C12345678:1752624000.000001'))", "2", "unchanged context source version count");
    assertScalar("select count(*) from ledger_events where event_type = 'slack_context_committed' and subject_id = 'bundle_v1'", "1", "unchanged context event count");
    completeWork(unchanged.workItemId!);
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${firstSaveId}'`, "2", "unchanged refresh reaction synchronization count");
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${firstSaveId}' and status = 'pending'`, "1", "unchanged refresh pending reaction synchronization");
    assertScalar(`select count(*) from ledger_events where event_type = 'slack_extraction_completed' and subject_id = '${firstSaveId}'`, "2", "unchanged refresh completion observation count");
    console.log("unchanged_refresh=ok");

    // A new reply creates bundle v2 while retaining every v1 source version.
    const changed = register("f", timestamp);
    const changedContext = context({
      saveId: firstSaveId,
      suffix: "v2",
      timestamp,
      contentHash: "c".repeat(64),
      selectedText: "Checkout failures started after release 2.7.0.",
      replyText: "Rollback completed; checkout success recovered at 12:14 UTC.",
    });
    const changedCommit = commit(changedContext);
    assert(changedCommit.created === true && changedCommit.changed === true, "new reply did not create a context version");
    assertScalar(`select context_version from connector_saves where id = '${firstSaveId}'`, "2", "new reply context version");
    assertScalar("select previous_bundle_id from slack_context_bundles where id = 'bundle_v2'", "bundle_v1", "context version history link");
    assertScalar("select count(*) from source_items where external_id = 'slack_message:T12345678:C12345678:1752624000.000002'", "1", "new reply source item count");
    assertScalar("select content from source_versions where id = 'srcv_selected_v1'", "Checkout failures started after release 2.7.0.", "v1 selected source immutability");
    completeWork(changed.workItemId!);

    // Editing the selected Slack message creates source version 2 under the same stable identity.
    const edited = register("7", timestamp);
    const editedContext = context({
      saveId: firstSaveId,
      suffix: "v3",
      timestamp,
      contentHash: "d".repeat(64),
      selectedText: "Checkout failures started after release 2.7.1, not 2.7.0.",
      selectedContentHash: "e".repeat(64),
      replyText: "Rollback completed; checkout success recovered at 12:14 UTC.",
    });
    commit(editedContext);
    assertScalar(`select context_version from connector_saves where id = '${firstSaveId}'`, "3", "edited message context version");
    assertScalar("select count(*) from source_items where external_id = 'slack_message:T12345678:C12345678:1752624000.000001'", "1", "edited message stable source identity");
    assertScalar("select count(*) from source_versions sv join source_items si on si.id = sv.source_item_id where si.external_id = 'slack_message:T12345678:C12345678:1752624000.000001'", "2", "edited message version count");
    assertScalar("select content from source_versions where id = 'srcv_selected_v1'", "Checkout failures started after release 2.7.0.", "edited message did not mutate old version");
    completeWork(edited.workItemId!);
    console.log("context_versioning=ok");

    // Two workers committing the same snapshot converge on one bundle and one source version per content hash.
    const concurrentSave = register("8", "1752624010.000001");
    const concurrentContext = context({
      saveId: saveId(concurrentSave), suffix: "concurrent", timestamp: "1752624010.000001",
      contentHash: "8".repeat(64), selectedText: "Concurrent context commit.",
    });
    const [commitOne, commitTwo] = await Promise.all([
      psqlAsync(commitSql(concurrentContext)),
      psqlAsync(commitSql(concurrentContext)),
    ]);
    assert((JSON.parse(commitOne) as ContextCommit).created !== (JSON.parse(commitTwo) as ContextCommit).created, "concurrent commits did not converge");
    assertScalar(`select count(*) from slack_context_bundles where connector_save_id = '${saveId(concurrentSave)}'`, "1", "concurrent bundle count");
    assertScalar("select count(*) from source_versions sv join source_items si on si.id = sv.source_item_id where si.external_id in ('slack_channel_profile:T12345678:C12345678', 'slack_message:T12345678:C12345678:1752624010.000001')", "2", "concurrent source version count");
    console.log("concurrent_commit=ok");

    // A bad evidence offset must roll back the entire bundle transaction.
    const atomicSave = register("9", "1752624020.000001");
    const invalidContext = context({
      saveId: saveId(atomicSave), suffix: "atomic", timestamp: "1752624020.000001",
      contentHash: "9".repeat(64), selectedText: "Must roll back.",
    });
    invalidContext.sources[1]!.evidenceSpans[0]!.text = "does not match";
    const failedCommit = runAllowFailure("docker", psqlArgs(commitSql(invalidContext)));
    assert(failedCommit.status !== 0, "invalid evidence commit unexpectedly succeeded");
    assertScalar("select count(*) from source_items where external_id = 'slack_message:T12345678:C12345678:1752624020.000001'", "0", "failed context source rollback");
    assertScalar(`select status from connector_saves where id = '${saveId(atomicSave)}'`, "pending", "failed context connector status");
    console.log("transactional_atomicity=ok");

    console.log("slack_database_integration=ok");
  } finally {
    runAllowFailure("docker", ["stop", container]);
  }
}

type Registration = { save: unknown; workItemId: string | null; created: boolean; replayed: boolean };
type ContextCommit = { bundle: Record<string, unknown>; created: boolean; changed: boolean };
type SourceInput = ReturnType<typeof source>;
type ContextInput = ReturnType<typeof context>;

function applyMigration(name: string): void {
  const sql = fs.readFileSync(`packages/db/migrations/${name}`, "utf8");
  run("docker", [
    "exec", "--interactive", "--user", "postgres", container,
    "psql", "--dbname", "postgres", "--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", "-",
  ], sql);
}

function saveId(registration: Registration): string {
  return String((registration.save as Record<string, unknown>).id);
}

function register(hashCharacter: string, timestamp: string): Registration {
  return JSON.parse(psql(registerSql(hashCharacter, timestamp))) as Registration;
}

function registerSql(hashCharacter: string, timestamp: string): string {
  return `select distillery_create_or_get_slack_save('stable', repeat('${hashCharacter}', 64), '${workspaceId}', '${channelId}', '${timestamp}', null, 'U12345678', null, 'slack_message:${workspaceId}:${channelId}:${timestamp}')`;
}

function commit(input: ContextInput): ContextCommit {
  return JSON.parse(psql(commitSql(input))) as ContextCommit;
}

function commitSql(input: ContextInput): string {
  return `select distillery_commit_slack_context_bundle('${sqlLiteral(JSON.stringify(input))}'::jsonb)`;
}

function context(input: {
  saveId: string;
  suffix: string;
  timestamp: string;
  contentHash: string;
  selectedText: string;
  selectedContentHash?: string;
  replyText?: string;
}) {
  const profile = source({
    prefix: `profile_${input.suffix}`,
    sourceType: "slack_channel_profile",
    externalId: `slack_channel_profile:${workspaceId}:${channelId}`,
    content: "#incident-room\nTopic: Live incident coordination.",
    contentHash: "2".repeat(64),
    timestamp: input.timestamp,
  });
  const selected = source({
    prefix: `selected_${input.suffix}`,
    sourceType: "slack_message",
    externalId: `slack_message:${workspaceId}:${channelId}:${input.timestamp}`,
    content: input.selectedText,
    contentHash: input.selectedContentHash ?? "3".repeat(64),
    timestamp: input.timestamp,
  });
  const sources: SourceInput[] = [profile, selected];
  const items = [
    { id: `bundle_item_profile_${input.suffix}`, ordinal: 0, role: "channel_profile", requestedSourceVersionId: profile.sourceVersionId, externalId: profile.externalId, selectionReason: "Channel metadata", primary: false },
    { id: `bundle_item_selected_${input.suffix}`, ordinal: 1, role: "selected_message", requestedSourceVersionId: selected.sourceVersionId, externalId: selected.externalId, selectionReason: "Invoked message", primary: true },
  ];
  if (input.replyText) {
    const replyTimestamp = "1752624000.000002";
    const reply = source({
      prefix: `reply_${input.suffix}`,
      sourceType: "slack_message",
      externalId: `slack_message:${workspaceId}:${channelId}:${replyTimestamp}`,
      content: input.replyText,
      contentHash: "4".repeat(64),
      timestamp: replyTimestamp,
    });
    sources.push(reply);
    items.push({
      id: `bundle_item_reply_${input.suffix}`, ordinal: 2, role: "thread_reply",
      requestedSourceVersionId: reply.sourceVersionId, externalId: reply.externalId,
      selectionReason: "Reply in selected thread", primary: false,
    });
  }
  return {
    id: `bundle_${input.suffix}`,
    saveId: input.saveId,
    selectedMessageTimestamp: input.timestamp,
    threadTimestamp: input.replyText ? input.timestamp : null,
    channelProfile: {
      workspaceId, channelId, name: "incident-room", topic: "Live incident coordination.", purpose: "Resolve production incidents.",
      isPublic: true, isPrivate: false, externallyShared: false, slackConnect: false, externalTeamIds: [],
      capturedAt: "2026-07-16T12:00:00.000Z",
    },
    selectionStrategy: input.replyText ? "thread" : "selected_only",
    selectionVersion: "slack-context-v1",
    contentHash: input.contentHash,
    capturedAt: "2026-07-16T12:00:00.000Z",
    externallyShared: false,
    truncation: {
      truncated: false, messageLimitApplied: false, characterLimitApplied: false,
      originalMessageCount: sources.length - 1, retainedMessageCount: sources.length - 1,
      originalCharacterCount: input.selectedText.length + (input.replyText?.length ?? 0),
      retainedCharacterCount: input.selectedText.length + (input.replyText?.length ?? 0),
      omittedMessageTimestamps: [],
    },
    classification: {
      category: "incident", rationale: "The messages describe and resolve a production failure.",
      identities: { products: ["StablePay"], featureComponents: ["Checkout"], externalServices: [], issueTicketIds: [], releaseVersions: ["2.7.0"], environments: ["production"], namedOrganizations: [] },
    },
    skippedAttachments: [],
    sources,
    items,
  };
}

function source(input: {
  prefix: string;
  sourceType: "slack_message" | "slack_channel_profile" | "slack_file_pdf" | "slack_file_docx";
  externalId: string;
  content: string;
  contentHash: string;
  timestamp: string;
}) {
  const canonicalUrl = input.sourceType === "slack_channel_profile"
    ? `https://example.slack.com/archives/${channelId}`
    : `https://example.slack.com/archives/${channelId}/p${input.timestamp.replace(".", "")}`;
  return {
    sourceItemId: `src_${input.prefix}`,
    sourceVersionId: `srcv_${input.prefix}`,
    ingestionId: `ing_${input.prefix}`,
    sourceType: input.sourceType,
    provider: "slack",
    externalId: input.externalId,
    canonicalUrl,
    authorId: input.sourceType === "slack_channel_profile" ? null : "U87654321",
    authorLabel: input.sourceType === "slack_channel_profile" ? "Slack channel profile" : "Ada Lovelace",
    occurredAt: "2026-07-16T12:00:00.000Z",
    mimeType: "text/plain",
    originalFilename: null,
    content: input.content,
    contentHash: input.contentHash,
    sourceMetadata: {
      workspaceId, channelId, messageTimestamp: input.timestamp,
      permalink: canonicalUrl, authorId: "U87654321", authorLabel: "Ada Lovelace", occurredAt: "2026-07-16T12:00:00.000Z",
    },
    evidenceSpans: [{
      id: `span_${input.prefix}`,
      sourceVersionId: `srcv_${input.prefix}`,
      startLine: 1, endLine: 1, startChar: 0, endChar: input.content.length,
      text: input.content,
      locator: { provider: "slack", channelId, messageTimestamp: input.timestamp, permalink: canonicalUrl },
    }],
  };
}

function createExtractionWork(id: string, bundleId: string): string {
  psql(`insert into pending_work(
    id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version,
    status, attempts, lease_token, lease_expires_at
  ) values (
    '${id}', 'stable', 'extract_slack_context', 'context_bundle', '${bundleId}',
    (select id from ledger_events where event_type = 'slack_context_committed' and subject_id = '${bundleId}'),
    'extract:${bundleId}', 'running', 1, 'lease-${id}', now() + interval '15 minutes'
  )`);
  return id;
}

function completeWork(id: string): void {
  psql(`update pending_work set status = 'running', attempts = greatest(attempts, 1), lease_token = 'lease-${id}', lease_expires_at = now() + interval '15 minutes' where id = '${id}' and status = 'pending'`);
  psql(`select distillery_complete_pending_work('${id}', 'lease-${id}')`);
}

function psql(sql: string): string {
  return run("docker", psqlArgs(sql)).trim();
}

function psqlArgs(sql: string): string[] {
  return ["exec", "--user", "postgres", container, "psql", "--dbname", "postgres", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql];
}

function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", psqlArgs(sql), { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

function assertScalar(sql: string, expected: string, label: string): void {
  const actual = psql(sql);
  assert(actual === expected, `${label}: expected ${expected}, received ${actual}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function requireCommand(command: string, args: string[]): void {
  const result = runAllowFailure(command, args);
  if (result.status !== 0) throw new Error(`${command} is required for this database-backed test.`);
}

function run(command: string, args: string[], input?: string): string {
  const result = runAllowFailure(command, args, input);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).slice(0, 2_000)}`);
  }
  return result.stdout;
}

function runAllowFailure(command: string, args: string[], input?: string) {
  return spawnSync(command, args, { input, encoding: "utf8" });
}

async function waitForPostgres(): Promise<void> {
  let consecutiveReady = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = runAllowFailure("docker", ["exec", "--user", "postgres", container, "pg_isready", "--dbname", "postgres"]);
    consecutiveReady = result.status === 0 ? consecutiveReady + 1 : 0;
    if (consecutiveReady >= 4) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Disposable PostgreSQL did not become ready within 15 seconds.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
