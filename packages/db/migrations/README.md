# Database migrations

SQL migrations define the canonical persistence behavior. Apply every file in filename order. Never infer that the highest-numbered file can be applied safely while earlier files are missing.

The current schema is `0001` through `0021`.

## Table families

- Sources: `ingestions`, `source_items`, `source_versions`, `evidence_spans`, `extraction_runs`.
- Memory: `memory_items`, memory/evidence bindings, entities, relations, schemas, correction events.
- Loop: `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, `proposed_events`.
- Section checkpoints: `memory_section_plans`, `memory_sections`.
- Claim graph: observations, claims, evidence links, promoted semantic registries, connections, conflicts, graph nodes/edges, reviewer preferences.
- Retrieval: full-text indexes and `memory_embeddings`; older embedding tables remain from earlier migrations for compatibility.
- Synthesis: initiative briefs and decisions, enrichment state, clusters/versions/memberships, readiness evaluations, suggested brief versions, dirty neighborhoods, global cursor.
- Slack: `connector_saves`, replay receipts, immutable context bundles, and ordered bundle items.
- Legacy support: early workflow/outbox/session/audit tables remain part of the schema where later migrations still depend on them.

## Evolution by migration range

- `0001`–`0006`: direct text capture, immutable evidence, memory correction/recall/briefs, and semantic metadata.
- `0007`–`0009`: canonical event loop, UI-safe status read model, and first background brief policy.
- `0010`–`0012`: claim graph, hybrid retrieval RPCs, leases, fencing, and scheduled recovery.
- `0013`–`0015`: corpus-wide clusters/readiness/suggested drafts, atomic proposal batching, and redundant sweep cleanup.
- `0016`–`0017`: independently leased document sections and preferred routing for a new capture.
- `0018`–`0019`: Slack connector, read-only generated briefs, and two-stage reaction lifecycle.
- `0020`–`0021`: context-aware Slack bundles, immutable refresh/version behavior, context extraction, and unchanged-refresh reaction sync.

The [runbook](../../../docs/runbooks/RUNBOOK.md#database-migrations) describes every migration and gives safe application commands.

## Change rules

- Add a new migration. Do not edit an already-applied migration to change live behavior.
- Keep changes additive unless a human explicitly authorizes a destructive migration.
- Update TypeScript contracts, RPC adapters, tests, the migration list, and architecture docs together.
- Test the complete sequence on a fresh database.
- On an existing database, apply every unapplied migration in order.
- Do not reset or reseed a database without explicit human authorization for the named target.
