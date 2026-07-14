import { describe, expect, it } from "vitest";
import {
  CLAIM_TYPES,
  EPISTEMIC_STATUSES,
} from "@distillery/contracts";
import {
  groundedAnswerSystemPrompt,
  initiativeBriefDraftSystemPrompt,
  memoryCandidateVerifierSystemPrompt,
  memoryConnectionScorerSystemPrompt,
  memoryGenerationSystemPrompt,
  renderMemoryCandidateVerificationInputForModel,
  renderMemoryConnectionScoringInputForModel,
  renderGroundedAnswerInputForModel,
  renderInitiativeBriefDraftInputForModel,
  renderMemoryGenerationInputForModel,
  renderRetrievalRerankInputForModel,
  renderSynthesisIntent,
} from "./index";

describe("@distillery/prompts", () => {
  it("exports non-empty system prompts with core guardrails", () => {
    expect(memoryGenerationSystemPrompt()).toContain("Extract every plausible source-backed memory candidate");
    expect(memoryGenerationSystemPrompt()).toContain("One evidence span may produce multiple candidates");
    expect(memoryGenerationSystemPrompt()).toContain("Every item must cite one or more supplied evidenceSpanIds exactly.");
    expect(memoryGenerationSystemPrompt()).toContain("Never emit entities like: the, a, an, in, no, yes");
    expect(memoryGenerationSystemPrompt()).toContain("If no meaningful entity exists, return an empty entities array.");
    expect(memoryCandidateVerifierSystemPrompt()).toContain("verified, needs_review, corrected, duplicate, or unsupported");
    expect(memoryCandidateVerifierSystemPrompt()).toContain("Use needs_review when");
    expect(memoryConnectionScorerSystemPrompt()).toContain("direct, supporting, contextual, or weak");
    expect(memoryConnectionScorerSystemPrompt()).toContain("weak for exploratory bridges");
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

  it("renders memory verifier and connection scorer inputs with candidate IDs", () => {
    const evidence = [{
      id: "ev_1",
      sourceVersionId: "srcv_1",
      startLine: 1,
      endLine: 1,
      startChar: 0,
      endChar: 39,
      text: "Docs ownership blocks launch readiness.",
    }];
    const candidate = {
      temporaryId: "cand_1",
      claimType: "dependency" as const,
      statement: "Docs ownership blocks launch readiness.",
      evidenceSpanIds: ["ev_1"],
      epistemicStatus: "reported" as const,
      qualifiers: {},
      stableDomainTags: [],
      entities: [],
      relations: [],
      schemas: [],
    };
    const verification = renderMemoryCandidateVerificationInputForModel({
      evidenceSpans: evidence,
      candidates: [candidate],
      negativeExpectations: ["Do not invent approval."],
    });
    const connection = renderMemoryConnectionScoringInputForModel({
      memory: [{
        memoryItem: {
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
        evidenceSpans: evidence,
      }],
      candidates: [{
        id: "ccand_1",
        fromClaimId: "mem_1",
        toClaimId: "mem_1",
        connectionType: "related_context",
        confidence: 0.2,
        scoreComponents: { source_context_overlap: 1 },
        evidenceSpanIds: ["ev_1"],
        rationale: "test",
      }],
    });

    expect(verification).toContain('temporaryId="cand_1"');
    expect(verification).toContain("Do not invent approval.");
    expect(connection).toContain('connectionCandidate id="ccand_1"');
    expect(connection).toContain("source_context_overlap");
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

  it("compacts retrieval rerank input to keep model latency bounded", () => {
    const longStatement = "Statement detail ".repeat(100);
    const longEvidence = "Evidence detail ".repeat(100);
    const rendered = renderRetrievalRerankInputForModel({
      question: "What blocks launch?",
      profile: "ask",
      candidates: [{
        claimId: "mem_1",
        statement: longStatement,
        evidenceSpanTexts: [longEvidence, longEvidence, "third evidence should not be sent"],
        graphScore: 0.8,
        vectorScore: 0.7,
        sparseScore: 0.2,
        conflictWarningCount: 0,
      }],
    });

    expect(rendered).toContain('<candidate claimId="mem_1"');
    expect(rendered).toContain("[truncated]");
    expect(rendered).not.toContain("third evidence should not be sent");
    expect(rendered.length).toBeLessThan(1_500);
  });
});
