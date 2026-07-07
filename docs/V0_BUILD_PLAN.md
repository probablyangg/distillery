# Distillery v0 build plan

Status: implementation in progress

## 1. v0 outcome

v0 is one complete product composed of two systems:

```text
Memory Generation
  text braindump
  -> immutable evidence
  -> structured, correctable memory
  -> cited recall

Memory Synthesis
  committed memory
  -> related evidence groups
  -> human-created initiative
  -> readiness review
  -> traceable initiative brief
  -> human approval
```

The v0 release outcome is an approved initiative brief whose consequential assertions can be verified against exact source evidence, decisions, or explicit inference labels.

## 2. Product surfaces

### Memory Generation screen

One prompt:

> What should Distillery remember or answer?

For `Remember`, show only the structured memory items being committed and passed to Memory Synthesis. Each item has a type, normalized statement, exact source, epistemic status, and minimal edit/remove controls.

For `Ask`, show only the cited answer or explicit evidence gap.

Do not show initiative suggestions, candidate scores, initiative actions, readiness, a dashboard, or a history feed on this screen.

### Synthesis review

A separate reviewer surface shows one reviewable evidence group at a time. It explains why memories were grouped and permits a human reviewer to create, attach, merge, or ignore.

### Initiative brief review

A focused surface shows brief assertions with evidence badges, contrary evidence, gaps, lifecycle state, version diff, and approval controls.

### v0 access control

v0 does not implement formal authentication, user accounts, SSO, or RBAC. The webapp is protected by a single shared server-side password:

- environment variable: `DISTILLERY_APP_PASSWORD`;
- all app routes require the password before use;
- the password is never exposed through `NEXT_PUBLIC_*`;
- anyone with the shared password can use capture, recall, synthesis review, and approval flows;
- approval events capture a self-attested name/email label at action time, not as a verified identity claim;
- formal identity, roles, source-level ACLs, and SSO move to post-v0.

This is acceptable for a private pilot only. It should not be presented as enterprise security.

## 3. Technical architecture

```text
Cloudflare Worker web/API
  -> shared password gate
  -> Supabase HTTP API / RPC

Cloudflare Queue consumer / background Worker
  -> LangGraph workflows
  -> Supabase HTTP API / RPC
  -> model APIs

Supabase PostgreSQL
  -> application ledger
  -> pgvector extension
  -> transactional outbox

Object storage
  -> Cloudflare R2 only if larger source snapshots are added later
```

Use a TypeScript modular monolith deployed on Cloudflare Workers. Memory Generation and Memory Synthesis are application modules and background workflow handlers, not separate product services.

For v0:

- deploy the web/API surface as a Worker, with Next.js through OpenNext only if the UI needs Next.js features;
- use Cloudflare Queues for ingestion and synthesis jobs that should not run inside an HTTP request;
- use Supabase's HTTP API and Postgres RPC functions from the Worker runtime;
- use RPC functions for multi-table atomic commits, such as evidence commit, memory commit, and outbox enqueue;
- run database migrations from local/CI using `DATABASE_DIRECT_URL`, not from the request Worker;
- store Cloudflare production secrets with Wrangler secrets, not committed env files.

Long-running LangGraph work must not rely on one HTTP request staying alive. Break workflows into resumable steps and keep the database ledger authoritative.

Hyperdrive is not required for v0. It becomes useful later if Workers need direct PostgreSQL drivers, ORM access, or LangGraph's PostgreSQL checkpoint saver inside the Cloudflare runtime. Until then, avoid the extra moving part.

### Model provider

- Provider: OpenRouter.
- Primary generation model: `moonshotai/kimi-k2.7-code`.
- Fallback generation models: `~moonshotai/kimi-latest`, then `moonshotai/kimi-k2.6`.
- Environment variable: `OPENROUTER_MODEL=moonshotai/kimi-k2.7-code`.
- Fallback environment variable: `OPENROUTER_FALLBACK_MODELS=~moonshotai/kimi-latest,moonshotai/kimi-k2.6`.
- Use the OpenRouter OpenAI-compatible Chat Completions API from the model gateway.

### Embedding provider

- Provider: OpenRouter.
- Embedding model: `qwen/qwen3-embedding-8b`.
- Embedding dimensions: `1536`.
- Encoding format: `float`.
- Distance metric: cosine similarity.
- Environment variables: `EMBEDDING_PROVIDER`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_ENCODING_FORMAT`.

Reason: Qwen3 Embedding 8B has strong multilingual/retrieval performance, a 32K context window, low OpenRouter cost, and supports 1536-dimensional output. 1536 fits pgvector's standard indexed `vector` path without requiring `halfvec`.

### Authoritative and derived data

- PostgreSQL application tables are authoritative.
- Source versions and evidence spans are immutable.
- v0 workflow state is stored in application tables and outbox events.
- LangGraph checkpoints are optional post-v0 runtime infrastructure, not company memory.
- Embeddings, full-text indexes, and future graph projections are rebuildable.
- Models never write directly to persistence.

## 4. Current readiness

Verified:

- `.env.local` is present and ignored by Git;
- `OPENROUTER_API_KEY` is present in `.env.local`;
- `OPENROUTER_BASE_URL` and `OPENROUTER_MODEL` are present in `.env.local`;
- `DISTILLERY_APP_PASSWORD` is present in `.env.local`;
- `SUPABASE_URL` is present in `.env.local`;
- `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `SUPABASE_JWKS_URL` are present in `.env.local`;
- Supabase publishable and secret key prefixes are valid;
- OpenRouter generation model selected: `moonshotai/kimi-k2.7-code` with tested Moonshot fallback chain;
- OpenRouter embedding model selected and probed: `qwen/qwen3-embedding-8b` with `1536` dimensions;
- 20 Stable-specific labeled text-braindump fixtures are approved;
- Slice 1 text ingestion/evidence/memory workflow is implemented and smoke-tested with Supabase RPC;
- Slice 2 confirm/edit/remove correction flow is implemented and smoke-tested with Supabase RPC;
- Slice 3 deterministic lexical cited recall is implemented and smoke-tested with Supabase RPC;
- Slice 4 manual Memory Synthesis to approved initiative brief is implemented and smoke-tested with Supabase RPC;
- full live v0 smoke passed: text capture -> live OpenRouter memory generation -> memory storage -> traceable initiative brief -> approval -> cleanup;
- deployment target selected: Cloudflare Workers;
- Supabase session connection works on port `5432`;
- Supabase transaction pooler works on port `6543`;
- PostgreSQL authentication succeeds;
- the `vector` extension is enabled;
- v0 runtime database access simplified to Supabase HTTP/RPC; Hyperdrive and direct runtime Postgres drivers are deferred.

Still required:

- none for v0 build readiness.

## 5. Repository target

```text
distillery/
  apps/
    web/                     # Cloudflare Worker web/API surface
    worker/                  # Cloudflare Queue consumer for LangGraph workflows
  packages/
    contracts/               # Zod schemas and event/API types
    db/                      # migrations, repositories, transactions
    evidence/                # sources, versions, spans
    memory-generation/       # generation and recall workflows
    memory-synthesis/        # grouping and brief workflows
    model-gateway/           # structured model calls and run metadata
    policy/                  # shared password gate and state guards
    validation/              # provenance and output gates
  evals/
    fixtures/
    runners/
  docs/
```

Create directories only as their first deployable slice requires them; do not generate empty service scaffolds.

## 6. Core contracts to implement first

Use Zod schemas as runtime validation and generate JSON Schema where external contracts need it.

### Memory Generation

- `CaptureInput`;
- `EvidenceSpan`;
- `GeneratedMemoryBatch`;
- `MemoryItem`;
- `MemoryReadyEvent`;
- `IngestionStatus`;
- `ValidationResult`.

### Memory Synthesis

- `CandidateEdge`;
- `RelatednessDecision`;
- `SynthesisGroup`;
- `SynthesisRole`;
- `InitiativeReadiness`;
- `EvidenceBundleManifest`;
- `BriefAssertion`;
- `InitiativeBriefVersion`;
- `ApprovalRecord`.

Contract tests must reject unknown evidence IDs, invalid states, unsupported claim types, and incomplete approval bindings before prompts are written.

## 6.1 Labeled fixtures

The 20 labeled fixtures are a small local evaluation set for Memory Generation. They are not production data.

The initial review set lives in [`evals/fixtures/memory-generation/labeled-fixtures.v0.json`](../evals/fixtures/memory-generation/labeled-fixtures.v0.json).

Each fixture is one realistic input plus the expected structured output:

- raw text braindump;
- expected evidence spans with exact character offsets or source locators;
- expected memory items;
- expected claim type for each item;
- expected support span IDs;
- expected epistemic status: `observed`, `reported`, `inferred`, `assumption`, or `decision_reported`;
- expected conflicts or duplicate relationships, when relevant;
- negative expectations: what the model must not extract.

Purpose:

- catch prompt/model regressions before they reach users;
- prove evidence-span citations work;
- force unsupported claims to fail closed;
- evaluate whether the configured Moonshot model remains good enough for the extraction job.

Recommended initial mix:

- executive braindumps about Stable's payments, wallet, ecosystem, compliance, GTM, and infrastructure priorities;
- partner/customer signals;
- engineering or protocol dependencies;
- metric/impact snippets;
- contradiction or supersession cases;
- noisy captures where the correct answer is to extract little or nothing.

## 6.2 Initiative brief fields

Use a compact brief schema. The v0 brief should be easier to verify than a PRD, not a mini-PRD.

Required fields:

- title;
- owner;
- evidence bundle, including bundle ID and `as_of` timestamp;
- problem and affected users;
- recommendation, including intended outcome and scope boundary;
- must-have capabilities;
- success measure;
- blockers and risks, including unresolved decisions, dependencies, and contrary evidence;
- trace table mapping every consequential assertion to evidence, decision, or labeled inference.

Do not require full PRD sections such as detailed design, launch comms, support plans, or implementation sequencing in v0.

## 6.3 Reviewer metadata fields

Because v0 has only a shared password, reviewer metadata is self-attested and must not be treated as verified identity.

Required fields:

- reviewer label: name and email;
- action: `approve`, `request_changes`, `reject`, or `mark_stale`;
- rationale;
- evidence-reviewed attestation;
- reviewed version: artifact ID/hash and evidence bundle ID/hash;
- reviewed at timestamp.

System-only audit fields:

- password-gated session ID;
- request ID.

## 7. Database migrations

### Foundation

```text
tenants
app_sessions
audit_events
outbox_events
workflow_runs
```

### Evidence and Memory Generation

```text
ingestions
source_items
source_versions
evidence_spans
extraction_runs
observations
entities
entity_aliases
claims
claim_evidence
claim_relations
conflict_groups
conflict_group_members
```

### Recall indexes

```text
claim_embeddings
evidence_span_embeddings
```

Use `vector(1536)` columns for recall embeddings. Add full-text indexes before vector retrieval, then add HNSW cosine indexes after enough rows exist to evaluate recall.

### Memory Synthesis

```text
synthesis_runs
signal_groups
signal_group_members
initiatives
initiative_members
decisions
decision_support
evidence_bundles
briefs
brief_assertions
assertion_support
approvals
```

Every mutable aggregate has an optimistic `version`. Every tenant-scoped table has `tenant_id`. Every artifact includes content and input-state hashes.

## 8. Implementation slices

Each slice deploys working behavior on the production path. v0 is complete only after Slice 8.

### Slice 1 — text to committed memory

User outcome:

> I paste text and see exactly what Distillery will store and pass to Memory Synthesis.

Build:

- monorepo foundation, CI, linting, tests, and deployment skeleton;
- shared-password gate and single pilot tenant;
- contracts for capture, evidence, generated memory, and validation;
- foundation and evidence migrations;
- `POST /api/ingestions` and ingestion status API;
- LangGraph Memory Generation workflow;
- immutable text source/version/span storage;
- one structured LLM generation node;
- support-ID and schema validation;
- deterministic memory commit and `memory.ready` outbox event;
- minimal one-input UI and memory-item result.

Exit criteria:

- duplicate requests are idempotent;
- every displayed item opens its exact source span;
- invalid model support IDs cannot commit;
- failed model generation leaves evidence available for retry;
- no model call occurs inside a database transaction.

### Slice 2 — correction and memory history

User outcome:

> I can correct or remove an interpretation without changing the original evidence.

Build:

- observation, claim, evidence-link, and audit history;
- confirm, edit, remove, undo, and merge operations;
- append-only versions and supersession;
- extraction/prompt/model/schema version lineage;
- correction impact events for downstream synthesis.

Exit criteria:

- source evidence is immutable;
- correction history is reconstructable;
- a removed interpretation no longer enters new synthesis runs;
- earlier synthesis versions remain reproducible.

### Slice 3 — cited recall

User outcome:

> I ask about stored context and receive a cited answer or a visible evidence gap.

Build:

- lexical retrieval over active memory and evidence;
- migrate 1536-dimensional vector columns for `qwen/qwen3-embedding-8b`;
- asynchronous embeddings and hybrid retrieval;
- tenant/private-pilot filters before model context construction;
- answer evidence bundles;
- structured cited-answer generation;
- citation and access-scope validation.

Exit criteria:

- every answer assertion has an exact citation;
- unsupported questions abstain;
- superseded and conflicting claims remain visible;
- evidence outside the private pilot scope cannot influence an answer.

Current implementation status:

- deterministic lexical recall implemented;
- exact evidence-span citations returned;
- unsupported questions return an explicit gap;
- embedding tables are migrated, but asynchronous embedding generation and hybrid retrieval are still pending.

### Slice 4 — manual synthesis to approved brief

User outcome:

> A reviewer can take a known group of related memories through initiative creation and approve a traceable brief.

Build:

- synthesis, initiative, decision, bundle, brief, and approval migrations;
- manually seeded or selected evidence groups;
- dedicated synthesis review surface;
- create/attach/merge/ignore actions;
- deterministic readiness checks;
- decision and owner collection;
- frozen evidence bundles;
- structured brief assertion generation;
- trace, access-scope, contradiction, and freshness validators;
- LangGraph interrupt for human review;
- exact-version approval and Markdown export.

Exit criteria:

- a human creates the initiative;
- every consequential assertion is evidenced, decided, or explicitly inferred/assumed;
- approval binds artifact and bundle hashes;
- invalid or stale briefs cannot be approved.

Current implementation status:

- `/synthesis` reviewer surface implemented separately from the Memory Generation screen;
- active-memory selection implemented through `distillery_list_active_memory`;
- human-authored initiative brief creation implemented through `distillery_create_initiative_brief`;
- brief records bind selected memory item IDs and exact evidence span IDs;
- approve/reject decision writeback implemented through `distillery_record_initiative_brief_decision`;
- approval is blocked if supporting memory has been removed or superseded;
- Markdown export, artifact hashing, automated evidence grouping, and LangGraph interrupt workflow remain post-v0 hardening.

### Slice 5 — automatic evidence grouping

User outcome:

> Distillery presents a coherent related-memory group in the separate review surface and explains why it exists.

Build:

- `memory.ready` synthesis updater;
- deterministic candidate retrieval by entity, type, relation, time, and lexical/vector similarity;
- hub suppression and source-lineage handling;
- bounded LLM adjudication for ambiguous relatedness;
- append-only group membership decisions;
- reviewability checklist;
- quiet storage for immature groups.

Exit criteria:

- no synthesis suggestions appear on the ingestion screen;
- every group has inspectable membership reasons;
- contrary evidence is retained;
- the system cannot create or merge initiatives autonomously;
- false review-item rate meets the pilot threshold.

### Slice 6 — Stable braindump hardening

User outcome:

> Stable leadership can paste messy strategic braindumps and get trustworthy memory without the system inventing initiatives or hiding weak evidence.

Build:

- multiline text capture with exact line and character-span locators;
- Stable-specific labeled fixture suite;
- extraction eval runner for support precision, unsupported-claim rejection, and duplicate handling;
- Stable domain tags for payments, wallets, ecosystem, compliance, protocol, developer experience, and GTM;
- visible low-confidence and insufficient-evidence states;
- source-specific retry and idempotency for text captures.

Exit criteria:

- every fixture memory item links to exact text evidence;
- noisy braindumps do not produce unsupported memory;
- Stable-specific terms do not cause the model to infer roadmap approval;
- text capture remains the only v0 ingestion input.

### Slice 7 — currentness and contradiction handling

User outcome:

> Changed context is visible before I trust or approve an answer or brief.

Build:

- duplicate, temporal, mutually exclusive, and granularity conflict candidates;
- conflict review and reviewer acknowledgement;
- freshness policies and affected-artifact analysis;
- stale answer/initiative/brief states;
- non-destructive resolution records.

Exit criteria:

- original conflicting claims remain queryable;
- deterministic version changes mark affected bundles stale;
- severe conflicts block brief approval;
- no LLM can delete or overwrite a claim.

### Slice 8 — pilot reliability and release

User outcome:

> The product behaves predictably with real company context and failures are recoverable.

Build:

- shared-password gate, route protection, and single-tenant scope checks;
- persistent workflow state, outbox events, and retention;
- retries, dead-letter handling, rate/cost limits, and cancellation;
- operational and model-run observability;
- backups, deletion, export, and incident procedures;
- golden-set and pilot evaluation automation;
- accessibility and end-to-end usability testing.

Exit criteria:

- all v0 release gates pass;
- three real evidence groups become approved briefs;
- reviewers verify submitted briefs in under five minutes;
- no known unsupported assertion escapes hard gates;
- pilot users continue using capture, recall, or review without prompting.

## 9. Parallel workstreams

With a 4–6 person team:

### Product/design

- finalize memory-item presentation;
- define synthesis review interaction;
- define brief schema and reviewer metadata fields;
- recruit pilot and label fixtures.

### Platform/backend

- database migrations and repositories;
- access-control and audit foundations;
- API, workers, outbox, and checkpoints;
- idempotency, retries, and observability.

### Applied AI

- structured memory generation;
- retrieval and embeddings;
- relatedness adjudication;
- brief assertion generation;
- offline evaluation and prompt/model versioning.

### Frontend

- Memory Generation screen;
- exact-source drawer and corrections;
- synthesis review;
- brief trace review and approval.

## 10. First implementation backlog

1. Add monorepo metadata, TypeScript, test runner, linting, and CI.
2. Define Zod contracts and negative fixtures for capture, memory, and support.
3. Create tenant, ingestion, evidence, extraction, reviewer metadata, audit, and outbox migrations.
4. Configure database access roles and private-pilot scope checks.
5. Implement workflow state, retry, and outbox tables for resumable Worker jobs.
6. Implement text capture and immutable source versioning.
7. Implement exact span generation and source preview.
8. Implement structured `generateMemory` model invocation and run logging.
9. Implement support-ID, type, private-pilot access-scope, and completeness validators.
10. Commit memory transactionally and publish `memory.ready`.
11. Build the one-input Memory Generation UI and status stream.
12. Add correction/version history before expanding input types.

## 11. Testing strategy

### Contract tests

- Zod schema acceptance/rejection;
- lifecycle transition guards;
- event version compatibility;
- unknown support IDs.

### Persistence tests

- immutable source versions;
- idempotent retries;
- optimistic concurrency;
- transaction/outbox atomicity;
- tenant isolation.

### Workflow tests

- mock model structured responses;
- resume from each LangGraph checkpoint;
- failed generation retry;
- duplicate event delivery;
- human interrupt/resume;
- stale bundle rejection.

### Evaluation tests

- extraction precision/recall by claim type;
- evidence locator validity;
- citation precision;
- correct abstention;
- grouping precision and retrieval recall;
- contradiction preservation;
- unsupported-assertion escape rate.

### End-to-end tests

- text -> memory -> correction -> recall;
- memory events -> group -> initiative -> approved brief;
- source change -> stale brief;
- evidence outside the private pilot scope -> blocked recall and synthesis.

## 12. Release gates

### Memory Generation

- 100% of displayed memory items have valid exact evidence or an explicit inference label;
- 100% of citations resolve to the stored source version;
- unknown/out-of-scope evidence fails closed;
- unsupported questions abstain;
- corrections never rewrite source evidence.

### Memory Synthesis

- every group has inspectable membership reasons;
- system grouping never creates an initiative without human action;
- 100% trace coverage for consequential brief assertions;
- severe staleness and blocking contradictions prevent approval;
- approvals bind exact artifact and evidence-bundle hashes.

### Product

- at least five pilot users return weekly;
- at least three real initiatives reach approved brief;
- reviewer verification takes under five minutes;
- teams choose to use approved briefs in their actual planning process.

## 13. Decisions to finalize during Slice 1

1. Initial memory taxonomy.
2. Data retention and model-provider policy.

## 14. Explicitly deferred

- autonomous initiative creation, prioritization, or rejection;
- organization-wide dashboards and notification feeds;
- Slack/Drive/Jira background synchronization;
- dedicated graph database and PPR retrieval;
- PRD and TDD generation;
- external market/news ingestion;
- model fine-tuning;
- multi-agent orchestration;
- polished PDF export.
