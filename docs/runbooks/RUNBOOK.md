# Distillery runbook

Use this document for local setup, database migration, seed/reset, deployment, and smoke testing.

## Prerequisites

- Node.js 22+
- pnpm 11+
- PostgreSQL client tools (`psql`)
- Supabase project
- Cloudflare account with Workers and Queues
- OpenRouter API key

Corpus-wide synthesis adds no service, account, hosted dependency, API key, graph database, or paid package. It reuses PostgreSQL/Supabase, Cloudflare Worker/Queue/Cron, the existing OpenRouter-compatible gateway, pgvector, and the existing TypeScript packages.

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
OPENROUTER_MODEL=openai/gpt-5
OPENROUTER_FALLBACK_MODELS=anthropic/claude-sonnet-4.5,moonshotai/kimi-k2.7-code,~moonshotai/kimi-latest
OPENROUTER_TIMEOUT_MS=60000
OPENROUTER_FALLBACK_TIMEOUT_MS=45000
MEMORY_EXTRACTOR_MODEL=
MEMORY_VERIFIER_MODEL=
MEMORY_CONNECTION_MODEL=
MEMORY_SECTION_PLANNER_MODEL=
MEMORY_SECTIONING_ENABLED=true
MEMORY_SECTION_TRIGGER_CHARS=6000
MEMORY_SECTION_TRIGGER_SPANS=20
MEMORY_SECTION_TARGET_CHARS=5000
MEMORY_SECTION_MAX_CHARS=8000
MEMORY_SECTION_MAX_SECTIONS=50
EMBEDDING_PROVIDER=openrouter
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=google/gemini-embedding-001
EMBEDDING_DIMENSIONS=1536
EMBEDDING_ENCODING_FORMAT=float
DISTILLERY_APP_PASSWORD=...
```

The four `MEMORY_*_MODEL` values are optional model-ID overrides. Leave them empty to use `OPENROUTER_MODEL` for that role. Section thresholds are positive integers. `TARGET_CHARS` must not exceed `MAX_CHARS`, and `MAX_SECTIONS` cannot exceed 50. Lower section sizes make more model calls and usually take longer.

Worker call sites currently set `maxFallbackModels: 1`. Only the first entry in `OPENROUTER_FALLBACK_MODELS` is attempted by the Worker; later entries remain available to standalone scripts that pass the full list.

Populate `apps/web/.dev.vars` with Worker runtime secrets:

```text
DISTILLERY_APP_PASSWORD=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
OPENROUTER_API_KEY=...
```

Never commit `.env.local`, `.dev.vars`, database URLs, API keys, or Worker secrets.

Environment-file responsibilities:

- `.env.local` is read by repository scripts such as migrations, seed/reset, backfill, deploy, smoke, and model evaluation.
- `apps/web/.dev.vars` is read by Wrangler and contains Worker runtime secrets only.
- `apps/web/wrangler.toml` contains non-secret local/deployed Worker variables, including model IDs and timeouts.
- Editing `.env.local` does not change `pnpm dev` model variables unless the corresponding value is also in `wrangler.toml` or passed to Wrangler by another supported mechanism.

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

Optional evaluators:

```bash
# Local and deterministic; reports connection density/score distributions.
pnpm exec tsx evals/runners/evaluate-memory-connections.ts

# Calls OpenRouter with the configured model and reports extraction quality.
pnpm exec tsx evals/runners/evaluate-memory-extraction.ts
```

The evaluators report measurements; they are not pass/fail build gates. The extraction evaluator requires `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, and `OPENROUTER_MODEL` in the process environment or `.env.local`.

## Database migrations

Apply all migrations to a fresh database:

```bash
for migration in packages/db/migrations/*.sql; do
  psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f "$migration"
done
```

If the database already has migrations through `0010`, apply every later migration in order:

```bash
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0011_hybrid_retrieval_rpcs.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0012_loop_leases_and_scheduled_recovery.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0013_corpus_wide_brief_synthesis.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0014_batch_auto_proposed_events.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0015_suppress_redundant_global_synthesis_events.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0016_automatic_memory_sectioning.sql
psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0017_prefer_current_capture_outbox.sql
```

Helper for migration `0011` only:

```bash
pnpm retrieval:migrate
```

`pnpm retrieval:migrate` always applies only `0011_hybrid_retrieval_rpcs.sql`. It does not apply later migrations and is not a general migration runner. Apply every missing migration in filename order.

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
- `0012_loop_leases_and_scheduled_recovery.sql` — atomic seed-source suppression, router/worker leases and fencing, abandoned-claim recovery, retry metadata, and lease-aware loop status.
- `0013_corpus_wide_brief_synthesis.sql` — independent enrichment events, versioned overlapping clusters, readiness history, suggested-brief versions, dirty-neighborhood scheduling, durable global scan cursor, and the corrected atomic artifact persistence function.
- `0014_batch_auto_proposed_events.sql` — one atomic RPC for creating, validating, and committing any number of auto-approved proposed events, avoiding Worker subrequest exhaustion during high-fan-out cluster projection.
- `0015_suppress_redundant_global_synthesis_events.sql` — one-time cleanup of redundant rollout-era global-sweep outbox rows after unchanged sweep projections became no-ops.
- `0016_automatic_memory_sectioning.sql` — canonical section plans/checkpoints, section work policies and events, idempotent retry-safe proposal/extraction functions, progress status v3, and section-plan completion tracking.
- `0017_prefer_current_capture_outbox.sql` — a lease-fenced outbox claim that may prioritize the current capture once before returning to FIFO order, preventing historical derived-work backlog from starving new Remember submissions.

Deployment order is database migration first, then Worker deployment. Roll back the Worker if new synthesis work produces repeated failures, unexpected queue growth, or readiness/draft duplication. Do not drop synthesis tables during an operational rollback. Preserve them for diagnosis and deploy a corrective forward migration. Migration `0015` changes only transport/outbox state for redundant global-sweep events; it does not delete evidence, memory, clusters, readiness evaluations, or briefs.

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

Hybrid retrieval needs embeddings for existing claims, evidence spans, entities, and schema patterns. New or edited memory is handled by the independent `update_embeddings` policy when embedding env vars are configured, but historical rows still need a backfill.

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
pnpm dev
```

Open the local URL printed by Wrangler.

Manual check:

1. Log in with `DISTILLERY_APP_PASSWORD`.
2. On `/`, paste a text braindump and click `Remember`.
3. Confirm memory items appear with `claimType`.
4. On `/synthesis`, check the pending-memory section. When the verifier marks a candidate `needs_review`, approve or reject its proposal there.
5. Open the loop status drawer and verify `source_committed`, routed work, policy run, proposal, and commit activity are visible.
6. Paste a document longer than 6,000 characters or with at least 20 nonempty lines. Verify the drawer shows that sectioning was used, its planned section count, current title, progress counts, and terminal success.
7. If a section fails, use the Retry button. Verify completed counts do not fall and only unfinished work resumes.
8. Expand `Trace details` and verify entities, relations, schemas, and evidence.
9. Ask a recall question and confirm `retrievalMetadata.strategy` is `hybrid-graph-ppr-rerank`.
10. Select memory on `/synthesis`.
11. Generate a brief draft. Related-memory expansion is the default. To test strict selection-only behavior through the API, call `POST /api/initiative-brief-drafts` with `expandRelatedMemory: false`.
12. Edit/save a brief.
13. Approve or reject it.
14. Open `/graph`.
15. Rebuild the graph if needed, inspect clusters, and test connection review, conflict resolution, pin, and exclude actions.

## Deploy to Cloudflare

Preferred:

```bash
pnpm deploy:cloudflare
```

The helper:

- verifies Cloudflare auth;
- creates the queue if needed;
- uploads Worker secrets from `.env.local`;
- deploys the Worker;
- explicitly applies the configured Cron and Queue triggers;
- health-checks the deployment.

The Worker configuration includes a one-minute Cron Trigger and a bounded Queue consumer. After migrations through `0017`, each scheduled maintenance pass recovers expired claims, requeues up to 25 recovered work items, schedules up to 4 synthesis scan events, and routes up to 4 outbox rows. Request-triggered routing and post-work downstream routing are also capped at 4 rows. The first request-triggered claim may prefer that new source; later claims remain FIFO. These deployed caps keep external database calls within the Worker invocation budget; PostgreSQL retains the remaining canonical work for later passes. Section work is canonical and independently leased, while each completed queue item gives the next section events a bounded chance to progress immediately. Clustering, readiness, and generation remain policy work, and unchanged global sweeps emit no cluster event. Do not manually change `running` rows while their lease is still valid.

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

This is a legacy direct Supabase/model integration smoke. It does not exercise the deployed HTTP login, Worker router, Queue consumer, Cron Trigger, or synthesis-opportunity UI. Its cleanup predates the corpus-synthesis tables and can race asynchronous loop work, so run it only against an isolated disposable database. Do not point it at production.

For a production-safe readiness check, use read-only requests: verify `/health`, load `/`, `/synthesis`, and `/graph`, log in, then call `GET /api/session`, `GET /api/loop-status`, `GET /api/memory-items`, `GET /api/synthesis/opportunities`, `GET /api/initiative-briefs`, and `GET /api/graph/clusters`. Inspect Worker logs for a successful scheduled pass and Queue messages before starting manual testing.

## API reference

App routes:

- `GET /health` — unauthenticated deployment health check.
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
- `POST /api/ingestions/{id}/retry` — resumes failed sectioned ingestion work while preserving completed section checkpoints.
- `GET /api/loop-status` — returns UI-safe loop stages, timeline, and recent activity. Optional query params: `ingestionId`, `limit`.
- `POST /api/queries` — graph-grounded hybrid retrieval plus grounded answer generation. This path does not use the legacy DB lexical answer fallback.
- `GET /api/memory-proposals` — pending valid memory proposals that require human review. Optional query param: `limit`.
- `POST /api/proposed-events/{id}/decision` — approve or reject a human-review proposal; approval commits the target event and resumes routing.

Memory review:

- `GET /api/memory-items` — active memory with evidence.
- `POST /api/memory-items/{id}/actions` — confirm/edit/remove.
- `GET /api/memory-items/{id}/history` — memory correction history.

Memory Synthesis:

- `GET /api/synthesis/opportunities` — ranked cluster opportunities with readiness reasons and bounded dossiers.
- The opportunities response also includes saved suggested versions, their current review status, and the fields changed since the prior version.
- `POST /api/initiative-brief-drafts` — generate an editable brief draft from selected retrieval seeds. `expandRelatedMemory` defaults to `true`; set it to `false` for explicit selection-only generation.
- `POST /api/initiative-briefs` — save human-reviewed brief.
- `GET /api/initiative-briefs` — list briefs.
- `GET /api/initiative-briefs/{id}` — inspect one brief.
- `PATCH /api/initiative-briefs/{id}` — update the editable fields of a draft brief. Approved or rejected briefs are not editable.
- `POST /api/synthesis/clusters/{id}/generate` — enqueue generation for a specific discovered cluster and optional intent; returns `202`.
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
