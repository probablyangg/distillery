# Distillery

Distillery is an internal company-intelligence system for turning scattered context into trustworthy memory and human-approved initiative briefs.

The core product rule:

> A brief is only useful if a human can verify why every important claim says what it says.

## Start Here

For implementation work, read these in order:

1. [Docs index](./docs/README.md) — source-of-truth map for all documentation.
2. [Current status](./docs/current/STATUS_AND_ROADMAP.md) — what exists today, including known loop-system gaps.
3. [Loop system PRD](./docs/implementation/LOOP_SYSTEM_PRD.md) — implementation contract for the event-driven loop system.
4. [Runbook](./docs/runbooks/RUNBOOK.md) — local setup, migrations, seed data, deployment, and smoke testing.

Do not treat older roadmap or research docs as implementation authority when they conflict with the current status document or loop system PRD.

## Current System

Implemented and deployed:

- password-gated capture/recall app at `/`;
- password-gated synthesis surface at `/synthesis`;
- text-only ingestion;
- immutable source versions and evidence spans;
- OpenRouter memory generation;
- evidence-backed memory with `claimType`, entities, relations, and schemas;
- confirm/edit/remove memory actions with append-only history;
- deterministic cited recall;
- human-directed initiative brief draft, save, approve, and reject flow;
- event-driven loop infrastructure with `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, and `proposed_events`;
- `source_committed -> extract_memory -> memory_proposed -> validation -> memory_committed` loop path;
- loop status endpoint and UI drawer for recent loop activity;
- Cloudflare Worker deployment;
- Supabase PostgreSQL/RPC persistence with `pgvector`.

Live app:

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

Canonical state is PostgreSQL. Queues, indexes, embeddings, and future graph projections are derived or transport mechanisms.

Current loop limitation: `extract_memory` is the only policy with real domain logic. Downstream policies are wired as placeholder runners until their product behavior is implemented.

## Quick Start

```bash
pnpm install
pnpm build
```

Run locally:

```bash
cp .env.example .env.local
cp apps/web/.dev.vars.example apps/web/.dev.vars
PATH=/opt/homebrew/bin:$PATH pnpm dev
```

Seed Stable starter data:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm seed:stable
```

Deploy:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm deploy:cloudflare
```

## Verification Commands

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm build
pnpm smoke:live
```

`pnpm smoke:live` requires live Supabase, Cloudflare, OpenRouter, and app password configuration.

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
- app access:
  - `DISTILLERY_APP_PASSWORD`.

For Worker runtime secrets, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`.

Never commit `.env.local`, `.dev.vars`, database URLs, API keys, or Worker secrets.
