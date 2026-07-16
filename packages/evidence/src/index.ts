import type { EvidenceSpan } from "@distillery/contracts";

export type TextEvidenceBundle = {
  contentHash: string;
  normalizedText: string;
  evidenceSpans: EvidenceSpan[];
};

export const DEFAULT_MAX_EVIDENCE_SPAN_CHARS = 2_000;

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeBraindumpText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export async function createTextEvidenceBundle(args: {
  sourceVersionId: string;
  text: string;
  newSpanId?: () => string;
  maxSpanChars?: number;
}): Promise<TextEvidenceBundle> {
  const normalizedText = normalizeBraindumpText(args.text);
  const contentHash = await sha256Hex(normalizedText);
  const newSpanId = args.newSpanId ?? (() => `evspan_${globalThis.crypto.randomUUID()}`);
  const maxSpanChars = Math.max(200, args.maxSpanChars ?? DEFAULT_MAX_EVIDENCE_SPAN_CHARS);

  const lines = normalizedText.split("\n");
  const evidenceSpans: EvidenceSpan[] = [];
  let offset = 0;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const lineStart = offset;
    const lineEnd = lineStart + rawLine.length;
    const trimmedText = rawLine.trim();

    if (trimmedText.length > 0) {
      const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
      const trailingWhitespace = rawLine.length - rawLine.trimEnd().length;
      const contentStart = leadingWhitespace;
      const contentEnd = rawLine.length - trailingWhitespace;
      for (const range of splitTextRange(rawLine, contentStart, contentEnd, maxSpanChars)) {
        evidenceSpans.push({
          id: newSpanId(),
          sourceVersionId: args.sourceVersionId,
          startLine: lineNumber,
          endLine: lineNumber,
          startChar: lineStart + range.start,
          endChar: lineStart + range.end,
          text: rawLine.slice(range.start, range.end),
        });
      }
    }

    offset = lineEnd + 1;
  }

  return {
    contentHash,
    normalizedText,
    evidenceSpans,
  };
}

function splitTextRange(
  text: string,
  start: number,
  end: number,
  maxChars: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;

  while (cursor < end) {
    const hardEnd = Math.min(end, cursor + maxChars);
    let splitAt = hardEnd;

    if (hardEnd < end) {
      const minimumUsefulBoundary = cursor + Math.floor(maxChars * 0.5);
      const window = text.slice(cursor, hardEnd);
      const sentenceBoundary = lastBoundary(window, /[.!?][\]"')\u201d\u2019]*\s+/gu);
      const wordBoundary = window.lastIndexOf(" ");
      const candidate = sentenceBoundary > 0 ? cursor + sentenceBoundary : cursor + wordBoundary;
      if (candidate >= minimumUsefulBoundary) splitAt = candidate;
    }

    while (splitAt > cursor && /\s/u.test(text[splitAt - 1] ?? "")) splitAt -= 1;
    if (splitAt <= cursor) splitAt = hardEnd;
    ranges.push({ start: cursor, end: splitAt });
    cursor = splitAt;
    while (cursor < end && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  }

  return ranges;
}

function lastBoundary(input: string, pattern: RegExp): number {
  let boundary = -1;
  for (const match of input.matchAll(pattern)) boundary = (match.index ?? 0) + match[0].length;
  return boundary;
}
