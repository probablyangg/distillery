import type { EvidenceSpan } from "@distillery/contracts";

export type TextEvidenceBundle = {
  contentHash: string;
  normalizedText: string;
  evidenceSpans: EvidenceSpan[];
};

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
}): Promise<TextEvidenceBundle> {
  const normalizedText = normalizeBraindumpText(args.text);
  const contentHash = await sha256Hex(normalizedText);
  const newSpanId = args.newSpanId ?? (() => `evspan_${globalThis.crypto.randomUUID()}`);

  const lines = normalizedText.split("\n");
  const evidenceSpans: EvidenceSpan[] = [];
  let offset = 0;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const lineStart = offset;
    const lineEnd = lineStart + rawLine.length;
    const text = rawLine.trim();

    if (text.length > 0) {
      const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
      const trailingWhitespace = rawLine.length - rawLine.trimEnd().length;
      evidenceSpans.push({
        id: newSpanId(),
        sourceVersionId: args.sourceVersionId,
        startLine: lineNumber,
        endLine: lineNumber,
        startChar: lineStart + leadingWhitespace,
        endChar: lineEnd - trailingWhitespace,
        text,
      });
    }

    offset = lineEnd + 1;
  }

  return {
    contentHash,
    normalizedText,
    evidenceSpans,
  };
}

