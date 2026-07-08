# Distillery build plan

Status: implemented and deployed as a private pilot.

For current status and roadmap, start with [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md). This file explains the initial build structure, what shipped, and what remains.

## Product outcome

The initial build delivers two complete end-to-end systems:

```text
Memory Generation
  text braindump
  -> immutable evidence
  -> generated memory
  -> validation
  -> committed memory
  -> cited recall

Memory Synthesis
  selected active memory
  -> optional generated draft
  -> human-edited initiative brief
  -> evidence binding
  -> approve/reject decision
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
- inspect evidence and trace details;
- select related memory;
- optionally generate a brief draft;
- edit/save an initiative brief;
- approve or reject the brief.

## Implemented slices

### Slice 1 — text to committed memory

Implemented:

- text-only capture endpoint;
- immutable source versions;
- evidence spans;
- extraction runs;
- OpenRouter structured memory generation;
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
- selection limit of 1-8 memory items;
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
packages/memory-synthesis/ brief evidence and traceability validation
packages/model-gateway/    OpenRouter structured calls
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
- Add a safe `reset:stable` script for pilots.
- Add automated deployed smoke coverage for both pages.
- Add duplicate/contradiction candidate detection.
- Add basic observability for latency, fallback model use, and failure reasons.

## Deferred

- automated initiative discovery;
- automated evidence grouping;
- initiative maturity scoring;
- PRD generation;
- TDD generation;
- source connectors;
- SSO/RBAC;
- source-level ACLs;
- canonical entity/schema promotion workflow;
- graph retrieval;
- continuous freshness checks.
