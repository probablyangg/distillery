import { describe, expect, it, vi } from "vitest";
import { SlackApiError, SlackWebClient, type SlackFile } from "./client";

describe("SlackWebClient", () => {
  it("invokes Cloudflare's binding-sensitive global fetch without a client receiver", async () => {
    const bindingSensitiveFetch = vi.fn(async function (this: unknown) {
      if (this instanceof SlackWebClient) throw new TypeError("Illegal invocation");
      return slackResponse({ channel: { id: "C12345678", name: "pilot", is_member: true } });
    });
    vi.stubGlobal("fetch", bindingSensitiveFetch);

    const client = new SlackWebClient("xoxb-test");
    await expect(client.getConversation("C12345678")).resolves.toMatchObject({
      id: "C12345678",
      is_member: true,
    });
    expect(bindingSensitiveFetch.mock.contexts[0]).not.toBe(client);

    vi.unstubAllGlobals();
  });

  it("resolves the installed bot and workspace identity without exposing the token", async () => {
    const client = new SlackWebClient("xoxb-test", async () => slackResponse({
      team_id: "T12345678",
      user_id: "U12345678",
      team: "Pilot Workspace",
    }));
    await expect(client.getAuthIdentity()).resolves.toEqual({
      teamId: "T12345678",
      userId: "U12345678",
      teamName: "Pilot Workspace",
    });
  });

  it("reads and normalizes the scopes granted to the installed bot token", async () => {
    const client = new SlackWebClient("xoxb-test", async () => slackResponse({}, { ok: true }, {
      "x-oauth-scopes": "users:read, commands,users:read",
    }));
    await expect(client.getGrantedScopes()).resolves.toEqual(["commands", "users:read"]);
  });

  it("fetches exactly the selected top-level message", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: formBody(init),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return slackResponse({
        messages: [message("1752624000.000001")],
      });
    });
    const client = new SlackWebClient("test-bot-token", fetchImpl);
    await expect(client.getSelectedMessage({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
    })).resolves.toMatchObject({ text: "Selected message" });
    expect(calls).toEqual([expect.objectContaining({
      url: "https://slack.com/api/conversations.history",
      body: {
        channel: "C12345678",
        oldest: "1752624000.000001",
        latest: "1752624000.000001",
        inclusive: "true",
        limit: "1",
      },
      authorization: "Bearer test-bot-token",
    })]);
  });

  it("uses conversations.replies for one selected threaded reply and does not ingest the thread", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(formBody(init));
      return slackResponse({ messages: [message("1752624000.000009")] });
    });
    const client = new SlackWebClient("xoxb-test", fetchImpl);
    await client.getSelectedMessage({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000009",
      threadTimestamp: "1752624000.000001",
    });
    expect(bodies[0]).toEqual({
      channel: "C12345678",
      oldest: "1752624000.000009",
      latest: "1752624000.000009",
      inclusive: "true",
      limit: "1",
      ts: "1752624000.000001",
    });
  });

  it("paginates the bounded nearby history window and returns unique top-level messages chronologically", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = formBody(init);
      bodies.push(body);
      return body.cursor
        ? slackResponse({ messages: [message("1752623999.000001")] })
        : slackResponse({
          messages: [
            message("1752624001.000001"),
            { ...message("1752623998.000001"), thread_ts: "1752623990.000001" },
          ],
          response_metadata: { next_cursor: "next-page" },
        });
    });
    const client = new SlackWebClient("xoxb-test", fetchImpl);
    await expect(client.getNearbyTopLevelMessages({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      windowSeconds: 1_800,
    })).resolves.toMatchObject([
      { ts: "1752623999.000001" },
      { ts: "1752624001.000001" },
    ]);
    expect(bodies).toEqual([
      expect.objectContaining({
        channel: "C12345678", oldest: "1752622200.000001", latest: "1752625800.000001",
        inclusive: "true", limit: "100",
      }),
      expect.objectContaining({ cursor: "next-page" }),
    ]);
  });

  it("treats already_reacted as a successful idempotent reaction", async () => {
    const fetchImpl = vi.fn(async () => slackResponse({}, { ok: false, error: "already_reacted" }));
    const client = new SlackWebClient("xoxb-test", fetchImpl);
    await expect(client.addReaction({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      reaction: "factory",
    })).resolves.toBeUndefined();
  });

  it("treats no_reaction as a successful idempotent reaction removal", async () => {
    const fetchImpl = vi.fn(async () => slackResponse({}, { ok: false, error: "no_reaction" }));
    const client = new SlackWebClient("xoxb-test", fetchImpl);
    await expect(client.removeReaction({
      channelId: "C12345678",
      messageTimestamp: "1752624000.000001",
      reaction: "hourglass_flowing_sand",
    })).resolves.toBeUndefined();
  });

  it("classifies Slack throttling as retryable", async () => {
    const client = new SlackWebClient("xoxb-test", async () => slackResponse({}, { ok: false, error: "ratelimited" }));
    await expect(client.getConversation("C12345678")).rejects.toMatchObject({
      slackCode: "ratelimited",
      retryable: true,
    });
  });

  it("treats incomplete newly uploaded file metadata as retryable", async () => {
    const client = new SlackWebClient("xoxb-test", async () => slackResponse({
      file: { id: "F12345678", name: "processing.docx" },
    }));
    await expect(client.getFile("F12345678")).rejects.toMatchObject({
      method: "files.info",
      slackCode: "file_metadata_not_ready",
      retryable: true,
    });
  });

  it("rejects a download whose actual body exceeds the bound", async () => {
    const file: SlackFile = {
      id: "F12345678",
      name: "brief.pdf",
      mimetype: "application/pdf",
      size: 4,
      permalink: "https://example.slack.com/files/F12345678",
      url_private_download: "https://files.slack.com/files-pri/test/brief.pdf",
    };
    const client = new SlackWebClient("xoxb-test", async () => new Response(new Uint8Array(9)));
    await expect(client.downloadFile(file, 8)).rejects.toMatchObject({
      slackCode: "file_too_large",
      retryable: false,
    });
  });

  it("never forwards the bot token across an allowed download redirect", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const file: SlackFile = {
      id: "F12345678",
      name: "brief.pdf",
      mimetype: "application/pdf",
      size: 4,
      permalink: "https://example.slack.com/files/F12345678",
      url_private_download: "https://files.slack.com/files-pri/test/brief.pdf",
    };
    const client = new SlackWebClient("xoxb-secret", async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://slack-files.s3.amazonaws.com/signed/brief.pdf" } })
        : new Response(new Uint8Array([1, 2, 3, 4]));
    });
    await expect(client.downloadFile(file, 8)).resolves.toHaveLength(4);
    expect(calls).toEqual([
      { url: file.url_private_download, authorization: "Bearer xoxb-secret" },
      { url: "https://slack-files.s3.amazonaws.com/signed/brief.pdf", authorization: null },
    ]);
  });

  it("rejects malicious private-file and permalink hosts returned by Slack API", async () => {
    const client = new SlackWebClient("xoxb-test", async () => slackResponse({
      file: {
        id: "F12345678",
        name: "brief.pdf",
        mimetype: "application/pdf",
        size: 4,
        permalink: "https://attacker.example/brief",
        url_private_download: "https://attacker.example/download",
      },
    }));
    await expect(client.getFile("F12345678")).rejects.toThrow();
  });

  it("refuses to post private error text to a non-Slack response URL", async () => {
    const fetchImpl = vi.fn();
    const client = new SlackWebClient("xoxb-test", fetchImpl);
    await expect(client.sendPrivateResponse("https://attacker.example/hook", "private error"))
      .rejects.toMatchObject({ slackCode: "unsafe_response_url", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function slackResponse(
  result: Record<string, unknown>,
  status: { ok: boolean; error?: string } = { ok: true },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ...status, ...result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function formBody(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init?.body)));
}

function message(timestamp: string) {
  return {
    type: "message",
    ts: timestamp,
    user: "U12345678",
    text: "Selected message",
    files: [],
  };
}
