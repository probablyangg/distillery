# Distillery Docs

This directory is organized so an implementation agent can quickly separate current product facts, implementation authority, operational runbooks, architecture rationale, and research notes.

## Read Order For Coding Agents

1. [Current status](./current/STATUS_AND_ROADMAP.md)
2. [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md)
3. [Memory synthesis policy PRD](./implementation/MEMORY_SYNTHESIS_POLICY_PRD.md)
4. [Runbook](./runbooks/RUNBOOK.md)
5. [System design](./architecture/SYSTEM_DESIGN.md)
6. [Loop system diagram](./architecture/loop-system.mermaid)

The current status document is the source of truth for what is implemented today. The loop system PRD is the source of truth for the base loop contract. The memory synthesis policy PRD is the source of truth for the `synthesize_brief` worker. If another doc conflicts with these on event routing, queue ownership, policy runner behavior, validation gates, required tables, or definition of success, follow the current status document for reality and the relevant PRD for intended behavior.

As of 2026-07-08, `synthesize_brief` is implemented as a first-class policy worker. See the current status and Memory Synthesis product docs for runtime behavior.

## Implementation

- [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md) — implementation contract for the event-driven loop system.
- [Memory synthesis policy PRD](./implementation/MEMORY_SYNTHESIS_POLICY_PRD.md) — implementation contract for the `synthesize_brief` policy worker.

## Current State

- [Status and roadmap](./current/STATUS_AND_ROADMAP.md) — canonical description of what currently works.
- [Current system diagram](./current/current-system.mermaid) — implemented private-pilot architecture.

## Runbooks

- [Runbook](./runbooks/RUNBOOK.md) — setup, migrations, seed/reset, deploy, and smoke tests.
- [Build plan](./runbooks/BUILD_PLAN.md) — historical build slices and backlog context.

## Architecture

- [System design](./architecture/SYSTEM_DESIGN.md) — current architecture plus forward design principles.
- [Loop system diagram](./architecture/loop-system.mermaid) — simplified event loop target.
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
