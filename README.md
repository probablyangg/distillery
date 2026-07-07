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
- [v0 runbook](./docs/V0_RUNBOOK.md)
- [Memory Generation labeled fixtures](./evals/fixtures/memory-generation/labeled-fixtures.v0.json)

## Current status

- Product and system architecture defined.
- Slice 1 implementation scaffold added: Cloudflare Worker UI/API, Supabase RPC repository, evidence storage, memory validation, model gateway, and tests.
- Slice 2 correction/history foundation added: confirm, edit, remove, and memory-item history via append-only events.
- Slice 3 cited recall foundation added: deterministic lexical recall with exact evidence citations and explicit evidence-gap responses.
- Slice 4 Memory Synthesis foundation added: separate reviewer surface, active-memory selection, traceable initiative brief creation, and approve/reject decision writeback.
- Supabase PostgreSQL session and transaction-pooler connections verified.
- Supabase v0 Memory Generation migration applied.
- Supabase v0 correction/history migration applied.
- Supabase v0 cited recall migration applied.
- Supabase v0 Memory Synthesis migration applied and smoke-tested.
- `pgvector` enabled.
- OpenRouter primary model selected: `moonshotai/kimi-k2.7-code`.
- OpenRouter fallback models configured: `~moonshotai/kimi-latest`, then `moonshotai/kimi-k2.6`.
- Embedding model selected: `qwen/qwen3-embedding-8b` at 1536 dimensions.
- v0 deployment target selected: Cloudflare Workers.
- Live end-to-end smoke passed through the fallback chain: text capture, live memory generation, memory storage, traceable brief creation, approval, and cleanup.

## Local prerequisites

- Node.js 22 or later
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

Populate `.env.local` with server-side credentials and model config, including `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_FALLBACK_TIMEOUT_MS`, `EMBEDDING_PROVIDER`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_ENCODING_FORMAT`, and `DISTILLERY_APP_PASSWORD`. Never commit that file or expose database/model credentials through `NEXT_PUBLIC_` variables.

Implementation begins with Slice 1 in the [v0 build plan](./docs/V0_BUILD_PLAN.md): pasted text to immutable evidence to validated, committed memory.
