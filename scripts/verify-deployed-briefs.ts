import fs from "node:fs";
import { LeadershipBriefSchema } from "@distillery/contracts";

const BASE_URL = "https://distillery-v0.angela-f4b.workers.dev";
const localEnv = readLocalEnv();

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/health`);
  if (!health.ok) throw new Error(`Live health failed with ${health.status}.`);
  console.log("health=ok");

  const shell = await fetch(`${BASE_URL}/briefs`);
  const shellText = await shell.text();
  if (!shell.ok || !shellText.includes("Leadership briefs") || !shellText.includes("/api/briefs")) {
    throw new Error("Live /briefs shell did not contain the expected reader UI.");
  }
  console.log("briefs_shell=ok");

  const unauthorized = await fetch(`${BASE_URL}/api/briefs`);
  if (unauthorized.status !== 401) throw new Error(`Expected unauthenticated /api/briefs to return 401, got ${unauthorized.status}.`);
  console.log("briefs_unauthenticated=ok (401)");

  const login = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: requiredEnv("DISTILLERY_APP_PASSWORD") }),
  });
  if (login.status !== 204) throw new Error(`Live shared-password login failed with ${login.status}.`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Live login did not set the session cookie.");

  const list = await fetch(`${BASE_URL}/api/briefs`, { headers: { cookie } });
  if (!list.ok) throw new Error(`Authenticated /api/briefs failed with ${list.status}.`);
  const briefs = LeadershipBriefSchema.array().parse(await list.json());
  console.log(`briefs_authenticated=ok (count=${briefs.length})`);

  const slackStatusResponse = await fetch(`${BASE_URL}/api/slack/status`, { headers: { cookie } });
  if (!slackStatusResponse.ok) throw new Error(`Authenticated Slack status failed with ${slackStatusResponse.status}.`);
  const slackStatus = await slackStatusResponse.json() as {
    configured?: boolean; allowedTeamMatches?: boolean; exactScopes?: boolean;
    allowedExternalChannelIds?: string[]; botUserId?: string;
    savedReaction?: string; processingReaction?: string;
  };
  if (
    !slackStatus.configured || !slackStatus.allowedTeamMatches || !slackStatus.exactScopes ||
    !slackStatus.allowedExternalChannelIds?.includes("C0BG2JXTG77") ||
    slackStatus.savedReaction !== "factory" || slackStatus.processingReaction !== "hourglass_flowing_sand"
  ) {
    throw new Error("Deployed Slack identity, scopes, reactions, or external-channel opt-in are not ready.");
  }
  console.log(`slack_status=ok (bot=${slackStatus.botUserId ?? "unknown"}, external_channels=${slackStatus.allowedExternalChannelIds.length})`);

  const first = briefs[0];
  if (first) {
    const detailShell = await fetch(`${BASE_URL}/briefs/${encodeURIComponent(first.id)}`);
    if (!detailShell.ok) throw new Error(`Live detail shell failed with ${detailShell.status}.`);
    const detail = await fetch(`${BASE_URL}/api/briefs/${encodeURIComponent(first.id)}`, { headers: { cookie } });
    if (!detail.ok) throw new Error(`Authenticated brief detail failed with ${detail.status}.`);
    const parsed = LeadershipBriefSchema.parse(await detail.json());
    if (parsed.citations.length === 0) throw new Error("Generated brief detail did not include evidence citations.");
    for (const citation of parsed.citations) {
      if (!citation.exactText.trim()) throw new Error("Generated brief citation did not include exact evidence text.");
      if (citation.sourceType.startsWith("slack_") && !citation.originalUrl) {
        throw new Error("Slack-backed brief citation did not include an original Slack URL.");
      }
    }
    console.log(`brief_detail=ok (citations=${parsed.citations.length})`);
  } else {
    console.log("brief_detail=skipped (no generated brief)");
  }

  const slackProbe = await fetch(`${BASE_URL}/api/slack/interactions`, { method: "POST" });
  if (![401, 415, 503].includes(slackProbe.status)) {
    throw new Error(`Slack endpoint did not fail closed; received ${slackProbe.status}.`);
  }
  console.log(`slack_endpoint=fail_closed (${slackProbe.status})`);
  console.log("deployed_smoke=ok");
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
