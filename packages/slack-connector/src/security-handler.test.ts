import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SlackConnectorSave, SlackSaveRegistrationResult } from "@distillery/contracts";
import { handleSlackInteraction } from "./handler";
import {
  SlackRequestError,
  constantTimeEqual,
  parseSlackInteractionBody,
  verifySlackSignature,
} from "./security";

const NOW_MS = 1_752_624_000_000;
const NOW_SECONDS = String(Math.floor(NOW_MS / 1_000));
const SIGNING_SECRET = "test-signing-secret";

describe("Slack request security", () => {
  it("accepts a valid signature calculated over the exact raw form body", async () => {
    const rawBody = bodyFor(payload());
    await expect(verifySlackSignature({
      rawBody,
      timestamp: NOW_SECONDS,
      signature: signatureFor(rawBody),
      signingSecret: SIGNING_SECRET,
      now: NOW_MS,
    })).resolves.toBeUndefined();
  });

  it.each([
    ["missing", null, null, "invalid_signature"],
    ["invalid", NOW_SECONDS, `v0=${"0".repeat(64)}`, "invalid_signature"],
    ["stale", String(Number(NOW_SECONDS) - 301), "signed", "stale_timestamp"],
  ])("rejects %s signature input", async (_label, timestamp, requestedSignature, code) => {
    const rawBody = bodyFor(payload());
    const signature = requestedSignature === "signed" ? signatureFor(rawBody, timestamp!) : requestedSignature;
    await expect(verifySlackSignature({
      rawBody,
      timestamp,
      signature,
      signingSecret: SIGNING_SECRET,
      now: NOW_MS,
    })).rejects.toMatchObject({ code });
  });

  it("uses a length-independent comparison result", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different-and-longer")).toBe(false);
  });

  it("accepts the official message-action shape when Slack omits action_ts", () => {
    const value = payload();
    delete value.action_ts;
    expect(parseSlackInteractionBody(bodyFor(value))).toMatchObject({
      type: "message_action",
      callback_id: "save_to_distillery",
    });
  });

  it.each([
    ["", "malformed_form_payload"],
    ["payload=%7Bnot-json", "malformed_form_payload"],
    [bodyFor(payload({ callback_id: "wrong_action" })), "wrong_callback_id"],
    [bodyFor(payload({ type: "block_actions" })), "invalid_payload"],
  ])("rejects malformed interaction form %#", (rawBody, code) => {
    expect(() => parseSlackInteractionBody(rawBody)).toThrowError(
      expect.objectContaining<Partial<SlackRequestError>>({ code }),
    );
  });
});

describe("Slack message shortcut handler", () => {
  it("durably registers the save, enqueues only workItemId, and does not await the queue wakeup", async () => {
    const createOrGetSlackSave = vi.fn(async () => registration());
    let releaseQueue!: () => void;
    const queuePromise = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const send = vi.fn(() => queuePromise);
    const background: Promise<unknown>[] = [];
    const responsePromise = handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave },
      queue: { send },
      waitUntil: (promise) => background.push(promise),
      now: NOW_MS,
    });

    await expect(Promise.race([
      responsePromise.then(() => "acknowledged"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])).resolves.toBe("acknowledged");
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(createOrGetSlackSave).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "stable",
      workspaceId: "T12345678",
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      externalSourceId: "slack:T12345678:C12345678:1752624000.000001",
    }));
    expect(send).toHaveBeenCalledWith({ workItemId: "work_slack_1" });
    expect(background).toHaveLength(1);
    releaseQueue();
    await Promise.all(background);
  });

  it("adds the processing reaction before waking the extraction worker", async () => {
    const order: string[] = [];
    const background: Promise<unknown>[] = [];
    const response = await handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave: async () => registration() },
      onRegistered: async () => { order.push("hourglass"); },
      queue: { send: async () => { order.push("queue"); } },
      waitUntil: (promise) => background.push(promise),
      now: NOW_MS,
    });

    expect(response.status).toBe(200);
    await Promise.all(background);
    expect(order).toEqual(["hourglass", "queue"]);
  });

  it("acknowledges durable state when the noncanonical queue wakeup throws synchronously", async () => {
    const response = await handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave: async () => registration() },
      queue: { send() { throw new Error("queue unavailable"); } },
      waitUntil(promise) { void promise.catch(() => undefined); },
      now: NOW_MS,
    });
    expect(response.status).toBe(200);
  });

  it("does not enqueue an exact request replay", async () => {
    const send = vi.fn();
    const replay = registration({ replayed: true, workItemId: null, created: false });
    const response = await handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave: async () => replay },
      queue: { send },
      now: NOW_MS,
    });
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", { team: { id: "T99999999" } }],
    ["channel", { channel: { id: "C99999999" } }],
    ["user", { user: { id: "U99999999" } }],
    ["direct message", { channel: { id: "D12345678" } }],
  ])("fails closed for a disallowed %s and sends a private error", async (_label, patch) => {
    const createOrGetSlackSave = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const background: Promise<unknown>[] = [];
    const response = await handleSlackInteraction({
      request: signedRequest(payload(patch)),
      config: config({ allowedChannelIds: new Set(["C12345678", "D12345678"]) }),
      tenantId: "stable",
      persistence: { createOrGetSlackSave },
      waitUntil: (promise) => background.push(promise),
      fetchImpl,
      now: NOW_MS,
    });
    await Promise.all(background);
    expect(response.status).toBe(200);
    expect(createOrGetSlackSave).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hooks.slack.com/actions/test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects unsupported attachments without writing canonical state", async () => {
    const createOrGetSlackSave = vi.fn();
    const response = await handleSlackInteraction({
      request: signedRequest(payload({
        message: {
          ...payload().message,
          files: [{ id: "F12345678", name: "roadmap.xlsx", mimetype: "application/vnd.ms-excel" }],
        },
      })),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave },
      now: NOW_MS,
    });
    expect(response.status).toBe(200);
    expect(createOrGetSlackSave).not.toHaveBeenCalled();
  });

  it("returns 503 and no false success when atomic registration fails", async () => {
    const response = await handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave: async () => { throw new Error("database unavailable"); } },
      now: NOW_MS,
    });
    expect(response.status).toBe(503);
  });

  it("emits structured operational fields without secrets or source content", async () => {
    const logs: Record<string, unknown>[] = [];
    await handleSlackInteraction({
      request: signedRequest(payload()),
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave: async () => registration() },
      now: NOW_MS,
      logger: (fields) => logs.push(fields),
    });
    const serialized = JSON.stringify(logs);
    expect(logs).toEqual([expect.objectContaining({
      event: "slack_interaction_registered",
      workspaceId: "T12345678",
      channelId: "C12345678",
      connectorSaveId: "csave_1",
    })]);
    expect(serialized).not.toContain(SIGNING_SECRET);
    expect(serialized).not.toContain("hooks.slack.com");
    expect(serialized).not.toContain("A decision grounded in source evidence");
  });

  it("rejects malformed, stale, and incorrectly signed requests before persistence", async () => {
    const createOrGetSlackSave = vi.fn();
    const request = signedRequest(payload());
    request.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
    const response = await handleSlackInteraction({
      request,
      config: config(),
      tenantId: "stable",
      persistence: { createOrGetSlackSave },
      now: NOW_MS,
    });
    expect(response.status).toBe(401);
    expect(createOrGetSlackSave).not.toHaveBeenCalled();
  });
});

function payload(patch: Record<string, unknown> = {}): Record<string, any> {
  const base = {
    type: "message_action",
    callback_id: "save_to_distillery",
    action_ts: "1752624000.000002",
    trigger_id: "123.456.test",
    response_url: "https://hooks.slack.com/actions/test",
    team: { id: "T12345678", domain: "example" },
    channel: { id: "C12345678", name: "leadership" },
    user: { id: "U12345678", username: "angela" },
    message: {
      type: "message",
      user: "U87654321",
      ts: "1752624000.000001",
      text: "A decision grounded in source evidence.",
      files: [],
    },
  };
  return { ...base, ...patch };
}

function bodyFor(value: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(value) }).toString();
}

function signatureFor(rawBody: string, timestamp = NOW_SECONDS): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function signedRequest(value: Record<string, unknown>): Request {
  const rawBody = bodyFor(value);
  return new Request("https://distillery.example/api/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": NOW_SECONDS,
      "x-slack-signature": signatureFor(rawBody),
    },
    body: rawBody,
  });
}

function config(overrides: Partial<Parameters<typeof handleSlackInteraction>[0]["config"]> = {}) {
  return {
    signingSecret: SIGNING_SECRET,
    allowedTeamId: "T12345678",
    allowedChannelIds: new Set(["C12345678"]),
    allowedUserIds: new Set(["U12345678"]),
    ...overrides,
  };
}

function registration(overrides: Partial<SlackSaveRegistrationResult> = {}): SlackSaveRegistrationResult {
  const save: SlackConnectorSave = {
    id: "csave_1",
    tenantId: "stable",
    provider: "slack",
    workspaceId: "T12345678",
    channelId: "C12345678",
    messageTimestamp: "1752624000.000001",
    invokingUserId: "U12345678",
    externalSourceId: "slack:T12345678:C12345678:1752624000.000001",
    status: "pending",
    workItemId: "work_slack_1",
    attachmentSourceIds: [],
    reactionStatus: "pending",
    retryCount: 0,
    reactionRetryCount: 0,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
  return { save, workItemId: "work_slack_1", created: true, replayed: false, ...overrides };
}
