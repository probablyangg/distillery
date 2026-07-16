import {
  MemorySectionPlanSchema,
  type EvidenceSpan,
  type GeneratedMemoryItem,
  type MemorySectionPlan,
  type MemorySectionPlanItem,
  type ValidationIssue,
  type ValidationResult,
} from "@distillery/contracts";

export const DEFAULT_MEMORY_SECTIONING_CONFIG = {
  enabled: true,
  triggerChars: 6_000,
  triggerSpans: 20,
  targetChars: 5_000,
  maxChars: 8_000,
  maxSections: 50,
  maxSubdivisionDepth: 3,
} as const;

export type MemorySectioningConfig = {
  enabled: boolean;
  triggerChars: number;
  triggerSpans: number;
  targetChars: number;
  maxChars: number;
  maxSections: number;
  maxSubdivisionDepth: number;
};

export type SectioningDecision = {
  shouldSection: boolean;
  normalizedCharCount: number;
  evidenceSpanCount: number;
  reasons: Array<"disabled" | "char_threshold" | "span_threshold" | "below_thresholds">;
};

export function resolveMemorySectioningConfig(input: Partial<MemorySectioningConfig> = {}): MemorySectioningConfig {
  const config = { ...DEFAULT_MEMORY_SECTIONING_CONFIG, ...input };
  if (config.triggerChars < 1 || config.triggerSpans < 1 || config.targetChars < 1 || config.maxChars < 1) {
    throw new Error("Memory sectioning thresholds must be positive integers.");
  }
  if (config.targetChars > config.maxChars) throw new Error("Memory section target chars cannot exceed max chars.");
  if (config.maxSections < 1 || config.maxSections > 50) throw new Error("Memory section max sections must be between 1 and 50.");
  if (config.maxSubdivisionDepth < 0 || config.maxSubdivisionDepth > 8) {
    throw new Error("Memory section subdivision depth must be between 0 and 8.");
  }
  return config;
}

export function decideMemorySectioning(
  evidenceSpans: EvidenceSpan[],
  config: MemorySectioningConfig = resolveMemorySectioningConfig(),
): SectioningDecision {
  const normalizedCharCount = evidenceSpans.reduce((maximum, span) => Math.max(maximum, span.endChar), 0);
  const evidenceSpanCount = evidenceSpans.length;
  if (!config.enabled) {
    return { shouldSection: false, normalizedCharCount, evidenceSpanCount, reasons: ["disabled"] };
  }

  const reasons: SectioningDecision["reasons"] = [];
  if (normalizedCharCount >= config.triggerChars) reasons.push("char_threshold");
  if (evidenceSpanCount >= config.triggerSpans) reasons.push("span_threshold");
  if (reasons.length === 0) reasons.push("below_thresholds");
  return {
    shouldSection: reasons[0] !== "below_thresholds",
    normalizedCharCount,
    evidenceSpanCount,
    reasons,
  };
}

export function validateMemorySectionPlan(args: {
  plan: unknown;
  evidenceSpans: EvidenceSpan[];
  maxChars: number;
  maxSections: number;
}): ValidationResult {
  const parsed = MemorySectionPlanSchema.safeParse(args.plan);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "section_plan_schema_invalid",
        message: issue.message,
        path: issue.path.map(String),
      })),
    };
  }

  const issues: ValidationIssue[] = [];
  if (parsed.data.sections.length > args.maxSections) {
    issues.push({ code: "too_many_sections", message: `Section plan exceeds the maximum of ${args.maxSections}.`, path: ["sections"] });
  }

  const spanIndex = new Map(args.evidenceSpans.map((span, index) => [span.id, index]));
  let expectedStart = 0;
  for (const [sectionIndex, section] of parsed.data.sections.entries()) {
    const start = spanIndex.get(section.startEvidenceSpanId);
    const end = spanIndex.get(section.endEvidenceSpanId);
    const path = [`sections.${sectionIndex}`];
    if (start === undefined || end === undefined) {
      if (start === undefined) issues.push({ code: "unknown_evidence_span", message: `Unknown start evidence span: ${section.startEvidenceSpanId}`, path: [...path, "startEvidenceSpanId"] });
      if (end === undefined) issues.push({ code: "unknown_evidence_span", message: `Unknown end evidence span: ${section.endEvidenceSpanId}`, path: [...path, "endEvidenceSpanId"] });
      continue;
    }
    if (start > end) {
      issues.push({ code: "section_out_of_order", message: "A section must start before it ends.", path });
      continue;
    }
    if (start < expectedStart) issues.push({ code: "section_overlap", message: "Sections overlap or are out of source order.", path });
    if (start > expectedStart) issues.push({ code: "section_gap", message: "Section plan leaves evidence spans uncovered.", path });

    const charCount = sectionCharCount(args.evidenceSpans, start, end);
    if (charCount > args.maxChars && start !== end) {
      issues.push({ code: "section_oversized", message: `Section contains ${charCount} characters; maximum is ${args.maxChars}.`, path });
    }
    expectedStart = Math.max(expectedStart, end + 1);
  }

  if (expectedStart < args.evidenceSpans.length) {
    issues.push({ code: "section_gap", message: "Section plan does not cover every evidence span.", path: ["sections"] });
  }
  return { ok: issues.length === 0, issues };
}

export function deterministicMemorySectionPlan(args: {
  evidenceSpans: EvidenceSpan[];
  targetChars: number;
  maxChars: number;
  maxSections: number;
}): MemorySectionPlan {
  if (args.evidenceSpans.length === 0) throw new Error("Cannot section a source with no nonempty evidence spans.");
  const sections: MemorySectionPlanItem[] = [];
  let start = 0;

  while (start < args.evidenceSpans.length) {
    if (sections.length >= args.maxSections) {
      throw new Error(`Deterministic sectioning requires more than ${args.maxSections} sections.`);
    }
    let end = start;
    let bestEnd = start;
    while (end < args.evidenceSpans.length) {
      const charCount = sectionCharCount(args.evidenceSpans, start, end);
      if (charCount > args.maxChars && end > start) break;
      bestEnd = end;
      const next = args.evidenceSpans[end + 1];
      if (!next || charCount >= args.targetChars) break;
      if (end > start && isLikelyHeading(next) && charCount >= Math.floor(args.targetChars * 0.5)) break;
      end += 1;
    }

    const first = args.evidenceSpans[start]!;
    const last = args.evidenceSpans[bestEnd]!;
    sections.push({
      temporaryId: `section_${sections.length + 1}`,
      title: sectionTitle(first, sections.length + 1),
      startEvidenceSpanId: first.id,
      endEvidenceSpanId: last.id,
    });
    start = bestEnd + 1;
  }

  return { sections };
}

export function evidenceSpansForSection(
  section: Pick<MemorySectionPlanItem, "startEvidenceSpanId" | "endEvidenceSpanId">,
  evidenceSpans: EvidenceSpan[],
): EvidenceSpan[] {
  const start = evidenceSpans.findIndex((span) => span.id === section.startEvidenceSpanId);
  const end = evidenceSpans.findIndex((span) => span.id === section.endEvidenceSpanId);
  if (start < 0 || end < start) return [];
  return evidenceSpans.slice(start, end + 1);
}

export function subdivideSaturatedSection(args: {
  evidenceSpans: EvidenceSpan[];
  depth: number;
  maxDepth: number;
}): [EvidenceSpan[], EvidenceSpan[]] | null {
  if (args.depth >= args.maxDepth || args.evidenceSpans.length < 2) return null;
  const total = sectionCharCount(args.evidenceSpans, 0, args.evidenceSpans.length - 1);
  const target = total / 2;
  let splitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < args.evidenceSpans.length; index += 1) {
    const leftChars = sectionCharCount(args.evidenceSpans, 0, index - 1);
    const distance = Math.abs(target - leftChars);
    if (distance < bestDistance) {
      splitIndex = index;
      bestDistance = distance;
    }
  }
  return [args.evidenceSpans.slice(0, splitIndex), args.evidenceSpans.slice(splitIndex)];
}

export function consolidateSectionCandidates(input: Array<{
  sectionOrdinal: number;
  reviewRequired: boolean;
  item: GeneratedMemoryItem;
}>): { autoItems: GeneratedMemoryItem[]; reviewItems: GeneratedMemoryItem[]; duplicateCount: number } {
  const groups: Array<typeof input> = [];
  for (const candidate of input) {
    const match = groups.find((group) => areDuplicateStatements(group[0]!.item.statement, candidate.item.statement));
    if (match) match.push(candidate);
    else groups.push([candidate]);
  }

  let duplicateCount = 0;
  const survivors = groups.map((group) => {
    duplicateCount += group.length - 1;
    const ranked = [...group].sort((left, right) => candidateStrength(right) - candidateStrength(left));
    const survivor = ranked[0]!;
    const evidenceSpanIds = unique(group.flatMap((candidate) => candidate.item.evidenceSpanIds)).slice(0, 12);
    const relations = survivor.item.relations.map((relation) => ({
      ...relation,
      evidenceSpanIds: relation.evidenceSpanIds.filter((id) => evidenceSpanIds.includes(id)),
    })).filter((relation) => relation.evidenceSpanIds.length > 0);
    return {
      reviewRequired: group.every((candidate) => candidate.reviewRequired),
      item: {
        ...survivor.item,
        evidenceSpanIds,
        relations,
        qualifiers: {
          ...survivor.item.qualifiers,
          sectionOrdinals: unique(group.map((candidate) => String(candidate.sectionOrdinal))).map(Number),
          consolidatedDuplicateCount: group.length - 1,
        },
      },
    };
  });

  return {
    autoItems: survivors.filter((candidate) => !candidate.reviewRequired).map((candidate) => candidate.item),
    reviewItems: survivors.filter((candidate) => candidate.reviewRequired).map((candidate) => candidate.item),
    duplicateCount,
  };
}

function sectionCharCount(spans: EvidenceSpan[], start: number, end: number): number {
  const first = spans[start];
  const last = spans[end];
  return first && last ? Math.max(0, last.endChar - first.startChar) : 0;
}

function isLikelyHeading(span: EvidenceSpan): boolean {
  const text = span.text.trim();
  return text.length <= 120 && (/^#{1,6}\s/u.test(text) || /^[A-Z][^.!?]{0,100}:?$/u.test(text));
}

function sectionTitle(first: EvidenceSpan, ordinal: number): string {
  const compact = first.text.replace(/^#{1,6}\s*/u, "").replace(/\s+/gu, " ").trim();
  if (compact.length > 0 && compact.length <= 100) return compact.replace(/:$/u, "");
  return `Section ${ordinal}`;
}

function areDuplicateStatements(left: string, right: string): boolean {
  const normalizedLeft = normalizeStatement(left);
  const normalizedRight = normalizeStatement(right);
  // Cross-section consolidation is deliberately conservative. A one-word
  // difference can reverse a claim (for example, "enabled" versus "not
  // enabled"), so lexical similarity alone is not enough to merge facts.
  return normalizedLeft === normalizedRight;
}

function normalizeStatement(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function candidateStrength(candidate: { reviewRequired: boolean; item: GeneratedMemoryItem }): number {
  const verification = String(candidate.item.qualifiers.verificationStatus ?? "");
  const verificationScore = verification === "verified" ? 40 : verification === "corrected" ? 35 : 10;
  const epistemicScore = candidate.item.epistemicStatus === "observed" ? 8 : candidate.item.epistemicStatus === "decision_reported" ? 7 : 5;
  return verificationScore + epistemicScore + Math.min(candidate.item.evidenceSpanIds.length, 12) - (candidate.reviewRequired ? 20 : 0);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
