import { describe, expect, it } from "vitest";
import { validateGeneratedMemory } from "./index";

const spans = [
  {
    id: "span_1",
    sourceVersionId: "srcv_1",
    startLine: 1,
    endLine: 1,
    startChar: 0,
    endChar: 12,
    text: "Stable note.",
  },
];

describe("validateGeneratedMemory", () => {
  it("rejects memory that references unsupported evidence", () => {
    const validation = validateGeneratedMemory({
      allowedEvidenceSpans: spans,
      generated: {
        items: [
          {
            temporaryId: "m1",
            type: "risk",
            statement: "Unsupported claim.",
            evidenceSpanIds: ["missing_span"],
            epistemicStatus: "reported",
          },
        ],
      },
    });

    expect(validation.result.ok).toBe(false);
    expect(validation.result.issues[0]?.code).toBe("unknown_evidence_span");
  });

  it("accepts supported memory", () => {
    const validation = validateGeneratedMemory({
      allowedEvidenceSpans: spans,
      generated: {
        items: [
          {
            temporaryId: "m1",
            type: "risk",
            statement: "Stable note is a risk.",
            evidenceSpanIds: ["span_1"],
            epistemicStatus: "reported",
          },
        ],
      },
    });

    expect(validation.result.ok).toBe(true);
    expect(validation.items).toHaveLength(1);
  });

  it("allows duplicate temporary ids because persisted memory ids are assigned by Distillery", () => {
    const validation = validateGeneratedMemory({
      allowedEvidenceSpans: spans,
      generated: {
        items: [
          {
            temporaryId: "model_tmp",
            type: "risk",
            statement: "Stable note is a risk.",
            evidenceSpanIds: ["span_1"],
            epistemicStatus: "reported",
          },
          {
            temporaryId: "model_tmp",
            type: "dependency",
            statement: "Stable note is a dependency.",
            evidenceSpanIds: ["span_1"],
            epistemicStatus: "reported",
          },
        ],
      },
    });

    expect(validation.result.ok).toBe(true);
    expect(validation.items).toHaveLength(2);
  });
});
