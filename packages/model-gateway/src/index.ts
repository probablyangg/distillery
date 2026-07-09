import type {
  ConflictGroup,
  EmbeddingRequest,
  EmbeddingResponse,
  EvidenceSpan,
  GeneratedMemoryBatch,
  GraphRetrievalClaim,
  GroundedAnswerResponse,
  InitiativeBriefDraft,
  MemoryItem,
} from "@distillery/contracts";
import {
  CLAIM_TYPES,
  EmbeddingRequestSchema,
  EmbeddingResponseSchema,
  GeneratedMemoryBatchSchema,
  GroundedAnswerResponseSchema,
  InitiativeBriefDraftSchema,
  EPISTEMIC_STATUSES,
  MEMORY_SCHEMA_STATUSES,
} from "@distillery/contracts";
import { jsonrepair } from "jsonrepair";

export type MemoryGenerationRequest = {
  ingestionId: string;
  sourceVersionId: string;
  evidenceSpans: EvidenceSpan[];
};

export type MemoryGenerationResponse = {
  parsed: GeneratedMemoryBatch;
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

export interface InitiativeBriefDraftModel {
  generateInitiativeBriefDraft(request: InitiativeBriefDraftRequest): Promise<InitiativeBriefDraftResponse>;
}

export interface EmbeddingModel {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface GroundedAnswerModel {
  generateGroundedAnswer(request: GroundedAnswerRequest): Promise<GroundedAnswerResponse>;
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

const MEMORY_GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 30,
      items: {
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
            minItems: 1,
            items: { type: "string" },
          },
          epistemicStatus: { type: "string", enum: EPISTEMIC_STATUSES },
          qualifiers: { type: "object" },
          stableDomainTags: {
            type: "array",
            items: { type: "string" },
          },
          entities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "entityType"],
              properties: {
                name: { type: "string" },
                entityType: { type: "string" },
                canonicalName: { type: "string" },
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
                  minItems: 1,
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
    "successMetric",
    "risksAndDependencies",
    "memoryItemIds",
    "evidenceSpanIds",
  ],
  properties: {
    title: { type: "string" },
    problem: { type: "string" },
    proposal: { type: "string" },
    successMetric: { type: "string" },
    risksAndDependencies: { type: "string" },
    memoryItemIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    evidenceSpanIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
};

const GROUNDED_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations", "usedClaimIds", "usedEvidenceSpanIds", "warnings"],
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
          claimIds: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    usedClaimIds: { type: "array", items: { type: "string" } },
    usedEvidenceSpanIds: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    gap: { type: "string" },
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
                content: renderEvidenceForModel(request.evidenceSpans),
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

      const rawText = await response.text();
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

      const rawText = await response.text();
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
          }),
        });
      } catch (error) {
        if (didTimeout || abortController.signal.aborted) {
          throw new Error(`OpenRouter embedding timed out after ${timeoutMs}ms for model ${this.config.model}.`);
        }
        throw error;
      }

      const rawText = await response.text();
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
        model: raw.model ?? this.config.model,
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

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`OpenRouter grounded answer failed: ${response.status} ${rawText.slice(0, 500)}`);
      }

      const raw = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter response did not include message content.");

      const parsed = GroundedAnswerResponseSchema.parse({
        ...Object(parseModelJson(content)),
        model,
      });
      validateGroundedAnswerCitations(parsed, request);
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function memoryGenerationSystemPrompt(): string {
  return [
    "You are Distillery's Memory Generation step for Stable.",
    "Extract only source-backed memory items from the provided text spans.",
    "Do not create initiatives, PRDs, tasks, recommendations, or product priorities.",
    "Do not hide uncertainty. If a statement is a decision report, use decision_reported.",
    "If evidence is weak, use inferred or assumption only when the inference is clearly labeled and supported by supplied span IDs.",
    "Every item must cite one or more supplied evidenceSpanIds exactly.",
    `Allowed claim types: ${CLAIM_TYPES.join(", ")}.`,
    `Allowed epistemic statuses: ${EPISTEMIC_STATUSES.join(", ")}.`,
    "For each item, include entities, relations, and schema candidates as interpretation metadata only; they are not standalone evidence.",
    "Every relation must cite one or more evidenceSpanIds already cited by its parent memory item.",
    "Generated schemas must be abstract patterns with status candidate unless an existing reviewed schema is explicitly supplied.",
    "Output must be a single minified JSON object.",
    "Do not include markdown, comments, trailing commas, or unescaped line breaks inside strings.",
    "Return valid JSON matching the requested schema.",
  ].join("\n");
}

export function initiativeBriefDraftSystemPrompt(): string {
  return [
    "You are Distillery's Memory Synthesis drafting step for Stable.",
    "Create a concise, reviewable initiative brief draft from only the selected memory and evidence.",
    "Do not invent customers, metrics, approvals, owners, dependencies, or timelines.",
    "If a claim is weak, unresolved, or only a reported signal, make that uncertainty visible.",
    "The draft is not a PRD. Keep it short and suitable for executive review.",
    "Use every selected memoryItemId and every selected evidenceSpanId exactly as supplied.",
    "Output must be a single minified JSON object.",
    "Do not include markdown, comments, trailing commas, or unescaped line breaks inside strings.",
    "Return valid JSON matching the requested schema.",
  ].join("\n");
}

export function groundedAnswerSystemPrompt(): string {
  return [
    "You are Distillery's grounded Ask answer writer.",
    "Use only the supplied claims, evidence, and conflicts.",
    "Every substantive answer sentence or bullet must be supported by the supplied evidence IDs.",
    "Cite only supplied evidenceSpanIds and claim IDs.",
    "Call out missing, partial, stale, or conflicted evidence. Do not resolve open conflicts as fact.",
    "Do not invent owners, metrics, dates, decisions, dependencies, launch states, or causality.",
    "Output must be a single minified JSON object matching the requested schema.",
  ].join("\n");
}

export function renderEvidenceForModel(spans: EvidenceSpan[]): string {
  return spans
    .map((span) =>
      [
        `<evidence id="${span.id}" lines="${span.startLine}-${span.endLine}">`,
        span.text,
        "</evidence>",
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderInitiativeBriefDraftInputForModel(request: InitiativeBriefDraftRequest): string {
  const intent = request.intent?.trim()
    ? `<intent>${request.intent.trim()}</intent>\n\n`
    : "";
  const memory = request.memoryItems
    .map((item) =>
      [
        `<memory id="${item.id}" claimType="${item.claimType}" epistemicStatus="${item.epistemicStatus}" evidenceSpanIds="${
          item.evidenceSpanIds.join(",")
        }">`,
        item.statement,
        `<entities>${JSON.stringify(item.entities)}</entities>`,
        `<relations>${JSON.stringify(item.relations)}</relations>`,
        `<schemas>${JSON.stringify(item.schemas)}</schemas>`,
        "</memory>",
      ].join("\n"),
    )
    .join("\n\n");
  const evidence = renderEvidenceForModel(request.evidenceSpans);

  return `${intent}<selected_memory>\n${memory}\n</selected_memory>\n\n<selected_evidence>\n${evidence}\n</selected_evidence>`;
}

export function renderGroundedAnswerInputForModel(request: GroundedAnswerRequest): string {
  const claims = request.claims
    .map((record) =>
      [
        `<claim id="${record.claim.id}" claimType="${record.claim.claimType}" epistemicStatus="${record.claim.epistemicStatus}" evidenceSpanIds="${record.claim.evidenceSpanIds.join(",")}">`,
        record.claim.statement,
        "</claim>",
      ].join("\n"),
    )
    .join("\n\n");
  const evidence = renderEvidenceForModel(request.evidenceSpans);
  const conflicts = request.conflicts
    .map((conflict) =>
      [
        `<conflict id="${conflict.id}" type="${conflict.conflictType}" severity="${conflict.severity}" status="${conflict.status}">`,
        conflict.summary,
        `<members>${JSON.stringify(conflict.members)}</members>`,
        "</conflict>",
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `<question>${request.question}</question>`,
    `<retrieved_claims>${claims}</retrieved_claims>`,
    `<retrieved_evidence>${evidence}</retrieved_evidence>`,
    `<conflicts>${conflicts}</conflicts>`,
  ].join("\n\n");
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

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}
