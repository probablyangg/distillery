import fs from "node:fs";
import { SupabaseLoopPersistence, SupabaseRpcClient } from "@distillery/db";
import { createPolicies, executeWorkItem, routeCommittedEvents } from "@distillery/loop";
import { ingestSlackSource, SlackWebClient, syncSlackReaction } from "@distillery/slack-connector";

const workItemId = requiredFlag("--work-item");
const fallbackSaveId = flagValue("--save-id");
if (!/^work_[0-9a-f-]+$/u.test(workItemId)) throw new Error("--work-item is not a valid work item ID.");
if (!process.argv.includes("--confirm-live")) {
  throw new Error("Pass --confirm-live to acknowledge that this claims canonical pilot work.");
}

const localEnv = readLocalEnv();
const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
if (!slackBotToken) throw new Error("Missing SLACK_BOT_TOKEN.");
const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseSecretKey = requiredEnv("SUPABASE_SECRET_KEY");

const followUpWorkItemIds: string[] = [];
const queue = {
  async send(message: { workItemId: string }): Promise<void> {
    followUpWorkItemIds.push(message.workItemId);
  },
};
const persistence = new SupabaseLoopPersistence(new SupabaseRpcClient({
  supabaseUrl,
  secretKey: supabaseSecretKey,
}));
const slack = new SlackWebClient(slackBotToken);
const reaction = requiredEnv("SLACK_SAVED_REACTION");
const processingReaction = process.env.SLACK_PROCESSING_REACTION?.trim() || "hourglass_flowing_sand";
const policies = createPolicies({
  persistence,
  memoryModel: {} as never,
  connectorPolicyRunner: {
    ingestSlackSource: (saveId) => ingestSlackSource({
      saveId,
      persistence,
      slack,
      reaction,
      processingReaction,
      queue,
    }),
    syncSlackReaction: (saveId) => syncSlackReaction({
      saveId,
      persistence,
      slack,
      reaction,
      processingReaction,
      queue,
    }),
  },
});

const executed = await executeWorkItem({ persistence, policies, workItemId });
const saveId = executed?.workItem.subjectId ?? fallbackSaveId;
if (!saveId) throw new Error("Canonical work item was unavailable; pass --save-id to route its committed sources.");
const save = await persistence.getSlackConnectorSave(saveId);
const sourceItemIds = [save.messageSourceId, ...save.attachmentSourceIds].filter((id): id is string => Boolean(id));
for (const sourceItemId of sourceItemIds) {
  const url = new URL(`${supabaseUrl.replace(/\/$/u, "")}/rest/v1/source_versions`);
  url.searchParams.set("select", "id");
  url.searchParams.set("source_item_id", `eq.${sourceItemId}`);
  url.searchParams.set("order", "version.desc");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: {
      apikey: supabaseSecretKey,
      Authorization: `Bearer ${supabaseSecretKey}`,
    },
  });
  if (!response.ok) throw new Error(`Source-version lookup failed with ${response.status}.`);
  const rows = await response.json() as Array<{ id: string }>;
  const sourceVersionId = rows[0]?.id;
  if (!sourceVersionId) throw new Error(`No source version exists for ${sourceItemId}.`);
  await routeCommittedEvents({ persistence, queue, maxRows: 1, preferredSubjectId: sourceVersionId });
}

console.log(`work_item=completed (${workItemId})`);
console.log(`follow_up_work_items=canonical (${followUpWorkItemIds.length})`);
console.log("manual_live_recovery=ok");

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
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}
