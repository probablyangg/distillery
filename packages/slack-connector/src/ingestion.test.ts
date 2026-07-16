import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SlackConnectorSave,
  SlackContextCommitInput,
} from "@distillery/contracts";

vi.mock("./documents", () => ({
  SlackDocumentError: class SlackDocumentError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
  },
  parsePdfDocument: vi.fn(async (input: { sourceVersionId: string; permalink: string }) => ({
    content: "Parsed PDF evidence.",
    contentHash: "d".repeat(64),
    evidenceSpans: [{
      id: `span_${input.sourceVersionId}`,
      sourceVersionId: input.sourceVersionId,
      startLine: 1,
      endLine: 1,
      startChar: 0,
      endChar: 20,
      text: "Parsed PDF evidence.",
      locator: { provider: "slack", permalink: input.permalink, pageNumber: 1 },
    }],
    structure: { pageCount: 1 },
  })),
  parseDocxDocument: vi.fn(async () => ({ content: "DOCX", contentHash: "e".repeat(64), evidenceSpans: [], structure: {} })),
}));

import { SlackApiError, type SlackMessage, type SlackWebClient } from "./client";
import { ingestSlackSource, syncSlackReaction, type SlackConnectorPersistence } from "./ingestion";

describe("context-aware Slack ingestion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures channel name/topic/purpose and a selected root with every reply in chronological roles", async () => {
    const committed: SlackContextCommitInput[] = [];
    const root = message("1752624000.000001", "Earn deposit does not advance.");
    const replies = [
      message("1752624002.000001", "Morpho had an outage associated with AWS.", root.ts),
      message("1752624001.000001", "Possibly regional.", root.ts),
      message("1752624003.000001", "Later tests worked.", root.ts),
    ];
    const slack = slackFake({
      getConversation: vi.fn(async () => ({
        id: "C12345678",
        name: "stablepay-war-room",
        is_channel: true,
        is_member: true,
        topic: { value: "StablePay production incidents" },
        purpose: { value: "Coordinate incident response" },
      })),
      getSelectedMessage: vi.fn(async () => root),
      getThread: vi.fn(async () => [root, ...replies]),
    });

    const result = await ingest({ slack, committed });

    expect(result).toMatchObject({ sourceCount: 5, bundleChanged: true });
    expect(committed[0]?.channelProfile).toMatchObject({
      channelName: "stablepay-war-room",
      topic: "StablePay production incidents",
      purpose: "Coordinate incident response",
      isPublic: true,
      externallyShared: false,
    });
    expect(committed[0]?.items.map((item) => item.role)).toEqual([
      "channel_profile",
      "selected_message",
      "thread_reply",
      "thread_reply",
      "thread_reply",
    ]);
    const messageSources = committed[0]?.sources.filter((source) => source.sourceType === "slack_message") ?? [];
    expect(messageSources.map((source) => source.content)).toEqual([
      "Earn deposit does not advance.",
      "Possibly regional.",
      "Morpho had an outage associated with AWS.",
      "Later tests worked.",
    ]);
    expect(messageSources.every((source) => source.externalId.startsWith("slack_message:T12345678:C12345678:"))).toBe(true);
    expect(messageSources[0]?.evidenceSpans[0]?.locator).toMatchObject({
      messageTimestamp: root.ts,
      permalink: expect.stringContaining(root.ts.replace(".", "")),
    });
  });

  it("loads the root and sibling replies when the selected message is a context-poor reply", async () => {
    const committed: SlackContextCommitInput[] = [];
    const root = message("1752624000.000001", "Can QA verify the v2.0.1 hotfix?");
    const selected = message("1752624002.000001", "Works for me", root.ts);
    const sibling = message("1752624001.000001", "The missing payment_id fix is on the hotfix branch.", root.ts);
    await ingest({
      committed,
      savePatch: { messageTimestamp: selected.ts, threadTimestamp: root.ts },
      slack: slackFake({
        getSelectedMessage: vi.fn(async () => selected),
        getThread: vi.fn(async () => [selected, root, sibling]),
      }),
    });
    expect(committed[0]?.items.map((item) => item.role)).toEqual([
      "channel_profile", "thread_root", "thread_reply", "selected_message",
    ]);
    expect(committed[0]?.sources.some((source) => source.content === "Works for me")).toBe(true);
    expect(committed[0]?.sources.some((source) => source.content.includes("missing payment_id"))).toBe(true);
  });

  it("preserves empty topic and purpose instead of inventing them from the channel name", async () => {
    const committed: SlackContextCommitInput[] = [];
    await ingest({
      committed,
      slack: slackFake({
        getConversation: vi.fn(async () => ({ id: "C12345678", name: "payments", is_member: true, is_channel: true })),
      }),
    });
    expect(committed[0]?.channelProfile).toMatchObject({ channelName: "payments", topic: "", purpose: "" });
  });

  it("uses only valid model-selected nearby messages and records short reasons", async () => {
    const committed: SlackContextCommitInput[] = [];
    const selected = message("1752624000.000001", "PAY-1719 still has no balance.");
    const before = message("1752623990.000001", "Linear created PAY-1719.");
    const after = message("1752624010.000001", "PAY-1719 moved to In Progress.");
    await ingest({
      committed,
      slack: slackFake({
        getSelectedMessage: vi.fn(async () => selected),
        getThread: vi.fn(async () => [selected]),
        getNearbyTopLevelMessages: vi.fn(async () => [before, after]),
      }),
      contextModel: contextModelFake({
        selectNearbyContext: vi.fn(async () => ({
          parsed: { selected: [{ messageId: after.ts, reason: "Same Linear issue ID." }] },
          raw: {},
          model: "context-model",
        })),
      }),
    });
    expect(committed[0]?.selectionStrategy).toBe("nearby");
    expect(committed[0]?.items.find((item) => item.role === "nearby_context")).toMatchObject({
      selectionReason: "Same Linear issue ID.",
    });
    expect(committed[0]?.classification.identities.issueTicketIds).toContain("PAY-1719");
  });

  it("selects no nearby context when the selector fails", async () => {
    const committed: SlackContextCommitInput[] = [];
    await ingest({
      committed,
      slack: slackFake({ getNearbyTopLevelMessages: vi.fn(async () => [message("1752623990.000001", "Unrelated")]) }),
      contextModel: contextModelFake({
        selectNearbyContext: vi.fn(async () => { throw new Error("invalid model output"); }),
      }),
    });
    expect(committed[0]?.selectionStrategy).toBe("selected_only");
    expect(committed[0]?.items.some((item) => item.role === "nearby_context")).toBe(false);
  });

  it("skips unsupported image/video attachments without failing textual capture and warns privately", async () => {
    const committed: SlackContextCommitInput[] = [];
    const selected = { ...message("1752624000.000001", "The text must still be saved."), files: [{ id: "F12345678" }, { id: "F87654321" }] };
    const slack = slackFake({
      getSelectedMessage: vi.fn(async () => selected),
      getThread: vi.fn(async () => [selected]),
      getFile: vi.fn(async (id: string) => file(id, id === "F12345678" ? "screenshot.png" : "demo.mp4", id === "F12345678" ? "image/png" : "video/mp4")),
    });
    const result = await ingest({ committed, slack });
    expect(result).toMatchObject({ bundleChanged: true, skippedAttachmentCount: 2 });
    expect(committed[0]?.sources.some((source) => source.content === "The text must still be saved.")).toBe(true);
    expect(committed[0]?.skippedAttachments.map((item) => item.filename)).toEqual(["screenshot.png", "demo.mp4"]);
    expect(slack.downloadFile).not.toHaveBeenCalled();
    expect(slack.sendPrivateResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("contents were not analyzed"),
    );
  });

  it("keeps supported PDF extraction as a separate attachment source", async () => {
    const committed: SlackContextCommitInput[] = [];
    const selected = { ...message("1752624000.000001", "See the attached brief."), files: [{ id: "F12345678" }] };
    await ingest({
      committed,
      slack: slackFake({
        getSelectedMessage: vi.fn(async () => selected),
        getThread: vi.fn(async () => [selected]),
        getFile: vi.fn(async () => file("F12345678", "brief.pdf", "application/pdf")),
      }),
    });
    expect(committed[0]?.sources.map((source) => source.sourceType)).toEqual([
      "slack_channel_profile", "slack_message", "slack_file_pdf",
    ]);
    expect(committed[0]?.items.at(-1)?.role).toBe("supported_attachment");
  });

  it("rejects Slack Connect by default and accepts only the explicit channel opt-in", async () => {
    const conversation = vi.fn(async () => ({ id: "C0BG2JXTG77", is_member: true, is_ext_shared: true, is_channel: true }));
    const rejectedPersistence = persistenceFake([]);
    await ingestSlackSource({
      saveId: "csave_1",
      persistence: rejectedPersistence,
      slack: slackFake({ getConversation: conversation }),
      contextModel: contextModelFake(),
      allowedExternalChannelIds: new Set(),
      reaction: "factory",
    });
    expect(rejectedPersistence.recordSlackConnectorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "slack_connect_not_allowlisted",
      retryable: false,
    }));

    const committed: SlackContextCommitInput[] = [];
    await ingest({
      committed,
      savePatch: { channelId: "C0BG2JXTG77" },
      slack: slackFake({ getConversation: conversation }),
      allowedExternalChannelIds: new Set(["C0BG2JXTG77"]),
    });
    expect(committed[0]?.externallyShared).toBe(true);
    expect(committed[0]?.channelProfile).toMatchObject({ externallyShared: true, slackConnect: true });
  });

  it("requires membership and rejects direct and group DMs before reading message history", async () => {
    for (const conversation of [
      { id: "C12345678", is_member: false },
      { id: "D12345678", is_member: true, is_im: true },
      { id: "G12345678", is_member: true, is_mpim: true },
    ]) {
      const persistence = persistenceFake([]);
      const slack = slackFake({ getConversation: vi.fn(async () => conversation) });
      await ingestSlackSource({
        saveId: "csave_1",
        persistence,
        slack,
        contextModel: contextModelFake(),
        allowedExternalChannelIds: new Set(),
        reaction: "factory",
      });
      expect(persistence.commitSlackContextBundle).not.toHaveBeenCalled();
      expect(slack.getSelectedMessage).not.toHaveBeenCalled();
    }
  });

  it("records only redacted operational diagnostics on commit failure", async () => {
    const persistence = persistenceFake([], {
      commitSlackContextBundle: vi.fn(async () => {
        throw new Error("Supabase RPC distillery_commit_slack_context_bundle failed: 500 secret message body");
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ingestSlackSource({
      saveId: "csave_1",
      persistence,
      slack: slackFake(),
      contextModel: contextModelFake(),
      allowedExternalChannelIds: new Set(),
      reaction: "factory",
    });
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("secret message body");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("commit_context_bundle"));
    consoleError.mockRestore();
  });
});

describe("Slack context reaction readiness", () => {
  it("keeps the hourglass until the current context extraction finishes", async () => {
    const persistence = persistenceFake([], {
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed" })),
      isSlackConnectorExtractionComplete: vi.fn(async () => false),
    });
    const slack = slackFake();
    await expect(syncSlackReaction({ saveId: "csave_1", persistence, slack, reaction: "factory" }))
      .resolves.toEqual({ sourceCount: 0, reactionAdded: false });
    expect(slack.removeReaction).not.toHaveBeenCalled();
  });

  it("removes hourglass and idempotently adds factory after extraction", async () => {
    const persistence = persistenceFake([], {
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed" })),
      isSlackConnectorExtractionComplete: vi.fn(async () => true),
    });
    const slack = slackFake();
    await expect(syncSlackReaction({ saveId: "csave_1", persistence, slack, reaction: "factory" }))
      .resolves.toEqual({ sourceCount: 0, reactionAdded: true });
    expect(slack.removeReaction).toHaveBeenCalledWith(expect.objectContaining({ reaction: "hourglass_flowing_sand" }));
    expect(slack.addReaction).toHaveBeenCalledWith(expect.objectContaining({ reaction: "factory" }));
  });

  it("keeps canonical retry work when the reaction call is throttled", async () => {
    const persistence = persistenceFake([], {
      getSlackConnectorSave: vi.fn(async () => save({ status: "completed" })),
      isSlackConnectorExtractionComplete: vi.fn(async () => true),
      recordSlackReactionFailure: vi.fn(async () => ({ save: save(), workItemId: "work_retry" })),
    });
    const send = vi.fn(async () => undefined);
    const slack = slackFake({ addReaction: vi.fn(async () => { throw new SlackApiError("reactions.add", "ratelimited", true); }) });
    await syncSlackReaction({ saveId: "csave_1", persistence, slack, reaction: "factory", queue: { send } });
    expect(send).toHaveBeenCalledWith({ workItemId: "work_retry" });
  });
});

async function ingest(input: {
  committed: SlackContextCommitInput[];
  slack?: SlackWebClient & Record<string, ReturnType<typeof vi.fn>>;
  contextModel?: ReturnType<typeof contextModelFake>;
  savePatch?: Partial<SlackConnectorSave>;
  allowedExternalChannelIds?: Set<string>;
}) {
  return ingestSlackSource({
    saveId: "csave_1",
    persistence: persistenceFake(input.committed, {
      getSlackConnectorSave: vi.fn(async () => save(input.savePatch)),
    }),
    slack: input.slack ?? slackFake(),
    contextModel: input.contextModel ?? contextModelFake(),
    allowedExternalChannelIds: input.allowedExternalChannelIds ?? new Set(),
    reaction: "factory",
    newId: sequentialIds(),
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
}

function persistenceFake(
  committed: SlackContextCommitInput[],
  overrides: Partial<Record<keyof SlackConnectorPersistence, ReturnType<typeof vi.fn>>> = {},
): SlackConnectorPersistence & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getSlackConnectorSave: vi.fn(async () => save()),
    markSlackConnectorSaveProcessing: vi.fn(async () => undefined),
    commitSlackContextBundle: vi.fn(async (context: SlackContextCommitInput) => {
      committed.push(context);
      return { bundle: { items: context.items }, created: true, changed: true } as never;
    }),
    recordSlackConnectorFailure: vi.fn(async () => ({ save: save({ status: "failed" }), workItemId: null })),
    markSlackReactionAdded: vi.fn(async () => undefined),
    recordSlackReactionFailure: vi.fn(async () => ({ save: save(), workItemId: null })),
    isSlackConnectorExtractionComplete: vi.fn(async () => true),
    ...overrides,
  } as SlackConnectorPersistence & Record<string, ReturnType<typeof vi.fn>>;
}

function slackFake(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): SlackWebClient & Record<string, ReturnType<typeof vi.fn>> {
  const selected = message("1752624000.000001", "Selected decision only.");
  return {
    getConversation: vi.fn(async () => ({ id: "C12345678", name: "pilot", is_channel: true, is_member: true, topic: { value: "" }, purpose: { value: "" } })),
    getSelectedMessage: vi.fn(async () => selected),
    getThread: vi.fn(async () => [selected]),
    getNearbyTopLevelMessages: vi.fn(async () => []),
    getUserLabel: vi.fn(async (userId: string) => userId === "U87654321" ? "Ada Lovelace" : userId),
    getMessagePermalink: vi.fn(async (channelId: string, timestamp: string) => `https://example.slack.com/archives/${channelId}/p${timestamp.replace(".", "")}`),
    getFile: vi.fn(),
    downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    sendPrivateResponse: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SlackWebClient & Record<string, ReturnType<typeof vi.fn>>;
}

function contextModelFake(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    selectNearbyContext: vi.fn(async () => ({ parsed: { selected: [] }, raw: {}, model: "context-model" })),
    classifySlackContext: vi.fn(async () => ({
      parsed: {
        category: "mixed" as const,
        rationale: "The thread contains an observation and later status.",
        identities: {
          products: ["StablePay"], featureComponents: ["Earn deposit"], externalServices: ["Morpho", "AWS"],
          issueTicketIds: [], releaseVersions: [], environments: [], namedOrganizations: [],
        },
      },
      raw: {},
      model: "context-model",
    })),
    ...overrides,
  };
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
    externalSourceId: "slack_message:T12345678:C12345678:1752624000.000001",
    status: "pending",
    workItemId: "work_slack_1",
    messageSourceId: null,
    attachmentSourceIds: [],
    currentContextBundleId: null,
    contextVersion: 0,
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

function message(ts: string, text: string, threadTimestamp?: string): SlackMessage {
  return {
    type: "message",
    ts,
    ...(threadTimestamp ? { thread_ts: threadTimestamp } : {}),
    user: "U87654321",
    text,
    files: [],
    blocks: [],
    attachments: [],
  };
}

function file(id: string, name: string, mimetype: string) {
  return {
    id, name, mimetype, filetype: name.split(".").at(-1), size: 1_024,
    permalink: `https://example.slack.com/files/${id}`,
    url_private_download: `https://files.slack.com/files-pri/${id}/${name}`,
  };
}

function sequentialIds(): (prefix: string) => string {
  let number = 0;
  return (prefix) => `${prefix}_${++number}`;
}
