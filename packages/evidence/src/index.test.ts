import { describe, expect, it } from "vitest";
import { createTextEvidenceBundle, normalizeBraindumpText } from "./index";

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

  it("segments a 50,000-character single line and preserves exact offsets", async () => {
    const text = `${"Alpha sentence. ".repeat(3_124)}${"z".repeat(16)}`;
    const bundle = await createTextEvidenceBundle({ sourceVersionId: "srcv_long", text });

    expect(text).toHaveLength(50_000);
    expect(bundle.normalizedText).toBe(normalizeBraindumpText(text));
    expect(bundle.evidenceSpans.length).toBeGreaterThan(20);
    expect(bundle.evidenceSpans.every((span) => span.text === bundle.normalizedText.slice(span.startChar, span.endChar))).toBe(true);
    expect(bundle.evidenceSpans.every((span) => span.text.length <= 2_000)).toBe(true);
  });

  it("normalizes line endings and preserves Unicode and trimmed source offsets", async () => {
    const bundle = await createTextEvidenceBundle({
      sourceVersionId: "srcv_unicode",
      text: "  Caf\u00e9 \ud83d\ude80\r\n\r\n\u6771\u4eac roadmap  \r",
      maxSpanChars: 200,
    });

    expect(bundle.normalizedText).toBe("Caf\u00e9 \ud83d\ude80\n\n\u6771\u4eac roadmap");
    for (const span of bundle.evidenceSpans) {
      expect(span.text).toBe(bundle.normalizedText.slice(span.startChar, span.endChar));
    }
    expect(bundle.evidenceSpans.map((span) => span.text)).toEqual(["Caf\u00e9 \ud83d\ude80", "\u6771\u4eac roadmap"]);
  });

  it("uses word boundaries for long paragraphs without headings", async () => {
    const bundle = await createTextEvidenceBundle({
      sourceVersionId: "srcv_paragraph",
      text: "word ".repeat(2_000),
      maxSpanChars: 500,
    });

    expect(bundle.evidenceSpans.length).toBeGreaterThan(10);
    expect(bundle.evidenceSpans.every((span) => !span.text.startsWith(" ") && !span.text.endsWith(" "))).toBe(true);
    expect(bundle.evidenceSpans.every((span) => span.text.length <= 500)).toBe(true);
  });
});
