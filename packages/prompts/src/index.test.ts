import { describe, expect, it } from "vitest";
import {
  CLAIM_TYPES,
  EPISTEMIC_STATUSES,
} from "@distillery/contracts";
import {
  groundedAnswerSystemPrompt,
  initiativeBriefDraftSystemPrompt,
  memoryGenerationSystemPrompt,
  renderGroundedAnswerInputForModel,
  renderInitiativeBriefDraftInputForModel,
  renderMemoryGenerationInputForModel,
  renderSynthesisIntent,
} from "./index";

describe("@distillery/prompts", () => {
  it("exports non-empty system prompts with core guardrails", () => {
    expect(memoryGenerationSystemPrompt()).toContain("Extract only source-backed memory items");
    expect(memoryGenerationSystemPrompt()).toContain("Every item must cite one or more supplied evidenceSpanIds exactly.");
    expect(memoryGenerationSystemPrompt()).toContain("Never emit entities like: the, a, an, in, no, yes");
    expect(memoryGenerationSystemPrompt()).toContain("If no meaningful entity exists, return an empty entities array.");
    expect(initiativeBriefDraftSystemPrompt()).toContain("Do not invent customers, metrics, approvals, owners, dependencies, or timelines.");
    expect(initiativeBriefDraftSystemPrompt()).toContain("Use every selected memoryItemId and every selected evidenceSpanId exactly as supplied.");
    expect(groundedAnswerSystemPrompt()).toContain("Use only the supplied claims, evidence, and conflicts.");
    expect(groundedAnswerSystemPrompt()).toContain("Cite only supplied evidenceSpanIds and claim IDs.");
  });

  it("includes current claim type and epistemic status enums in the memory prompt", () => {
    const prompt = memoryGenerationSystemPrompt();

    for (const claimType of CLAIM_TYPES) {
      expect(prompt).toContain(claimType);
    }
    for (const epistemicStatus of EPISTEMIC_STATUSES) {
      expect(prompt).toContain(epistemicStatus);
    }
  });

  it("renders memory generation evidence with citation-bearing fields", () => {
    const rendered = renderMemoryGenerationInputForModel({
      evidenceSpans: [{
        id: "ev_1",
        sourceVersionId: "srcv_1",
        startLine: 3,
        endLine: 4,
        startChar: 10,
        endChar: 48,
        text: "Docs ownership blocks launch readiness.",
      }],
    });

    expect(rendered).toContain('<evidence id="ev_1" lines="3-4">');
    expect(rendered).toContain("Docs ownership blocks launch readiness.");
  });

  it("renders grounded answer input with claim, evidence, and conflict IDs", () => {
    const rendered = renderGroundedAnswerInputForModel({
      question: "What blocks launch?",
      claims: [{
        rank: 1,
        graphScore: 1,
        lexicalScore: 1,
        vectorScore: 0,
        connectionIds: ["conn_1"],
        claim: {
          id: "mem_1",
          ingestionId: "ing_1",
          sourceVersionId: "srcv_1",
          claimType: "dependency",
          statement: "Docs ownership blocks launch readiness.",
          evidenceSpanIds: ["ev_1"],
          epistemicStatus: "reported",
          qualifiers: {},
          stableDomainTags: [],
          entities: [],
          relations: [],
          schemas: [],
          reviewState: "confirmed",
        },
        evidenceSpans: [{
          id: "ev_1",
          sourceVersionId: "srcv_1",
          startLine: 1,
          endLine: 1,
          startChar: 0,
          endChar: 39,
          text: "Docs ownership blocks launch readiness.",
        }],
      }],
      evidenceSpans: [{
        id: "ev_1",
        sourceVersionId: "srcv_1",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 39,
        text: "Docs ownership blocks launch readiness.",
      }],
      conflicts: [{
        id: "conflict_1",
        tenantId: "stable",
        conflictType: "dependency",
        severity: "warning",
        status: "open",
        summary: "Launch blocker disagreement.",
        members: [{
          conflictGroupId: "conflict_1",
          claimId: "mem_1",
          role: "supports",
          evidenceSpanIds: ["ev_1"],
        }],
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      }],
    });

    expect(rendered).toContain("<question>What blocks launch?</question>");
    expect(rendered).toContain('<claim id="mem_1"');
    expect(rendered).toContain('<evidence id="ev_1" lines="1-1">');
    expect(rendered).toContain('<conflict id="conflict_1"');
  });

  it("renders initiative brief input and synthesis intent with selected IDs", () => {
    const rendered = renderInitiativeBriefDraftInputForModel({
      intent: "Focus on launch readiness.",
      memoryItems: [{
        id: "mem_1",
        ingestionId: "ing_1",
        sourceVersionId: "srcv_1",
        claimType: "dependency",
        statement: "Docs ownership blocks launch readiness.",
        evidenceSpanIds: ["ev_1"],
        epistemicStatus: "reported",
        qualifiers: {},
        stableDomainTags: [],
        entities: [],
        relations: [],
        schemas: [],
        reviewState: "confirmed",
      }],
      evidenceSpans: [{
        id: "ev_1",
        sourceVersionId: "srcv_1",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 39,
        text: "Docs ownership blocks launch readiness.",
      }],
    });
    const intent = renderSynthesisIntent({
      seedMemoryItemIds: ["mem_1"],
      connections: [{ reason: "shared_entity", fromMemoryItemId: "mem_1", toMemoryItemId: "mem_2" }],
      readiness: { warningReasons: ["conflict_open"] },
    });

    expect(rendered).toContain("<intent>Focus on launch readiness.</intent>");
    expect(rendered).toContain('<memory id="mem_1"');
    expect(rendered).toContain('<evidence id="ev_1" lines="1-1">');
    expect(intent).toContain("Seed memory: mem_1");
    expect(intent).toContain("shared_entity(mem_1->mem_2)");
    expect(intent).toContain("Warnings to surface: conflict_open");
  });
});
