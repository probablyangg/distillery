# Distillery Docs

This directory is organized so an implementation agent can quickly separate current product facts, implementation authority, operational runbooks, architecture rationale, and research notes.

The code is the final source of truth. When docs and implementation disagree, inspect:

- `packages/contracts/src/index.ts` for exported API/runtime contracts;
- `apps/web/src/index.ts` for Worker routes, rendered surfaces, auth, and queue handling;
- `packages/loop/src/index.ts` for event routes and policy behavior;
- `packages/db/src/index.ts` for RPC bindings;
- `packages/db/migrations/` for persistence invariants.

## Read Order For Coding Agents

1. [Current status](./current/STATUS_AND_ROADMAP.md)
2. [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md)
3. [Memory synthesis policy PRD](./implementation/MEMORY_SYNTHESIS_POLICY_PRD.md)
4. [Claim graph memory upgrade plan](./implementation/CLAIM_GRAPH_MEMORY_UPGRADE_PLAN.md)
5. [Runbook](./runbooks/RUNBOOK.md)
6. [System design](./architecture/SYSTEM_DESIGN.md)
7. [Loop system diagram](./architecture/loop-system.mermaid)

The current status document is the prose source of truth for what is implemented today. The loop system PRD is the source of truth for the base loop contract. The memory synthesis policy PRD is the source of truth for the `synthesize_brief` worker. The claim graph memory upgrade plan records the claim-graph implementation contract and should be read with the current status document because the graph pilot is now partially implemented. If another doc conflicts with these on event routing, queue ownership, policy runner behavior, validation gates, required tables, or definition of success, follow the code and migrations first, then the current status document for reality and the relevant implementation document for intended behavior.

As of 2026-07-09, `extract_memory`, `connect_memory`, `detect_contradiction`, and `synthesize_brief` are implemented policy workers. Candidate discovery, freshness, ranking, artifact gating, and revision remain placeholder policy runners.

## Implementation

- [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md) — implementation contract for the event-driven loop system.
- [Memory synthesis policy PRD](./implementation/MEMORY_SYNTHESIS_POLICY_PRD.md) — implementation contract for the `synthesize_brief` policy worker.
- [Claim graph memory upgrade plan](./implementation/CLAIM_GRAPH_MEMORY_UPGRADE_PLAN.md) — implemented pilot plan and remaining hardening notes for durable memory connections, graph retrieval, conflicts, and graph review UI.

## Current State

- [Status and roadmap](./current/STATUS_AND_ROADMAP.md) — canonical description of what currently works.
- [Current system diagram](./current/current-system.mermaid) — implemented private-pilot architecture.

## Runbooks

- [Runbook](./runbooks/RUNBOOK.md) — setup, migrations, seed/reset, deploy, and smoke tests.
- [Build plan](./runbooks/BUILD_PLAN.md) — historical build slices and backlog context.

## Architecture

- [System design](./architecture/SYSTEM_DESIGN.md) — current architecture plus forward design principles.
- [Loop system diagram](./architecture/loop-system.mermaid) — simplified current event loop plus intended downstream policies.
- [North-star diagram](./architecture/system.mermaid) — future architecture reference, not current implementation.
- [Memory architecture](./architecture/MEMORY_ARCHITECTURE.md) — memory-layer rationale and MemGraphRAG notes.

## Product Subsystems

- [Memory Generation](./product/MEMORY_GENERATION.md)
- [Memory Synthesis](./product/MEMORY_SYNTHESIS.md)

## Research

- [MemGraphRAG paper PDF](./research/2606.00610v1.pdf)

## Rules For Updating Docs

- Keep this index current when moving or adding docs.
- Update the root [README](../README.md) when the implementation entrypoint changes.
- Do not duplicate implementation requirements across multiple docs. Link to the PRD instead.
- Keep current-state facts in [Status and roadmap](./current/STATUS_AND_ROADMAP.md).
- Keep operational commands in [Runbook](./runbooks/RUNBOOK.md).
