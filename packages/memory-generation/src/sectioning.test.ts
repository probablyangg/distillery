import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvidenceSpan, GeneratedMemoryItem } from "@distillery/contracts";
import { createTextEvidenceBundle } from "@distillery/evidence";
import {
  consolidateSectionCandidates,
  decideMemorySectioning,
  deterministicMemorySectionPlan,
  evidenceSpansForSection,
  resolveMemorySectioningConfig,
  subdivideSaturatedSection,
  validateMemorySectionPlan,
} from "./sectioning";

function spans(count: number, chars = 400): EvidenceSpan[] {
  let offset = 0;
  return Array.from({ length: count }, (_, index) => {
    const start = offset;
    const text = `${index === 0 ? "Overview " : "detail "}${"x".repeat(Math.max(1, chars - 10))}`;
    offset += text.length + 1;
    return { id: `span_${index + 1}`, sourceVersionId: "srcv_1", startLine: index + 1, endLine: index + 1, startChar: start, endChar: start + text.length, text };
  });
}

describe("memory sectioning", () => {
  it("keeps short input on the single-extraction path", () => {
    expect(decideMemorySectioning(spans(2, 100), resolveMemorySectioningConfig()).shouldSection).toBe(false);
  });

  it("sections long or information-dense input", () => {
    expect(decideMemorySectioning(spans(2, 3_100), resolveMemorySectioningConfig()).shouldSection).toBe(true);
    expect(decideMemorySectioning(spans(20, 100), resolveMemorySectioningConfig()).shouldSection).toBe(true);
  });

  it("accepts a complete contiguous semantic plan", () => {
    const evidenceSpans = spans(4, 100);
    const result = validateMemorySectionPlan({
      plan: { sections: [
        { temporaryId: "a", title: "Overview", startEvidenceSpanId: "span_1", endEvidenceSpanId: "span_2" },
        { temporaryId: "b", title: "Compatibility", startEvidenceSpanId: "span_3", endEvidenceSpanId: "span_4" },
      ] },
      evidenceSpans,
      maxChars: 8_000,
      maxSections: 50,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["unknown IDs", { sections: [{ temporaryId: "a", title: "A", startEvidenceSpanId: "missing", endEvidenceSpanId: "span_4" }] }, "unknown_evidence_span"],
    ["overlap", { sections: [
      { temporaryId: "a", title: "A", startEvidenceSpanId: "span_1", endEvidenceSpanId: "span_3" },
      { temporaryId: "b", title: "B", startEvidenceSpanId: "span_3", endEvidenceSpanId: "span_4" },
    ] }, "section_overlap"],
    ["gap", { sections: [
      { temporaryId: "a", title: "A", startEvidenceSpanId: "span_1", endEvidenceSpanId: "span_1" },
      { temporaryId: "b", title: "B", startEvidenceSpanId: "span_3", endEvidenceSpanId: "span_4" },
    ] }, "section_gap"],
    ["out of order", { sections: [{ temporaryId: "a", title: "A", startEvidenceSpanId: "span_3", endEvidenceSpanId: "span_2" }] }, "section_out_of_order"],
  ])("rejects %s", (_label, plan, code) => {
    const result = validateMemorySectionPlan({ plan, evidenceSpans: spans(4, 100), maxChars: 8_000, maxSections: 50 });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  it("falls back to a complete bounded deterministic plan", () => {
    const evidenceSpans = spans(30, 500);
    const plan = deterministicMemorySectionPlan({ evidenceSpans, targetChars: 2_000, maxChars: 3_000, maxSections: 50 });
    expect(validateMemorySectionPlan({ plan, evidenceSpans, maxChars: 3_000, maxSections: 50 }).ok).toBe(true);
    expect(plan.sections.length).toBeGreaterThan(1);
  });

  it("subdivides saturated multi-span sections with a bounded depth", () => {
    const split = subdivideSaturatedSection({ evidenceSpans: spans(10, 500), depth: 0, maxDepth: 3 });
    expect(split?.[0].length).toBeGreaterThan(0);
    expect(split?.[1].length).toBeGreaterThan(0);
    expect(subdivideSaturatedSection({ evidenceSpans: spans(10, 500), depth: 3, maxDepth: 3 })).toBeNull();
  });

  it("consolidates exact cross-section duplicates and retains their citations", () => {
    const item = (temporaryId: string, evidenceSpanId: string, verificationStatus: string): GeneratedMemoryItem => ({
      temporaryId,
      claimType: "fact",
      statement: "MemIAVL reduces write amplification for Stable nodes.",
      evidenceSpanIds: [evidenceSpanId],
      epistemicStatus: "reported",
      qualifiers: { verificationStatus },
      stableDomainTags: [], entities: [], relations: [], schemas: [],
    });
    const result = consolidateSectionCandidates([
      { sectionOrdinal: 1, reviewRequired: false, item: item("a", "span_1", "verified") },
      { sectionOrdinal: 2, reviewRequired: true, item: item("b", "span_2", "needs_review") },
    ]);
    expect(result.duplicateCount).toBe(1);
    expect(result.autoItems).toHaveLength(1);
    expect(result.autoItems[0]?.evidenceSpanIds).toEqual(["span_1", "span_2"]);
  });

  it("organizes the Stable v1.4.0 fixture into meaningful sections without losing beginning, middle, or end evidence", async () => {
    const fixtureUrl = new URL("../../../evals/fixtures/memory-generation/stable-v1.4.0-release.txt", import.meta.url);
    const text = readFileSync(fileURLToPath(fixtureUrl), "utf8");
    let nextId = 0;
    const bundle = await createTextEvidenceBundle({
      sourceVersionId: "srcv_stable_v1_4",
      text,
      newSpanId: () => `release_${++nextId}`,
    });
    expect(decideMemorySectioning(bundle.evidenceSpans).shouldSection).toBe(true);

    const expectedTitles = [
      "Stable v1.4.0 release overview",
      "Optimistic Parallel Execution (OPE)",
      "Selective RecheckTx",
      "MemIAVL storage",
      "2D Nonce and Guaranteed Blockspace",
      "Compatibility and rollout",
      "Deferred work and known limits",
    ];
    const headingIndexes = expectedTitles.map((title) => {
      const index = bundle.evidenceSpans.findIndex((span) => span.text === `# ${title}`);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    });
    const plan = {
      sections: expectedTitles.map((title, index) => ({
        temporaryId: `fixture_${index + 1}`,
        title,
        startEvidenceSpanId: bundle.evidenceSpans[headingIndexes[index]!]!.id,
        endEvidenceSpanId: bundle.evidenceSpans[(headingIndexes[index + 1] ?? bundle.evidenceSpans.length) - 1]!.id,
      })),
    };
    expect(validateMemorySectionPlan({
      plan,
      evidenceSpans: bundle.evidenceSpans,
      maxChars: 8_000,
      maxSections: 50,
    }).ok).toBe(true);

    const covered = plan.sections.flatMap((section) => evidenceSpansForSection(section, bundle.evidenceSpans));
    expect(covered.map((span) => span.id)).toEqual(bundle.evidenceSpans.map((span) => span.id));
    const citedFacts = [
      "coordinated protocol release",
      "MemIAVL becomes the recommended state-store path",
      "This release does not enable arbitrary application-defined reserved lanes",
    ].map((phrase) => {
      const span = covered.find((candidate) => candidate.text.includes(phrase));
      expect(span).toBeDefined();
      return { statement: phrase, evidenceSpanIds: [span!.id] };
    });
    const citedIndexes = citedFacts.map((fact) => bundle.evidenceSpans.findIndex((span) => span.id === fact.evidenceSpanIds[0]));
    expect(citedIndexes[0]).toBeGreaterThanOrEqual(0);
    expect(citedIndexes[0]!).toBeLessThan(citedIndexes[1]!);
    expect(citedIndexes[1]!).toBeLessThan(citedIndexes[2]!);
    expect(citedFacts[0]!.evidenceSpanIds[0]).not.toBe(citedFacts[1]!.evidenceSpanIds[0]);
    expect(citedFacts[1]!.evidenceSpanIds[0]).not.toBe(citedFacts[2]!.evidenceSpanIds[0]);
  });
});
