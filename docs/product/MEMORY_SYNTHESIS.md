# Memory Synthesis

Status: current. Corpus-wide cluster discovery, explicit readiness, suggested background drafts, and corpus-aware manual synthesis are implemented. Migrations through `0021` preserve this path and add Slack context as another evidence source.

Memory Synthesis turns committed memory into a human-reviewed initiative brief.

It must preserve traceability. A brief should never hide weak evidence or present generated interpretation as proof.

## Implemented flow

```text
GET /synthesis
  -> load ranked cluster opportunities and active memory
  -> inspect readiness, membership reasons, evidence, contradictions, and gaps
  -> select seed memory or choose a discovered cluster
  -> expand through the corpus by default (or explicitly choose selection-only)
  -> generate or regenerate a bounded draft
  -> human edits brief
  -> save brief
  -> approve or reject
```

Implemented endpoints:

- `GET /api/memory-items`;
- `GET /api/synthesis/opportunities`;
- `POST /api/initiative-brief-drafts`;
- `POST /api/initiative-briefs`;
- `GET /api/initiative-briefs`;
- `GET /api/initiative-briefs/{id}`;
- `PATCH /api/initiative-briefs/{id}`;
- `POST /api/synthesis/clusters/{id}/generate`;
- `POST /api/initiative-briefs/{id}/decisions`.

`POST /api/initiative-brief-drafts` accepts `expandRelatedMemory?: boolean`. The default is `true`: selected memory is used as retrieval seeds against the active corpus. Set it to `false` only for deliberate selection-only generation. Responses expose the included memory, included evidence, bundle, and retrieval metadata.

## Current product behavior

The reviewer can choose memory manually or start from a ranked opportunity.

The brief generator is optional. By default it expands selected seeds through hybrid vector, sparse, and graph retrieval before building a bounded context. The human can edit before saving.

Background synthesis never runs directly from `memory_committed`. Independent connection, contradiction, embedding, and graph workers record durable completion events. Incremental dirty-neighborhood work and a bounded global sweep update overlapping cluster versions. A separate readiness policy evaluates deterministic opportunity scores. Only a `synthesis_ready` event can enqueue generation.

Synthesis does not care whether evidence began as direct text or Slack. It consumes active evidence-backed memory after normal validation. Slack channel profiles and conversation classifications may provide context, but they do not outrank exact message/document evidence.

Connection and contradiction completion invalidate the older graph-completion marker before an independently routed graph rebuild. This prevents out-of-order workers from making stale graph state appear ready. Discovery also receives bounded vector-neighbor signals from existing claim embeddings; lexical topics, entities, schemas, typed relations, and durable connections remain separate explainable signals.

Saved briefs bind to:

- selected memory item IDs;
- all evidence span IDs supporting those memory items.

Approval/rejection writes an append-only decision record with a self-attested reviewer label.

## Implemented invariants

- A brief must select at least one memory item.
- Selected memory must be active when the brief is created.
- Supporting evidence is derived from selected memory.
- Briefs remain readable if supporting memory is later edited or removed.
- Approval is blocked if supporting memory has become inactive.
- Generated drafts must include every selected memory ID and required evidence ID.
- On-demand manual draft generation falls back to a deterministic traceable draft if the model fails or violates validation. Background cluster generation instead records explicit `failed` readiness and commits no brief.
- Missing enrichment records `pending_enrichment`; weak context records `not_ready`. Neither state pretends generation succeeded.
- Removed and superseded memory is excluded from discovery, dossiers, and new suggested drafts.
- A ready cluster version and generation intent can enqueue at most one background draft.
- Suggested output must state scope, risks/dependencies, and contradictions/uncertainties, and must cite only evidence bound to selected active memory.
- `artifact_drafted` creates one traceable initiative-brief draft, one suggested-brief version, memory/evidence bindings, ledger event, and outbox row idempotently.
- Model timeouts and invalid generated drafts create an explicit `failed` readiness result and no initiative brief. The same cluster version remains failed until a distinct generation intent or a material cluster-version change is used.

## Brief fields

The current brief shape is intentionally small:

```ts
type InitiativeBrief = {
  title: string;
  problem: string;
  proposal: string;
  successMetric: string;
  risksAndDependencies?: string;
  memoryItemIds: string[];
  evidenceSpanIds: string[];
  status: "draft" | "approved" | "rejected";
};
```

This is not a PRD. It is a reviewable initiative brief.

## Traceability contract

Every saved brief must be explainable through:

- selected memory;
- exact evidence spans;
- reviewer decision record.

Semantic memory metadata (`entities`, `relations`, `schemas`) can help humans inspect context, but evidence spans remain authoritative.

## Draft generation

The draft generator receives:

- selected memory items;
- `claimType`;
- epistemic status;
- evidence IDs;
- entities;
- relations;
- schema candidates;
- exact evidence text;
- optional human intent.

It must not invent:

- customers;
- owners;
- metrics;
- approvals;
- dependencies;
- timelines.

If evidence is weak or unresolved, the draft should make uncertainty visible.

## Background synthesis policy

The durable flow is:

```text
memory_committed
  -> connect_memory | detect_contradiction | update_embeddings | update_graph
  -> recompute_cluster
  -> cluster_changed
  -> evaluate_synthesis_readiness
  -> pending_enrichment | not_ready | synthesis_ready
  -> synthesize_brief
  -> artifact_drafted suggested draft
  -> human review
```

Definitions:

- **Cluster:** a rebuildable, overlapping group of active memories that may support a brief.
- **Cluster version:** a stable token that changes only when cluster membership or meaning materially changes.
- **Dirty neighborhood:** a changed memory area that needs bounded incremental recomputation.
- **Readiness:** the deterministic state and opportunity score for one cluster version and generation intent.
- **Failed readiness:** generation was attempted but timed out or failed deterministic traceability validation; no brief was committed.
- **Synthesis bundle/dossier:** the capped, traceable model context selected from a cluster. Current caps are 16 memories, 24 evidence spans, 32 connections, 12 contradictions, 16 entities, 16 topics, and 30,000 characters.
- **Suggested brief:** a generated draft that has not received human authority.
- **Global sweep:** a cursor-backed periodic scan that makes all active memory eligible over time without loading the whole database in one Worker invocation.

Auto-approved cluster projections and readiness events commit through one atomic batch RPC. This preserves one proposed-event and ledger-event record per output while avoiding one Worker-to-database request per record. Global sweep recomputation is a no-op when the affected cluster versions are unchanged; enrichment and memory-change events still force reevaluation when state outside membership changes.

## What is not implemented yet

- model-assisted reranking of deterministic opportunity candidates;
- immutable dossier snapshots separate from suggested-brief version payloads;
- assertion-level trace tables;
- stale-brief detection;
- PRD generation.

## Known limits

Each incremental recomputation reads at most 500 active memories. Repeated cursor sweeps make all memory eligible, but this remains a pilot-scale candidate-generation strategy. Larger corpora should add PostgreSQL-partitioned neighborhood candidate indexes while preserving the same cluster/version/readiness contracts.

Suggested briefs are traceable at the brief level, not assertion by assertion. The system also has no source-level ACL filtering, stale-brief invalidation, or formal approver identity beyond a self-attested reviewer label.
