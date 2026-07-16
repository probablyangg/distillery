# Distillery Docs

This directory is organized so an implementation agent can quickly separate current product facts, implementation authority, operational runbooks, architecture rationale, and research notes.

Start with the repository [coding-agent instructions](../AGENTS.md). They define how to resolve conflicts between code, migrations, current-state docs, and historical plans.

The code is the final source of truth. When docs and implementation disagree, inspect:

- `packages/contracts/src/index.ts` for exported API/runtime contracts;
- `apps/web/src/index.ts` for Worker routes, rendered surfaces, auth, and queue handling;
- `packages/loop/src/index.ts` for event routes and policy behavior;
- `packages/db/src/index.ts` for RPC bindings;
- `packages/db/migrations/` for persistence invariants.

## Read Order For Coding Agents

1. [Current status](./current/STATUS_AND_ROADMAP.md)
2. [Runbook](./runbooks/RUNBOOK.md)
3. The product or architecture document for the subsystem being changed.
4. The relevant implementation PRD for design constraints and history.
5. The code, tests, package manifests, and SQL migrations in that subsystem.

The current status document is the prose source of truth for what is implemented today. Implementation PRDs record the contract at the time a feature was designed; their baseline, requirements, and future-work language is historical unless the current status and code confirm it. If another doc conflicts on event routing, queue ownership, policy behavior, validation gates, required tables, or endpoint behavior, follow code/tests first, migrations second, and the current status document third.

As of 2026-07-15, `extract_memory`, `connect_memory`, `detect_contradiction`, `update_embeddings`, `update_graph`, `recompute_cluster`, `evaluate_synthesis_readiness`, and `synthesize_brief` are implemented policy workers. Candidate discovery, freshness, ranking, artifact gating, and revision remain placeholder policy runners.

## Implementation

- [Loop system PRD](./implementation/LOOP_SYSTEM_PRD.md) — original loop contract plus an implementation-status note; historical requirements do not override current code.
- [Memory synthesis policy PRD](./implementation/MEMORY_SYNTHESIS_POLICY_PRD.md) — implementation contract for the `synthesize_brief` policy worker.
- [Claim graph memory upgrade plan](./implementation/CLAIM_GRAPH_MEMORY_UPGRADE_PLAN.md) — historical implementation plan plus current delta notes for durable memory connections, conflicts, retrieval, and graph review UI.
- [Graph-grounded hybrid retrieval and synthesis PRD](./implementation/GRAPH_GROUNDED_HYBRID_RETRIEVAL_SYNTHESIS_PRD.md) — implemented contract for hybrid retrieval, graph PPR, reranking, and synthesis context selection; its baseline section describes the pre-upgrade state.

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
- Put coding-agent invariants and conflict-resolution rules in the root [AGENTS.md](../AGENTS.md).
- Label plans and PRDs as `proposed`, `partially implemented`, `implemented`, or `historical`. Never use an unlabeled “current baseline” in a completed PRD.
