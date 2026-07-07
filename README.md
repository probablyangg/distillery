# Distillery

Distillery turns scattered company context into trustworthy memory and human-approved initiative briefs.

## v0

```text
Memory Generation
  text braindump -> immutable evidence -> structured memory -> cited recall

Memory Synthesis
  committed memory -> evidence groups -> human-created initiative
  -> traceable brief -> human approval
```

The Memory Generation screen asks only:

> What should Distillery remember or answer?

For `Remember`, it displays only the committed memory items being passed to Memory Synthesis. Initiative grouping and review happen on a separate password-gated reviewer surface.

v0 uses a single shared webapp password, configured server-side as `DISTILLERY_APP_PASSWORD`. It does not implement formal authentication, accounts, SSO, or RBAC yet.

## Documentation

- [v0 build plan](./docs/V0_BUILD_PLAN.md)
- [Memory Generation implementation](./docs/MEMORY_GENERATION.md)
- [Memory Synthesis implementation](./docs/MEMORY_SYNTHESIS.md)
- [memory architecture and MemGraphRAG analysis](./docs/MEMORY_ARCHITECTURE.md)
- [system design](./docs/SYSTEM_DESIGN.md)
- [Memory Generation labeled fixtures](./evals/fixtures/memory-generation/labeled-fixtures.v0.json)

## Current status

- Product and system architecture defined.
- Supabase PostgreSQL session and transaction-pooler connections verified.
- `pgvector` enabled.
- OpenRouter model selected: `tencent/hy3`.
- Embedding model selected: `qwen/qwen3-embedding-8b` at 1536 dimensions.
- v0 deployment target selected: Cloudflare Workers.
- Application implementation has not started.

## Local prerequisites

- Node.js 20 or later
- pnpm 11
- Supabase PostgreSQL project
- Supabase project URL and API keys for the Cloudflare Worker runtime
- OpenRouter API key
- shared v0 webapp password

## Setup

```bash
cp .env.example .env.local
pnpm install
```

Populate `.env.local` with server-side credentials and model config, including `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, and `DISTILLERY_APP_PASSWORD`. Never commit that file or expose database/model credentials through `NEXT_PUBLIC_` variables.

Implementation begins with Slice 1 in the [v0 build plan](./docs/V0_BUILD_PLAN.md): pasted text to immutable evidence to validated, committed memory.
