# Distillery v0 runbook

This runbook covers the current build path for the text-braindump Memory Generation slice.

## Local prerequisites

- Node.js 22 or later
- pnpm 11
- Supabase project with PostgreSQL and `pgvector`
- Cloudflare account with Workers and Queues
- OpenRouter key

## Local verification

```bash
pnpm install
pnpm build
PATH=/opt/homebrew/bin:$PATH pnpm exec wrangler deploy --config apps/web/wrangler.toml --dry-run --outdir /tmp/distillery-worker-dryrun
```

`pnpm build` runs:

- TypeScript typecheck;
- unit tests;
- Stable fixture validation.

Run the live end-to-end smoke when `.env.local` has Supabase, OpenRouter, and direct database credentials:

```bash
pnpm smoke:live
```

The live smoke creates temporary rows, verifies text capture -> live model memory generation -> memory storage -> initiative brief creation -> approval, and then deletes its temporary rows.

## Local app testing

Wrangler local dev reads Worker secrets from `apps/web/.dev.vars`.

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Populate `apps/web/.dev.vars` from `.env.local`:

```text
DISTILLERY_APP_PASSWORD=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
OPENROUTER_API_KEY=...
```

Run the Worker locally:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm dev
```

Open the local URL printed by Wrangler. Test:

1. log in with `DISTILLERY_APP_PASSWORD`;
2. paste a text braindump on `/`;
3. click `Remember`;
4. wait for memory items to appear;
5. ask a cited recall question in the same text box and click `Ask`;
6. open `/synthesis`;
7. select memory, write a brief, create it, and approve it.

## Model smoke status

The embedding model was probed successfully through OpenRouter.

The selected primary generation model is `moonshotai/kimi-k2.7-code`. OpenRouter lists it as MoonshotAI: Kimi K2.7 Code, released June 12, 2026, with a 262K-token context window and structured output support. v0 config uses this fallback chain:

```text
moonshotai/kimi-k2.7-code
  -> ~moonshotai/kimi-latest
  -> moonshotai/kimi-k2.6
```

The primary timeout is `OPENROUTER_TIMEOUT_MS=30000`; fallback timeout is `OPENROUTER_FALLBACK_TIMEOUT_MS=45000`. A live end-to-end smoke passed with the Moonshot primary model.

## Supabase migration

Apply the migration from local/CI using the direct database URL:

```bash
for migration in packages/db/migrations/*.sql; do
  psql "$DATABASE_DIRECT_URL" --set ON_ERROR_STOP=1 --single-transaction -f "$migration"
done
```

Do not run migrations from the Cloudflare Worker. The Worker uses Supabase HTTP/RPC at runtime.

The migration creates:

- v0 ledger tables for ingestions, source versions, evidence spans, extraction runs, memory items, audit events, workflow state, and outbox events;
- correction/history tables for append-only memory item confirm, edit, and remove events;
- Memory Synthesis tables for initiative briefs, brief-memory bindings, brief-evidence bindings, and approve/reject decision records;
- RPC functions used by the Worker:
  - `distillery_create_text_ingestion_with_evidence`;
  - `distillery_get_ingestion_context`;
  - `distillery_update_ingestion_status`;
  - `distillery_record_extraction_run`;
  - `distillery_commit_generated_memory`;
  - `distillery_fail_ingestion`;
  - `distillery_get_ingestion_result`;
  - `distillery_apply_memory_item_action`;
  - `distillery_get_memory_item_history`;
  - `distillery_recall_memory_lexical`;
  - `distillery_list_active_memory`;
  - `distillery_create_initiative_brief`;
  - `distillery_get_initiative_brief`;
  - `distillery_list_initiative_briefs`;
  - `distillery_record_initiative_brief_decision`.

## Cloudflare setup

Create the queue:

```bash
pnpm exec wrangler queues create distillery-memory-generation
```

Set secrets:

```bash
pnpm exec wrangler secret put DISTILLERY_APP_PASSWORD --config apps/web/wrangler.toml
pnpm exec wrangler secret put SUPABASE_URL --config apps/web/wrangler.toml
pnpm exec wrangler secret put SUPABASE_SECRET_KEY --config apps/web/wrangler.toml
pnpm exec wrangler secret put OPENROUTER_API_KEY --config apps/web/wrangler.toml
```

Deploy:

```bash
pnpm deploy
```

Or use the full deployment helper, which creates the queue, sets Worker secrets from `.env.local`, deploys, and health-checks the deployed Worker:

```bash
pnpm deploy:cloudflare
```

This command requires an interactive Wrangler login or `CLOUDFLARE_API_TOKEN` in the shell environment.

If Cloudflare reports that no `workers.dev` subdomain is registered, open the Workers onboarding page in the Cloudflare dashboard, claim a subdomain once, then rerun:

```bash
pnpm deploy:cloudflare
```

Alternatively, configure a custom Worker route/custom domain in `apps/web/wrangler.toml` and rerun the same deployment helper.

## Seed first-use Stable data

Seed the Supabase database with the approved Stable starter corpus:

```bash
pnpm seed:stable
```

The command is idempotent. It inserts 10 approved Stable fixture braindumps, 32 confirmed memory items, and 3 draft initiative briefs when they do not already exist.

Use the full fixture set only when you intentionally want all eval data in the app:

```bash
pnpm seed:stable -- --all
```

## v0 API path

- `GET /` serves the one-screen password-gated text UI.
- `GET /synthesis` serves the separate password-gated Memory Synthesis reviewer surface. Users select memory, optionally add brief intent, generate a draft, review/edit it, then save.
- `POST /login` sets the 30-day shared-password session cookie.
- `POST /logout` clears the shared-password session cookie.
- `GET /api/session` verifies the current session cookie.
- `POST /api/ingestions` stores immutable text evidence and queues Memory Generation.
- `GET /api/ingestions/{id}` returns status, evidence spans, and committed memory items.
- `GET /api/memory-items` returns active memory with evidence spans for synthesis selection.
- `POST /api/memory-items/{id}/actions` confirms, edits, or removes memory items using append-only events.
- `GET /api/memory-items/{id}/history` returns correction history and replacements.
- `POST /api/queries` returns a deterministic cited answer or an explicit evidence gap from active memory.
- `GET /api/initiative-briefs` lists traceable initiative briefs.
- `POST /api/initiative-brief-drafts` generates an editable brief draft from 1-8 selected active memory items.
- `POST /api/initiative-briefs` creates a human-authored brief from selected active memory.
- `GET /api/initiative-briefs/{id}` returns a brief with memory, evidence, and decisions.
- `POST /api/initiative-briefs/{id}/decisions` records an approve/reject decision.
