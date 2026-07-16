import fs from "node:fs";
import { SlackWebClient } from "@distillery/slack-connector";

const localEnv = readLocalEnv();
const REQUIRED_SCOPES = [
  "channels:history",
  "channels:read",
  "commands",
  "files:read",
  "groups:history",
  "groups:read",
  "reactions:write",
  "users:read",
] as const;

async function main(): Promise<void> {
  const botToken = requiredEnv("SLACK_BOT_TOKEN");
  const allowedTeamId = requiredEnv("SLACK_ALLOWED_TEAM_ID");
  const channelIds = csvEnv("SLACK_ALLOWED_CHANNEL_IDS");
  const userIds = csvEnv("SLACK_ALLOWED_USER_IDS");
  const reaction = envValue("SLACK_SAVED_REACTION") || "factory";
  const processingReaction = envValue("SLACK_PROCESSING_REACTION") || "hourglass_flowing_sand";
  if (reaction !== "factory") {
    throw new Error("SLACK_SAVED_REACTION must be factory for this private pilot.");
  }
  if (processingReaction !== "hourglass_flowing_sand") {
    throw new Error("SLACK_PROCESSING_REACTION must be hourglass_flowing_sand for this private pilot.");
  }

  const slack = new SlackWebClient(botToken);
  const grantedScopes = await slack.getGrantedScopes();
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !grantedScopes.includes(scope));
  const unexpectedScopes = grantedScopes.filter((scope) => !(REQUIRED_SCOPES as readonly string[]).includes(scope));
  if (missingScopes.length > 0 || unexpectedScopes.length > 0) {
    throw new Error([
      missingScopes.length > 0 ? `missing required scopes: ${missingScopes.join(", ")}` : "",
      unexpectedScopes.length > 0 ? `unexpected broader scopes: ${unexpectedScopes.join(", ")}` : "",
      "Update the app from config/slack/manifest.yaml and reinstall it.",
    ].filter(Boolean).join("; "));
  }
  console.log(`scopes=ok (${grantedScopes.length})`);
  const identity = await slack.getAuthIdentity();
  if (identity.teamId !== allowedTeamId) {
    throw new Error(`Slack token belongs to workspace ${identity.teamId}, not allowlisted workspace ${allowedTeamId}.`);
  }
  console.log(`workspace=ok (${identity.teamName ?? identity.teamId})`);

  for (const channelId of channelIds) {
    const channel = await slack.getConversation(channelId);
    if (channel.is_im || channel.is_mpim) {
      throw new Error(`Allowlisted channel ${channelId} is a direct-message conversation.`);
    }
    if (channel.is_ext_shared || channel.is_ext_ws_shared || channel.is_pending_ext_shared) {
      throw new Error(`Allowlisted channel ${channelId} is Slack Connect or externally shared.`);
    }
    if (channel.is_member !== true) {
      throw new Error(`Distillery bot is not a member of allowlisted channel ${channelId}.`);
    }
    console.log(`channel=ok (${channel.name ?? channel.id})`);
  }

  for (const userId of userIds) {
    const label = await slack.getUserLabel(userId);
    console.log(`user=ok (${label})`);
  }

  console.log(`reaction=ok (:${reaction}: is a built-in Slack emoji)`);
  console.log(`processing_reaction=ok (:${processingReaction}: is a built-in Slack emoji)`);
  console.log(`bot_user=ok (${identity.userId})`);
  console.log("slack_pilot=ready");
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csvEnv(name: string): string[] {
  const values = requiredEnv(name).split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one Slack ID.`);
  return [...new Set(values)];
}

function envValue(name: string): string | undefined {
  return localEnv[name] ?? process.env[name]?.trim();
}

function readLocalEnv(): Record<string, string> {
  if (!fs.existsSync(".env.local")) return {};
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
