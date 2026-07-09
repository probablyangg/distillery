# Distillery status and roadmap

Last updated: 2026-07-09

This is the canonical current-state document for implemented behavior. For the intended loop-system contract, use [LOOP_SYSTEM_PRD.md](../implementation/LOOP_SYSTEM_PRD.md). For background synthesis behavior, use [MEMORY_SYNTHESIS_POLICY_PRD.md](../implementation/MEMORY_SYNTHESIS_POLICY_PRD.md).

## Current product state

Distillery is live as a private internal pilot.

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

Graph review app
  inspect claim clusters
  review connections and conflicts
  pin or exclude claims for synthesis
```

Live Worker:

```text
https://distillery-v0.angela-f4b.workers.dev
```

Current seeded data:

- 32 confirmed Stable memory items;
- 3 starter initiative briefs;
- all active memory returns `claimType`, `entities`, `relations`, and `schemas`.

Current system diagram: [current-system.mermaid](./current-system.mermaid).
Loop-system implementation PRD: [LOOP_SYSTEM_PRD.md](../implementation/LOOP_SYSTEM_PRD.md).
Loop-system diagram: [loop-system.mermaid](../architecture/loop-system.mermaid).
North-star system diagram: [system.mermaid](../architecture/system.mermaid).

## Implemented

### Product

- Shared-password login with 30-day `HttpOnly` session cookie.
- Logout.
- `/` capture and recall screen.
- `/synthesis` reviewer screen.
- `/graph` claim graph reviewer screen.
- Text-only braindump ingestion.
- No initiative suggestions on the ingestion screen.
- No formal auth, SSO, RBAC, or per-source ACLs.

### Memory Generation

- Immutable source version and evidence-span storage.
- Text capture commits a `source_committed` ledger event and `event_outbox` row in the same RPC path.
- Event router maps committed source events to `extract_memory` pending work.
- Policy executor records `policy_runs`, emits `proposed_events`, validates output, and auto-commits valid `memory_committed` events.
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
- Graph-grounded cited recall with deterministic lexical fallback.

### Memory Synthesis

- Active-memory listing with evidence spans.
- Optional LLM brief draft generation from 1-8 selected memory items.
- Optional manual related-memory expansion for brief draft generation with `expandRelatedMemory: true`.
- Deterministic fallback draft when model drafting fails validation or times out.
- Human-editable initiative brief creation.
- Brief-to-memory and brief-to-evidence bindings.
- Approve/reject decision writeback.
- Traceability validation for created briefs and generated drafts.
- First-class `synthesize_brief` policy worker after `memory_committed`.
- Runtime synthesis bundle builder that derives related active memory from entities, relations, schemas, evidence/source context, lineage, decision references, and contradiction metadata without persisting canonical memory links.
- Background synthesis readiness gates require at least 2 active memory items, at least 2 evidence spans, at least 1 strong connection beyond shared source/context, no inactive selected memory, and no unresolved blocking contradiction.
- Valid background synthesis emits `artifact_draft_proposed` and auto-commits `artifact_drafted` without human approval.
- Committed `artifact_drafted` events create traceable `initiative_briefs` drafts and memory/evidence bindings idempotently.

### Claim Graph Pilot

- Claim graph contracts for durable connections, conflicts, graph clusters, graph retrieval context, embeddings, and grounded Ask answers.
- Fresh pilot migration `0010_claim_graph_memory_upgrade.sql` adds observations, claims, claim evidence, promoted entities/predicates/schema patterns, claim connections, conflict groups/resolutions, graph projection tables, generic `memory_embeddings`, and graph review preferences.
- `connect_memory` is a real deterministic policy that persists grounded connection proposals and prevents claim-type-only links.
- `detect_contradiction` is a deterministic policy that records evidence-backed blocking/warning conflict groups for shared-subject polarity conflicts.
- Graph retrieval RPCs and Worker wrappers exist for graph recall context, graph clusters, graph claims, connection review, conflict resolution, claim pinning/exclusion, and graph rebuild.
- `/graph` reviewer route exists in the Worker with cluster list, graph canvas, details pane, and accept/reject/resolve/pin/exclude actions.
- Ask uses graph retrieval plus grounded OpenRouter answer generation by default when graph context is available, with deterministic lexical fallback on retrieval/model/validation failure.
- `packages/model-gateway` includes OpenRouter embedding and grounded-answer clients with mocked tests and dimension/citation validation.

### Infrastructure

- Cloudflare Worker web/API deployment.
- Cloudflare Queue binding used as a noncanonical wakeup transport with `{ workItemId }` messages.
- Supabase PostgreSQL with RPC functions for multi-table commits.
- Loop tables:
  - `ledger_events`;
  - `event_outbox`;
  - `pending_work`;
  - `policy_runs`;
  - `proposed_events`.
- Loop status endpoint at `GET /api/loop-status`.
- Loop status drawer in the capture UI.
- `pgvector` enabled.
- OpenRouter model gateway.
- OpenRouter embedding client.
- Stable fixture validation.
- Stable seed script.
- Live smoke script.

## Current architecture

```text
Browser
  -> Cloudflare Worker
  -> Supabase HTTP/RPC
  -> PostgreSQL ledger

Capture
  -> source_committed
  -> event_outbox
  -> event router
  -> pending_work

Worker queue consumer or inline fallback
  -> claim pending_work by workItemId
  -> policy runner
  -> OpenRouter
  -> proposed_events
  -> validation and approval
  -> ledger_events

After memory commit
  -> connect_memory
  -> durable claim connection proposals
  -> memory_connected

After memory commit
  -> detect_contradiction
  -> conflict group proposals
  -> contradiction_recorded

After memory commit
  -> synthesize_brief
  -> derive active related memory bundle
  -> readiness checks
  -> OpenRouter brief draft
  -> artifact_draft_proposed
  -> artifact_drafted
  -> initiative_briefs draft rows

Synthesis page
  -> active memory
  -> optional brief draft model call
  -> human save/approval

Ask
  -> graph retrieval context
  -> grounded OpenRouter answer with citation validation
  -> deterministic lexical fallback

Graph page
  -> graph clusters and claim details
  -> connection review, conflict resolution, claim pinning/exclusion
```

Authoritative state is in PostgreSQL. Lexical indexes, embeddings, and graph projections are derived.

## Current models

Generation and brief drafting use OpenRouter.

```text
primary:  deepseek/deepseek-v4-flash
fallback: ~moonshotai/kimi-latest
fallback: moonshotai/kimi-k2.6
```

Configured embedding model:

```text
google/gemini-embedding-001
1536 dimensions
```

Embedding storage and inline extraction-time embedding generation exist when embedding env vars are configured. Historical embedding backfill, vector ranking in recall, and hybrid lexical/vector graph retrieval are not implemented yet.

## Current loop-system limitations

- `extract_memory`, `connect_memory`, `detect_contradiction`, and `synthesize_brief` have real domain logic.
- `discover_candidate`, `check_freshness`, `rank_candidate`, `draft_artifact`, `gate_output`, and `revise_artifact` are registered policy runners but currently emit placeholder `not_enough_context` proposals.
- After a worker auto-commits a proposed event, the newly inserted `event_outbox` row is not automatically drained by the same worker invocation. Multi-hop loops can therefore wait until another router invocation occurs.
- SQL/RPC loop behavior has minimal automated coverage. Most loop tests run against `InMemoryLoopPersistence`.
- The OpenRouter embedding client and `memory_embeddings` table are wired into `extract_memory`, but historical backfill and vector ranking are not yet wired.
- Graph retrieval currently uses lexical seed expansion plus durable connection neighborhoods; bounded TypeScript PPR and vector ranking remain future hardening.
- The `/graph` page is Worker-rendered and operational, but it has not yet been checked with a browser automation screenshot pass.

## What is intentionally not done

- Slack, docs, meetings, tickets, metrics, or URL ingestion.
- Voice input.
- Formal user accounts.
- SSO/RBAC.
- Source-level ACL enforcement.
- Full candidate-based initiative discovery.
- Human-facing automated evidence grouping review.
- Automated candidate maturity scoring.
- PRD generation.
- TDD generation.
- Continuous freshness checks.
- Production-grade contradiction adjudication workflow.
- Production-grade observability, cost dashboards, or alerting.
- Human-reviewed canonical entity/schema promotion workflow.
- Production-grade graph retrieval / Personalized PageRank.

## Roadmap

### Current system hardening

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
5. Safer DB reset/seed command for pilots.

### Memory quality

Goal: improve the reliability of extracted memory before adding more input channels.

Build:

- fixture-based extraction eval runner;
- precision/recall review by `claimType`;
- stricter model prompt around entities/relations/schema candidates;
- duplicate detection;
- broader contradiction coverage beyond the current deterministic shared-subject polarity checks;
- semantic metadata quality review.

### Synthesis quality

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
- production-grade hybrid graph retrieval.

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
