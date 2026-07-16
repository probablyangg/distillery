import type {
  SlackMessageShortcutPayload,
  SlackSaveRegistrationResult,
} from "@distillery/contracts";
import { validateShortcutAttachments } from "./limits";
import {
  SlackRequestError,
  parseSlackInteractionBody,
  sha256Hex,
  verifySlackSignature,
} from "./security";

export type SlackInteractionConfig = {
  signingSecret: string;
  allowedTeamId: string;
  allowedChannelIds: Set<string>;
  allowedUserIds: Set<string>;
};

export type SlackSaveRegistrationInput = {
  tenantId: string;
  requestHash: string;
  workspaceId: string;
  channelId: string;
  messageTimestamp: string;
  threadTimestamp?: string;
  invokingUserId: string;
  responseUrl?: string;
  externalSourceId: string;
};

export interface SlackInteractionPersistence {
  createOrGetSlackSave(input: SlackSaveRegistrationInput): Promise<SlackSaveRegistrationResult>;
}

export type SlackQueue = {
  send(message: { workItemId: string }): Promise<unknown>;
};

export async function handleSlackInteraction(input: {
  request: Request;
  config: SlackInteractionConfig;
  tenantId: string;
  persistence: SlackInteractionPersistence;
  queue?: SlackQueue;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  now?: number;
  logger?: (fields: Record<string, unknown>) => void;
  onRegistered?: (result: SlackSaveRegistrationResult) => Promise<unknown>;
}): Promise<Response> {
  const contentType = input.request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    safeLog(input.logger, { event: "slack_interaction_rejected", reason: "unsupported_content_type" });
    return slackErrorResponse(new SlackRequestError(
      "Slack interactions must be form encoded.",
      415,
      "unsupported_content_type",
    ));
  }

  const rawBody = await input.request.text();
  try {
    await verifySlackSignature({
      rawBody,
      timestamp: input.request.headers.get("x-slack-request-timestamp"),
      signature: input.request.headers.get("x-slack-signature"),
      signingSecret: input.config.signingSecret,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch (error) {
    const requestError = asSlackRequestError(error);
    safeLog(input.logger, { event: "slack_interaction_rejected", reason: requestError.code });
    return slackErrorResponse(requestError);
  }

  let payload: SlackMessageShortcutPayload;
  try {
    payload = parseSlackInteractionBody(rawBody);
  } catch (error) {
    const requestError = asSlackRequestError(error);
    safeLog(input.logger, { event: "slack_interaction_rejected", reason: requestError.code });
    return slackErrorResponse(requestError);
  }

  const rejection = validateAccess(payload, input.config)
    ?? validateShortcutAttachments(payload.message.files ?? []);
  if (rejection) {
    safeLog(input.logger, {
      event: "slack_interaction_rejected",
      reason: "access_or_attachment_policy",
      workspaceId: payload.team.id,
      channelId: payload.channel.id,
      invokingUserId: payload.user.id,
    });
    schedulePrivateResponse({
      message: rejection,
      ...(payload.response_url ? { responseUrl: payload.response_url } : {}),
      ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return new Response(null, { status: 200 });
  }

  try {
    const requestHash = await sha256Hex(rawBody);
    const externalSourceId = `slack:${payload.team.id}:${payload.channel.id}:${payload.message.ts}`;
    const result = await input.persistence.createOrGetSlackSave({
      tenantId: input.tenantId,
      requestHash,
      workspaceId: payload.team.id,
      channelId: payload.channel.id,
      messageTimestamp: payload.message.ts,
      ...(payload.message.thread_ts ? { threadTimestamp: payload.message.thread_ts } : {}),
      invokingUserId: payload.user.id,
      ...(payload.response_url ? { responseUrl: payload.response_url } : {}),
      externalSourceId,
    });

    const background = Promise.resolve()
      .then(async () => {
        if (result.save.reactionStatus !== "added") await input.onRegistered?.(result);
      })
      .catch(() => {
        safeLog(input.logger, {
          event: "slack_processing_reaction_failed",
          connectorSaveId: result.save.id,
          workspaceId: result.save.workspaceId,
          channelId: result.save.channelId,
        });
      })
      .then(async () => {
        if (!result.replayed && result.workItemId && input.queue) {
          await input.queue.send({ workItemId: result.workItemId });
        }
      });
    if (input.waitUntil) input.waitUntil(background);
    else void background;
    safeLog(input.logger, {
      event: "slack_interaction_registered",
      workspaceId: payload.team.id,
      channelId: payload.channel.id,
      invokingUserId: payload.user.id,
      connectorSaveId: result.save.id,
      workItemId: result.workItemId ?? null,
      replayed: result.replayed,
    });
    return new Response(null, { status: 200 });
  } catch {
    safeLog(input.logger, {
      event: "slack_interaction_registration_failed",
      workspaceId: payload.team.id,
      channelId: payload.channel.id,
      invokingUserId: payload.user.id,
    });
    schedulePrivateResponse({
      message: "Distillery could not durably register this save. Nothing was stored and no reaction was added. Please try again.",
      ...(payload.response_url ? { responseUrl: payload.response_url } : {}),
      ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return new Response(null, { status: 503 });
  }
}

function safeLog(
  logger: ((fields: Record<string, unknown>) => void) | undefined,
  fields: Record<string, unknown>,
): void {
  try {
    logger?.(fields);
  } catch {
    // Logging is noncanonical and must never change request handling.
  }
}

function validateAccess(payload: SlackMessageShortcutPayload, config: SlackInteractionConfig): string | null {
  if (payload.team.id !== config.allowedTeamId) return "This Slack workspace is not allowed to save into Distillery.";
  if (!config.allowedUserIds.has(payload.user.id)) return "You are not in the Distillery pilot allowlist.";
  if (!config.allowedChannelIds.has(payload.channel.id)) return "This channel is not in the Distillery source allowlist.";
  if (payload.channel.id.startsWith("D")) return "Direct messages cannot be saved to Distillery.";
  return null;
}

function schedulePrivateResponse(input: {
  responseUrl?: string;
  message: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}): void {
  if (!input.responseUrl) return;
  const fetchImpl = input.fetchImpl ?? fetch;
  const request = Promise.resolve().then(() => fetchImpl(input.responseUrl!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: input.message }),
  })).then(() => undefined);
  if (input.waitUntil) input.waitUntil(request);
  else void request;
}

function slackErrorResponse(error: SlackRequestError): Response {
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asSlackRequestError(error: unknown): SlackRequestError {
  return error instanceof SlackRequestError
    ? error
    : new SlackRequestError("Slack request validation failed.", 400, "invalid_request");
}

export function parseCsvAllowlist(value: string): Set<string> {
  return new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
}
