import { z } from "zod";

const SlackPermalinkSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
}, { message: "Slack permalink must use an HTTPS slack.com host." });

const SlackPrivateFileUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && isAllowedSlackDownloadHost(url.hostname);
}, { message: "Slack private file URL must use an approved HTTPS Slack host." });

const SlackConversationSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  is_channel: z.boolean().optional(),
  is_group: z.boolean().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_ext_shared: z.boolean().optional(),
  is_ext_ws_shared: z.boolean().optional(),
  is_pending_ext_shared: z.boolean().optional(),
}).passthrough();

const SlackFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string().optional(),
  mimetype: z.string().min(1),
  filetype: z.string().optional(),
  size: z.number().int().min(0),
  url_private: SlackPrivateFileUrlSchema.optional(),
  url_private_download: SlackPrivateFileUrlSchema.optional(),
  permalink: SlackPermalinkSchema,
  mode: z.string().optional(),
  is_external: z.boolean().optional(),
}).passthrough();

const SlackMessageSchema = z.object({
  type: z.literal("message"),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
  user: z.string().min(1),
  text: z.string().default(""),
  files: z.array(z.object({ id: z.string().min(1) }).passthrough()).default([]),
}).passthrough();

export type SlackConversation = z.infer<typeof SlackConversationSchema>;
export type SlackFile = z.infer<typeof SlackFileSchema>;
export type SlackMessage = z.infer<typeof SlackMessageSchema>;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackCode: string,
    readonly retryable: boolean,
  ) {
    super(`Slack API ${method} failed: ${slackCode}`);
    this.name = "SlackApiError";
  }
}

export class SlackWebClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly botToken: string,
    fetchImpl?: typeof fetch,
  ) {
    // Cloudflare's global fetch is binding-sensitive. Wrapping it prevents
    // `this.fetchImpl(...)` from invoking the platform function with the
    // SlackWebClient instance as its receiver (which throws TypeError).
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async getAuthIdentity(): Promise<{ teamId: string; userId: string; teamName?: string }> {
    const result = await this.api("auth.test", {});
    return z.object({
      team_id: z.string().min(1),
      user_id: z.string().min(1),
      team: z.string().optional(),
    }).passthrough().transform((value) => ({
      teamId: value.team_id,
      userId: value.user_id,
      ...(value.team ? { teamName: value.team } : {}),
    })).parse(result);
  }

  async getGrantedScopes(): Promise<string[]> {
    const { response } = await this.apiResponse("auth.test", {});
    const value = response.headers.get("x-oauth-scopes");
    if (!value) throw new SlackApiError("auth.test", "missing_scope_header", false);
    return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))].sort();
  }

  async getConversation(channelId: string): Promise<SlackConversation> {
    const result = await this.api("conversations.info", { channel: channelId });
    return SlackConversationSchema.parse(result.channel);
  }

  async getSelectedMessage(input: {
    channelId: string;
    messageTimestamp: string;
    threadTimestamp?: string | null;
  }): Promise<SlackMessage> {
    const exactWindow = {
      channel: input.channelId,
      oldest: input.messageTimestamp,
      latest: input.messageTimestamp,
      inclusive: true,
      limit: 1,
    };
    const result = input.threadTimestamp
      ? await this.api("conversations.replies", { ...exactWindow, ts: input.threadTimestamp })
      : await this.api("conversations.history", exactWindow);
    const messages = z.array(SlackMessageSchema).parse(result.messages ?? []);
    const message = messages.find((candidate) => candidate.ts === input.messageTimestamp);
    if (!message) throw new SlackApiError("conversations.history", "message_not_found", false);
    return message;
  }

  async getUserLabel(userId: string): Promise<string> {
    const result = await this.api("users.info", { user: userId });
    const user = z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      real_name: z.string().optional(),
      profile: z.object({
        display_name: z.string().optional(),
        real_name: z.string().optional(),
      }).passthrough().optional(),
    }).passthrough().parse(result.user);
    return user.profile?.display_name?.trim()
      || user.profile?.real_name?.trim()
      || user.real_name?.trim()
      || user.name?.trim()
      || user.id;
  }

  async getMessagePermalink(channelId: string, messageTimestamp: string): Promise<string> {
    const result = await this.api("chat.getPermalink", {
      channel: channelId,
      message_ts: messageTimestamp,
    });
    return SlackPermalinkSchema.parse(result.permalink);
  }

  async getFile(fileId: string): Promise<SlackFile> {
    const result = await this.api("files.info", { file: fileId });
    const parsed = SlackFileSchema.safeParse(result.file);
    if (!parsed.success) {
      throw new SlackApiError("files.info", "file_metadata_not_ready", true);
    }
    return parsed.data;
  }

  async downloadFile(file: SlackFile, maxBytes: number): Promise<Uint8Array> {
    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) throw new SlackApiError("files.download", "missing_download_url", false);
    let currentUrl = downloadUrl;
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const current = new URL(currentUrl);
      if (current.protocol !== "https:" || !isAllowedSlackDownloadHost(current.hostname)) {
        throw new SlackApiError("files.download", "unsafe_download_url", false);
      }
      response = await this.fetchImpl(currentUrl, {
        headers: redirectCount === 0 ? { Authorization: `Bearer ${this.botToken}` } : {},
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirectCount === 3) {
        throw new SlackApiError("files.download", "unsafe_download_redirect", false);
      }
      currentUrl = new URL(location, currentUrl).href;
    }
    if (!response) throw new SlackApiError("files.download", "download_failed", true);
    if (!response.ok) {
      throw new SlackApiError("files.download", `http_${response.status}`, response.status >= 500 || response.status === 429);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new SlackApiError("files.download", "file_too_large", false);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new SlackApiError("files.download", "file_too_large", false);
    return bytes;
  }

  async addReaction(input: { channelId: string; messageTimestamp: string; reaction: string }): Promise<void> {
    try {
      await this.api("reactions.add", {
        channel: input.channelId,
        timestamp: input.messageTimestamp,
        name: input.reaction,
      });
    } catch (error) {
      if (error instanceof SlackApiError && error.slackCode === "already_reacted") return;
      throw error;
    }
  }

  async removeReaction(input: { channelId: string; messageTimestamp: string; reaction: string }): Promise<void> {
    try {
      await this.api("reactions.remove", {
        channel: input.channelId,
        timestamp: input.messageTimestamp,
        name: input.reaction,
      });
    } catch (error) {
      if (error instanceof SlackApiError && error.slackCode === "no_reaction") return;
      throw error;
    }
  }

  async sendPrivateResponse(responseUrl: string | null | undefined, message: string): Promise<void> {
    if (!responseUrl) return;
    const parsedUrl = new URL(responseUrl);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "hooks.slack.com") {
      throw new SlackApiError("response_url", "unsafe_response_url", false);
    }
    const response = await this.fetchImpl(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: message }),
    });
    if (!response.ok) throw new SlackApiError("response_url", `http_${response.status}`, response.status >= 500 || response.status === 429);
  }

  private async api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.apiResponse(method, body)).result;
  }

  private async apiResponse(method: string, body: Record<string, unknown>): Promise<{
    response: Response;
    result: Record<string, unknown>;
  }> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: encodeSlackApiBody(body),
    });
    if (!response.ok) {
      throw new SlackApiError(method, `http_${response.status}`, response.status >= 500 || response.status === 429);
    }
    const result = z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }).passthrough().parse(await response.json());
    if (!result.ok) {
      const code = result.error ?? "unknown_error";
      throw new SlackApiError(method, code, isRetryableSlackCode(code));
    }
    return { response, result };
  }
}

function encodeSlackApiBody(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.set(key, String(value));
      continue;
    }
    params.set(key, JSON.stringify(value));
  }
  return params;
}

function isAllowedSlackDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "slack.com"
    || host.endsWith(".slack.com")
    || host.endsWith(".slack-edge.com")
    || host.endsWith(".slack-files.com")
    || host.endsWith(".amazonaws.com")
    || host.endsWith(".cloudfront.net");
}

function isRetryableSlackCode(code: string): boolean {
  return [
    "fatal_error",
    "internal_error",
    "ratelimited",
    "request_timeout",
    "service_unavailable",
    "external_channel_migrating",
  ].includes(code);
}
