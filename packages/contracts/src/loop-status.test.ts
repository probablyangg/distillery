import { describe, expect, it } from "vitest";
import { InitiativeBriefDraftInputSchema, PolicyNameSchema, LoopStatusResponseSchema } from "./index";

describe("LoopStatusResponseSchema", () => {
  it("accepts current item loop status with stages, timeline, and activity", () => {
    const parsed = LoopStatusResponseSchema.parse({
      mode: "current",
      subject: {
        ingestionId: "ing_1",
        subjectType: "source",
        subjectId: "srcv_1",
      },
      summary: "Loop committed memory_committed.",
      isTerminal: true,
      lastUpdatedAt: new Date(0).toISOString(),
      stages: [{
        key: "source_committed",
        label: "Source committed",
        status: "completed",
        description: "Evidence enters the immutable ledger.",
        occurredAt: new Date(0).toISOString(),
        detail: "levt_1",
      }],
      timeline: [{
        id: "levt_1",
        kind: "ledger_event",
        label: "Source committed",
        status: "source_committed",
        occurredAt: new Date(0).toISOString(),
        summary: "Immutable source and evidence were committed to the ledger.",
        severity: "success",
        technical: [{ label: "ledger_event_id", value: "levt_1" }],
      }],
      activity: [{
        id: "work_1",
        kind: "work",
        label: "Pending work",
        status: "completed",
        occurredAt: new Date(0).toISOString(),
        summary: "extract_memory for source srcv_1",
        severity: "success",
        technical: [{ label: "work_item_id", value: "work_1" }],
      }],
      sectionProgress: {
        usedSectioning: true,
        plannedSections: 7,
        pendingSections: 3,
        processingSections: 1,
        completedSections: 3,
        failedSections: 0,
        currentSectionOrdinal: 4,
        currentSectionTitle: "MemIAVL",
        phase: "extracting",
        terminalState: "processing",
      },
    });

    expect(parsed.mode).toBe("current");
    expect(parsed.stages[0]?.key).toBe("source_committed");
    expect(parsed.timeline[0]?.technical[0]?.label).toBe("ledger_event_id");
    expect(parsed.sectionProgress?.currentSectionTitle).toBe("MemIAVL");
  });

  it("rejects raw payload-like timeline records", () => {
    const result = LoopStatusResponseSchema.safeParse({
      mode: "activity",
      subject: null,
      summary: "Recent loop activity",
      isTerminal: true,
      lastUpdatedAt: new Date(0).toISOString(),
      stages: [],
      timeline: [],
      activity: [{
        id: "pevt_1",
        kind: "proposed_event",
        label: "Proposed event",
        status: "valid/not_required",
        occurredAt: new Date(0).toISOString(),
        summary: "memory_proposed -> memory_committed",
        severity: "success",
        payload: { raw: "should not be accepted" },
      }],
    });

    expect(result.success).toBe(false);
  });
});

describe("policy contracts", () => {
  it("accepts synthesize_brief as a policy name", () => {
    expect(PolicyNameSchema.parse("synthesize_brief")).toBe("synthesize_brief");
  });

  it("uses corpus expansion by default for manual drafts", () => {
    const parsed = InitiativeBriefDraftInputSchema.parse({
      memoryItemIds: ["mem_1"],
    });

    expect(parsed.expandRelatedMemory).toBe(true);
  });
});
