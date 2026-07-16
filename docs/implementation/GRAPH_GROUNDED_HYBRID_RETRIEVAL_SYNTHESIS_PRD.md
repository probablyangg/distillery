# Graph-grounded hybrid retrieval and synthesis PRD

Status: implemented 2026-07-09; retained as the design and acceptance-test record.

Reading rule: the “Current repo baseline” below is the pre-implementation state from when this PRD was written. It is intentionally historical. The shared retriever, migration `0011`, backfill script, reranker, and retrieval fixtures now exist. Use [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md) and the code for current behavior.

This PRD upgrades Distillery retrieval and synthesis using MemGraphRAG as inspiration, not as a rigid implementation target. The goal is better evidence-backed Ask answers and broader, more useful synthesis context through hybrid semantic, sparse, exact, and graph signals.

Related docs:

- Docs index: [README.md](../README.md)
- Current state: [STATUS_AND_ROADMAP.md](../current/STATUS_AND_ROADMAP.md)
- Current code map: [CODEBASE_GUIDE.md](../reference/CODEBASE_GUIDE.md)
- Claim graph plan: [CLAIM_GRAPH_MEMORY_UPGRADE_PLAN.md](./CLAIM_GRAPH_MEMORY_UPGRADE_PLAN.md)
- Memory architecture and MemGraphRAG notes: [MEMORY_ARCHITECTURE.md](../architecture/MEMORY_ARCHITECTURE.md)
- MemGraphRAG paper: [2606.00610v1.pdf](../research/2606.00610v1.pdf)

## Objective

Replace the current Ask and synthesis retrieval paths with a shared graph-grounded hybrid retriever.

The retriever must use:

- dense vector candidates from memory embeddings;
- sparse and exact candidates as seed signals only;
- claim, evidence, entity, and schema graph nodes;
- bounded Personalized PageRank over `graph_edges`;
- OpenRouter-backed reranking through `packages/model-gateway`;
- evidence hydration and citation validation before answer or brief generation.

This is a retrieval and synthesis quality upgrade. Do not optimize for paper fidelity when product retrieval quality, exact recall, traceability, or synthesis breadth requires a practical deviation.

## Historical pre-implementation baseline

The implementation started from the repository state described below, not a greenfield system. The bullets in this section are not current facts.

Current implemented behavior:

- `apps/web/src/index.ts` handles Ask at `POST /api/queries`.
- Ask currently calls `distillery_graph_recall_context` and falls back to `distillery_recall_memory_lexical`.
- `distillery_graph_recall_context` currently performs lexical seed selection plus one-hop `claim_connections` expansion.
- `distillery_recall_memory_lexical` is a DB lexical answer fallback, not a graph retriever.
- `memory_embeddings`, `graph_nodes`, and `graph_edges` exist in migration `0010_claim_graph_memory_upgrade.sql`.
- `extract_memory` already stores embeddings for claims, evidence spans, entities, and schema patterns when embedding env vars are configured.
- Historical embedding backfill, hybrid vector/sparse retrieval, TypeScript PPR, OpenRouter retrieval reranking, and retrieval evals are not implemented.
- `synthesize_brief` currently uses `getMemorySynthesisContext`, which is not the shared hybrid retriever.

Current config mismatch to fix:

- `.env.example` still names `qwen/qwen3-embedding-8b`.
- `apps/web/wrangler.toml`, runbook, and status docs standardize on `google/gemini-embedding-001` with `EMBEDDING_DIMENSIONS=1536`.
- This implementation must update `.env.example` to match `google/gemini-embedding-001`.

## Non-negotiable rules

- PostgreSQL remains canonical.
- Embeddings and graph projections remain derived.
- Do not add a graph database.
- Do not add a hosted MemGraphRAG service.
- Do not add LangGraph, CrewAI, AutoGen, or another agent orchestration framework.
- Do not call model providers directly outside `packages/model-gateway`.
- Do not use `distillery_recall_memory_lexical` from Ask or synthesis retrieval.
- Sparse/exact retrieval is allowed only as a seed signal into the hybrid retriever; it must not generate answers.
- Returned Ask answers and initiative brief drafts must cite hydrated evidence spans only.

## External dependencies

No new signup, external service, graph database, hosted MemGraphRAG service, or direct OpenAI dependency is introduced.

Required existing services:

```text
Supabase/PostgreSQL with pgvector
Cloudflare Workers and Queue
OpenRouter
```

Required environment for full retrieval success:

```text
OPENROUTER_API_KEY
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL
OPENROUTER_FALLBACK_MODELS
OPENROUTER_TIMEOUT_MS
OPENROUTER_FALLBACK_TIMEOUT_MS
EMBEDDING_PROVIDER=openrouter
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=google/gemini-embedding-001
EMBEDDING_DIMENSIONS=1536
EMBEDDING_ENCODING_FORMAT=float
```

The OpenRouter reranker must use the existing `OPENROUTER_MODEL` and fallback settings. Do not introduce a separate reranker API key or provider in this PRD.

If query embedding fails, retrieval may degrade to sparse/exact seeds plus graph ranking with explicit metadata. If reranking fails, deterministic hybrid scoring may be used with explicit metadata. The old DB lexical answer fallback is not allowed.

## Target package

Add a workspace package:

```text
packages/memory-retrieval
```

Export the shared retrieval entry point:

```ts
export type RetrievalProfile = "ask" | "synthesis";

export type RetrieveMemoryContextInput = {
  tenantId: string;
  profile: RetrievalProfile;
  queryText: string;
  seedMemoryItemIds?: string[];
  embeddingModel?: EmbeddingModel;
  rerankerModel?: RetrievalRerankerModel;
  persistence: MemoryRetrievalPersistence;
};

export function retrieveMemoryContext(input: RetrieveMemoryContextInput): Promise<GraphRecallContext>;
```

`packages/memory-retrieval` owns:

- candidate score normalization;
- profile defaults;
- graph node reset-weight construction;
- bounded PPR;
- deterministic rerank fallback;
- retrieval metadata;
- conversion to `GraphRecallContext`.

## Retrieval profiles

Use separate defaults. Ask optimizes precision. Synthesis optimizes broader recall and diversity.

Ask profile:

```text
vector_top_k_per_layer=64
sparse_top_k_per_layer=32
max_graph_nodes=1000
max_graph_edges=4000
ppr_iterations=30
ppr_restart=0.5
ppr_tolerance=0.000001
rerank_candidate_claims=10
final_claims=10
```

Synthesis profile:

```text
vector_top_k_per_layer=96
sparse_top_k_per_layer=64
max_graph_nodes=2500
max_graph_edges=10000
ppr_iterations=40
ppr_restart=0.5
ppr_tolerance=0.000001
rerank_candidate_claims=60
final_claims=32
```

These are v1 guardrails, not final retrieval quality ceilings. Every cap hit must be reported in retrieval metadata. Ask reranks only the final 10 returned claims to keep the OpenRouter reranker inside the Worker timeout budget; this trades off possible LLM rescue of claims ranked 11-30 by deterministic graph scoring for materially better live reliability. The Ask reranker primary timeout is capped at 18 seconds, with one short fallback attempt. Synthesis keeps a wider reranking window because it is less latency-sensitive and benefits more from breadth.

## Retrieval flow

For each request:

1. Validate `tenantId`, `profile`, `queryText`, and optional `seedMemoryItemIds`.
2. If an embedding model is configured, embed `queryText` once.
3. Retrieve dense vector candidates from `memory_embeddings` for target types:
   - `claim`;
   - `evidence_span`;
   - `entity`;
   - `schema_pattern`.
4. Retrieve sparse/exact candidates through a dedicated retrieval RPC using:
   - full-text match on claim statements and evidence span text;
   - exact/substring matching for entity names, canonical names, schema predicates, and source/evidence identifiers.
5. Hard-seed `seedMemoryItemIds` for synthesis with maximum initial confidence.
6. Normalize scores by source so one source cannot dominate only because it returns larger raw scores.
7. Map candidates to `graph_nodes`.
8. Load a tenant-scoped bounded graph snapshot around candidate nodes through `graph_edges`.
9. Build reset weights:
   - vector similarity boosts semantically aligned nodes;
   - sparse/exact boosts identifier and literal matches;
   - seed memory IDs receive hard-seed boost;
   - reviewer pinned claims receive a boost;
   - reviewer synthesis exclusions are removed for synthesis;
   - schema and high-degree entity nodes receive degree suppression;
   - stale or conflicted claims are not silently removed, but must carry metadata and warnings.
10. Run weighted bidirectional Personalized PageRank over the loaded graph.
11. Convert top graph-ranked nodes to claim candidates.
12. Rerank top claim candidates through `RetrievalRerankerModel` when available.
13. Fall back to deterministic hybrid reranking when reranker is unavailable or invalid.
14. Hydrate final ordered claims and evidence spans.
15. Include open conflicts relevant to final claims.
16. Return `GraphRecallContext`.

## Ranking semantics

`GraphRetrievalClaim` output must populate:

- `graphScore` from PPR;
- `vectorScore` from best normalized vector candidate support;
- `lexicalScore` as sparse/exact seed support for backward-compatible field naming;
- `connectionIds` from durable claim connections.

Metadata must include:

- `strategy: "hybrid-graph-ppr-rerank"`;
- `profile`;
- seed counts by source and target type;
- embedding model used or embedding failure reason;
- graph node and edge counts loaded;
- PPR iterations and convergence;
- cap hits;
- reranker model used or reranker fallback reason;
- final deterministic/reranked score components per claim when practical.

## Database changes

Add a new migration after `0010_claim_graph_memory_upgrade.sql`.

Add RPCs:

```text
distillery_retrieval_vector_candidates
distillery_retrieval_sparse_candidates
distillery_retrieval_graph_snapshot
distillery_hydrate_retrieval_claims
```

RPC requirements:

- every RPC accepts `p_tenant_id`;
- every RPC enforces tenant scope;
- every RPC enforces limit caps server-side;
- vector RPC accepts query embedding JSON and target types, uses pgvector cosine similarity, and returns normalized similarity-like scores;
- sparse RPC returns seed candidates only, not answer text;
- graph snapshot RPC returns `GraphNode` and `GraphEdge` shaped rows;
- hydration RPC returns ordered `GraphRetrievalClaim` rows with evidence spans and connection IDs.

Do not remove existing DB functions in this PR unless all call sites and tests are migrated. Existing lexical DB functions may remain for legacy/manual compatibility, but Ask and synthesis must not use them.

## Model gateway changes

Add retrieval reranking behind `packages/model-gateway`.

Required interface:

```ts
export type RetrievalRerankCandidate = {
  claimId: string;
  statement: string;
  evidenceSpanTexts: string[];
  graphScore: number;
  vectorScore: number;
  sparseScore: number;
  conflictWarningCount: number;
};

export type RetrievalRerankRequest = {
  question: string;
  profile: "ask" | "synthesis";
  candidates: RetrievalRerankCandidate[];
};

export type RetrievalRerankResponse = {
  rankedClaimIds: string[];
  rationaleByClaimId: Record<string, string>;
  model: string;
};

export interface RetrievalRerankerModel {
  rerankRetrieval(request: RetrievalRerankRequest): Promise<RetrievalRerankResponse>;
}
```

The OpenRouter implementation must:

- use existing `OPENROUTER_MODEL`, fallbacks, base URL, API key, and timeout settings;
- return valid JSON only;
- reject unknown claim IDs;
- reject duplicate claim IDs;
- tolerate partial rankings by appending missing candidates in deterministic order.

## Ask behavior

`POST /api/queries` must:

- call `retrieveMemoryContext` with `profile: "ask"`;
- generate grounded answers from the returned `GraphRecallContext`;
- never call `distillery_recall_memory_lexical`;
- never use `SupabaseMemoryGenerationRepository.recallMemory`;
- return a no-evidence or retrieval-unavailable grounded response only when hybrid retrieval cannot produce evidence-backed context.

If embeddings fail but sparse/exact plus graph retrieval succeeds, Ask may answer with `retrievalMetadata.degraded = true`.

If all retrieval paths fail, Ask returns an explicit gap with retrieval metadata. It must not invent an answer.

## Synthesis behavior

Background `synthesize_brief` and manual draft expansion must:

- call `retrieveMemoryContext` with `profile: "synthesis"`;
- pass `seedMemoryItemIds` from the causing event or manual input;
- use final retrieved claims as selected memory;
- preserve readiness gates for weak/isolated memory;
- include conflicts, stale evidence warnings, dependencies, risks, and diverse clusters when present;
- exclude reviewer-marked `exclude_from_synthesis` claims.

Synthesis should prefer breadth and diversity over only top semantic similarity.

## Backfill script

Add:

```text
scripts/backfill-memory-embeddings.ts
```

The script must:

- find active claims, evidence spans, entities, and schema patterns missing embeddings for `google/gemini-embedding-001`;
- batch calls through `OpenRouterEmbeddingModel`;
- write through existing `distillery_upsert_memory_embeddings`;
- be idempotent;
- support a dry-run mode;
- print counts by target type and model.

## Evaluation requirements

Add:

```text
evals/fixtures/retrieval/hybrid-retrieval.v1.json
evals/runners/validate-retrieval-fixtures.ts
```

Fixture classes:

- exact internal identifier/name recall;
- semantic paraphrase recall;
- multi-hop graph recall;
- conflict-aware retrieval;
- irrelevant-neighborhood resistance;
- synthesis breadth and diversity;
- stale or low-authority evidence suppression;
- citation validity.

The eval runner must be deterministic and use mocked embeddings/reranker where needed. It must run without external network calls.

## Definition of success

Implementation is successful when:

- Ask defaults to the shared hybrid graph retriever.
- Ask never calls `distillery_recall_memory_lexical`.
- Synthesis uses the same retriever with the synthesis profile.
- Sparse/exact retrieval is used only as a seed signal.
- Semantic, exact identifier, multi-hop, conflict-aware, and synthesis breadth fixtures pass.
- Exact identifier recall is not worse than the old lexical path on fixtures.
- Semantic and multi-hop recall improve over the current lexical-plus-one-hop graph path on fixtures.
- Returned Ask answers cite only hydrated evidence spans from retrieved claims.
- Brief synthesis includes broader risks, dependencies, conflicts, stale evidence warnings, and diverse clusters when present in fixtures.
- `graphScore`, `vectorScore`, and sparse/lexical score metadata are populated.
- Cap hits, degraded modes, reranker use/failure, and selected seed sources are visible in metadata.
- Historical seeded memory can be embedded through the backfill script.
- `.env.example` uses `EMBEDDING_MODEL=google/gemini-embedding-001`.
- `pnpm typecheck`, `pnpm test`, `pnpm fixtures:validate`, and the retrieval eval runner pass.

## Tests

Add or update tests for:

- vector candidate RPC target filtering and tenant isolation;
- sparse candidate RPC seed-only behavior;
- graph snapshot RPC caps and tenant isolation;
- hydration RPC preserves requested order;
- PPR ranking on a small weighted graph;
- reranker validates IDs and falls back deterministically;
- Ask has no call path to `distillery_recall_memory_lexical`;
- Ask returns degraded metadata when embeddings fail but sparse/graph retrieval works;
- synthesis profile uses broader caps than Ask;
- reviewer synthesis exclusions are honored;
- backfill script dry-run and idempotency;
- `.env.example` embedding model consistency.
