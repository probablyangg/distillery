# Distillery packages

These packages keep evidence, model calls, domain logic, persistence, and runtime orchestration separate. The [codebase guide](../docs/reference/CODEBASE_GUIDE.md) explains how they work together.

| Package | Responsibility | Main tests |
|---|---|---|
| `contracts` | Zod schemas, enums, and inferred TypeScript types shared across every layer | contract and loop-status schema tests |
| `evidence` | text normalization, SHA-256 hashing, bounded exact evidence spans | offsets, Unicode, long-line segmentation |
| `validation` | deterministic validation of events, memory, evidence bindings, decisions, and artifact traceability | supported/unsupported evidence and relation grounding |
| `prompts` | model system prompts and bounded renderers; no provider calls | guardrails, enum coverage, input compaction |
| `model-gateway` | OpenRouter chat completions, embeddings, JSON repair, runtime response validation, fallback attempts | mocked provider calls, schema and citation checks |
| `memory-generation` | direct text capture, correction actions, legacy direct workflow helpers, deterministic cited-answer helper, section planning utilities | workflow, correction, recall, sectioning |
| `memory-retrieval` | hybrid vector/sparse seeds, bounded graph hydration, Personalized PageRank, optional reranking | ranking, degraded modes, profile limits |
| `memory-synthesis` | bundle construction, cluster projection, opportunity scoring, readiness, dossiers, brief traceability | corpus discovery, readiness, bounded dossiers |
| `slack-connector` | signature security, Slack API access, bounded context assembly, PDF/DOCX parsing, persistence handoff, reactions | security, API safety, context, attachments, reaction lifecycle |
| `loop` | deterministic event routing, leases, policy runner, validation/approval flow, real policies, placeholders | end-to-end in-memory loop behavior |
| `db` | Supabase REST/RPC adapters for repositories and loop persistence | RPC bindings and SQL migration assertions |

## Dependency rules

- Do not import a model provider from domain code. Add provider behavior to `model-gateway`.
- Do not implement multi-table canonical writes in the Worker. Add a forward SQL migration and call its RPC through `db`.
- Keep exported domain shapes in `contracts`.
- Keep evidence checks deterministic. Model confidence never replaces evidence validation.
- Treat graph rows, embeddings, and clusters as rebuildable projections.
