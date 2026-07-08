# Distillery v0 runbook

Use this document for local setup, database migration, seed/reset, deployment, and smoke testing.

## Prerequisites

- Node.js 22+
- pnpm 11+
- PostgreSQL client tools (`psql`)
- Supabase project
- Cloudflare account with Workers and Queues
- OpenRouter API key

## Environment files

Create local env files:

```bash
cp .env.example .env.local
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Populate `.env.local`:

```text
DATABASE_DIRECT_URL=...
DATABASE_URL=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=moonshotai/kimi-k2.7-code
OPENROUTER_FALLBACK_MODELS=~moonshotai/kimi-latest,moonshotai/kimi-k2.6
DISTILLERY_APP_PASSWORD=...
```

Populate `apps/web/.dev.vars` with Worker runtime secrets:

```text
DISTILLERY_APP_PASSWORD=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
OPENROUTER_API_KEY=...
```

Never commit `.env.local`, `.dev.vars`, database URLs, API keys, or Worker secrets.

## Local verification

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm build
```

`pnpm build` runs typecheck, tests, and fixture validation.

## Database migrations

Apply all migrations to a fresh database:

```bash
for migration in packages/db/migrations/*.sql; do
  psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f "$migration"
done
```

Apply only the latest migration after pulling new code:

```bash
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0006_backfill_memory_semantics.sql
```

Do not run migrations from the Cloudflare Worker. Migrations require `DATABASE_DIRECT_URL` from local/CI.

Current migration set:

- `0001_v0_memory_generation.sql` — tenants, ingestions, sources, evidence spans, extraction runs, memory items, outbox/audit/workflow tables.
- `0002_memory_item_corrections.sql` — confirm/edit/remove history and replacement memory.
- `0003_cited_recall.sql` — lexical recall and embedding tables.
- `0004_memory_synthesis.sql` — initiative briefs, evidence bindings, approval decisions.
- `0005_memgraphrag_schema_layer.sql` — `claimType`, memory entities, relations, schema candidates.
- `0006_backfill_memory_semantics.sql` — conservative semantic metadata for pre-schema-layer rows.

## Seed Stable starter data

```bash
pnpm seed:stable
```

This seeds:

- 10 approved Stable fixture braindumps;
- 32 confirmed memory items;
- 3 starter initiative briefs.

Use all fixtures only when intentionally loading the full eval corpus:

```bash
pnpm seed:stable -- --all
```

## Reset v0 data

For v0 pilots it is acceptable to clear application data and reseed.

This deletes all tenant-scoped app data while preserving schema/functions:

```bash
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction <<'SQL'
truncate table tenants cascade;
notify pgrst, 'reload schema';
SQL
```

Then reseed:

```bash
pnpm seed:stable
```

## Run locally

```bash
PATH=/opt/homebrew/bin:$PATH pnpm dev
```

Open the local URL printed by Wrangler.

Manual check:

1. Log in with `DISTILLERY_APP_PASSWORD`.
2. On `/`, paste a text braindump and click `Remember`.
3. Confirm memory items appear with `claimType`.
4. Expand `Trace details` and verify entities, relations, schemas, and evidence.
5. Ask a recall question.
6. Open `/synthesis`.
7. Select memory.
8. Generate a brief draft.
9. Edit/save a brief.
10. Approve or reject it.

## Deploy to Cloudflare

Preferred:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm deploy:cloudflare
```

The helper:

- verifies Cloudflare auth;
- creates the queue if needed;
- uploads Worker secrets from `.env.local`;
- deploys the Worker;
- health-checks the deployment.

Manual deploy:

```bash
pnpm exec wrangler queues create distillery-memory-generation
pnpm exec wrangler secret put DISTILLERY_APP_PASSWORD --config apps/web/wrangler.toml
pnpm exec wrangler secret put SUPABASE_URL --config apps/web/wrangler.toml
pnpm exec wrangler secret put SUPABASE_SECRET_KEY --config apps/web/wrangler.toml
pnpm exec wrangler secret put OPENROUTER_API_KEY --config apps/web/wrangler.toml
pnpm deploy
```

Live Worker:

```text
https://distillery-v0.angela-f4b.workers.dev
```

## Live smoke

```bash
pnpm smoke:live
```

The smoke test creates temporary rows, runs capture -> model generation -> memory commit -> brief creation -> approval, and cleans up.

## API reference

App routes:

- `GET /` — capture/recall UI.
- `GET /synthesis` — synthesis/brief review UI.

Session:

- `POST /login` — sets 30-day shared-password cookie.
- `POST /logout` — clears cookie.
- `GET /api/session` — checks current session.

Memory Generation:

- `POST /api/ingestions` — stores text evidence and queues memory generation.
- `GET /api/ingestions/{id}` — returns ingestion status, evidence, and memory items.
- `POST /api/queries` — deterministic cited recall.

Memory review:

- `GET /api/memory-items` — active memory with evidence.
- `POST /api/memory-items/{id}/actions` — confirm/edit/remove.
- `GET /api/memory-items/{id}/history` — memory correction history.

Memory Synthesis:

- `POST /api/initiative-brief-drafts` — generate editable brief draft from selected memory.
- `POST /api/initiative-briefs` — save human-reviewed brief.
- `GET /api/initiative-briefs` — list briefs.
- `GET /api/initiative-briefs/{id}` — inspect one brief.
- `POST /api/initiative-briefs/{id}/decisions` — approve/reject.
