# Memory Generation

Status: implemented for text braindumps.

Memory Generation turns one user-submitted text braindump into evidence-backed, correctable memory.

It does not create initiatives, PRDs, tasks, priorities, or recommendations.

## Implemented flow

```text
POST /api/ingestions
  -> create ingestion
  -> store source version
  -> create evidence spans
  -> commit source_committed
  -> route pending work

Queue consumer or inline fallback
  -> claim pending_work by workItemId
  -> hold a fenced worker lease while model work is active
  -> load source/evidence context
  -> call OpenRouter
  -> parse structured JSON
  -> validate evidence and schema deterministically
  -> optionally verify/correct/classify candidates with a second model
  -> route uncertain candidates to human review
  -> optionally store embeddings when embedding env vars are configured
  -> create memory_proposed
  -> auto-commit valid memory_committed
  -> route graph connection, contradiction, and synthesis work

Scheduled maintenance
  -> recover only expired router/worker leases
  -> close abandoned policy runs and requeue safe retries
  -> drain bounded outbox batches independently of user traffic

GET /api/ingestions/{id}
  -> return status, evidence spans, memory items, error if any
```

## User-facing behavior

The capture page asks:

> What should Distillery remember or answer?

For `Remember`, the page shows committed memory items and correction controls.

The synthesis page also shows pending memory proposals. A reviewer can approve a valid `memory_proposed` event, which commits it and resumes downstream routing, or reject it without committing memory.

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
- `memory_embeddings`;
- `ledger_events`;
- `event_outbox`;
- `pending_work`;
- `policy_runs`;
- `proposed_events`;
- claim graph projection/review tables populated by migration `0010_claim_graph_memory_upgrade.sql`;
- `audit_events`;
- `outbox_events`.

Source versions and evidence spans are immutable. Memory items are correctable through append-only events. Claim graph rows, embeddings, and graph projection rows are derived from evidence-backed memory; they are not more authoritative than the underlying evidence and ledger.

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

Effective default Worker model chain:

```text
openai/gpt-5
  -> anthropic/claude-sonnet-4.5
```

The configured fallback list also contains `moonshotai/kimi-k2.7-code` and `~moonshotai/kimi-latest`, but current Worker call sites cap fallback attempts to the first configured model. Extractor, verifier, and connection-scoring roles may use `MEMORY_EXTRACTOR_MODEL`, `MEMORY_VERIFIER_MODEL`, and `MEMORY_CONNECTION_MODEL`; each falls back to `OPENROUTER_MODEL` when unset.

The extractor and verifier must return structured JSON matching their contracts. They receive evidence spans and may cite only supplied evidence IDs. Deterministic validation remains authoritative.

## Correction model

Memory correction is append-only:

- `confirm` marks a memory item as reviewed;
- `remove` makes it inactive;
- `edit` creates a replacement memory item and supersedes the original.

Original evidence, original extraction output, and history remain inspectable.

## Recall

Recall first tries graph retrieval plus a grounded OpenRouter answer. The grounded answer client validates that every cited claim and evidence span came from the graph retrieval context. If graph retrieval returns no claims, model generation fails, or citation validation fails, recall falls back to deterministic lexical retrieval over active memory and evidence spans.

If memory supports an answer, Distillery returns:

- answer;
- evidence span IDs;
- citations;
- matched memory.

If memory does not support an answer, Distillery returns an explicit gap instead of inventing an answer.

## Future work

- broader extraction/verifier quality evaluation;
- production hardening for embedding backfill and hybrid graph retrieval;
- duplicate detection;
- broader contradiction detection;
- memory quality evals by `claimType`;
- source connectors beyond text;
- human-reviewed canonical entity/schema promotion.
