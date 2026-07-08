import { describe, expect, it } from "vitest";
import type { EvidenceSpan, InitiativeBrief, MemoryItem } from "@distillery/contracts";
import {
  buildBriefEvidenceSet,
  buildSynthesisBundle,
  validateInitiativeBriefDraftTraceability,
  validateInitiativeBriefTraceability,
} from "./index";

const memoryItem: MemoryItem = {
  id: "mem_1",
  ingestionId: "ing_1",
  sourceVersionId: "srcv_1",
  claimType: "dependency",
  statement: "Stable checkout depends on relayer reliability before public launch.",
  evidenceSpanIds: ["ev_1"],
  epistemicStatus: "reported",
  qualifiers: {},
  stableDomainTags: ["checkout"],
  entities: [],
  relations: [],
  schemas: [],
  reviewState: "confirmed",
};

const evidenceSpan: EvidenceSpan = {
  id: "ev_1",
  sourceVersionId: "srcv_1",
  startLine: 1,
  endLine: 1,
  startChar: 0,
  endChar: 72,
  text: "Checkout launch depends on relayer reliability before we message it publicly.",
};

describe("memory synthesis traceability", () => {
  it("derives the evidence set from selected memory", () => {
    const evidenceSet = buildBriefEvidenceSet({
      memoryItems: [memoryItem],
      evidenceSpans: [evidenceSpan],
    });

    expect(evidenceSet.memoryItemIds).toEqual(["mem_1"]);
    expect(evidenceSet.evidenceSpanIds).toEqual(["ev_1"]);
    expect(evidenceSet.evidenceSpans).toEqual([evidenceSpan]);
  });

  it("accepts a brief backed by active memory and evidence", () => {
    const brief = makeBrief();
    const result = validateInitiativeBriefTraceability(brief, {
      requireActiveMemory: true,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a brief with inactive supporting memory", () => {
    const brief = makeBrief({
      memoryItems: [{ ...memoryItem, reviewState: "removed" }],
    });

    const result = validateInitiativeBriefTraceability(brief, {
      requireActiveMemory: true,
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("brief_inactive_memory");
  });

  it("accepts a generated draft backed by selected memory and evidence", () => {
    const result = validateInitiativeBriefDraftTraceability({
      draft: {
        title: "Relayer reliability launch gate",
        problem: "Stable cannot safely message checkout until relayer reliability is proven.",
        proposal: "Treat relayer reliability as a launch gate for checkout messaging.",
        successMetric: "Relayer success rate remains above the internal threshold for the agreed window.",
        risksAndDependencies: "Requires protocol and GTM alignment.",
        memoryItemIds: ["mem_1"],
        evidenceSpanIds: ["ev_1"],
      },
      selectedMemoryItems: [memoryItem],
      selectedEvidenceSpans: [evidenceSpan],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a generated draft that cites unselected evidence", () => {
    const result = validateInitiativeBriefDraftTraceability({
      draft: {
        title: "Relayer reliability launch gate",
        problem: "Stable cannot safely message checkout until relayer reliability is proven.",
        proposal: "Treat relayer reliability as a launch gate for checkout messaging.",
        successMetric: "Relayer success rate remains above the internal threshold for the agreed window.",
        risksAndDependencies: "Requires protocol and GTM alignment.",
        memoryItemIds: ["mem_1"],
        evidenceSpanIds: ["ev_1", "ev_unsupported"],
      },
      selectedMemoryItems: [memoryItem],
      selectedEvidenceSpans: [evidenceSpan],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "draft_unsupported_evidence")).toBe(true);
  });

  it("expands seed memory through semantic connections", () => {
    const bundle = buildSynthesisBundle({
      seedMemoryItemIds: ["mem_1"],
      memory: [
        {
          memoryItem: {
            ...memoryItem,
            entities: [{ name: "Relayer reliability", entityType: "capability" }],
            schemas: [{
              subjectType: "capability",
              predicate: "gates",
              objectType: "launch",
              status: "candidate",
            }],
          },
          evidenceSpans: [evidenceSpan],
        },
        {
          memoryItem: {
            ...memoryItem,
            id: "mem_2",
            claimType: "risk",
            statement: "Checkout launch risk remains high until relayer reliability is proven.",
            evidenceSpanIds: ["ev_2"],
            entities: [{ name: "Relayer reliability", entityType: "capability" }],
            schemas: [{
              subjectType: "capability",
              predicate: "gates",
              objectType: "launch",
              status: "candidate",
            }],
          },
          evidenceSpans: [{ ...evidenceSpan, id: "ev_2", sourceVersionId: "srcv_2" }],
        },
      ],
    });

    expect(bundle.bundle.selectedMemoryItemIds).toEqual(["mem_1", "mem_2"]);
    expect(bundle.bundle.connections.map((connection) => connection.reason)).toContain("shared_entity");
    expect(bundle.bundle.connections.map((connection) => connection.reason)).toContain("matching_schema_candidate");
    expect(bundle.bundle.readiness.ready).toBe(true);
  });

  it("blocks readiness for unresolved blocking contradictions", () => {
    const bundle = buildSynthesisBundle({
      seedMemoryItemIds: ["mem_1"],
      memory: [
        {
          memoryItem: {
            ...memoryItem,
            entities: [{ name: "Relayer reliability", entityType: "capability" }],
            qualifiers: { contradictionSeverity: "blocking" },
          },
          evidenceSpans: [evidenceSpan],
        },
        {
          memoryItem: {
            ...memoryItem,
            id: "mem_2",
            statement: "Relayer reliability is already proven.",
            evidenceSpanIds: ["ev_2"],
            entities: [{ name: "Relayer reliability", entityType: "capability" }],
          },
          evidenceSpans: [{ ...evidenceSpan, id: "ev_2", sourceVersionId: "srcv_2" }],
        },
      ],
    });

    expect(bundle.bundle.readiness.ready).toBe(false);
    expect(bundle.bundle.readiness.skipReasons).toContain("Unresolved blocking contradiction exists.");
  });
});

function makeBrief(overrides: Partial<InitiativeBrief> = {}): InitiativeBrief {
  return {
    id: "brief_1",
    title: "Relayer reliability launch gate",
    status: "draft",
    problem: "Stable cannot safely message checkout until relayer reliability is proven.",
    proposal: "Treat relayer reliability as a launch gate for checkout messaging.",
    successMetric: "Relayer success rate remains above the internal threshold for the agreed window.",
    risksAndDependencies: "Requires protocol and GTM alignment.",
    memoryItemIds: ["mem_1"],
    evidenceSpanIds: ["ev_1"],
    memoryItems: [memoryItem],
    evidenceSpans: [evidenceSpan],
    createdByLabel: "Angela",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    decisions: [],
    ...overrides,
  };
}
