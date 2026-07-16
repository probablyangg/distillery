# Memory Generation labeled fixtures

These fixtures are for reviewing and testing Memory Generation for Stable. They exercise the shared extracted-memory contract; Slack context has separate connector and loop tests.

They are synthetic text-only braindumps, not training data and not real internal Stable records. They are a small golden set used to check whether a prompt/model change still extracts only evidence-backed memory items.

## Format

- `inputLines` is the raw pasted text braindump, split into numbered lines.
- `expectedSpans` are source locators. Line ranges are inclusive.
- `expectedMemoryItems` are the memory records that should be proposed for commit.
- Each memory item uses `claimType`, not `type`.
- Each memory item includes MemGraphRAG-aligned interpretation metadata:
  - `entities`;
  - `relations`;
  - `schemas`.
- `negativeExpectations` are things the model must not infer or promote.

The review question for each fixture is:

> Would Stable leadership be comfortable with these memory items entering Memory Synthesis?

Run validation:

```bash
pnpm fixtures:validate
```

The validator checks fixture shape, claim types, evidence support, relation support, and duplicate IDs. It does not score extraction quality; human review still decides whether the expected memory is correct.

See the [evaluation guide](../../README.md) for the optional extraction and connection measurements and the deterministic retrieval fixture gate.
