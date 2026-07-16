import { describe, expect, it } from "vitest";
import { SupabaseLoopPersistence, SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "./index";

describe("Slack connector and leadership brief RPC bindings", () => {
  it("registers the exact Slack identity and replay hash through one atomic RPC", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const persistence = new SupabaseLoopPersistence(client(async (url, body) => {
      calls.push({ url, body });
      return { save: connectorSave(), workItemId: "work_1", created: true, replayed: false };
    }));

    const result = await persistence.createOrGetSlackSave({
      tenantId: "stable",
      requestHash: "a".repeat(64),
      workspaceId: "T12345678",
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      threadTimestamp: "1752623999.000001",
      invokingUserId: "U12345678",
      responseUrl: "https://hooks.slack.com/actions/test",
      externalSourceId: "slack:T12345678:C12345678:1752624000.000001",
    });

    expect(result.workItemId).toBe("work_1");
    expect(calls).toEqual([{
      url: "https://example.supabase.co/rest/v1/rpc/distillery_create_or_get_slack_save",
      body: {
        p_tenant_id: "stable",
        p_request_hash: "a".repeat(64),
        p_workspace_id: "T12345678",
        p_channel_id: "C12345678",
        p_message_timestamp: "1752624000.000001",
        p_thread_timestamp: "1752623999.000001",
        p_invoking_user_id: "U12345678",
        p_response_url: "https://hooks.slack.com/actions/test",
        p_external_source_id: "slack:T12345678:C12345678:1752624000.000001",
      },
    }]);
  });

  it("passes all sources to the single atomic source/evidence commit RPC", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const persistence = new SupabaseLoopPersistence(client(async (_url, body) => {
      calls.push(body);
      return connectorSave({ status: "completed", reactionStatus: "pending" });
    }));
    const source = {
      sourceItemId: "src_1",
      sourceVersionId: "srcv_1",
      ingestionId: "ing_1",
      sourceType: "slack_message" as const,
      provider: "slack" as const,
      externalId: "slack:T12345678:C12345678:1752624000.000001",
      canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624000000001",
      authorId: "U87654321",
      authorLabel: "Ada Lovelace",
      occurredAt: "2026-07-16T00:00:00.000Z",
      mimeType: "text/plain",
      originalFilename: null,
      content: "Decision text.",
      contentHash: "b".repeat(64),
      sourceMetadata: { workspaceId: "T12345678" },
      evidenceSpans: [{
        id: "span_1",
        sourceVersionId: "srcv_1",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 14,
        text: "Decision text.",
        locator: { provider: "slack", messageTimestamp: "1752624000.000001" },
      }],
    };
    await persistence.commitSlackConnectorSources({ saveId: "csave_1", sources: [source] });
    expect(calls).toEqual([{ p_save_id: "csave_1", p_sources: [source] }]);
  });

  it("reads extraction readiness and the canonical reaction wakeup", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const persistence = new SupabaseLoopPersistence(client(async (url, body) => {
      calls.push({ url, body });
      return url.endsWith("distillery_is_slack_connector_extraction_complete")
        ? true
        : [pendingReactionWork()];
    }));

    await expect(persistence.isSlackConnectorExtractionComplete("csave_1")).resolves.toBe(true);
    await expect(persistence.listSlackReactionWorkForCompletedWork("work_extract_1"))
      .resolves.toEqual([expect.objectContaining({ id: "work_reaction_1", policy: "sync_slack_reaction" })]);
    expect(calls.map(({ url, body }) => ({ url: url.split("/").at(-1), body }))).toEqual([
      { url: "distillery_is_slack_connector_extraction_complete", body: { p_save_id: "csave_1" } },
      { url: "distillery_list_slack_reaction_work_for_completed_work", body: { p_work_item_id: "work_extract_1" } },
    ]);
  });

  it("validates generated brief citations returned by PostgreSQL", async () => {
    const repository = new SupabaseMemoryGenerationRepository(client(async () => [leadershipBrief()]));
    const briefs = await repository.listLeadershipBriefs({ limit: 10 });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      status: "approved",
      supportingSourceCount: 1,
      citations: [expect.objectContaining({
        exactText: "<script>alert('untrusted source')</script>",
        locator: { provider: "slack", pageNumber: 2 },
      })],
    });
  });
});

function client(handler: (url: string, body: Record<string, unknown>) => Promise<unknown>): SupabaseRpcClient {
  return new SupabaseRpcClient({
    supabaseUrl: "https://example.supabase.co",
    secretKey: "test-secret",
    fetchImpl: async (input, init) => new Response(JSON.stringify(await handler(
      String(input),
      JSON.parse(String(init?.body)) as Record<string, unknown>,
    )), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

function connectorSave(overrides: Record<string, unknown> = {}) {
  return {
    id: "csave_1",
    tenantId: "stable",
    provider: "slack",
    workspaceId: "T12345678",
    channelId: "C12345678",
    messageTimestamp: "1752624000.000001",
    threadTimestamp: null,
    invokingUserId: "U12345678",
    responseUrl: "https://hooks.slack.com/actions/test",
    externalSourceId: "slack:T12345678:C12345678:1752624000.000001",
    status: "pending",
    workItemId: "work_1",
    messageSourceId: null,
    attachmentSourceIds: [],
    reactionStatus: "pending",
    retryCount: 0,
    reactionRetryCount: 0,
    lastError: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function pendingReactionWork() {
  return {
    id: "work_reaction_1",
    tenantId: "stable",
    policy: "sync_slack_reaction",
    subjectType: "connector_save",
    subjectId: "csave_1",
    causedByEventId: "evt_extraction_complete_1",
    inputVersion: "extraction-complete:work_extract_1",
    status: "pending",
    attempts: 0,
    lastError: null,
    lockedAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    recoveryCount: 0,
    lastRecoveredAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

function leadershipBrief() {
  return {
    id: "brief_1",
    title: "Pilot decision",
    summary: "A pilot decision was recorded. Leadership can inspect its evidence.",
    whyGenerated: "The connected evidence passed readiness checks.",
    status: "approved",
    supportingSourceCount: 1,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    executiveSummary: "A pilot decision was recorded.",
    whatIsHappening: "The pilot is ready.",
    decisionsAndCommitments: "Launch the pilot.",
    risks: ["Scope drift"],
    dependencies: ["Slack admin setup"],
    openQuestions: ["Who owns support?"],
    conflictingEvidence: [],
    citations: [{
      evidenceSpanId: "span_1",
      sourceVersionId: "srcv_1",
      sourceType: "slack_file_pdf",
      authorOrTitle: "Pilot decision.pdf",
      occurredAt: "2026-07-15T12:00:00.000Z",
      exactText: "<script>alert('untrusted source')</script>",
      locator: { provider: "slack", pageNumber: 2 },
      originalUrl: "https://example.slack.com/files/F12345678",
    }],
    memoryItemIds: ["mem_1"],
    evidenceSpanIds: ["span_1"],
  };
}
