# Distillery

Distillery is an internal company-intelligence system for turning scattered context into trustworthy memory and human-approved initiative briefs.

The core product rule is:

> A brief is only useful if a human can verify why every important claim says what it says.

v0 is intentionally narrow. It handles text braindumps, creates evidence-backed memory, supports cited recall, and lets a human generate, edit, save, and approve an initiative brief from selected memory.

## Current v0 status

Implemented and deployed:

- one-screen password-gated capture/recall app at `/`;
- separate password-gated synthesis surface at `/synthesis`;
- 30-day shared-password session cookie with logout;
- text-only ingestion;
- immutable source versions and evidence spans;
- OpenRouter memory generation;
- `claimType` memory contract;
- MemGraphRAG-aligned semantic metadata on memory items:
  - `entities`;
  - `relations`;
  - `schemas`;
- confirm/edit/remove memory actions with append-only history;
- deterministic cited recall with evidence-gap responses;
- initiative brief draft generation from 1-8 selected memory items;
- human-editable initiative brief creation;
- approve/reject decision writeback;
- Stable starter seed data: 32 confirmed memory items and 3 starter briefs;
- Cloudflare Worker deployment;
- Supabase PostgreSQL/RPC persistence with `pgvector` enabled.

Live app:

```text
https://distillery-v0.angela-f4b.workers.dev
```

## How v0 works

```text
Memory Generation
  text braindump
  -> immutable evidence spans
  -> generated memory items
  -> validation
  -> committed memory
  -> correction/history
  -> cited recall

Memory Synthesis
  active committed memory
  -> human selects memory
  -> optional brief draft generation
  -> human edits/saves brief
  -> evidence binding
  -> approve/reject decision
```

Important boundaries:

- Memory Generation does not create initiatives, PRDs, tasks, or priorities.
- Memory Synthesis v0 is human-directed; automated initiative discovery is not implemented yet.
- `entities`, `relations`, and `schemas` are interpretation metadata, not standalone proof.
- Exact evidence spans remain authoritative.
- Shared password access is acceptable only for a private v0 pilot.

## Quick start

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

Deploy:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm deploy:cloudflare
```

Seed Stable starter data:

```bash
PATH=/opt/homebrew/bin:$PATH pnpm seed:stable
```

## Documentation map

Start here:

- [Status and roadmap](./docs/STATUS_AND_ROADMAP.md) — what is done, what is left, and where the system goes next.
- [v0 runbook](./docs/V0_RUNBOOK.md) — local setup, migrations, seed data, deployment, smoke testing.
- [v0 build plan](./docs/V0_BUILD_PLAN.md) — implemented slices and remaining backlog.

Subsystem docs:

- [Memory Generation](./docs/MEMORY_GENERATION.md)
- [Memory Synthesis](./docs/MEMORY_SYNTHESIS.md)
- [System design](./docs/SYSTEM_DESIGN.md)
- [Memory architecture and MemGraphRAG notes](./docs/MEMORY_ARCHITECTURE.md)
- [Stable labeled fixtures](./evals/fixtures/memory-generation/README.md)

## Useful commands

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm build
pnpm smoke:live
pnpm seed:stable
pnpm deploy:cloudflare
```

## Environment

Copy `.env.example` to `.env.local` and populate:

- Supabase:
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

Never commit `.env.local`, `.dev.vars`, database URLs, API keys, or Worker secrets.
