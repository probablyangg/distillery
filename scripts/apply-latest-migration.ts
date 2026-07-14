import { spawnSync } from "node:child_process";
import fs from "node:fs";

type LocalEnv = Record<string, string>;

const migration = process.argv[2] ?? "packages/db/migrations/0011_hybrid_retrieval_rpcs.sql";
const databaseUrl = readLocalEnv().DATABASE_DIRECT_URL ?? process.env.DATABASE_DIRECT_URL?.trim();

if (!databaseUrl) {
  console.error("Missing DATABASE_DIRECT_URL. Set it before applying database migrations.");
  process.exit(1);
}

const result = spawnSync("psql", [
  databaseUrl,
  "--set",
  "ON_ERROR_STOP=1",
  "--single-transaction",
  "-f",
  migration,
], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);

function readLocalEnv(): LocalEnv {
  if (!fs.existsSync(".env.local")) return {};

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
