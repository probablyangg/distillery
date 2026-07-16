# Distillery memory synthesis policy PRD

Status: implemented on 2026-07-08; retained as the implementation contract.

Reading rule: this PRD records the original first-pass `synthesize_brief` policy. Its direct `memory_committed -> synthesize_brief`, selected-memory compatibility default, transient readiness rules, and tests are historical. Migrations `0013` through `0015` replaced that route with independent enrichment, versioned cluster projection, explicit readiness, `synthesis_ready -> synthesize_brief`, batched auto-approved commits, and no-op unchanged global sweeps. Use the current-status and product documents for current behavior.

This PRD adds `synthesize_brief` as a first-class Loop System policy worker. It extends the current loop implementation; it does not replace the existing manual synthesis flow.

Related docs:

- Docs index: [README.md](../README.md)
- Current state: [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md)
- Loop system PRD: [LOOP_SYSTEM_PRD.md](./LOOP_SYSTEM_PRD.md)
- Memory synthesis product behavior: [MEMORY_SYNTHESIS.md](../product/MEMORY_SYNTHESIS.md)
- Memory architecture and MemGraphRAG notes: [MEMORY_ARCHITECTURE.md](../architecture/MEMORY_ARCHITECTURE.md)

## Objective

Add `synthesize_brief` as a first-class Loop System policy worker.

It runs after `memory_committed`, derives related active memory at runtime, generates a traceable initiative brief draft through the existing OpenRouter model-gateway, validates the draft, emits `artifact_draft_proposed`, and auto-commits `artifact_drafted` only when validation passes.

Human approval is not required for `artifact_drafted`. Human approval remains required for `artifact_approved`, `artifact_rejected`, `artifact_delivered`, memory edits/removals, candidate approvals, and decisions.

No graph database, MemGraphRAG service, LangGraph, new queue, or new external provider is added.

## Original repo constraints

The implementation extended the repo state that existed when this PRD was written:

- Existing loop tables: `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, `proposed_events`.
- The policy list did not yet include `synthesize_brief`.
- Existing manual synthesis endpoint: `POST /api/initiative-brief-drafts`.
- Existing brief storage: `initiative_briefs`, `initiative_brief_memory`, `initiative_brief_evidence`, `initiative_brief_decisions`.
- Existing semantic memory tables: `memory_entities`, `memory_relations`, `memory_schemas`.
- Existing `artifact_draft_proposed` and `artifact_drafted` event types already exist.
- Existing validation does not require human approval for `artifact_drafted`.

Do not create parallel artifact tables or persistent memory-link tables.

## Implementation requirements

Add `synthesize_brief` to:

- `POLICY_NAMES`;
- `PolicyNameSchema`;
- `pending_work.policy` DB check constraint via a new migration;
- policy registry in `createPolicies`;
- router tests and loop status expectations where applicable.

Add route:

```text
memory_committed -> synthesize_brief on memory
```

`synthesize_brief.buildInput` must read seed memory IDs from the causing `memory_committed` ledger event payload, not from `pending_work.subjectId`, because current `memory_committed.subjectId` may represent the source version or memory batch.

Add a persistence method for synthesis context, for example:

```ts
getMemorySynthesisContext(input: {
  tenantId: string;
  seedMemoryItemIds: string[];
  limit: number;
}): Promise<MemoryWithEvidence[]>
```

It must return active memory with evidence, entities, relations, and schemas.

Build a derived `SynthesisBundle` in memory. Connection reasons may include:

- shared entity;
- compatible relation;
- matching schema candidate;
- complementary claim type;
- shared evidence or source context;
- edit/supersession lineage;
- decision reference;
- contradiction or freshness warning.

Do not persist derived connections as canonical memory links.

Generate the brief using the existing `OpenRouterInitiativeBriefDraftModel` through `packages/model-gateway`. Do not call OpenRouter directly from policy code.

Emit `artifact_draft_proposed` with:

- `targetEventType: "artifact_drafted"`;
- `subjectType: "artifact"`;
- `subjectId: briefId`;
- `requiresHumanApproval: false`;
- payload containing `briefId`, brief fields, selected memory IDs, selected evidence span IDs, synthesis bundle, model metadata, and validation metadata.

Update `distillery_commit_validated_proposed_event` so that when `target_event_type = 'artifact_drafted'`, it atomically creates the `initiative_briefs` draft and its memory/evidence bindings before committing the ledger event. This must be idempotent for retries.

Extend `POST /api/initiative-brief-drafts` with:

```ts
expandRelatedMemory?: boolean
```

Default is `false`. When `true`, the endpoint uses the same derived bundle builder as `synthesize_brief`.

## Readiness rules

Background synthesis may draft only when all are true:

- at least 2 active memory items are selected;
- at least 2 evidence spans support the bundle;
- at least 1 connection reason is stronger than same source/context;
- no selected memory item is removed, edited, superseded, or inactive;
- no unresolved blocking contradiction exists.

If readiness fails, complete the policy run with zero proposed events and a clear skip reason in policy run metadata.

## External dependencies

No new external services, signups, API keys, queues, or databases are required.

This feature uses existing dependencies only:

- Supabase/PostgreSQL;
- Cloudflare Workers and Queues;
- OpenRouter through the existing model-gateway.

Required env/secrets remain:

```text
DATABASE_URL
DATABASE_DIRECT_URL
SUPABASE_URL
SUPABASE_SECRET_KEY
OPENROUTER_API_KEY
OPENROUTER_BASE_URL
OPENROUTER_MODEL
OPENROUTER_FALLBACK_MODELS
OPENROUTER_TIMEOUT_MS
OPENROUTER_FALLBACK_TIMEOUT_MS
DISTILLERY_APP_PASSWORD
```

Background `synthesize_brief` is allowed to call the existing OpenRouter model-gateway automatically after readiness thresholds pass.

## Definition of success

The implementation is successful when:

- a committed `memory_committed` event queues `synthesize_brief` exactly once;
- weak or isolated memory completes `synthesize_brief` without creating a draft;
- connected active memory produces one valid `artifact_draft_proposed`;
- a valid proposal auto-commits one `artifact_drafted` ledger event;
- committing `artifact_drafted` creates one traceable `initiative_briefs` draft;
- the draft references only active memory and real evidence spans;
- manual synthesis still works when `expandRelatedMemory` is omitted or `false`;
- no new external dependency is introduced;
- loop, validation, DB, model-gateway, and endpoint tests pass.

## Tests

Add or update tests for:

- policy contract accepts `synthesize_brief`;
- SQL constraint accepts `pending_work.policy = 'synthesize_brief'`;
- `memory_committed` routes to `synthesize_brief`;
- policy input reads seed IDs from ledger payload;
- derived bundle builder finds related memory through entities, relations, schemas, evidence/source context, and decisions;
- readiness failure emits no proposed event;
- contradiction blocks or warns according to severity;
- valid synthesis emits traceable `artifact_draft_proposed`;
- committing `artifact_drafted` creates an initiative brief atomically and idempotently;
- manual draft endpoint remains backward compatible.
