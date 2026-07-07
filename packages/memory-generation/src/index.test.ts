import { describe, expect, it } from "vitest";
import type {
  EvidenceSpan,
  IngestionReceipt,
  IngestionResult,
  MemoryItem,
  MemoryItemActionInput,
  MemoryItemHistory,
  MemoryItemHistoryEvent,
  CitedAnswer,
} from "@distillery/contracts";
import {
  runMemoryGenerationWorkflow,
  StaticMemoryGenerationModel,
  submitTextCapture,
  type ExtractionRunRecord,
  type IngestionContext,
  type MemoryGenerationRepository,
} from "./index";

class InMemoryRepository implements MemoryGenerationRepository {
  receipt?: IngestionReceipt;
  context?: IngestionContext;
  result?: IngestionResult;
  extractionRuns: ExtractionRunRecord[] = [];
  events: MemoryItemHistoryEvent[] = [];
  supersededMemoryItemIds = new Set<string>();
  removedMemoryItemIds = new Set<string>();

  async createTextIngestionWithEvidence(input: {
    tenantId: string;
    ingestionId: string;
    sourceVersionId: string;
    evidenceSpans: EvidenceSpan[];
  }): Promise<IngestionReceipt> {
    this.context = {
      ingestionId: input.ingestionId,
      tenantId: input.tenantId,
      sourceVersionId: input.sourceVersionId,
      evidenceSpans: input.evidenceSpans,
    };
    this.result = {
      ingestionId: input.ingestionId,
      status: "evidence_stored",
      sourceVersionId: input.sourceVersionId,
      evidenceSpans: input.evidenceSpans,
      memoryItems: [],
    };
    this.receipt = {
      ingestionId: input.ingestionId,
      status: "evidence_stored",
      sourceVersionId: input.sourceVersionId,
    };
    return this.receipt;
  }

  async getIngestionContext(): Promise<IngestionContext> {
    if (!this.context) throw new Error("missing context");
    return this.context;
  }

  async markIngestionStatus(_ingestionId: string, status: "generating" | "validating" | "memory_stored"): Promise<void> {
    if (this.result) this.result.status = status;
  }

  async recordExtractionRun(record: ExtractionRunRecord): Promise<void> {
    this.extractionRuns.push(record);
  }

  async commitGeneratedMemory(input: {
    ingestionId: string;
    sourceVersionId: string;
    items: Array<Omit<MemoryItem, "ingestionId" | "sourceVersionId" | "reviewState" | "supersedesMemoryItemId">>;
  }): Promise<MemoryItem[]> {
    if (!this.result) throw new Error("missing result");
    const memoryItems = input.items.map((item) => ({
      ...item,
      ingestionId: input.ingestionId,
      sourceVersionId: input.sourceVersionId,
      reviewState: "unreviewed" as const,
    }));
    this.result.status = "ready";
    this.result.memoryItems = memoryItems;
    return memoryItems;
  }

  async failIngestion(_ingestionId: string, message: string): Promise<void> {
    if (!this.result) throw new Error("missing result");
    this.result.status = "failed";
    this.result.errorMessage = message;
  }

  async getIngestionResult(): Promise<IngestionResult> {
    if (!this.result) throw new Error("missing result");
    return {
      ...this.result,
      memoryItems: this.result.memoryItems.filter(
        (item) => !this.supersededMemoryItemIds.has(item.id) && !this.removedMemoryItemIds.has(item.id),
      ),
    };
  }

  async applyMemoryItemAction(input: {
    memoryItemId: string;
    action: MemoryItemActionInput;
    replacementMemoryItemId?: string;
  }): Promise<IngestionResult> {
    if (!this.result) throw new Error("missing result");
    const item = this.result.memoryItems.find((candidate) => candidate.id === input.memoryItemId);
    if (!item) throw new Error("missing memory item");

    const event: MemoryItemHistoryEvent = {
      id: `evt_${this.events.length + 1}`,
      memoryItemId: input.memoryItemId,
      eventType: input.action.action,
      reviewerLabel: input.action.reviewerLabel,
      rationale: input.action.rationale ?? null,
      replacementMemoryItemId: null,
      createdAt: new Date(0).toISOString(),
    };

    if (input.action.action === "confirm") {
      item.reviewState = "confirmed";
    }

    if (input.action.action === "remove") {
      this.removedMemoryItemIds.add(item.id);
      item.reviewState = "removed";
    }

    if (input.action.action === "edit") {
      if (!input.action.replacement || !input.replacementMemoryItemId) throw new Error("missing replacement");
      this.supersededMemoryItemIds.add(item.id);
      item.reviewState = "superseded";
      const replacement: MemoryItem = {
        ...input.action.replacement,
        id: input.replacementMemoryItemId,
        ingestionId: item.ingestionId,
        sourceVersionId: item.sourceVersionId,
        reviewState: "unreviewed",
        supersedesMemoryItemId: item.id,
      };
      this.result.memoryItems.push(replacement);
      event.replacementMemoryItemId = replacement.id;
    }

    this.events.push(event);
    return this.getIngestionResult();
  }

  async getMemoryItemHistory(memoryItemId: string): Promise<MemoryItemHistory> {
    if (!this.result) throw new Error("missing result");
    const memoryItem = this.result.memoryItems.find((item) => item.id === memoryItemId);
    if (!memoryItem) throw new Error("missing memory item");
    return {
      memoryItem,
      events: this.events.filter((event) => event.memoryItemId === memoryItemId),
      replacements: this.result.memoryItems.filter((item) => item.supersedesMemoryItemId === memoryItemId),
    };
  }

  async recallMemory(): Promise<CitedAnswer> {
    return {
      question: "test question",
      answer: "I do not have enough stored evidence to answer that yet.",
      evidenceSpanIds: [],
      citations: [],
      matches: [],
      gap: "No active memory matched the question.",
    };
  }
}

describe("memory generation workflow", () => {
  it("stores evidence first and commits supported memory", async () => {
    const repository = new InMemoryRepository();
    let id = 0;
    const newId = (prefix: string) => `${prefix}_${++id}`;
    const receipt = await submitTextCapture({
      command: {
        mode: "remember",
        text: "Stable should not launch campaign until reliability metrics are boring.",
        idempotencyKey: "idem_1",
        appSessionId: "sess_1",
      },
      repository,
      newId,
    });

    expect(receipt.status).toBe("evidence_stored");
    const spanId = repository.context?.evidenceSpans[0]?.id;
    expect(spanId).toBeTruthy();

    const result = await runMemoryGenerationWorkflow({
      ingestionId: receipt.ingestionId,
      repository,
      newId,
      model: new StaticMemoryGenerationModel({
        items: [
          {
            temporaryId: "m1",
            type: "constraint",
            statement: "Stable should not launch the campaign until reliability metrics are boring.",
            evidenceSpanIds: [spanId!],
            epistemicStatus: "reported",
            stableDomainTags: ["gtm", "protocol"],
            qualifiers: {},
          },
        ],
      }),
    });

    expect(result.status).toBe("ready");
    expect(result.memoryItems).toHaveLength(1);
    expect(result.memoryItems[0]?.evidenceSpanIds).toEqual([spanId]);
  });

  it("fails closed when the model invents evidence ids", async () => {
    const repository = new InMemoryRepository();
    let id = 0;
    const newId = (prefix: string) => `${prefix}_${++id}`;
    const receipt = await submitTextCapture({
      command: {
        mode: "remember",
        text: "Stable gas waiver requires governance approval.",
        idempotencyKey: "idem_2",
        appSessionId: "sess_1",
      },
      repository,
      newId,
    });

    const result = await runMemoryGenerationWorkflow({
      ingestionId: receipt.ingestionId,
      repository,
      newId,
      model: new StaticMemoryGenerationModel({
        items: [
          {
            temporaryId: "m1",
            type: "dependency",
            statement: "Gas waiver requires governance approval.",
            evidenceSpanIds: ["invented_span"],
            epistemicStatus: "reported",
            stableDomainTags: ["gasless_ux"],
            qualifiers: {},
          },
        ],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("unknown_evidence_span");
  });

  it("supports append-only confirm, remove, and edit actions", async () => {
    const repository = new InMemoryRepository();
    let id = 0;
    const newId = (prefix: string) => `${prefix}_${++id}`;
    const receipt = await submitTextCapture({
      command: {
        mode: "remember",
        text: "Stable gas waiver requires governance approval.",
        idempotencyKey: "idem_3",
        appSessionId: "sess_1",
      },
      repository,
      newId,
    });
    const spanId = repository.context?.evidenceSpans[0]?.id;

    const ready = await runMemoryGenerationWorkflow({
      ingestionId: receipt.ingestionId,
      repository,
      newId,
      model: new StaticMemoryGenerationModel({
        items: [
          {
            temporaryId: "m1",
            type: "dependency",
            statement: "Gas waiver requires governance approval.",
            evidenceSpanIds: [spanId!],
            epistemicStatus: "reported",
            stableDomainTags: ["gasless_ux"],
            qualifiers: {},
          },
        ],
      }),
    });

    const originalId = ready.memoryItems[0]!.id;
    const confirmed = await repository.applyMemoryItemAction({
      memoryItemId: originalId,
      action: {
        action: "confirm",
        reviewerLabel: "Stable reviewer",
      },
    });
    expect(confirmed.memoryItems[0]?.reviewState).toBe("confirmed");

    const edited = await repository.applyMemoryItemAction({
      memoryItemId: originalId,
      replacementMemoryItemId: "mem_replacement",
      action: {
        action: "edit",
        reviewerLabel: "Stable reviewer",
        replacement: {
          type: "constraint",
          statement: "Public gas waiver promises require governance approval.",
          evidenceSpanIds: [spanId!],
          epistemicStatus: "reported",
          stableDomainTags: ["gasless_ux", "governance"],
          qualifiers: {},
        },
      },
    });
    expect(edited.memoryItems.map((item) => item.id)).toEqual(["mem_replacement"]);

    const history = await repository.getMemoryItemHistory(originalId);
    expect(history.memoryItem.reviewState).toBe("superseded");
    expect(history.events.map((event) => event.eventType)).toEqual(["confirm", "edit"]);
    expect(history.replacements[0]?.id).toBe("mem_replacement");

    const removed = await repository.applyMemoryItemAction({
      memoryItemId: "mem_replacement",
      action: {
        action: "remove",
        reviewerLabel: "Stable reviewer",
      },
    });
    expect(removed.memoryItems).toHaveLength(0);
  });
});
