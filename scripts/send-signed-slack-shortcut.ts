import fs from "node:fs";
import { createHmac } from "node:crypto";

const localEnv = readLocalEnv();

async function main(): Promise<void> {
  const signingSecret = requiredEnv("SLACK_SIGNING_SECRET");
  const workspaceId = requiredEnv("SLACK_ALLOWED_TEAM_ID");
  const channelId = requiredFlag("--channel");
  const messageTimestamp = requiredFlag("--message-ts");
  const authorUserId = requiredFlag("--author-user");
  const invokingUserId = requiredFlag("--invoking-user");
  const endpoint = flagValue("--endpoint")
    ?? "https://distillery-v0.angela-f4b.workers.dev/api/slack/interactions";
  if (!/^https:\/\//u.test(endpoint)) throw new Error("--endpoint must be an HTTPS URL.");

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const payload = {
    type: "message_action",
    callback_id: "save_to_distillery",
    action_ts: `${nowSeconds}.000001`,
    trigger_id: `synthetic.${nowSeconds}.distillery`,
    team: { id: workspaceId },
    channel: { id: channelId },
    user: { id: invokingUserId },
    message: {
      type: "message",
      user: authorUserId,
      ts: messageTimestamp,
      text: "Synthetic request uses Slack as the canonical message source.",
    },
  };
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${nowSeconds}:${rawBody}`)
    .digest("hex")}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Deployed Slack endpoint returned ${response.status}: ${responseBody.slice(0, 300)}`);
  }
  console.log(`endpoint=ok (${response.status})`);
  console.log(`external_source=slack_message:${workspaceId}:${channelId}:${messageTimestamp}`);
  console.log("synthetic_request=accepted");
  console.log("Check PostgreSQL canonical state and the Slack reaction before calling the worker path verified.");
}

function requiredFlag(name: string): string {
  const value = flagValue(name);
  if (!value) throw new Error(`Missing required flag: ${name}`);
  return value;
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function requiredEnv(name: string): string {
  const value = localEnv[name] ?? process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
