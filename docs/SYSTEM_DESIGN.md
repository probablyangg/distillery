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

## v0 architecture

```text
Browser
  -> Cloudflare Worker
  -> Supabase HTTP/RPC
  -> PostgreSQL ledger

Cloudflare Queue
  -> memory generation handler
  -> OpenRouter
  -> Supabase RPC commit
```

### Runtime

- `apps/web` is a Cloudflare Worker serving HTML, API routes, and the queue consumer.
- Supabase RPC functions perform multi-table atomic writes.
- OpenRouter provides structured LLM calls.
- PostgreSQL is authoritative.
- Full-text indexes, embeddings, and future graph projections are derived.

### Access

v0 uses one shared password:

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

initiative_brief
  -> initiative_brief_memory
  -> initiative_brief_evidence
  -> initiative_brief_decisions
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

v0 enforces this at the brief level by binding briefs to memory and evidence spans. Later versions should enforce assertion-level traceability.

## Implemented product surfaces

### `/`

Capture and recall:

- remember text braindumps;
- show committed memory;
- confirm/edit/remove memory;
- ask cited recall questions.

### `/synthesis`

Memory Synthesis:

- load active memory;
- inspect trace details;
- select memory;
- generate optional draft;
- save initiative brief;
- approve/reject.

## What v0 deliberately avoids

- initiative suggestions during ingestion;
- automated PRD generation;
- broad company-source ingestion;
- autonomous decision-making;
- hidden confidence scores;
- destructive conflict resolution.

## Next design steps

### v0 hardening

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
- add contradiction workflows;
- add graph retrieval only after simpler retrieval is benchmarked.

## Engineering rules

- Keep contracts in `packages/contracts` as source of truth.
- Keep persistence invariants in SQL migrations/RPCs.
- Keep model calls behind `packages/model-gateway`.
- Never let model output write directly to tables without validation.
- Never treat semantic metadata as proof.
- Prefer explicit gaps over plausible unsupported answers.
