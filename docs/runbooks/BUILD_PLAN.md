# Distillery build plan

Status: historical build plan. The described pilot is implemented in the repository; consult the current-status document for deployment and remaining-work claims.

Post-plan delta, 2026-07-16: corpus-wide synthesis now adds independent enrichment workers, versioned overlapping clusters, deterministic readiness/opportunity scoring, suggested brief versions, a cursor-backed global sweep, and one-RPC auto-approved proposal batches. Manual synthesis accepts 1–20 seed memories and expands related memory by default. Ask uses the shared hybrid graph retriever and, if model generation fails, degrades from the same retrieved context rather than switching to the legacy lexical-answer function. Migrations `0018`–`0021` also add a bounded, versioned Slack-context connector, reaction lifecycle, and read-only generated brief surface. Historical slice text below is preserved as build history; superseded behavior is called out where it could mislead current implementation work.

For current status and roadmap, start with [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md). This file explains the initial build structure, what shipped, and what remains.

## Product outcome

The initial build delivered memory generation and manual synthesis. The current private pilot also includes loop automation and a claim graph review surface.

```text
Memory Generation
  text braindump
  -> immutable evidence
  -> generated memory
  -> validation
  -> committed memory
  -> cited recall

Memory Synthesis
  active corpus and selected retrieval seeds
  -> ranked overlapping opportunities
  -> bounded evidence-backed dossier
  -> suggested or on-demand draft
  -> human-edited initiative brief
  -> evidence binding
  -> approve/reject decision

Claim Graph Pilot
  committed memory
  -> durable claim projection
  -> connection and conflict policies
  -> graph-grounded recall
  -> reviewer graph UI

Slack Context Pilot
  selected message shortcut
  -> bounded thread or selected nearby context
  -> immutable versioned source bundle
  -> context-level memory extraction
  -> completion reaction
```

The release outcome is an approved initiative brief whose consequential claims can be traced to exact evidence spans, selected memory, or a human decision record.

## Product surfaces

### `/` Capture and Recall

One prompt:

> What should Distillery remember or answer?

Actions:

- `Remember` — stores a text braindump as evidence, generates memory, validates it, and commits memory.
- `Ask` — answers from active memory with citations or returns an explicit evidence gap.

This screen intentionally does not show initiative suggestions, readiness scoring, candidate queues, PRD actions, or roadmap dashboards.

### `/synthesis` Memory Synthesis

Reviewer surface:

- load active memory;
- inspect ranked corpus-wide opportunities, readiness reasons, contradictions, and evidence;
- inspect evidence and trace details;
- select retrieval seeds, with related-memory expansion enabled by default;
- optionally generate or regenerate a brief draft;
- edit/save an initiative brief;
- approve or reject the brief.

### `/graph` Claim Graph

Reviewer surface:

- inspect claim clusters and details;
- accept or reject proposed connections;
- resolve or dismiss conflicts;
- pin claims;
- exclude claims from synthesis.

### `/briefs` Generated Brief Reader

- show only Distillery-generated draft and approved briefs;
- show exact evidence citations and source-native links;
- keep data behind the shared-password session.

### Slack `Save to Distillery`

- save a selected message with bounded thread or nearby context;
- keep each author and supported PDF/DOCX as separate immutable evidence;
- version changed context and deduplicate unchanged refreshes;
- replace the processing reaction only after current context extraction completes.

## Implemented slices

### Slice 1 — text to committed memory

Implemented in the original slice:

- text-only capture endpoint;
- immutable source versions;
- evidence spans;
- extraction runs;
- OpenRouter structured memory generation;
- optional second-model verification and correction of extracted candidates;
- human review proposals for uncertain memory;
- deterministic validation;
- memory commit through Supabase RPC;
- Cloudflare Queue handler.

### Slice 2 — correction and memory history

Implemented:

- confirm memory item;
- edit memory item by creating a replacement;
- remove memory item;
- append-only memory item events;
- memory history endpoint.

### Slice 3 — cited recall

Implemented:

- deterministic lexical recall;
- answer with evidence citations;
- explicit gap response when no evidence supports an answer;
- active-memory filtering.

Current replacement: the Worker Ask route uses hybrid vector/sparse seeds, a bounded graph snapshot, Personalized PageRank, optional reranking, and grounded answer generation. Deterministic fallback uses that same retrieved context. It does not call the old lexical-answer RPC.

### Slice 4 — manual synthesis to approved brief

Implemented:

- active-memory list for synthesis;
- traceable brief creation;
- memory/evidence bindings;
- approve/reject decision writeback;
- approval blocked when supporting memory becomes inactive.

### Slice 5 — generated brief draft

Implemented:

- `POST /api/initiative-brief-drafts`;
- original selection limit of 1–8 memory items, later raised to 1–20;
- OpenRouter brief drafting;
- traceability validation;
- deterministic fallback draft when model generation fails.

### Slice 6 — MemGraphRAG-aligned memory metadata

Implemented:

- renamed memory item `type` to `claimType`;
- added memory entities;
- added memory relations;
- added memory schema candidates;
- relation evidence validation;
- trace details UI;
- Stable fixture updates;
- seed-data semantic metadata;
- backfill migration for old rows.

### Slice 7 — loop automation and claim graph pilot

Implemented:

- canonical loop tables and queue wakeup handling;
- real `connect_memory`, `detect_contradiction`, and `synthesize_brief` policies;
- `0010_claim_graph_memory_upgrade.sql` graph tables, triggers, projection, and RPCs;
- hybrid vector/sparse-seeded PPR retrieval with grounded Ask answers and deterministic degraded behavior over retrieved graph context;
- `/graph` review surface;
- OpenRouter embedding and grounded-answer clients.

## Core contracts

Memory items use this shape conceptually:

```ts
type MemoryItem = {
  id: string;
  claimType:
    | "fact"
    | "user_signal"
    | "reported_decision"
    | "metric"
    | "risk"
    | "dependency"
    | "constraint"
    | "strategic_statement"
    | "ownership_statement"
    | "scope_statement";
  statement: string;
  evidenceSpanIds: string[];
  epistemicStatus:
    | "observed"
    | "reported"
    | "inferred"
    | "assumption"
    | "decision_reported";
  entities: Array<{
    name: string;
    entityType: string;
    canonicalName?: string;
  }>;
  relations: Array<{
    subject: string;
    predicate: string;
    object: string;
    evidenceSpanIds: string[];
  }>;
  schemas: Array<{
    subjectType: string;
    predicate: string;
    objectType: string;
    status: "candidate" | "stable" | "rejected";
  }>;
};
```

Important rule: semantic metadata is interpretation support. Evidence spans remain authoritative.

## Repository layout

```text
apps/web/                  Cloudflare Worker UI/API
packages/contracts/        Zod schemas and API types
packages/db/               Supabase RPC repository and SQL migrations
packages/evidence/         text normalization, hashing, evidence spans
packages/memory-generation/ capture, workflow, recall
packages/memory-retrieval/ shared hybrid graph retrieval and PPR
packages/memory-synthesis/ brief evidence and traceability validation
packages/model-gateway/    OpenRouter structured calls, embeddings, grounded answers
packages/prompts/          model prompts and bounded input renderers
packages/slack-connector/  signed shortcut, context, documents, reactions
packages/loop/             event routing, leases, policies, proposal gates
packages/validation/       memory validation
evals/fixtures/            Stable labeled fixtures
evals/runners/             fixture/live smoke runners
scripts/                   deploy and seed helpers
docs/                      architecture, runbook, roadmap
```

## Testing strategy

Current required checks:

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm retrieval:validate
pnpm build
```

Current coverage:

- evidence-span creation;
- memory validation;
- relation evidence grounding;
- workflow commit/correction behavior;
- cited recall;
- brief traceability validation;
- OpenRouter request/response parsing;
- embedding dimension and grounded-answer citation validation;
- loop routing and policy behavior through in-memory persistence;
- Slack signature/access, bounded context, attachment, versioning, and reaction behavior;
- corpus cluster/readiness/dossier behavior;
- deterministic hybrid retrieval fixtures;
- Stable fixture schema validation.

Recommended next coverage:

- browser-level login/session test;
- browser-level capture flow;
- browser-level synthesis flow;
- deployed smoke that verifies `claimType`, entities, relations, schemas, and brief generation.

## Remaining hardening backlog

- Improve first-run UX copy.
- Make trace details easier to scan.
- Add model run metadata display for generated drafts.
- Add automated deployed smoke coverage for both pages.
- Add broader duplicate detection and contradiction coverage.
- Broaden contradiction detection beyond deterministic shared-subject polarity checks.
- Add basic observability for latency, fallback model use, and failure reasons.

## Deferred

- full candidate-policy initiative discovery beyond the implemented cluster/readiness path;
- automated evidence grouping;
- initiative maturity scoring;
- PRD generation;
- TDD generation;
- connectors beyond direct text and the bounded Slack message shortcut;
- SSO/RBAC;
- source-level ACLs;
- human-reviewed canonical entity/schema promotion workflow;
- production benchmarking and hardening of vector/sparse-seeded PPR graph retrieval;
- continuous freshness checks.
