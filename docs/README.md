# Distillery Docs

This directory is organized so an implementation agent can quickly separate current product facts, implementation authority, operational runbooks, architecture rationale, and research notes.

## Read Order For Coding Agents

1. [Implementation PRD](./implementation/LOOP_SYSTEM_PRD.md)
2. [Current status](./current/STATUS_AND_ROADMAP.md)
3. [v0 runbook](./runbooks/V0_RUNBOOK.md)
4. [System design](./architecture/SYSTEM_DESIGN.md)
5. [Loop system diagram](./architecture/loop-system.mermaid)

The implementation PRD is the source of truth for the loop-system work. If another doc conflicts with it on event routing, queue ownership, policy runner behavior, validation gates, required tables, or definition of success, follow the implementation PRD.

## Implementation

- [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md) — authoritative handoff for implementing the event-driven loop system.

## Current State

- [Status and roadmap](./current/STATUS_AND_ROADMAP.md) — canonical description of what v0 currently does.
- [v0 current diagram](./current/v0-current.mermaid) — implemented private-pilot architecture.

## Runbooks

- [v0 runbook](./runbooks/V0_RUNBOOK.md) — setup, migrations, seed/reset, deploy, and smoke tests.
- [v0 build plan](./runbooks/V0_BUILD_PLAN.md) — historical build slices and backlog context.

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
- Keep operational commands in [v0 runbook](./runbooks/V0_RUNBOOK.md).

