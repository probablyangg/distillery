import fs from "node:fs";
import { spawnSync } from "node:child_process";

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

const env = readLocalEnv();
const databaseUrl = requireEnv(env, "DATABASE_DIRECT_URL");

const result = spawnSync(
  "psql",
  [
    databaseUrl,
    "--set",
    "ON_ERROR_STOP=1",
    "--single-transaction",
    "--command",
    "truncate table tenants cascade;",
    "--command",
    "notify pgrst, 'reload schema';",
  ],
  {
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
