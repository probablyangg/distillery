import type {
  ConnectorSourceInput,
  EvidenceSpan,
  SlackConnectorSave,
} from "@distillery/contracts";
import { createTextEvidenceBundle } from "@distillery/evidence";
import { z } from "zod";
import { SlackApiError, SlackWebClient, type SlackFile } from "./client";
import { parseDocxDocument, parsePdfDocument, SlackDocumentError } from "./documents";
import {
  MAX_SLACK_ATTACHMENTS,
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_TOTAL_FILE_BYTES,
  supportedSlackDocument,
} from "./limits";

const DEFAULT_PROCESSING_REACTION = "hourglass_flowing_sand";

export interface SlackConnectorPersistence {
  getSlackConnectorSave(saveId: string): Promise<SlackConnectorSave>;
  markSlackConnectorSaveProcessing(saveId: string): Promise<void>;
  commitSlackConnectorSources(input: {
    saveId: string;
    sources: ConnectorSourceInput[];
  }): Promise<SlackConnectorSave>;
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
  | "load_author_and_permalink"
  | "load_file_metadata"
  | "validate_files"
  | "build_message_source"
  | "download_and_parse_attachments"
  | "commit_sources";

export async function ingestSlackSource(input: {
  saveId: string;
  persistence: SlackConnectorPersistence;
  slack: SlackWebClient;
  reaction: string;
  processingReaction?: string;
  queue?: WorkQueue;
  newId?: (prefix: string) => string;
}): Promise<{ sourceCount: number; reactionAdded: boolean }> {
  const newId = input.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);
  const save = await input.persistence.getSlackConnectorSave(input.saveId);
  if (save.status === "completed") {
    return syncSlackReaction(input);
  }
  await input.persistence.markSlackConnectorSaveProcessing(save.id);
  let stage: SlackIngestionStage = "load_conversation";

  try {
    const conversation = await input.slack.getConversation(save.channelId);
    stage = "validate_conversation";
    validateConversation(conversation);
    stage = "load_message";
    const message = await input.slack.getSelectedMessage({
      channelId: save.channelId,
      messageTimestamp: save.messageTimestamp,
      ...(save.threadTimestamp ? { threadTimestamp: save.threadTimestamp } : {}),
    });
    stage = "load_author_and_permalink";
    const [authorLabel, messagePermalink] = await Promise.all([
      input.slack.getUserLabel(message.user),
      input.slack.getMessagePermalink(save.channelId, save.messageTimestamp),
    ]);
    stage = "load_file_metadata";
    const files = await Promise.all(message.files.map((file) => input.slack.getFile(file.id)));
    stage = "validate_files";
    validateFiles(files);

    stage = "build_message_source";
    const sourceInputs: ConnectorSourceInput[] = [];
    const messageSourceVersionId = newId("srcv");
    const messageBundle = await createTextEvidenceBundle({
      sourceVersionId: messageSourceVersionId,
      text: message.text,
      newSpanId: () => newId("evspan"),
    });
    const occurredAt = slackTimestampToIso(message.ts);
    const messageEvidence = messageBundle.evidenceSpans.map((span): EvidenceSpan => ({
      ...span,
      locator: {
        provider: "slack",
        messageTimestamp: message.ts,
        permalink: messagePermalink,
        startChar: span.startChar,
        endChar: span.endChar,
      },
    }));
    sourceInputs.push({
      sourceItemId: newId("src"),
      sourceVersionId: messageSourceVersionId,
      ingestionId: newId("ing"),
      sourceType: "slack_message",
      provider: "slack",
      externalId: save.externalSourceId,
      canonicalUrl: messagePermalink,
      authorId: message.user,
      authorLabel,
      occurredAt,
      mimeType: "text/plain",
      originalFilename: null,
      content: messageBundle.normalizedText,
      contentHash: messageBundle.contentHash,
      sourceMetadata: {
        connector: "slack",
        workspaceId: save.workspaceId,
        channelId: save.channelId,
        messageTimestamp: message.ts,
        threadTimestamp: message.thread_ts ?? save.threadTimestamp ?? null,
        permalink: messagePermalink,
        invokingUserId: save.invokingUserId,
        authorId: message.user,
        authorLabel,
        occurredAt,
      },
      evidenceSpans: messageEvidence,
    });

    let downloadedBytes = 0;
    stage = "download_and_parse_attachments";
    for (const file of files) {
      downloadedBytes += file.size;
      if (downloadedBytes > MAX_SLACK_TOTAL_FILE_BYTES) {
        throw new ConnectorIngestionError("The supported attachments exceed the 25 MB total download limit.", "attachments_total_too_large", false);
      }
      const bytes = await input.slack.downloadFile(file, MAX_SLACK_FILE_BYTES);
      const sourceVersionId = newId("srcv");
      const kind = supportedSlackDocument(file);
      if (!kind) throw unsupportedFile(file);
      const parsed = kind === "pdf"
        ? await parsePdfDocument({
          bytes,
          sourceVersionId,
          permalink: file.permalink,
          newSpanId: () => newId("evspan"),
        })
        : await parseDocxDocument({
          bytes,
          sourceVersionId,
          permalink: file.permalink,
          newSpanId: () => newId("evspan"),
        });
      sourceInputs.push({
        sourceItemId: newId("src"),
        sourceVersionId,
        ingestionId: newId("ing"),
        sourceType: kind === "pdf" ? "slack_file_pdf" : "slack_file_docx",
        provider: "slack",
        externalId: `slack_file:${save.workspaceId}:${file.id}`,
        canonicalUrl: file.permalink,
        authorId: message.user,
        authorLabel,
        occurredAt,
        mimeType: file.mimetype,
        originalFilename: file.name,
        content: parsed.content,
        contentHash: parsed.contentHash,
        sourceMetadata: {
          connector: "slack",
          workspaceId: save.workspaceId,
          channelId: save.channelId,
          messageTimestamp: message.ts,
          threadTimestamp: message.thread_ts ?? save.threadTimestamp ?? null,
          messagePermalink,
          fileId: file.id,
          filename: file.name,
          title: file.title ?? file.name,
          mimeType: file.mimetype,
          size: file.size,
          downloadUrl: file.url_private_download ?? file.url_private ?? null,
          permalink: file.permalink,
          contentHash: parsed.contentHash,
          ...parsed.structure,
        },
        evidenceSpans: parsed.evidenceSpans,
      });
    }

    stage = "commit_sources";
    await input.persistence.commitSlackConnectorSources({ saveId: save.id, sources: sourceInputs });
    return { sourceCount: sourceInputs.length, reactionAdded: false };
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
    // Leave retryable ingestion work canonical and pending. Scheduled maintenance
    // wakes it once per minute, which gives newly uploaded Slack files time to
    // finish processing instead of exhausting every retry back-to-back.
    return { sourceCount: 0, reactionAdded: false };
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

function validateConversation(conversation: {
  is_im?: boolean | undefined;
  is_mpim?: boolean | undefined;
  is_member?: boolean | undefined;
  is_ext_shared?: boolean | undefined;
  is_ext_ws_shared?: boolean | undefined;
  is_pending_ext_shared?: boolean | undefined;
}): void {
  if (conversation.is_im) throw new ConnectorIngestionError("Direct messages cannot be saved to Distillery.", "direct_message_rejected", false);
  if (conversation.is_mpim) throw new ConnectorIngestionError("Group direct messages cannot be saved to Distillery.", "group_direct_message_rejected", false);
  if (conversation.is_ext_shared || conversation.is_ext_ws_shared || conversation.is_pending_ext_shared) {
    throw new ConnectorIngestionError("Slack Connect and externally shared channels cannot be saved to Distillery.", "slack_connect_rejected", false);
  }
  if (conversation.is_member !== true) {
    throw new ConnectorIngestionError("Invite @Distillery to this channel before saving messages.", "bot_not_channel_member", false);
  }
}

function validateFiles(files: SlackFile[]): void {
  if (files.length > MAX_SLACK_ATTACHMENTS) {
    throw new ConnectorIngestionError(`A saved message can include at most ${MAX_SLACK_ATTACHMENTS} PDF or DOCX attachments.`, "too_many_attachments", false);
  }
  let total = 0;
  for (const file of files) {
    if (!supportedSlackDocument(file)) throw unsupportedFile(file);
    if (file.size > MAX_SLACK_FILE_BYTES) {
      throw new ConnectorIngestionError(`Attachment “${file.name}” exceeds the 10 MB per-file limit.`, "attachment_too_large", false);
    }
    total += file.size;
  }
  if (total > MAX_SLACK_TOTAL_FILE_BYTES) {
    throw new ConnectorIngestionError("The supported attachments exceed the 25 MB total download limit.", "attachments_total_too_large", false);
  }
}

function unsupportedFile(file: Pick<SlackFile, "id" | "name">): ConnectorIngestionError {
  return new ConnectorIngestionError(
    `Unsupported attachment “${file.name || file.id}”. Distillery accepts only text-based PDF and DOCX files.`,
    "unsupported_attachment",
    false,
  );
}

class ConnectorIngestionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function classifyIngestionError(
  error: unknown,
  stage: SlackIngestionStage,
  errorKind: string,
): ConnectorIngestionError {
  if (error instanceof ConnectorIngestionError) return error;
  if (error instanceof SlackDocumentError) return new ConnectorIngestionError(error.message, error.code, false);
  if (error instanceof SlackApiError) {
    return new ConnectorIngestionError(
      error.retryable
        ? "Slack was temporarily unavailable while Distillery saved this message. The save will retry automatically."
        : "Slack did not allow Distillery to read the selected message or attachment. Nothing was saved.",
      error.slackCode,
      error.retryable,
    );
  }
  return new ConnectorIngestionError(
    "Distillery could not finish saving this Slack message. Nothing was committed and no reaction was added.",
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
