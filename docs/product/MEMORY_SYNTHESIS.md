# Memory Synthesis

Status: manual synthesis implemented; automated grouping/discovery is future work.

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

## Current product behavior

The reviewer chooses memory manually.

The brief generator is optional. It drafts from selected memory and evidence only. The human can edit before saving.

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

## What is not implemented yet

- automatic related-memory grouping;
- initiative candidate discovery;
- candidate maturity scoring;
- readiness checks;
- evidence bundle freezing/versioning;
- assertion-level trace tables;
- contrary evidence display;
- stale-brief detection;
- PRD generation.

## Future synthesis workflow

The intended next architecture is:

```text
memory.ready event
  -> retrieve related active memory
  -> propose evidence groups
  -> detect conflicts/gaps
  -> human accepts/ignores/merges group
  -> generate initiative brief
  -> validate assertion traceability
  -> human approval
```

This should be implemented as durable workflow steps, not as one long HTTP request.
