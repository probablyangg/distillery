import { SlackMessageShortcutPayloadSchema, type SlackMessageShortcutPayload } from "@distillery/contracts";

export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export class SlackRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "SlackRequestError";
  }
}

export async function verifySlackSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  now?: number;
}): Promise<void> {
  const timestamp = input.timestamp ?? "";
  const signature = input.signature ?? "";
  if (!/^\d{10}$/u.test(timestamp) || !/^v0=[a-f0-9]{64}$/u.test(signature)) {
    throw new SlackRequestError("Slack signature headers are missing or malformed.", 401, "invalid_signature");
  }

  const requestSeconds = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1_000);
  if (Math.abs(nowSeconds - requestSeconds) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    throw new SlackRequestError("Slack request timestamp is outside the five-minute window.", 401, "stale_timestamp");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${input.rawBody}`),
  );
  const expected = `v0=${bytesToHex(new Uint8Array(digest))}`;
  if (!constantTimeEqual(expected, signature)) {
    throw new SlackRequestError("Slack signature verification failed.", 401, "invalid_signature");
  }
}

export function parseSlackInteractionBody(rawBody: string): SlackMessageShortcutPayload {
  if (rawBody.length === 0 || rawBody.length > 1_000_000) {
    throw new SlackRequestError("Slack interaction body is empty or too large.", 400, "malformed_form_payload");
  }
  const form = new URLSearchParams(rawBody);
  const payloadValues = form.getAll("payload");
  if (payloadValues.length !== 1 || payloadValues[0] === undefined) {
    throw new SlackRequestError("Slack interaction must contain exactly one payload field.", 400, "malformed_form_payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadValues[0]);
  } catch {
    throw new SlackRequestError("Slack interaction payload is not valid JSON.", 400, "malformed_form_payload");
  }

  const result = SlackMessageShortcutPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const callbackId = isRecord(parsed) ? parsed.callback_id : undefined;
    const wrongCallback = typeof callbackId === "string" && callbackId !== "save_to_distillery";
    throw new SlackRequestError(
      wrongCallback ? "Unsupported Slack shortcut callback." : "Slack interaction payload failed runtime validation.",
      400,
      wrongCallback ? "wrong_callback_id" : "invalid_payload",
    );
  }
  return result.data;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const input = new Uint8Array(source.byteLength);
  input.set(source);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
