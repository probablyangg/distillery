# Distillery Docs

This directory is organized so an implementation agent can quickly separate current product facts, implementation authority, operational runbooks, architecture rationale, and research notes.

## Read Order For Coding Agents

1. [Current status](./current/STATUS_AND_ROADMAP.md)
2. [Implementation PRD](./implementation/LOOP_SYSTEM_PRD.md)
3. [Runbook](./runbooks/RUNBOOK.md)
4. [System design](./architecture/SYSTEM_DESIGN.md)
5. [Loop system diagram](./architecture/loop-system.mermaid)

The current status document is the source of truth for what is implemented today. The implementation PRD is the source of truth for the intended loop-system contract. If another doc conflicts with either on event routing, queue ownership, policy runner behavior, validation gates, required tables, or definition of success, follow the current status document for reality and the PRD for intended behavior.

## Implementation

- [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md) — implementation contract for the event-driven loop system.

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
