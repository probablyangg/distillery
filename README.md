# Distillery

Distillery is an internal company-intelligence system for turning scattered context into trustworthy memory and human-approved initiative briefs.

The core product rule:

> A brief is only useful if a human can verify why every important claim says what it says.

## Start Here

For implementation work, read these in order:

1. [Coding-agent instructions](./AGENTS.md) — source-of-truth order, current boundaries, and safe workflow.
2. [Docs index](./docs/README.md) — authority and lifecycle map for all documentation.
3. [Current status](./docs/current/STATUS_AND_ROADMAP.md) — what exists today, including known loop-system gaps.
4. [Codebase guide](./docs/reference/CODEBASE_GUIDE.md) — runtime entry points, package responsibilities, data flows, and where to make common changes.
5. [Runbook](./docs/runbooks/RUNBOOK.md) — local setup, migrations, seed data, deployment, and smoke testing.
6. Read the relevant product/architecture doc, then any implementation PRD needed for design history.

Do not treat roadmaps, research notes, build plans, or implementation PRD baselines as current implementation authority. When sources disagree, follow the order in `AGENTS.md`: code/tests, ordered migrations, then the current-status document.

For code-facing details, use the implementation as the final source of truth: exported contracts live in `packages/contracts/src/index.ts`, Worker routes in `apps/web/src/index.ts`, loop routing and policies in `packages/loop/src/index.ts`, persistence/RPC bindings in `packages/db/src/index.ts`, and database invariants in `packages/db/migrations/`.

## Current System

Implemented in the current repository:

- password-gated capture/recall app at `/`;
- password-gated synthesis surface at `/synthesis`;
- password-gated graph review surface at `/graph`;
- password-gated, read-only generated brief surface at `/briefs`;
- context-aware Slack message shortcut ingestion from channels where the app is a member, including bounded threads or selected nearby messages, immutable channel-profile snapshots, and text-based PDF/DOCX attachments;
- direct text-braindump ingestion;
- immutable source versions and evidence spans;
- automatic semantic sectioning for documents that reach 6,000 normalized characters or 20 evidence spans, with deterministic fallback boundaries;
- OpenRouter memory generation;
- evidence-backed memory with `claimType`, entities, relations, and schemas;
- durable claim graph projection with claim connections, conflict groups, graph clusters, and reviewer preferences;
- confirm/edit/remove memory actions with append-only history;
- hybrid vector/sparse-seeded graph retrieval with bounded Personalized PageRank, optional model reranking, and grounded Ask answers;
- deterministic degraded ranking/answering from the retrieved graph context when a model step fails; the legacy DB lexical-answer function is not on the Ask path;
- extractor-plus-verifier memory routing, including a human review queue for uncertain memory proposals;
- human-directed initiative brief draft, save, approve, and reject flow;
- event-driven loop infrastructure with `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, and `proposed_events`;
- one-minute scheduled outbox draining, explicit router/worker leases, stale-claim recovery, and fenced retries;
- short-source `source_committed -> extract_memory -> memory_proposed -> validation -> memory_committed` loop path;
- long-source `extract_memory -> extract_memory_section (one leased work item per section) -> consolidate_memory -> memory_committed` loop path;
- `memory_committed -> connect_memory -> enrichment_update_proposed -> validation -> connections_updated` loop path;
- `memory_committed -> detect_contradiction -> enrichment_update_proposed -> validation -> contradictions_updated` loop path;
- independent post-memory work for connections, contradictions, embeddings, graph projection, clustering, and the placeholder candidate/freshness runners;
- corpus-wide `recompute_cluster -> evaluate_synthesis_readiness -> synthesis_ready -> synthesize_brief` loop path;
- versioned overlapping clusters, deterministic opportunity scoring, bounded evidence dossiers, and idempotent suggested drafts;
- atomic batching for auto-approved policy proposals, keeping high-fan-out cluster work within the Cloudflare Worker subrequest budget;
- cursor-backed global synthesis sweeps that no-op when cluster versions have not changed;
- loop status endpoint and UI drawer with planned, pending, processing, completed, and failed section counts;
- Cloudflare Worker deployment;
- Supabase PostgreSQL/RPC persistence with `pgvector`.

Configured live app (repository deployment target; verify `/health` before operating it):

```text
https://distillery-v0.angela-f4b.workers.dev
```

## Current Stack

```text
TypeScript
Cloudflare Worker
Cloudflare Queue
Supabase PostgreSQL/RPC
OpenRouter
Zod
Vitest
pnpm
```

Canonical state is PostgreSQL. Queues, indexes, embeddings, and graph projections are derived or transport mechanisms.

Current loop limitation: extraction, connection, contradiction, embedding, graph projection, clustering, readiness, and synthesis have real domain logic. Slack ingestion/reaction policies perform connector side effects. Candidate, freshness, ranking, artifact gating, and revision policies remain placeholder runners.

## Quick Start

```bash
pnpm install
pnpm build
```

Before running against a database, apply every SQL file in `packages/db/migrations/` in filename order. The current schema requires migrations `0001` through `0021`; see the [runbook](./docs/runbooks/RUNBOOK.md#database-migrations).

The Slack private-pilot setup is documented in [Slack pilot setup](./docs/runbooks/SLACK_PILOT.md).

Run locally:

```bash
cp .env.example .env.local
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev
```

`apps/web/.dev.vars` contains only Worker runtime secrets. Non-secret local Worker variables come from `apps/web/wrangler.toml`. The repository-level `.env.local` is used by scripts and is not automatically loaded by Wrangler.

Seed Stable starter data:

```bash
pnpm seed:stable
```

Reset and reseed Stable pilot data:

```bash
pnpm reset:stable
pnpm seed:stable
```

Deploy:

```bash
pnpm deploy:cloudflare
```

## Verification Commands

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm retrieval:validate
pnpm build
pnpm smoke:live
```

`pnpm smoke:live` requires live Supabase, Cloudflare, OpenRouter, and app password configuration. It is a legacy direct database/model integration smoke, not a browser or deployed Worker end-to-end test. Its cleanup does not cover asynchronous corpus-synthesis rows, so run it only against an isolated disposable database—not production.

## Environment

Copy `.env.example` to `.env.local` and populate:

- Supabase/PostgreSQL:
  - `DATABASE_DIRECT_URL`;
  - `DATABASE_URL`;
  - `SUPABASE_URL`;
  - `SUPABASE_SECRET_KEY`;
- OpenRouter:
  - `OPENROUTER_API_KEY`;
  - `OPENROUTER_BASE_URL`;
  - `OPENROUTER_MODEL`;
  - `OPENROUTER_FALLBACK_MODELS`;
  - `OPENROUTER_TIMEOUT_MS`;
  - `OPENROUTER_FALLBACK_TIMEOUT_MS`;
  - optional role overrides: `MEMORY_EXTRACTOR_MODEL`, `MEMORY_VERIFIER_MODEL`, `MEMORY_CONNECTION_MODEL`, and `MEMORY_SECTION_PLANNER_MODEL`;
- automatic sectioning:
  - `MEMORY_SECTIONING_ENABLED` (default `true`);
  - `MEMORY_SECTION_TRIGGER_CHARS` (default `6000`);
  - `MEMORY_SECTION_TRIGGER_SPANS` (default `20`);
  - `MEMORY_SECTION_TARGET_CHARS` (default `5000`);
  - `MEMORY_SECTION_MAX_CHARS` (default `8000`);
  - `MEMORY_SECTION_MAX_SECTIONS` (default `50`);
- embeddings:
  - `EMBEDDING_PROVIDER`;
  - `EMBEDDING_BASE_URL`;
  - `EMBEDDING_MODEL`;
  - `EMBEDDING_DIMENSIONS`;
  - `EMBEDDING_ENCODING_FORMAT`;
- app access:
  - `DISTILLERY_APP_PASSWORD`.
- Slack private pilot:
  - `SLACK_BOT_TOKEN`;
  - `SLACK_SIGNING_SECRET`;
  - `SLACK_ALLOWED_TEAM_ID`;
  - comma-separated `SLACK_ALLOWED_USER_IDS`;
  - comma-separated `SLACK_ALLOWED_EXTERNAL_CHANNEL_IDS` for explicit Slack Connect opt-ins; ordinary member channels need no channel allowlist;
  - `SLACK_SAVED_REACTION=factory` (Slack's built-in 🏭 reaction).
  - `SLACK_PROCESSING_REACTION=hourglass_flowing_sand` (Slack's built-in processing reaction).
  - optional `SLACK_CONTEXT_MODEL`; when empty, context selection and classification use the configured extractor model and existing OpenRouter key.

The [runbook environment section](./docs/runbooks/RUNBOOK.md#environment-files) explains which values are used by repository scripts, Wrangler, and the deployed Worker. Do not assume `.env.local` is loaded by `pnpm dev`.

For Worker runtime secrets, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`.

Never commit `.env.local`, `.dev.vars`, database URLs, API keys, or Worker secrets.

The complete normalized source is stored before any model call. Short submissions skip the section planner. Long or dense submissions use the planner only to select ordered evidence-span boundaries; the planner cannot rewrite source text. Invalid or unavailable plans fall back to deterministic, size-bounded sections. Each section is then extracted and verified independently, and cross-section duplicates are consolidated before memory commits. This can add one planning call plus one extractor/verifier sequence per section, so lower thresholds improve recall at higher model cost and processing time.
