# Evaluation fixtures and runners

The evaluation directory contains deterministic build gates and optional quality measurements.

## Build gates

- `pnpm fixtures:validate` validates the labeled memory-generation fixture schema, evidence bindings, relation support, and duplicate identifiers.
- `pnpm retrieval:validate` runs deterministic hybrid-retrieval cases with local fake embeddings/reranking.
- `pnpm build` runs both after typechecking and unit tests.

## Optional measurements

- `evaluate-memory-connections.ts` is local and deterministic. It reports connection density and score distributions.
- `evaluate-memory-extraction.ts` calls OpenRouter and compares generated items with the labeled golden set. It reports measurements; it is not a pass/fail build gate.
- `live-v0-smoke.ts` is a legacy direct database/model smoke. Run it only against an isolated disposable database.

Fixtures are synthetic evaluation data, not training data or real internal company records. See [fixtures/memory-generation/README.md](./fixtures/memory-generation/README.md) for the memory fixture format.
