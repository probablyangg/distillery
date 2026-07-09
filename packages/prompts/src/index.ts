import type {
  ConflictGroup,
  EvidenceSpan,
  GraphRetrievalClaim,
  MemoryItem,
} from "@distillery/contracts";
import {
  CLAIM_TYPES,
  EPISTEMIC_STATUSES,
} from "@distillery/contracts";

export const MEMORY_PROMPT_VERSION = "stable-memory-prompt-v0.2";

export type MemoryGenerationPromptInput = {
  evidenceSpans: EvidenceSpan[];
};

export type InitiativeBriefDraftPromptInput = {
  memoryItems: MemoryItem[];
  evidenceSpans: EvidenceSpan[];
  intent?: string;
};

export type GroundedAnswerPromptInput = {
  question: string;
  claims: GraphRetrievalClaim[];
  evidenceSpans: EvidenceSpan[];
  conflicts: ConflictGroup[];
};

export type SynthesisIntentInput = {
  seedMemoryItemIds: string[];
  connections: Array<{
    reason: string;
    fromMemoryItemId: string;
    toMemoryItemId: string;
  }>;
  readiness: {
    warningReasons: string[];
  };
};

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
    "Entities must be specific business or domain objects, products, user groups, systems, docs, APIs, workflows, merchants, partners, protocols, or named concepts.",
    "Do not emit determiners, pronouns, generic quantifiers, sentence-leading function words, standalone adjectives, or standalone adverbs as entities.",
    "Never emit entities like: the, a, an, in, no, yes, this, that, there, here, one, two, three, four, many, some.",
    "Prefer concrete multi-word entities when available, such as node installation tutorial instead of node or tutorial.",
    "If no meaningful entity exists, return an empty entities array.",
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

export function renderMemoryGenerationInputForModel(input: MemoryGenerationPromptInput): string {
  return renderEvidenceForModel(input.evidenceSpans);
}

export function renderInitiativeBriefDraftInputForModel(input: InitiativeBriefDraftPromptInput): string {
  const intent = input.intent?.trim()
    ? `<intent>${input.intent.trim()}</intent>\n\n`
    : "";
  const memory = input.memoryItems
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
  const evidence = renderEvidenceForModel(input.evidenceSpans);

  return `${intent}<selected_memory>\n${memory}\n</selected_memory>\n\n<selected_evidence>\n${evidence}\n</selected_evidence>`;
}

export function renderGroundedAnswerInputForModel(input: GroundedAnswerPromptInput): string {
  const claims = input.claims
    .map((record) =>
      [
        `<claim id="${record.claim.id}" claimType="${record.claim.claimType}" epistemicStatus="${record.claim.epistemicStatus}" evidenceSpanIds="${record.claim.evidenceSpanIds.join(",")}">`,
        record.claim.statement,
        "</claim>",
      ].join("\n"),
    )
    .join("\n\n");
  const evidence = renderEvidenceForModel(input.evidenceSpans);
  const conflicts = input.conflicts
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
    `<question>${input.question}</question>`,
    `<retrieved_claims>${claims}</retrieved_claims>`,
    `<retrieved_evidence>${evidence}</retrieved_evidence>`,
    `<conflicts>${conflicts}</conflicts>`,
  ].join("\n\n");
}

export function renderSynthesisIntent(input: SynthesisIntentInput): string {
  return [
    "Draft an initiative brief only from the selected memory and evidence.",
    `Seed memory: ${input.seedMemoryItemIds.join(", ")}`,
    `Connection reasons: ${input.connections.map((connection) => `${connection.reason}(${connection.fromMemoryItemId}->${connection.toMemoryItemId})`).join(", ")}`,
    input.readiness.warningReasons.length > 0
      ? `Warnings to surface: ${input.readiness.warningReasons.join("; ")}`
      : "",
  ].filter(Boolean).join("\n");
}
