import type {
  ConflictGroup,
  EmbeddingRequest,
  EmbeddingResponse,
  EvidenceSpan,
  GeneratedMemoryBatch,
  GeneratedMemoryItem,
  GraphRetrievalClaim,
  GroundedAnswerResponse,
  InitiativeBriefDraft,
  MemoryItem,
  MemoryWithEvidence,
  MemorySectionPlan,
  SlackChannelProfile,
  SlackConversationClassification,
  SlackContextRole,
  SlackNearbyContextSelection,
} from "@distillery/contracts";
import {
  CLAIM_TYPES,
  CLAIM_CONNECTION_TYPES,
  EmbeddingRequestSchema,
  EmbeddingResponseSchema,
  GeneratedMemoryBatchSchema,
  GeneratedMemoryItemSchema,
  GroundedAnswerResponseSchema,
  InitiativeBriefDraftSchema,
  EPISTEMIC_STATUSES,
  MEMORY_SCHEMA_STATUSES,
  MemorySectionPlanSchema,
  SlackConversationClassificationSchema,
  SlackNearbyContextSelectionSchema,
} from "@distillery/contracts";
import {
  groundedAnswerSystemPrompt,
  initiativeBriefDraftSystemPrompt,
  memoryCandidateVerifierSystemPrompt,
  memoryConnectionScorerSystemPrompt,
  memoryGenerationSystemPrompt,
  memorySectionPlanningSystemPrompt,
  renderMemoryCandidateVerificationInputForModel,
  renderMemoryConnectionScoringInputForModel,
  renderRetrievalRerankInputForModel,
  renderGroundedAnswerInputForModel,
  renderInitiativeBriefDraftInputForModel,
  renderMemoryGenerationInputForModel,
  renderMemorySectionPlanningInputForModel,
  retrievalRerankSystemPrompt,
  renderSlackClassificationInputForModel,
  renderSlackNearbySelectionInputForModel,
  slackClassificationSystemPrompt,
  slackNearbySelectionSystemPrompt,
} from "@distillery/prompts";
import { jsonrepair } from "jsonrepair";

export type MemoryGenerationRequest = {
  ingestionId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
  slackContext?: {
    selectedMessageTimestamp: string;
    channelProfile: SlackChannelProfile;
    classification: SlackConversationClassification;
    items: Array<{
      role: SlackContextRole;
      messageTimestamp?: string;
      authorId?: string;
      authorLabel?: string;
      occurredAt: string;
      permalink?: string;
      evidenceSpanIds: string[];
    }>;
  };
};

export type SlackNearbySelectionRequest = {
  selectedMessage: { messageId: string; text: string };
  candidates: Array<{ messageId: string; text: string; authorLabel: string; occurredAt: string }>;
};

export type SlackNearbySelectionResponse = {
  parsed: SlackNearbyContextSelection;
  raw: unknown;
  model: string;
};

export type SlackClassificationRequest = {
  channelProfile: SlackChannelProfile;
  selectedMessageTimestamp: string;
  items: Array<{
    role: SlackContextRole;
    messageTimestamp?: string;
    authorLabel?: string;
    occurredAt: string;
    text: string;
  }>;
};

export type SlackClassificationResponse = {
  parsed: SlackConversationClassification;
  raw: unknown;
  model: string;
};

export type MemoryGenerationResponse = {
  parsed: GeneratedMemoryBatch;
  raw: unknown;
  model: string;
};

export type MemorySectionPlanningRequest = {
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
  targetChars: number;
  maxChars: number;
  maxSections: number;
};

export type MemorySectionPlanningResponse = {
  parsed: MemorySectionPlan;
  raw: unknown;
  model: string;
};

export type MemoryCandidateVerificationDecision =
  | "verified"
  | "needs_review"
  | "corrected"
  | "duplicate"
  | "unsupported";

export type MemoryCandidateVerificationRequest = {
  evidenceSpans: EvidenceSpan[];
  candidates: GeneratedMemoryItem[];
  negativeExpectations?: string[];
};

export type MemoryCandidateVerificationItem = {
  temporaryId: string;
  decision: MemoryCandidateVerificationDecision;
  rationale: string;
  correctedItem?: GeneratedMemoryItem;
};

export type MemoryCandidateVerificationResponse = {
  decisions: MemoryCandidateVerificationItem[];
  raw: unknown;
  model: string;
};

export type MemoryConnectionTier = "direct" | "supporting" | "contextual" | "weak";

export type MemoryConnectionScoringCandidate = {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  connectionType: string;
  confidence: number;
  scoreComponents: Record<string, unknown>;
  evidenceSpanIds: string[];
  rationale: string;
};

export type MemoryConnectionScoringRequest = {
  memory: MemoryWithEvidence[];
  candidates: MemoryConnectionScoringCandidate[];
};

export type MemoryConnectionScoringDecision = {
  candidateId: string;
  tier: MemoryConnectionTier;
  connectionType: string;
  connectionReason: string;
  confidence: number;
  rationale: string;
  evidenceSpanIds: string[];
  reviewRequired: boolean;
};

export type MemoryConnectionScoringResponse = {
  decisions: MemoryConnectionScoringDecision[];
  raw: unknown;
  model: string;
};

export type InitiativeBriefDraftRequest = {
  memoryItems: MemoryItem[];
  evidenceSpans: EvidenceSpan[];
  intent?: string;
};

export type InitiativeBriefDraftResponse = {
  parsed: InitiativeBriefDraft;
  raw: unknown;
  model: string;
};

export type GroundedAnswerRequest = {
  question: string;
  claims: GraphRetrievalClaim[];
  evidenceSpans: EvidenceSpan[];
  conflicts: ConflictGroup[];
};

export interface MemoryGenerationModel {
  generateMemory(request: MemoryGenerationRequest): Promise<MemoryGenerationResponse>;
}

export interface MemorySectionPlannerModel {
  planMemorySections(request: MemorySectionPlanningRequest): Promise<MemorySectionPlanningResponse>;
}

export interface MemoryCandidateVerifierModel {
  verifyMemoryCandidates(request: MemoryCandidateVerificationRequest): Promise<MemoryCandidateVerificationResponse>;
}

export interface MemoryConnectionScorerModel {
  scoreMemoryConnections(request: MemoryConnectionScoringRequest): Promise<MemoryConnectionScoringResponse>;
}

export interface InitiativeBriefDraftModel {
  generateInitiativeBriefDraft(request: InitiativeBriefDraftRequest): Promise<InitiativeBriefDraftResponse>;
}

export interface EmbeddingModel {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface GroundedAnswerModel {
  generateGroundedAnswer(request: GroundedAnswerRequest): Promise<GroundedAnswerResponse>;
}

export type RetrievalRerankCandidate = {
  claimId: string;
  statement: string;
  evidenceSpanTexts: string[];
  graphScore: number;
  vectorScore: number;
  sparseScore: number;
  conflictWarningCount: number;
};

export type RetrievalRerankRequest = {
  question: string;
  profile: "ask" | "synthesis";
  candidates: RetrievalRerankCandidate[];
};

export type RetrievalRerankResponse = {
  rankedClaimIds: string[];
  rationaleByClaimId: Record<string, string>;
  model: string;
};

export interface RetrievalRerankerModel {
  rerankRetrieval(request: RetrievalRerankRequest): Promise<RetrievalRerankResponse>;
}

export interface SlackContextModel {
  selectNearbyContext(request: SlackNearbySelectionRequest): Promise<SlackNearbySelectionResponse>;
  classifySlackContext(request: SlackClassificationRequest): Promise<SlackClassificationResponse>;
}

export type OpenRouterModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModels?: string[];
  appTitle?: string;
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type OpenRouterEmbeddingModelConfig = OpenRouterModelConfig & {
  dimensions: number;
  encodingFormat?: "float";
};

const GENERATED_MEMORY_ITEM_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "temporaryId",
    "claimType",
    "statement",
    "evidenceSpanIds",
    "epistemicStatus",
    "qualifiers",
    "stableDomainTags",
    "entities",
    "relations",
    "schemas",
  ],
  properties: {
    temporaryId: { type: "string" },
    claimType: { type: "string", enum: CLAIM_TYPES },
    statement: { type: "string" },
    evidenceSpanIds: {
      type: "array",
      items: { type: "string" },
    },
    epistemicStatus: { type: "string", enum: EPISTEMIC_STATUSES },
    qualifiers: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    stableDomainTags: {
      type: "array",
      items: { type: "string" },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "entityType", "canonicalName"],
        properties: {
          name: { type: "string" },
          entityType: { type: "string" },
          canonicalName: {
            anyOf: [
              { type: "string" },
              { type: "null" },
            ],
          },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "predicate", "object", "evidenceSpanIds"],
        properties: {
          subject: { type: "string" },
          predicate: { type: "string" },
          object: { type: "string" },
          evidenceSpanIds: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    schemas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subjectType", "predicate", "objectType", "status"],
        properties: {
          subjectType: { type: "string" },
          predicate: { type: "string" },
          objectType: { type: "string" },
          status: { type: "string", enum: MEMORY_SCHEMA_STATUSES },
        },
      },
    },
  },
};

const MEMORY_GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: GENERATED_MEMORY_ITEM_JSON_SCHEMA,
    },
  },
};

const MEMORY_SECTION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["temporaryId", "title", "startEvidenceSpanId", "endEvidenceSpanId"],
        properties: {
          temporaryId: { type: "string" },
          title: { type: "string" },
          startEvidenceSpanId: { type: "string" },
          endEvidenceSpanId: { type: "string" },
        },
      },
    },
  },
};

const MEMORY_CANDIDATE_VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["temporaryId", "decision", "rationale", "correctedItem"],
        properties: {
          temporaryId: { type: "string" },
          decision: { type: "string", enum: ["verified", "needs_review", "corrected", "duplicate", "unsupported"] },
          rationale: { type: "string" },
          correctedItem: {
            anyOf: [
              GENERATED_MEMORY_ITEM_JSON_SCHEMA,
              { type: "null" },
            ],
          },
        },
      },
    },
  },
};

const MEMORY_CONNECTION_SCORING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "tier", "connectionType", "connectionReason", "confidence", "rationale", "evidenceSpanIds", "reviewRequired"],
        properties: {
          candidateId: { type: "string" },
          tier: { type: "string", enum: ["direct", "supporting", "contextual", "weak"] },
          connectionType: { type: "string", enum: CLAIM_CONNECTION_TYPES },
          connectionReason: { type: "string" },
          confidence: { type: "number" },
          rationale: { type: "string" },
          evidenceSpanIds: { type: "array", items: { type: "string" } },
          reviewRequired: { type: "boolean" },
        },
      },
    },
  },
};

const INITIATIVE_BRIEF_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "problem",
    "proposal",
    "scope",
    "successMetric",
    "risksAndDependencies",
    "contradictionsOrUncertainties",
    "memoryItemIds",
    "evidenceSpanIds",
  ],
  properties: {
    title: { type: "string" },
    problem: { type: "string" },
    proposal: { type: "string" },
    scope: { type: "string" },
    successMetric: { type: "string" },
    risksAndDependencies: { type: "string" },
    contradictionsOrUncertainties: {
      type: "array",
      items: { type: "string" },
    },
    memoryItemIds: {
      type: "array",
      items: { type: "string" },
    },
    evidenceSpanIds: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const GROUNDED_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations", "usedClaimIds", "usedEvidenceSpanIds", "warnings", "gap"],
  properties: {
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceSpanId", "claimIds"],
        properties: {
          evidenceSpanId: { type: "string" },
          claimIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    usedClaimIds: { type: "array", items: { type: "string" } },
    usedEvidenceSpanIds: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    gap: {
      anyOf: [
        { type: "string" },
        { type: "null" },
      ],
    },
  },
};

const RETRIEVAL_RERANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rankedClaimIds"],
  properties: {
    rankedClaimIds: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const SLACK_NEARBY_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selected"],
  properties: {
    selected: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["messageId", "reason"],
        properties: {
          messageId: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const SLACK_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "rationale", "identities"],
  properties: {
    category: {
      type: "string",
      enum: ["bug", "suggestion", "incident", "status_update", "decision", "question", "resolution", "mixed", "unknown"],
    },
    rationale: { type: "string" },
    identities: {
      type: "object",
      additionalProperties: false,
      required: ["products", "featureComponents", "externalServices", "issueTicketIds", "releaseVersions", "environments", "namedOrganizations"],
      properties: {
        products: { type: "array", items: { type: "string" } },
        featureComponents: { type: "array", items: { type: "string" } },
        externalServices: { type: "array", items: { type: "string" } },
        issueTicketIds: { type: "array", items: { type: "string" } },
        releaseVersions: { type: "array", items: { type: "string" } },
        environments: { type: "array", items: { type: "string" } },
        namedOrganizations: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export class OpenRouterMemoryGenerationModel implements MemoryGenerationModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async generateMemory(request: MemoryGenerationRequest): Promise<MemoryGenerationResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.generateMemoryWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter memory generation failed for all configured models. ${failures.join(" | ")}`);
  }

  private async generateMemoryWithModel(
    request: MemoryGenerationRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<MemoryGenerationResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 45_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 2400,
            messages: [
              {
                role: "system",
                content: memoryGenerationSystemPrompt(),
              },
              {
                role: "user",
                content: renderMemoryGenerationInputForModel(request),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "generated_memory_batch",
                strict: true,
                schema: MEMORY_GENERATION_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter memory generation timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter memory generation", model);
      if (!response.ok) {
        throw new Error(`OpenRouter memory generation failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("OpenRouter response did not include message content.");
      }

      const parsedJson = parseModelJson(content);
      const parsed = GeneratedMemoryBatchSchema.parse(parsedJson);

      return {
        parsed,
        raw,
        model,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterMemorySectionPlannerModel implements MemorySectionPlannerModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async planMemorySections(request: MemorySectionPlanningRequest): Promise<MemorySectionPlanningResponse> {
    const failures: string[] = [];
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    for (const [index, model] of models.entries()) {
      try {
        return await this.planWithModel(
          request,
          model,
          index === 0 ? this.config.timeoutMs : this.config.fallbackTimeoutMs ?? this.config.timeoutMs,
        );
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`OpenRouter memory section planning failed for all configured models. ${failures.join(" | ")}`);
  }

  private async planWithModel(
    request: MemorySectionPlanningRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<MemorySectionPlanningResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 45_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 3_200,
            messages: [
              { role: "system", content: memorySectionPlanningSystemPrompt() },
              { role: "user", content: renderMemorySectionPlanningInputForModel(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "memory_section_plan", strict: true, schema: MEMORY_SECTION_PLAN_SCHEMA },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter memory section planning timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter memory section planning", model);
      if (!response.ok) throw new Error(`OpenRouter memory section planning failed: ${response.status} ${rawText.slice(0, 500)}`);
      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter section planner response did not include message content.");
      const parsed = MemorySectionPlanSchema.parse(parseModelJson(content));
      validateMemorySectionPlannerResponse(parsed, request);
      return { parsed, raw, model };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function validateMemorySectionPlannerResponse(
  plan: MemorySectionPlan,
  request: MemorySectionPlanningRequest,
): void {
  if (plan.sections.length > request.maxSections) throw new Error(`Section planner exceeded maximum section count: ${request.maxSections}`);
  const indexes = new Map(request.evidenceSpans.map((span, index) => [span.id, index]));
  let expectedStart = 0;
  for (const section of plan.sections) {
    const start = indexes.get(section.startEvidenceSpanId);
    const end = indexes.get(section.endEvidenceSpanId);
    if (start === undefined || end === undefined) throw new Error("Section planner referenced an unknown evidence span ID.");
    if (start > end) throw new Error("Section planner returned an out-of-order section.");
    if (start < expectedStart) throw new Error("Section planner returned overlapping sections.");
    if (start > expectedStart) throw new Error("Section planner left a gap in source coverage.");
    const first = request.evidenceSpans[start]!;
    const last = request.evidenceSpans[end]!;
    if (last.endChar - first.startChar > request.maxChars && start !== end) {
      throw new Error(`Section planner returned a section larger than ${request.maxChars} characters.`);
    }
    expectedStart = end + 1;
  }
  if (expectedStart !== request.evidenceSpans.length) throw new Error("Section planner did not cover every evidence span.");
}

export class OpenRouterMemoryCandidateVerifierModel implements MemoryCandidateVerifierModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async verifyMemoryCandidates(request: MemoryCandidateVerificationRequest): Promise<MemoryCandidateVerificationResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.verifyMemoryCandidatesWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter memory candidate verification failed for all configured models. ${failures.join(" | ")}`);
  }

  private async verifyMemoryCandidatesWithModel(
    request: MemoryCandidateVerificationRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<MemoryCandidateVerificationResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 30_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 2200,
            messages: [
              { role: "system", content: memoryCandidateVerifierSystemPrompt() },
              { role: "user", content: renderMemoryCandidateVerificationInputForModel(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "memory_candidate_verification",
                strict: true,
                schema: MEMORY_CANDIDATE_VERIFICATION_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter memory candidate verification timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter memory candidate verification", model);
      if (!response.ok) {
        throw new Error(`OpenRouter memory candidate verification failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter response did not include message content.");

      const parsed = parseMemoryCandidateVerificationResponse(parseModelJson(content), model, request);
      validateMemoryCandidateVerificationResponse(parsed, request);
      return { ...parsed, raw };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterMemoryConnectionScorerModel implements MemoryConnectionScorerModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async scoreMemoryConnections(request: MemoryConnectionScoringRequest): Promise<MemoryConnectionScoringResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.scoreMemoryConnectionsWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter memory connection scoring failed for all configured models. ${failures.join(" | ")}`);
  }

  private async scoreMemoryConnectionsWithModel(
    request: MemoryConnectionScoringRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<MemoryConnectionScoringResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 30_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 2600,
            messages: [
              { role: "system", content: memoryConnectionScorerSystemPrompt() },
              { role: "user", content: renderMemoryConnectionScoringInputForModel(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "memory_connection_scoring",
                strict: true,
                schema: MEMORY_CONNECTION_SCORING_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter memory connection scoring timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter memory connection scoring", model);
      if (!response.ok) {
        throw new Error(`OpenRouter memory connection scoring failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter response did not include message content.");

      const parsed = parseMemoryConnectionScoringResponse(parseModelJson(content), model);
      validateMemoryConnectionScoringResponse(parsed, request);
      return { ...parsed, raw };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterInitiativeBriefDraftModel implements InitiativeBriefDraftModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async generateInitiativeBriefDraft(request: InitiativeBriefDraftRequest): Promise<InitiativeBriefDraftResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.generateInitiativeBriefDraftWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter initiative brief drafting failed for all configured models. ${failures.join(" | ")}`);
  }

  private async generateInitiativeBriefDraftWithModel(
    request: InitiativeBriefDraftRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<InitiativeBriefDraftResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 45_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 1800,
            messages: [
              {
                role: "system",
                content: initiativeBriefDraftSystemPrompt(),
              },
              {
                role: "user",
                content: renderInitiativeBriefDraftInputForModel(request),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "initiative_brief_draft",
                strict: true,
                schema: INITIATIVE_BRIEF_DRAFT_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter initiative brief drafting timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter initiative brief drafting", model);
      if (!response.ok) {
        throw new Error(`OpenRouter initiative brief drafting failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("OpenRouter response did not include message content.");
      }

      const parsedJson = parseModelJson(content);
      const parsed = InitiativeBriefDraftSchema.parse(parsedJson);

      return {
        parsed,
        raw,
        model,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterEmbeddingModel implements EmbeddingModel {
  constructor(private readonly config: OpenRouterEmbeddingModelConfig) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const parsedRequest = EmbeddingRequestSchema.parse(request);
    const abortController = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model: this.config.model,
            input: parsedRequest.input,
            encoding_format: this.config.encodingFormat ?? "float",
            dimensions: this.config.dimensions,
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter embedding timed out after ${timeoutMs}ms for model ${this.config.model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter embedding", this.config.model);
      if (!response.ok) {
        throw new Error(`OpenRouter embedding failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as {
        model?: string;
        data?: Array<{ embedding?: number[] }>;
      };
      const vectors = raw.data?.map((item) => item.embedding ?? []) ?? [];
      const parsed = EmbeddingResponseSchema.parse({
        vectors,
        model: this.config.model,
      });

      if (parsed.vectors.length !== parsedRequest.input.length) {
        throw new Error(`OpenRouter embedding returned ${parsed.vectors.length} vectors for ${parsedRequest.input.length} inputs.`);
      }

      for (const [index, vector] of parsed.vectors.entries()) {
        if (vector.length !== this.config.dimensions) {
          throw new Error(`Embedding vector ${index} has ${vector.length} dimensions; expected ${this.config.dimensions}.`);
        }
      }

      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterGroundedAnswerModel implements GroundedAnswerModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async generateGroundedAnswer(request: GroundedAnswerRequest): Promise<GroundedAnswerResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.generateGroundedAnswerWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter grounded answer failed for all configured models. ${failures.join(" | ")}`);
  }

  private async generateGroundedAnswerWithModel(
    request: GroundedAnswerRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<GroundedAnswerResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 25_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 1400,
            messages: [
              { role: "system", content: groundedAnswerSystemPrompt() },
              { role: "user", content: renderGroundedAnswerInputForModel(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "grounded_answer",
                strict: true,
                schema: GROUNDED_ANSWER_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter grounded answer timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter grounded answer", model);
      if (!response.ok) {
        throw new Error(`OpenRouter grounded answer failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter response did not include message content.");

      const parsedPayload = Object(parseModelJson(content)) as { gap?: unknown };
      const parsed = GroundedAnswerResponseSchema.parse({
        ...parsedPayload,
        ...(parsedPayload.gap === null ? { gap: undefined } : {}),
        model,
      });
      validateGroundedAnswerCitations(parsed, request);
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterRetrievalRerankerModel implements RetrievalRerankerModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async rerankRetrieval(request: RetrievalRerankRequest): Promise<RetrievalRerankResponse> {
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    const failures: string[] = [];

    for (const [index, model] of models.entries()) {
      try {
        const timeoutMs = index === 0
          ? this.config.timeoutMs
          : this.config.fallbackTimeoutMs ?? this.config.timeoutMs;
        return await this.rerankRetrievalWithModel(request, model, timeoutMs);
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OpenRouter retrieval rerank failed for all configured models. ${failures.join(" | ")}`);
  }

  private async rerankRetrievalWithModel(
    request: RetrievalRerankRequest,
    model: string,
    configuredTimeoutMs: number | undefined,
  ): Promise<RetrievalRerankResponse> {
    const abortController = new AbortController();
    const timeoutMs = configuredTimeoutMs ?? 12_000;
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const fetchImpl = this.config.fetchImpl ?? ((input, init) => fetch(input, init));
        response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 1000,
            messages: [
              { role: "system", content: retrievalRerankSystemPrompt() },
              { role: "user", content: renderRetrievalRerankInputForModel(request) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "retrieval_rerank",
                strict: true,
                schema: RETRIEVAL_RERANK_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter retrieval rerank timed out after ${timeoutMs}ms for model ${model}.`);
        }
        throw error;
      }

      const rawText = await readModelResponseText(response, abortController.signal, didTimeout, timeoutMs, "OpenRouter retrieval rerank", model);
      if (!response.ok) {
        throw new Error(`OpenRouter retrieval rerank failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter response did not include message content.");

      const parsed = Object(parseModelJson(content)) as {
        rankedClaimIds?: unknown;
        rationaleByClaimId?: unknown;
      };
      const rankedClaimIds = Array.isArray(parsed.rankedClaimIds)
        ? parsed.rankedClaimIds.filter((value): value is string => typeof value === "string")
        : [];
      const rationaleByClaimId = typeof parsed.rationaleByClaimId === "object" && parsed.rationaleByClaimId !== null
        ? Object.fromEntries(Object.entries(parsed.rationaleByClaimId).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
      const responsePayload = { rankedClaimIds, rationaleByClaimId, model };
      validateRetrievalRerankResponse(responsePayload, request);
      return responsePayload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenRouterSlackContextModel implements SlackContextModel {
  constructor(private readonly config: OpenRouterModelConfig) {}

  async selectNearbyContext(request: SlackNearbySelectionRequest): Promise<SlackNearbySelectionResponse> {
    const response = await this.complete({
      operation: "Slack nearby context selection",
      systemPrompt: slackNearbySelectionSystemPrompt(),
      userPrompt: renderSlackNearbySelectionInputForModel(request),
      schemaName: "slack_nearby_context_selection",
      schema: SLACK_NEARBY_SELECTION_SCHEMA,
      maxTokens: 800,
    });
    const parsed = SlackNearbyContextSelectionSchema.parse(parseModelJson(response.content));
    validateSlackNearbySelection(parsed, request);
    return { parsed, raw: response.raw, model: response.model };
  }

  async classifySlackContext(request: SlackClassificationRequest): Promise<SlackClassificationResponse> {
    const response = await this.complete({
      operation: "Slack context classification",
      systemPrompt: slackClassificationSystemPrompt(),
      userPrompt: renderSlackClassificationInputForModel(request),
      schemaName: "slack_context_classification",
      schema: SLACK_CLASSIFICATION_SCHEMA,
      maxTokens: 1_200,
    });
    const parsed = SlackConversationClassificationSchema.parse(parseModelJson(response.content));
    return { parsed, raw: response.raw, model: response.model };
  }

  private async complete(input: {
    operation: string;
    systemPrompt: string;
    userPrompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens: number;
  }): Promise<{ content: string; raw: unknown; model: string }> {
    const failures: string[] = [];
    const models = unique([this.config.model, ...(this.config.fallbackModels ?? [])]);
    for (const [index, model] of models.entries()) {
      const timeoutMs = index === 0
        ? this.config.timeoutMs ?? 20_000
        : this.config.fallbackTimeoutMs ?? this.config.timeoutMs ?? 20_000;
      const abortController = new AbortController();
      let didTimeout = false;
      const timeout = setTimeout(() => {
        didTimeout = true;
        abortController.abort();
      }, timeoutMs);
      try {
        const fetchImpl = this.config.fetchImpl ?? ((request, init) => fetch(request, init));
        const response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": this.config.appTitle ?? "Distillery v0",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: input.maxTokens,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPrompt },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: input.schemaName, strict: true, schema: input.schema },
            },
          }),
        });
        const rawText = await readModelResponseText(
          response,
          abortController.signal,
          didTimeout,
          timeoutMs,
          `OpenRouter ${input.operation}`,
          model,
        );
        if (!response.ok) throw new Error(`${input.operation} failed with HTTP ${response.status}.`);
        const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
        const content = raw.choices?.[0]?.message?.content;
        if (!content) throw new Error(`${input.operation} returned no message content.`);
        return { content, raw, model };
      } catch (error) {
        failures.push(`${model}: ${didTimeout ? "timeout" : error instanceof Error ? error.message : "unknown failure"}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`${input.operation} failed for all configured models. ${failures.join(" | ")}`);
  }
}

export function validateSlackNearbySelection(
  selection: SlackNearbyContextSelection,
  request: SlackNearbySelectionRequest,
): void {
  const allowed = new Set(request.candidates.map((candidate) => candidate.messageId));
  const seen = new Set<string>();
  for (const selected of selection.selected) {
    if (!allowed.has(selected.messageId)) {
      throw new Error(`Slack context selector returned unknown message ID: ${selected.messageId}`);
    }
    if (seen.has(selected.messageId)) {
      throw new Error(`Slack context selector returned duplicate message ID: ${selected.messageId}`);
    }
    seen.add(selected.messageId);
  }
}

export function validateRetrievalRerankResponse(
  response: RetrievalRerankResponse,
  request: RetrievalRerankRequest,
): void {
  const allowedClaimIds = new Set(request.candidates.map((candidate) => candidate.claimId));
  const seen = new Set<string>();
  for (const claimId of response.rankedClaimIds) {
    if (!allowedClaimIds.has(claimId)) throw new Error(`Retrieval reranker returned unknown claim ID: ${claimId}`);
    if (seen.has(claimId)) throw new Error(`Retrieval reranker returned duplicate claim ID: ${claimId}`);
    seen.add(claimId);
  }
}

function parseMemoryCandidateVerificationResponse(
  payload: unknown,
  model: string,
  request: MemoryCandidateVerificationRequest,
): MemoryCandidateVerificationResponse {
  const parsed = Object(payload) as { decisions?: unknown };
  const candidatesByTemporaryId = new Map(request.candidates.map((candidate) => [candidate.temporaryId, candidate]));
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.map((decision): MemoryCandidateVerificationItem => {
      const record = Object(decision) as {
        temporaryId?: unknown;
        decision?: unknown;
        rationale?: unknown;
        correctedItem?: unknown;
      };
      const originalCandidate = candidatesByTemporaryId.get(String(record.temporaryId ?? ""));
      let correctedItem: GeneratedMemoryItem | undefined;
      if (record.correctedItem !== undefined && record.correctedItem !== null) {
        const correctedRecord = Object(record.correctedItem) as Record<string, unknown>;
        const suppliedQualifiers = correctedRecord.qualifiers;
        correctedItem = GeneratedMemoryItemSchema.parse({
          ...correctedRecord,
          qualifiers: {
            ...(originalCandidate?.qualifiers ?? {}),
            ...(typeof suppliedQualifiers === "object" && suppliedQualifiers !== null && !Array.isArray(suppliedQualifiers)
              ? suppliedQualifiers
              : {}),
          },
        });
      }
      return {
        temporaryId: String(record.temporaryId ?? ""),
        decision: parseVerificationDecision(record.decision),
        rationale: typeof record.rationale === "string" ? record.rationale : "",
        ...(correctedItem ? { correctedItem } : {}),
      };
    })
    : [];
  return { decisions, raw: payload, model };
}

function parseVerificationDecision(value: unknown): MemoryCandidateVerificationDecision {
  if (
    value === "verified" ||
    value === "needs_review" ||
    value === "corrected" ||
    value === "duplicate" ||
    value === "unsupported"
  ) {
    return value;
  }
  throw new Error(`Unsupported memory verification decision: ${String(value)}`);
}

export function validateMemoryCandidateVerificationResponse(
  response: MemoryCandidateVerificationResponse,
  request: MemoryCandidateVerificationRequest,
): void {
  const allowedTemporaryIds = new Set(request.candidates.map((candidate) => candidate.temporaryId));
  const allowedEvidenceSpanIds = new Set(request.evidenceSpans.map((span) => span.id));
  const seen = new Set<string>();
  for (const decision of response.decisions) {
    if (!allowedTemporaryIds.has(decision.temporaryId)) {
      throw new Error(`Memory verifier returned unknown candidate ID: ${decision.temporaryId}`);
    }
    if (seen.has(decision.temporaryId)) throw new Error(`Memory verifier returned duplicate candidate ID: ${decision.temporaryId}`);
    seen.add(decision.temporaryId);
    if (decision.decision === "corrected" && !decision.correctedItem) {
      throw new Error(`Memory verifier marked ${decision.temporaryId} corrected without correctedItem.`);
    }
    if (decision.correctedItem) {
      if (decision.decision !== "corrected") {
        throw new Error(`Memory verifier returned correctedItem for ${decision.temporaryId} without a corrected decision.`);
      }
      if (decision.correctedItem.temporaryId !== decision.temporaryId) {
        throw new Error(`Memory verifier corrected ${decision.temporaryId} with mismatched temporary ID: ${decision.correctedItem.temporaryId}`);
      }
      for (const evidenceSpanId of decision.correctedItem.evidenceSpanIds) {
        if (!allowedEvidenceSpanIds.has(evidenceSpanId)) {
          throw new Error(`Memory verifier corrected ${decision.temporaryId} with unavailable evidence span: ${evidenceSpanId}`);
        }
      }
    }
  }
}

function parseMemoryConnectionScoringResponse(payload: unknown, model: string): MemoryConnectionScoringResponse {
  const parsed = Object(payload) as { decisions?: unknown };
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.map((decision): MemoryConnectionScoringDecision => {
      const record = Object(decision) as {
        candidateId?: unknown;
        tier?: unknown;
        connectionType?: unknown;
        connectionReason?: unknown;
        confidence?: unknown;
        rationale?: unknown;
        evidenceSpanIds?: unknown;
        reviewRequired?: unknown;
      };
      return {
        candidateId: String(record.candidateId ?? ""),
        tier: parseConnectionTier(record.tier),
        connectionType: String(record.connectionType ?? ""),
        connectionReason: String(record.connectionReason ?? ""),
        confidence: Number(record.confidence),
        rationale: typeof record.rationale === "string" ? record.rationale : "",
        evidenceSpanIds: Array.isArray(record.evidenceSpanIds)
          ? record.evidenceSpanIds.filter((value): value is string => typeof value === "string")
          : [],
        reviewRequired: Boolean(record.reviewRequired),
      };
    })
    : [];
  return { decisions, raw: payload, model };
}

function parseConnectionTier(value: unknown): MemoryConnectionTier {
  if (value === "direct" || value === "supporting" || value === "contextual" || value === "weak") return value;
  throw new Error(`Unsupported memory connection tier: ${String(value)}`);
}

export function validateMemoryConnectionScoringResponse(
  response: MemoryConnectionScoringResponse,
  request: MemoryConnectionScoringRequest,
): void {
  const allowedCandidateIds = new Set(request.candidates.map((candidate) => candidate.id));
  const allowedClaimIds = new Set(request.memory.map((record) => record.memoryItem.id));
  const allowedEvidenceSpanIds = new Set(request.memory.flatMap((record) => record.evidenceSpans.map((span) => span.id)));
  const allowedConnectionTypes = new Set<string>(CLAIM_CONNECTION_TYPES);
  const seen = new Set<string>();
  for (const decision of response.decisions) {
    if (!allowedCandidateIds.has(decision.candidateId)) throw new Error(`Connection scorer returned unknown candidate ID: ${decision.candidateId}`);
    if (seen.has(decision.candidateId)) throw new Error(`Connection scorer returned duplicate candidate ID: ${decision.candidateId}`);
    seen.add(decision.candidateId);
    if (!allowedConnectionTypes.has(decision.connectionType)) throw new Error(`Connection scorer returned invalid connection type: ${decision.connectionType}`);
    if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
      throw new Error(`Connection scorer returned invalid confidence for ${decision.candidateId}: ${decision.confidence}`);
    }
    const candidate = request.candidates.find((item) => item.id === decision.candidateId);
    if (!candidate || !allowedClaimIds.has(candidate.fromClaimId) || !allowedClaimIds.has(candidate.toClaimId)) {
      throw new Error(`Connection scorer candidate references unavailable claims: ${decision.candidateId}`);
    }
    for (const evidenceSpanId of decision.evidenceSpanIds) {
      if (!allowedEvidenceSpanIds.has(evidenceSpanId)) {
        throw new Error(`Connection scorer returned unavailable evidence span: ${evidenceSpanId}`);
      }
    }
  }
}

export function validateGroundedAnswerCitations(
  answer: GroundedAnswerResponse,
  request: GroundedAnswerRequest,
): void {
  const allowedClaimIds = new Set(request.claims.map((record) => record.claim.id));
  const allowedEvidenceIds = new Set(request.evidenceSpans.map((span) => span.id));

  for (const claimId of answer.usedClaimIds) {
    if (!allowedClaimIds.has(claimId)) throw new Error(`Grounded answer cited unavailable claim: ${claimId}`);
  }
  for (const evidenceSpanId of answer.usedEvidenceSpanIds) {
    if (!allowedEvidenceIds.has(evidenceSpanId)) {
      throw new Error(`Grounded answer cited unavailable evidence span: ${evidenceSpanId}`);
    }
  }
  for (const citation of answer.citations) {
    if (!allowedEvidenceIds.has(citation.evidenceSpanId)) {
      throw new Error(`Grounded answer citation references unavailable evidence span: ${citation.evidenceSpanId}`);
    }
    for (const claimId of citation.claimIds) {
      if (!allowedClaimIds.has(claimId)) {
        throw new Error(`Grounded answer citation references unavailable claim: ${claimId}`);
      }
    }
  }
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const candidate = extractJsonCandidate(trimmed);

  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(jsonrepair(candidate));
  }
}

function extractJsonCandidate(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  const firstObjectChar = trimmed.indexOf("{");
  const lastObjectChar = trimmed.lastIndexOf("}");
  if (firstObjectChar >= 0 && lastObjectChar > firstObjectChar) {
    return trimmed.slice(firstObjectChar, lastObjectChar + 1);
  }

  return trimmed;
}

async function readModelResponseText(
  response: Response,
  signal: AbortSignal,
  didTimeout: boolean,
  timeoutMs: number,
  operation: string,
  model: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (didTimeout || signal.aborted) {
      throw new Error(`${operation} timed out after ${timeoutMs}ms for model ${model}.`);
    }
    throw error;
  }
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}
