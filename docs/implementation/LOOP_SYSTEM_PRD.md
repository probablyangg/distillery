# Distillery loop system implementation PRD

Status: implementation contract; initial loop infrastructure is implemented.

Reading rule: “required” sections below preserve the original loop contract. The “Historical Repo Baseline,” original model list, policy classification, route table, and event list describe the repository when this PRD was written. They are historical where they disagree with the current status, `.env.example`, `apps/web/wrangler.toml`, contracts, or routing code.

Implementation note, 2026-07-09:

- The canonical loop tables, queue wakeup shape, router, executor, proposal validation, memory auto-commit path, loop status API, and loop status UI are present in the repo.
- `extract_memory` is implemented with OpenRouter-backed memory generation and deterministic fallback. Embeddings are now produced independently by `update_embeddings` after memory commit.
- `connect_memory`, `detect_contradiction`, and `synthesize_brief` are implemented as real policy workers.
- `discover_candidate`, `check_freshness`, `rank_candidate`, `draft_artifact`, `gate_output`, and `revise_artifact` are registered placeholder implementations. Treat them as incomplete product behavior until their domain logic is implemented.
- For exact current-state facts and known gaps, read [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md) before coding.

Implementation note, 2026-07-15 (migration `0013`):

- `memory_committed` no longer routes directly to `synthesize_brief`.
- Connections, contradictions, embeddings, and graph projection are independent work items with durable completion events.
- `recompute_cluster` persists versioned overlapping cluster projections; `evaluate_synthesis_readiness` records explicit readiness states.
- Only `synthesis_ready` routes to `synthesize_brief`, which receives a bounded cluster dossier.
- The scheduled handler performs only bounded recovery, scan-event scheduling, and routing. Business logic remains in policies.
- The original event and route lists later in this historical PRD are superseded by current contracts, code, migrations `0013` through `0015`, and the current-status document.

Operational hardening note, 2026-07-15 (migrations `0014` and `0015`):

- Auto-approved proposed events are created, marked valid, and committed by one atomic RPC. This preserves individual proposal/ledger records while avoiding per-event Worker subrequests.
- The deployed scheduled and request-triggered routers process at most 4 outbox rows per pass; scheduled maintenance can requeue up to 25 recovered jobs.
- Cursor-backed global synthesis scans no longer emit `cluster_changed` when the affected cluster versions are unchanged.
- Migration `0015` resolves only redundant rollout-era global-sweep outbox rows; it does not delete domain state.

Related docs:

- Docs index: [README.md](../README.md)
- Current state: [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md)
- Current system design: [SYSTEM_DESIGN.md](../architecture/SYSTEM_DESIGN.md)
- System diagram: [loop-system.mermaid](../architecture/loop-system.mermaid)

## Objective

Implement Distillery as an event-driven evidence-to-decision loop:

```text
ledger
  -> event router
  -> pending work queue
  -> get input
  -> policy runner
  -> proposed event
  -> validation and approval
  -> ledger
```

The system must preserve source evidence, convert evidence into reviewable memory, generate artifacts only from approved/validated inputs, and keep every consequential output traceable to evidence, memory, decisions, or labeled assumptions.

## Non-Negotiable Rules

- PostgreSQL is the canonical ledger.
- Cloudflare Queue is not canonical. Its only role is waking workers with a `workItemId`.
- The event router is deterministic code, not an LLM agent.
- The policy runner is not LangGraph.
- Do not add LangGraph, CrewAI, AutoGen, or another agent orchestration framework.
- Policy runners never write directly to canonical domain tables.
- Policy runners emit proposed events.
- Validation and approval are the only path from proposed event to committed ledger event.
- Humans approve authority, delivery, priority, contradiction resolution, and destructive or superseding changes.
- Model output is never trusted without runtime validation.
- Corrections are represented by new events, not mutation or deletion of historical events.
- Source evidence remains immutable.

## Required Runtime And Framework

Implement the loop system with the existing Distillery stack:

```text
TypeScript
Cloudflare Worker
PostgreSQL / Supabase RPC
Cloudflare Queue as noncanonical wakeup transport
Zod contracts in packages/contracts
Shared validators in packages/validation
Model calls behind packages/model-gateway
Vitest for tests
```

Do not use LangGraph for the policy runner.

The "fleet of agents" is a set of named TypeScript policy modules executed by a minimal in-repo runner. Each policy has one typed input contract, one typed output contract, and one validation path.

Required policy interface:

```ts
type Policy<I, O> = {
  name: PolicyName
  version: string
  buildInput(workItem: PendingWorkItem): Promise<I>
  run(input: I): Promise<O>
  validate(output: O): Promise<ValidationGateResult>
}
```

The runner dispatches by `pending_work.policy`:

```ts
const policies: Record<PolicyName, Policy<unknown, unknown>> = {
  extract_memory,
  connect_memory,
  discover_candidate,
  check_freshness,
  detect_contradiction,
  synthesize_brief,
  rank_candidate,
  draft_artifact,
  gate_output,
  revise_artifact,
}
```

The only orchestration framework is this in-repo runner plus the ledger/outbox/queue tables defined in this PRD.

## Historical Repo Baseline

The implementation started from the repository state below, not a greenfield app. Migrations now continue through `0012`; the `0001` through `0008` line records the old baseline.

Existing runtime:

```text
apps/web/src/index.ts
  Cloudflare Worker
  HTTP routes for capture, graph-grounded recall, memory review, synthesis, graph review, and brief decisions
  queue consumer accepts MEMORY_GENERATION_QUEUE messages shaped as { workItemId }

apps/web/wrangler.toml
  Worker name: distillery-v0
  Queue binding: MEMORY_GENERATION_QUEUE
  Queue name: distillery-memory-generation

packages/contracts
  Zod contracts and exported TypeScript types

packages/validation
  Shared validation package

packages/model-gateway
  OpenRouter memory generation, initiative brief draft, embedding, and grounded answer model calls

packages/memory-generation
  capture, evidence storage, memory generation workflow, recall, memory correction logic

packages/memory-synthesis
  synthesis bundle construction and initiative brief draft traceability validation

packages/db/migrations
  SQL migrations 0001 through 0008
```

Existing domain tables remain part of the canonical system:

```text
tenants
app_sessions
ingestions
source_items
source_versions
evidence_spans
extraction_runs
memory_items
memory_item_evidence
memory_entities
memory_relations
memory_schemas
memory_item_events
initiative_briefs
initiative_brief_memory
initiative_brief_evidence
initiative_brief_decisions
memory_embeddings
```

Existing `outbox_events`, `audit_events`, and `workflow_runs` tables are legacy support tables. The loop system requires the new tables named in this PRD. Do not silently repurpose `outbox_events` or `workflow_runs` as substitutes for `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, or `proposed_events`.

The existing Cloudflare Queue binding name remains `MEMORY_GENERATION_QUEUE`. Change the message body from:

```ts
{ ingestionId: string }
```

to:

```ts
{ workItemId: string }
```

The Worker queue consumer must claim `pending_work` from PostgreSQL using `workItemId` before running any policy.

## Model-provider contract

All LLM calls must go through `packages/model-gateway`.

Use OpenRouter as the provider.

The original configured defaults were:

```text
primary generation/drafting model: deepseek/deepseek-v4-flash
fallback generation/drafting model: ~moonshotai/kimi-latest
fallback generation/drafting model: moonshotai/kimi-k2.6
embedding model: google/gemini-embedding-001
```

The embedding model is for retrieval/indexing only. It must not be treated as a reasoning policy model.

Current model IDs are configuration, not an architectural invariant. As of 2026-07-15, `.env.example` and `apps/web/wrangler.toml` default to `openai/gpt-5` with `anthropic/claude-sonnet-4.5`, `moonshotai/kimi-k2.7-code`, and `~moonshotai/kimi-latest` fallbacks. Optional `MEMORY_EXTRACTOR_MODEL`, `MEMORY_VERIFIER_MODEL`, and `MEMORY_CONNECTION_MODEL` values override the primary model for those roles.

Original planned LLM-backed policies:

```text
extract_memory
synthesize_brief
discover_candidate
draft_artifact
revise_artifact
```

Original planned deterministic policies:

```text
event_router
connect_memory
check_freshness
detect_contradiction
rank_candidate
gate_output
validation
human_review_commit
```

Current delta: `extract_memory` can call separate extractor and verifier models; `connect_memory` can use a model-gateway connection scorer after deterministic candidate generation; and `synthesize_brief` uses the model gateway. The six placeholder policies do not implement the planned domain behavior yet. Inspect `createPolicies` in `packages/loop/src/index.ts` for the current registry.

When a deterministic policy requires LLM assistance in a future change, that change must add a new model-gateway method and keep deterministic validation as the authority. Do not call model providers directly from policy modules.

## External Services, Accounts, And Secrets

No new external service is introduced by this PRD. The implementation uses the services already required by Distillery:

```text
Supabase project with PostgreSQL
Cloudflare account with Workers and Queues
OpenRouter account with API key access to the configured models
```

Required local development environment values in `.env.local`:

```text
DATABASE_DIRECT_URL
DATABASE_URL
SUPABASE_URL
SUPABASE_SECRET_KEY
OPENROUTER_API_KEY
OPENROUTER_BASE_URL
OPENROUTER_MODEL
OPENROUTER_FALLBACK_MODELS
OPENROUTER_TIMEOUT_MS
OPENROUTER_FALLBACK_TIMEOUT_MS
EMBEDDING_PROVIDER
EMBEDDING_BASE_URL
EMBEDDING_MODEL
EMBEDDING_DIMENSIONS
EMBEDDING_ENCODING_FORMAT
DISTILLERY_APP_PASSWORD
```

Required Worker secrets:

```text
DISTILLERY_APP_PASSWORD
SUPABASE_URL
SUPABASE_SECRET_KEY
OPENROUTER_API_KEY
```

Required Worker vars in `apps/web/wrangler.toml`:

```text
OPENROUTER_BASE_URL
OPENROUTER_MODEL
OPENROUTER_FALLBACK_MODELS
OPENROUTER_TIMEOUT_MS
OPENROUTER_FALLBACK_TIMEOUT_MS
EMBEDDING_PROVIDER
EMBEDDING_BASE_URL
EMBEDDING_MODEL
EMBEDDING_DIMENSIONS
EMBEDDING_ENCODING_FORMAT
```

Required Cloudflare resources:

```text
Worker: distillery-v0
Queue binding: MEMORY_GENERATION_QUEUE
Queue name: distillery-memory-generation
```

Required Supabase/PostgreSQL capabilities:

```text
pgcrypto extension
pgvector extension
SQL migrations applied through DATABASE_DIRECT_URL
Supabase RPC access through SUPABASE_URL and SUPABASE_SECRET_KEY
```

Implementation agents must stop and ask the human for missing service access or secret values. Do not invent replacements, create new third-party services, change providers, or commit secret values to the repository.

## Required Data Model

Add the following PostgreSQL tables. Keep existing domain tables for source versions, evidence spans, memory items, memory item events, initiative briefs, evidence bindings, and decisions.

### `ledger_events`

Canonical append-only event log. This table records committed system changes and references domain records. It must not duplicate full domain state.

Required columns:

```text
id text primary key
tenant_id text not null references tenants(id)
event_type text not null
subject_type text not null
subject_id text not null
actor_type text not null
actor_label text
caused_by_event_id text references ledger_events(id)
caused_by_work_item_id text
input_version text
idempotency_key text not null
payload jsonb not null default '{}'::jsonb
created_at timestamptz not null default now()
```

Required constraints:

```text
unique (tenant_id, idempotency_key)
check actor_type in ('human', 'policy', 'router', 'system', 'connector')
check subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system')
```

Required indexes:

```text
(tenant_id, created_at desc)
(tenant_id, event_type, created_at desc)
(tenant_id, subject_type, subject_id, created_at desc)
```

### `event_outbox`

Durable routing inbox for committed ledger events.

Required columns:

```text
id text primary key
tenant_id text not null references tenants(id)
ledger_event_id text not null references ledger_events(id)
status text not null default 'pending'
attempts integer not null default 0
last_error text
locked_at timestamptz
processed_at timestamptz
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Required constraints:

```text
unique (ledger_event_id)
check status in ('pending', 'processing', 'processed', 'failed')
```

Required indexes:

```text
(status, created_at)
(tenant_id, status, created_at)
```

### `pending_work`

Canonical queue state.

Required columns:

```text
id text primary key
tenant_id text not null references tenants(id)
policy text not null
subject_type text not null
subject_id text not null
caused_by_event_id text not null references ledger_events(id)
input_version text not null
status text not null default 'pending'
attempts integer not null default 0
last_error text
locked_at timestamptz
started_at timestamptz
completed_at timestamptz
cancelled_at timestamptz
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Required constraints:

```text
unique (tenant_id, policy, subject_type, subject_id, caused_by_event_id)
check status in ('pending', 'running', 'completed', 'failed', 'cancelled')
check subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system')
```

Required indexes:

```text
(status, created_at)
(tenant_id, status, created_at)
(tenant_id, subject_type, subject_id, created_at desc)
```

For work keyed by current state rather than a single causing event, compute `input_version` from the relevant ledger/domain state and use an additional unique index:

```text
unique (tenant_id, policy, subject_type, subject_id, input_version)
```

Use this pattern for freshness checks and re-gating jobs.

### `policy_runs`

Observable execution record for every policy/model run.

Required columns:

```text
id text primary key
tenant_id text not null references tenants(id)
work_item_id text not null references pending_work(id)
caused_by_event_id text references ledger_events(id)
policy_name text not null
policy_version text not null
status text not null
input_version text not null
input_hash text not null
input_summary jsonb not null default '{}'::jsonb
provider text
model text
fallback_used boolean not null default false
fallback_reason text
prompt_version text
schema_version text
output_schema_version text
validation_ok boolean
validation_issues jsonb not null default '[]'::jsonb
failure_reason text
retry_count integer not null default 0
raw_response_hash text
raw_response_ref text
prompt_tokens integer
completion_tokens integer
total_tokens integer
estimated_cost_usd numeric
started_at timestamptz not null
completed_at timestamptz
latency_ms integer
created_at timestamptz not null default now()
```

Required constraints:

```text
check status in ('running', 'completed', 'failed', 'cancelled')
```

Required indexes:

```text
(tenant_id, work_item_id, created_at desc)
(tenant_id, policy_name, created_at desc)
(tenant_id, status, created_at desc)
```

### `proposed_events`

Reviewable staging table for policy outputs before commit.

Required columns:

```text
id text primary key
tenant_id text not null references tenants(id)
work_item_id text references pending_work(id)
policy_run_id text references policy_runs(id)
proposed_event_type text not null
target_event_type text not null
subject_type text not null
subject_id text not null
payload jsonb not null
evidence_span_ids jsonb not null default '[]'::jsonb
memory_item_ids jsonb not null default '[]'::jsonb
decision_ids jsonb not null default '[]'::jsonb
requires_human_approval boolean not null
validation_status text not null default 'pending'
validation_issues jsonb not null default '[]'::jsonb
review_status text not null default 'not_required'
reviewer_label text
review_rationale text
committed_ledger_event_id text references ledger_events(id)
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Required constraints:

```text
check subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system')
check validation_status in ('pending', 'valid', 'invalid')
check review_status in ('not_required', 'pending', 'approved', 'rejected')
```

Required indexes:

```text
(tenant_id, validation_status, created_at)
(tenant_id, review_status, created_at)
(tenant_id, subject_type, subject_id, created_at desc)
```

## Required Event Types

Implement these committed event types exactly:

```text
source_committed
memory_committed
memory_confirmed
memory_edited
memory_removed
candidate_created
candidate_approved
candidate_rejected
artifact_drafted
artifact_approved
artifact_rejected
artifact_delivered
decision_committed
freshness_warning_committed
contradiction_recorded
policy_run_recorded
```

Implement these proposed event types exactly:

```text
memory_proposed
candidate_proposed
artifact_draft_proposed
freshness_warning_proposed
contradiction_proposed
decision_record_proposed
```

## Required Event Router

Implement the router as a deterministic module with this contract:

```ts
type EventRoute = {
  eventType: string
  policy: string
  subjectType: WorkSubjectType
  getSubjectId(event: LedgerEvent): string
  getInputVersion(event: LedgerEvent): string
  guard(event: LedgerEvent): Promise<boolean>
}
```

The router must:

1. claim one `event_outbox` row with `status = 'pending'`;
2. load the referenced `ledger_events` row;
3. evaluate route rules;
4. insert `pending_work` rows idempotently;
5. when a Cloudflare Queue binding is configured, send one Queue message containing only `workItemId` for each inserted `pending_work` row;
6. mark the outbox row `processed`;
7. mark the outbox row `failed` with `last_error` only after retry exhaustion.

Required route table:

```text
source_committed       -> extract_memory on source
memory_committed       -> discover_candidate on memory
memory_committed       -> check_freshness on memory
candidate_created      -> rank_candidate on candidate
candidate_approved     -> draft_artifact on candidate
artifact_drafted       -> gate_output on artifact
artifact_rejected      -> revise_artifact on artifact
decision_committed     -> check_freshness on decision
freshness_warning_committed -> no automatic follow-up work
contradiction_recorded -> no automatic follow-up work
policy_run_recorded    -> no automatic follow-up work
```

The router must not enqueue work when:

- an equivalent `pending_work` row already exists;
- the subject is archived, removed, rejected, or superseded;
- the policy already completed successfully for the same `input_version`;
- the route guard returns false;
- the event type has no route;
- the route would create work from `policy_run_recorded`, `freshness_warning_committed`, or `contradiction_recorded`.

## Required Work Executor

Implement a worker executor with this exact lifecycle:

1. Claim one `pending_work` row with `status = 'pending'`.
2. Set status to `running`, increment `attempts`, set `started_at` and `locked_at`.
3. Build typed policy input from PostgreSQL.
4. Create a `policy_runs` row with `status = 'running'`.
5. Run the named policy.
6. Write policy output into `proposed_events`.
7. Run validation.
8. Update `proposed_events.validation_status`.
9. If invalid, mark work `failed` and store validation issues.
10. If valid and human approval is not required, commit the target event to domain tables and `ledger_events` in one transaction.
11. If valid and human approval is required, set `review_status = 'pending'` and mark work `completed`.
12. Update `policy_runs` with completion/failure metadata.
13. Mark `pending_work` as `completed`, `failed`, or `cancelled`.

The executor must claim work from PostgreSQL even when invoked by Cloudflare Queue. Queue messages are hints, not authority.

## Required Context Loader

Implement one context loader per policy. Context loaders must be deterministic and must return typed objects from `packages/contracts`.

Required loaders:

```text
buildExtractMemoryInput(workItem)
buildDiscoverCandidateInput(workItem)
buildCheckFreshnessInput(workItem)
buildRankCandidateInput(workItem)
buildDraftArtifactInput(workItem)
buildGateOutputInput(workItem)
buildReviseArtifactInput(workItem)
```

Context loaders must:

- load the causing `ledger_event`;
- load the work subject;
- load exact evidence spans when relevant;
- load linked memory, decisions, and artifacts when relevant;
- compute `input_hash`;
- produce `input_summary` safe for logs/UI;
- fail fast if required subject state is missing.

## Required Policies

Implement these policies as named modules. Each policy returns proposed events only.

### `extract_memory`

Input:

```text
source_version
evidence_spans
existing_related_memory
memory_generation_schema
```

Output:

```text
memory_proposed
```

Validation:

- every memory item has at least one evidence span;
- every referenced evidence span belongs to the source;
- relation evidence span IDs are inside the parent memory item evidence set;
- claim type and epistemic status match contract enums;
- generated memory does not claim more certainty than evidence supports.

Auto-commit:

```text
memory_committed as unreviewed memory
```

### `discover_candidate`

Input:

```text
new_or_changed_memory
related_active_memory
existing_candidates
related_decisions
```

Output:

```text
candidate_proposed
```

Validation:

- candidate cites at least two memory items or one explicit human decision;
- candidate has problem, affected users, evidence summary, dependencies, risks, and open questions;
- candidate does not duplicate an active candidate.

Human approval:

Required before `candidate_approved`.

### `check_freshness`

Input:

```text
changed_memory_or_decision
related_candidates
related_artifacts
related_decisions
```

Output:

```text
freshness_warning_proposed
```

Validation:

- warning references the changed event;
- warning identifies affected candidates or artifacts;
- warning states whether the affected object is stale, contradicted, or requires review.

Auto-commit:

```text
freshness_warning_committed
```

### `detect_contradiction`

Input:

```text
new_or_changed_memory
related_memory
related_decisions
```

Output:

```text
contradiction_proposed
```

Validation:

- both sides cite evidence or decision records;
- original claims remain intact;
- proposal records the conflict but does not resolve truth.

Auto-commit:

```text
contradiction_recorded
```

Human approval is required for contradiction resolution.

### `rank_candidate`

Input:

```text
candidate
linked_memory
linked_evidence
related_decisions
open_questions
```

Output:

```text
candidate_proposed with ranking metadata
```

Validation:

- ranking factors are visible in payload;
- no hidden aggregate confidence score is required for review;
- ranking does not approve or reject the candidate.

Human approval:

Required for priority changes.

### `draft_artifact`

Input:

```text
approved_candidate
approved_or_active_memory
evidence_spans
prior_decisions
artifact_schema
```

Output:

```text
artifact_draft_proposed
```

Validation:

- candidate is approved;
- draft cites evidence, memory, decisions, or labeled assumptions;
- unresolved questions are labeled;
- dependencies and risks are included;
- artifact conforms to schema.

Auto-commit:

```text
artifact_drafted
```

Human approval:

Required before `artifact_approved` or `artifact_delivered`.

### `gate_output`

Input:

```text
artifact
linked_evidence
linked_memory
linked_decisions
freshness_warnings
contradictions
```

Output:

```text
decision_record_proposed or freshness_warning_proposed
```

Validation:

- artifact has no uncited consequential claim;
- artifact has no unresolved blocking contradiction;
- artifact uses current approved candidate state;
- artifact has required sections and trace appendix.

Human approval:

Required for delivery to engineering.

### `revise_artifact`

Input:

```text
rejected_artifact
review_rationale
linked_memory
linked_evidence
linked_decisions
```

Output:

```text
artifact_draft_proposed
```

Validation:

- revision addresses review rationale;
- revision preserves traceability;
- revision creates a new artifact version.

Auto-commit:

```text
artifact_drafted
```

## Required Human Review Gates

Auto-commit after validation:

```text
source_committed
memory_committed as unreviewed memory
freshness_warning_committed
contradiction_recorded
artifact_drafted
policy_run_recorded
```

Require human approval:

```text
memory_confirmed
memory_edited
memory_removed
candidate_approved
candidate_rejected
artifact_approved
artifact_rejected
artifact_delivered
decision_committed
contradiction resolution
priority changes
scope changes
owner changes
launch assumption changes
non-goal changes
archive/supersession actions
```

## Required Capture Behavior

When a user submits text in the app:

1. Create immutable source/evidence records.
2. Commit `source_committed`.
3. Write `event_outbox` row for that event.
4. Do not create candidates or artifacts directly from capture.
5. Let the router enqueue `extract_memory`.

Example input:

```text
dev docs need to be updated
```

Required result:

```text
source_committed
-> event_outbox
-> router
-> pending_work(extract_memory)
-> memory_proposed
-> validation
-> memory_committed as unreviewed memory
```

A single weak input becomes evidence-backed memory. It does not become a PRD.

## Required Validation Layer

Implement shared validators in `packages/validation`.

Validators must cover:

- ledger event shape;
- proposed event shape;
- work item shape;
- policy run metadata shape;
- evidence span existence;
- memory-to-evidence bindings;
- artifact-to-evidence bindings;
- artifact-to-memory bindings;
- decision references;
- source/version currentness;
- known contradiction surfacing;
- human approval requirements.

Policy-specific validators are allowed only when they call the shared validators.

## Required Contracts

Add or extend TypeScript contracts in `packages/contracts` for:

```text
LedgerEvent
EventOutboxRow
PendingWorkItem
PolicyRun
ProposedEvent
PolicyName
EventType
ProposedEventType
ActorType
WorkSubjectType
ValidationGateResult
HumanReviewDecision
```

Contracts must use zod schemas and exported inferred types, matching the existing package style.

## Required Persistence API

Expose database functions/RPCs for:

```text
commitLedgerEventWithOutbox
claimEventOutboxRow
markEventOutboxProcessed
markEventOutboxFailed
enqueuePendingWork
claimPendingWork
completePendingWork
failPendingWork
cancelPendingWork
createPolicyRun
completePolicyRun
failPolicyRun
createProposedEvent
markProposedEventValid
markProposedEventInvalid
approveProposedEvent
rejectProposedEvent
commitValidatedProposedEvent
```

Every commit that writes domain state and a ledger event must happen transactionally.

## Required Observability

Every policy/model run must record:

```text
policyName
policyVersion
status
startedAt
completedAt
latencyMs
causedByWorkItemId
causedByEventId
inputVersion
inputHash
inputSummary
provider
model
fallbackUsed
fallbackReason
promptVersion
schemaVersion
outputSchemaVersion
validationOk
validationIssues
failureReason
retryCount
rawResponseHash or rawResponseRef
promptTokens
completionTokens
totalTokens
estimatedCostUsd
```

UI must show parsed output, validation issues, and trace links before raw JSON.

## Required Idempotency

The implementation must be safe under retries, duplicate Queue messages, Worker restarts, and router replays.

Required idempotency keys:

```text
ledger_events: tenant_id + idempotency_key
event_outbox: ledger_event_id
pending_work event-triggered jobs: tenant_id + policy + subject_type + subject_id + caused_by_event_id
pending_work state-triggered jobs: tenant_id + policy + subject_type + subject_id + input_version
```

## Required Tests

Add tests for:

- capture commits `source_committed` and outbox row;
- router maps `source_committed` to exactly one `extract_memory` work item;
- router replay does not duplicate work;
- duplicated Cloudflare Queue wakeup cannot duplicate execution;
- worker claims work from Postgres before running policy;
- policy output creates `proposed_events`, not direct domain writes;
- invalid proposal cannot commit;
- valid auto-commit proposal writes domain state, `ledger_events`, and `event_outbox` transactionally;
- human-required proposal waits in review state;
- approved proposal commits exactly one ledger event;
- rejected proposal does not commit a target event;
- `memory_committed` routes configured follow-up work idempotently;
- artifact delivery requires human approval;
- every committed artifact remains bound to memory/evidence/decision references.

## Definition Of Success

This PRD is complete only when all functional, regression, and verification requirements below are true.

Functional requirements:

- Required contracts exist in `packages/contracts` with zod schemas and exported inferred TypeScript types.
- Required validators exist in `packages/validation` and are used by policy-specific validators.
- Required SQL migration creates `ledger_events`, `event_outbox`, `pending_work`, `policy_runs`, and `proposed_events` with the columns, constraints, and indexes in this PRD.
- A human text capture creates source/evidence records, `source_committed`, and `event_outbox` in one committed path.
- The router consumes outbox rows and creates canonical `pending_work` rows idempotently.
- Cloudflare Queue messages contain only `workItemId` and cannot act as canonical state.
- The worker claims work from Postgres, builds typed input, runs one policy, records `policy_runs`, and emits `proposed_events`.
- Policy output cannot bypass validation.
- Valid auto-commit proposals create domain rows, `ledger_events`, and outbox rows transactionally.
- Human-required proposals remain pending until explicit approval/rejection.
- Approved human review commits exactly one target ledger event.
- Rejected human review commits no target event and records rejection rationale.
- Router, worker, and validation behavior is covered by automated tests.
- The existing capture, recall, memory review, synthesis, and approval flows still work.
- The Worker queue consumer no longer runs memory generation directly from `{ ingestionId }`; it claims `pending_work` using `{ workItemId }`.
- `MEMORY_GENERATION_QUEUE` remains the Cloudflare binding name unless `apps/web/wrangler.toml`, deployment scripts, and this PRD are updated in the same implementation change.

Regression requirements:

- Existing API routes listed in [RUNBOOK.md](../runbooks/RUNBOOK.md) continue to respond with compatible request/response behavior unless this PRD explicitly changes them.
- Existing seeded Stable memory and starter briefs remain loadable.
- Existing memory generation validation behavior remains enforced, including relation evidence validation.
- Existing synthesis traceability validation remains enforced for generated and saved briefs.
- Existing shared-password login/session behavior remains unchanged.

Required verification commands:

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm build
```

Database verification:

```text
All migrations apply successfully to a fresh PostgreSQL database using DATABASE_DIRECT_URL.
The new migration is reversible only through normal database restore/reset procedures; do not add destructive rollback code.
```

Live/deployed verification:

```text
Run pnpm smoke:live only when live Supabase, Cloudflare, OpenRouter, and DISTILLERY_APP_PASSWORD values are available.
If live credentials are unavailable, record that live smoke was not run and provide the missing credential names.
```
