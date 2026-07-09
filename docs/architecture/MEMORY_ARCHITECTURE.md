# Distillery memory layer: lessons from MemGraphRAG

Status: research/reference and forward architecture recommendation.

The current implementation borrows the MemGraphRAG separation partially:

- evidence spans are authoritative;
- memory items use `claimType`;
- memory items include `entities`, `relations`, and `schemas`;
- schema entries are candidates only;
- migration `0010_claim_graph_memory_upgrade.sql` projects memory into observations, claims, claim evidence, promoted entities/predicates/schema patterns, claim connections, conflict groups, graph nodes, and graph edges;
- graph recall, graph clusters, connection review, conflict resolution, claim pinning, and synthesis exclusion are implemented as a pilot;
- OpenRouter embeddings can be stored during extraction when embedding env vars are configured;
- there is no human-reviewed canonical entity/schema promotion workflow yet;
- graph retrieval is lexical/neighborhood based and does not use vector ranking or Personalized PageRank yet;
- contradiction detection is deterministic and narrow, not a production-grade adjudication system.

Use [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md) for current project state. Use this file for design rationale and future memory-layer direction.

Sources reviewed:

- Wu et al., *MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation*, arXiv:2606.00610v1, especially Sections 4–5 and Appendices D–E.
- `XMUDeepLIT/MemGraphRAG` at commit `cd6fabda1ec31a302bb283089e17c087ab7713e8` (2026-06-21).

## 1. Recommendation

Distillery should adopt MemGraphRAG's central separation:

```text
source evidence <-> concrete assertions <-> abstract semantic schema
```

It should not adopt MemGraphRAG's memory representation or conflict-resolution behavior directly.

For Distillery, the authoritative memory should be an append-only, temporal evidence and claim ledger. Vector search and a knowledge graph should be rebuildable projections of that ledger, not the canonical database.

The proposed Distillery structure is:

```text
Evidence
  <-> Observations
  <-> Claims
  <-> Schema / taxonomy

Claims
  <-> Decisions and authority
  <-> Initiative synthesis

Authoritative ledger
  -> lexical index
  -> vector index
  -> retrieval graph
```

This preserves the paper's useful hierarchical grounding while adding the temporal, authorization, decision, ownership, and audit semantics required for company intelligence.

## 2. What MemGraphRAG actually does

### Three-layer global memory

MemGraphRAG represents memory as three bidirectionally linked layers:

1. **Ontology/schema:** abstract triples such as `(Person, works_for, Organization)`.
2. **Fact:** concrete triples such as `(Angela, works_for, Acme)`.
3. **Passage:** original chunks supporting extracted facts.

The conceptual relationships are:

```text
Schema --1:N--> Fact --N:M--> Passage
```

Schemas constrain facts; facts instantiate schemas. Facts point to their supporting passages; passages index the facts extracted from them.

### Indexing pipeline

The paper describes:

```text
document chunks
  -> schema, fact, and passage candidates
  -> pending/stable schema filtering
  -> conflict candidate detection
  -> evidence-backed conflict adjudication
  -> type/entity/passage retrieval graph
```

Its key principles are:

- extracted knowledge begins as a hypothesis rather than immediate graph truth;
- low-frequency schema patterns remain outside the active graph;
- logical, temporal, and granularity conflicts are detected globally;
- conflict resolution retrieves original passages;
- the graph is constructed from the resolved memory rather than being the memory itself.

### Retrieval pipeline

The paper describes parallel retrieval from schema, fact, and passage memory, relevance filtering, structure-aware node initialization, and Personalized PageRank. If no useful schema or fact is found, retrieval falls back to dense passage retrieval.

The graph provides multi-hop expansion; passages remain the final evidence returned to generation.

### Evidence from the paper

The reported ablation study indicates that schema filtering, conflict resolution, hub suppression, and passage information-density weighting all contribute. Removing conflict resolution causes the largest reported HotpotQA degradation among those ablations. This supports Distillery's emphasis on contradiction handling, but it does not validate autonomous conflict resolution for organizational decisions.

## 3. Important differences between the paper and repository

The code is a research artifact, not a direct implementation blueprint for production company memory.

| Paper concept | Repository behavior at reviewed commit | Consequence |
|---|---|---|
| Composite schema/fact/passage extraction | Runs OpenIE first, constructs fact/passage memory, then asks an LLM for one schema per fact | Sequential and more restrictive than the paper's description |
| Pending and stable schemas | Frequency filtering removes low-frequency schemas and their facts from the final memory | Rare but important signals can disappear |
| Hybrid vector and symbolic conflict candidates | Candidate generation primarily groups exact normalized subject/relation pairs, with an optional reverse-relation check | It does not implement the paper's broad vector candidate scan in this path |
| Evidence-backed adjudication | An LLM returns `kept`, `modified`, or `discarded`; the code rebuilds and renumbers the fact layer | Original conflicting truth can be lost from the canonical snapshot |
| Persistent global memory | Memory is serialized to JSON snapshots containing list indices | No transactional updates, stable IDs, bitemporal history, or concurrent writes |
| Detailed conflict audit | Detailed detection/resolution artifacts are optional; default mode persists the resolved memory | Default output is insufficient for Distillery-grade auditability |
| Multi-layer retrieval | Runtime retrieval directly embeds facts and passages, seeds entity/passage nodes, and runs PPR; no separate schema embedding retrieval is visible in this path | The implemented online path is narrower than Algorithm 2 |
| Fine-grained provenance | A fact links to one or more whole passage chunks | No source version, exact span offsets, author, ACL, validity interval, or decision authority |

Additional production gaps:

- exact triple equality is used for fact deduplication;
- a fact has only one `schema_idx`;
- predicates flatten negation, modality, temporal scope, and qualifiers into strings;
- low-frequency evidence is treated as noise even though a single executive decision or customer escalation can be decisive;
- the memory path is batch-oriented rather than event-driven;
- there is no tenant authorization model or permission-aware retrieval;
- generated answers receive passages, but there is no machine-enforced assertion-to-citation contract;
- there is no human review or organizational authority model.

These gaps do not invalidate the research. They define the boundary between a benchmark GraphRAG system and Distillery's company-intelligence requirements.

## 4. What Distillery should borrow

### 4.1 Keep evidence, assertions, and schema separate

Do not store an extracted sentence as a current fact. Store:

- the immutable evidence span;
- the observation that a source asserted something;
- the normalized claim the observation may support;
- the semantic type/schema used to interpret it.

This separation makes extraction errors correctable without altering source history.

### 4.2 Treat extraction as probationary

New observations enter as unreviewed proposals. They can be used for search and related-signal suggestions, but their status must remain visible. A system-generated extraction must never silently acquire human authority.

### 4.3 Use bidirectional grounding

Every claim can enumerate supporting, contradicting, and qualifying evidence. Every evidence span can enumerate observations and claims derived from it. This is essential for both verification and impact analysis when a source changes.

### 4.4 Separate memory from retrieval projections

The paper's graph is derived from memory. Distillery should preserve this pattern:

- PostgreSQL ledger is authoritative;
- blob storage preserves original source versions;
- lexical, vector, and graph indexes are disposable projections;
- rebuilding an index cannot change claims, decisions, approvals, or artifact history.

### 4.5 Detect conflicts before synthesis

Contradiction detection should run when claims are added or changed. Initiative synthesis must receive conflict groups and contrary evidence, not only a cleaned “winner.”

### 4.6 Retrieve across abstraction levels

Recall should search both exact evidence and normalized claims. Initiative synthesis should additionally search entities, claim types, dependencies, decisions, and existing initiatives. Graph expansion can later improve multi-hop discovery if benchmarked against simpler hybrid retrieval.

## 5. What Distillery must change

### 5.1 Never destructively resolve truth

If two claims conflict, keep both. Resolution creates a new record:

```text
claim A ----\
             -> conflict group -> resolution decision -> current interpretation
claim B ----/
```

The original evidence, observations, and claims remain queryable. A resolution may mark a claim rejected, superseded, time-bounded, or compatible at another granularity, but it cannot erase it.

### 5.2 Frequency is not authority

Repeated statements may share one origin, and one authoritative decision may appear only once. Promotion should consider separate facets:

- source authority;
- human confirmation;
- independent supporting origins;
- recency and validity interval;
- contradiction state;
- extraction quality;
- applicability to the current initiative;
- decision status.

Never collapse these into one unexplained confidence score.

### 5.3 Time is first-class

Every source, observation, claim, and decision needs both:

- **valid time:** when the assertion is claimed to be true;
- **recorded time:** when Distillery learned or recorded it.

This permits “what did we believe on March 1?” and prevents a former strategy or owner from being presented as current.

### 5.4 Decisions are not facts

“The team approved an enterprise launch” is an observation about a reported decision until an authorized decision record exists. Effective decisions need owner, approver, rationale, scope, validity, and supersession semantics.

### 5.5 Exact evidence spans are mandatory

Passage chunks are too coarse for Distillery. Evidence locators must identify exact text or time ranges and retain source-native navigation:

- document block/paragraph and offsets;
- Slack message/thread ID;
- recording timestamps;
- ticket comment ID;
- metric query, series, and time window;
- source version and content hash.

## 6. Proposed Distillery memory model

### Layer 0 — immutable evidence

```text
source_item
  id, tenant_id, source_type, external_id, canonical_url,
  author_id, occurred_at, ingested_at, acl_policy_id

source_version
  id, source_item_id, version, content_hash, object_uri,
  recorded_at, deletion_state

evidence_span
  id, source_version_id, locator_json, exact_text,
  start_offset, end_offset, start_time, end_time, content_hash
```

This is the equivalent of MemGraphRAG's passage layer, strengthened with immutable versions, exact locators, identity, time, and authorization.

### Layer 1 — observations

```text
observation
  id, evidence_span_id, extraction_run_id,
  observation_type, raw_statement,
  subject_mention, predicate_mention, object_value,
  modality, negated, qualifiers_json,
  extraction_confidence, review_state, created_at
```

An observation means “this source appears to say X.” It is never overwritten. Human corrections create a reviewed interpretation while preserving the original extraction.

### Layer 2 — claims and semantic relationships

```text
claim
  id, tenant_id, claim_type_id,
  subject_entity_id, predicate_id, object_json,
  valid_from, valid_to, recorded_at,
  epistemic_type, truth_state, review_state,
  version, supersedes_claim_id

claim_evidence
  claim_id, observation_id,
  stance, independence_group_id, relevance
  // stance: supports | contradicts | qualifies | motivates

claim_relation
  from_claim_id, relation, to_claim_id
  // duplicate_of | contradicts | supersedes | depends_on | refines

conflict_group
  id, conflict_type, severity, status,
  detected_by, detected_at, resolution_decision_id
```

Separate state dimensions:

- `epistemic_type`: source_assertion, inference, assumption, recommendation;
- `truth_state`: active, disputed, superseded, unknown;
- `review_state`: unreviewed, human_confirmed, human_rejected.

This avoids forcing evidence quality, currentness, and human approval into one status.

### Layer 3 — schema and taxonomy

```text
claim_type
  id, name, description, value_schema,
  temporal_policy, conflict_policy, owner_role, version

predicate
  id, name, inverse_id, cardinality,
  temporal_behavior, allowed_subject_types, allowed_object_types

entity
  id, canonical_name, entity_type_id, status

entity_alias
  entity_id, alias, source_scope, confidence
```

The schema layer should begin as a small managed product ontology, then evolve from observed usage. Learned schema suggestions may be proposed, but schema promotion requires review. Frequency can inform review; it cannot determine semantic validity.

Recommended claim types:

- customer/user signal;
- problem or pain point;
- request;
- metric observation;
- risk;
- dependency;
- constraint;
- reported decision;
- strategic statement;
- scope or non-goal;
- ownership statement.

### Layer 4 — decisions and authority

```text
decision
  id, tenant_id, initiative_id, decision_type,
  statement, rationale, scope_json,
  status, owner_id, decided_by, decided_at,
  valid_from, valid_to, supersedes_decision_id

decision_support
  decision_id, claim_id, relationship
  // informed_by | accepts | rejects | qualifies
```

This layer has no MemGraphRAG equivalent. It is required because company truth includes choices, not only extracted descriptions.

### Layer 5 — synthesis memory

```text
initiative_candidate
  id, title, problem_hypothesis, status,
  owner_id, created_by, created_at

candidate_membership
  initiative_id, claim_id, role,
  inclusion_reason_json, disposition, reviewed_by

evidence_bundle
  id, initiative_id, version, as_of,
  manifest_hash, retrieval_policy_version

brief_assertion
  id, brief_id, json_pointer, text,
  assertion_type, epistemic_status, owner_id

assertion_support
  assertion_id, support_type, support_id, relationship
```

Initiatives and briefs are versioned syntheses over memory. They do not become new source evidence merely because an LLM generated them. Approved artifacts may support later work only through an explicit `prior_artifact` relationship.

## 7. Boundary between generation and synthesis

### Memory Generation owns

- capture and source versioning;
- transcription, parsing, and exact spans;
- observation extraction;
- entity resolution proposals;
- claim clustering and versioning;
- duplicate and conflict candidates;
- correction workflows;
- hybrid recall and evidence-backed answers;
- derived index updates.

Its output contract is a set of versioned claims with support, conflicts, currentness, authority facets, and exact evidence.

### Memory Synthesis owns

- related-signal grouping;
- initiative candidate suggestions;
- explanation of why memories were grouped;
- human create/attach/merge/ignore actions;
- initiative field coverage and readiness;
- decision and owner collection;
- frozen evidence bundles;
- initiative brief generation, validation, review, and approval.

Memory Synthesis cannot edit source evidence or silently promote claims. Corrections are sent back through Memory Generation, producing new versions and a refreshed synthesis.

### Contract

```text
Memory Generation
  publishes: claim.changed, conflict.changed, decision.reported
  serves: retrieve evidence bundle as-of time T

Memory Synthesis
  consumes: claims and conflict groups
  writes: candidate membership, decisions, bundles, brief assertions, approvals
  requests: claim correction or additional evidence
```

## 8. Memory Generation write path

```text
1. Create source item/version and return capture receipt.
2. Normalize content and create exact evidence spans.
3. Run extraction; persist the complete extraction run and observations.
4. Resolve entity mentions to existing entities or create proposals.
5. Match observations to claims using deterministic keys plus semantic candidates.
6. Add support/contradiction/qualification edges; never replace observations.
7. Evaluate temporal, cardinality, granularity, and semantic conflict rules.
8. Persist conflict groups without selecting a winner.
9. Publish an outbox event and update disposable search/graph projections.
10. Show the user what was understood and what remains uncertain.
```

Every step is idempotent on source version and processor version.

## 9. Recall path

Start simpler than the paper's PPR pipeline:

```text
question
  -> tenant/ACL/time filters
  -> lexical + vector retrieval over claims and evidence spans
  -> deterministic entity and claim-type expansion
  -> bounded one-hop relation expansion
  -> group versions, support, decisions, and conflicts
  -> rerank
  -> freeze answer evidence bundle
  -> generate atomic cited assertions
  -> validate support IDs and authorization
```

Reranking should expose components rather than one opaque score:

```text
semantic relevance
+ exact lexical/entity match
+ effective human decision or confirmation
+ currentness
+ independent support
- unresolved contradiction risk
- stale evidence
- low extraction quality
```

Add Personalized PageRank only after an evaluation set shows that multi-hop graph propagation improves recall without increasing unsupported synthesis. PostgreSQL plus `pgvector` and an edge table is sufficient for the current system.

## 10. Memory Synthesis path

```text
claim changes
  -> candidate grouping features
  -> related-signal suggestion with rationale
  -> human create/attach/merge/ignore
  -> initiative claim roles
  -> field coverage, conflicts, owners, and decisions
  -> readiness checks
  -> frozen evidence bundle
  -> structured brief assertions
  -> deterministic trace/freshness/authorization gates
  -> review and approval of exact version
```

Candidate grouping can use:

- shared entities, users, products, systems, and customers;
- compatible problem and outcome claim types;
- semantic similarity;
- temporal proximity;
- explicit references;
- shared dependencies or metrics;
- source independence.

The UI must show those features as the suggestion rationale. A model similarity score alone is not an explanation.

## 11. Conflict policy for Distillery

Borrow the paper's three categories and add company-specific categories:

| Conflict type | Distillery behavior |
|---|---|
| Mutually exclusive | Keep both claims; require resolution if the conflict affects a brief field |
| Temporal | Add or request validity intervals; do not treat non-overlapping claims as contradictory |
| Granularity | Link with `refines` or `contains`; preserve both levels |
| Decision conflict | Effective authorized decision wins operationally; prior/reported decisions remain visible |
| Scope conflict | Block brief approval until explicitly decided or acknowledged |
| Metric-definition conflict | Keep measurements separate by definition/version; block comparisons until normalized |
| Ownership conflict | Require confirmation from an authorized owner |
| Dependency conflict | Show both states and request confirmation from the dependency owner |

Automated conflict detection is diagnostic. Automated resolution may suggest actions, but only deterministic temporal logic or authorized human decisions can change operational state.

## 12. Derived retrieval graph

The current graph is a projection, not a separate graph database.

Recommended nodes:

- entity;
- claim;
- claim type;
- evidence span/source;
- decision;
- initiative.

Recommended typed edges:

- claim `supported_by` evidence;
- claim `contradicted_by` evidence;
- claim `about` entity;
- claim `instance_of` claim type;
- claim `depends_on` claim;
- claim `supersedes` claim;
- decision `accepts/rejects/qualifies` claim;
- initiative `includes` claim;
- initiative `depends_on` entity/initiative.

Avoid similarity edges in the authoritative graph. Calculate them in the retrieval index with model/version metadata and thresholds. Similarity is a retrieval hypothesis, not an organizational relationship.

## 13. Implementation order

1. Implement immutable source versions and exact evidence spans.
2. Implement observations and extraction-run lineage.
3. Implement typed claims and many-to-many evidence links.
4. Implement temporal fields and separate epistemic/truth/review states.
5. Implement append-only corrections, supersession, and audit events.
6. Implement hybrid claim/span retrieval with ACL filtering and citation validation.
7. Implement deterministic conflict candidates and visible conflict groups.
8. Implement a small managed claim-type and predicate registry.
9. Implement related-signal suggestions using explicit grouping features.
10. Implement decisions, evidence bundles, brief assertions, and approval hashes.

Do not build a dedicated graph database or PPR retrieval before steps 1–10 work and are evaluated.

## 14. Evaluation required before graph retrieval

Build a Distillery-specific golden set containing:

- repeated claims sharing one origin;
- rare but authoritative decisions;
- superseded strategy and ownership;
- temporal claims that are compatible rather than contradictory;
- true mutually exclusive claims;
- different granularity levels;
- extraction errors;
- inaccessible evidence;
- cross-document initiative signals;
- unrelated items sharing generic entities.

Measure:

- evidence-span locator validity;
- claim extraction precision/recall by type;
- entity-resolution precision;
- contradiction recall and false-positive rate by category;
- retrieval recall at K for both direct and multi-hop questions;
- citation precision;
- correct abstention;
- initiative grouping precision;
- reviewer time to verify a brief;
- unsupported-assertion escape rate.

Compare three retrieval variants:

1. lexical + vector evidence retrieval;
2. claim-aware hybrid retrieval with one-hop typed expansion;
3. graph propagation/PPR.

Adopt graph propagation only if variant 3 produces a material improvement on Distillery tasks and preserves citation precision and latency.

## 15. Decision

Use MemGraphRAG as a conceptual influence, not a dependency.

Adopt:

- hierarchical evidence/fact/schema separation;
- probationary extraction;
- bidirectional evidence grounding;
- global contradiction detection;
- graph as a derived retrieval projection;
- fallback to direct evidence retrieval.

Reject or redesign:

- JSON/list-index memory as canonical storage;
- frequency-only schema promotion;
- destructive LLM conflict resolution;
- one schema per fact;
- whole-passage provenance;
- static batch rebuilding;
- unversioned graph truth;
- graph retrieval without authorization and citation gates.

The result is not “MemGraphRAG for company documents.” It is an evidence ledger with semantic and graph projections, designed so Memory Generation can remain trustworthy while Memory Synthesis becomes progressively more capable.
