# Memory Synthesis

Status: manual synthesis and first-pass background synthesis are implemented. Candidate discovery and human-facing evidence grouping review remain future work.

Memory Synthesis turns committed memory into a human-reviewed initiative brief.

It must preserve traceability. A brief should never hide weak evidence or present generated interpretation as proof.

## Implemented flow

```text
GET /synthesis
  -> load active memory
  -> inspect evidence and trace details
  -> select memory items
  -> optionally generate draft
  -> human edits brief
  -> save brief
  -> approve or reject
```

Implemented endpoints:

- `GET /api/memory-items`;
- `POST /api/initiative-brief-drafts`;
- `POST /api/initiative-briefs`;
- `GET /api/initiative-briefs`;
- `GET /api/initiative-briefs/{id}`;
- `POST /api/initiative-briefs/{id}/decisions`.

`POST /api/initiative-brief-drafts` accepts `expandRelatedMemory?: boolean`. The default is `false`, which preserves the original manual selected-memory behavior. When `true`, the endpoint uses the same derived synthesis bundle builder as the background policy and may include related active memory in the generated draft context.

## Current product behavior

The reviewer chooses memory manually.

The brief generator is optional. It drafts from selected memory and evidence only unless `expandRelatedMemory` is explicitly enabled. The human can edit before saving.

Background synthesis also runs after `memory_committed`. It loads synthesis context from persistence, derives a selected bundle at runtime, checks readiness, generates a traceable draft through the existing OpenRouter model gateway, emits `artifact_draft_proposed`, and auto-commits `artifact_drafted` only when validation passes.

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
- Draft generation falls back to a deterministic traceable draft if the model fails or violates validation.
- Background synthesis must select at least 2 active memory items and 2 evidence spans.
- Background synthesis must have at least 1 connection stronger than shared source/context.
- Background synthesis skips without a proposed event when memory is isolated, inactive, superseded, removed, or blocked by an unresolved contradiction.
- `artifact_drafted` creates one traceable initiative-brief draft and memory/evidence bindings idempotently during proposal commit.

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

The `synthesize_brief` policy is routed from `memory_committed` events. It reads seed memory IDs from the ledger event payload, not from `pending_work.subjectId`, because a memory commit subject can represent a source version or batch.

The policy builds a transient `SynthesisBundle`. Connection reasons can include shared entity, compatible relation, matching schema candidate, complementary claim type, shared evidence or source context, edit/supersession lineage, decision reference, contradiction warning, or blocking contradiction.

The `SynthesisBundle` itself is not persisted as canonical memory links. The claim graph pilot separately persists durable claim connections and conflict groups used by graph review and retrieval.

## What is not implemented yet

- full candidate-based initiative discovery;
- candidate maturity scoring;
- evidence bundle freezing/versioning;
- assertion-level trace tables;
- richer contrary evidence display in the synthesis UI;
- stale-brief detection;
- PRD generation.

## Future synthesis workflow

The intended next architecture is:

```text
memory_committed event
  -> synthesize_brief
  -> retrieve related active memory
  -> derive transient synthesis bundle
  -> check readiness
  -> generate initiative brief draft
  -> validate traceability
  -> auto-commit artifact_drafted
  -> human reviews saved brief later
```

Future candidate discovery and PRD generation should be implemented as durable workflow steps, not as one long HTTP request.
