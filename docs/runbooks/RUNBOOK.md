# Distillery runbook

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
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_FALLBACK_MODELS=~moonshotai/kimi-latest,moonshotai/kimi-k2.6
OPENROUTER_TIMEOUT_MS=30000
OPENROUTER_FALLBACK_TIMEOUT_MS=45000
EMBEDDING_PROVIDER=openrouter
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=google/gemini-embedding-001
EMBEDDING_DIMENSIONS=1536
EMBEDDING_ENCODING_FORMAT=float
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
pnpm retrieval:validate
pnpm build
```

`pnpm build` runs typecheck, tests, memory fixture validation, and retrieval fixture validation.

## Database migrations

Apply all migrations to a fresh database:

```bash
for migration in packages/db/migrations/*.sql; do
  psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f "$migration"
done
```

Apply only the latest migration after pulling new code:

```bash
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0011_hybrid_retrieval_rpcs.sql
```

Equivalent helper:

```bash
pnpm retrieval:migrate
```

Do not run migrations from the Cloudflare Worker. Migrations require `DATABASE_DIRECT_URL` from local/CI.

Current migration set:

- `0001_v0_memory_generation.sql` — tenants, ingestions, sources, evidence spans, extraction runs, memory items, outbox/audit/workflow tables.
- `0002_memory_item_corrections.sql` — confirm/edit/remove history and replacement memory.
- `0003_cited_recall.sql` — lexical recall and embedding tables.
- `0004_memory_synthesis.sql` — initiative briefs, evidence bindings, approval decisions.
- `0005_memgraphrag_schema_layer.sql` — `claimType`, memory entities, relations, schema candidates.
- `0006_backfill_memory_semantics.sql` — conservative semantic metadata for pre-schema-layer rows.
- `0007_loop_system.sql` — canonical loop tables, router/executor RPCs, proposed event commit path, and text capture `source_committed` write.
- `0008_loop_status_read_model.sql` — loop status read model for UI/API inspection.
- `0009_synthesize_brief_policy.sql` — `synthesize_brief` policy constraint, synthesis context RPC, semantic memory JSON projection, and atomic artifact-draft-to-initiative-brief commit path.
- `0010_claim_graph_memory_upgrade.sql` — claim graph pilot tables, memory-to-claim graph triggers, graph projection/retrieval RPCs, connection review, conflict resolution, claim preferences, generic `memory_embeddings`, and graph policy/event constraints.
- `0011_hybrid_retrieval_rpcs.sql` — hybrid retrieval candidate/snapshot/hydration RPCs, schema graph projection, and missing embedding target listing for backfill.

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

## Backfill retrieval embeddings

Hybrid retrieval needs embeddings for existing claims, evidence spans, entities, and schema patterns. New memory can store embeddings during extraction when embedding env vars are configured, but historical rows need a backfill.

Preview missing targets without writing:

```bash
pnpm retrieval:backfill -- --dry-run --batch-size 128
```

Backfill one batch:

```bash
pnpm retrieval:backfill -- --batch-size 128
```

Run repeatedly until `missing_targets=0`. The script is idempotent and writes through `distillery_upsert_memory_embeddings`.

## Reset pilot data

For pilots it is acceptable to clear application data and reseed.

This deletes all tenant-scoped app data while preserving schema/functions:

```bash
pnpm reset:stable
```

Equivalent SQL:

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
4. Open the loop status drawer and verify `source_committed`, routed work, policy run, proposal, and commit activity are visible.
5. Expand `Trace details` and verify entities, relations, schemas, and evidence.
6. Ask a recall question and confirm `retrievalMetadata.strategy` is `hybrid-graph-ppr-rerank`.
7. Open `/synthesis`.
8. Select memory.
9. Generate a brief draft. To test related-memory expansion through the API, call `POST /api/initiative-brief-drafts` with `expandRelatedMemory: true`.
10. Edit/save a brief.
11. Approve or reject it.
12. Open `/graph`.
13. Rebuild the graph if needed, inspect clusters, and test connection review, conflict resolution, pin, and exclude actions.

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
- `GET /graph` — claim graph review UI.
- `GET /assets/d3-local.js` — locally vendored D3 asset for the graph UI.

Session:

- `POST /login` — sets 30-day shared-password cookie.
- `POST /logout` — clears cookie.
- `GET /api/session` — checks current session.

Memory Generation and Recall:

- `POST /api/ingestions` — stores text evidence, commits `source_committed`, routes pending work, and wakes the loop runner.
- `GET /api/ingestions/{id}` — returns ingestion status, evidence, and memory items.
- `GET /api/loop-status` — returns UI-safe loop stages, timeline, and recent activity. Optional query params: `ingestionId`, `limit`.
- `POST /api/queries` — graph-grounded hybrid retrieval plus grounded answer generation. This path does not use the legacy DB lexical answer fallback.

Memory review:

- `GET /api/memory-items` — active memory with evidence.
- `POST /api/memory-items/{id}/actions` — confirm/edit/remove.
- `GET /api/memory-items/{id}/history` — memory correction history.

Memory Synthesis:

- `POST /api/initiative-brief-drafts` — generate editable brief draft from selected memory. Optional body field: `expandRelatedMemory` defaults to `false`; when `true`, the endpoint expands through the shared hybrid graph retriever and synthesis bundle builder.
- `POST /api/initiative-briefs` — save human-reviewed brief.
- `GET /api/initiative-briefs` — list briefs.
- `GET /api/initiative-briefs/{id}` — inspect one brief.
- `POST /api/initiative-briefs/{id}/decisions` — approve/reject.

Claim Graph:

- `GET /api/graph/clusters` — list graph clusters.
- `GET /api/graph/clusters/{id}` — inspect one graph cluster with claims, connections, and conflicts.
- `GET /api/graph/claims/{id}` — inspect one graph claim.
- `POST /api/graph/rebuild` — rebuild graph projection rows from current memory/claim state.
- `POST /api/graph/connections/{id}/review` — accept or reject a proposed claim connection.
- `POST /api/graph/conflicts/{id}/resolve` — resolve or dismiss a conflict group.
- `POST /api/graph/claims/{id}/pin` — pin or unpin a claim for review/synthesis.
- `POST /api/graph/claims/{id}/exclude-from-synthesis` — include or exclude a claim from synthesis.
