# Memory Generation

Status: implemented for v0 text braindumps.

Memory Generation turns one user-submitted text braindump into evidence-backed, correctable memory.

It does not create initiatives, PRDs, tasks, priorities, or recommendations.

## Implemented v0 flow

```text
POST /api/ingestions
  -> create ingestion
  -> store source version
  -> create evidence spans
  -> enqueue memory generation

Queue consumer
  -> load ingestion context
  -> call OpenRouter
  -> parse structured JSON
  -> validate evidence and schema
  -> commit memory through Supabase RPC
  -> mark ingestion ready

GET /api/ingestions/{id}
  -> return status, evidence spans, memory items, error if any
```

## User-facing behavior

The capture page asks:

> What should Distillery remember or answer?

For `Remember`, the page shows committed memory items and correction controls.

For `Ask`, the page returns a cited answer or an explicit evidence gap.

The capture page does not show initiative suggestions or PRD actions.

## Authoritative data

Memory Generation writes:

- `ingestions`;
- `source_items`;
- `source_versions`;
- `evidence_spans`;
- `extraction_runs`;
- `memory_items`;
- `memory_item_evidence`;
- `memory_entities`;
- `memory_relations`;
- `memory_schemas`;
- `memory_item_events`;
- `audit_events`;
- `outbox_events`.

Source versions and evidence spans are immutable. Memory items are correctable through append-only events.

## Memory item contract

Memory items use `claimType`, not `type`.

```ts
type GeneratedMemoryItem = {
  temporaryId: string;
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
  qualifiers: Record<string, unknown>;
  stableDomainTags: string[];
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

## Validation rules

Validation rejects:

- malformed model output;
- unsupported claim types;
- statements with no evidence;
- evidence IDs not present in the source version;
- duplicate normalized statements in one generation;
- `reported_decision` items marked as `observed`;
- relation evidence IDs not present in the source version;
- relation evidence IDs outside the parent memory item evidence set.

Validation does not decide company truth. It only decides whether the generated interpretation is safe enough to store as unreviewed memory.

## Model boundary

Provider:

```text
OpenRouter
```

Model chain:

```text
moonshotai/kimi-k2.7-code
  -> ~moonshotai/kimi-latest
  -> moonshotai/kimi-k2.6
```

The model must return structured JSON matching the contract. It receives evidence spans and may only cite supplied evidence IDs.

## Correction model

Memory correction is append-only:

- `confirm` marks a memory item as reviewed;
- `remove` makes it inactive;
- `edit` creates a replacement memory item and supersedes the original.

Original evidence, original extraction output, and history remain inspectable.

## Recall

v0 recall is deterministic lexical retrieval over active memory and evidence spans.

If memory supports an answer, Distillery returns:

- answer;
- evidence span IDs;
- citations;
- matched memory.

If memory does not support an answer, Distillery returns an explicit gap instead of inventing an answer.

## Future work

- embedding generation;
- hybrid lexical/vector recall;
- duplicate detection;
- contradiction detection;
- memory quality evals by `claimType`;
- source connectors beyond text;
- canonical entity/schema promotion;
- graph retrieval projection.
