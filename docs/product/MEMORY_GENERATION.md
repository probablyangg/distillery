# Memory Generation

Status: implemented for direct text braindumps and bounded Slack context bundles through migration `0021`.

Memory Generation turns immutable source evidence into evidence-backed, correctable memory. Direct text capture creates one source version. Slack capture creates a versioned context bundle containing separate channel-profile, message, and supported-document sources.

It does not create initiatives, PRDs, tasks, priorities, or recommendations.

## Implemented flow

### Direct text

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
  -> deterministically choose single extraction or sectioning
  -> for sectioning: request and validate ordered evidence-span boundaries
  -> fall back to deterministic boundaries if planning is unavailable or invalid
  -> claim and extract every canonical section independently
  -> parse structured JSON
  -> validate evidence and schema deterministically
  -> optionally verify/correct/classify candidates with a second model
  -> wait for every required section and deduplicate across boundaries
  -> route uncertain candidates to human review
  -> create memory_proposed
  -> auto-commit valid memory_committed
  -> independently route connection, contradiction, embedding, graph, candidate, freshness, and clustering work

Scheduled maintenance
  -> recover only expired router/worker leases
  -> close abandoned policy runs and requeue safe retries
  -> drain bounded outbox batches independently of user traffic

GET /api/ingestions/{id}
  -> return status, evidence spans, memory items, error if any
```

### Slack context

```text
Save to Distillery shortcut
  -> verify signature, workspace, invoking user, and non-DM rule
  -> durably register ingest_slack_source work
  -> add processing reaction
  -> verify channel membership and Slack Connect opt-in
  -> refresh channel profile, selected message, and bounded conversation
  -> keep thread root/replies, or at most four model-selected nearby messages
  -> parse up to five supported PDF/DOCX files within byte/text limits
  -> record unsupported media as skipped without analyzing it
  -> commit one immutable ordered context bundle
  -> slack_context_committed
  -> extract_slack_context over the current bundle's exact evidence
  -> validate/verify memory candidates through the normal proposal path
  -> replace the processing reaction with :factory: after extraction completes
```

An unchanged repeat click creates no duplicate source version, evidence, context event, or extraction. A changed reply, edit, channel profile, or supported attachment creates a linked bundle version while preserving earlier versions.

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
- `memory_section_plans`;
- `memory_sections`;
- claim graph projection/review tables populated by migration `0010_claim_graph_memory_upgrade.sql`;
- `connector_saves` and `slack_interaction_receipts`;
- `slack_context_bundles` and `slack_context_bundle_items`;
- `audit_events`;
- `outbox_events`.

Source versions and evidence spans are immutable. Memory items are correctable through append-only events. Claim graph rows, embeddings, and graph projection rows are derived from evidence-backed memory; they are not more authoritative than the underlying evidence and ledger.

Slack context does not flatten multiple authors into one document. Each message keeps its own author, timestamp, permalink, edit metadata, source version, evidence spans, and ordered role. The context bundle records why each item is present and which message is primary evidence.

## Automatic sectioning

Distillery stores the complete normalized source before deciding how to extract it. Evidence construction splits very long lines into bounded spans at sentence or word boundaries when possible. Every span keeps exact character offsets into `source_versions.content`; no planner or extractor output replaces that source.

Sectioning is enabled by default. It starts when the normalized source reaches 6,000 characters or contains at least 20 nonempty evidence spans. Sources below both thresholds retain one extraction and do not pay for a planner call.

The planner receives ordered, original evidence spans. Its output contains only section titles and the first and last evidence ID in each section. Runtime validation requires complete, exactly-once source coverage in source order, with no gaps or overlaps and no over-budget multi-span section. An invalid response follows the existing model fallback policy, then uses a deterministic heading-and-size plan if no model returns a valid plan.

Each section is a PostgreSQL checkpoint with one leased work item. Completed sections are not reprocessed when a different section fails. `POST /api/ingestions/{id}/retry` returns failed section work to the queue and preserves completed checkpoints. Consolidation cannot commit memory until every section is complete.

The extractor/verifier receives the section's original evidence spans. A response that reaches the 30-candidate ceiling is split deterministically and retried, up to three levels. After all sections complete, exact normalized duplicate statements are merged while preserving their valid source citations. Similar but nonidentical statements remain separate because small wording differences can reverse a fact. Ordinary connection and contradiction policies run after the resulting `memory_committed` events.

Operators can tune `MEMORY_SECTION_TRIGGER_CHARS`, `MEMORY_SECTION_TRIGGER_SPANS`, `MEMORY_SECTION_TARGET_CHARS`, `MEMORY_SECTION_MAX_CHARS`, and `MEMORY_SECTION_MAX_SECTIONS`, or disable the feature with `MEMORY_SECTIONING_ENABLED=false`. Smaller sections can improve high-recall extraction but increase planner/extractor/verifier calls, elapsed time, and model cost. The existing submission limit remains 50,000 characters; one source can contain at most 50 top-level sections.

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

The configured fallback list also contains `moonshotai/kimi-k2.7-code` and `~moonshotai/kimi-latest`, but current Worker call sites cap fallback attempts to the first configured model. Extractor, verifier, connection-scoring, and section-planning roles may use `MEMORY_EXTRACTOR_MODEL`, `MEMORY_VERIFIER_MODEL`, `MEMORY_CONNECTION_MODEL`, and `MEMORY_SECTION_PLANNER_MODEL`; each falls back to `OPENROUTER_MODEL` when unset.

The planner, extractor, verifier, Slack nearby selector, and Slack classifier must return structured JSON matching their contracts. They receive bounded known inputs and may return only known IDs. `SLACK_CONTEXT_MODEL` optionally overrides the model used for Slack selection/classification; it reuses the same OpenRouter key. Deterministic validation remains authoritative.

## Correction model

Memory correction is append-only:

- `confirm` marks a memory item as reviewed;
- `remove` makes it inactive;
- `edit` creates a replacement memory item and supersedes the original.

Original evidence, original extraction output, and history remain inspectable.

## Recall

Recall first runs shared hybrid vector/sparse-seeded graph retrieval, bounded Personalized PageRank, and optional model reranking. The grounded OpenRouter answer client validates that every cited claim and evidence span came from that retrieved context. If grounded answer generation or citation validation fails, recall creates a deterministic cited answer from the same retrieved claims. If retrieval itself fails or returns no claims, Distillery returns an explicit evidence gap. The legacy database lexical-answer function is not an Ask fallback.

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
- source connectors beyond direct text and the bounded Slack message shortcut;
- richer Slack media processing or OCR;
- human-reviewed canonical entity/schema promotion.
