# Distillery system design

Status: current architecture plus forward design.

Distillery is an evidence-to-decision system. Its job is not to produce persuasive documents. Its job is to preserve the chain from source evidence to memory to human-approved artifacts.

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
  -> ledger event
```

### Runtime

- `apps/web` is a Cloudflare Worker serving HTML, API routes, and the queue consumer.
- Supabase RPC functions perform multi-table atomic writes.
- OpenRouter provides structured LLM calls.
- PostgreSQL is authoritative.
- Cloudflare Queue messages are wakeups only; PostgreSQL owns committed events, outbox state, pending work, policy runs, and proposals.
- Full-text indexes, embeddings, and graph projections are derived.

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

ledger_events
  -> event_outbox
  -> pending_work
  -> policy_runs
  -> proposed_events
```

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

## Implemented loop

```text
source_committed
  -> event_outbox
  -> extract_memory pending_work
  -> policy_run
  -> memory_proposed
  -> validation
  -> memory_committed

memory_committed
  -> connect_memory pending_work
  -> memory_connection_proposed
  -> validation
  -> memory_connected

memory_committed
  -> detect_contradiction pending_work
  -> contradiction_proposed
  -> validation
  -> contradiction_recorded

memory_committed
  -> synthesize_brief pending_work
  -> artifact_draft_proposed
  -> validation
  -> artifact_drafted
```

The loop runner and persistence scaffolding are installed for the full policy set. Current production logic is real for `extract_memory`, `connect_memory`, `detect_contradiction`, and `synthesize_brief`. Candidate discovery, freshness, ranking, artifact gating, and revision policies are placeholders until their domain behavior is implemented.

### `/synthesis`

Memory Synthesis:

- load active memory;
- inspect trace details;
- select memory;
- generate optional draft;
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
- destructive conflict resolution.

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

- add Slack/docs/meeting/ticket/metric connectors;
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
