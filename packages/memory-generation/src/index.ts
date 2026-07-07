import type {
  EvidenceSpan,
  GeneratedMemoryBatch,
  IngestionReceipt,
  IngestionResult,
  RecallMatch,
  CitedAnswer,
  RecallQueryInput,
  MemoryItemActionInput,
  MemoryItemHistory,
  MemoryItem,
} from "@distillery/contracts";
import { createTextEvidenceBundle } from "@distillery/evidence";
import type { MemoryGenerationModel } from "@distillery/model-gateway";
import { validateGeneratedMemory } from "@distillery/validation";

export const MEMORY_GENERATION_VERSION = "memory-generation-v0.1";
export const MEMORY_PROMPT_VERSION = "stable-memory-prompt-v0.1";
export const MEMORY_SCHEMA_VERSION = "generated-memory-batch-v0.2";
export const DEFAULT_TENANT_ID = "stable";

export type TextCaptureCommand = {
  mode: "remember";
  text: string;
  submittedByLabel?: string;
  idempotencyKey: string;
  appSessionId: string;
  tenantId?: string;
};

export type IngestionContext = {
  ingestionId: string;
  tenantId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
};

export type ExtractionRunRecord = {
  id: string;
  ingestionId: string;
  tenantId: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  rawResponse: unknown;
  status: "completed" | "failed";
};

export type CommittableMemoryItem = Omit<
  MemoryItem,
  "ingestionId" | "sourceVersionId" | "reviewState" | "supersedesMemoryItemId"
>;

export interface MemoryGenerationRepository {
  createTextIngestionWithEvidence(input: {
    tenantId: string;
    ingestionId: string;
    sourceItemId: string;
    sourceVersionId: string;
    idempotencyKey: string;
    appSessionId: string;
    submittedByLabel?: string;
    content: string;
    contentHash: string;
    evidenceSpans: EvidenceSpan[];
  }): Promise<IngestionReceipt>;

  getIngestionContext(ingestionId: string): Promise<IngestionContext>;

  markIngestionStatus(ingestionId: string, status: "generating" | "validating" | "memory_stored"): Promise<void>;

  recordExtractionRun(record: ExtractionRunRecord): Promise<void>;

  commitGeneratedMemory(input: {
    ingestionId: string;
    tenantId: string;
    sourceVersionId: string;
    extractionRunId: string;
    memoryGenerationVersion: string;
    items: CommittableMemoryItem[];
  }): Promise<MemoryItem[]>;

  failIngestion(ingestionId: string, message: string): Promise<void>;

  getIngestionResult(ingestionId: string): Promise<IngestionResult>;

  applyMemoryItemAction(input: {
    memoryItemId: string;
    action: MemoryItemActionInput;
    replacementMemoryItemId?: string;
  }): Promise<IngestionResult>;

  getMemoryItemHistory(memoryItemId: string): Promise<MemoryItemHistory>;

  recallMemory(input: RecallQueryInput): Promise<CitedAnswer>;
}

export async function applyMemoryItemAction(args: {
  memoryItemId: string;
  action: MemoryItemActionInput;
  repository: MemoryGenerationRepository;
  newId?: (prefix: string) => string;
}): Promise<IngestionResult> {
  const newId = args.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`);

  const payload = {
    memoryItemId: args.memoryItemId,
    action: args.action,
    ...(args.action.action === "edit" ? { replacementMemoryItemId: newId("mem") } : {}),
  };

  return args.repository.applyMemoryItemAction(payload);
}

export async function submitTextCapture(args: {
  command: TextCaptureCommand;
  repository: MemoryGenerationRepository;
  newId?: (prefix: string) => string;
}): Promise<IngestionReceipt> {
  const newId = args.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`);
  const tenantId = args.command.tenantId ?? DEFAULT_TENANT_ID;
  const ingestionId = newId("ing");
  const sourceItemId = newId("src");
  const sourceVersionId = newId("srcv");
  const evidence = await createTextEvidenceBundle({
    sourceVersionId,
    text: args.command.text,
    newSpanId: () => newId("evspan"),
  });

  const payload = {
    tenantId,
    ingestionId,
    sourceItemId,
    sourceVersionId,
    idempotencyKey: args.command.idempotencyKey,
    appSessionId: args.command.appSessionId,
    content: evidence.normalizedText,
    contentHash: evidence.contentHash,
    evidenceSpans: evidence.evidenceSpans,
    ...(args.command.submittedByLabel ? { submittedByLabel: args.command.submittedByLabel } : {}),
  };

  return args.repository.createTextIngestionWithEvidence(payload);
}

export async function runMemoryGenerationWorkflow(args: {
  ingestionId: string;
  repository: MemoryGenerationRepository;
  model: MemoryGenerationModel;
  newId?: (prefix: string) => string;
}): Promise<IngestionResult> {
  const newId = args.newId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`);

  try {
    const context = await args.repository.getIngestionContext(args.ingestionId);
    await args.repository.markIngestionStatus(args.ingestionId, "generating");

    const generated = await args.model.generateMemory({
      ingestionId: args.ingestionId,
      sourceVersionId: context.sourceVersionId,
      evidenceSpans: context.evidenceSpans,
    });

    const extractionRunId = newId("extr");
    await args.repository.recordExtractionRun({
      id: extractionRunId,
      ingestionId: args.ingestionId,
      tenantId: context.tenantId,
      provider: "openrouter",
      model: generated.model,
      promptVersion: MEMORY_PROMPT_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      rawResponse: generated.raw,
      status: "completed",
    });

    await args.repository.markIngestionStatus(args.ingestionId, "validating");
    const validation = validateGeneratedMemory({
      generated: generated.parsed,
      allowedEvidenceSpans: context.evidenceSpans,
    });

    if (!validation.result.ok) {
      await args.repository.failIngestion(
        args.ingestionId,
        validation.result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      );
      return args.repository.getIngestionResult(args.ingestionId);
    }

    await args.repository.commitGeneratedMemory({
      ingestionId: args.ingestionId,
      tenantId: context.tenantId,
      sourceVersionId: context.sourceVersionId,
      extractionRunId,
      memoryGenerationVersion: MEMORY_GENERATION_VERSION,
      items: validation.items.map((item) => ({
        id: newId("mem"),
        claimType: item.claimType,
        statement: item.statement,
        evidenceSpanIds: item.evidenceSpanIds,
        epistemicStatus: item.epistemicStatus,
        qualifiers: item.qualifiers,
        stableDomainTags: item.stableDomainTags,
        entities: item.entities,
        relations: item.relations,
        schemas: item.schemas,
      })),
    });

    return args.repository.getIngestionResult(args.ingestionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown memory generation failure.";
    await args.repository.failIngestion(args.ingestionId, message);
    return args.repository.getIngestionResult(args.ingestionId);
  }
}

export class StaticMemoryGenerationModel implements MemoryGenerationModel {
  constructor(private readonly batch: GeneratedMemoryBatch) {}

  async generateMemory(): Promise<{
    parsed: GeneratedMemoryBatch;
    raw: unknown;
    model: string;
  }> {
    return {
      parsed: this.batch,
      raw: this.batch,
      model: "static-test-model",
    };
  }
}

export function buildDeterministicCitedAnswer(args: {
  question: string;
  matches: RecallMatch[];
}): CitedAnswer {
  if (args.matches.length === 0) {
    return {
      question: args.question,
      answer: "I do not have enough stored evidence to answer that yet.",
      evidenceSpanIds: [],
      citations: [],
      matches: [],
      gap: "No active memory matched the question. Capture more context or ask a narrower question.",
    };
  }

  const citationMap = new Map<string, CitedAnswer["citations"][number]>();
  const answerLines = args.matches.map((match, index) => {
    for (const span of match.evidenceSpans) {
      citationMap.set(span.id, {
        evidenceSpanId: span.id,
        sourceVersionId: span.sourceVersionId,
        lineRange: `${span.startLine}-${span.endLine}`,
        text: span.text,
      });
    }

    const evidenceList = match.evidenceSpans.map((span) => span.id).join(", ");
    const status = match.memoryItem.reviewState === "confirmed" ? "confirmed" : match.memoryItem.epistemicStatus;
    return `${index + 1}. ${match.memoryItem.statement} [${evidenceList}; ${status}]`;
  });

  const citations = Array.from(citationMap.values());
  return {
    question: args.question,
    answer: answerLines.join("\n"),
    evidenceSpanIds: citations.map((citation) => citation.evidenceSpanId),
    citations,
    matches: args.matches,
  };
}
