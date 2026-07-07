import { describe, expect, it } from "vitest";
import { buildDeterministicCitedAnswer } from "./index";

describe("buildDeterministicCitedAnswer", () => {
  it("returns explicit gap when no evidence matches", () => {
    const answer = buildDeterministicCitedAnswer({
      question: "What do we know about Stable Pay rewards?",
      matches: [],
    });

    expect(answer.gap).toContain("No active memory matched");
    expect(answer.evidenceSpanIds).toEqual([]);
  });

  it("returns only cited statements when matches exist", () => {
    const answer = buildDeterministicCitedAnswer({
      question: "What blocks gas waiver?",
      matches: [
        {
          rank: 1,
          memoryItem: {
            id: "mem_1",
            ingestionId: "ing_1",
            sourceVersionId: "srcv_1",
            claimType: "dependency",
            statement: "Public gas waiver messaging requires governance approval.",
            evidenceSpanIds: ["ev_1"],
            epistemicStatus: "reported",
            stableDomainTags: ["gasless_ux"],
            entities: [],
            relations: [],
            schemas: [],
            qualifiers: {},
            reviewState: "confirmed",
          },
          evidenceSpans: [
            {
              id: "ev_1",
              sourceVersionId: "srcv_1",
              startLine: 1,
              endLine: 1,
              startChar: 0,
              endChar: 61,
              text: "Governance approval is a dependency before we promise this publicly.",
            },
          ],
        },
      ],
    });

    expect(answer.gap).toBeUndefined();
    expect(answer.answer).toContain("[ev_1; confirmed]");
    expect(answer.citations[0]?.text).toContain("Governance approval");
  });
});
