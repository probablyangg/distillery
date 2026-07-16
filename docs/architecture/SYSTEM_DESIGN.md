# Distillery system design

Status: current architecture plus forward design.

Distillery is an evidence-to-decision system. Its job is not to produce persuasive documents. Its job is to preserve the chain from source evidence to memory to human-approved artifacts.

For the file-level implementation map, see the [codebase guide](../reference/CODEBASE_GUIDE.md).

## Product principle

The system fails if users cannot verify why a brief says what it says.

Therefore:

- evidence is immutable;
- generated memory is reviewable interpretation;
- decisions are separate records;
- approved artifacts bind to exact memory/evidence inputs;
- uncertainty must stay visible.

## Current Architecture

```text
Browser
  -> Cloudflare Worker
  -> Supabase HTTP/RPC
  -> PostgreSQL ledger

Cloudflare Queue
  -> pending_work wakeup by workItemId
  -> policy runner
  -> OpenRouter
  -> proposed event
  -> validation and approval
  -> atomic batch commit for auto-approved proposals
  -> ledger event

Cloudflare Cron (every minute)
  -> recover expired router/worker leases
  -> requeue recovered work
  -> schedule bounded synthesis scans
  -> route a bounded outbox batch

Slack
  -> signed message shortcut
  -> durable connector save and canonical work
  -> bounded immutable context bundle
  -> context extraction through the same proposal/validation path
  -> completion reaction after current-bundle extraction
```

### Runtime

- `apps/web` is a Cloudflare Worker serving HTML, API routes, and the queue consumer.
- Supabase RPC functions perform multi-table atomic writes.
- High-fan-out auto-approved policy output is persisted by one batch RPC; human-required and invalid proposals retain their explicit review/validation paths.
- OpenRouter provides structured LLM calls.
- PostgreSQL is authoritative.
- Cloudflare Queue messages are wakeups only; PostgreSQL owns committed events, outbox state, pending work, policy runs, and proposals.
- Full-text indexes, embeddings, and graph projections are derived.
- The Slack interaction endpoint is public because Slack must reach it. It verifies the raw-body signature before persistence; workspace/user checks happen at registration, while membership and Slack Connect checks require live Slack state in the ingestion worker.

### Access

The current pilot uses one shared password:

- `DISTILLERY_APP_PASSWORD`;
- 30-day `HttpOnly`, `Secure`, `SameSite=Lax` cookie;
- no formal users;
- no SSO;
- no RBAC;
- no source-level ACLs.

This is private-pilot access, not enterprise security.

## Core data model

```text
source_version
  -> evidence_span
  -> memory_item
  -> memory_item_evidence
  -> memory_entities
  -> memory_relations
  -> memory_schemas
  -> memory_item_events

connector_save
  -> slack_context_bundle (versioned)
  -> slack_context_bundle_items (ordered source roles)
  -> source_versions / evidence_spans

memory_item
  -> observations
  -> claims
  -> claim_evidence
  -> claim_connections
  -> conflict_groups
  -> graph_nodes / graph_edges

initiative_brief
  -> initiative_brief_memory
  -> initiative_brief_evidence
  -> initiative_brief_decisions

synthesis_cluster
  -> synthesis_cluster_versions
  -> synthesis_cluster_memberships
  -> synthesis_readiness_evaluations
  -> suggested_briefs / suggested_brief_versions

memory_item
  -> synthesis_enrichment_states
  -> synthesis_dirty_neighborhoods

tenant
  -> synthesis_global_scan_cursors

ledger_events
  -> event_outbox
  -> pending_work
  -> policy_runs
  -> proposed_events
```

Database table names are plural in SQL. The singular names above show relationships. The full table-family map is in the [migration guide](../../packages/db/migrations/README.md).

Memory item fields:

- `claimType` — why this memory matters for synthesis;
- `statement` — normalized evidence-backed statement;
- `evidenceSpanIds` — exact supporting evidence;
- `epistemicStatus` — observed/reported/inferred/assumption/decision reported;
- `entities` — interpreted things mentioned;
- `relations` — interpreted relationships grounded in evidence;
- `schemas` — candidate abstract relation patterns.

Evidence remains authoritative. Entities, relations, and schemas are metadata.

## Traceability contract

A consequential output claim must point to at least one of:

- exact evidence span;
- selected memory item with evidence;
- human decision record;
- explicitly labeled inference/assumption.

The current system enforces this at the brief level by binding briefs to memory and evidence spans. Later versions should enforce assertion-level traceability.

## Implemented product surfaces

### `/`

Capture and recall:

- remember text braindumps;
- inspect recent loop activity;
- show committed memory;
- confirm/edit/remove memory;
- ask through hybrid vector/sparse-seeded graph retrieval, bounded Personalized PageRank, optional model reranking, and grounded answer generation;
- degrade to deterministic ranking/answering over the same retrieved graph context when model steps fail. The legacy DB lexical-answer function is not an Ask fallback.

### `/briefs`

Read-only generated brief surface:

- list Distillery-generated draft and approved briefs newest first;
- inspect exact evidence citations and source-native Slack links;
- exclude manually created briefs from this leadership projection;
- keep list/detail data behind the shared-password session.

### Slack message shortcut

Context capture:

- keep the selected message as primary evidence;
- for a thread, keep the root and bounded replies in chronological order;
- for a non-thread message, let a validated model select at most four nearby candidates from a deterministic time window;
- snapshot channel name, topic, purpose, privacy, and external-sharing state;
- store each author/message/file as a separate immutable source version;
- parse text-based PDF/DOCX attachments within fixed limits;
- record unsupported media as skipped metadata without analyzing it;
- version changed context and deduplicate unchanged refreshes.

## Implemented loop

```text
source_committed
  -> event_outbox
  -> extract_memory pending_work
  -> policy_run
  -> memory_proposed
  -> validation
  -> memory_committed

slack shortcut
  -> ingest_slack_source pending_work
  -> slack_context_committed
  -> extract_slack_context pending_work
  -> memory_proposed
  -> validation / optional human review
  -> memory_committed
  -> sync_slack_reaction pending_work after extraction completion

memory_committed
  -> connect_memory pending_work
  -> enrichment_update_proposed
  -> validation
  -> connections_updated

memory_committed
  -> detect_contradiction pending_work
  -> enrichment_update_proposed
  -> validation
  -> contradictions_updated

memory_committed
  -> update_embeddings + update_graph + recompute_cluster (independent work)

connections_updated / contradictions_updated / embeddings_updated / graph_updated
  -> recompute_cluster
  -> versioned overlapping cluster projections
  -> evaluate_synthesis_readiness
  -> pending_enrichment | not_ready | synthesis_ready

synthesis_neighborhood_dirty (bounded global safety-net scan)
  -> recompute_cluster
  -> no event when the affected cluster versions are unchanged

synthesis_ready
  -> synthesize_brief pending_work
  -> bounded evidence-backed cluster dossier
  -> artifact_draft_proposed
  -> validation
  -> artifact_drafted
```

The loop runner and persistence scaffolding are installed for the full policy set. Current domain logic is real for Slack-context extraction, text extraction/sectioning/consolidation, connection, contradiction, embeddings, graph projection, clustering, readiness, and synthesis. Slack ingestion/reaction policies perform bounded connector side effects. Candidate discovery, freshness, ranking, artifact gating, and revision policies are placeholders.

The deployed Worker routes at most 4 outbox rows per scheduled or request-triggered pass and can requeue up to 25 recovered work items. Those caps protect the Cloudflare invocation budget; they do not limit total eventual work because PostgreSQL retains pending rows canonically.

### `/synthesis`

Memory Synthesis:

- load ranked corpus-wide opportunities and active memory;
- inspect readiness score, reasons, cluster scope, evidence, contradictions, and missing information;
- inspect saved suggested versions and which draft fields changed since the prior version;
- inspect trace details;
- use selected memory as retrieval seeds by default, or choose explicit selection-only mode;
- generate, edit, save, approve, reject, or regenerate a suggested draft;
- save initiative brief;
- approve/reject.

### `/graph`

Claim Graph:

- inspect graph clusters and claim details;
- review proposed claim connections;
- resolve or dismiss conflict groups;
- pin claims;
- exclude claims from synthesis.

## What the current system deliberately avoids

- initiative suggestions during ingestion;
- automated PRD generation;
- broad company-source ingestion;
- autonomous decision-making;
- hidden confidence scores;
- destructive conflict resolution;
- treating Slack channel profile/classification metadata as proof;
- analyzing unsupported Slack images, audio, video, or scanned-PDF content;
- presenting Queue delivery as canonical work state.

## Next design steps

### Current system hardening

- improve first-use UI clarity;
- add deployed browser smoke tests;
- expose model run metadata;
- improve trace details;
- add safer reset/seed tooling.

### v1 PRD

- add artifact versions;
- add PRD schema;
- add assertion-level evidence support;
- add trace appendix/export;
- add approval records bound to artifact hash and evidence bundle.

### v2 TDD

- ingest repository/engineering context;
- generate technical design drafts;
- map TDD claims to code/architecture evidence;
- add engineering approval.

### v3 continuous intelligence

- expand beyond the current Slack message shortcut to docs, meetings, tickets, metrics, and broader connector coverage;
- add currentness checks;
- add source ACLs;
- harden contradiction workflows;
- benchmark and harden the implemented vector/sparse-seeded PPR retrieval path against simpler retrieval variants.

## Engineering rules

- Keep contracts in `packages/contracts` as source of truth.
- Keep persistence invariants in SQL migrations/RPCs.
- Keep model calls behind `packages/model-gateway`.
- Never let model output write directly to tables without validation.
- Never treat semantic metadata as proof.
- Prefer explicit gaps over plausible unsupported answers.
- Keep connector sources separate by author and source identity; do not concatenate multi-author context into false single-source evidence.
