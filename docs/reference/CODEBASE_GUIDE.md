# Distillery codebase guide

Status: current code map, verified against the repository on 2026-07-16.

Use this guide when you need to understand where behavior lives or where to make a change. Use the [current-status page](../current/STATUS_AND_ROADMAP.md) for product state and the [runbook](../runbooks/RUNBOOK.md) for setup, deployment, and operations.

## The system in one paragraph

Distillery turns source material into immutable evidence, asks models to propose structured memory, validates those proposals, and stores accepted memory in PostgreSQL. Derived workers connect claims, detect narrow contradiction patterns, build embeddings and a graph projection, discover evidence clusters, and draft reviewable initiative briefs. Humans can correct memory, review uncertain proposals, inspect graph relationships, and approve or reject briefs. A Slack shortcut is the first connector beyond direct text capture.

## Terms used in the code

- **Source version:** one immutable snapshot of source content.
- **Evidence span:** exact text and offsets inside a source version. Evidence is authoritative.
- **Memory item:** a validated interpretation of evidence. It uses `claimType`, never `type`.
- **Ledger event:** an immutable statement that something happened in the domain.
- **Outbox:** PostgreSQL rows waiting for deterministic event routing.
- **Pending work:** canonical policy jobs in PostgreSQL.
- **Queue wakeup:** a Cloudflare Queue message containing only `{ workItemId }`. It is a prompt to look in PostgreSQL, not work state.
- **Proposed event:** policy output waiting for deterministic validation and, when required, human review.
- **Claim graph:** a rebuildable projection of evidence-backed memory, connections, conflicts, entities, and schemas.
- **Synthesis cluster:** a versioned, overlapping group of active memory that may support a brief.

## Runtime entry points

| Concern | Executable entry point | What it owns |
|---|---|---|
| HTTP, HTML, Queue, Cron | `apps/web/src/index.ts` | Routes, shared-password session, runtime wiring, Queue consumer, scheduled maintenance |
| Runtime contracts | `packages/contracts/src/index.ts` | Zod schemas, enums, API/domain types |
| Event loop | `packages/loop/src/index.ts` | Event routes, leases, policy execution, validation/commit sequencing, real and placeholder policies |
| PostgreSQL access | `packages/db/src/index.ts` | Supabase RPC client and repository/persistence adapters |
| Database behavior | `packages/db/migrations/*.sql` | Tables, constraints, triggers, RPC functions, atomic commits |
| Model boundary | `packages/model-gateway/src/index.ts` | All OpenRouter chat, embedding, reranking, and Slack-context calls |
| Prompts | `packages/prompts/src/index.ts` | System prompts and bounded input renderers |
| Slack connector | `packages/slack-connector/src/index.ts` | Signature checks, Slack API client, context selection, document parsing, reaction lifecycle |

## Package dependency direction

```text
contracts
  <- evidence, prompts, validation, model-gateway
  <- memory-generation, memory-retrieval, memory-synthesis, slack-connector
  <- loop
  <- db
  <- apps/web
```

This is a conceptual direction, not a strict layered build graph. Important boundaries are strict:

- routes and policies do not call model providers directly;
- model calls go through `packages/model-gateway`;
- multi-table canonical writes go through PostgreSQL RPC functions;
- policies propose events before canonical domain state is committed;
- evidence is never replaced by a model summary.

See [packages/README.md](../../packages/README.md) for a package-by-package map.

## Main flows

### Direct text capture

```text
POST /api/ingestions
  -> submitTextCapture
  -> normalize the complete source
  -> create exact evidence spans
  -> atomic PostgreSQL source_committed + outbox write
  -> route extract_memory work
  -> single extraction or section plan
  -> extractor + deterministic validation + optional verifier
  -> memory_proposed
  -> auto-commit verified/corrected memory, or wait for human review
  -> memory_committed
  -> independent enrichment and synthesis work
```

Long or dense text uses `memory_section_plans` and `memory_sections`. Each section is independently leased and checkpointed. `consolidate_memory` runs after all required sections complete.

### Slack shortcut

```text
Slack message action
  -> verify signature over the raw body
  -> check workspace, invoking user, and non-DM rule
  -> atomically register connector_saves + ingest_slack_source work
  -> add :hourglass_flowing_sand:
  -> verify bot membership and Slack Connect opt-in
  -> refresh selected message, channel profile, thread or nearby context
  -> parse supported PDF/DOCX files; record other media as skipped
  -> commit an immutable, ordered slack_context_bundle
  -> slack_context_committed
  -> extract_slack_context
  -> memory proposal validation/commit
  -> sync_slack_reaction only after current-bundle extraction completes
  -> replace hourglass with :factory:
```

The request handler performs cheap fail-closed checks. The leased ingestion policy performs checks that require Slack API state, including channel membership and external-sharing status.

### Ask

```text
POST /api/queries
  -> vector candidates when embeddings are configured
  -> sparse/exact candidates
  -> bounded graph snapshot
  -> Personalized PageRank in TypeScript
  -> optional OpenRouter reranking
  -> hydrate active claims, evidence, and conflicts
  -> grounded OpenRouter answer with citation validation
  -> deterministic cited answer from the same context on model failure
  -> explicit gap when retrieval cannot supply evidence
```

The legacy database lexical-answer RPC and `MemoryGenerationRepository.recallMemory` remain for compatibility and tests. The Worker Ask route does not use them.

### Corpus synthesis

```text
memory or review change
  -> connect_memory / detect_contradiction / update_embeddings / update_graph
  -> completion events
  -> recompute_cluster
  -> versioned overlapping clusters
  -> evaluate_synthesis_readiness
  -> pending_enrichment | not_ready | synthesis_ready
  -> synthesize_brief
  -> validated artifact_draft_proposed
  -> initiative_briefs + suggested brief version
  -> human edit, approve, or reject
```

Manual drafting uses selected memory as retrieval seeds by default. `expandRelatedMemory: false` is the explicit selection-only mode.

## Current policy registry

Real domain policies:

- `extract_slack_context`;
- `extract_memory`;
- `extract_memory_section`;
- `consolidate_memory`;
- `connect_memory`;
- `detect_contradiction`;
- `update_embeddings` when an embedding model is configured;
- `update_graph`;
- `recompute_cluster`;
- `evaluate_synthesis_readiness`;
- `synthesize_brief`.

Connector side-effect policies:

- `ingest_slack_source`;
- `sync_slack_reaction`.

Installed placeholders that currently emit `not_enough_context`:

- `discover_candidate`;
- `check_freshness`;
- `rank_candidate`;
- `draft_artifact`;
- `gate_output`;
- `revise_artifact`.

The exact vocabulary and current route table live in `POLICY_NAMES`, `EVENT_TYPES`, and `eventRoutes` in the contracts and loop packages.

## Canonical and derived data

Canonical facts live in PostgreSQL. The important distinction is authority, not whether a row is stored:

- source versions and evidence spans are immutable evidence;
- ledger, work, policy-run, proposal, review, and decision rows are audit state;
- memory items are validated interpretations and remain correctable;
- embeddings, full-text indexes, claim graph nodes/edges, and synthesis clusters are derived projections;
- Queue messages are transport only.

The table-family map is in [packages/db/migrations/README.md](../../packages/db/migrations/README.md).

## Where to make common changes

| Change | Start here | Also inspect |
|---|---|---|
| Add or change an HTTP endpoint | `apps/web/src/index.ts` | contracts, repository/RPC, `docs/runbooks/RUNBOOK.md` |
| Change a request/response shape | `packages/contracts/src/index.ts` | all parsers, tests, API docs |
| Add a ledger event or policy | contracts + `packages/loop/src/index.ts` | SQL check constraints, commit RPC, loop tests, diagrams |
| Change canonical persistence | new ordered SQL migration | `packages/db/src/index.ts`, fresh-migration tests, runbook migration list |
| Change extraction behavior | prompts, model-gateway, validation, loop policy | labeled fixtures and extraction evaluator |
| Change retrieval | `packages/memory-retrieval/src/index.ts` | migration `0011` RPCs, retrieval fixtures, Ask and synthesis callers |
| Change cluster/readiness behavior | `packages/memory-synthesis/src/index.ts` | loop policies, migration `0013`, corpus-synthesis tests |
| Change Slack capture | `packages/slack-connector` | contracts, migrations `0018`–`0021`, Worker wiring, Slack runbook |
| Change model/provider behavior | `packages/model-gateway` | prompts, Worker configuration, mocked gateway tests |

## Tests as executable documentation

- Package tests sit beside the implementation as `*.test.ts`.
- `packages/loop/src/index.test.ts` is the broadest executable description of event routing, leases, sectioning, enrichment, proposals, and synthesis.
- `packages/slack-connector/src/ingestion.test.ts` documents context selection, provenance, attachment behavior, and channel safety.
- `apps/web/src/briefs.test.ts` documents auth boundaries and the read-only brief/Slack-status surfaces.
- Migration assertions are in `packages/db/src/*.test.ts`.
- Deterministic golden sets are in `evals/fixtures`.

Run `pnpm build` before handoff. It runs typechecking, unit tests, memory fixture validation, and retrieval fixture validation.

## Known boundaries

- One hard-coded tenant is used by the Worker: `stable`.
- Access is a shared password, not user accounts, SSO, or RBAC.
- There is no source-level ACL enforcement.
- Slack is one allowlisted workspace. Ordinary channels require bot membership. Slack Connect requires an explicit channel opt-in.
- Slack image, audio, and video content is not analyzed. Scanned PDFs do not use OCR.
- Contradiction detection covers a narrow deterministic shared-subject polarity pattern.
- Candidate discovery, freshness, ranking, artifact gating, and revision are placeholders.
- Cluster recomputation is bounded to 500 active memories per load and is designed for pilot scale.
