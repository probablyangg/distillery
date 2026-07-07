# v0 Memory Synthesis implementation

Status: v0 manual synthesis implemented; automated grouping workflow proposed for later.

## 0. Implemented v0 path

v0 Memory Synthesis is intentionally manual and deterministic:

```text
active memory
  -> human selects memory items
  -> human writes initiative brief
  -> Distillery binds the brief to memory + exact evidence spans
  -> human approves or rejects
  -> decision is written to the audit trail
```

Implemented surface:

- `GET /synthesis` — separate password-gated reviewer surface;
- `GET /api/memory-items` — active memory with exact evidence spans;
- `POST /api/initiative-briefs` — create a human-authored traceable brief;
- `GET /api/initiative-briefs` and `GET /api/initiative-briefs/{id}` — inspect briefs, memory, evidence, and decisions;
- `POST /api/initiative-briefs/{id}/decisions` — record approve/reject.

Implemented invariants:

- a new brief must select at least one active memory item;
- selected memory must belong to the Stable tenant;
- selected memory cannot be removed or superseded when the brief is created;
- the brief derives its evidence span set from selected memory;
- approval is blocked if supporting memory has become inactive;
- old briefs remain readable even if supporting memory is later corrected or removed.

The rest of this document describes the intended post-v0 automated grouping and generated-brief workflow.

## 1. Purpose

Memory Synthesis converts trustworthy, source-linked memory into a human-approved initiative brief.

```text
committed memory items
  -> related evidence groups
  -> reviewable synthesis proposal
  -> human-created initiative
  -> readiness checks
  -> frozen evidence bundle
  -> traceable initiative brief
  -> human approval
```

It operates across captures and over time. Memory Generation is source-local; Memory Synthesis is cross-memory.

Memory Synthesis does not appear on the ingestion screen. That screen displays only the memory items being committed and passed downstream.

## 2. What it is technically

Memory Synthesis is not a ReAct agent. Implement it as two durable LangGraph workflows:

1. **Synthesis updater:** triggered by `memory.ready`; finds related memory and maintains evidence groups.
2. **Brief workflow:** triggered by a human reviewer; freezes evidence, drafts the brief, validates it, and pauses for approval.

Splitting the workflows prevents every background group from becoming a long-running human-interaction thread.

## 3. Inputs and outputs

### Input event

```ts
type MemoryReadyEvent = {
  eventId: string;
  tenantId: string;
  ingestionId: string;
  sourceVersionId: string;
  memoryItemIds: string[];
  memoryGenerationVersion: string;
  createdAt: string;
};
```

Only committed memory IDs are accepted. Raw model output is never passed between the systems.

### Synthesis updater output

```ts
type SynthesisGroup = {
  id: string;
  tenantId: string;
  memberMemoryIds: string[];
  rolesByMemoryId: Record<string, SynthesisRole[]>;
  whyGrouped: GroupingReason[];
  contraryMemoryIds: string[];
  sourceIndependenceGroups: string[];
  status: "building" | "reviewable" | "accepted" | "ignored" | "merged";
  asOf: string;
  synthesisVersion: string;
};
```

### Brief workflow output

```ts
type InitiativeBriefVersion = {
  initiativeId: string;
  version: number;
  evidenceBundleId: string;
  assertions: BriefAssertion[];
  validation: ValidationResult;
  status: "draft" | "review" | "approved" | "rejected" | "stale";
};
```

## 4. Synthesis roles

Every included memory item has one or more explicit roles:

- `problem_evidence`;
- `affected_user`;
- `impact_evidence`;
- `metric`;
- `dependency`;
- `risk`;
- `constraint`;
- `reported_decision`;
- `strategic_context`;
- `ownership`;
- `scope`;
- `contrary_evidence`.

Evidence gaps are derived by comparing these roles with brief requirements. They are not stored as Memory Generation claims.

## 5. Workflow A: synthesis updater

```text
memory.ready
  -> loadCommittedMemory
  -> retrieveRelatedMemory
  -> buildDeterministicCandidates
  -> adjudicateAmbiguousRelatedness
  -> validateGrouping
  -> upsertEvidenceGroups
  -> evaluateReviewability
  -> publishSynthesisUpdated
```

### 5.1 Load committed memory

Load the new memory items, exact support, entities, temporal fields, conflicts, review state, and access-scope metadata.

Fail closed if an item is missing, outside the configured access scope, superseded, or absent from the `memory.ready` event.

### 5.2 Retrieve related memory

Use deterministic filters and hybrid retrieval:

1. Same tenant and configured private-pilot scope.
2. Shared canonical entities.
3. Compatible claim types and synthesis roles.
4. Explicit relationships or dependencies.
5. Temporal proximity and overlapping valid time.
6. Lexical similarity.
7. Vector similarity when embeddings are available.

Retrieval returns candidates. It does not establish that items belong together.

### 5.3 Build deterministic candidates

Create candidate edges with transparent features:

```ts
type CandidateEdge = {
  leftMemoryId: string;
  rightMemoryId: string;
  sharedEntityIds: string[];
  compatibleRoles: string[];
  lexicalScore?: number;
  vectorScore?: number;
  temporalOverlap: boolean;
  explicitRelationshipIds: string[];
};
```

Reject candidates based only on generic entities such as “customer,” “platform,” or “team.” Apply high-degree hub suppression before clustering.

### 5.4 Adjudicate ambiguous relatedness

Use an LLM only when deterministic features cannot confidently accept or reject a candidate relationship.

The structured result is constrained to supplied memory and evidence IDs:

```ts
const RelatednessDecision = z.object({
  related: z.boolean(),
  relationship: z.enum([
    "same_problem",
    "same_user_need",
    "dependency",
    "impact",
    "risk",
    "context_only",
    "unrelated",
  ]),
  rationaleMemoryIds: z.array(z.string()),
  confidenceBand: z.enum(["low", "medium", "high"]),
});
```

The model cannot create entities, claims, decisions, initiatives, or evidence IDs in this step.

### 5.5 Validate grouping

Deterministic validation checks:

- all members exist and are inside the configured access scope;
- every grouping reason references supplied memory IDs;
- no member is silently excluded because it contradicts the group;
- temporal claims are compatible or visibly disputed;
- copied statements sharing one origin count as one evidence lineage;
- the group is not a duplicate of an existing group or initiative;
- model and policy versions are recorded.

### 5.6 Upsert evidence groups

Groups are derived syntheses, not truth records. Store memberships with their origin and disposition:

```text
proposed -> accepted | rejected
accepted -> removed
```

Never replace group membership wholesale. Append membership decisions so later reviewers can reconstruct why a memory entered or left the group.

### 5.7 Evaluate reviewability

Reviewability is a checklist, not one maturity score.

A group becomes `reviewable` when it has:

- a coherent problem hypothesis supported by at least one current memory item;
- identified affected users or an explicit missing-user warning;
- more than a generic topic relationship;
- no access-scope violation;
- no duplicate accepted initiative;
- visible conflicts and source-lineage information;
- a grouping rationale a reviewer can inspect.

An authoritative single source may be sufficient. Frequency is not a hard requirement.

Groups that are not reviewable remain stored quietly. They do not appear on the ingestion screen or create notifications.

## 6. Human review surface

Use a separate password-gated reviewer route, not the Memory Generation screen.

```text
/review/synthesis/{groupId}
```

Show one proposal at a time:

- provisional problem hypothesis;
- why the memories were grouped;
- strongest supporting evidence;
- contrary evidence;
- source independence;
- currentness;
- gaps and unresolved decisions.

Available actions:

- `Create initiative`;
- `Attach to existing initiative`;
- `Merge with another group`;
- `Ignore`;
- `Correct memory` — returns to Memory Generation and creates a new version.

The system never creates an initiative until a human reviewer selects one of the first three actions.

## 7. Workflow B: initiative brief

```text
human accepts synthesis group
  -> createInitiative
  -> classifyMembershipRoles
  -> evaluateReadiness
  -> collectOwnerAndDecisions
  -> freezeEvidenceBundle
  -> generateBriefAssertions
  -> validateBrief
  -> interruptForReview
  -> approve | revise | reject
  -> publishBriefApproved
```

### 7.1 Readiness

Before brief generation, require:

- initiative owner;
- evidenced problem hypothesis;
- affected user evidence;
- strategic-fit decision and decision owner;
- visible dependencies and risks;
- blocking contradictions resolved or explicitly acknowledged;
- no severe staleness or access-scope violation.

Missing information remains visible. Readiness cannot be overridden by prose generation.

### 7.2 Freeze evidence bundle

The bundle manifest contains exact versions of:

- memory items and claims;
- evidence spans and source versions;
- decisions;
- conflicts and acknowledgements;
- retrieval/grouping policy;
- model and schema versions;
- `as_of` time.

Hash the manifest. Brief generation accepts only `evidenceBundleId`.

### 7.3 Generate brief assertions

The LLM produces structured atomic assertions. It may select only allowlisted support IDs from the bundle.

```ts
const BriefAssertion = z.object({
  temporaryId: z.string(),
  section: z.enum([
    "problem",
    "affected_users",
    "impact",
    "metrics",
    "dependencies",
    "risks",
    "strategy",
    "scope",
    "non_goals",
    "gaps",
  ]),
  text: z.string(),
  epistemicStatus: z.enum([
    "evidenced",
    "decided",
    "inferred",
    "assumed",
    "unknown",
  ]),
  supportIds: z.array(z.string()),
  ownerId: z.string().optional(),
});
```

The model may output `unknown` or `insufficient_evidence`. It cannot fill missing fields with plausible prose.

### 7.4 Validate brief

Hard blockers:

- any consequential assertion lacks evidence, a decision, or an explicit inference/assumption label;
- unknown or out-of-scope support ID;
- support absent from the frozen bundle;
- severe staleness;
- unresolved blocking contradiction;
- missing initiative owner or strategic decision;
- artifact or bundle hash mismatch.

### 7.5 Human review and approval

Use a LangGraph interrupt after deterministic validation passes. Approval records:

- brief version and hash;
- evidence bundle and hash;
- reviewer name/email metadata;
- disposition and rationale;
- timestamp.

New evidence never silently edits an approved brief. It marks the relevant initiative or brief `stale` and starts a new version.

## 8. LLM boundary

The LLM may:

- adjudicate ambiguous relatedness;
- propose synthesis roles;
- draft a provisional problem hypothesis;
- generate structured brief assertions;
- explain evidence gaps.

The LLM may not:

- retrieve outside the configured private-pilot scope;
- write directly to PostgreSQL;
- create effective decisions;
- create or approve initiatives;
- resolve truth destructively;
- invent evidence IDs;
- decide readiness or lifecycle transitions;
- hide contrary evidence.

## 9. Persistence model

```text
synthesis_runs
  id, tenant_id, trigger_event_id, workflow_version,
  started_at, completed_at, status

signal_groups
  id, tenant_id, version, status, as_of,
  synthesis_version, supersedes_group_id

signal_group_members
  group_id, memory_item_id, roles, disposition,
  inclusion_reason, decided_by, created_at

initiatives
  id, tenant_id, title, problem_hypothesis,
  owner_id, status, version

initiative_members
  initiative_id, memory_item_id, roles,
  disposition, reviewed_by

decisions
  id, initiative_id, type, statement, rationale,
  owner_id, decided_by, status, supersedes_decision_id

evidence_bundles
  id, initiative_id, version, as_of,
  manifest_json, manifest_hash

briefs
  id, initiative_id, version, evidence_bundle_id,
  content_json, content_hash, status

brief_assertions
  id, brief_id, json_pointer, type, text,
  epistemic_status, owner_id

assertion_support
  assertion_id, support_type, support_id, relationship

approvals
  id, artifact_id, artifact_version, artifact_hash,
  evidence_bundle_id, bundle_hash, approver_id,
  role, disposition, rationale, created_at
```

## 10. APIs and events

```text
POST /internal/events/memory-ready

GET  /api/synthesis/review/next
GET  /api/synthesis/groups/{id}
POST /api/synthesis/groups/{id}/create-initiative
POST /api/synthesis/groups/{id}/attach
POST /api/synthesis/groups/{id}/merge
POST /api/synthesis/groups/{id}/ignore

GET  /api/initiatives/{id}
GET  /api/initiatives/{id}/readiness
POST /api/initiatives/{id}/decisions
POST /api/initiatives/{id}/bundles
POST /api/initiatives/{id}/briefs
POST /api/briefs/{id}/reviews
POST /api/briefs/{id}/approvals
```

Mutations require an idempotency key and expected entity version.

## 11. Idempotency and concurrency

- Deduplicate incoming events by `eventId`.
- Coalesce rapid memory events per tenant before retrieval.
- Synthesis run key: `(tenant_id, trigger_event_id, workflow_version)`.
- Bundle creation key: `(initiative_id, input_state_hash, policy_version)`.
- Brief generation key: `(evidence_bundle_id, brief_schema_version, generator_version)`.
- Use optimistic versions when changing group, initiative, and brief state.
- Serialize merges affecting the same groups or initiatives.
- Publish state-change events through the transactional outbox.

## 12. Evaluation

Create a labeled set of related and unrelated memory groups covering:

- same problem expressed differently;
- same customer but unrelated problems;
- generic shared entities;
- repeated copies from one origin;
- rare authoritative evidence;
- temporal changes;
- mutually exclusive claims;
- granularity differences;
- overlapping initiatives;
- duplicate accepted initiatives.

Measure:

- candidate retrieval recall;
- grouping precision;
- false review-item rate;
- contradiction preservation;
- source-independence accuracy;
- reviewer correction rate;
- time to accept, attach, merge, or ignore;
- brief trace coverage and citation precision;
- unsupported-assertion escape rate;
- time to verify an approved brief.

Optimize grouping precision before recall. Excessive weak proposals will destroy trust and reviewer attention.

## 13. First synthesis vertical slice

> Three committed memory items from two captures describe the same user problem. The synthesis updater groups them with an inspectable rationale. A reviewer creates an initiative, supplies the owner and strategic decision, generates a source-linked brief, and approves the exact version.

Initially use manually labeled fixture groups to exercise the entire brief workflow. Add automatic candidate retrieval only after the review and traceability path is working.
