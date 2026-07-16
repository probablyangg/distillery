import fs from "node:fs";
import { execFile, spawnSync } from "node:child_process";

const container = `distillery-slack-db-test-${process.pid}`;
const image = "pgvector/pgvector:pg16";

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
    for (const migration of fs.readdirSync("packages/db/migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const sql = fs.readFileSync(`packages/db/migrations/${migration}`, "utf8");
      run("docker", [
        "exec", "--interactive", "--user", "postgres", container,
        "psql", "--dbname", "postgres", "--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", "-",
      ], sql);
    }
    console.log("fresh_migrations=ok");

    const first = register("a", "1752624000.000001");
    assert(first.created === true && first.replayed === false && typeof first.workItemId === "string", "first save did not create canonical work");
    const replay = register("a", "1752624000.000001");
    assert(replay.replayed === true && replay.workItemId === null, "exact replay created work");
    assertScalar("select count(*) from connector_saves", "1", "first save connector count");
    assertScalar("select count(*) from pending_work where policy = 'ingest_slack_source'", "1", "first save work count");
    const invalidIdentity = runAllowFailure("docker", psqlArgs(
      "select distillery_create_or_get_slack_save('stable', repeat('9', 64), 'T12345678', 'C12345678', '1752624999.000001', null, 'U12345678', null, 'slack:forged')",
    ));
    assert(invalidIdentity.status !== 0, "forged external identity was accepted");
    assertScalar("select count(*) from connector_saves", "1", "forged identity wrote connector state");

    const concurrentSql = (letter: string) => registerSql(letter, "1752624001.000001");
    const [concurrentOne, concurrentTwo] = await Promise.all([
      psqlAsync(concurrentSql("c")),
      psqlAsync(concurrentSql("d")),
    ]);
    const concurrentWorkOne = (JSON.parse(concurrentOne) as Registration).workItemId;
    const concurrentWorkTwo = (JSON.parse(concurrentTwo) as Registration).workItemId;
    assert(concurrentWorkOne === concurrentWorkTwo, "concurrent saves returned different work items");
    assertScalar("select count(*) from connector_saves where message_timestamp = '1752624001.000001'", "1", "concurrent connector count");
    assertScalar("select count(*) from pending_work where subject_id = (select id from connector_saves where message_timestamp = '1752624001.000001')", "1", "concurrent work count");
    console.log("registration_idempotency=ok");

    const firstSaveId = String((first.save as Record<string, unknown>).id);
    const firstSources = [
      source({
        sourceItemId: "src_message_1",
        sourceVersionId: "srcv_message_1",
        ingestionId: "ing_message_1",
        sourceType: "slack_message",
        externalId: "slack:T12345678:C12345678:1752624000.000001",
        canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624000000001",
        mimeType: "text/plain",
        content: "Decision text.",
        contentHash: "b".repeat(64),
        spanId: "span_message_1",
        locator: { provider: "slack", messageTimestamp: "1752624000.000001", permalink: "https://example.slack.com/archives/C12345678/p1752624000000001" },
      }),
      source({
        sourceItemId: "src_file_1",
        sourceVersionId: "srcv_file_1",
        ingestionId: "ing_file_1",
        sourceType: "slack_file_pdf",
        externalId: "slack_file:T12345678:F12345678",
        canonicalUrl: "https://example.slack.com/files/F12345678",
        mimeType: "application/pdf",
        originalFilename: "decision.pdf",
        content: "PDF evidence text.",
        contentHash: "e".repeat(64),
        spanId: "span_file_1",
        locator: { provider: "slack", pageNumber: 2, startChar: 0, endChar: 18, permalink: "https://example.slack.com/files/F12345678" },
      }),
    ];
    commit(firstSaveId, firstSources);
    assertScalar("select count(*) from source_items", "2", "initial source count");
    assertScalar("select count(*) from source_versions", "2", "initial source version count");
    assertScalar("select count(*) from evidence_spans", "2", "initial evidence count");
    assertScalar("select count(*) from ledger_events where event_type = 'source_committed'", "2", "downstream source event count");

    const repeated = register("f", "1752624000.000001");
    assert(typeof repeated.workItemId === "string", "completed repeat did not create reaction sync work");
    assertScalar("select count(*) from source_versions", "2", "repeat changed source versions");
    assertScalar("select count(*) from ledger_events where event_type = 'source_committed'", "2", "repeat created downstream extraction event");
    assertScalar("select count(*) from pending_work where policy = 'sync_slack_reaction'", "1", "repeat reaction work count");

    const reshare = register("1", "1752624002.000001");
    const reshareSaveId = String((reshare.save as Record<string, unknown>).id);
    commit(reshareSaveId, [
      source({
        sourceItemId: "src_message_2", sourceVersionId: "srcv_message_2", ingestionId: "ing_message_2",
        sourceType: "slack_message", externalId: "slack:T12345678:C12345678:1752624002.000001",
        canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624002000001", mimeType: "text/plain",
        content: "The file was shared again.", contentHash: "2".repeat(64), spanId: "span_message_2",
        locator: { provider: "slack", messageTimestamp: "1752624002.000001" },
      }),
      source({
        sourceItemId: "src_file_duplicate", sourceVersionId: "srcv_file_duplicate", ingestionId: "ing_file_duplicate",
        sourceType: "slack_file_pdf", externalId: "slack_file:T12345678:F12345678",
        canonicalUrl: "https://example.slack.com/files/F12345678", mimeType: "application/pdf", originalFilename: "decision.pdf",
        content: "PDF evidence text.", contentHash: "e".repeat(64), spanId: "span_file_duplicate",
        locator: { provider: "slack", pageNumber: 2 },
      }),
    ]);
    assertScalar("select count(*) from source_items where external_id = 'slack_file:T12345678:F12345678'", "1", "reshared file item count");
    assertScalar("select count(*) from source_versions where source_item_id = 'src_file_1'", "1", "reshared file version count");
    assertScalar("select content from source_versions where id = 'srcv_file_1'", "PDF evidence text.", "reshared file immutable content");

    const concurrentFileSaveOne = register("5", "1752624010.000001");
    const concurrentFileSaveTwo = register("6", "1752624011.000001");
    const concurrentFileSources = (ordinal: number, timestamp: string) => [
      source({
        sourceItemId: `src_concurrent_message_${ordinal}`, sourceVersionId: `srcv_concurrent_message_${ordinal}`, ingestionId: `ing_concurrent_message_${ordinal}`,
        sourceType: "slack_message", externalId: `slack:T12345678:C12345678:${timestamp}`,
        canonicalUrl: `https://example.slack.com/archives/C12345678/p${timestamp.replace(".", "")}`, mimeType: "text/plain",
        content: `Concurrent message ${ordinal}.`, contentHash: String(ordinal + 6).repeat(64), spanId: `span_concurrent_message_${ordinal}`,
        locator: { provider: "slack", messageTimestamp: timestamp },
      }),
      source({
        sourceItemId: `src_concurrent_file_${ordinal}`, sourceVersionId: `srcv_concurrent_file_${ordinal}`, ingestionId: `ing_concurrent_file_${ordinal}`,
        sourceType: "slack_file_pdf", externalId: "slack_file:T12345678:FCONCURR1",
        canonicalUrl: "https://example.slack.com/files/FCONCURR1", mimeType: "application/pdf", originalFilename: "concurrent.pdf",
        content: "One concurrent file version.", contentHash: "8".repeat(64), spanId: `span_concurrent_file_${ordinal}`,
        locator: { provider: "slack", pageNumber: 1 },
      }),
    ];
    await Promise.all([
      psqlAsync(commitSql(String((concurrentFileSaveOne.save as Record<string, unknown>).id), concurrentFileSources(1, "1752624010.000001"))),
      psqlAsync(commitSql(String((concurrentFileSaveTwo.save as Record<string, unknown>).id), concurrentFileSources(2, "1752624011.000001"))),
    ]);
    assertScalar("select count(*) from source_items where external_id = 'slack_file:T12345678:FCONCURR1'", "1", "concurrent reshared file item count");
    assertScalar("select count(*) from source_versions sv join source_items si on si.id = sv.source_item_id where si.external_id = 'slack_file:T12345678:FCONCURR1'", "1", "concurrent reshared file version count");
    console.log("source_deduplication=ok");

    const atomic = register("3", "1752624003.000001");
    const atomicSaveId = String((atomic.save as Record<string, unknown>).id);
    const invalidSources = [source({
      sourceItemId: "src_atomic_message", sourceVersionId: "srcv_atomic_message", ingestionId: "ing_atomic_message",
      sourceType: "slack_message", externalId: "slack:T12345678:C12345678:1752624003.000001",
      canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624003000001", mimeType: "text/plain",
      content: "Must roll back.", contentHash: "4".repeat(64), spanId: "span_atomic_message",
      locator: { provider: "slack", messageTimestamp: "1752624003.000001" },
    })];
    invalidSources[0]!.evidenceSpans[0]!.text = "does not match";
    const failedCommit = runAllowFailure("docker", psqlArgs(commitSql(atomicSaveId, invalidSources)));
    assert(failedCommit.status !== 0, "invalid evidence commit unexpectedly succeeded");
    assertScalar("select count(*) from source_items where external_id = 'slack:T12345678:C12345678:1752624003.000001'", "0", "failed atomic source rollback");
    assertScalar(`select status from connector_saves where id = '${atomicSaveId}'`, "pending", "failed atomic connector status");
    console.log("transactional_atomicity=ok");

    const lifecycle = register("7", "1752624020.000001");
    const lifecycleSaveId = String((lifecycle.save as Record<string, unknown>).id);
    commit(lifecycleSaveId, [
      source({
        sourceItemId: "src_lifecycle_message", sourceVersionId: "srcv_lifecycle_message", ingestionId: "ing_lifecycle_message",
        sourceType: "slack_message", externalId: "slack:T12345678:C12345678:1752624020.000001",
        canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624020000001", mimeType: "text/plain",
        content: "Lifecycle message.", contentHash: "a".repeat(64), spanId: "span_lifecycle_message",
        locator: { provider: "slack", messageTimestamp: "1752624020.000001" },
      }),
      source({
        sourceItemId: "src_lifecycle_file", sourceVersionId: "srcv_lifecycle_file", ingestionId: "ing_lifecycle_file",
        sourceType: "slack_file_pdf", externalId: "slack_file:T12345678:FLIFECYCLE",
        canonicalUrl: "https://example.slack.com/files/FLIFECYCLE", mimeType: "application/pdf", originalFilename: "lifecycle.pdf",
        content: "Sectioned lifecycle file.", contentHash: "9".repeat(64), spanId: "span_lifecycle_file",
        locator: { provider: "slack", pageNumber: 1 },
      }),
    ]);
    psql(`
      insert into memory_section_plans(
        id, tenant_id, ingestion_id, source_version_id, used_sectioning, strategy,
        trigger_chars, trigger_spans, target_chars, max_chars, max_sections
      ) values
        ('mplan_lifecycle_message', 'stable', 'ing_lifecycle_message', 'srcv_lifecycle_message', false, 'single', 6000, 20, 5000, 8000, 50),
        ('mplan_lifecycle_file', 'stable', 'ing_lifecycle_file', 'srcv_lifecycle_file', true, 'model', 6000, 20, 5000, 8000, 50);
      insert into pending_work(
        id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version,
        status, attempts, lease_token, lease_expires_at
      ) values
        ('work_lifecycle_message', 'stable', 'extract_memory', 'source', 'srcv_lifecycle_message',
          (select id from ledger_events where event_type = 'source_committed' and subject_id = 'srcv_lifecycle_message'),
          'lifecycle-message', 'running', 1, 'lease-message', now() + interval '15 minutes'),
        ('work_lifecycle_file', 'stable', 'consolidate_memory', 'source', 'srcv_lifecycle_file',
          (select id from ledger_events where event_type = 'source_committed' and subject_id = 'srcv_lifecycle_file'),
          'lifecycle-file', 'running', 1, 'lease-file', now() + interval '15 minutes');
    `);
    assertScalar(`select distillery_is_slack_connector_extraction_complete('${lifecycleSaveId}')`, "f", "lifecycle readiness before extraction");
    psql("select distillery_complete_pending_work('work_lifecycle_message', 'lease-message')");
    assertScalar(`select distillery_is_slack_connector_extraction_complete('${lifecycleSaveId}')`, "f", "lifecycle readiness after one source");
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${lifecycleSaveId}'`, "0", "premature lifecycle reaction work");
    psql("select distillery_complete_pending_work('work_lifecycle_file', 'lease-file')");
    assertScalar(`select distillery_is_slack_connector_extraction_complete('${lifecycleSaveId}')`, "t", "lifecycle readiness after every source");
    assertScalar(`select count(*) from pending_work where policy = 'sync_slack_reaction' and subject_id = '${lifecycleSaveId}' and status = 'pending'`, "1", "completed lifecycle reaction work");
    assertScalar(`select count(*) from ledger_events where event_type = 'slack_extraction_completed' and subject_id = '${lifecycleSaveId}'`, "1", "lifecycle completion event");
    const lifecycleReactionWork = JSON.parse(psql(`select distillery_list_slack_reaction_work_for_completed_work('work_lifecycle_file')`)) as unknown[];
    assert(lifecycleReactionWork.length === 1, "completed extraction did not expose its reaction wakeup");
    console.log("reaction_lifecycle=ok");

    psql(`insert into initiative_briefs(id, tenant_id, title, problem, proposal, success_metric, status, created_by_label, origin, generation_reason, updated_at) values
      ('brief_manual', 'stable', 'Manual', 'Manual problem.', 'Manual proposal.', 'Metric', 'approved', 'Human', 'manual', null, '2026-07-16T04:00:00Z'),
      ('brief_generated_old', 'stable', 'Generated old', 'Old evidence. Extra sentence.', 'Old action. Extra proposal.', 'Metric', 'draft', 'Distillery', 'distillery_generated', 'Old readiness reason.', '2026-07-16T01:00:00Z'),
      ('brief_generated_new', 'stable', 'Generated new', 'New evidence. Extra sentence.', 'New action! Extra proposal.', 'Metric', 'approved', 'Distillery', 'distillery_generated', 'New readiness reason.', '2026-07-16T03:00:00Z'),
      ('brief_rejected', 'stable', 'Rejected', 'Rejected evidence.', 'Rejected action.', 'Metric', 'rejected', 'Distillery', 'distillery_generated', 'Rejected reason.', '2026-07-16T05:00:00Z');
      insert into initiative_brief_evidence(brief_id, evidence_span_id, tenant_id) values ('brief_generated_new', 'span_message_1', 'stable');`);
    const projected = JSON.parse(psql("select distillery_list_leadership_briefs('stable', 50)")) as Array<Record<string, unknown>>;
    assert(projected.length === 2, "manual or rejected briefs leaked into leadership projection");
    assert(projected[0]?.id === "brief_generated_new" && projected[1]?.id === "brief_generated_old", "leadership briefs were not newest first");
    assert(projected[0]?.summary === "New evidence. New action!", "leadership summary was not exactly two sentences");
    const citations = projected[0]?.citations as Array<Record<string, unknown>>;
    assert(citations[0]?.exactText === "Decision text.", "exact evidence citation was not projected");
    console.log("leadership_projection=ok");
    console.log("slack_database_integration=ok");
  } finally {
    runAllowFailure("docker", ["stop", container]);
  }
}

type Registration = { save: unknown; workItemId: string | null; created: boolean; replayed: boolean };

function register(hashCharacter: string, timestamp: string): Registration {
  return JSON.parse(psql(registerSql(hashCharacter, timestamp))) as Registration;
}

function registerSql(hashCharacter: string, timestamp: string): string {
  return `select distillery_create_or_get_slack_save('stable', repeat('${hashCharacter}', 64), 'T12345678', 'C12345678', '${timestamp}', null, 'U12345678', null, 'slack:T12345678:C12345678:${timestamp}')`;
}

function commit(saveId: string, sources: SourceInput[]): void {
  psql(commitSql(saveId, sources));
}

function commitSql(saveId: string, sources: SourceInput[]): string {
  return `select distillery_commit_slack_connector_sources('${saveId}', '${sqlLiteral(JSON.stringify(sources))}'::jsonb)`;
}

type SourceInput = ReturnType<typeof source>;

function source(input: {
  sourceItemId: string; sourceVersionId: string; ingestionId: string;
  sourceType: "slack_message" | "slack_file_pdf" | "slack_file_docx";
  externalId: string; canonicalUrl: string; mimeType: string; originalFilename?: string;
  content: string; contentHash: string; spanId: string; locator: Record<string, unknown>;
}) {
  return {
    sourceItemId: input.sourceItemId,
    sourceVersionId: input.sourceVersionId,
    ingestionId: input.ingestionId,
    sourceType: input.sourceType,
    provider: "slack",
    externalId: input.externalId,
    canonicalUrl: input.canonicalUrl,
    authorId: "U87654321",
    authorLabel: "Ada Lovelace",
    occurredAt: "2026-07-16T00:00:00.000Z",
    mimeType: input.mimeType,
    originalFilename: input.originalFilename ?? null,
    content: input.content,
    contentHash: input.contentHash,
    sourceMetadata: { workspaceId: "T12345678", channelId: "C12345678" },
    evidenceSpans: [{
      id: input.spanId,
      sourceVersionId: input.sourceVersionId,
      startLine: 1,
      endLine: 1,
      startChar: 0,
      endChar: input.content.length,
      text: input.content,
      locator: input.locator,
    }],
  };
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
