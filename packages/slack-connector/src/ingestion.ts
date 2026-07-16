import type {
  ConnectorSourceInput,
  EvidenceSpan,
  SlackChannelProfile,
  SlackConnectorSave,
  SlackContextBundleCommitResult,
  SlackContextCommitInput,
  SlackContextRole,
  SlackSkippedAttachment,
} from "@distillery/contracts";
import { createTextEvidenceBundle } from "@distillery/evidence";
import type { SlackContextModel } from "@distillery/model-gateway";
import { z } from "zod";
import { SlackApiError, SlackWebClient, type SlackConversation, type SlackFile, type SlackMessage } from "./client";
import {
  SLACK_CONTEXT_SELECTION_VERSION,
  boundThreadMessages,
  canonicalJson,
  defaultSlackClassification,
  mergeDeterministicSlackIdentities,
  nearbyMessageCandidates,
  normalizedSlackMessageContent,
} from "./context";
import { parseDocxDocument, parsePdfDocument, SlackDocumentError } from "./documents";
import {
  MAX_SLACK_ATTACHMENTS,
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_TOTAL_FILE_BYTES,
  supportedSlackDocument,
} from "./limits";
import { sha256Hex } from "./security";

const DEFAULT_PROCESSING_REACTION = "hourglass_flowing_sand";

export interface SlackConnectorPersistence {
  getSlackConnectorSave(saveId: string): Promise<SlackConnectorSave>;
  markSlackConnectorSaveProcessing(saveId: string): Promise<void>;
  commitSlackContextBundle(input: SlackContextCommitInput): Promise<SlackContextBundleCommitResult>;
  recordSlackConnectorFailure(input: {
    saveId: string;
    errorCode: string;
    userMessage: string;
    retryable: boolean;
  }): Promise<{ save: SlackConnectorSave; workItemId?: string | null }>;
  markSlackReactionAdded(saveId: string): Promise<void>;
  recordSlackReactionFailure(input: {
    saveId: string;
    errorCode: string;
  }): Promise<{ save: SlackConnectorSave; workItemId?: string | null }>;
  isSlackConnectorExtractionComplete(saveId: string): Promise<boolean>;
}

export type WorkQueue = { send(message: { workItemId: string }): Promise<unknown> };

type SlackIngestionStage =
  | "load_conversation"
  | "validate_conversation"
  | "load_message"
  | "assemble_context"
  | "load_authors_and_permalinks"
  | "load_file_metadata"
  | "download_and_parse_attachments"
  | "classify_context"
  | "commit_context_bundle";

type PreparedMessage = {
  message: SlackMessage;
  role: SlackContextRole;
  selectionReason: string | null;
  authorId: string;
  authorLabel: string;
  permalink: string;
  content: string;
  source: ConnectorSourceInput;
};

export async function ingestSlackSource(input: {
  saveId: string;
  persistence: SlackConnectorPersistence;
  slack: SlackWebClient;
  contextModel: SlackContextModel;
  allowedExternalChannelIds: Set<string>;
  reaction: string;
  processingReaction?: string;
  queue?: WorkQueue;
  newId?: (prefix: string) => string;
  now?: () => Date;
}): Promise<{ sourceCount: number; reactionAdded: boolean; bundleChanged: boolean; skippedAttachmentCount: number }> {
  const newId = input.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);
  const capturedAt = (input.now?.() ?? new Date()).toISOString();
  const save = await input.persistence.getSlackConnectorSave(input.saveId);
  await input.persistence.markSlackConnectorSaveProcessing(save.id);
  let stage: SlackIngestionStage = "load_conversation";

  try {
    const conversation = await input.slack.getConversation(save.channelId);
    stage = "validate_conversation";
    const externallyShared = validateConversation(conversation, save.channelId, input.allowedExternalChannelIds);
    const channelProfile = channelProfileSnapshot(save, conversation, capturedAt, externallyShared);

    stage = "load_message";
    const selected = await input.slack.getSelectedMessage({
      channelId: save.channelId,
      messageTimestamp: save.messageTimestamp,
      ...(save.threadTimestamp ? { threadTimestamp: save.threadTimestamp } : {}),
    });

    stage = "assemble_context";
    const rootTimestamp = selected.thread_ts ?? selected.ts;
    const thread = await input.slack.getThread(save.channelId, rootTimestamp);
    const hasThread = Boolean(selected.thread_ts) || thread.some((message) => message.ts !== rootTimestamp);
    let messages: SlackMessage[];
    let selectionStrategy: SlackContextCommitInput["selectionStrategy"];
    let truncation;
    const nearbyReasons = new Map<string, string>();

    if (hasThread) {
      const bounded = boundThreadMessages({
        messages: thread,
        selectedTimestamp: selected.ts,
        rootTimestamp,
      });
      messages = bounded.messages;
      truncation = bounded.truncation;
      selectionStrategy = "thread";
    } else {
      const nearby = nearbyMessageCandidates(
        await input.slack.getNearbyTopLevelMessages({
          channelId: save.channelId,
          messageTimestamp: selected.ts,
          windowSeconds: 30 * 60,
        }),
        selected.ts,
      );
      let selectedNearby: SlackMessage[] = [];
      if (nearby.length > 0) {
        try {
          const response = await input.contextModel.selectNearbyContext({
            selectedMessage: { messageId: selected.ts, text: normalizedSlackMessageContent(selected) },
            candidates: nearby.map((message) => ({
              messageId: message.ts,
              text: normalizedSlackMessageContent(message),
              authorLabel: message.user ?? message.username ?? message.bot_id ?? "Slack app",
              occurredAt: slackTimestampToIso(message.ts),
            })),
          });
          const selectedIds = new Set(response.parsed.selected.map((item) => item.messageId));
          for (const item of response.parsed.selected) nearbyReasons.set(item.messageId, item.reason);
          selectedNearby = nearby.filter((message) => selectedIds.has(message.ts));
        } catch {
          selectedNearby = [];
        }
      }
      messages = [...selectedNearby, selected]
        .sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
      const chars = messages.reduce((sum, message) => sum + normalizedSlackMessageContent(message).length, 0);
      truncation = {
        truncated: false,
        messageLimitApplied: false,
        characterLimitApplied: false,
        originalMessageCount: messages.length,
        retainedMessageCount: messages.length,
        originalCharacterCount: chars,
        retainedCharacterCount: chars,
        omittedMessageTimestamps: [],
      };
      selectionStrategy = selectedNearby.length > 0 ? "nearby" : "selected_only";
    }

    if (!messages.some((message) => message.ts === selected.ts)) messages.push(selected);
    messages.sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));

    stage = "load_authors_and_permalinks";
    const userIds = [...new Set(messages.map((message) => message.user).filter((value): value is string => Boolean(value)))];
    const authorLabels = new Map(await Promise.all(userIds.map(async (userId) => [userId, await input.slack.getUserLabel(userId)] as const)));
    const permalinks = new Map(await Promise.all(messages.map(async (message) => [
      message.ts,
      await input.slack.getMessagePermalink(save.channelId, message.ts),
    ] as const)));

    const sources: ConnectorSourceInput[] = [];
    const bundleItems: SlackContextCommitInput["items"] = [];
    const channelSourceVersionId = newId("srcv");
    const channelContent = canonicalJson({
      workspaceId: channelProfile.workspaceId,
      channelId: channelProfile.channelId,
      channelName: channelProfile.channelName,
      topic: channelProfile.topic,
      purpose: channelProfile.purpose,
      isPublic: channelProfile.isPublic,
      isPrivate: channelProfile.isPrivate,
      externallyShared: channelProfile.externallyShared,
      slackConnect: channelProfile.slackConnect,
      externalTeamIds: channelProfile.externalTeamIds,
    });
    const channelExternalId = `slack_channel:${save.workspaceId}:${save.channelId}`;
    sources.push({
      sourceItemId: newId("src"),
      sourceVersionId: channelSourceVersionId,
      ingestionId: newId("ing"),
      sourceType: "slack_channel_profile",
      provider: "slack",
      externalId: channelExternalId,
      canonicalUrl: permalinks.get(selected.ts)!,
      authorId: null,
      authorLabel: "Slack channel profile",
      occurredAt: capturedAt,
      mimeType: "application/json",
      originalFilename: null,
      content: channelContent,
      contentHash: await sha256Hex(channelContent),
      sourceMetadata: { ...channelProfile, role: "channel_profile" },
      evidenceSpans: [],
    });
    bundleItems.push({
      id: newId("sctxi"),
      ordinal: 0,
      role: "channel_profile",
      requestedSourceVersionId: channelSourceVersionId,
      externalId: channelExternalId,
      selectionReason: "Immutable channel profile snapshot; background context only.",
      primary: false,
    });

    const preparedMessages: PreparedMessage[] = [];
    for (const [messageIndex, message] of messages.entries()) {
      const content = normalizedSlackMessageContent(message);
      const sourceVersionId = newId("srcv");
      const evidence = await createTextEvidenceBundle({
        sourceVersionId,
        text: content,
        newSpanId: () => newId("evspan"),
      });
      const permalink = permalinks.get(message.ts)!;
      const authorId = message.user ?? message.bot_id ?? "slack_system";
      const authorLabel = message.user
        ? authorLabels.get(message.user) ?? message.user
        : message.username ?? (message.bot_id ? `Slack app ${message.bot_id}` : "Slack system");
      const role: SlackContextRole = message.ts === selected.ts
        ? "selected_message"
        : message.ts === rootTimestamp
          ? "thread_root"
          : hasThread
            ? "thread_reply"
            : "nearby_context";
      const selectionReason = role === "nearby_context" ? nearbyReasons.get(message.ts) ?? null : null;
      const contentHash = await sha256Hex(canonicalJson({
        content: evidence.normalizedText,
        edited: message.edited ?? null,
        blocks: message.blocks,
        attachments: message.attachments,
      }));
      const messageEvidence = evidence.evidenceSpans.map((span): EvidenceSpan => ({
        ...span,
        locator: {
          provider: "slack",
          messageTimestamp: message.ts,
          threadTimestamp: message.thread_ts ?? (hasThread ? rootTimestamp : undefined),
          permalink,
          startChar: span.startChar,
          endChar: span.endChar,
        },
      }));
      const externalId = `slack_message:${save.workspaceId}:${save.channelId}:${message.ts}`;
      const source: ConnectorSourceInput = {
        sourceItemId: newId("src"),
        sourceVersionId,
        ingestionId: newId("ing"),
        sourceType: "slack_message",
        provider: "slack",
        externalId,
        canonicalUrl: permalink,
        authorId,
        authorLabel,
        occurredAt: slackTimestampToIso(message.ts),
        mimeType: "text/plain",
        originalFilename: null,
        content: evidence.normalizedText,
        contentHash,
        sourceMetadata: {
          connector: "slack",
          workspaceId: save.workspaceId,
          channelId: save.channelId,
          channelName: channelProfile.channelName,
          messageTimestamp: message.ts,
          threadTimestamp: message.thread_ts ?? (hasThread ? rootTimestamp : null),
          permalink,
          invokingUserId: save.invokingUserId,
          authorId,
          authorLabel,
          occurredAt: slackTimestampToIso(message.ts),
          edited: message.edited ?? null,
          subtype: message.subtype ?? null,
          botId: message.bot_id ?? null,
          exactText: message.text,
          blocks: message.blocks,
          attachments: message.attachments,
          contextRole: role,
        },
        evidenceSpans: messageEvidence,
      };
      sources.push(source);
      bundleItems.push({
        id: newId("sctxi"),
        ordinal: messageIndex + 1,
        role,
        requestedSourceVersionId: sourceVersionId,
        externalId,
        selectionReason,
        primary: message.ts === selected.ts,
      });
      preparedMessages.push({ message, role, selectionReason, authorId, authorLabel, permalink, content, source });
    }

    stage = "load_file_metadata";
    const fileRefs = [...new Map(messages.flatMap((message) => message.files.map((file) => [file.id, { fileId: file.id, messageTimestamp: message.ts }]))).values()];
    const skippedAttachments: SlackSkippedAttachment[] = [];
    const supportedFiles: Array<{ file: SlackFile; messageTimestamp: string }> = [];
    let plannedBytes = 0;
    for (const fileRef of fileRefs) {
      const file = await input.slack.getFile(fileRef.fileId);
      const common = {
        fileId: file.id,
        filename: file.name,
        mimeType: file.mimetype,
        size: file.size,
        permalink: file.permalink,
        messageTimestamp: fileRef.messageTimestamp,
      };
      if (!supportedSlackDocument(file)) {
        skippedAttachments.push({ ...common, reason: "unsupported_media" });
      } else if (supportedFiles.length >= MAX_SLACK_ATTACHMENTS) {
        skippedAttachments.push({ ...common, reason: "attachment_limit" });
      } else if (file.size > MAX_SLACK_FILE_BYTES || plannedBytes + file.size > MAX_SLACK_TOTAL_FILE_BYTES) {
        skippedAttachments.push({ ...common, reason: "size_limit" });
      } else if (!file.url_private_download && !file.url_private) {
        skippedAttachments.push({ ...common, reason: "missing_download_url" });
      } else {
        plannedBytes += file.size;
        supportedFiles.push({ file, messageTimestamp: fileRef.messageTimestamp });
      }
    }

    stage = "download_and_parse_attachments";
    for (const [attachmentIndex, entry] of supportedFiles.entries()) {
      const bytes = await input.slack.downloadFile(entry.file, MAX_SLACK_FILE_BYTES);
      const sourceVersionId = newId("srcv");
      const kind = supportedSlackDocument(entry.file)!;
      const parsed = kind === "pdf"
        ? await parsePdfDocument({ bytes, sourceVersionId, permalink: entry.file.permalink, newSpanId: () => newId("evspan") })
        : await parseDocxDocument({ bytes, sourceVersionId, permalink: entry.file.permalink, newSpanId: () => newId("evspan") });
      const parent = preparedMessages.find((message) => message.message.ts === entry.messageTimestamp)!;
      const externalId = `slack_file:${save.workspaceId}:${entry.file.id}`;
      sources.push({
        sourceItemId: newId("src"),
        sourceVersionId,
        ingestionId: newId("ing"),
        sourceType: kind === "pdf" ? "slack_file_pdf" : "slack_file_docx",
        provider: "slack",
        externalId,
        canonicalUrl: entry.file.permalink,
        authorId: parent.authorId,
        authorLabel: parent.authorLabel,
        occurredAt: slackTimestampToIso(parent.message.ts),
        mimeType: entry.file.mimetype,
        originalFilename: entry.file.name,
        content: parsed.content,
        contentHash: parsed.contentHash,
        sourceMetadata: {
          connector: "slack",
          workspaceId: save.workspaceId,
          channelId: save.channelId,
          messageTimestamp: parent.message.ts,
          threadTimestamp: parent.message.thread_ts ?? (hasThread ? rootTimestamp : null),
          messagePermalink: parent.permalink,
          fileId: entry.file.id,
          filename: entry.file.name,
          title: entry.file.title ?? entry.file.name,
          mimeType: entry.file.mimetype,
          size: entry.file.size,
          permalink: entry.file.permalink,
          contentHash: parsed.contentHash,
          ...parsed.structure,
        },
        evidenceSpans: parsed.evidenceSpans,
      });
      bundleItems.push({
        id: newId("sctxi"),
        ordinal: messages.length + attachmentIndex + 1,
        role: "supported_attachment",
        requestedSourceVersionId: sourceVersionId,
        externalId,
        selectionReason: `Supported attachment on Slack message ${entry.messageTimestamp}.`,
        primary: false,
      });
    }

    stage = "classify_context";
    const conversationalTexts = preparedMessages.map((message) => message.content);
    let classification = defaultSlackClassification(conversationalTexts);
    try {
      classification = (await input.contextModel.classifySlackContext({
        channelProfile,
        selectedMessageTimestamp: selected.ts,
        items: preparedMessages.map((item) => ({
          role: item.role,
          messageTimestamp: item.message.ts,
          authorLabel: item.authorLabel,
          occurredAt: slackTimestampToIso(item.message.ts),
          text: item.content,
        })),
      })).parsed;
    } catch {
      // Unknown is the safe runtime-validated fallback. Context remains available to extraction.
    }
    classification = mergeDeterministicSlackIdentities(classification, conversationalTexts);

    const hashMaterial = {
      channelProfile: channelContent,
      selectionStrategy,
      selectionVersion: SLACK_CONTEXT_SELECTION_VERSION,
      messages: preparedMessages.map((item) => ({
        externalId: item.source.externalId,
        contentHash: item.source.contentHash,
        role: item.role,
        selectionReason: item.selectionReason,
      })),
      attachments: sources.filter((source) => source.sourceType === "slack_file_pdf" || source.sourceType === "slack_file_docx")
        .map((source) => ({ externalId: source.externalId, contentHash: source.contentHash })),
      skippedAttachments,
      truncation,
    };

    stage = "commit_context_bundle";
    const committed = await input.persistence.commitSlackContextBundle({
      id: newId("sctx"),
      saveId: save.id,
      selectedMessageTimestamp: selected.ts,
      threadTimestamp: hasThread ? rootTimestamp : null,
      channelProfile,
      selectionStrategy,
      selectionVersion: SLACK_CONTEXT_SELECTION_VERSION,
      contentHash: await sha256Hex(canonicalJson(hashMaterial)),
      capturedAt,
      externallyShared,
      truncation,
      classification,
      skippedAttachments,
      sources,
      items: bundleItems,
    });
    if (skippedAttachments.length > 0) {
      await safePrivateResponse(
        input.slack,
        save.responseUrl,
        `Distillery saved the textual Slack context. It skipped unsupported or over-limit attachments: ${skippedAttachments.map((file) => file.filename).join(", ")}. Their contents were not analyzed.`,
      );
    }
    return {
      sourceCount: committed.bundle.items.length,
      reactionAdded: false,
      bundleChanged: committed.changed,
      skippedAttachmentCount: skippedAttachments.length,
    };
  } catch (error) {
    const errorKind = safeIngestionErrorKind(error);
    const failure = classifyIngestionError(error, stage, errorKind);
    console.error(JSON.stringify({
      event: "slack_connector_ingestion_failed",
      connectorSaveId: save.id,
      stage,
      errorKind,
      retryable: failure.retryable,
    }));
    await input.persistence.recordSlackConnectorFailure({
      saveId: save.id,
      errorCode: failure.code,
      userMessage: failure.message,
      retryable: failure.retryable,
    });
    await safePrivateResponse(input.slack, save.responseUrl, failure.message);
    return { sourceCount: 0, reactionAdded: false, bundleChanged: false, skippedAttachmentCount: 0 };
  }
}

export async function syncSlackReaction(input: {
  saveId: string;
  persistence: SlackConnectorPersistence;
  slack: SlackWebClient;
  reaction: string;
  processingReaction?: string;
  queue?: WorkQueue;
}): Promise<{ sourceCount: number; reactionAdded: boolean }> {
  const save = await input.persistence.getSlackConnectorSave(input.saveId);
  if (save.status !== "completed") return { sourceCount: 0, reactionAdded: false };
  if (!await input.persistence.isSlackConnectorExtractionComplete(save.id)) {
    return { sourceCount: 0, reactionAdded: false };
  }
  return { sourceCount: 0, reactionAdded: await tryReaction({ ...input, save }) };
}

async function tryReaction(input: {
  save: SlackConnectorSave;
  persistence: SlackConnectorPersistence;
  slack: SlackWebClient;
  reaction: string;
  processingReaction?: string;
  queue?: WorkQueue;
}): Promise<boolean> {
  try {
    await input.slack.removeReaction({
      channelId: input.save.channelId,
      messageTimestamp: input.save.messageTimestamp,
      reaction: input.processingReaction ?? DEFAULT_PROCESSING_REACTION,
    });
    await input.slack.addReaction({
      channelId: input.save.channelId,
      messageTimestamp: input.save.messageTimestamp,
      reaction: input.reaction,
    });
    await input.persistence.markSlackReactionAdded(input.save.id);
    return true;
  } catch (error) {
    const code = error instanceof SlackApiError ? error.slackCode : "reaction_failed";
    const recorded = await input.persistence.recordSlackReactionFailure({ saveId: input.save.id, errorCode: code });
    await wake(input.queue, recorded.workItemId);
    return false;
  }
}

function channelProfileSnapshot(
  save: SlackConnectorSave,
  conversation: SlackConversation,
  capturedAt: string,
  externallyShared: boolean,
): SlackChannelProfile {
  const externalTeamIds = [...new Set([
    ...(conversation.shared_team_ids ?? []),
    ...(conversation.connected_team_ids ?? []),
  ].filter((teamId) => teamId !== save.workspaceId))].sort();
  return {
    workspaceId: save.workspaceId,
    channelId: save.channelId,
    channelName: conversation.name ?? "",
    topic: conversation.topic?.value ?? "",
    purpose: conversation.purpose?.value ?? "",
    isPublic: conversation.is_channel === true && conversation.is_private !== true,
    isPrivate: conversation.is_private === true || conversation.is_group === true,
    externallyShared,
    slackConnect: externallyShared,
    externalTeamIds,
    capturedAt,
  };
}

function validateConversation(
  conversation: SlackConversation,
  channelId: string,
  allowedExternalChannelIds: Set<string>,
): boolean {
  if (conversation.is_im) throw new ConnectorIngestionError("Direct messages cannot be saved to Distillery.", "direct_message_rejected", false);
  if (conversation.is_mpim) throw new ConnectorIngestionError("Group direct messages cannot be saved to Distillery.", "group_direct_message_rejected", false);
  if (conversation.is_member !== true) {
    throw new ConnectorIngestionError("Invite @Distillery to this channel before saving messages.", "bot_not_channel_member", false);
  }
  const externallyShared = Boolean(
    conversation.is_ext_shared || conversation.is_ext_ws_shared || conversation.is_pending_ext_shared || conversation.is_org_shared,
  );
  if (externallyShared && !allowedExternalChannelIds.has(channelId)) {
    throw new ConnectorIngestionError(
      "This Slack Connect channel is not explicitly enabled for Distillery.",
      "slack_connect_not_allowlisted",
      false,
    );
  }
  return externallyShared;
}

class ConnectorIngestionError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message);
  }
}

function classifyIngestionError(error: unknown, stage: SlackIngestionStage, errorKind: string): ConnectorIngestionError {
  if (error instanceof ConnectorIngestionError) return error;
  if (error instanceof SlackDocumentError) return new ConnectorIngestionError(error.message, error.code, false);
  if (error instanceof SlackApiError) {
    return new ConnectorIngestionError(
      error.retryable
        ? "Slack was temporarily unavailable while Distillery saved this message. The save will retry automatically."
        : "Slack did not allow Distillery to read the selected message or supported attachment. Nothing was saved.",
      error.slackCode,
      error.retryable,
    );
  }
  return new ConnectorIngestionError(
    "Distillery could not finish saving this Slack context. Nothing was committed and no completion reaction was added.",
    `connector_ingestion_failed_${stage}_${errorKind}`,
    true,
  );
}

function safeIngestionErrorKind(error: unknown): string {
  if (error instanceof ConnectorIngestionError) return error.code;
  if (error instanceof SlackDocumentError) return error.code;
  if (error instanceof SlackApiError) return error.slackCode;
  if (error instanceof z.ZodError) return "runtime_validation_error";
  if (error instanceof Error) {
    const supabase = error.message.match(/^Supabase RPC ([a-z0-9_]+) failed: (\d{3})\b/iu);
    if (supabase?.[1] && supabase[2]) return `supabase_rpc_${supabase[1]}_http_${supabase[2]}`;
    if (error instanceof TypeError) return "type_error";
    if (error instanceof RangeError) return "range_error";
    if (error instanceof ReferenceError) return "reference_error";
    if (error instanceof SyntaxError) return "syntax_error";
    return "error";
  }
  return "unknown_error";
}

function slackTimestampToIso(timestamp: string): string {
  return new Date(Number.parseFloat(timestamp) * 1_000).toISOString();
}

async function wake(queue: WorkQueue | undefined, workItemId: string | null | undefined): Promise<void> {
  if (!queue || !workItemId) return;
  try {
    await queue.send({ workItemId });
  } catch {
    // PostgreSQL holds the retry. Scheduled maintenance will send another wakeup.
  }
}

async function safePrivateResponse(slack: SlackWebClient, responseUrl: string | null | undefined, message: string): Promise<void> {
  try {
    await slack.sendPrivateResponse(responseUrl, message);
  } catch {
    // A response URL is short-lived and noncanonical. The connector state remains authoritative.
  }
}
