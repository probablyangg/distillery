# v0 Memory Generation implementation with LangChain/LangGraph

Status: proposed

## 1. Recommendation

Implement Memory Generation as a durable LangGraph workflow containing one bounded LangChain model step. Do not implement it as an open-ended ReAct agent with general-purpose tools.

The workflow is known in advance:

```text
ingest
  -> storeEvidence
  -> generateMemory
  -> validateMemory
  -> storeMemory
  -> publishMemoryReady
```

The frontend starts the workflow and observes its status. It does not call the model directly.

## 2. Terminology

### Ingest

Convert the user's text braindump into a canonical input envelope:

```text
CaptureEnvelope
  ingestionId
  tenantId
  appSessionId
  submittedByLabel
  inputType: text
  content
  occurredAt
  idempotencyKey
```

Ingestion includes normalizing pasted text and identifying source boundaries. It does not extract company memory yet. Voice, URL import, and file upload are deferred beyond v0.

### Store evidence

Persist exactly what Distillery received before asking an LLM to interpret it.

```text
source_item
  -> source_version
  -> evidence_span[]
```

Properties:

- immutable source version;
- content hash;
- exact span locators;
- actor, tenant, source time, and ingestion time;
- private-pilot access policy;
- idempotent write;
- independent of model success.

If generation fails, the evidence remains available for retry. This step is deterministic application code, not an agent tool choice.

### Generate memory

Read the stored evidence and convert it into typed memory candidates:

```text
stored evidence spans
  -> facts/signals/metrics/risks/dependencies/etc.
  -> normalized statements
  -> evidence-span references
  -> epistemic labels
```

This is the LLM reasoning step. It does not create initiatives, choose company truth, or write directly to the database.

Because the downstream product is named **Memory Synthesis**, call this internal node `generateMemory` or `materializeMemory`, not `synthesize`, in code and telemetry.

### Validate memory

Deterministically reject or flag:

- evidence IDs not present in the stored source version;
- unsupported memory types;
- statements with no evidence;
- malformed values;
- evidence outside the configured access scope;
- duplicate model IDs;
- claims that exceed configured source-span limits.

An optional second model can estimate whether a span supports a statement, but that score is a warning signal rather than proof.

### Store memory

Commit the validated interpretation:

```text
extraction_run
  -> observation[]
  -> claim candidates
  -> claim_evidence[]
  -> audit_event
```

This is a second deterministic transaction. It stores model output as an interpretation linked to immutable evidence. It does not alter the evidence or silently promote a claim to human-confirmed truth.

### Publish

Emit `memory.ready` through a transactional outbox. The UI receives the exact committed memory items. Memory Synthesis consumes the same event later.

## 3. The two meanings of “store”

There should be two explicit commits:

| Commit | Timing | Purpose |
|---|---|---|
| Evidence commit | Before model execution | Preserve the exact input and make retries safe |
| Memory commit | After generation and validation | Persist the structured interpretation with provenance |

Do not combine them into one transaction spanning an LLM request. Model calls are slow and unreliable; database transactions should be short.

## 4. LangGraph state

Illustrative TypeScript:

```ts
import { StateGraph, StateSchema, START, END } from "@langchain/langgraph";
import { z } from "zod/v4";

const MemoryItem = z.object({
  temporaryId: z.string(),
  type: z.enum([
    "fact",
    "user_signal",
    "reported_decision",
    "metric",
    "risk",
    "dependency",
    "constraint",
    "strategic_statement",
    "ownership_statement",
    "scope_statement",
  ]),
  statement: z.string().min(1),
  evidenceSpanIds: z.array(z.string()).min(1),
  epistemicType: z.enum(["source_assertion", "inference"]),
  qualifiers: z.record(z.string(), z.unknown()).default({}),
});

const GeneratedMemory = z.object({
  items: z.array(MemoryItem),
});

const IngestionState = new StateSchema({
  ingestionId: z.string(),
  tenantId: z.string(),
  actorId: z.string(),
  inputType: z.literal("text"),
  inputReference: z.string(),
  sourceVersionId: z.string().optional(),
  evidenceSpanIds: z.array(z.string()).default([]),
  generatedMemory: GeneratedMemory.optional(),
  committedMemoryIds: z.array(z.string()).default([]),
  status: z.enum([
    "received",
    "evidence_stored",
    "generating",
    "validating",
    "memory_stored",
    "ready",
    "failed",
  ]),
  errors: z.array(z.string()).default([]),
});
```

Keep large source text out of graph state. State should hold durable database/object references.

## 5. Structured generation

Use a LangChain model with structured output rather than a tool-calling loop:

For v0, configure this model through OpenRouter:

```text
OPENROUTER_MODEL=moonshotai/kimi-k2.7-code
OPENROUTER_FALLBACK_MODELS=~moonshotai/kimi-latest,moonshotai/kimi-k2.6
OPENROUTER_TIMEOUT_MS=30000
OPENROUTER_FALLBACK_TIMEOUT_MS=45000
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

OpenRouter lists `moonshotai/kimi-k2.7-code` as MoonshotAI: Kimi K2.7 Code, released June 12, 2026, with a 262K-token context window and structured output support. v0 uses it as the primary extraction model.

```ts
const memoryModel = model.withStructuredOutput(GeneratedMemory, {
  includeRaw: true,
});

async function generateMemory(state: typeof IngestionState.Type) {
  const spans = await evidenceRepository.getAllowedSpans({
    tenantId: state.tenantId,
    sourceVersionId: state.sourceVersionId!,
  });

  const allowedIds = spans.map((span) => span.id);

  const result = await memoryModel.invoke([
    {
      role: "system",
      content: MEMORY_GENERATION_PROMPT,
    },
    {
      role: "user",
      content: renderNumberedEvidence(spans),
    },
  ]);

  await modelRunRepository.record({
    ingestionId: state.ingestionId,
    promptVersion: MEMORY_PROMPT_VERSION,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    rawResponse: result.raw,
  });

  return {
    generatedMemory: result.parsed,
    status: "validating" as const,
  };
}
```

The model may reference only supplied evidence-span IDs. It cannot mint source IDs, call persistence tools, or decide which database records to modify.

## 6. Graph construction

```ts
const memoryGenerationGraph = new StateGraph(IngestionState)
  .addNode("ingest", ingest)
  .addNode("storeEvidence", storeEvidence)
  .addNode("generateMemory", generateMemory)
  .addNode("validateMemory", validateMemory)
  .addNode("storeMemory", storeMemory)
  .addNode("publishMemoryReady", publishMemoryReady)
  .addEdge(START, "ingest")
  .addEdge("ingest", "storeEvidence")
  .addEdge("storeEvidence", "generateMemory")
  .addEdge("generateMemory", "validateMemory")
  .addEdge("validateMemory", "storeMemory")
  .addEdge("storeMemory", "publishMemoryReady")
  .addEdge("publishMemoryReady", END)
  .compile({ checkpointer: productionCheckpointer });
```

Use `ingestionId` as the LangGraph `thread_id`. A persistent checkpointer allows failed workflows to resume from the last completed node.

The checkpointer stores workflow execution state. It is not the Distillery memory database. Domain memory remains in the evidence/observation/claim tables.

## 7. Frontend/API interaction

### Start

```http
POST /api/ingestions
Idempotency-Key: <uuid>

{
  "type": "text",
  "content": "..."
}
```

Respond immediately:

```json
{
  "ingestionId": "ing_123",
  "status": "received"
}
```

The API creates the ingestion record, queues the graph invocation, and returns. Do not hold the request open for model generation.

### Observe

Use server-sent events or polling:

```http
GET /api/ingestions/ing_123/events
```

Expose product states, not internal prompts or chain-of-thought:

```text
received
storing evidence
generating memory
validating
ready
failed — retry available
```

LangGraph can stream node updates, but the backend should translate them into this stable product event contract so the frontend is not coupled to graph node names.

### Result

```http
GET /api/ingestions/ing_123
```

```json
{
  "ingestionId": "ing_123",
  "status": "ready",
  "sourceVersionId": "srcv_456",
  "memoryItems": [
    {
      "id": "mem_789",
      "type": "user_signal",
      "statement": "Admins cannot understand failed exports.",
      "reviewState": "unverified",
      "evidence": [
        {
          "spanId": "span_12",
          "exactText": "...",
          "locator": { "start": 180, "end": 228 }
        }
      ]
    }
  ]
}
```

This response is exactly what the Memory Generation screen displays under “Going into Memory Synthesis.”

## 8. Idempotency and retry rules

- `POST /ingestions` requires an idempotency key.
- Evidence uniqueness: `(tenant_id, content_hash, source_identity, source_version)`.
- Generation uniqueness: `(source_version_id, pipeline_version)`.
- Memory commit uniqueness: `(extraction_run_id, temporary_item_id)`.
- Every node can run more than once without duplicating domain records.
- Evidence remains stored if later nodes fail.
- A retry creates a new extraction run when the prompt, model, or schema version changes.
- Never keep a database transaction open across a model call.
- Publish `memory.ready` with a transactional outbox so the commit and event cannot diverge.

## 9. What belongs in LangChain/LangGraph

Use LangChain for:

- model-provider abstraction;
- structured output;
- prompt composition;
- embeddings later;
- test doubles and model-call tracing.

Use LangGraph for:

- step orchestration;
- checkpoints and recovery;
- retries and conditional failure paths;
- progress streaming;
- future human interruption if required.

Do not use LangGraph's store or checkpointer as the authoritative company memory. Do not give the generation model generic database-write tools.

## 10. Boundary with Memory Synthesis

Memory Generation ends when `memory.ready` is committed and emitted.

```text
memory.ready
  ingestionId
  sourceVersionId
  memoryItemIds[]
  tenantId
  pipelineVersion
  createdAt
```

Memory Synthesis consumes those versioned memory records, compares them with existing memory, and produces higher-order structures such as related-signal groups and initiative evidence. It never receives raw, unvalidated model output.

The downstream workflow is specified in [MEMORY_SYNTHESIS.md](./MEMORY_SYNTHESIS.md).
