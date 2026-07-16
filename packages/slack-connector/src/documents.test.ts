import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({ extractText: vi.fn() }));
vi.mock("mammoth", () => ({
  default: { convertToHtml: vi.fn() },
}));

import mammoth from "mammoth";
import { extractText } from "unpdf";
import { parseDocxDocument, parsePdfDocument } from "./documents";

const mockedExtractText = vi.mocked(extractText);
const mockedConvertToHtml = vi.mocked(mammoth.convertToHtml);

describe("Slack attachment parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains PDF page locators and exact normalized-source offsets", async () => {
    mockedExtractText.mockResolvedValue({
      totalPages: 2,
      text: [
        "Page one records a leadership decision.",
        "Page two records the dependency and owner.",
      ],
    } as unknown as Awaited<ReturnType<typeof extractText>>);
    let id = 0;
    const result = await parsePdfDocument({
      bytes: new Uint8Array([1, 2, 3]),
      sourceVersionId: "srcv_pdf",
      permalink: "https://example.slack.com/files/F12345678",
      newSpanId: () => `span_${++id}`,
    });

    expect(result.content).toBe(
      "Page one records a leadership decision.\n\nPage two records the dependency and owner.",
    );
    expect(result.structure).toEqual({ pageCount: 2 });
    expect(result.evidenceSpans.map((span) => span.locator?.pageNumber)).toEqual([1, 2]);
    for (const span of result.evidenceSpans) {
      expect(result.content.slice(span.startChar, span.endChar)).toBe(span.text);
    }
  });

  it("rejects scanned or image-only PDFs instead of invoking OCR", async () => {
    mockedExtractText.mockResolvedValue({ totalPages: 1, text: ["  1  "] } as unknown as Awaited<ReturnType<typeof extractText>>);
    await expect(parsePdfDocument({
      bytes: new Uint8Array([1]),
      sourceVersionId: "srcv_pdf",
      permalink: "https://example.slack.com/files/F12345678",
    })).rejects.toMatchObject({ code: "pdf_without_meaningful_text" });
  });

  it("retains DOCX paragraph/block locators, decodes text, and preserves offsets", async () => {
    mockedConvertToHtml.mockResolvedValue({
      value: "<h1>Decision &amp; context</h1><p>Ship in August.<br/>Owner: Angela.</p><ul><li>Dependency A</li></ul>",
      messages: [],
    });
    let id = 0;
    const result = await parseDocxDocument({
      bytes: new Uint8Array([80, 75]),
      sourceVersionId: "srcv_docx",
      permalink: "https://example.slack.com/files/F87654321",
      newSpanId: () => `span_${++id}`,
    });

    expect(result.content).toBe("Decision & context\n\nShip in August.\nOwner: Angela.\n\nDependency A");
    expect(result.structure).toEqual({ paragraphCount: 3 });
    expect(result.evidenceSpans.map((span) => span.locator?.paragraphNumber)).toEqual([1, 2, 2, 3]);
    for (const span of result.evidenceSpans) {
      expect(result.content.slice(span.startChar, span.endChar)).toBe(span.text);
    }
  });

  it("rejects documents above the extracted-text cap", async () => {
    mockedConvertToHtml.mockResolvedValue({ value: `<p>${"x".repeat(200_001)}</p>`, messages: [] });
    await expect(parseDocxDocument({
      bytes: new Uint8Array([80, 75]),
      sourceVersionId: "srcv_large",
      permalink: "https://example.slack.com/files/F87654321",
    })).rejects.toMatchObject({ code: "document_text_too_large" });
  });

  it("chunks a long document into bounded exact evidence spans for the existing sectioning policy", async () => {
    const text = "Evidence sentence with a decision and dependency. ".repeat(1_000).trim();
    mockedConvertToHtml.mockResolvedValue({ value: `<p>${text}</p>`, messages: [] });
    const result = await parseDocxDocument({
      bytes: new Uint8Array([80, 75]),
      sourceVersionId: "srcv_long_docx",
      permalink: "https://example.slack.com/files/F87654321",
    });
    expect(result.evidenceSpans.length).toBeGreaterThan(20);
    expect(result.evidenceSpans.every((span) => span.text.length <= 2_000)).toBe(true);
    for (const span of result.evidenceSpans) {
      expect(result.content.slice(span.startChar, span.endChar)).toBe(span.text);
      expect(span.locator?.paragraphNumber).toBe(1);
    }
  });
});
