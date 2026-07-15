# Instructions for coding agents

Read this file before changing the repository.

## Source-of-truth order

When two sources disagree, use this order:

1. Executable code and tests.
2. SQL migrations, applied in filename order.
3. [`docs/current/STATUS_AND_ROADMAP.md`](./docs/current/STATUS_AND_ROADMAP.md) for a prose snapshot of current behavior.
4. Product and architecture docs for invariants and rationale.
5. Implementation PRDs and build plans for historical intent.

Implementation PRDs contain original requirements and baselines. They are not proof that every described feature is current, and their “current baseline,” “required,” and “future work” sections may describe the point in time when the PRD was written. Confirm current behavior in code before changing it.

## Read before coding

1. [`README.md`](./README.md)
2. [`docs/README.md`](./docs/README.md)
3. [`docs/current/STATUS_AND_ROADMAP.md`](./docs/current/STATUS_AND_ROADMAP.md)
4. The relevant product or implementation document.
5. The code, tests, package manifests, and migrations in the area being changed.

## Current boundaries

- PostgreSQL is canonical. Queues, embeddings, full-text indexes, and graph rows are derived or transport state.
- Cloudflare Queue messages contain only `workItemId`. A worker must claim canonical work in PostgreSQL.
- Model calls go through `packages/model-gateway`. Do not call a model provider directly from routes or policy code.
- Model output must pass runtime validation before it can commit domain state.
- Evidence spans are authoritative. Entities, relations, schemas, scores, and graph connections are interpretations or projections.
- Memory items use `claimType`, never `type`.
- Source versions and evidence spans are immutable. Corrections create review/history records or replacement memory.
- The capture page must not create or show initiative suggestions.
- Do not add a graph database, LangGraph, CrewAI, AutoGen, or a new model provider without an explicit architecture decision.

## Important current behavior

- Real policies: `extract_memory`, `connect_memory`, `detect_contradiction`, and `synthesize_brief`.
- Placeholder policies: `discover_candidate`, `check_freshness`, `rank_candidate`, `draft_artifact`, `gate_output`, and `revise_artifact`.
- Memory extraction uses an extractor followed by deterministic validation and, when configured, a verifier. Verified/corrected candidates can auto-commit. `needs_review` candidates become human-review proposals.
- Ask uses the shared vector/sparse-seeded graph retriever, bounded Personalized PageRank, optional model reranking, and grounded answer generation. If a model step fails, it degrades using the same retrieved context. It does not fall back to the legacy database lexical-answer function.
- Manual brief drafting expands related memory only when `expandRelatedMemory: true`. Background `synthesize_brief` uses the shared synthesis retriever.
- Worker model calls currently attempt only the first configured fallback model, even if `OPENROUTER_FALLBACK_MODELS` contains more entries.
- Migrations `0010` and `0011` are both required for the current claim graph and hybrid retrieval path. Historical rows also require graph rebuild and embedding backfill for full vector coverage.

## Safe workflow

- Preserve unrelated user changes in the worktree.
- Never commit `.env.local`, `.dev.vars`, URLs containing credentials, API keys, or database secrets.
- Apply all migrations to a fresh database. On an existing database, apply every unapplied migration in order; do not assume “latest” means only one file after an arbitrarily old state.
- Do not reset or reseed any database unless the human explicitly identifies the target and requests that destructive action.
- Run `pnpm build` before handoff. It includes typecheck, unit tests, memory fixture validation, and retrieval fixture validation.
- Run live tests only when the required credentials are available and the human has placed the live environment in scope.
