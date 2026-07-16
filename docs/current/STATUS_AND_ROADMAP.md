# Distillery status and roadmap

Last updated: 2026-07-16

This is the canonical prose snapshot of implemented behavior. Executable code/tests and ordered SQL migrations remain authoritative. Implementation PRDs explain design intent and may contain historical baselines; do not use them as current-state checklists without confirming the code.

## Current product state

Distillery is live as a private internal pilot.

```text
Capture/Recall app
  one screen
  one text input
  remember or ask

Synthesis app
  rank corpus-wide brief opportunities
  inspect bounded cluster evidence and readiness
  generate or review suggested drafts
  edit, save, approve, or reject traceable briefs

Graph review app
  inspect claim clusters
  review connections and conflicts
  pin or exclude claims for synthesis
```

Live Worker:

```text
https://distillery-v0.angela-f4b.workers.dev
```

The default starter seed command produces:

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
- Evidence construction bounds each nonempty span to 2,000 characters at sentence, word, or hard boundaries while retaining exact normalized-source offsets. This includes one-line inputs up to the existing 50,000-character capture limit.
- Text capture commits a `source_committed` ledger event and `event_outbox` row in the same RPC path.
- Request-triggered routing prefers the newly captured source for its first leased outbox claim, then returns to FIFO order. A derived-work backlog therefore cannot starve a new Remember submission.
- Event router maps committed source events to `extract_memory` pending work.
- `extract_memory` deterministically selects the single path or semantic sectioning. The default section triggers are 6,000 normalized characters or 20 evidence spans.
- Section planning uses ordered original evidence spans through `packages/model-gateway`. Deterministic validation rejects unknown IDs, gaps, overlaps, reordering, over-budget multi-span sections, and excessive section counts. Invalid or unavailable model plans fall back to deterministic ordered boundaries.
- Each planned section has canonical PostgreSQL state and an independently leased `extract_memory_section` work item. Extraction and verification receive original evidence spans, never a rewritten summary.
- Saturated 30-candidate section responses are subdivided deterministically up to three levels. The 30-item schema limit is per model response, not per complete Remember submission.
- `consolidate_memory` waits for every section, merges only exact normalized cross-section duplicates, retains original citations, and emits stable proposal and memory IDs in batches of at most 30. Similar-looking but nonidentical facts stay separate.
- Failed section retries reset and resume only unfinished section work; completed checkpoints are preserved.
- Policy executor records `policy_runs`, emits `proposed_events`, validates output, and auto-commits valid `memory_committed` events.
- OpenRouter structured memory generation.
- Two-stage extraction routing: the extractor proposes candidates, deterministic validation rejects malformed or ungrounded candidates, and an optional verifier classifies remaining candidates.
- Verifier outcomes:
  - `verified` and valid `corrected` candidates can auto-commit;
  - `needs_review` candidates become human-review `memory_proposed` events;
  - duplicates and unsupported candidates are recorded in extraction audit metadata and do not commit.
- Pending memory review on `/synthesis`, backed by `GET /api/memory-proposals` and `POST /api/proposed-events/{id}/decision`.
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
- Graph-grounded cited recall through hybrid vector/sparse graph retrieval, with deterministic graph-score fallback when model reranking is unavailable.

### Memory Synthesis

- Active-memory listing with evidence spans.
- Corpus-aware LLM brief draft generation from 1-20 selected seed memories. Related-memory expansion is the default; `expandRelatedMemory: false` is the explicit selection-only mode.
- Deterministic fallback draft when model drafting fails validation or times out.
- Human-editable initiative brief creation.
- Brief-to-memory and brief-to-evidence bindings.
- Approve/reject decision writeback.
- Traceability validation for created briefs and generated drafts.
- `memory_committed` independently routes connection, contradiction, embedding, graph, candidate, freshness, and dirty-neighborhood work. It no longer routes directly to generation.
- Versioned, overlapping synthesis clusters exist at narrow-decision, initiative, and strategic-theme resolutions. Each membership stores a deterministic score and plain-language reasons. Incremental neighborhoods include durable connections, shared entities/schema, lexical topics, and bounded claim-embedding neighbors when embeddings exist.
- Readiness is a separate policy with explicit `pending_enrichment`, `not_ready`, `ready`, `draft_generated`, `superseded`, and `failed` states.
- Deterministic opportunity scoring exposes cohesion, evidence breadth/quality, source diversity, actionability, importance, momentum, urgency, novelty, completeness, and explicit penalties.
- Ready cluster versions produce at most one suggested draft per tenant, cluster version, and generation intent. Suggested drafts remain ordinary reviewable `initiative_briefs` drafts until a human approves or rejects them.
- `/synthesis` lists ranked opportunities, reasons, members, evidence, contradictions, missing information, saved suggested drafts, and fields changed from the previous suggested version. Capture does not show initiative suggestions.

### Claim Graph Pilot

- Claim graph contracts for durable connections, conflicts, graph clusters, graph retrieval context, embeddings, and grounded Ask answers.
- Fresh pilot migration `0010_claim_graph_memory_upgrade.sql` adds observations, claims, claim evidence, promoted entities/predicates/schema patterns, claim connections, conflict groups/resolutions, graph projection tables, generic `memory_embeddings`, and graph review preferences.
- `connect_memory` is a real deterministic policy that persists grounded connection proposals and prevents claim-type-only links.
- `detect_contradiction` is a deterministic policy that records evidence-backed blocking/warning conflict groups for shared-subject polarity conflicts.
- Graph retrieval RPCs and Worker wrappers exist for graph recall context, graph clusters, graph claims, connection review, conflict resolution, claim pinning/exclusion, and graph rebuild.
- `/graph` reviewer route exists in the Worker with cluster list, graph canvas, details pane, and accept/reject/resolve/pin/exclude actions.
- Ask uses shared hybrid graph retrieval plus grounded OpenRouter answer generation by default. The old DB lexical answer fallback is no longer on the Ask path; sparse/exact matching is only a graph seed source.
- `packages/model-gateway` includes OpenRouter embedding and grounded-answer clients with mocked tests and dimension/citation validation.

### Infrastructure

- Cloudflare Worker web/API deployment.
- Cloudflare Queue binding used as a noncanonical wakeup transport with `{ workItemId }` messages.
- Cloudflare Cron invokes bounded loop maintenance every minute, so outbox progress does not depend on another user action.
- Router and worker claims use explicit leases and fencing tokens. Expired claims are recovered up to bounded attempt limits; unexpired work is never reclaimed.
- Approved seed fixtures preserve source/evidence/ledger records but atomically resolve their source outbox rows as non-actionable, avoiding duplicate model extraction.
- Supabase PostgreSQL with RPC functions for multi-table commits.
- `pnpm reset:stable` pilot reset command that clears tenant-scoped app data while preserving schema/functions.
- Loop tables:
  - `ledger_events`;
  - `event_outbox`;
  - `pending_work`;
  - `policy_runs`;
  - `proposed_events`.
- Section checkpoint tables:
  - `memory_section_plans`;
  - `memory_sections`.
- Loop status endpoint at `GET /api/loop-status`.
- Loop status drawer in the capture UI, including section strategy, counts, current section, high-level phase, and terminal state.
- `pgvector` enabled.
- OpenRouter model gateway.
- OpenRouter embedding client.
- Stable fixture validation.
- Deterministic retrieval fixture validation.
- Standalone extraction-quality and connection-density evaluators. The extraction evaluator calls live OpenRouter; the connection evaluator is local and deterministic.
- Stable seed script.
- Legacy direct database/model smoke script. It is not a deployed Worker/browser smoke and must use an isolated disposable database because its cleanup does not cover asynchronous corpus-synthesis rows.

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

Short Remember
  -> one extract_memory model call
  -> verification and memory proposal

Long or dense Remember
  -> validated semantic section plan (deterministic fallback on failure)
  -> memory_section_ready per canonical section
  -> independently leased extract_memory_section work
  -> per-section verification and checkpoint
  -> consolidate_memory only after all sections complete
  -> cross-section deduplication and memory proposals

Worker queue consumer or inline fallback
  -> claim pending_work by workItemId
  -> policy runner
  -> OpenRouter
  -> proposed_events
  -> validation and approval
  -> one atomic RPC for auto-approved proposal batches
  -> ledger_events

Scheduled loop maintenance (every minute)
  -> resolve legacy non-actionable seed routing
  -> recover expired router and worker leases
  -> close abandoned policy runs with failure metadata
  -> requeue up to 25 recovered workItemId messages
  -> schedule up to 4 cursor-backed synthesis scans
  -> route up to 4 event_outbox rows

After memory commit
  -> connect_memory
  -> durable claim connection proposals
  -> connections_updated (even when no connection crosses the threshold)

After memory commit
  -> detect_contradiction
  -> conflict group proposals
  -> contradictions_updated (even when no contradiction is found)

After memory or enrichment change
  -> recompute_cluster (incremental neighborhood or bounded global sweep)
  -> cluster_changed
  -> evaluate_synthesis_readiness
  -> pending_enrichment / not_ready / synthesis_ready
  -> synthesize_brief
  -> bounded cluster dossier
  -> OpenRouter brief draft
  -> artifact_draft_proposed
  -> artifact_drafted
  -> initiative_briefs draft rows

Synthesis page
  -> ranked corpus-wide opportunities and active memory
  -> corpus expansion by default; explicit selection-only option
  -> human save/approval

Ask
  -> hybrid vector/sparse graph retrieval context
  -> grounded OpenRouter answer with citation validation
  -> explicit no-answer gap if graph retrieval or grounded answer generation cannot produce a cited answer

Graph page
  -> graph clusters and claim details
  -> connection review, conflict resolution, claim pinning/exclusion
```

Connection or contradiction completion invalidates the prior graph-completion facet and routes an independent graph rebuild. Readiness therefore cannot treat a graph projection from before those changes as current. A model timeout or invalid generated draft records `failed` readiness for that cluster version and commits no brief.

Authoritative state is in PostgreSQL. Lexical indexes, embeddings, and graph projections are derived.

## Current models

Section planning, generation, verification, connection scoring, retrieval reranking, grounded answers, and brief drafting use OpenRouter through `packages/model-gateway`.

```text
default primary:  openai/gpt-5
configured fallback 1: anthropic/claude-sonnet-4.5
configured fallback 2: moonshotai/kimi-k2.7-code
configured fallback 3: ~moonshotai/kimi-latest
```

These are repository defaults from `.env.example` and `apps/web/wrangler.toml`, not hard-coded product requirements. `MEMORY_EXTRACTOR_MODEL`, `MEMORY_VERIFIER_MODEL`, `MEMORY_CONNECTION_MODEL`, and `MEMORY_SECTION_PLANNER_MODEL` may override the primary model for those roles. If an override is absent, that role uses `OPENROUTER_MODEL`.

Current Worker call sites cap fallback attempts to one model, so only the first configured fallback is effective in the Worker. Standalone scripts that construct the model gateway directly may use the full configured list.

Configured embedding model:

```text
google/gemini-embedding-001
1536 dimensions
```

Embedding storage and an independent `update_embeddings` policy exist when embedding env vars are configured. A hybrid graph retrieval implementation is present for Ask and synthesis, with vector/sparse seeds, TypeScript PPR, OpenRouter reranking, and a batch embedding backfill script. Apply migrations through `0017`, then run the backfill before expecting full vector coverage on historical memory.

## Current loop-system limitations

- `extract_memory`, `extract_memory_section`, `consolidate_memory`, `connect_memory`, `detect_contradiction`, `update_embeddings`, `update_graph`, `recompute_cluster`, `evaluate_synthesis_readiness`, and `synthesize_brief` have real domain logic.
- `discover_candidate`, `check_freshness`, `rank_candidate`, `draft_artifact`, `gate_output`, and `revise_artifact` are registered policy runners but currently emit placeholder `not_enough_context` proposals.
- After a queue work item completes, the Worker routes up to four newly available outbox rows before acknowledging the message. The one-minute scheduled router remains the recovery path for backlog and idle periods. Sectioned documents therefore propagate through section completions without requiring a full Cron interval between every step.
- The deployed Worker limits each scheduled or request-triggered routing pass to 4 outbox rows and requeues up to 25 recovered jobs. Auto-approved proposals commit in one database RPC so high-fan-out cluster projections stay within the Worker subrequest budget.
- Global sweep events are safety-net scans. An unchanged cluster version is a no-op; enrichment and memory-change events can still force readiness reevaluation without changing membership.
- SQL/RPC loop behavior has minimal automated coverage. Most loop tests run against `InMemoryLoopPersistence`.
- Sectioning adds one planner call for triggered sources plus extractor/verifier calls for every section. Lower targets and triggers increase recall opportunities, latency, and model cost. A hard maximum of 50 sections and a three-level saturation subdivision bound prevent unbounded work.
- The OpenRouter embedding client and `memory_embeddings` table are wired into independently retryable `update_embeddings`; historical embedding backfill is available through `scripts/backfill-memory-embeddings.ts`.
- Each cluster recomputation loads at most 500 active memories, while the durable global cursor makes every active memory eligible over repeated sweeps. Very large corpora will eventually need partitioned candidate indexes rather than a larger Worker batch.
- Ask and synthesis are wired to the shared hybrid graph retriever in code. Full runtime success requires migration `0011_hybrid_retrieval_rpcs.sql`, graph projection rebuild, and embedding backfill in the target database. If OpenRouter reranking fails, retrieval degrades to deterministic graph/vector/sparse ranking and reports the reranker failure in metadata.
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
- Production hardening and quality benchmarking for hybrid graph retrieval and Personalized PageRank.

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
5. Browser-verified graph page screenshot pass.
6. Review-queue browser coverage for verifier-routed memory proposals.

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
