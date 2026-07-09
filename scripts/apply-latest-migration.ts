import { spawnSync } from "node:child_process";

const migration = process.argv[2] ?? "packages/db/migrations/0011_hybrid_retrieval_rpcs.sql";
const databaseUrl = process.env.DATABASE_DIRECT_URL?.trim();

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
