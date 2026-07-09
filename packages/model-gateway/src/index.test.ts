import { describe, expect, it } from "vitest";
import {
  OpenRouterEmbeddingModel,
  OpenRouterGroundedAnswerModel,
  OpenRouterInitiativeBriefDraftModel,
  OpenRouterMemoryGenerationModel,
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
          response_format?: { json_schema?: { name?: string } };
          messages?: Array<{ content: string }>;
        };
        expect(body.response_format?.json_schema?.name).toBe("grounded_answer");
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

describe("OpenRouterInitiativeBriefDraftModel", () => {
  it("generates a structured initiative brief draft", async () => {
    const model = new OpenRouterInitiativeBriefDraftModel({
      apiKey: "test-key",
      baseUrl: "https://openrouter.test/api/v1",
      model: "moonshotai/kimi-k2.7-code",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string } };
          messages?: Array<{ content: string }>;
        };

        expect(body.response_format?.json_schema?.name).toBe("initiative_brief_draft");
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
