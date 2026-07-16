import fs from "node:fs";
import { spawnSync } from "node:child_process";

const CONFIG_PATH = "apps/web/wrangler.toml";
const QUEUE_NAME = "distillery-memory-generation";
const SECRET_KEYS = [
  "DISTILLERY_APP_PASSWORD",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "OPENROUTER_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_ALLOWED_TEAM_ID",
  "SLACK_ALLOWED_CHANNEL_IDS",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_SAVED_REACTION",
] as const;

type LocalEnv = Record<string, string>;

function readLocalEnv(): LocalEnv {
  const envText = fs.readFileSync(".env.local", "utf8");
  const env: LocalEnv = {};

  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;

    let value = rawValue.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function requireEnv(env: LocalEnv, key: string): string {
  const value = env[key] ?? process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function run(label: string, args: string[], options: { input?: string; allowAlreadyExists?: boolean } = {}): string {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    input: options.input,
    encoding: "utf8",
    env: process.env,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (/register a workers\.dev subdomain|need a workers\.dev subdomain|workers\/onboarding/i.test(output)) {
      const onboardingUrl = output.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+\/workers\/onboarding/)?.[0];
      process.stderr.write(output);
      throw new Error(
        [
          "Cloudflare account setup is incomplete: register a workers.dev subdomain once, then rerun pnpm deploy:cloudflare.",
          onboardingUrl ? `Dashboard URL from Wrangler output: ${onboardingUrl}` : undefined,
          "Alternative: add a custom Worker route/custom domain in wrangler.toml and rerun deploy.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    if (options.allowAlreadyExists && /already exists|already taken|exists/i.test(output)) {
      console.log(`${label}=already_exists`);
      return output;
    }

    process.stderr.write(output);
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }

  console.log(`${label}=ok`);
  return output;
}

async function main(): Promise<void> {
  const env = readLocalEnv();
  requireEnv(env, "DISTILLERY_APP_PASSWORD");
  requireEnv(env, "SUPABASE_URL");
  requireEnv(env, "SUPABASE_SECRET_KEY");
  requireEnv(env, "OPENROUTER_API_KEY");
  requireEnv(env, "SLACK_BOT_TOKEN");
  requireEnv(env, "SLACK_SIGNING_SECRET");
  requireEnv(env, "SLACK_ALLOWED_TEAM_ID");
  requireEnv(env, "SLACK_ALLOWED_CHANNEL_IDS");
  requireEnv(env, "SLACK_ALLOWED_USER_IDS");
  requireEnv(env, "SLACK_SAVED_REACTION");

  run("cloudflare_auth", ["whoami"]);
  run("queue_create", ["queues", "create", QUEUE_NAME], { allowAlreadyExists: true });

  run("secrets", ["secret", "bulk", "--config", CONFIG_PATH], {
    input: JSON.stringify(Object.fromEntries(
      SECRET_KEYS.map((key) => [key, requireEnv(env, key)]),
    )),
  });

  const deployOutput = run("deploy", ["deploy", "--config", CONFIG_PATH]);
  run("triggers", ["triggers", "deploy", "--config", CONFIG_PATH]);
  const url = deployOutput.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];

  if (url) {
    const response = await fetch(`${url}/health`);
    if (!response.ok) {
      throw new Error(`health check failed: ${response.status} ${await response.text()}`);
    }

    console.log(`health=ok`);
    console.log(`url=${url}`);
  } else {
    console.log("url=not_found_in_wrangler_output");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
