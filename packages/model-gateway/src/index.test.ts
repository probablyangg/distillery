import { describe, expect, it } from "vitest";
import {
  OpenRouterEmbeddingModel,
  OpenRouterGroundedAnswerModel,
  OpenRouterInitiativeBriefDraftModel,
  OpenRouterMemoryCandidateVerifierModel,
  OpenRouterMemoryConnectionScorerModel,
  OpenRouterMemoryGenerationModel,
  OpenRouterMemorySectionPlannerModel,
  OpenRouterRetrievalRerankerModel,
} from "./index";

describe("OpenRouterMemoryGenerationModel", () => {
  it("falls back to the next configured model when the primary fails", async () => {
    const requestedModels: string[] = [];
    const model = new OpenRouterMemoryGenerationModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fallbackModels: ["~moonshotai/kimi-latest"],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          response_format?: { json_schema?: { schema?: { properties?: { items?: { items?: { required?: string[]; properties?: Record<string, unknown> } } } } } };
        };
        requestedModels.push(body.model);
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        const itemSchema = body.response_format?.json_schema?.schema?.properties?.items?.items;
        expect(itemSchema?.required).toContain("claimType");
        expect(itemSchema?.required).not.toContain("type");
        expect(itemSchema?.properties).toHaveProperty("entities");
        expect(itemSchema?.properties).toHaveProperty("relations");
        expect(itemSchema?.properties).toHaveProperty("schemas");

        if (body.model === "moonshotai/kimi-k2.7-code") {
          return new Response("upstream timeout", { status: 504 });
        }

        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ items: [] }),
              },
            },
          ],
        });
      },
    });

    const result = await model.generateMemory({
      ingestionId: "ing_1",
      sourceVersionId: "srcv_1",
      evidenceSpans: [
        {
          id: "ev_1",
          sourceVersionId: "srcv_1",
          startLine: 1,
          endLine: 1,
          startChar: 0,
          endChar: 12,
          text: "Stable note.",
        },
      ],
    });

    expect(result.model).toBe("~moonshotai/kimi-latest");
    expect(result.parsed.items).toEqual([]);
    expect(requestedModels).toEqual(["moonshotai/kimi-k2.7-code", "~moonshotai/kimi-latest"]);
  });

  it("repairs malformed JSON syntax before applying the memory schema", async () => {
    const model = new OpenRouterMemoryGenerationModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: `{
                  items: [{
                    temporaryId: "m1",
                    claimType: "dependency",
                    statement: "Stable checkout depends on relayer review.",
                    evidenceSpanIds: ["ev_1"],
                    epistemicStatus: "reported",
                    qualifiers: {},
                    stableDomainTags: ["checkout"],
                  entities: [],
                  relations: [],
                  schemas: [],
                  }]
                }`,
              },
            },
          ],
        }),
    });

    const result = await model.generateMemory({
      ingestionId: "ing_1",
      sourceVersionId: "srcv_1",
      evidenceSpans: [
        {
          id: "ev_1",
          sourceVersionId: "srcv_1",
          startLine: 1,
          endLine: 1,
          startChar: 0,
          endChar: 12,
          text: "Stable note.",
        },
      ],
    });

    expect(result.parsed.items[0]?.statement).toBe("Stable checkout depends on relayer review.");
  });
});

describe("OpenRouterMemorySectionPlannerModel", () => {
  it("returns a strict ordered section plan without rewritten content", async () => {
    const model = new OpenRouterMemorySectionPlannerModel({
      apiKey: "test-key", baseUrl: "https://openrouter.test/api/v1", model: "planner-model",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }>; response_format?: { json_schema?: { name?: string } } };
        expect(body.response_format?.json_schema?.name).toBe("memory_section_plan");
        expect(body.messages?.[1]?.content).toContain('<evidence id="ev_1"');
        return Response.json({ choices: [{ message: { content: JSON.stringify({ sections: [
          { temporaryId: "overview", title: "Overview", startEvidenceSpanId: "ev_1", endEvidenceSpanId: "ev_1" },
          { temporaryId: "compat", title: "Compatibility", startEvidenceSpanId: "ev_2", endEvidenceSpanId: "ev_2" },
        ] }) } }] });
      },
    });
    const response = await model.planMemorySections({
      sourceVersionId: "srcv_1", evidenceSpans: [testEvidenceSpan("ev_1"), testEvidenceSpan("ev_2", 20)],
      targetChars: 5_000, maxChars: 8_000, maxSections: 50,
    });
    expect(response.parsed.sections.map((section) => section.title)).toEqual(["Overview", "Compatibility"]);
  });

  it("retries an invariant-invalid plan on the configured fallback model", async () => {
    const calls: string[] = [];
    const model = new OpenRouterMemorySectionPlannerModel({
      apiKey: "test-key", baseUrl: "https://openrouter.test/api/v1", model: "primary", fallbackModels: ["fallback"],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        calls.push(body.model);
        const sections = body.model === "primary"
          ? [{ temporaryId: "bad", title: "Bad", startEvidenceSpanId: "missing", endEvidenceSpanId: "ev_2" }]
          : [{ temporaryId: "good", title: "All", startEvidenceSpanId: "ev_1", endEvidenceSpanId: "ev_2" }];
        return Response.json({ choices: [{ message: { content: JSON.stringify({ sections }) } }] });
      },
    });
    await model.planMemorySections({
      sourceVersionId: "srcv_1", evidenceSpans: [testEvidenceSpan("ev_1"), testEvidenceSpan("ev_2", 20)],
      targetChars: 5_000, maxChars: 8_000, maxSections: 50,
    });
    expect(calls).toEqual(["primary", "fallback"]);
  });
});

describe("OpenRouterMemoryCandidateVerifierModel", () => {
  it("verifies candidates with structured output", async () => {
    const model = new OpenRouterMemoryCandidateVerifierModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "verifier-model",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string; schema?: unknown } };
          messages?: Array<{ content: string }>;
        };
        expect(body.response_format?.json_schema?.name).toBe("memory_candidate_verification");
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        expect(body.messages?.[1]?.content).toContain('temporaryId="cand_1"');
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                decisions: [{
                  temporaryId: "cand_1",
                  decision: "verified",
                  rationale: "Supported by evidence.",
                  correctedItem: null,
                }],
              }),
            },
          }],
        });
      },
    });

    const response = await model.verifyMemoryCandidates({
      evidenceSpans: [testEvidenceSpan()],
      candidates: [testGeneratedMemoryItem("cand_1")],
    });

    expect(response.model).toBe("verifier-model");
    expect(response.decisions[0]).toMatchObject({
      temporaryId: "cand_1",
      decision: "verified",
    });
  });

  it("preserves original qualifiers when a candidate is corrected", async () => {
    const candidate = {
      ...testGeneratedMemoryItem("cand_1"),
      qualifiers: { extractionFallback: true },
    };
    const model = new OpenRouterMemoryCandidateVerifierModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "verifier-model",
      fetchImpl: async () =>
        Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                decisions: [{
                  temporaryId: "cand_1",
                  decision: "corrected",
                  rationale: "The evidence supports narrower wording.",
                  correctedItem: {
                    ...candidate,
                    statement: "Docs ownership is reported as a launch dependency.",
                    qualifiers: {},
                  },
                }],
              }),
            },
          }],
        }),
    });

    const response = await model.verifyMemoryCandidates({
      evidenceSpans: [testEvidenceSpan()],
      candidates: [candidate],
    });

    expect(response.decisions[0]?.correctedItem?.qualifiers).toEqual({ extractionFallback: true });
  });
});

describe("OpenRouterMemoryConnectionScorerModel", () => {
  it("scores memory connection candidates with tier metadata", async () => {
    const model = new OpenRouterMemoryConnectionScorerModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "connection-model",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string; schema?: unknown } };
          messages?: Array<{ content: string }>;
        };
        expect(body.response_format?.json_schema?.name).toBe("memory_connection_scoring");
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        expect(body.messages?.[1]?.content).toContain('connectionCandidate id="ccand_1"');
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                decisions: [{
                  candidateId: "ccand_1",
                  tier: "direct",
                  connectionType: "depends_on",
                  connectionReason: "explicit_dependency",
                  confidence: 0.9,
                  rationale: "Direct launch dependency.",
                  evidenceSpanIds: ["ev_1"],
                  reviewRequired: false,
                }],
              }),
            },
          }],
        });
      },
    });

    const response = await model.scoreMemoryConnections({
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
        evidenceSpans: [testEvidenceSpan()],
      }],
      candidates: [{
        id: "ccand_1",
        fromClaimId: "mem_1",
        toClaimId: "mem_1",
        connectionType: "related_context",
        confidence: 0.3,
        scoreComponents: { source_context_overlap: 1 },
        evidenceSpanIds: ["ev_1"],
        rationale: "test",
      }],
    });

    expect(response.model).toBe("connection-model");
    expect(response.decisions[0]).toMatchObject({
      candidateId: "ccand_1",
      tier: "direct",
      connectionReason: "explicit_dependency",
    });
  });
});

describe("OpenRouterEmbeddingModel", () => {
  it("calls OpenRouter embeddings and validates dimensions", async () => {
    const model = new OpenRouterEmbeddingModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "google/gemini-embedding-001",
      dimensions: 3,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions: number };
        expect(body.model).toBe("google/gemini-embedding-001");
        expect(body.input).toEqual(["Docs block launch."]);
        expect(body.dimensions).toBe(3);
        return Response.json({
          model: "google/gemini-embedding-001",
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        });
      },
    });

    const result = await model.embed({
      targetType: "claim",
      input: ["Docs block launch."],
    });

    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("records the configured embedding model even when provider returns an alias", async () => {
    const model = new OpenRouterEmbeddingModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "google/gemini-embedding-001",
      dimensions: 3,
      fetchImpl: async () =>
        Response.json({
          model: "gemini-embedding-001",
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
    });

    const result = await model.embed({
      targetType: "claim",
      input: ["Docs block launch."],
    });

    expect(result.model).toBe("google/gemini-embedding-001");
  });

  it("rejects embedding dimension mismatches", async () => {
    const model = new OpenRouterEmbeddingModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "google/gemini-embedding-001",
      dimensions: 3,
      fetchImpl: async () =>
        Response.json({
          data: [{ embedding: [0.1, 0.2] }],
        }),
    });

    await expect(model.embed({ targetType: "claim", input: ["x"] }))
      .rejects.toThrow("expected 3");
  });
});

describe("OpenRouterGroundedAnswerModel", () => {
  it("generates and validates grounded citations", async () => {
    const model = new OpenRouterGroundedAnswerModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string; schema?: unknown } };
          messages?: Array<{ content: string }>;
        };
        expect(body.response_format?.json_schema?.name).toBe("grounded_answer");
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        expect(body.messages?.[1]?.content).toContain("claim id=\"mem_1\"");
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                answer: "Docs ownership blocks launch readiness. [ev_1]",
                citations: [{ evidenceSpanId: "ev_1", claimIds: ["mem_1"] }],
                usedClaimIds: ["mem_1"],
                usedEvidenceSpanIds: ["ev_1"],
                warnings: [],
                gap: null,
              }),
            },
          }],
        });
      },
    });

    const result = await model.generateGroundedAnswer({
      question: "What blocks launch?",
      claims: [{
        rank: 1,
        graphScore: 1,
        lexicalScore: 1,
        vectorScore: 0,
        connectionIds: [],
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
          endChar: 37,
          text: "Docs ownership blocks launch readiness.",
        }],
      }],
      evidenceSpans: [{
        id: "ev_1",
        sourceVersionId: "srcv_1",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 37,
        text: "Docs ownership blocks launch readiness.",
      }],
      conflicts: [],
    });

    expect(result.citations[0]?.evidenceSpanId).toBe("ev_1");
    expect(result.model).toBe("moonshotai/kimi-k2.7-code");
  });

  it("rejects unavailable citations", async () => {
    const model = new OpenRouterGroundedAnswerModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async () =>
        Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                answer: "Unsupported.",
                citations: [{ evidenceSpanId: "ev_missing", claimIds: ["mem_1"] }],
                usedClaimIds: ["mem_1"],
                usedEvidenceSpanIds: ["ev_missing"],
                warnings: [],
              }),
            },
          }],
        }),
    });

    await expect(model.generateGroundedAnswer({
      question: "What blocks launch?",
      claims: [],
      evidenceSpans: [],
      conflicts: [],
    })).rejects.toThrow("unavailable");
  });
});

describe("OpenRouterRetrievalRerankerModel", () => {
  it("reranks supplied claim IDs", async () => {
    const model = new OpenRouterRetrievalRerankerModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string; schema?: { required?: string[] } } };
          messages?: Array<{ content: string }>;
        };
        expect(body.response_format?.json_schema?.name).toBe("retrieval_rerank");
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        expect(body.response_format?.json_schema?.schema?.required).toEqual(["rankedClaimIds"]);
        expect(body.messages?.[1]?.content).toContain("claimId=\"mem_2\"");
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                rankedClaimIds: ["mem_2", "mem_1"],
              }),
            },
          }],
        });
      },
    });

    const result = await model.rerankRetrieval({
      question: "What blocks launch?",
      profile: "ask",
      candidates: [
        {
          claimId: "mem_1",
          statement: "Relayer review is related to launch.",
          evidenceSpanTexts: ["Relayer review is related to launch."],
          graphScore: 0.3,
          vectorScore: 0.4,
          sparseScore: 0,
          conflictWarningCount: 0,
        },
        {
          claimId: "mem_2",
          statement: "Relayer review blocks launch.",
          evidenceSpanTexts: ["Relayer review blocks launch."],
          graphScore: 0.2,
          vectorScore: 0.5,
          sparseScore: 1,
          conflictWarningCount: 0,
        },
      ],
    });

    expect(result.rankedClaimIds).toEqual(["mem_2", "mem_1"]);
    expect(result.rationaleByClaimId).toEqual({});
    expect(result.model).toBe("moonshotai/kimi-k2.7-code");
  });

  it("rejects unknown reranked claim IDs", async () => {
    const model = new OpenRouterRetrievalRerankerModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async () =>
        Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                rankedClaimIds: ["mem_missing"],
                rationaleByClaimId: {},
              }),
            },
          }],
        }),
    });

    await expect(model.rerankRetrieval({
      question: "What blocks launch?",
      profile: "ask",
      candidates: [{
        claimId: "mem_1",
        statement: "Relayer review blocks launch.",
        evidenceSpanTexts: ["Relayer review blocks launch."],
        graphScore: 1,
        vectorScore: 1,
        sparseScore: 0,
        conflictWarningCount: 0,
      }],
    })).rejects.toThrow("unknown claim ID");
  });
});

describe("OpenRouterInitiativeBriefDraftModel", () => {
  it("generates a structured initiative brief draft", async () => {
    const model = new OpenRouterInitiativeBriefDraftModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string; schema?: unknown } };
          messages?: Array<{ content: string }>;
        };

        expect(body.response_format?.json_schema?.name).toBe("initiative_brief_draft");
        expectPortableStructuredOutputSchema(body.response_format?.json_schema?.schema);
        expect(body.messages?.[1]?.content).toContain("mem_1");
        expect(body.messages?.[1]?.content).toContain("ev_1");

        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "Relayer reliability launch gate",
                  problem: "Stable cannot safely message checkout until relayer reliability is proven.",
                  proposal: "Treat relayer reliability as a launch gate for checkout messaging.",
                  successMetric: "Relayer success rate remains above the internal threshold for the agreed window.",
                  risksAndDependencies: "Requires protocol and GTM alignment.",
                  memoryItemIds: ["mem_1"],
                  evidenceSpanIds: ["ev_1"],
                }),
              },
            },
          ],
        });
      },
    });

    const result = await model.generateInitiativeBriefDraft({
      intent: "Focus on launch readiness.",
      memoryItems: [
        {
          id: "mem_1",
          ingestionId: "ing_1",
          sourceVersionId: "srcv_1",
          claimType: "dependency",
          statement: "Stable checkout depends on relayer reliability before public launch.",
          evidenceSpanIds: ["ev_1"],
          epistemicStatus: "reported",
          qualifiers: {},
          stableDomainTags: ["checkout"],
          entities: [],
          relations: [],
          schemas: [],
          reviewState: "confirmed",
        },
      ],
      evidenceSpans: [
        {
          id: "ev_1",
          sourceVersionId: "srcv_1",
          startLine: 1,
          endLine: 1,
          startChar: 0,
          endChar: 72,
          text: "Checkout launch depends on relayer reliability before we message it publicly.",
        },
      ],
    });

    expect(result.model).toBe("moonshotai/kimi-k2.7-code");
    expect(result.parsed.title).toBe("Relayer reliability launch gate");
    expect(result.parsed.memoryItemIds).toEqual(["mem_1"]);
    expect(result.parsed.evidenceSpanIds).toEqual(["ev_1"]);
  });
});

function testEvidenceSpan(id = "ev_1", startChar = 0) {
  return {
    id,
    sourceVersionId: "srcv_1",
    startLine: 1,
    endLine: 1,
    startChar,
    endChar: startChar + 39,
    text: "Docs ownership blocks launch readiness.",
  };
}

function testGeneratedMemoryItem(temporaryId: string) {
  return {
    temporaryId,
    claimType: "dependency" as const,
    statement: "Docs ownership blocks launch readiness.",
    evidenceSpanIds: ["ev_1"],
    epistemicStatus: "reported" as const,
    qualifiers: {},
    stableDomainTags: ["docs"],
    entities: [],
    relations: [],
    schemas: [],
  };
}

function expectPortableStructuredOutputSchema(schema: unknown): void {
  expect(schema).toBeTypeOf("object");
  expect(schema).not.toBeNull();
  const record = schema as Record<string, unknown>;
  for (const unsupportedKeyword of ["minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength"]) {
    expect(record, `unsupported structured-output keyword: ${unsupportedKeyword}`).not.toHaveProperty(unsupportedKeyword);
  }

  if (record.type === "object") {
    expect(record.additionalProperties).toBe(false);
    const properties = (record.properties ?? {}) as Record<string, unknown>;
    expect([...(record.required as string[] ?? [])].sort()).toEqual(Object.keys(properties).sort());
    for (const propertySchema of Object.values(properties)) expectPortableStructuredOutputSchema(propertySchema);
  }

  if (record.items) expectPortableStructuredOutputSchema(record.items);
  if (Array.isArray(record.anyOf)) {
    for (const option of record.anyOf) expectPortableStructuredOutputSchema(option);
  }
}
