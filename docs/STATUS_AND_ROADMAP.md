# Distillery status and roadmap

Last updated: 2026-07-07

This is the canonical project-status document. If another doc disagrees with this file, treat this file as the current source of truth and update the stale doc.

## Current product state

Distillery v0 is live as a private internal pilot.

```text
Capture/Recall app
  one screen
  one text input
  remember or ask

Synthesis app
  select committed memory
  generate optional brief draft
  edit/save traceable brief
  approve or reject
```

Live Worker:

```text
https://distillery-v0.angela-f4b.workers.dev
```

Current seeded data:

- 32 confirmed Stable memory items;
- 3 starter initiative briefs;
- all active memory returns `claimType`, `entities`, `relations`, and `schemas`.

Current system diagram: [v0-current.mermaid](./v0-current.mermaid).
North-star system diagram: [system.mermaid](./system.mermaid).

## Implemented

### Product

- Shared-password login with 30-day `HttpOnly` session cookie.
- Logout.
- `/` capture and recall screen.
- `/synthesis` reviewer screen.
- Text-only braindump ingestion.
- No initiative suggestions on the ingestion screen.
- No formal auth, SSO, RBAC, or per-source ACLs.

### Memory Generation

- Immutable source version and evidence-span storage.
- OpenRouter structured memory generation.
- Runtime validation before memory commit.
- `claimType` taxonomy:
  - `fact`;
  - `user_signal`;
  - `reported_decision`;
  - `metric`;
  - `risk`;
  - `dependency`;
  - `constraint`;
  - `strategic_statement`;
  - `ownership_statement`;
  - `scope_statement`.
- MemGraphRAG-aligned metadata on each memory item:
  - `entities`;
  - `relations`;
  - `schemas`.
- Relation evidence validation: relation evidence must be valid and inside the parent memory item evidence set.
- Append-only confirm/edit/remove memory actions.
- Memory item history and replacements.
- Deterministic cited recall.

### Memory Synthesis

- Active-memory listing with evidence spans.
- Optional LLM brief draft generation from 1-8 selected memory items.
- Deterministic fallback draft when model drafting fails validation or times out.
- Human-editable initiative brief creation.
- Brief-to-memory and brief-to-evidence bindings.
- Approve/reject decision writeback.
- Traceability validation for created briefs and generated drafts.

### Infrastructure

- Cloudflare Worker web/API deployment.
- Cloudflare Queue binding for memory generation.
- Supabase PostgreSQL with RPC functions for multi-table commits.
- `pgvector` enabled.
- OpenRouter model gateway.
- Stable fixture validation.
- Stable seed script.
- Live smoke script.

## Current architecture

```text
Browser
  -> Cloudflare Worker
  -> Supabase HTTP/RPC
  -> PostgreSQL ledger

Worker queue consumer
  -> memory generation workflow
  -> OpenRouter
  -> Supabase RPC commit

Synthesis page
  -> active memory
  -> optional brief draft model call
  -> human save/approval
```

Authoritative state is in PostgreSQL. Lexical indexes, embeddings, and future graph projections are derived.

## Current models

Generation and brief drafting use OpenRouter.

```text
primary:  moonshotai/kimi-k2.7-code
fallback: ~moonshotai/kimi-latest
fallback: moonshotai/kimi-k2.6
```

Configured embedding model:

```text
qwen/qwen3-embedding-8b
1536 dimensions
```

Embedding storage exists, but asynchronous embedding generation and hybrid retrieval are not implemented yet.

## What is intentionally not done in v0

- Slack, docs, meetings, tickets, metrics, or URL ingestion.
- Voice input.
- Formal user accounts.
- SSO/RBAC.
- Source-level ACL enforcement.
- Automated initiative discovery.
- Automated evidence grouping.
- Automated candidate maturity scoring.
- PRD generation.
- TDD generation.
- Continuous freshness checks.
- Conflict resolution workflow.
- Production-grade observability, cost dashboards, or alerting.
- Canonical entity/schema promotion.
- Graph retrieval / Personalized PageRank.

## Roadmap

### v0 hardening

Goal: make the existing private pilot reliable enough for repeated Stable leadership use.

Build next:

1. Better UI copy for first-time users.
2. Cleaner trace details display for entities, relations, schemas, and evidence.
3. Local and deployed smoke tests that cover:
   - login/session;
   - capture;
   - memory generation;
   - recall;
   - brief draft generation;
   - brief approval.
4. Basic run metadata:
   - model used;
   - fallback used;
   - latency;
   - failure reason.
5. Safer DB reset/seed command for v0 pilots.

### v0.1 memory quality

Goal: improve the reliability of extracted memory before adding more input channels.

Build:

- fixture-based extraction eval runner;
- precision/recall review by `claimType`;
- stricter model prompt around entities/relations/schema candidates;
- duplicate detection;
- contradiction candidate detection;
- semantic metadata quality review.

### v0.2 synthesis quality

Goal: make brief generation more useful without hiding uncertainty.

Build:

- evidence bundle view;
- generated brief assertion trace table;
- explicit gaps/unknowns in brief drafts;
- contrary evidence display;
- stale-brief warning if supporting memory changes.

### v1 PRD

Goal: turn an approved initiative brief into an approved PRD.

Build:

- PRD schema;
- PRD draft generation;
- assertion-level evidence support;
- review/edit/approval workflow;
- artifact versioning;
- export with trace appendix.

### v2 TDD

Goal: turn approved PRDs into engineering design drafts.

Build:

- repository/code evidence ingestion;
- architecture and dependency extraction;
- TDD schema;
- engineering review workflow;
- bidirectional PRD/TDD requirement mapping.

### v3 continuous company intelligence

Goal: keep memory, initiatives, and artifacts current as company context changes.

Build:

- Slack/docs/meeting/ticket/metric ingestion;
- incremental refresh;
- currentness checks;
- source permission model;
- notifications for material changes;
- derived graph retrieval.

## Agent handoff notes

When working in this repo:

- Treat `packages/contracts/src/index.ts` as the API/runtime validation source of truth.
- Treat PostgreSQL migrations as the persistence source of truth.
- Keep evidence authoritative; do not let generated metadata become proof.
- Use `claimType`, not `type`, for memory items.
- Do not add initiative suggestions to the capture screen.
- Do not store secrets in docs, examples, or command output.
- Run before handoff:

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm build
```
