import { describe, expect, it } from "vitest";
import { createTextEvidenceBundle } from "./index";

describe("createTextEvidenceBundle", () => {
  it("creates exact line spans for non-empty braindump lines", async () => {
    const bundle = await createTextEvidenceBundle({
      sourceVersionId: "srcv_1",
      text: "  First line\n\nSecond line  ",
      newSpanId: (() => {
        let count = 0;
        return () => `span_${++count}`;
      })(),
    });

    expect(bundle.normalizedText).toBe("First line\n\nSecond line");
    expect(bundle.evidenceSpans).toEqual([
      {
        id: "span_1",
        sourceVersionId: "srcv_1",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 10,
        text: "First line",
      },
      {
        id: "span_2",
        sourceVersionId: "srcv_1",
        startLine: 3,
        endLine: 3,
        startChar: 12,
        endChar: 23,
        text: "Second line",
      },
    ]);
  });
});

