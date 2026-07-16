import type { EvidenceSpan } from "@distillery/contracts";
import { createTextEvidenceBundle, sha256Hex } from "@distillery/evidence";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { MAX_EXTRACTED_DOCUMENT_CHARS } from "./limits";

export class SlackDocumentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SlackDocumentError";
  }
}

export type ParsedSlackDocument = {
  content: string;
  contentHash: string;
  evidenceSpans: EvidenceSpan[];
  structure: { pageCount?: number; paragraphCount?: number };
};

export async function parsePdfDocument(input: {
  bytes: Uint8Array;
  sourceVersionId: string;
  permalink: string;
  newSpanId?: () => string;
}): Promise<ParsedSlackDocument> {
  let result: { totalPages: number; text: string[] };
  try {
    result = await extractText(input.bytes, { mergePages: false });
  } catch {
    throw new SlackDocumentError("The attached PDF could not be parsed.", "pdf_parse_failed");
  }
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const meaningful = pages.join(" ").replace(/\s+/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  if (meaningful.length < 20) {
    throw new SlackDocumentError(
      "The attached PDF appears to be scanned or image-only. Distillery does not use OCR.",
      "pdf_without_meaningful_text",
    );
  }
  return createStructuredDocument({
    sourceVersionId: input.sourceVersionId,
    permalink: input.permalink,
    blocks: pages.map((text, index) => ({ text, pageNumber: index + 1 })),
    pageCount: result.totalPages,
    ...(input.newSpanId ? { newSpanId: input.newSpanId } : {}),
  });
}

export async function parseDocxDocument(input: {
  bytes: Uint8Array;
  sourceVersionId: string;
  permalink: string;
  newSpanId?: () => string;
}): Promise<ParsedSlackDocument> {
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      typeof Buffer === "undefined"
        ? { arrayBuffer: exactArrayBuffer(input.bytes) }
        : { buffer: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) },
      { includeDefaultStyleMap: true, ignoreEmptyParagraphs: true },
    );
    html = result.value;
  } catch {
    throw new SlackDocumentError("The attached DOCX could not be parsed.", "docx_parse_failed");
  }

  const blocks = extractHtmlBlocks(html);
  if (blocks.length === 0 || blocks.join("").replace(/\s+/gu, "").length < 1) {
    throw new SlackDocumentError("The attached DOCX does not contain extractable text.", "docx_without_text");
  }
  return createStructuredDocument({
    sourceVersionId: input.sourceVersionId,
    permalink: input.permalink,
    blocks: blocks.map((text, index) => ({ text, paragraphNumber: index + 1, blockNumber: index + 1 })),
    paragraphCount: blocks.length,
    ...(input.newSpanId ? { newSpanId: input.newSpanId } : {}),
  });
}

async function createStructuredDocument(input: {
  sourceVersionId: string;
  permalink: string;
  blocks: Array<{ text: string; pageNumber?: number; paragraphNumber?: number; blockNumber?: number }>;
  pageCount?: number;
  paragraphCount?: number;
  newSpanId?: () => string;
}): Promise<ParsedSlackDocument> {
  const blocks = input.blocks.map((block) => ({
    ...block,
    text: block.text.replace(/\r\n?/gu, "\n").trim(),
  })).filter((block) => block.text.length > 0);
  const content = blocks.map((block) => block.text).join("\n\n");
  if (content.length > MAX_EXTRACTED_DOCUMENT_CHARS) {
    throw new SlackDocumentError(
      `The document contains more than ${MAX_EXTRACTED_DOCUMENT_CHARS.toLocaleString()} extracted characters.`,
      "document_text_too_large",
    );
  }

  const evidenceSpans: EvidenceSpan[] = [];
  let charOffset = 0;
  let lineOffset = 0;
  const newSpanId = input.newSpanId ?? (() => `evspan_${crypto.randomUUID()}`);
  for (const block of blocks) {
    const bundle = await createTextEvidenceBundle({
      sourceVersionId: input.sourceVersionId,
      text: block.text,
      newSpanId,
    });
    for (const span of bundle.evidenceSpans) {
      evidenceSpans.push({
        ...span,
        startLine: span.startLine + lineOffset,
        endLine: span.endLine + lineOffset,
        startChar: span.startChar + charOffset,
        endChar: span.endChar + charOffset,
        locator: {
          provider: "slack",
          permalink: input.permalink,
          ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}),
          ...(block.paragraphNumber ? { paragraphNumber: block.paragraphNumber } : {}),
          ...(block.blockNumber ? { blockNumber: block.blockNumber } : {}),
          startChar: span.startChar,
          endChar: span.endChar,
        },
      });
    }
    charOffset += block.text.length + 2;
    lineOffset += block.text.split("\n").length + 1;
  }

  return {
    content,
    contentHash: await sha256Hex(content),
    evidenceSpans,
    structure: {
      ...(input.pageCount ? { pageCount: input.pageCount } : {}),
      ...(input.paragraphCount ? { paragraphCount: input.paragraphCount } : {}),
    },
  };
}

function extractHtmlBlocks(html: string): string[] {
  const matches = html.matchAll(/<(?:p|h[1-6]|li|blockquote|td|th)(?:\s[^>]*)?>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|td|th)>/giu);
  const blocks: string[] = [];
  for (const match of matches) {
    const text = decodeHtmlEntities(
      (match[1] ?? "")
        .replace(/<br\s*\/?>/giu, "\n")
        .replace(/<[^>]+>/gu, ""),
    ).replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (_match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
