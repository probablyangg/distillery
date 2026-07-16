import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSourceInput, SlackConnectorSave } from "@distillery/contracts";

vi.mock("./documents", () => {
  class SlackDocumentError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  }
  const parsed = async (input: { sourceVersionId: string; permalink: string }) => ({
    content: `Parsed document from ${input.permalink}`,
    contentHash: "d".repeat(64),
    evidenceSpans: [{
      id: `span_${input.sourceVersionId}`,
      sourceVersionId: input.sourceVersionId,
      startLine: 1,
      endLine: 1,
      startChar: 0,
      endChar: `Parsed document from ${input.permalink}`.length,
      text: `Parsed document from ${input.permalink}`,
      locator: { provider: "slack", permalink: input.permalink, pageNumber: 1 },
    }],
    structure: { pageCount: 1 },
  });
  return {
    SlackDocumentError,
    parsePdfDocument: vi.fn(parsed),
    parseDocxDocument: vi.fn(parsed),
  };
});

import { SlackApiError, type SlackWebClient } from "./client";
import { parsePdfDocument } from "./documents";
import { ingestSlackSource, syncSlackReaction, type SlackConnectorPersistence } from "./ingestion";

describe("Slack connector ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the exact selected message without adding the completion reaction", async () => {
    const events: string[] = [];
    let committedSources: ConnectorSourceInput[] = [];
    const persistence = persistenceFake({
      commitSlackConnectorSources: vi.fn(async ({ sources }) => {
        events.push("commit");
        committedSources = sources;
        return save({ status: "completed", reactionStatus: "pending" });
      }),
    });
    const slack = slackFake();

    await expect(ingestSlackSource({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
      newId: sequentialIds(),
    })).resolves.toEqual({ sourceCount: 1, reactionAdded: false });

    expect(events).toEqual(["commit"]);
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(committedSources).toHaveLength(1);
    expect(committedSources[0]).toMatchObject({
      sourceType: "slack_message",
      externalId: "slack:T12345678:C12345678:1752624000.000001",
      canonicalUrl: "https://example.slack.com/archives/C12345678/p1752624000000001",
      authorId: "U87654321",
      authorLabel: "Ada Lovelace",
      content: "Selected decision only.",
      sourceMetadata: expect.objectContaining({
        workspaceId: "T12345678",
        channelId: "C12345678",
        messageTimestamp: "1752624000.000001",
        invokingUserId: "U12345678",
      }),
    });
    expect(committedSources[0]?.evidenceSpans[0]?.locator).toMatchObject({
      messageTimestamp: "1752624000.000001",
      permalink: "https://example.slack.com/archives/C12345678/p1752624000000001",
    });
  });

  it("stores one source per supported attachment in one atomic commit", async () => {
    let committedSources: ConnectorSourceInput[] = [];
    const files = [file("F12345678", "brief.pdf", "application/pdf"), file(
      "F87654321",
      "decision.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )];
    const persistence = persistenceFake({
      commitSlackConnectorSources: vi.fn(async ({ sources }) => {
        committedSources = sources;
        return save({ status: "completed" });
      }),
    });
    const slack = slackFake({
      getSelectedMessage: vi.fn(async () => ({
        type: "message" as const,
        ts: "1752624000.000001",
        user: "U87654321",
        text: "Message with two files.",
        files: files.map(({ id }) => ({ id })),
      })),
      getFile: vi.fn(async (fileId: string) => files.find(({ id }) => id === fileId)!),
    });

    const result = await ingestSlackSource({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
      newId: sequentialIds(),
    });

    expect(result).toEqual({ sourceCount: 3, reactionAdded: false });
    expect(persistence.commitSlackConnectorSources).toHaveBeenCalledTimes(1);
    expect(committedSources.map((source) => source.sourceType)).toEqual([
      "slack_message",
      "slack_file_pdf",
      "slack_file_docx",
    ]);
    expect(committedSources.slice(1).map((source) => source.externalId)).toEqual([
      "slack_file:T12345678:F12345678",
      "slack_file:T12345678:F87654321",
    ]);
  });

  it("rejects Slack Connect before fetching source data or adding a reaction", async () => {
    const persistence = persistenceFake();
    const slack = slackFake({
      getConversation: vi.fn(async () => ({ id: "C12345678", is_member: true, is_ext_shared: true })),
    });

    await expect(ingestSlackSource({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
    })).resolves.toEqual({ sourceCount: 0, reactionAdded: false });
    expect(slack.getSelectedMessage).not.toHaveBeenCalled();
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "slack_connect_rejected",
      retryable: false,
    }));
    expect(slack.sendPrivateResponse).toHaveBeenCalled();
  });

  it("requires bot membership before reading the selected message", async () => {
    const persistence = persistenceFake();
    const slack = slackFake({
      getConversation: vi.fn(async () => ({ id: "C12345678", is_member: false })),
    });
    await ingestSlackSource({ saveId: "csave_1", persistence, slack, reaction: "factory" });
    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "bot_not_channel_member",
      retryable: false,
    }));
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
  });

  it("does not commit or react when any supported attachment cannot be parsed", async () => {
    vi.mocked(parsePdfDocument).mockRejectedValueOnce(new Error("parse failed"));
    const persistence = persistenceFake();
    const attachment = file("F12345678", "broken.pdf", "application/pdf");
    const slack = slackFake({
      getSelectedMessage: vi.fn(async () => ({
        type: "message" as const,
        ts: "1752624000.000001",
        user: "U87654321",
        text: "Attachment follows.",
        files: [{ id: attachment.id }],
      })),
      getFile: vi.fn(async () => attachment),
    });
    await ingestSlackSource({ saveId: "csave_1", persistence, slack, reaction: "factory" });
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      retryable: true,
    }));
  });

  it("records only redacted stage and error-kind diagnostics for unexpected commit failures", async () => {
    const persistence = persistenceFake({
      commitSlackConnectorSources: vi.fn(async () => {
        throw new Error("Supabase RPC distillery_commit_slack_connector_sources failed: 500 secret body");
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await ingestSlackSource({ saveId: "csave_1", persistence, slack: slackFake(), reaction: "factory" });

    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "connector_ingestion_failed_commit_sources_supabase_rpc_distillery_commit_slack_connector_sources_http_500",
      retryable: true,
    }));
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({
      event: "slack_connector_ingestion_failed",
      connectorSaveId: "csave_1",
      stage: "commit_sources",
      errorKind: "supabase_rpc_distillery_commit_slack_connector_sources_http_500",
      retryable: true,
    }));
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("secret body");
    consoleError.mockRestore();
  });

  it("rejects unsupported and oversized attachment metadata before download", async () => {
    for (const attachment of [
      file("F12345678", "sheet.xlsx", "application/vnd.ms-excel"),
      { ...file("F12345678", "external.pdf", "application/pdf"), is_external: true, mode: "external" },
      { ...file("F12345678", "huge.pdf", "application/pdf"), size: 10 * 1024 * 1024 + 1 },
    ]) {
      const persistence = persistenceFake();
      const slack = slackFake({
        getSelectedMessage: vi.fn(async () => ({
          type: "message" as const,
          ts: "1752624000.000001",
          user: "U87654321",
          text: "Attachment follows.",
          files: [{ id: attachment.id }],
        })),
        getFile: vi.fn(async () => attachment),
      });
      await ingestSlackSource({ saveId: "csave_1", persistence, slack, reaction: "factory" });
      expect(slack.downloadFile).not.toHaveBeenCalled();
      expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    }
  });

  it("records a retryable Slack download failure without committing partial source data", async () => {
    const persistence = persistenceFake();
    const attachment = file("F12345678", "brief.pdf", "application/pdf");
    const slack = slackFake({
      getSelectedMessage: vi.fn(async () => ({
        type: "message" as const,
        ts: "1752624000.000001",
        user: "U87654321",
        text: "Attachment follows.",
        files: [{ id: attachment.id }],
      })),
      getFile: vi.fn(async () => attachment),
      downloadFile: vi.fn(async () => { throw new SlackApiError("files.download", "http_503", true); }),
    });
    await ingestSlackSource({ saveId: "csave_1", persistence, slack, reaction: "factory" });
    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "http_503",
      retryable: true,
    }));
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
  });

  it("leaves canonical retry work for paced scheduled maintenance", async () => {
    const persistence = persistenceFake({
      recordSlackConnectorFailure: vi.fn(async () => ({ save: save(), workItemId: "work_retry_2" })),
    });
    const slack = slackFake({
      getConversation: vi.fn(async () => { throw new SlackApiError("conversations.info", "service_unavailable", true); }),
    });
    const send = vi.fn(async () => undefined);
    await expect(ingestSlackSource({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
      queue: { send },
    })).resolves.toEqual({ sourceCount: 0, reactionAdded: false });
    expect(persistence.recordSlackConnectorFailure).toHaveBeenCalled();
    expect(slack.sendPrivateResponse).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps committed source data and schedules only reaction retry when final synchronization fails", async () => {
    const persistence = persistenceFake({
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed", reactionStatus: "pending" })),
      recordSlackReactionFailure: vi.fn(async () => ({ save: save({ status: "completed", reactionStatus: "failed" }), workItemId: "work_reaction_2" })),
    });
    const send = vi.fn(async () => undefined);
    const slack = slackFake({
      addReaction: vi.fn(async () => { throw new SlackApiError("reactions.add", "ratelimited", true); }),
    });

    await expect(syncSlackReaction({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
      queue: { send },
    })).resolves.toEqual({ sourceCount: 0, reactionAdded: false });
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    expect(persistence.recordSlackConnectorFailure).not.toHaveBeenCalled();
    expect(persistence.recordSlackReactionFailure).toHaveBeenCalledWith({
      saveId: "csave_1",
      errorCode: "ratelimited",
    });
    expect(send).toHaveBeenCalledWith({ workItemId: "work_reaction_2" });
  });

  it("keeps the hourglass while extraction is still pending", async () => {
    const persistence = persistenceFake({
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed" })),
      isSlackConnectorExtractionComplete: vi.fn(async () => false),
    });
    const slack = slackFake();

    await expect(syncSlackReaction({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
    })).resolves.toEqual({ sourceCount: 0, reactionAdded: false });
    expect(slack.removeReaction).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
  });

  it("a completed repeated save only synchronizes the reaction and never re-ingests", async () => {
    const persistence = persistenceFake({
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed", reactionStatus: "failed" })),
    });
    const slack = slackFake();
    await expect(syncSlackReaction({
      saveId: "csave_1",
      persistence,
      slack,
      reaction: "factory",
    })).resolves.toEqual({ sourceCount: 0, reactionAdded: true });
    expect(persistence.commitSlackConnectorSources).not.toHaveBeenCalled();
    expect(slack.getSelectedMessage).not.toHaveBeenCalled();
    expect(slack.removeReaction).toHaveBeenCalledWith({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      reaction: "hourglass_flowing_sand",
    });
    expect(slack.addReaction).toHaveBeenCalledTimes(1);
  });
});

function persistenceFake(overrides: Partial<Record<keyof SlackConnectorPersistence, ReturnType<typeof vi.fn>>> = {}): SlackConnectorPersistence & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getSlackConnectorSave: vi.fn(async () => save()),
    markSlackConnectorSaveProcessing: vi.fn(async () => undefined),
    commitSlackConnectorSources: vi.fn(async () => save({ status: "completed" })),
    recordSlackConnectorFailure: vi.fn(async () => ({ save: save({ status: "failed" }), workItemId: null })),
    markSlackReactionAdded: vi.fn(async () => undefined),
    recordSlackReactionFailure: vi.fn(async () => ({ save: save({ status: "completed", reactionStatus: "failed" }), workItemId: null })),
    isSlackConnectorExtractionComplete: vi.fn(async () => true),
    ...overrides,
  } as SlackConnectorPersistence & Record<string, ReturnType<typeof vi.fn>>;
}

function slackFake(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): SlackWebClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getConversation: vi.fn(async () => ({ id: "C12345678", is_member: true })),
    getSelectedMessage: vi.fn(async () => ({
      type: "message" as const,
      ts: "1752624000.000001",
      user: "U87654321",
      text: "Selected decision only.",
      files: [],
    })),
    getUserLabel: vi.fn(async () => "Ada Lovelace"),
    getMessagePermalink: vi.fn(async () => "https://example.slack.com/archives/C12345678/p1752624000000001"),
    getFile: vi.fn(),
    downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    sendPrivateResponse: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SlackWebClient & Record<string, ReturnType<typeof vi.fn>>;
}

function save(overrides: Partial<SlackConnectorSave> = {}): SlackConnectorSave {
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
    workItemId: "work_slack_1",
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

function file(id: string, name: string, mimetype: string) {
  return {
    id,
    name,
    mimetype,
    filetype: name.split(".").at(-1),
    size: 1_024,
    permalink: `https://example.slack.com/files/${id}`,
    url_private_download: `https://files.slack.com/files-pri/${id}/${name}`,
  };
}

function sequentialIds(): (prefix: string) => string {
  let number = 0;
  return (prefix) => `${prefix}_${++number}`;
}
