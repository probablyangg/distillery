import {
  CaptureInputSchema,
  CreateInitiativeBriefInputSchema,
  InitiativeBriefDraftInputSchema,
  InitiativeBriefDecisionInputSchema,
  HumanReviewDecisionSchema,
  MemoryItemActionInputSchema,
  ProposedEventSchema,
  RecallQueryInputSchema,
  UpdateInitiativeBriefInputSchema,
  type CitedAnswer,
  type EvidenceSpan,
  type GraphRecallContext,
  type MemoryWithEvidence,
  type ProposedEvent,
  type SuggestedBrief,
  type LeadershipBrief,
} from "@distillery/contracts";
import { SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "@distillery/db";
import { SupabaseLoopPersistence } from "@distillery/db";
import {
  createPolicies,
  executeWorkItem,
  maintainLoop,
  routeCommittedEvents,
} from "@distillery/loop";
import {
  OpenRouterInitiativeBriefDraftModel,
  OpenRouterEmbeddingModel,
  OpenRouterGroundedAnswerModel,
  OpenRouterMemoryCandidateVerifierModel,
  OpenRouterMemoryConnectionScorerModel,
  OpenRouterMemoryGenerationModel,
  OpenRouterMemorySectionPlannerModel,
  OpenRouterRetrievalRerankerModel,
  type OpenRouterModelConfig,
} from "@distillery/model-gateway";
import d3LocalSource from "./vendor/d3.min.txt";
import {
  DEFAULT_TENANT_ID,
  applyMemoryItemAction,
  buildDeterministicCitedAnswer,
  submitTextCapture,
} from "@distillery/memory-generation";
import { retrieveMemoryContext } from "@distillery/memory-retrieval";
import {
  buildClusterDossier,
  buildSynthesisBundle,
  validateInitiativeBriefDraftTraceability,
} from "@distillery/memory-synthesis";
import {
  handleSlackInteraction as handleSlackMessageAction,
  ingestSlackSource,
  parseCsvAllowlist,
  SlackWebClient,
  syncSlackReaction,
} from "@distillery/slack-connector";

const SESSION_COOKIE_NAME = "distillery_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_DRAFT_MEMORY_ITEMS = 20;
const SLACK_SAVED_REACTION = "factory";
const SLACK_PROCESSING_REACTION = "hourglass_flowing_sand";

export type Env = {
  DISTILLERY_APP_PASSWORD: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODELS?: string;
  OPENROUTER_TIMEOUT_MS?: string;
  OPENROUTER_FALLBACK_TIMEOUT_MS?: string;
  MEMORY_EXTRACTOR_MODEL?: string;
  MEMORY_VERIFIER_MODEL?: string;
  MEMORY_CONNECTION_MODEL?: string;
  MEMORY_SECTION_PLANNER_MODEL?: string;
  MEMORY_SECTIONING_ENABLED?: string;
  MEMORY_SECTION_TRIGGER_CHARS?: string;
  MEMORY_SECTION_TRIGGER_SPANS?: string;
  MEMORY_SECTION_TARGET_CHARS?: string;
  MEMORY_SECTION_MAX_CHARS?: string;
  MEMORY_SECTION_MAX_SECTIONS?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  EMBEDDING_ENCODING_FORMAT?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_ALLOWED_TEAM_ID?: string;
  SLACK_ALLOWED_CHANNEL_IDS?: string;
  SLACK_ALLOWED_USER_IDS?: string;
  SLACK_SAVED_REACTION?: string;
  SLACK_PROCESSING_REACTION?: string;
  MEMORY_GENERATION_QUEUE?: Queue<{ workItemId: string }>;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "distillery-v0" });
    }

    if (request.method === "POST" && url.pathname === "/api/slack/interactions") {
      return handleSlackInteractions(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return html(renderAppShell());
    }

    if (request.method === "GET" && url.pathname === "/synthesis") {
      return html(renderSynthesisShell());
    }

    if (request.method === "GET" && url.pathname === "/graph") {
      return html(renderGraphShell());
    }

    if (request.method === "GET" && (url.pathname === "/briefs" || /^\/briefs\/[^/]+$/u.test(url.pathname))) {
      return html(renderBriefReaderShell());
    }

    if (request.method === "GET" && url.pathname === "/assets/d3-local.js") {
      return javascript(d3LocalSource);
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return handleLogin(request, env);
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      return handleLogout();
    }

    if (!await isAuthorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      return json({ authenticated: true });
    }

    if (request.method === "GET" && url.pathname === "/api/loop-status") {
      return handleLoopStatus(url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/graph/clusters") {
      return handleListGraphClusters(url, env);
    }

    if (request.method === "POST" && url.pathname === "/api/graph/rebuild") {
      return handleGraphRebuild(env);
    }

    if (request.method === "POST" && url.pathname === "/api/ingestions") {
      return handleCreateIngestion(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/api/queries") {
      return handleRecallQuery(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/memory-items") {
      return handleListActiveMemory(url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/memory-proposals") {
      return handleListPendingMemoryProposals(url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/initiative-briefs") {
      return handleListInitiativeBriefs(env);
    }

    if (request.method === "GET" && url.pathname === "/api/briefs") {
      return handleListLeadershipBriefs(env);
    }

    const leadershipBriefMatch = url.pathname.match(/^\/api\/briefs\/([^/]+)$/u);
    if (request.method === "GET" && leadershipBriefMatch?.[1]) {
      return handleGetLeadershipBrief(decodeRouteParam(leadershipBriefMatch[1]), env);
    }

    if (request.method === "GET" && url.pathname === "/api/synthesis/opportunities") {
      return handleListSynthesisOpportunities(url, env);
    }

    if (request.method === "POST" && url.pathname === "/api/initiative-brief-drafts") {
      return handleGenerateInitiativeBriefDraft(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/initiative-briefs") {
      return handleCreateInitiativeBrief(request, env);
    }

    const initiativeBriefMatch = url.pathname.match(/^\/api\/initiative-briefs\/([^/]+)$/);
    if (request.method === "GET" && initiativeBriefMatch?.[1]) {
      return handleGetInitiativeBrief(decodeRouteParam(initiativeBriefMatch[1]), env);
    }
    if (request.method === "PATCH" && initiativeBriefMatch?.[1]) {
      return handleUpdateInitiativeBrief(decodeRouteParam(initiativeBriefMatch[1]), request, env);
    }

    const synthesisGenerateMatch = url.pathname.match(/^\/api\/synthesis\/clusters\/([^/]+)\/generate$/);
    if (request.method === "POST" && synthesisGenerateMatch?.[1]) {
      return handleGenerateClusterDraft(decodeRouteParam(synthesisGenerateMatch[1]), request, env, ctx);
    }

    const initiativeBriefDecisionMatch = url.pathname.match(/^\/api\/initiative-briefs\/([^/]+)\/decisions$/);
    if (request.method === "POST" && initiativeBriefDecisionMatch?.[1]) {
      return handleInitiativeBriefDecision(decodeRouteParam(initiativeBriefDecisionMatch[1]), request, env);
    }

    const proposedEventDecisionMatch = url.pathname.match(/^\/api\/proposed-events\/([^/]+)\/decision$/);
    if (request.method === "POST" && proposedEventDecisionMatch?.[1]) {
      return handleProposedEventDecision(decodeRouteParam(proposedEventDecisionMatch[1]), request, env, ctx);
    }

    const ingestionMatch = url.pathname.match(/^\/api\/ingestions\/([^/]+)$/);
    if (request.method === "GET" && ingestionMatch?.[1]) {
      return handleGetIngestion(decodeRouteParam(ingestionMatch[1]), env);
    }

    const ingestionRetryMatch = url.pathname.match(/^\/api\/ingestions\/([^/]+)\/retry$/);
    if (request.method === "POST" && ingestionRetryMatch?.[1]) {
      return handleRetryIngestion(decodeRouteParam(ingestionRetryMatch[1]), env, ctx);
    }

    const memoryActionMatch = url.pathname.match(/^\/api\/memory-items\/([^/]+)\/actions$/);
    if (request.method === "POST" && memoryActionMatch?.[1]) {
      return handleMemoryItemAction(decodeRouteParam(memoryActionMatch[1]), request, env, ctx);
    }

    const memoryHistoryMatch = url.pathname.match(/^\/api\/memory-items\/([^/]+)\/history$/);
    if (request.method === "GET" && memoryHistoryMatch?.[1]) {
      return handleMemoryItemHistory(decodeRouteParam(memoryHistoryMatch[1]), env);
    }

    const graphClusterMatch = url.pathname.match(/^\/api\/graph\/clusters\/([^/]+)$/);
    if (request.method === "GET" && graphClusterMatch?.[1]) {
      return handleGetGraphCluster(decodeRouteParam(graphClusterMatch[1]), env);
    }

    const graphClaimMatch = url.pathname.match(/^\/api\/graph\/claims\/([^/]+)$/);
    if (request.method === "GET" && graphClaimMatch?.[1]) {
      return handleGetGraphClaim(decodeRouteParam(graphClaimMatch[1]), env);
    }

    const graphConnectionReviewMatch = url.pathname.match(/^\/api\/graph\/connections\/([^/]+)\/review$/);
    if (request.method === "POST" && graphConnectionReviewMatch?.[1]) {
      return handleReviewGraphConnection(decodeRouteParam(graphConnectionReviewMatch[1]), request, env);
    }

    const graphConflictResolveMatch = url.pathname.match(/^\/api\/graph\/conflicts\/([^/]+)\/resolve$/);
    if (request.method === "POST" && graphConflictResolveMatch?.[1]) {
      return handleResolveGraphConflict(decodeRouteParam(graphConflictResolveMatch[1]), request, env);
    }

    const graphClaimPinMatch = url.pathname.match(/^\/api\/graph\/claims\/([^/]+)\/pin$/);
    if (request.method === "POST" && graphClaimPinMatch?.[1]) {
      return handleSetGraphClaimPreference(decodeRouteParam(graphClaimPinMatch[1]), request, env, "pin");
    }

    const graphClaimExcludeMatch = url.pathname.match(/^\/api\/graph\/claims\/([^/]+)\/exclude-from-synthesis$/);
    if (request.method === "POST" && graphClaimExcludeMatch?.[1]) {
      return handleSetGraphClaimPreference(decodeRouteParam(graphClaimExcludeMatch[1]), request, env, "exclude");
    }

    return json({ error: "Not found" }, 404);
  },

  async queue(batch: MessageBatch<{ workItemId: string }>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        await processWorkItem(message.body.workItemId, env);
        // Keep a sectioned document moving without waiting for the next
        // one-minute Cron after every section completion. The router remains
        // bounded and every new Queue message still contains only workItemId.
        await routeAndMaybeExecuteLoop(env);
        message.ack();
      }),
    );
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledLoopMaintenance(env));
  },
} satisfies ExportedHandler<Env, { workItemId: string }>;

async function runScheduledLoopMaintenance(env: Env): Promise<void> {
  if (!env.MEMORY_GENERATION_QUEUE) {
    throw new Error("MEMORY_GENERATION_QUEUE is required for scheduled loop maintenance.");
  }
  const result = await maintainLoop({
    persistence: createLoopPersistence(env),
    queue: env.MEMORY_GENERATION_QUEUE,
    tenantId: DEFAULT_TENANT_ID,
    maxRows: 4,
    recoveredWorkLimit: 25,
  });
  console.log(JSON.stringify({
    event: "loop_maintenance_completed",
    recoveredOutboxCount: result.recoveredOutboxCount,
    terminalOutboxCount: result.terminalOutboxCount,
    recoveredWorkCount: result.recoveredWorkCount,
    terminalWorkCount: result.terminalWorkCount,
    suppressedSeedOutboxCount: result.suppressedSeedOutboxCount,
    cancelledSeedWorkCount: result.cancelledSeedWorkCount,
    routedWorkCount: result.routedWorkItems.length,
  }));
}

async function handleSlackInteractions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (
    !env.SLACK_BOT_TOKEN ||
    !env.SLACK_SIGNING_SECRET ||
    !env.SLACK_ALLOWED_TEAM_ID ||
    !env.SLACK_ALLOWED_CHANNEL_IDS ||
    !env.SLACK_ALLOWED_USER_IDS ||
    !env.MEMORY_GENERATION_QUEUE ||
    (env.SLACK_SAVED_REACTION?.trim() ?? SLACK_SAVED_REACTION) !== SLACK_SAVED_REACTION ||
    (env.SLACK_PROCESSING_REACTION?.trim() ?? SLACK_PROCESSING_REACTION) !== SLACK_PROCESSING_REACTION
  ) {
    return json({ error: "slack_connector_not_configured" }, 503);
  }
  return handleSlackMessageAction({
    request,
    tenantId: DEFAULT_TENANT_ID,
    config: {
      signingSecret: env.SLACK_SIGNING_SECRET,
      allowedTeamId: env.SLACK_ALLOWED_TEAM_ID,
      allowedChannelIds: parseCsvAllowlist(env.SLACK_ALLOWED_CHANNEL_IDS),
      allowedUserIds: parseCsvAllowlist(env.SLACK_ALLOWED_USER_IDS),
    },
    persistence: createLoopPersistence(env),
    ...(env.MEMORY_GENERATION_QUEUE ? { queue: env.MEMORY_GENERATION_QUEUE } : {}),
    onRegistered: async (result) => {
      await new SlackWebClient(env.SLACK_BOT_TOKEN!).addReaction({
        channelId: result.save.channelId,
        messageTimestamp: result.save.messageTimestamp,
        reaction: SLACK_PROCESSING_REACTION,
      });
    },
    waitUntil: (promise) => ctx.waitUntil(promise),
    logger: (fields) => console.log(JSON.stringify(fields)),
  });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let password = "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { password?: string };
    password = body.password ?? "";
  } else {
    const formData = await request.formData();
    password = String(formData.get("password") ?? "");
  }

  if (!await isPasswordValid(password, env)) {
    return json({ error: "Invalid password" }, 401);
  }

  const token = await sessionToken(env);
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": sessionCookie(token),
    },
  });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": expiredSessionCookie(),
    },
  });
}

async function handleCreateIngestion(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.json();
  const input = CaptureInputSchema.parse(body);

  if (input.mode === "ask") {
    return json(
      {
        error: "Cited recall is implemented in Slice 3. v0 Slice 1 currently accepts Remember text braindumps.",
      },
      422,
    );
  }

  const repository = createRepository(env);
  const appSessionId = await sessionToken(env);
  const command = {
    mode: "remember" as const,
    text: input.text,
    idempotencyKey: input.idempotencyKey ?? await requestId(input.text),
    appSessionId,
    tenantId: DEFAULT_TENANT_ID,
    ...(input.submittedByLabel ? { submittedByLabel: input.submittedByLabel } : {}),
  };

  const receipt = await submitTextCapture({
    command,
    repository,
  });

  ctx.waitUntil(routeAndMaybeExecuteLoop(env, receipt.sourceVersionId));

  return json(receipt, 202);
}

async function handleGetIngestion(ingestionId: string, env: Env): Promise<Response> {
  const result = await createRepository(env).getIngestionResult(ingestionId);
  return json(result);
}

async function handleRetryIngestion(ingestionId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const persistence = createLoopPersistence(env);
  const workItemIds = await persistence.retryMemorySectionIngestion(ingestionId);
  console.log(JSON.stringify({
    event: "memory_section_ingestion_retried",
    ingestionId,
    resumedWorkItemCount: workItemIds.length,
  }));
  if (env.MEMORY_GENERATION_QUEUE) {
    ctx.waitUntil(Promise.all(workItemIds.map((workItemId) => env.MEMORY_GENERATION_QUEUE!.send({ workItemId }))));
  } else {
    ctx.waitUntil(Promise.all(workItemIds.map((workItemId) => processWorkItem(workItemId, env))));
  }
  return json({ ingestionId, resumedWorkItemCount: workItemIds.length }, 202);
}

async function handleRecallQuery(request: Request, env: Env): Promise<Response> {
  const query = RecallQueryInputSchema.parse(await request.json());

  try {
    const graphContext = await retrieveMemoryContext({
      tenantId: DEFAULT_TENANT_ID,
      profile: "ask",
      queryText: query.question,
      embeddingModel: createEmbeddingModel(env),
      rerankerModel: createRetrievalRerankerModel(env),
      persistence: createLoopPersistence(env),
    });
    if (graphContext.claims.length === 0) {
      return json(retrievalGapAnswer({
        question: query.question,
        reason: "No evidence-backed memory matched the question.",
        retrievalMetadata: graphContext.metadata,
      }));
    }

    const evidenceSpans = uniqueEvidenceSpans(graphContext.claims.flatMap((claim) => claim.evidenceSpans));
    try {
      const grounded = await new OpenRouterGroundedAnswerModel(openRouterConfig(env, {
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })).generateGroundedAnswer({
        question: query.question,
        claims: graphContext.claims,
        evidenceSpans,
        conflicts: graphContext.conflicts,
      });

      return json(graphAnswerToCitedAnswer({
        question: query.question,
        graphContext,
        evidenceSpans,
        answer: grounded,
      }));
    } catch (error) {
      const reason = `Grounded answer generation failed: ${error instanceof Error ? error.message : String(error)}`;
      const fallback = buildDeterministicCitedAnswer({
        question: query.question,
        matches: graphContext.claims.map((claim) => ({
          rank: claim.rank,
          memoryItem: claim.claim,
          evidenceSpans: claim.evidenceSpans,
        })),
      });

      return json({
        ...fallback,
        gap: reason,
        conflicts: graphContext.conflicts,
        warnings: [reason, ...fallback.warnings],
        retrievalMetadata: graphContext.metadata,
        answerMetadata: {
          strategy: "deterministic-grounded-fallback",
          fallbackReason: reason,
        },
      });
    }
  } catch (error) {
    return json(retrievalGapAnswer({
      question: query.question,
      reason: `Retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`,
      retrievalMetadata: {
        strategy: "hybrid-graph-ppr-rerank",
        profile: "ask",
        degraded: true,
      },
    }));
  }
}

async function handleListActiveMemory(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 200;
  const memory = await createRepository(env).listActiveMemory({ limit });
  return json(memory);
}

async function handleListPendingMemoryProposals(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const proposals = await listPendingMemoryProposals(env, limit);
  return json(proposals);
}

async function handleLoopStatus(url: URL, env: Env): Promise<Response> {
  const ingestionId = url.searchParams.get("ingestionId")?.trim() || undefined;
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
  const status = await createLoopPersistence(env).getLoopStatus({
    tenantId: DEFAULT_TENANT_ID,
    ...(ingestionId ? { ingestionId } : {}),
    limit,
  });
  return json(status);
}

async function handleListGraphClusters(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const clusters = await createLoopPersistence(env).listGraphClusters({
    tenantId: DEFAULT_TENANT_ID,
    limit,
  });
  return json(clusters);
}

async function handleGetGraphCluster(clusterId: string, env: Env): Promise<Response> {
  const cluster = await createLoopPersistence(env).getGraphCluster({
    tenantId: DEFAULT_TENANT_ID,
    clusterId,
  });
  return json(cluster);
}

async function handleGetGraphClaim(claimId: string, env: Env): Promise<Response> {
  const claim = await createLoopPersistence(env).getGraphClaim({
    tenantId: DEFAULT_TENANT_ID,
    claimId,
  });
  return json(claim);
}

async function handleReviewGraphConnection(connectionId: string, request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    status?: "accepted" | "rejected";
    reviewerLabel?: string;
    rationale?: string;
  };
  if (body.status !== "accepted" && body.status !== "rejected") {
    return json({ error: "Connection review status must be accepted or rejected." }, 422);
  }
  const result = await createLoopPersistence(env).reviewClaimConnection({
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    status: body.status,
    reviewerLabel: body.reviewerLabel?.trim() || "graph-reviewer",
    ...(body.rationale ? { rationale: body.rationale } : {}),
  });
  return json(result);
}

async function handleResolveGraphConflict(conflictGroupId: string, request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    resolutionType?: string;
    winningClaimId?: string;
    reviewerLabel?: string;
    rationale?: string;
  };
  if (!body.resolutionType?.trim() || !body.rationale?.trim()) {
    return json({ error: "Conflict resolution requires resolutionType and rationale." }, 422);
  }
  const result = await createLoopPersistence(env).resolveConflict({
    tenantId: DEFAULT_TENANT_ID,
    conflictGroupId,
    resolutionId: newId("cres"),
    resolutionType: body.resolutionType,
    ...(body.winningClaimId ? { winningClaimId: body.winningClaimId } : {}),
    reviewerLabel: body.reviewerLabel?.trim() || "graph-reviewer",
    rationale: body.rationale,
  });
  return json(result);
}

async function handleSetGraphClaimPreference(
  claimId: string,
  request: Request,
  env: Env,
  mode: "pin" | "exclude",
): Promise<Response> {
  const body = await request.json() as {
    value?: boolean;
    reviewerLabel?: string;
    rationale?: string;
  };
  const value = body.value ?? true;
  const result = await createLoopPersistence(env).setGraphClaimPreference({
    tenantId: DEFAULT_TENANT_ID,
    claimId,
    ...(mode === "pin" ? { pinned: value } : { excludeFromSynthesis: value }),
    reviewerLabel: body.reviewerLabel?.trim() || "graph-reviewer",
    ...(body.rationale ? { rationale: body.rationale } : {}),
  });
  return json(result);
}

async function handleGraphRebuild(env: Env): Promise<Response> {
  const result = await createLoopPersistence(env).rebuildGraphProjection({
    tenantId: DEFAULT_TENANT_ID,
  });
  return json(result);
}

async function handleListInitiativeBriefs(env: Env): Promise<Response> {
  const briefs = await createRepository(env).listInitiativeBriefs({ limit: 50 });
  return json(briefs);
}

async function handleListLeadershipBriefs(env: Env): Promise<Response> {
  return json(await createRepository(env).listLeadershipBriefs({ limit: 50 }));
}

async function handleGetLeadershipBrief(briefId: string, env: Env): Promise<Response> {
  try {
    return json(await createRepository(env).getLeadershipBrief(briefId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("leadership brief not found")) return json({ error: "Brief not found" }, 404);
    throw error;
  }
}

async function handleListSynthesisOpportunities(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const corpus = await createLoopPersistence(env).getCorpusSynthesisState({
    tenantId: DEFAULT_TENANT_ID,
    limit: 500,
  });
  const opportunities = corpus.clusters
    .filter((cluster) => cluster.readiness?.state !== "superseded")
    .sort((left, right) => (right.readiness?.score ?? -1) - (left.readiness?.score ?? -1) || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((cluster) => ({
      cluster,
      suggestedDrafts: corpus.suggestedBriefs
        .filter((suggestion) => suggestion.clusterId === cluster.id)
        .map((suggestion) => ({
          ...suggestion,
          changesSincePreviousVersion: summarizeSuggestedBriefChanges(suggestion),
        })),
      dossier: buildClusterDossier({
        cluster,
        memory: corpus.memory,
        connections: corpus.connections,
        conflicts: corpus.conflicts,
        retrievalMetadata: { surface: "/synthesis", corpusWide: true },
      }),
    }));
  return json(opportunities);
}

function summarizeSuggestedBriefChanges(suggestion: SuggestedBrief): string[] {
  if (!suggestion.previousVersion) return ["Initial suggested version."];
  const draft = suggestion.draft as unknown as Record<string, unknown>;
  const previousDraft = suggestion.previousVersion.draft as unknown as Record<string, unknown>;
  const labels: Record<string, string> = {
    title: "title",
    problem: "problem",
    proposal: "proposed action",
    scope: "scope",
    successMetric: "success metric",
    risksAndDependencies: "risks and dependencies",
    contradictionsOrUncertainties: "contradictions or uncertainties",
  };
  const changed = Object.entries(labels)
    .filter(([field]) => JSON.stringify(draft[field]) !== JSON.stringify(previousDraft[field]))
    .map(([, label]) => `Changed ${label}.`);
  return changed.length > 0 ? changed : ["No factual draft fields changed."];
}

async function handleGenerateInitiativeBriefDraft(request: Request, env: Env): Promise<Response> {
  try {
    const parsedInput = InitiativeBriefDraftInputSchema.safeParse(await request.json());
    if (!parsedInput.success) {
      return json(
        {
          error: `Select between 1 and ${MAX_DRAFT_MEMORY_ITEMS} memory items for a focused draft.`,
          issues: parsedInput.error.issues,
        },
        422,
      );
    }

    const input = parsedInput.data;
    const repository = createRepository(env);
    let selectedMemoryWithEvidence: MemoryWithEvidence[];
    let synthesisBundle: ReturnType<typeof buildSynthesisBundle>["bundle"] | null = null;
    let retrievalMetadata: Record<string, unknown> | null = null;

    if (input.expandRelatedMemory) {
      const retrievalContext = await retrieveMemoryContext({
        tenantId: DEFAULT_TENANT_ID,
        profile: "synthesis",
        queryText: input.intent?.trim() || `Draft around selected memory ${input.memoryItemIds.join(", ")}.`,
        seedMemoryItemIds: input.memoryItemIds,
        embeddingModel: createEmbeddingModel(env),
        rerankerModel: createRetrievalRerankerModel(env),
        persistence: createLoopPersistence(env),
      });
      const expanded = buildSynthesisBundle({
        seedMemoryItemIds: input.memoryItemIds,
        memory: retrievalContext.claims.map((claim) => ({
          memoryItem: claim.claim,
          evidenceSpans: claim.evidenceSpans,
        })),
        maxMemoryItems: 32,
      });
      selectedMemoryWithEvidence = expanded.selectedMemory;
      synthesisBundle = expanded.bundle;
      retrievalMetadata = retrievalContext.metadata;
    } else {
      const activeMemory = await repository.listActiveMemory({ limit: 200 });
      selectedMemoryWithEvidence = input.memoryItemIds
        .map((memoryItemId) => activeMemory.find((record) => record.memoryItem.id === memoryItemId))
        .filter((record): record is MemoryWithEvidence => Boolean(record));
    }

    const missingMemoryItemId = input.memoryItemIds.find((memoryItemId) =>
      !selectedMemoryWithEvidence.some((record) => record.memoryItem.id === memoryItemId)
    );

    if (missingMemoryItemId) {
      return json({ error: `Selected memory is not active or was not found: ${missingMemoryItemId}` }, 422);
    }

    const memoryItems = selectedMemoryWithEvidence.map((record) => record.memoryItem);
    const evidenceSpans = uniqueEvidenceSpans(selectedMemoryWithEvidence.flatMap((record) => record.evidenceSpans));
    try {
      const generated = await new OpenRouterInitiativeBriefDraftModel(openRouterConfig(env, {
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      }))
        .generateInitiativeBriefDraft({
          memoryItems,
          evidenceSpans,
          ...(input.intent ? { intent: input.intent } : {}),
        });

      const validation = validateInitiativeBriefDraftTraceability({
        draft: generated.parsed,
        selectedMemoryItems: memoryItems,
        selectedEvidenceSpans: evidenceSpans,
      });

      if (validation.ok) {
        return json({
          ...generated.parsed,
          model: generated.model,
          includedMemory: selectedMemoryWithEvidence.map((record) => record.memoryItem),
          includedEvidenceSpans: evidenceSpans,
          ...(synthesisBundle ? { synthesisBundle } : {}),
          ...(retrievalMetadata ? { retrievalMetadata } : {}),
        });
      }

      const fallbackDraft = buildDeterministicInitiativeBriefDraft({
        memoryItems,
        evidenceSpans,
        ...(input.intent ? { intent: input.intent } : {}),
        fallbackReason: validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
      return json({
        ...fallbackDraft,
        includedMemory: selectedMemoryWithEvidence.map((record) => record.memoryItem),
        includedEvidenceSpans: evidenceSpans,
        ...(synthesisBundle ? { synthesisBundle } : {}),
        ...(retrievalMetadata ? { retrievalMetadata } : {}),
      });
    } catch (error) {
      const fallbackDraft = buildDeterministicInitiativeBriefDraft({
        memoryItems,
        evidenceSpans,
        ...(input.intent ? { intent: input.intent } : {}),
        fallbackReason: error instanceof Error ? error.message : String(error),
      });
      return json({
        ...fallbackDraft,
        includedMemory: selectedMemoryWithEvidence.map((record) => record.memoryItem),
        includedEvidenceSpans: evidenceSpans,
        ...(synthesisBundle ? { synthesisBundle } : {}),
        ...(retrievalMetadata ? { retrievalMetadata } : {}),
      });
    }
  } catch (error) {
    return json(
      {
        error: "Draft generation failed. Try fewer, more closely related memory items.",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

async function handleCreateInitiativeBrief(request: Request, env: Env): Promise<Response> {
  const input = CreateInitiativeBriefInputSchema.parse(await request.json());
  const brief = await createRepository(env).createInitiativeBrief({
    briefId: newId("brief"),
    brief: input,
  });

  return json(brief, 201);
}

async function handleGetInitiativeBrief(briefId: string, env: Env): Promise<Response> {
  const brief = await createRepository(env).getInitiativeBrief(briefId);
  return json(brief);
}

async function handleUpdateInitiativeBrief(briefId: string, request: Request, env: Env): Promise<Response> {
  const input = UpdateInitiativeBriefInputSchema.parse(await request.json());
  const brief = await createRepository(env).updateInitiativeBrief({ briefId, brief: input });
  return json(brief);
}

async function handleGenerateClusterDraft(
  clusterId: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.json() as { intent?: string };
  const intent = body.intent?.trim() || "initiative_brief";
  const persistence = createLoopPersistence(env);
  const corpus = await persistence.getCorpusSynthesisState({ tenantId: DEFAULT_TENANT_ID, limit: 500 });
  const cluster = corpus.clusters.find((candidate) => candidate.id === clusterId);
  if (!cluster) return json({ error: `Synthesis cluster not found: ${clusterId}` }, 404);
  const event = await persistence.commitLedgerEventWithOutbox({
    id: newId("levt"),
    tenantId: DEFAULT_TENANT_ID,
    eventType: "synthesis_ready",
    subjectType: "cluster",
    subjectId: cluster.id,
    actorType: "human",
    actorLabel: "synthesis-reviewer",
    inputVersion: cluster.version,
    idempotencyKey: `manual-synthesis:${cluster.id}:${cluster.version}:${intent.toLowerCase()}`,
    payload: { clusterId: cluster.id, clusterVersion: cluster.version, generationIntent: intent },
  });
  ctx.waitUntil(routeAndMaybeExecuteLoop(env));
  return json({ accepted: true, event, clusterId: cluster.id, clusterVersion: cluster.version, generationIntent: intent }, 202);
}

async function handleInitiativeBriefDecision(briefId: string, request: Request, env: Env): Promise<Response> {
  const decision = InitiativeBriefDecisionInputSchema.parse(await request.json());
  const brief = await createRepository(env).recordInitiativeBriefDecision({
    briefId,
    decisionId: newId("bdec"),
    decision,
  });

  return json(brief);
}

async function handleProposedEventDecision(
  proposedEventId: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const decision = HumanReviewDecisionSchema.parse(await request.json());
  const persistence = createLoopPersistence(env);
  const reviewDecision = {
    reviewerLabel: decision.reviewerLabel,
    ...(decision.rationale ? { rationale: decision.rationale } : {}),
  };
  const proposal = decision.decision === "approve"
    ? await persistence.approveProposedEvent(proposedEventId, reviewDecision)
    : await persistence.rejectProposedEvent(proposedEventId, reviewDecision);

  if (decision.decision === "reject") return json({ proposal });

  const ledgerEvent = await persistence.commitValidatedProposedEvent(proposedEventId);
  await persistence.rebuildGraphProjection({ tenantId: DEFAULT_TENANT_ID });
  ctx.waitUntil(routeAndMaybeExecuteLoop(env));
  return json({ proposal, ledgerEvent });
}

async function handleMemoryItemAction(
  memoryItemId: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const action = MemoryItemActionInputSchema.parse(await request.json());
  const repository = createRepository(env);
  const result = await applyMemoryItemAction({
    memoryItemId,
    action,
    repository,
  });

  const history = await repository.getMemoryItemHistory(memoryItemId);
  const latestHistoryEvent = history.events[history.events.length - 1];
  if (latestHistoryEvent) {
    const replacementId = latestHistoryEvent.replacementMemoryItemId ?? undefined;
    await createLoopPersistence(env).commitLedgerEventWithOutbox({
      id: newId("levt"),
      tenantId: DEFAULT_TENANT_ID,
      eventType: action.action === "confirm" ? "memory_confirmed" : action.action === "edit" ? "memory_edited" : "memory_removed",
      subjectType: "memory",
      subjectId: memoryItemId,
      actorType: "human",
      actorLabel: action.reviewerLabel,
      inputVersion: latestHistoryEvent.id,
      idempotencyKey: `memory-review:${latestHistoryEvent.id}`,
      payload: {
        memoryItemIds: [memoryItemId, ...(replacementId ? [replacementId] : [])],
        action: action.action,
        historyEventId: latestHistoryEvent.id,
        ...(replacementId ? { replacementMemoryItemId: replacementId } : {}),
      },
    });
    ctx.waitUntil(routeAndMaybeExecuteLoop(env));
  }

  return json(result);
}

async function handleMemoryItemHistory(memoryItemId: string, env: Env): Promise<Response> {
  const result = await createRepository(env).getMemoryItemHistory(memoryItemId);
  return json(result);
}

async function routeAndMaybeExecuteLoop(env: Env, preferredSubjectId?: string): Promise<void> {
  const persistence = createLoopPersistence(env);
  const workItems = await routeCommittedEvents({
    persistence,
    maxRows: 4,
    ...(preferredSubjectId ? { preferredSubjectId } : {}),
    ...(env.MEMORY_GENERATION_QUEUE ? { queue: env.MEMORY_GENERATION_QUEUE } : {}),
  });

  if (!env.MEMORY_GENERATION_QUEUE) {
    await Promise.all(workItems.map((workItem) => processWorkItem(workItem.id, env)));
  }
}

async function processWorkItem(workItemId: string, env: Env): Promise<void> {
  const persistence = createLoopPersistence(env);
  const embeddingModel = createEmbeddingModel(env);
  const slackClient = env.SLACK_BOT_TOKEN ? new SlackWebClient(env.SLACK_BOT_TOKEN) : undefined;
  const executed = await executeWorkItem({
    persistence,
    policies: createPolicies({
      persistence,
      memoryModel: new OpenRouterMemoryGenerationModel(openRouterConfig(env, {
        modelOverride: env.MEMORY_EXTRACTOR_MODEL,
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })),
      memorySectionPlannerModel: new OpenRouterMemorySectionPlannerModel(openRouterConfig(env, {
        modelOverride: env.MEMORY_SECTION_PLANNER_MODEL,
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })),
      memorySectioningConfig: {
        enabled: parseBoolean(env.MEMORY_SECTIONING_ENABLED, true),
        triggerChars: parsePositiveInteger(env.MEMORY_SECTION_TRIGGER_CHARS) ?? 6_000,
        triggerSpans: parsePositiveInteger(env.MEMORY_SECTION_TRIGGER_SPANS) ?? 20,
        targetChars: parsePositiveInteger(env.MEMORY_SECTION_TARGET_CHARS) ?? 5_000,
        maxChars: parsePositiveInteger(env.MEMORY_SECTION_MAX_CHARS) ?? 8_000,
        maxSections: parsePositiveInteger(env.MEMORY_SECTION_MAX_SECTIONS) ?? 50,
      },
      memoryVerifierModel: new OpenRouterMemoryCandidateVerifierModel(openRouterConfig(env, {
        modelOverride: env.MEMORY_VERIFIER_MODEL,
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })),
      memoryConnectionScorerModel: new OpenRouterMemoryConnectionScorerModel(openRouterConfig(env, {
        modelOverride: env.MEMORY_CONNECTION_MODEL,
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })),
      ...(embeddingModel ? { embeddingModel } : {}),
      retrievalRerankerModel: createRetrievalRerankerModel(env),
      initiativeBriefDraftModel: new OpenRouterInitiativeBriefDraftModel(openRouterConfig(env, {
        maxPrimaryTimeoutMs: 60_000,
        maxFallbackTimeoutMs: 45_000,
        maxFallbackModels: 1,
      })),
      connectorPolicyRunner: {
        async ingestSlackSource(saveId) {
          if (!slackClient) throw new Error("SLACK_BOT_TOKEN is required for Slack connector work.");
          return ingestSlackSource({
            saveId,
            persistence,
            slack: slackClient,
            reaction: SLACK_SAVED_REACTION,
            processingReaction: SLACK_PROCESSING_REACTION,
            ...(env.MEMORY_GENERATION_QUEUE ? { queue: env.MEMORY_GENERATION_QUEUE } : {}),
          });
        },
        async syncSlackReaction(saveId) {
          if (!slackClient) throw new Error("SLACK_BOT_TOKEN is required for Slack reaction work.");
          return syncSlackReaction({
            saveId,
            persistence,
            slack: slackClient,
            reaction: SLACK_SAVED_REACTION,
            processingReaction: SLACK_PROCESSING_REACTION,
            ...(env.MEMORY_GENERATION_QUEUE ? { queue: env.MEMORY_GENERATION_QUEUE } : {}),
          });
        },
      },
    }),
    workItemId,
  });

  if (!executed) return;
  const reactionWork = await persistence.listSlackReactionWorkForCompletedWork(executed.workItem.id);
  if (env.MEMORY_GENERATION_QUEUE) {
    await Promise.all(reactionWork.map((work) => env.MEMORY_GENERATION_QUEUE!.send({ workItemId: work.id })));
  } else {
    await Promise.all(reactionWork.map((work) => processWorkItem(work.id, env)));
  }
}

function createEmbeddingModel(env: Env): OpenRouterEmbeddingModel | undefined {
  if ((env.EMBEDDING_PROVIDER ?? "openrouter") !== "openrouter") return undefined;
  const model = env.EMBEDDING_MODEL?.trim();
  const baseUrl = env.EMBEDDING_BASE_URL?.trim() || env.OPENROUTER_BASE_URL;
  const dimensions = parsePositiveInteger(env.EMBEDDING_DIMENSIONS) ?? 1536;
  if (!model || !baseUrl) return undefined;

  return new OpenRouterEmbeddingModel({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl,
    model,
    dimensions,
    ...(env.EMBEDDING_ENCODING_FORMAT === "float" ? { encodingFormat: "float" as const } : {}),
    timeoutMs: 30_000,
  });
}

function createRetrievalRerankerModel(env: Env): OpenRouterRetrievalRerankerModel {
  return new OpenRouterRetrievalRerankerModel(openRouterConfig(env, {
    maxPrimaryTimeoutMs: 45_000,
    maxFallbackTimeoutMs: 30_000,
    maxFallbackModels: 1,
  }));
}

function createRepository(env: Env): SupabaseMemoryGenerationRepository {
  return new SupabaseMemoryGenerationRepository(
    new SupabaseRpcClient({
      supabaseUrl: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    }),
  );
}

function createLoopPersistence(env: Env): SupabaseLoopPersistence {
  return new SupabaseLoopPersistence(
    new SupabaseRpcClient({
      supabaseUrl: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    }),
  );
}

async function listPendingMemoryProposals(env: Env, limit: number): Promise<ProposedEvent[]> {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/proposed_events`);
  url.searchParams.set("select", "*");
  url.searchParams.set("proposed_event_type", "eq.memory_proposed");
  url.searchParams.set("target_event_type", "eq.memory_committed");
  url.searchParams.set("validation_status", "eq.valid");
  url.searchParams.set("review_status", "eq.pending");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase REST proposed_events failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const rows = JSON.parse(text) as Array<Record<string, unknown>>;
  return ProposedEventSchema.array().parse(rows.map(proposedEventRowToContract));
}

function proposedEventRowToContract(row: Record<string, unknown>): ProposedEvent {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    workItemId: nullableString(row.work_item_id),
    policyRunId: nullableString(row.policy_run_id),
    proposedEventType: String(row.proposed_event_type) as ProposedEvent["proposedEventType"],
    targetEventType: String(row.target_event_type) as ProposedEvent["targetEventType"],
    subjectType: String(row.subject_type) as ProposedEvent["subjectType"],
    subjectId: String(row.subject_id),
    payload: objectRecord(row.payload),
    evidenceSpanIds: stringArray(row.evidence_span_ids),
    memoryItemIds: stringArray(row.memory_item_ids),
    decisionIds: stringArray(row.decision_ids),
    requiresHumanApproval: Boolean(row.requires_human_approval),
    validationStatus: String(row.validation_status) as ProposedEvent["validationStatus"],
    validationIssues: Array.isArray(row.validation_issues) ? row.validation_issues : [],
    reviewStatus: String(row.review_status) as ProposedEvent["reviewStatus"],
    reviewerLabel: nullableString(row.reviewer_label),
    reviewRationale: nullableString(row.review_rationale),
    committedLedgerEventId: nullableString(row.committed_ledger_event_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCommaSeparatedList(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined || input.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(input.trim().toLowerCase());
}

function openRouterConfig(
  env: Env,
  options: {
    modelOverride?: string | undefined;
    maxPrimaryTimeoutMs?: number;
    maxFallbackTimeoutMs?: number;
    maxFallbackModels?: number;
  } = {},
): OpenRouterModelConfig {
  const timeoutMs = parsePositiveInteger(env.OPENROUTER_TIMEOUT_MS);
  const fallbackTimeoutMs = parsePositiveInteger(env.OPENROUTER_FALLBACK_TIMEOUT_MS);
  const fallbackModels = parseCommaSeparatedList(env.OPENROUTER_FALLBACK_MODELS);

  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: options.modelOverride?.trim() || env.OPENROUTER_MODEL,
    fallbackModels: typeof options.maxFallbackModels === "number"
      ? fallbackModels.slice(0, options.maxFallbackModels)
      : fallbackModels,
    ...(timeoutMs
      ? { timeoutMs: options.maxPrimaryTimeoutMs ? Math.min(timeoutMs, options.maxPrimaryTimeoutMs) : timeoutMs }
      : options.maxPrimaryTimeoutMs
        ? { timeoutMs: options.maxPrimaryTimeoutMs }
        : {}),
    ...(fallbackTimeoutMs
      ? {
        fallbackTimeoutMs: options.maxFallbackTimeoutMs
          ? Math.min(fallbackTimeoutMs, options.maxFallbackTimeoutMs)
          : fallbackTimeoutMs,
      }
      : options.maxFallbackTimeoutMs
        ? { fallbackTimeoutMs: options.maxFallbackTimeoutMs }
        : {}),
  };
}

function uniqueEvidenceSpans<T extends { id: string }>(spans: T[]): T[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    if (seen.has(span.id)) return false;
    seen.add(span.id);
    return true;
  });
}

function graphAnswerToCitedAnswer(args: {
  question: string;
  graphContext: GraphRecallContext;
  evidenceSpans: EvidenceSpan[];
  answer: {
    answer: string;
    citations: Array<{ evidenceSpanId: string; claimIds: string[] }>;
    usedEvidenceSpanIds: string[];
    warnings: string[];
    gap?: string | undefined;
    model: string;
  };
}): CitedAnswer {
  const citationEvidenceIds = uniqueStrings([
    ...args.answer.usedEvidenceSpanIds,
    ...args.answer.citations.map((citation) => citation.evidenceSpanId),
  ]);
  const citations = citationEvidenceIds
    .map((evidenceSpanId) => args.evidenceSpans.find((span) => span.id === evidenceSpanId))
    .filter((span): span is EvidenceSpan => Boolean(span))
    .map((span) => ({
      evidenceSpanId: span.id,
      sourceVersionId: span.sourceVersionId,
      lineRange: `${span.startLine}-${span.endLine}`,
      text: span.text,
    }));

  return {
    question: args.question,
    answer: args.answer.answer,
    evidenceSpanIds: citations.map((citation) => citation.evidenceSpanId),
    citations,
    matches: args.graphContext.claims.map((claim) => ({
      rank: claim.rank,
      memoryItem: claim.claim,
      evidenceSpans: claim.evidenceSpans,
    })),
    ...(args.answer.gap ? { gap: args.answer.gap } : {}),
    conflicts: args.graphContext.conflicts,
    warnings: args.answer.warnings,
    retrievalMetadata: args.graphContext.metadata,
    answerMetadata: {
      model: args.answer.model,
      strategy: "grounded-answer",
    },
  };
}

function retrievalGapAnswer(args: {
  question: string;
  reason: string;
  retrievalMetadata: Record<string, unknown>;
}): CitedAnswer {
  return {
    question: args.question,
    answer: "",
    evidenceSpanIds: [],
    citations: [],
    matches: [],
    gap: args.reason,
    conflicts: [],
    warnings: [args.reason],
    retrievalMetadata: args.retrievalMetadata,
    answerMetadata: {
      strategy: "no-lexical-fallback",
    },
  };
}

function buildDeterministicInitiativeBriefDraft(args: {
  memoryItems: Array<{
    id: string;
    claimType: string;
    statement: string;
    evidenceSpanIds: string[];
    epistemicStatus: string;
    stableDomainTags?: string[];
  }>;
  evidenceSpans: Array<{ id: string; text: string }>;
  intent?: string;
  fallbackReason: string;
}) {
  const memoryItemIds = args.memoryItems.map((item) => item.id);
  const evidenceSpanIds = uniqueStrings(args.memoryItems.flatMap((item) => item.evidenceSpanIds));
  const firstStatement = args.memoryItems[0]?.statement ?? "Selected Stable memory";
  const statementSummary = truncate(args.memoryItems.map((item) => item.statement).join(" "), 1_200);
  const evidenceSummary = truncate(args.evidenceSpans.map((span) => span.text).join(" "), 1_000);
  const tags = uniqueStrings(args.memoryItems.flatMap((item) => item.stableDomainTags ?? []));
  const titleSource = args.intent?.trim() || firstStatement;

  return {
    title: truncate(`Review: ${titleSource}`, 200),
    problem: truncate(`Selected memory indicates: ${statementSummary}`, 4_000),
    proposal: truncate(
      "Use the selected evidence as a review packet. Confirm whether this should become an initiative, identify the owner and scope, and refine the draft before approval.",
      4_000,
    ),
    scope: truncate(`Review only the selected ${memoryItemIds.length} memory items and their cited evidence.`, 3_000),
    successMetric: truncate(
      "A reviewer can approve or reject this brief with every claim traced to the selected memory; a concrete product outcome metric still needs human definition.",
      2_000,
    ),
    risksAndDependencies: truncate(
      [
        "Fallback draft generated because AI synthesis did not produce a valid traceable draft.",
        `Reason: ${args.fallbackReason}`,
        tags.length > 0 ? `Tags: ${tags.join(", ")}` : undefined,
        evidenceSummary ? `Evidence summary: ${evidenceSummary}` : undefined,
      ].filter(Boolean).join(" "),
      3_000,
    ),
    contradictionsOrUncertainties: ["This deterministic fallback could not validate a model-generated synthesis; human review is required."],
    memoryItemIds,
    evidenceSpanIds,
    model: "deterministic-fallback",
    fallbackReason: args.fallbackReason,
  };
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const session = getCookieValue(request, SESSION_COOKIE_NAME);
  if (!session) return false;

  const expectedSession = await sessionToken(env);
  return timingSafeEqual(
    await sha256Hex(`distillery-session-check:${session}`),
    await sha256Hex(`distillery-session-check:${expectedSession}`),
  );
}

async function isPasswordValid(candidate: string | undefined, env: Env): Promise<boolean> {
  if (!candidate) return false;

  return timingSafeEqual(
    await sha256Hex(`distillery-password-check:${candidate}`),
    await sha256Hex(`distillery-password-check:${env.DISTILLERY_APP_PASSWORD}`),
  );
}

function getCookieValue(request: Request, name: string): string | undefined {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")[1];
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

async function sessionToken(env: Env): Promise<string> {
  return sha256Hex(`distillery-v0:${env.DISTILLERY_APP_PASSWORD}`);
}

async function requestId(input: string): Promise<string> {
  return sha256Hex(`text-capture:${input}`);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function html(markup: string): Response {
  return new Response(markup, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function javascript(source: string): Response {
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function renderAppShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Distillery v0</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #f8fafc; }
    main { width: min(820px, calc(100vw - 32px)); }
    .card { background: #111827; border: 1px solid #263244; border-radius: 20px; padding: 24px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { color: #cbd5e1; line-height: 1.5; }
    textarea, input { width: 100%; box-sizing: border-box; border: 1px solid #334155; border-radius: 12px; background: #0f172a; color: #f8fafc; padding: 12px; font: inherit; }
    textarea { min-height: 220px; resize: vertical; }
    button { border: 0; border-radius: 12px; padding: 12px 16px; background: #38bdf8; color: #082f49; font-weight: 700; cursor: pointer; }
    button.secondary { background: #334155; color: #e2e8f0; }
    button:disabled { opacity: .6; cursor: wait; }
    a { color: #7dd3fc; }
    .row { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
    .hidden { display: none; }
    pre { white-space: pre-wrap; word-break: break-word; background: #020617; border-radius: 12px; padding: 16px; overflow: auto; }
    ${loopDrawerStyles()}
  </style>
</head>
<body>
  <main>
    <section class="card" id="login-card">
      <h1>Distillery</h1>
      <p>Enter the shared v0 password.</p>
      <form id="login-form">
        <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
        <div class="row"><button>Enter</button><span id="login-status"></span></div>
      </form>
    </section>

    <section class="card hidden" id="app-card">
      <h1>What should Distillery remember or answer?</h1>
      <p>v0 accepts text braindumps and cited questions. Ask returns stored evidence or an explicit gap.</p>
      <p><a href="/briefs">Briefs</a> · <a href="/synthesis">Memory Synthesis review</a> · <a href="/graph">Graph review</a></p>
      <div class="row"><button id="logout" type="button" class="secondary">Log out</button></div>
      <form id="capture-form">
        <textarea id="text" placeholder="Paste a Stable leadership braindump..."></textarea>
        <div class="row"><button id="remember">Remember</button><button id="ask" type="button">Ask</button><button id="loop-open" type="button" class="secondary loop-button">Loop</button><span id="status"></span></div>
      </form>
      <pre id="result"></pre>
    </section>
  </main>
  ${loopDrawerMarkup()}
  <script>
    const loginCard = document.querySelector("#login-card");
    const appCard = document.querySelector("#app-card");
    const loginForm = document.querySelector("#login-form");
    const captureForm = document.querySelector("#capture-form");
    const askButton = document.querySelector("#ask");
    const logoutButton = document.querySelector("#logout");
    const loginStatusEl = document.querySelector("#login-status");
    const statusEl = document.querySelector("#status");
    const resultEl = document.querySelector("#result");
    const loopController = initLoopDrawer();

    checkSession();

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.querySelector("#password").value;
      const response = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        loginStatusEl.textContent = "Invalid password";
        return;
      }
      showApp();
    });

    logoutButton.addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      showLogin("Logged out");
    });

    captureForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusEl.textContent = "Submitting...";
      resultEl.textContent = "";
      const text = document.querySelector("#text").value;
      const response = await fetch("/api/ingestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "remember", text })
      });
      if (handleUnauthorized(response)) return;
      const receipt = await response.json();
      resultEl.textContent = JSON.stringify(receipt, null, 2);
      if (!response.ok) {
        statusEl.textContent = "Failed";
        return;
      }
      loopController.setActiveIngestion(receipt.ingestionId, true);
      statusEl.textContent = "Processing...";
      poll(receipt.ingestionId);
    });

    askButton.addEventListener("click", async () => {
      statusEl.textContent = "Searching memory...";
      const question = document.querySelector("#text").value;
      const response = await fetch("/api/queries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question })
      });
      if (handleUnauthorized(response)) return;
      const answer = await response.json();
      resultEl.textContent = JSON.stringify(answer, null, 2);
      renderRecallAnswer(answer);
      statusEl.textContent = response.ok ? "Answered" : "Failed";
    });

    async function poll(id) {
      for (let i = 0; i < 900; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await fetch("/api/ingestions/" + encodeURIComponent(id));
        if (handleUnauthorized(response)) return;
        const result = await response.json();
        renderResult(result);
        const loopStatus = await loopController.refresh();
        if (loopStatus?.summary) statusEl.textContent = loopStatus.summary;
        if (result.status === "ready") {
          statusEl.textContent = loopStatus?.isTerminal ? "ready" : "Finalizing loop...";
          if (loopStatus?.isTerminal) return;
          continue;
        }
        statusEl.textContent = result.status;
        if (result.status === "failed") return;
      }
    }

    function renderResult(result) {
      resultEl.textContent = JSON.stringify(result, null, 2);
      let controls = document.querySelector("#memory-controls");
      if (!controls) {
        controls = document.createElement("div");
        controls.id = "memory-controls";
        resultEl.after(controls);
      }
      controls.innerHTML = "";
      if (result.status === "failed") {
        controls.append(actionButton("Retry unfinished work", async () => {
          statusEl.textContent = "Resuming unfinished sections...";
          const response = await fetch("/api/ingestions/" + encodeURIComponent(result.ingestionId) + "/retry", { method: "POST" });
          if (handleUnauthorized(response)) return;
          if (!response.ok) {
            statusEl.textContent = "Retry failed";
            return;
          }
          loopController.setActiveIngestion(result.ingestionId, true);
          poll(result.ingestionId);
        }));
      }
      if (!result.memoryItems || result.memoryItems.length === 0) return;
      for (const item of result.memoryItems) {
        const card = document.createElement("div");
        card.style.border = "1px solid #334155";
        card.style.borderRadius = "12px";
        card.style.padding = "12px";
        card.style.marginTop = "12px";
        card.innerHTML = "<strong>" + escapeHtml(item.claimType) + "</strong><p>" + escapeHtml(item.statement) + "</p><small>" + escapeHtml(item.reviewState || "unreviewed") + " · evidence: " + escapeHtml(item.evidenceSpanIds.join(", ")) + "</small>" + traceDetailsHtml(item);
        const row = document.createElement("div");
        row.className = "row";
        row.append(
          actionButton("Confirm", () => sendMemoryAction(item.id, { action: "confirm", reviewerLabel: reviewerLabel() })),
          actionButton("Edit", () => {
            const statement = prompt("Corrected memory statement", item.statement);
            if (!statement) return;
            sendMemoryAction(item.id, {
              action: "edit",
              reviewerLabel: reviewerLabel(),
              replacement: {
                claimType: item.claimType,
                statement,
                evidenceSpanIds: item.evidenceSpanIds,
                epistemicStatus: item.epistemicStatus,
                qualifiers: item.qualifiers || {},
                stableDomainTags: item.stableDomainTags || [],
                entities: item.entities || [],
                relations: item.relations || [],
                schemas: item.schemas || []
              }
            });
          }),
          actionButton("Remove", () => sendMemoryAction(item.id, { action: "remove", reviewerLabel: reviewerLabel() })),
          actionButton("History", async () => {
            const response = await fetch("/api/memory-items/" + encodeURIComponent(item.id) + "/history");
            if (handleUnauthorized(response)) return;
            const history = await response.json();
            alert(JSON.stringify(history, null, 2));
          })
        );
        card.append(row);
        controls.append(card);
      }
    }

    function renderRecallAnswer(answer) {
      let controls = document.querySelector("#memory-controls");
      if (!controls) {
        controls = document.createElement("div");
        controls.id = "memory-controls";
        resultEl.after(controls);
      }
      controls.innerHTML = "";
      const card = document.createElement("div");
      card.style.border = "1px solid #334155";
      card.style.borderRadius = "12px";
      card.style.padding = "12px";
      card.style.marginTop = "12px";
      const citationText = (answer.citations || []).map((citation) => "[" + citation.evidenceSpanId + "] lines " + citation.lineRange + ": " + citation.text).join("\\n");
      card.innerHTML = "<strong>Cited answer</strong><pre>" + escapeHtml(answer.answer || answer.error || "") + "</pre>" + (answer.gap ? "<p><strong>Gap:</strong> " + escapeHtml(answer.gap) + "</p>" : "") + "<pre>" + escapeHtml(citationText) + "</pre>";
      controls.append(card);
    }

    function actionButton(label, handler) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", handler);
      return button;
    }

    async function sendMemoryAction(memoryItemId, action) {
      statusEl.textContent = "Updating memory...";
      const response = await fetch("/api/memory-items/" + encodeURIComponent(memoryItemId) + "/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action)
      });
      if (handleUnauthorized(response)) return;
      const result = await response.json();
      renderResult(result);
      statusEl.textContent = response.ok ? result.status : "Failed";
    }

    function reviewerLabel() {
      const existing = localStorage.getItem("distillery_reviewer_label");
      if (existing) return existing;
      const entered = prompt("Your name/email for the audit trail") || "Shared password user";
      localStorage.setItem("distillery_reviewer_label", entered);
      return entered;
    }

    async function checkSession() {
      const response = await fetch("/api/session");
      if (response.ok) {
        showApp();
      }
    }

    function showApp() {
      loginStatusEl.textContent = "";
      loginCard.classList.add("hidden");
      appCard.classList.remove("hidden");
    }

    function showLogin(message) {
      appCard.classList.add("hidden");
      loginCard.classList.remove("hidden");
      loginStatusEl.textContent = message || "";
    }

    function showBriefForm() {
      briefForm.classList.remove("hidden");
    }

    function handleUnauthorized(response) {
      if (response.status !== 401) return false;
      showLogin("Session expired");
      statusEl.textContent = "";
      return true;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    }

    async function readJsonResponse(response) {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { error: text.slice(0, 500) };
      }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }

    function traceDetailsHtml(memory, evidenceText) {
      const entities = JSON.stringify(memory.entities || [], null, 2);
      const relations = JSON.stringify(memory.relations || [], null, 2);
      const schemas = JSON.stringify(memory.schemas || [], null, 2);
      const evidence = typeof evidenceText === "string" ? evidenceText : "";
      return '<details><summary>Trace details</summary>'
        + '<small>Entities</small><pre>' + escapeHtml(entities) + '</pre>'
        + '<small>Relations</small><pre>' + escapeHtml(relations) + '</pre>'
        + '<small>Schema candidates</small><pre>' + escapeHtml(schemas) + '</pre>'
        + (evidence ? '<small>Evidence</small><pre>' + escapeHtml(evidence) + '</pre>' : '')
        + '</details>';
    }

    ${loopDrawerScript()}
  </script>
</body>
</html>`;
}

function renderBriefReaderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Briefs · Distillery</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg:#070b12; --panel:#101827; --panel-2:#0b1220; --line:#2b3a51; --text:#f8fafc; --muted:#a8b5c7; --link:#7dd3fc; --cyan:#38bdf8; --green:#34d399; --amber:#fbbf24; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 12% 0%, rgba(56,189,248,.10), transparent 28%), var(--bg); color:var(--text); line-height:1.55; }
    a { color:var(--link); text-underline-offset:3px; }
    a:focus-visible, button:focus-visible, input:focus-visible { outline:3px solid #fde68a; outline-offset:3px; }
    button, input { font:inherit; }
    button { border:0; border-radius:9px; padding:10px 14px; background:var(--cyan); color:#082f49; font-weight:800; cursor:pointer; }
    button.secondary { color:#e2e8f0; background:#223148; border:1px solid #3c4e69; }
    input { width:100%; border:1px solid #465873; border-radius:9px; background:#07101e; color:var(--text); padding:11px 12px; }
    .skip { position:absolute; left:-9999px; top:8px; z-index:5; background:#fff; color:#000; padding:8px; }
    .skip:focus { left:8px; }
    .site-header { border-bottom:1px solid var(--line); background:rgba(7,11,18,.92); position:sticky; top:0; z-index:3; backdrop-filter:blur(14px); }
    .header-inner { width:min(1120px, calc(100% - 32px)); margin:auto; min-height:66px; display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .brand { color:#fff; font-size:18px; font-weight:850; text-decoration:none; letter-spacing:-.02em; }
    nav { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
    nav a[aria-current="page"] { color:#fff; font-weight:800; }
    main { width:min(1120px, calc(100% - 32px)); margin:0 auto; padding:38px 0 72px; }
    h1 { font-size:clamp(32px, 6vw, 56px); letter-spacing:-.045em; line-height:1.02; margin:0 0 12px; }
    h2 { font-size:24px; margin:0 0 10px; letter-spacing:-.02em; }
    h3 { margin:0 0 8px; }
    p { margin:0 0 14px; }
    .lede { max-width:720px; color:#cbd5e1; font-size:18px; }
    .hidden { display:none !important; }
    .panel { border:1px solid var(--line); border-radius:14px; background:linear-gradient(180deg, rgba(16,24,39,.98), rgba(10,17,29,.98)); padding:22px; box-shadow:0 22px 70px rgba(0,0,0,.2); }
    .login { width:min(460px, 100%); margin:56px auto 0; }
    .stack { display:grid; gap:12px; }
    .status { min-height:24px; color:#cbd5e1; margin:20px 0; }
    .error { border-color:#fb7185; color:#fecdd3; }
    .empty { border:1px dashed #465873; border-radius:14px; padding:28px; color:#cbd5e1; background:rgba(11,18,32,.72); }
    .brief-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; }
    .brief-card { display:flex; flex-direction:column; gap:13px; min-height:290px; color:inherit; text-decoration:none; transition:transform .14s ease, border-color .14s ease; }
    .brief-card:hover { transform:translateY(-2px); border-color:#4f6b91; }
    .brief-card h2 { font-size:23px; }
    .brief-card p { color:#d6deea; }
    .card-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:auto; color:var(--muted); font-size:14px; }
    .badge { display:inline-flex; align-items:center; border:1px solid #42607d; border-radius:999px; padding:3px 9px; font-size:12px; font-weight:850; text-transform:uppercase; letter-spacing:.05em; background:#102237; color:#bae6fd; }
    .badge.approved { border-color:#2f765e; background:#0b2b23; color:#bbf7d0; }
    .eyebrow { color:#7dd3fc; font-size:13px; font-weight:850; text-transform:uppercase; letter-spacing:.09em; margin-bottom:8px; }
    .why { border-left:3px solid var(--cyan); padding-left:14px; color:#cbd5e1; }
    .detail { display:grid; gap:18px; }
    .detail-header { margin-bottom:8px; }
    .detail-meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--muted); }
    .section-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; }
    .section-grid .wide { grid-column:1 / -1; }
    ul { margin:8px 0 0; padding-left:22px; }
    .citation-list { display:grid; gap:13px; }
    .citation { border:1px solid #33445e; border-radius:12px; padding:16px; background:#091220; }
    .citation header { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    blockquote { margin:12px 0 0; padding:12px 14px; border-left:3px solid var(--amber); background:#0e1726; white-space:pre-wrap; overflow-wrap:anywhere; }
    .fine { color:var(--muted); font-size:13px; }
    @media (max-width:760px) { .brief-grid, .section-grid { grid-template-columns:1fr; } .section-grid .wide { grid-column:auto; } .header-inner { align-items:flex-start; padding:14px 0; } nav { justify-content:flex-end; } main { padding-top:28px; } }
  </style>
</head>
<body>
  <a class="skip" href="#main-content">Skip to main content</a>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="/">Distillery</a>
      <nav aria-label="Authenticated application">
        <a href="/">Capture</a>
        <a href="/briefs" aria-current="page">Briefs</a>
        <a href="/synthesis">Review</a>
        <a href="/graph">Graph</a>
        <button id="logout" class="secondary hidden" type="button">Log out</button>
      </nav>
    </div>
  </header>
  <main id="main-content" tabindex="-1">
    <section id="login" class="panel login" aria-labelledby="login-title">
      <p class="eyebrow">Private pilot</p>
      <h1 id="login-title">Leadership briefs</h1>
      <p>Enter the shared Distillery password to view generated, evidence-backed briefs.</p>
      <form id="login-form" class="stack">
        <label for="password">Shared password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Continue</button>
      </form>
      <p id="login-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section id="reader" class="hidden" aria-labelledby="page-title">
      <div id="reader-heading">
        <p class="eyebrow">Read-only leadership view</p>
        <h1 id="page-title">Briefs</h1>
        <p class="lede">Distillery-generated briefs, grounded in the source evidence that leadership can inspect.</p>
      </div>
      <p id="reader-status" class="status" role="status" aria-live="polite">Loading briefs…</p>
      <div id="reader-content"></div>
    </section>
  </main>
  <script>
    const login = document.querySelector("#login");
    const reader = document.querySelector("#reader");
    const loginForm = document.querySelector("#login-form");
    const loginStatus = document.querySelector("#login-status");
    const readerStatus = document.querySelector("#reader-status");
    const readerContent = document.querySelector("#reader-content");
    const readerHeading = document.querySelector("#reader-heading");
    const logout = document.querySelector("#logout");

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      loginStatus.textContent = "Checking password…";
      const response = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: document.querySelector("#password").value })
      });
      if (!response.ok) { loginStatus.textContent = "That password did not match."; return; }
      openReader();
    });

    logout.addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      reader.classList.add("hidden");
      logout.classList.add("hidden");
      login.classList.remove("hidden");
      document.querySelector("#password").focus();
    });

    async function checkSession() {
      const response = await fetch("/api/session");
      if (response.ok) openReader();
    }

    function openReader() {
      login.classList.add("hidden");
      reader.classList.remove("hidden");
      logout.classList.remove("hidden");
      loginStatus.textContent = "";
      loadCurrentView();
    }

    async function loadCurrentView() {
      const match = location.pathname.match(/^\\/briefs\\/([^/]+)$/);
      if (match) return loadDetail(decodeURIComponent(match[1]));
      return loadList();
    }

    async function loadList() {
      readerHeading.classList.remove("hidden");
      readerStatus.textContent = "Loading briefs…";
      readerContent.replaceChildren();
      try {
        const response = await fetch("/api/briefs");
        if (handleUnauthorized(response)) return;
        if (!response.ok) throw new Error("Briefs could not be loaded.");
        const briefs = await response.json();
        if (!Array.isArray(briefs) || briefs.length === 0) {
          readerStatus.textContent = "";
          const empty = element("div", "empty");
          empty.append(element("h2", "", "No generated briefs yet"), element("p", "", "When Distillery finds enough connected evidence to generate a brief, it will appear here."));
          readerContent.append(empty);
          return;
        }
        const grid = element("div", "brief-grid");
        for (const brief of briefs) grid.append(renderCard(brief));
        readerContent.append(grid);
        readerStatus.textContent = briefs.length + (briefs.length === 1 ? " brief" : " briefs") + ", newest first.";
      } catch (error) {
        renderFailure("Briefs are temporarily unavailable. Refresh the page to try again.");
      }
    }

    async function loadDetail(briefId) {
      readerHeading.classList.add("hidden");
      readerStatus.textContent = "Loading brief…";
      readerContent.replaceChildren();
      try {
        const response = await fetch("/api/briefs/" + encodeURIComponent(briefId));
        if (handleUnauthorized(response)) return;
        if (response.status === 404) { renderFailure("This generated brief was not found or is no longer available."); return; }
        if (!response.ok) throw new Error("Brief could not be loaded.");
        const brief = await response.json();
        readerContent.append(renderDetail(brief));
        readerStatus.textContent = "Brief loaded.";
        document.title = brief.title + " · Distillery";
      } catch (error) {
        renderFailure("This brief is temporarily unavailable. Refresh the page to try again.");
      }
    }

    function renderCard(brief) {
      const card = element("a", "panel brief-card");
      card.href = "/briefs/" + encodeURIComponent(brief.id);
      const top = element("div");
      top.append(statusBadge(brief.status), element("h2", "", brief.title));
      card.append(top, element("p", "", brief.summary));
      const why = element("p", "why", brief.whyGenerated);
      why.setAttribute("aria-label", "Why Distillery generated this brief: " + brief.whyGenerated);
      card.append(why);
      const meta = element("div", "card-meta");
      meta.append(
        element("span", "", brief.supportingSourceCount + (brief.supportingSourceCount === 1 ? " supporting source" : " supporting sources")),
        element("span", "", "Updated " + formatDate(brief.updatedAt))
      );
      card.append(meta);
      return card;
    }

    function renderDetail(brief) {
      const article = element("article", "detail");
      const back = element("a", "", "← All briefs");
      back.href = "/briefs";
      const header = element("header", "detail-header");
      header.append(element("p", "eyebrow", "Leadership brief"), element("h1", "", brief.title));
      const meta = element("div", "detail-meta");
      meta.append(statusBadge(brief.status), element("span", "", brief.supportingSourceCount + " supporting sources"), element("span", "", "Updated " + formatDate(brief.updatedAt)));
      header.append(meta);
      const why = element("section", "panel");
      why.append(element("h2", "", "Why Distillery generated this"), element("p", "why", brief.whyGenerated));
      const sections = element("div", "section-grid");
      sections.append(
        textSection("Executive summary", brief.executiveSummary, "wide"),
        textSection("What appears to be happening", brief.whatIsHappening),
        textSection("Decisions and commitments", brief.decisionsAndCommitments),
        listSection("Risks", brief.risks),
        listSection("Dependencies", brief.dependencies),
        listSection("Open questions", brief.openQuestions),
        listSection("Conflicting evidence", brief.conflictingEvidence)
      );
      const sources = element("section", "panel wide");
      sources.append(element("h2", "", "Supporting sources"));
      if (!brief.citations || brief.citations.length === 0) {
        sources.append(element("p", "fine", "No source citations are available for this brief."));
      } else {
        const list = element("div", "citation-list");
        for (const citation of brief.citations) list.append(renderCitation(citation));
        sources.append(list);
      }
      article.append(back, header, why, sections, sources);
      return article;
    }

    function textSection(title, text, className) {
      const section = element("section", "panel " + (className || ""));
      section.append(element("h2", "", title), element("p", "", text || "No information recorded."));
      return section;
    }

    function listSection(title, values) {
      const section = element("section", "panel");
      section.append(element("h2", "", title));
      if (!Array.isArray(values) || values.length === 0) {
        section.append(element("p", "fine", "No information recorded."));
      } else {
        const list = element("ul");
        for (const value of values) list.append(element("li", "", String(value)));
        section.append(list);
      }
      return section;
    }

    function renderCitation(citation) {
      const item = element("article", "citation");
      const header = element("header");
      const label = element("div");
      label.append(element("strong", "", citation.authorOrTitle), element("div", "fine", sourceTypeLabel(citation.sourceType) + " · " + formatDate(citation.occurredAt) + locatorLabel(citation.locator)));
      header.append(label);
      const originalUrl = safeSlackUrl(citation.originalUrl);
      if (originalUrl) {
        const link = element("a", "", "Open in Slack");
        link.href = originalUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        header.append(link);
      }
      const quote = element("blockquote", "", citation.exactText);
      item.append(header, quote);
      return item;
    }

    function locatorLabel(locator) {
      if (!locator) return "";
      if (locator.pageNumber) return " · Page " + locator.pageNumber;
      if (locator.paragraphNumber) return " · Paragraph " + locator.paragraphNumber;
      if (locator.messageTimestamp) return " · Slack message";
      return "";
    }

    function sourceTypeLabel(value) {
      return ({ slack_message: "Slack message", slack_file_pdf: "PDF", slack_file_docx: "DOCX", text_braindump: "Distillery note" })[value] || "Source";
    }

    function safeSlackUrl(value) {
      if (typeof value !== "string") return null;
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === "https:" && (host === "slack.com" || host.endsWith(".slack.com"))
          ? url.href
          : null;
      } catch {
        return null;
      }
    }

    function statusBadge(status) {
      return element("span", "badge " + (status === "approved" ? "approved" : ""), status === "approved" ? "Approved" : "Draft");
    }

    function renderFailure(message) {
      readerStatus.textContent = "";
      readerContent.replaceChildren();
      const failure = element("div", "panel error");
      failure.append(element("h2", "", "Unable to load"), element("p", "", message));
      const retry = element("button", "secondary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", loadCurrentView);
      failure.append(retry);
      readerContent.append(failure);
    }

    function handleUnauthorized(response) {
      if (response.status !== 401) return false;
      reader.classList.add("hidden");
      logout.classList.add("hidden");
      login.classList.remove("hidden");
      loginStatus.textContent = "Your session expired. Enter the shared password again.";
      return true;
    }

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "");
      return new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(date);
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className.trim();
      if (text !== undefined) node.textContent = text;
      return node;
    }

    checkSession();
  </script>
</body>
</html>`;
}

function renderGraphShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Distillery Graph</title>
  <script src="/assets/d3-local.js"></script>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #070b12;
      --pane: #0d1421;
      --pane-2: #111a2a;
      --line: #253044;
      --line-strong: #3a4b67;
      --text: #f8fafc;
      --soft: #cbd5e1;
      --muted: #8ea0b8;
      --cyan: #38bdf8;
      --green: #34d399;
      --violet: #a78bfa;
      --amber: #fbbf24;
      --rose: #fb7185;
      --ink: #04111f;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    a { color: #7dd3fc; text-decoration: none; }
    button, input, textarea { font: inherit; }
    button { border: 0; border-radius: 8px; padding: 8px 10px; background: var(--cyan); color: #082f49; font-weight: 800; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
    button:hover { transform: translateY(-1px); }
    button.secondary { background: #243247; color: #e2e8f0; border: 1px solid #334155; }
    button.ghost { background: transparent; color: #cbd5e1; border: 1px solid #334155; }
    button.danger { background: #fda4af; color: #450a0a; }
    button:disabled { opacity: .55; cursor: wait; transform: none; }
    input, textarea { width: 100%; border: 1px solid #334155; border-radius: 8px; background: #080f1c; color: var(--text); padding: 9px 10px; }
    textarea { min-height: 84px; resize: vertical; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 2px; font-size: 20px; }
    h2 { margin: 18px 0 9px; color: #dbeafe; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    h3 { margin-bottom: 7px; font-size: 15px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; background: #050914; border: 1px solid #1f2a3c; border-radius: 8px; padding: 10px; overflow: auto; color: #dbeafe; }
    .shell { display: grid; grid-template-columns: minmax(260px, 330px) minmax(420px, 1fr) minmax(320px, 410px); height: 100vh; min-height: 0; overflow: hidden; }
    .sidebar, .inspector { background: var(--pane); min-width: 0; height: 100vh; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
    .sidebar { border-right: 1px solid var(--line); padding: 16px; }
    .inspector { border-left: 1px solid var(--line); padding: 16px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .subtitle { color: var(--muted); font-size: 13px; line-height: 1.4; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .stack { display: grid; gap: 8px; }
    .muted { color: var(--muted); }
    .fine { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .pill { display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 3px 7px; border-radius: 999px; border: 1px solid #334155; background: #121c2d; color: #dbeafe; font-size: 12px; font-weight: 750; white-space: nowrap; }
    .pill.conflict { border-color: rgba(251,113,133,.55); color: #fecdd3; background: rgba(251,113,133,.12); }
    .pill.good { border-color: rgba(52,211,153,.48); color: #bbf7d0; background: rgba(52,211,153,.12); }
    .pill.warn { border-color: rgba(251,191,36,.5); color: #fde68a; background: rgba(251,191,36,.1); }
    .filterbar { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
    .filterbar button { padding: 7px 8px; color: #cbd5e1; background: #121c2d; border: 1px solid #263244; font-weight: 750; }
    .filterbar button[aria-pressed="true"] { color: #082f49; background: var(--cyan); border-color: var(--cyan); }
    .cluster-list { display: grid; gap: 8px; margin-top: 10px; }
    .cluster { width: 100%; display: grid; gap: 8px; text-align: left; background: #101928; color: #e2e8f0; border: 1px solid #263244; border-radius: 8px; padding: 11px; position: relative; }
    .cluster[aria-selected="true"] { background: #11263b; border-color: #38bdf8; box-shadow: inset 3px 0 0 #38bdf8, 0 12px 34px rgba(56,189,248,.12); }
    .cluster-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .cluster-title strong { min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
    .cluster-index { color: #93c5fd; font-size: 11px; font-weight: 850; }
    .canvas { position: relative; min-width: 0; height: 100vh; overflow: hidden; background:
      radial-gradient(circle at 28% 18%, rgba(56,189,248,.09), transparent 24%),
      radial-gradient(circle at 78% 70%, rgba(52,211,153,.07), transparent 22%),
      #070b12; }
    .canvas-header { position: absolute; top: 14px; left: 14px; right: 14px; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; pointer-events: none; }
    .canvas-title { max-width: min(620px, 68%); padding: 12px; border: 1px solid rgba(51,65,85,.85); border-radius: 8px; background: rgba(8,15,28,.88); box-shadow: 0 18px 46px rgba(0,0,0,.22); backdrop-filter: blur(14px); pointer-events: auto; }
    .canvas-title h2 { margin: 0 0 4px; color: #f8fafc; font-size: 16px; text-transform: none; letter-spacing: 0; }
    .canvas-title p { margin: 0; }
    .toolbar { display: flex; gap: 8px; pointer-events: auto; }
    .legend { position: absolute; left: 14px; bottom: 14px; z-index: 3; display: flex; flex-wrap: wrap; gap: 8px; max-width: calc(100% - 28px); padding: 9px; border: 1px solid rgba(51,65,85,.78); border-radius: 8px; background: rgba(8,15,28,.88); backdrop-filter: blur(14px); }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 12px; white-space: nowrap; }
    .swatch { width: 13px; height: 13px; border-radius: 4px; border: 1px solid rgba(255,255,255,.35); display: inline-block; }
    .swatch.claim { border-radius: 999px; background: var(--cyan); }
    .swatch.entity { background: var(--green); }
    .swatch.evidence { background: var(--amber); transform: rotate(45deg); }
    .swatch.schema { background: var(--violet); }
    .edge-swatch { width: 24px; height: 0; border-top: 3px solid #64748b; display: inline-block; }
    .edge-swatch.accepted { border-color: var(--green); }
    .edge-swatch.rejected { border-color: var(--rose); border-top-style: dashed; }
    svg { width: 100%; height: 100vh; display: block; touch-action: none; }
    .graph-bg { fill: transparent; cursor: grab; }
    .edge { stroke: #64748b; stroke-linecap: round; opacity: .74; cursor: pointer; transition: opacity .12s ease, stroke .12s ease; }
    .edge.accepted { stroke: var(--green); }
    .edge.rejected { stroke: var(--rose); stroke-dasharray: 7 5; }
    .edge.proposed { stroke: var(--amber); }
    .edge.supported_by { stroke: #5b6f91; stroke-dasharray: 3 5; }
    .edge.mentions { stroke: #38bdf8; opacity: .54; }
    .edge.selected { stroke: #f8fafc; opacity: 1; filter: drop-shadow(0 0 8px rgba(248,250,252,.55)); }
    .edge.faded { opacity: .11; }
    .edge-label { fill: #dbeafe; paint-order: stroke; stroke: #070b12; stroke-width: 4px; font-size: 10px; pointer-events: none; opacity: 0; }
    .edge-label.visible { opacity: .9; }
    .node { cursor: pointer; }
    .node text { fill: #e2e8f0; paint-order: stroke; stroke: #070b12; stroke-width: 4px; font-size: 11px; pointer-events: none; }
    .node .halo { fill: rgba(255,255,255,.001); stroke: transparent; stroke-width: 10; pointer-events: all; }
    .node.selected .halo { stroke: rgba(56,189,248,.34); }
    .node.neighbor .halo { stroke: rgba(52,211,153,.18); }
    .node.faded { opacity: .2; }
    .node-shape { stroke: #06111f; stroke-width: 2; filter: drop-shadow(0 8px 13px rgba(0,0,0,.28)); }
    .node.claim .node-shape { fill: var(--cyan); }
    .node.entity .node-shape { fill: var(--green); }
    .node.evidence .node-shape { fill: var(--amber); }
    .node.schema .node-shape { fill: var(--violet); }
    .tooltip { position: absolute; z-index: 5; max-width: 320px; padding: 8px 10px; border: 1px solid #334155; border-radius: 8px; background: rgba(5,9,20,.94); color: #e2e8f0; box-shadow: 0 18px 50px rgba(0,0,0,.38); pointer-events: none; opacity: 0; transform: translate(10px, 10px); font-size: 12px; line-height: 1.35; }
    .inspector-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin: 10px 0 12px; }
    .inspector-tabs button { padding: 7px 4px; color: #cbd5e1; background: #121c2d; border: 1px solid #263244; font-size: 12px; }
    .inspector-tabs button[aria-selected="true"] { color: #082f49; background: var(--cyan); border-color: var(--cyan); }
    .panel { border: 1px solid #2d3b52; border-radius: 8px; padding: 12px; margin: 8px 0; background: #101928; }
    .panel.selected { border-color: #38bdf8; box-shadow: inset 3px 0 0 #38bdf8; }
    .panel.conflict { border-color: rgba(251,113,133,.45); }
    .panel-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .metric { padding: 10px; border: 1px solid #263244; border-radius: 8px; background: #0a1220; }
    .metric strong { display: block; font-size: 20px; }
    .metric span { color: var(--muted); font-size: 12px; }
    .connection-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: start; }
    .scorebar { height: 6px; overflow: hidden; border-radius: 999px; background: #1e293b; margin-top: 8px; }
    .scorebar span { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--green)); }
    .claim-line { display: block; color: #dbeafe; overflow-wrap: anywhere; }
    .claim-line small { display: block; color: var(--muted); margin-top: 3px; }
    .empty { border: 1px dashed #334155; border-radius: 8px; padding: 13px; color: #cbd5e1; background: #0a1220; }
    .statusline { min-height: 20px; color: var(--muted); font-size: 12px; }
    .statusline.error { color: #fecdd3; }
    @media (max-width: 1120px) {
      .shell { grid-template-columns: minmax(230px, 300px) minmax(360px, 1fr); grid-template-rows: minmax(0, 1fr) minmax(220px, 34vh); }
      .sidebar, .canvas, .inspector { height: 100%; min-height: 0; }
      .inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); max-height: none; }
      svg { height: 100%; }
    }
    @media (max-width: 760px) {
      html, body { height: auto; overflow: auto; }
      .shell { grid-template-columns: 1fr; height: auto; min-height: 100vh; overflow: visible; }
      .sidebar, .inspector { height: auto; max-height: 62vh; border: 0; border-bottom: 1px solid var(--line); }
      .canvas { height: auto; }
      .canvas-header { position: static; padding: 12px; display: grid; background: #070b12; }
      .canvas-title { max-width: none; width: 100%; }
      .toolbar { flex-wrap: wrap; }
      .legend { position: static; margin: 0 12px 12px; }
      svg { height: 62vh; }
      .panel-grid { grid-template-columns: 1fr; }
      .inspector-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="sidebar" aria-label="Graph clusters">
      <div class="topbar">
        <div>
          <h1>Claim Graph</h1>
          <div class="subtitle">Review memory clusters, links, evidence, and conflicts.</div>
        </div>
        <div class="row"><a href="/">Home</a><a href="/briefs">Briefs</a></div>
      </div>
      <div class="row">
        <button id="rebuild" type="button" class="secondary" title="Rebuild graph projection">Rebuild</button>
        <span id="cluster-status" class="statusline"></span>
      </div>
      <h2>Explore</h2>
      <input id="cluster-search" type="search" placeholder="Search clusters" autocomplete="off" />
      <div class="filterbar" role="group" aria-label="Cluster filters">
        <button type="button" data-cluster-filter="all" aria-pressed="true">All</button>
        <button type="button" data-cluster-filter="conflicts" aria-pressed="false">Conflicts</button>
        <button type="button" data-cluster-filter="connections" aria-pressed="false">Linked</button>
      </div>
      <h2>Clusters</h2>
      <div id="clusters" class="cluster-list"></div>
    </aside>
    <section class="canvas">
      <div class="canvas-header">
        <div class="canvas-title">
          <h2 id="graph-title">Select a cluster</h2>
          <p id="graph-subtitle" class="fine">The graph focuses on the active entity cluster and its memory connections.</p>
          <div id="graph-metrics" class="row" style="margin-top: 8px;"></div>
        </div>
        <div class="toolbar" aria-label="Graph controls">
          <button id="zoom-in" type="button" class="secondary" title="Zoom in">+</button>
          <button id="zoom-out" type="button" class="secondary" title="Zoom out">-</button>
          <button id="focus" type="button" class="secondary" title="Center active graph">Focus</button>
          <button id="reset" type="button" class="secondary" title="Reset selection">Reset</button>
        </div>
      </div>
      <svg id="graph" role="img" aria-label="Claim graph"></svg>
      <div id="graph-tooltip" class="tooltip"></div>
      <div class="legend" aria-label="Graph legend">
        <span class="legend-item"><span class="swatch claim"></span>Claim</span>
        <span class="legend-item"><span class="swatch entity"></span>Entity</span>
        <span class="legend-item"><span class="swatch evidence"></span>Evidence</span>
        <span class="legend-item"><span class="swatch schema"></span>Schema</span>
        <span class="legend-item"><span class="edge-swatch accepted"></span>Accepted</span>
        <span class="legend-item"><span class="edge-swatch"></span>Proposed</span>
        <span class="legend-item"><span class="edge-swatch rejected"></span>Rejected</span>
      </div>
    </section>
    <aside class="inspector" aria-label="Graph inspector">
      <div class="topbar">
        <div>
          <h1 id="inspector-title">Inspector</h1>
          <div id="inspector-subtitle" class="subtitle">Select a cluster, node, or edge.</div>
        </div>
      </div>
      <div class="inspector-tabs" role="tablist" aria-label="Inspector sections">
        <button type="button" data-tab="overview" aria-selected="true">Overview</button>
        <button type="button" data-tab="connections" aria-selected="false">Links</button>
        <button type="button" data-tab="evidence" aria-selected="false">Evidence</button>
        <button type="button" data-tab="conflicts" aria-selected="false">Conflicts</button>
        <button type="button" data-tab="actions" aria-selected="false">Actions</button>
      </div>
      <div id="details"></div>
    </aside>
  </main>
  <script>
    const state = {
      clusters: [],
      cluster: null,
      selectedClusterId: null,
      selectedNodeId: null,
      selectedEdgeId: null,
      activeTab: "overview",
      clusterFilter: "all",
      search: "",
      graph: { nodes: [], edges: [], simulation: null, zoom: null, transform: null }
    };
    const clustersEl = document.querySelector("#clusters");
    const detailsEl = document.querySelector("#details");
    const clusterStatusEl = document.querySelector("#cluster-status");
    const searchEl = document.querySelector("#cluster-search");
    const graphTitleEl = document.querySelector("#graph-title");
    const graphSubtitleEl = document.querySelector("#graph-subtitle");
    const graphMetricsEl = document.querySelector("#graph-metrics");
    const inspectorTitleEl = document.querySelector("#inspector-title");
    const inspectorSubtitleEl = document.querySelector("#inspector-subtitle");
    const tooltipEl = document.querySelector("#graph-tooltip");
    const svg = document.querySelector("#graph");
    const d3Graph = window.d3;

    loadClusters();

    document.querySelector("#rebuild").addEventListener("click", async () => {
      const button = document.querySelector("#rebuild");
      button.disabled = true;
      setStatus("Rebuilding...");
      try {
        await fetch("/api/graph/rebuild", { method: "POST" });
        await loadClusters(state.selectedClusterId);
        setStatus("Rebuilt");
      } catch (error) {
        setStatus("Rebuild failed", true);
      } finally {
        button.disabled = false;
      }
    });
    document.querySelector("#zoom-in").addEventListener("click", () => zoomBy(1.18));
    document.querySelector("#zoom-out").addEventListener("click", () => zoomBy(.84));
    document.querySelector("#focus").addEventListener("click", () => centerGraph(true));
    document.querySelector("#reset").addEventListener("click", () => {
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      updateFocusStyles();
      renderInspector();
      centerGraph(true);
    });
    searchEl.addEventListener("input", () => {
      state.search = searchEl.value.trim().toLowerCase();
      renderClusters();
    });
    document.querySelectorAll("[data-cluster-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.clusterFilter = button.dataset.clusterFilter;
        document.querySelectorAll("[data-cluster-filter]").forEach((candidate) => {
          candidate.setAttribute("aria-pressed", String(candidate === button));
        });
        renderClusters();
      });
    });
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        renderInspector();
      });
    });

    async function loadClusters(preferredId) {
      setStatus("Loading...");
      const response = await fetch("/api/graph/clusters");
      if (response.status === 401) {
        location.href = "/";
        return;
      }
      if (!response.ok) {
        setStatus("Failed to load clusters", true);
        return;
      }
      state.clusters = await response.json();
      renderClusters();
      const selected = preferredId && state.clusters.some((cluster) => cluster.id === preferredId) ? preferredId : state.clusters[0]?.id;
      if (selected) await loadCluster(selected, { selectEntity: Boolean(preferredId) });
      setStatus(state.clusters.length + " clusters");
    }

    function renderClusters() {
      const query = state.search;
      const filtered = state.clusters.filter((cluster) => {
        const matchesQuery = !query || cluster.label.toLowerCase().includes(query) || cluster.id.toLowerCase().includes(query);
        const matchesFilter = state.clusterFilter === "all"
          || (state.clusterFilter === "conflicts" && cluster.openConflictCount > 0)
          || (state.clusterFilter === "connections" && cluster.connectionCount > 0);
        return matchesQuery && matchesFilter;
      });
      clustersEl.innerHTML = "";
      if (filtered.length === 0) {
        clustersEl.innerHTML = "<div class='empty'>No clusters match this filter.</div>";
        return;
      }
      filtered.forEach((cluster, index) => {
        const button = document.createElement("button");
        button.className = "cluster";
        button.type = "button";
        button.dataset.clusterId = cluster.id;
        button.setAttribute("aria-selected", String(cluster.id === state.selectedClusterId));
        button.innerHTML =
          "<span class='cluster-title'><strong>" + escapeHtml(cluster.label) + "</strong><span class='cluster-index'>#" + String(index + 1).padStart(2, "0") + "</span></span>" +
          "<span class='row'>" +
          "<span class='pill'>" + cluster.claimCount + " claims</span>" +
          "<span class='pill good'>" + cluster.connectionCount + " links</span>" +
          "<span class='pill " + (cluster.openConflictCount > 0 ? "conflict" : "") + "'>" + cluster.openConflictCount + " conflicts</span>" +
          "</span>";
        button.addEventListener("click", () => loadCluster(cluster.id));
        clustersEl.append(button);
      });
      markSelectedCluster();
    }

    async function loadCluster(id, options = { selectEntity: true }) {
      state.selectedClusterId = id;
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.activeTab = "overview";
      markSelectedCluster();
      renderTabs();
      graphTitleEl.textContent = "Loading " + labelForClusterId(id);
      graphSubtitleEl.textContent = "Fetching cluster neighborhood...";
      detailsEl.innerHTML = "<div class='panel'>Loading cluster connections...</div>";
      const response = await fetch("/api/graph/clusters/" + encodeURIComponent(id));
      if (response.status === 401) {
        location.href = "/";
        return;
      }
      if (!response.ok) {
        detailsEl.innerHTML = "<div class='panel conflict'>Cluster failed to load.</div>";
        return;
      }
      state.cluster = await response.json();
      state.selectedNodeId = options.selectEntity && state.cluster.nodes.some((node) => node.id === id) ? id : null;
      drawGraph();
      renderInspector();
    }

    function drawGraph() {
      const cluster = state.cluster;
      if (!cluster || !d3Graph) return;
      if (state.graph.simulation) state.graph.simulation.stop();
      const width = Math.max(360, svg.clientWidth || 720);
      const height = Math.max(360, svg.clientHeight || 640);
      const model = buildGraphModel(cluster, width, height);
      state.graph.nodes = model.nodes;
      state.graph.edges = model.edges;
      graphTitleEl.textContent = cluster.label;
      graphSubtitleEl.textContent = "Click clusters, nodes, and edges to inspect how memory is connected.";
      graphMetricsEl.innerHTML =
        "<span class='pill'>" + cluster.claims.length + " claims</span>" +
        "<span class='pill good'>" + cluster.connections.length + " connections</span>" +
        "<span class='pill " + (cluster.conflicts.length ? "conflict" : "") + "'>" + cluster.conflicts.length + " conflicts</span>" +
        "<span class='pill'>" + model.nodes.length + " nodes</span>" +
        "<span class='pill'>" + model.edges.length + " graph links</span>";

      const root = d3Graph.select(svg);
      root.selectAll("*").remove();
      root.append("rect")
        .attr("class", "graph-bg")
        .attr("width", width)
        .attr("height", height)
        .on("click", () => {
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          hideTooltip();
          updateFocusStyles();
          renderInspector();
        });
      const zoomLayer = root.append("g").attr("class", "zoom-layer");
      const edgeLayer = zoomLayer.append("g").attr("class", "edge-layer");
      const labelLayer = zoomLayer.append("g").attr("class", "edge-label-layer");
      const nodeLayer = zoomLayer.append("g").attr("class", "node-layer");

      state.graph.zoom = d3Graph.zoom()
        .scaleExtent([.42, 2.8])
        .on("zoom", (event) => {
          state.graph.transform = event.transform;
          zoomLayer.attr("transform", event.transform);
        });
      root.call(state.graph.zoom);

      const link = edgeLayer.selectAll("line")
        .data(model.edges, (edge) => edge.id)
        .join("line")
        .attr("class", (edge) => "edge " + edgeClass(edge))
        .attr("stroke-width", (edge) => Math.max(1.2, Math.min(5.5, Number(edge.weight || 1) * 3)))
        .on("click", (event, edge) => {
          event.stopPropagation();
          state.selectedEdgeId = edge.id;
          state.selectedNodeId = null;
          state.activeTab = "overview";
          hideTooltip();
          updateFocusStyles();
          renderInspector();
        })
        .on("pointermove", (event, edge) => showTooltip(event, edgeTooltip(edge)))
        .on("pointerleave", hideTooltip);

      const edgeLabel = labelLayer.selectAll("text")
        .data(model.edges.filter((edge) => edge.properties?.connectionId), (edge) => edge.id)
        .join("text")
        .attr("class", "edge-label")
        .text((edge) => edge.edgeType.replaceAll("_", " "));

      const node = nodeLayer.selectAll("g")
        .data(model.nodes, (item) => item.id)
        .join("g")
        .attr("class", (item) => "node " + item.nodeType)
        .call(d3Graph.drag()
          .on("start", (event, item) => {
            if (!event.active) state.graph.simulation.alphaTarget(.25).restart();
            item.fx = item.x;
            item.fy = item.y;
          })
          .on("drag", (event, item) => {
            item.fx = event.x;
            item.fy = event.y;
          })
          .on("end", (event, item) => {
            if (!event.active) state.graph.simulation.alphaTarget(0);
            item.fx = null;
            item.fy = null;
          }))
        .on("click", (event, item) => {
          event.stopPropagation();
          state.selectedNodeId = item.id;
          state.selectedEdgeId = null;
          state.activeTab = "overview";
          hideTooltip();
          updateFocusStyles();
          renderInspector();
        })
        .on("pointermove", (event, item) => showTooltip(event, nodeTooltip(item)))
        .on("pointerleave", hideTooltip);

      node.append("circle")
        .attr("class", "halo")
        .attr("r", (item) => nodeRadius(item) + 7);
      node.each(function(item) {
        const selection = d3Graph.select(this);
        if (item.nodeType === "entity") {
          selection.append("rect")
            .attr("class", "node-shape")
            .attr("x", -nodeRadius(item))
            .attr("y", -nodeRadius(item))
            .attr("rx", 6)
            .attr("width", nodeRadius(item) * 2)
            .attr("height", nodeRadius(item) * 2);
        } else if (item.nodeType === "evidence" || item.nodeType === "schema") {
          const radius = nodeRadius(item);
          selection.append("path")
            .attr("class", "node-shape")
            .attr("d", "M 0 " + (-radius) + " L " + radius + " 0 L 0 " + radius + " L " + (-radius) + " 0 Z");
        } else {
          selection.append("circle")
            .attr("class", "node-shape")
            .attr("r", nodeRadius(item));
        }
      });
      node.append("text")
        .attr("x", (item) => nodeRadius(item) + 7)
        .attr("y", 4)
        .text((item) => truncate(item.label, item.nodeType === "claim" ? 48 : 32));

      state.graph.simulation = d3Graph.forceSimulation(model.nodes)
        .force("link", d3Graph.forceLink(model.edges).id((item) => item.id).distance((edge) => edgeDistance(edge)).strength((edge) => edgeStrength(edge)))
        .force("charge", d3Graph.forceManyBody().strength(-360))
        .force("collide", d3Graph.forceCollide().radius((item) => nodeRadius(item) + 36))
        .force("center", d3Graph.forceCenter(width / 2, height / 2))
        .force("x", d3Graph.forceX(width / 2).strength(.04))
        .force("y", d3Graph.forceY(height / 2).strength(.04))
        .on("tick", () => {
          link
            .attr("x1", (edge) => edge.source.x)
            .attr("y1", (edge) => edge.source.y)
            .attr("x2", (edge) => edge.target.x)
            .attr("y2", (edge) => edge.target.y);
          edgeLabel
            .attr("x", (edge) => (edge.source.x + edge.target.x) / 2)
            .attr("y", (edge) => (edge.source.y + edge.target.y) / 2);
          node.attr("transform", (item) => "translate(" + item.x + "," + item.y + ")");
        });
      centerGraph(false);
      updateFocusStyles();
    }

    function buildGraphModel(cluster, width, height) {
      const seen = new Set();
      const nodes = cluster.nodes.map((node, index) => {
        const angle = index * 2.399;
        const radius = Math.min(width, height) * (node.nodeType === "claim" ? .22 : .31);
        return {
          ...node,
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius
        };
      });
      const nodeIds = new Set(nodes.map((node) => node.id));
      const edges = [];
      for (const edge of cluster.edges) {
        if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) continue;
        seen.add(edge.properties?.connectionId || edge.id);
        edges.push({ ...edge, source: edge.fromNodeId, target: edge.toNodeId });
      }
      for (const connection of cluster.connections) {
        const connectionKey = connection.id;
        const fromNodeId = "claim:" + connection.fromClaimId;
        const toNodeId = "claim:" + connection.toClaimId;
        if (seen.has(connectionKey) || !nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) continue;
        edges.push({
          id: "edge:connection:" + connection.id,
          tenantId: connection.tenantId,
          fromNodeId,
          toNodeId,
          source: fromNodeId,
          target: toNodeId,
          edgeType: connection.connectionType,
          weight: connection.confidence,
          properties: { connectionId: connection.id, status: connection.status }
        });
      }
      return { nodes, edges };
    }

    function renderInspector() {
      renderTabs();
      const cluster = state.cluster;
      if (!cluster) {
        inspectorTitleEl.textContent = "Inspector";
        inspectorSubtitleEl.textContent = "Select a cluster, node, or edge.";
        detailsEl.innerHTML = "<div class='empty'>No cluster selected.</div>";
        return;
      }
      const node = state.selectedNodeId ? findNode(state.selectedNodeId) : null;
      const edge = state.selectedEdgeId ? findEdge(state.selectedEdgeId) : null;
      const connection = edge ? connectionForEdge(edge) : null;
      const title = connection ? connection.connectionType.replaceAll("_", " ") : edge ? edge.edgeType.replaceAll("_", " ") : node ? node.label : cluster.label;
      inspectorTitleEl.textContent = truncate(title, 44);
      inspectorSubtitleEl.textContent = connection
        ? "Connection edge"
        : edge
          ? "Graph edge"
        : node
          ? node.nodeType + " node"
          : "Cluster overview";
      if (state.activeTab === "overview") {
        detailsEl.innerHTML = renderOverview(node, edge, connection);
      } else if (state.activeTab === "connections") {
        detailsEl.innerHTML = renderConnectionsPanel(node, edge);
      } else if (state.activeTab === "evidence") {
        detailsEl.innerHTML = renderEvidencePanel(node);
      } else if (state.activeTab === "conflicts") {
        detailsEl.innerHTML = renderConflictsPanel(node);
      } else {
        detailsEl.innerHTML = renderActionsPanel(node, edge, connection);
      }
    }

    function renderOverview(node, edge, connection) {
      const cluster = state.cluster;
      if (connection) return renderConnectionDetail(connection, true);
      if (edge) {
        return "<div class='panel selected'><h3>" + escapeHtml(edge.edgeType.replaceAll("_", " ")) + "</h3>" +
          "<p class='fine'>" + escapeHtml(edge.fromNodeId) + " -> " + escapeHtml(edge.toNodeId) + "</p>" +
          "<span class='pill'>" + Number(edge.weight || 0).toFixed(2) + " weight</span></div>";
      }
      if (node) return renderNodeOverview(node);
      return "<div class='panel selected'><h3>" + escapeHtml(cluster.label) + "</h3><p class='fine'>Focused entity cluster. Select a node or edge to narrow the inspector.</p>" +
        "<div class='panel-grid'>" +
        metric("Claims", cluster.claims.length) +
        metric("Connections", cluster.connections.length) +
        metric("Conflicts", cluster.conflicts.length) +
        "</div></div>" +
        renderConnectionsPanel(null, null, 5) +
        renderConflictsPanel(null, 2);
    }

    function renderNodeOverview(node) {
      const claim = claimForNode(node);
      if (claim) {
        const related = connectionsForClaim(claim.claim.id);
        return "<div class='panel selected'><h3>" + escapeHtml(claim.claim.claimType) + "</h3><pre>" + escapeHtml(claim.claim.statement) + "</pre>" +
          "<div class='row'><span class='pill'>rank " + Number(claim.rank || 0).toFixed(2) + "</span><span class='pill'>graph " + Number(claim.graphScore || 0).toFixed(2) + "</span><span class='pill'>lexical " + Number(claim.lexicalScore || 0).toFixed(2) + "</span><span class='pill'>vector " + Number(claim.vectorScore || 0).toFixed(2) + "</span></div></div>" +
          "<h2>Connected claims</h2>" + (related.length ? related.slice(0, 6).map((connection) => renderConnectionDetail(connection, false)).join("") : "<div class='empty'>No claim-to-claim connections for this claim.</div>");
      }
      if (node.nodeType === "entity") {
        const claims = claimsConnectedToNode(node.id);
        const claimIds = new Set(claims.map((item) => item.claim.id));
        const related = state.cluster.connections.filter((connection) => claimIds.has(connection.fromClaimId) || claimIds.has(connection.toClaimId));
        return "<div class='panel selected'><h3>" + escapeHtml(node.label) + "</h3><p class='fine'>Entity node. These claims mention this entity.</p>" +
          "<div class='row'><span class='pill'>" + claims.length + " claims</span><span class='pill good'>" + related.length + " related links</span></div></div>" +
          claims.slice(0, 8).map((item) => claimSummary(item)).join("") +
          (related.length ? "<h2>Connection reasons</h2>" + related.slice(0, 5).map((connection) => renderConnectionDetail(connection, false)).join("") : "");
      }
      if (node.nodeType === "evidence") {
        const evidence = evidenceById(node.refId);
        const claims = claimsConnectedToNode(node.id);
        return "<div class='panel selected'><h3>" + escapeHtml(node.label) + "</h3><p class='fine'>Evidence node cited by " + claims.length + " claims.</p>" +
          (evidence ? "<pre>" + escapeHtml(evidence.text) + "</pre><p class='fine'>Lines " + evidence.startLine + "-" + evidence.endLine + "</p>" : "") +
          "</div>" + claims.map((item) => claimSummary(item)).join("");
      }
      return "<div class='panel selected'><h3>" + escapeHtml(node.label) + "</h3><p class='fine'>" + escapeHtml(node.nodeType) + " node</p><pre>" + escapeHtml(JSON.stringify(node.properties || {}, null, 2)) + "</pre></div>";
    }

    function renderConnectionsPanel(node, edge, limit) {
      const cluster = state.cluster;
      let connections = cluster.connections;
      let graphEdges = state.graph.edges;
      if (edge?.properties?.connectionId) connections = connections.filter((connection) => connection.id === edge.properties.connectionId);
      if (edge) graphEdges = graphEdges.filter((candidate) => candidate.id === edge.id);
      if (node?.nodeType === "claim") {
        const claimId = node.refId;
        connections = connections.filter((connection) => connection.fromClaimId === claimId || connection.toClaimId === claimId);
        graphEdges = graphEdges.filter((candidate) => edgeTouchesNode(candidate, node.id));
      } else if (node && node.nodeType !== "claim") {
        const claimIds = new Set(claimsConnectedToNode(node.id).map((item) => item.claim.id));
        connections = connections.filter((connection) => claimIds.has(connection.fromClaimId) || claimIds.has(connection.toClaimId));
        graphEdges = graphEdges.filter((candidate) => edgeTouchesNode(candidate, node.id));
      }
      if (typeof limit === "number") connections = connections.slice(0, limit);
      const connectionIds = new Set(connections.map((connection) => connection.id));
      const visibleGraphEdges = graphEdges.filter((candidate) => !candidate.properties?.connectionId || !connectionIds.has(candidate.properties.connectionId));
      if (connections.length === 0 && visibleGraphEdges.length === 0) return "<h2>Connections</h2><div class='empty'>No connections in this view.</div>";
      const groups = ["proposed", "accepted", "rejected"].map((status) => ({
        status,
        items: connections.filter((connection) => connection.status === status)
      })).filter((group) => group.items.length > 0);
      const claimConnectionHtml = groups.map((group) =>
        "<div class='row' style='margin-top: 10px;'><span class='pill " + (group.status === "accepted" ? "good" : group.status === "rejected" ? "conflict" : "warn") + "'>" + escapeHtml(group.status) + "</span><span class='fine'>" + group.items.length + " links</span></div>" +
        group.items.map((connection) => renderConnectionDetail(connection, state.selectedEdgeId === "edge:connection:" + connection.id)).join("")
      ).join("");
      const graphEdgeHtml = visibleGraphEdges.length
        ? "<h2>Graph links</h2>" + visibleGraphEdges.slice(0, typeof limit === "number" ? limit : 80).map((candidate) => renderGraphEdgeDetail(candidate, candidate.id === state.selectedEdgeId)).join("")
        : "";
      return "<h2>Connections</h2>" + (claimConnectionHtml || "<div class='empty'>No claim-to-claim connections in this view.</div>") + graphEdgeHtml;
    }

    function renderConnectionDetail(connection, selected) {
      const from = claimById(connection.fromClaimId);
      const to = claimById(connection.toClaimId);
      const scoreWidth = Math.round(Number(connection.confidence || 0) * 100);
      return "<div class='panel " + (selected ? "selected" : "") + "'>" +
        "<div class='connection-row'><div><h3>" + escapeHtml(connection.connectionType.replaceAll("_", " ")) + "</h3>" +
        "<div class='row'><span class='pill " + statusClass(connection.status) + "'>" + escapeHtml(connection.status) + "</span><span class='pill'>" + Number(connection.confidence || 0).toFixed(2) + " confidence</span></div></div>" +
        "<button type='button' class='ghost' data-select-connection='" + escapeHtml(connection.id) + "'>Inspect</button></div>" +
        "<div class='scorebar'><span style='width:" + scoreWidth + "%'></span></div>" +
        "<p class='claim-line'><small>From</small>" + escapeHtml(from?.claim.statement || connection.fromClaimId) + "</p>" +
        "<p class='claim-line'><small>To</small>" + escapeHtml(to?.claim.statement || connection.toClaimId) + "</p>" +
        (connection.rationale ? "<p class='fine'>" + escapeHtml(connection.rationale) + "</p>" : "") +
        "<details><summary>Score components</summary><pre>" + escapeHtml(JSON.stringify(connection.scoreComponents || {}, null, 2)) + "</pre></details>" +
        "<div class='row'><button data-connection='" + escapeHtml(connection.id) + "' data-status='accepted'>Accept</button>" +
        "<button class='danger' data-connection='" + escapeHtml(connection.id) + "' data-status='rejected'>Reject</button></div></div>";
    }

    function renderGraphEdgeDetail(edge, selected) {
      const source = findNode(edge.source?.id || edge.fromNodeId);
      const target = findNode(edge.target?.id || edge.toNodeId);
      const connection = connectionForEdge(edge);
      if (connection) return renderConnectionDetail(connection, selected);
      return "<div class='panel " + (selected ? "selected" : "") + "'>" +
        "<div class='connection-row'><div><h3>" + escapeHtml(edge.edgeType.replaceAll("_", " ")) + "</h3>" +
        "<div class='row'><span class='pill'>" + Number(edge.weight || 0).toFixed(2) + " weight</span></div></div>" +
        "<button type='button' class='ghost' data-select-edge='" + escapeHtml(edge.id) + "'>Inspect</button></div>" +
        "<p class='claim-line'><small>From</small>" + escapeHtml(source?.label || edge.fromNodeId) + "</p>" +
        "<p class='claim-line'><small>To</small>" + escapeHtml(target?.label || edge.toNodeId) + "</p></div>";
    }

    function renderEvidencePanel(node) {
      let claims = state.cluster.claims;
      if (node?.nodeType === "claim") claims = claims.filter((item) => "claim:" + item.claim.id === node.id);
      if (node && node.nodeType !== "claim") claims = claimsConnectedToNode(node.id);
      const seen = new Set();
      const evidence = [];
      for (const item of claims) {
        for (const span of item.evidenceSpans || []) {
          if (seen.has(span.id)) continue;
          seen.add(span.id);
          evidence.push({ span, claim: item.claim });
        }
      }
      if (evidence.length === 0) return "<h2>Evidence</h2><div class='empty'>No evidence spans in this view.</div>";
      return "<h2>Evidence</h2>" + evidence.map(({ span, claim }) =>
        "<div class='panel'><div class='row'><span class='pill'>lines " + span.startLine + "-" + span.endLine + "</span><span class='pill'>" + escapeHtml(span.sourceVersionId) + "</span></div>" +
        "<pre>" + escapeHtml(span.text) + "</pre><p class='fine'>Supports: " + escapeHtml(truncate(claim.statement, 140)) + "</p></div>"
      ).join("");
    }

    function renderConflictsPanel(node, limit) {
      let conflicts = state.cluster.conflicts;
      if (node?.nodeType === "claim") {
        conflicts = conflicts.filter((conflict) => conflict.members.some((member) => member.claimId === node.refId));
      } else if (node && node.nodeType !== "claim") {
        const claimIds = new Set(claimsConnectedToNode(node.id).map((item) => item.claim.id));
        conflicts = conflicts.filter((conflict) => conflict.members.some((member) => claimIds.has(member.claimId)));
      }
      if (typeof limit === "number") conflicts = conflicts.slice(0, limit);
      if (conflicts.length === 0) return "<h2>Conflicts</h2><div class='empty'>No conflicts in this view.</div>";
      return "<h2>Conflicts</h2>" + conflicts.map((conflict) => {
        const members = conflict.members.map((member) => {
          const claim = claimById(member.claimId);
          return "<div class='panel'><span class='pill conflict'>" + escapeHtml(member.role) + "</span><p>" + escapeHtml(claim?.claim.statement || member.claimId) + "</p><p class='fine'>Evidence: " + escapeHtml(member.evidenceSpanIds.join(", ")) + "</p></div>";
        }).join("");
        return "<div class='panel conflict'><div class='row'><span class='pill conflict'>" + escapeHtml(conflict.severity) + "</span><span class='pill'>" + escapeHtml(conflict.status) + "</span><span class='pill'>" + escapeHtml(conflict.conflictType) + "</span></div>" +
          "<p>" + escapeHtml(conflict.summary) + "</p>" + members +
          (conflict.status === "open" ? "<textarea data-resolution-id='" + escapeHtml(conflict.id) + "' placeholder='Resolution rationale'></textarea><div class='row'><button data-resolve='" + escapeHtml(conflict.id) + "'>Resolve conflict</button></div>" : "") +
          "</div>";
      }).join("");
    }

    function renderActionsPanel(node, edge, connection) {
      const claim = node?.nodeType === "claim" ? claimForNode(node) : null;
      const selectedConnection = connection || (edge ? connectionForEdge(edge) : null);
      let html = "<h2>Actions</h2>";
      if (claim) html += "<div class='panel selected'><h3>Claim actions</h3><p class='fine'>" + escapeHtml(truncate(claim.claim.statement, 170)) + "</p>" + preferenceButtons(claim.claim.id) + "</div>";
      if (selectedConnection) html += renderConnectionDetail(selectedConnection, true);
      html += "<div class='panel'><h3>Projection</h3><p class='fine'>Refresh the graph projection after reviewing links or conflicts.</p><button type='button' class='secondary' id='inspector-rebuild'>Rebuild graph</button></div>";
      if (!claim && !selectedConnection) html += "<div class='empty'>Select a claim or connection for targeted review actions.</div>";
      return html;
    }

    function preferenceButtons(claimId) {
      return "<div class='row'><button data-pin='" + escapeHtml(claimId) + "'>Pin to initiative</button><button class='secondary' data-exclude='" + escapeHtml(claimId) + "'>Exclude from synthesis</button></div>";
    }

    detailsEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const inspectConnectionId = target.dataset.selectConnection;
      if (inspectConnectionId) {
        const edge = state.graph.edges.find((candidate) => candidate.properties?.connectionId === inspectConnectionId);
        if (edge) {
          state.selectedEdgeId = edge.id;
          state.selectedNodeId = null;
          state.activeTab = "overview";
          updateFocusStyles();
          renderInspector();
        }
        return;
      }
      const inspectEdgeId = target.dataset.selectEdge;
      if (inspectEdgeId) {
        const edge = findEdge(inspectEdgeId);
        if (edge) {
          state.selectedEdgeId = edge.id;
          state.selectedNodeId = null;
          state.activeTab = "overview";
          updateFocusStyles();
          renderInspector();
        }
        return;
      }
      const connectionId = target.dataset.connection;
      if (connectionId) {
        target.disabled = true;
        await fetch("/api/graph/connections/" + encodeURIComponent(connectionId) + "/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: target.dataset.status, reviewerLabel: "graph-reviewer" })
        });
        await loadCluster(state.cluster.id);
        return;
      }
      const conflictId = target.dataset.resolve;
      if (conflictId) {
        target.disabled = true;
        const textarea = Array.from(detailsEl.querySelectorAll("textarea[data-resolution-id]")).find((item) => item.dataset.resolutionId === conflictId);
        await fetch("/api/graph/conflicts/" + encodeURIComponent(conflictId) + "/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resolutionType: "reviewed", rationale: textarea?.value || "Resolved in graph review.", reviewerLabel: "graph-reviewer" })
        });
        await loadCluster(state.cluster.id);
        return;
      }
      if (target.dataset.pin) {
        target.disabled = true;
        await fetch("/api/graph/claims/" + encodeURIComponent(target.dataset.pin) + "/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: true, reviewerLabel: "graph-reviewer" }) });
        target.textContent = "Pinned";
        return;
      }
      if (target.dataset.exclude) {
        target.disabled = true;
        await fetch("/api/graph/claims/" + encodeURIComponent(target.dataset.exclude) + "/exclude-from-synthesis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: true, reviewerLabel: "graph-reviewer" }) });
        target.textContent = "Excluded";
        return;
      }
      if (target.id === "inspector-rebuild") {
        document.querySelector("#rebuild").click();
      }
    });

    function updateFocusStyles() {
      if (!d3Graph) return;
      const selectedNodeId = state.selectedNodeId;
      const selectedEdgeId = state.selectedEdgeId;
      const connectedIds = new Set();
      if (selectedNodeId) {
        connectedIds.add(selectedNodeId);
        for (const edge of state.graph.edges) {
          const sourceId = edge.source?.id || edge.fromNodeId;
          const targetId = edge.target?.id || edge.toNodeId;
          if (sourceId === selectedNodeId || targetId === selectedNodeId) {
            connectedIds.add(sourceId);
            connectedIds.add(targetId);
          }
        }
      }
      if (selectedEdgeId) {
        const edge = findEdge(selectedEdgeId);
        if (edge) {
          connectedIds.add(edge.source?.id || edge.fromNodeId);
          connectedIds.add(edge.target?.id || edge.toNodeId);
        }
      }
      const hasSelection = Boolean(selectedNodeId || selectedEdgeId);
      d3Graph.select(svg).selectAll(".node")
        .classed("selected", (item) => item.id === selectedNodeId)
        .classed("neighbor", (item) => connectedIds.has(item.id) && item.id !== selectedNodeId)
        .classed("faded", (item) => hasSelection && !connectedIds.has(item.id));
      d3Graph.select(svg).selectAll(".edge")
        .classed("selected", (edge) => edge.id === selectedEdgeId)
        .classed("faded", (edge) => {
          if (!hasSelection) return false;
          const sourceId = edge.source?.id || edge.fromNodeId;
          const targetId = edge.target?.id || edge.toNodeId;
          if (edge.id === selectedEdgeId) return false;
          return !(connectedIds.has(sourceId) && connectedIds.has(targetId));
        });
      d3Graph.select(svg).selectAll(".edge-label")
        .classed("visible", (edge) => edge.id === selectedEdgeId || Boolean(selectedNodeId && (edge.source?.id === selectedNodeId || edge.target?.id === selectedNodeId)));
    }

    function centerGraph(animated) {
      if (!state.graph.zoom || !d3Graph) return;
      const width = Math.max(360, svg.clientWidth || 720);
      const height = Math.max(360, svg.clientHeight || 640);
      const transform = d3Graph.zoomIdentity.translate(width * .04, height * .04).scale(.92);
      const selection = d3Graph.select(svg);
      if (animated) selection.transition().duration(260).call(state.graph.zoom.transform, transform);
      else selection.call(state.graph.zoom.transform, transform);
    }

    function zoomBy(amount) {
      if (!state.graph.zoom || !d3Graph) return;
      d3Graph.select(svg).transition().duration(180).call(state.graph.zoom.scaleBy, amount);
    }

    function markSelectedCluster() {
      clustersEl.querySelectorAll(".cluster").forEach((button) => {
        button.setAttribute("aria-selected", String(button.dataset.clusterId === state.selectedClusterId));
      });
    }

    function renderTabs() {
      document.querySelectorAll("[data-tab]").forEach((button) => {
        button.setAttribute("aria-selected", String(button.dataset.tab === state.activeTab));
      });
    }

    function metric(label, value) {
      return "<div class='metric'><strong>" + escapeHtml(value) + "</strong><span>" + escapeHtml(label) + "</span></div>";
    }

    function nodeRadius(node) {
      if (node.nodeType === "claim") return 18;
      if (node.nodeType === "entity") return 15;
      if (node.nodeType === "evidence") return 11;
      return 12;
    }

    function edgeDistance(edge) {
      if (edge.edgeType === "mentions") return 108;
      if (edge.edgeType === "supported_by") return 96;
      return 164;
    }

    function edgeStrength(edge) {
      if (edge.edgeType === "mentions") return .55;
      if (edge.edgeType === "supported_by") return .32;
      return .68;
    }

    function edgeClass(edge) {
      const status = edge.properties?.status || "";
      return [edge.edgeType, status].filter(Boolean).join(" ");
    }

    function statusClass(status) {
      return status === "accepted" ? "good" : status === "rejected" ? "conflict" : "warn";
    }

    function claimForNode(node) {
      return state.cluster.claims.find((candidate) => "claim:" + candidate.claim.id === node.id);
    }

    function claimById(id) {
      return state.cluster.claims.find((candidate) => candidate.claim.id === id);
    }

    function evidenceById(id) {
      for (const claim of state.cluster.claims) {
        const evidence = (claim.evidenceSpans || []).find((span) => span.id === id);
        if (evidence) return evidence;
      }
      return null;
    }

    function findNode(id) {
      return state.graph.nodes.find((node) => node.id === id) || null;
    }

    function findEdge(id) {
      return state.graph.edges.find((edge) => edge.id === id) || null;
    }

    function connectionForEdge(edge) {
      const id = edge?.properties?.connectionId;
      if (!id) return null;
      return state.cluster.connections.find((connection) => connection.id === id) || null;
    }

    function connectionsForClaim(claimId) {
      return state.cluster.connections.filter((connection) => connection.fromClaimId === claimId || connection.toClaimId === claimId);
    }

    function edgeTouchesNode(edge, nodeId) {
      return (edge.source?.id || edge.fromNodeId) === nodeId || (edge.target?.id || edge.toNodeId) === nodeId;
    }

    function claimsConnectedToNode(nodeId) {
      const claimIds = new Set();
      for (const edge of state.graph.edges) {
        const sourceId = edge.source?.id || edge.fromNodeId;
        const targetId = edge.target?.id || edge.toNodeId;
        if (sourceId === nodeId && String(targetId).startsWith("claim:")) claimIds.add(String(targetId).slice(6));
        if (targetId === nodeId && String(sourceId).startsWith("claim:")) claimIds.add(String(sourceId).slice(6));
      }
      return state.cluster.claims.filter((item) => claimIds.has(item.claim.id));
    }

    function claimSummary(item) {
      return "<div class='panel'><span class='pill'>" + escapeHtml(item.claim.claimType) + "</span><p>" + escapeHtml(item.claim.statement) + "</p><p class='fine'>Evidence: " + escapeHtml(item.claim.evidenceSpanIds.join(", ")) + "</p></div>";
    }

    function labelForClusterId(id) {
      return state.clusters.find((cluster) => cluster.id === id)?.label || id;
    }

    function nodeTooltip(node) {
      return "<strong>" + escapeHtml(node.label) + "</strong><br><span class='fine'>" + escapeHtml(node.nodeType) + "</span>";
    }

    function edgeTooltip(edge) {
      const connection = connectionForEdge(edge);
      if (connection) return "<strong>" + escapeHtml(connection.connectionType.replaceAll("_", " ")) + "</strong><br>" + escapeHtml(connection.status) + " · " + Number(connection.confidence || 0).toFixed(2);
      return "<strong>" + escapeHtml(edge.edgeType.replaceAll("_", " ")) + "</strong><br>weight " + Number(edge.weight || 0).toFixed(2);
    }

    function showTooltip(event, html) {
      tooltipEl.innerHTML = html;
      tooltipEl.style.left = event.clientX + "px";
      tooltipEl.style.top = event.clientY + "px";
      tooltipEl.style.opacity = "1";
    }

    function hideTooltip() {
      tooltipEl.style.opacity = "0";
    }

    function setStatus(message, isError) {
      clusterStatusEl.textContent = message || "";
      clusterStatusEl.classList.toggle("error", Boolean(isError));
    }
    function truncate(value, max) { return String(value).length > max ? String(value).slice(0, max - 3) + "..." : String(value); }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}

function renderSynthesisShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Distillery Synthesis v0</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #f8fafc; }
    main { width: min(960px, calc(100vw - 32px)); padding: 32px 0; }
    .card { background: #111827; border: 1px solid #263244; border-radius: 20px; padding: 24px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin-top: 28px; font-size: 20px; }
    p, small { color: #cbd5e1; line-height: 1.5; }
    textarea, input { width: 100%; box-sizing: border-box; border: 1px solid #334155; border-radius: 12px; background: #0f172a; color: #f8fafc; padding: 12px; font: inherit; }
    textarea { min-height: 90px; resize: vertical; }
    button { border: 0; border-radius: 12px; padding: 12px 16px; background: #38bdf8; color: #082f49; font-weight: 700; cursor: pointer; }
    button.secondary { background: #334155; color: #e2e8f0; }
    button.danger { background: #fb7185; color: #450a0a; }
    button:disabled { opacity: .6; cursor: wait; }
    a { color: #7dd3fc; }
    .row { display: flex; gap: 12px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .hidden { display: none; }
    .memory, .brief { border: 1px solid #334155; border-radius: 12px; padding: 12px; margin-top: 12px; background: #0f172a; }
    .memory label { display: flex; gap: 10px; align-items: flex-start; }
    pre { white-space: pre-wrap; word-break: break-word; background: #020617; border-radius: 12px; padding: 16px; overflow: auto; }
    ${loopDrawerStyles()}
  </style>
</head>
<body>
  <main>
    <section class="card" id="login-card">
      <h1>Distillery Synthesis</h1>
      <p>Enter the shared v0 password.</p>
      <form id="login-form">
        <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
        <div class="row"><button>Enter</button><span id="login-status"></span></div>
      </form>
    </section>

    <section class="card hidden" id="app-card">
      <h1>Memory Synthesis</h1>
      <p>Select evidence-backed memory, optionally say what the brief should focus on, and let Distillery draft the initiative brief for review.</p>
      <p><a href="/">Memory Generation</a> · <a href="/briefs">Briefs</a> · <a href="/graph">Graph</a></p>
      <div class="row"><button id="logout" type="button" class="secondary">Log out</button></div>
      <div class="row">
        <button id="load-memory" type="button">Load active memory</button>
        <button id="load-opportunities" type="button" class="secondary">Load opportunities</button>
        <button id="load-proposals" type="button" class="secondary">Load pending memory</button>
        <button id="load-briefs" type="button" class="secondary">Load briefs</button>
        <button id="loop-open" type="button" class="secondary loop-button">Loop</button>
        <span id="status"></span>
      </div>

      <h2>Pending memory review</h2>
      <div id="pending-memory-list"></div>

      <h2>Ranked brief opportunities</h2>
      <p>These are corpus-wide clusters. Scores are deterministic; drafts still require human review.</p>
      <div id="opportunity-list"></div>

      <h2>1. Select memory</h2>
      <div id="memory-list"></div>

      <h2>2. Generate a brief</h2>
      <p><textarea id="intent" placeholder="Optional: what should this brief focus on? Example: turn this into a launch-readiness brief for leadership."></textarea></p>
      <p><label><input id="selection-only" type="checkbox" /> Use only the selected memory (disable corpus expansion)</label></p>
      <div class="row">
        <button id="generate-brief" type="button">Generate brief</button>
        <button id="manual-brief" type="button" class="secondary">Write manually instead</button>
        <span id="draft-status"></span>
      </div>

      <form id="brief-form" class="hidden">
        <h2>3. Review draft</h2>
        <p><input id="title" placeholder="Initiative title" /></p>
        <p><textarea id="problem" placeholder="Problem"></textarea></p>
        <p><textarea id="proposal" placeholder="Proposal / scope"></textarea></p>
        <p><textarea id="successMetric" placeholder="Success metric"></textarea></p>
        <p><textarea id="risksAndDependencies" placeholder="Risks and dependencies, optional"></textarea></p>
        <small id="draft-evidence"></small>
        <div class="row"><button>Save draft brief</button></div>
      </form>

      <h2>Saved briefs</h2>
      <div id="brief-list"></div>
      <pre id="result"></pre>
    </section>
  </main>
  ${loopDrawerMarkup()}
  <script>
    const loginCard = document.querySelector("#login-card");
    const appCard = document.querySelector("#app-card");
    const loginForm = document.querySelector("#login-form");
    const statusEl = document.querySelector("#status");
    const resultEl = document.querySelector("#result");
    const memoryList = document.querySelector("#memory-list");
    const pendingMemoryList = document.querySelector("#pending-memory-list");
    const opportunityList = document.querySelector("#opportunity-list");
    const briefList = document.querySelector("#brief-list");
    const logoutButton = document.querySelector("#logout");
    const loginStatusEl = document.querySelector("#login-status");
    const briefForm = document.querySelector("#brief-form");
    const draftStatusEl = document.querySelector("#draft-status");
    const draftEvidenceEl = document.querySelector("#draft-evidence");
    const loopController = initLoopDrawer();
    let editingBriefId = null;

    checkSession();

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.querySelector("#password").value;
      const response = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        loginStatusEl.textContent = "Invalid password";
        return;
      }
      openApp();
    });

    logoutButton.addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      showLogin("Logged out");
    });

    document.querySelector("#load-memory").addEventListener("click", loadMemory);
    document.querySelector("#load-opportunities").addEventListener("click", loadOpportunities);
    document.querySelector("#load-proposals").addEventListener("click", loadMemoryProposals);
    document.querySelector("#load-briefs").addEventListener("click", loadBriefs);
    document.querySelector("#generate-brief").addEventListener("click", generateBriefDraft);
    document.querySelector("#manual-brief").addEventListener("click", () => {
      showBriefForm();
      draftStatusEl.textContent = "Manual mode";
    });

    briefForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const memoryItemIds = [...document.querySelectorAll("input[name=memory]:checked")].map((input) => input.value);
      if (!editingBriefId && memoryItemIds.length === 0) {
        statusEl.textContent = "Select at least one memory item";
        return;
      }
      statusEl.textContent = "Creating brief...";
      const payload = {
        title: document.querySelector("#title").value,
        problem: document.querySelector("#problem").value,
        proposal: document.querySelector("#proposal").value,
        successMetric: document.querySelector("#successMetric").value,
        risksAndDependencies: document.querySelector("#risksAndDependencies").value || undefined,
        memoryItemIds,
        createdByLabel: reviewerLabel()
      };
      if (editingBriefId) {
        delete payload.memoryItemIds;
        delete payload.createdByLabel;
      }
      const response = await fetch(editingBriefId ? "/api/initiative-briefs/" + encodeURIComponent(editingBriefId) : "/api/initiative-briefs", {
        method: editingBriefId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (handleUnauthorized(response)) return;
      const brief = await response.json();
      resultEl.textContent = JSON.stringify(brief, null, 2);
      statusEl.textContent = response.ok ? (editingBriefId ? "Draft changes saved" : "Brief created") : "Failed";
      if (response.ok) {
        editingBriefId = null;
        loadBriefs();
      }
    });

    async function generateBriefDraft() {
      const memoryItemIds = [...document.querySelectorAll("input[name=memory]:checked")].map((input) => input.value);
      if (memoryItemIds.length === 0) {
        draftStatusEl.textContent = "Select at least one memory item";
        return;
      }
      if (memoryItemIds.length > ${MAX_DRAFT_MEMORY_ITEMS}) {
        draftStatusEl.textContent = "Select at most ${MAX_DRAFT_MEMORY_ITEMS} closely related memory items";
        return;
      }

      draftStatusEl.textContent = "Generating draft...";
      resultEl.textContent = "";
      const intent = document.querySelector("#intent").value;
      const generateButton = document.querySelector("#generate-brief");
      generateButton.disabled = true;
      try {
        const response = await fetchWithTimeout("/api/initiative-brief-drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            memoryItemIds,
            intent: intent || undefined,
            expandRelatedMemory: !document.querySelector("#selection-only").checked
          })
        }, 45000);
        if (handleUnauthorized(response)) return;
        const draft = await readJsonResponse(response);
        resultEl.textContent = JSON.stringify(draft, null, 2);

        if (!response.ok) {
          draftStatusEl.textContent = draft.error || "Draft failed; use manual mode or adjust selected memory";
          return;
        }

        document.querySelector("#title").value = draft.title || "";
        document.querySelector("#problem").value = draft.problem || "";
        document.querySelector("#proposal").value = draft.proposal || "";
        document.querySelector("#successMetric").value = draft.successMetric || "";
        document.querySelector("#risksAndDependencies").value = draft.risksAndDependencies || "";
        draftEvidenceEl.textContent = "Included " + (draft.includedMemory || []).length + " memories. Traceable to evidence: " + (draft.evidenceSpanIds || []).join(", ");
        showBriefForm();
        draftStatusEl.textContent = "Draft ready to review";
      } catch (error) {
        const isAbort = error && error.name === "AbortError";
        const message = String(error && error.message ? error.message : error);
        draftStatusEl.textContent = isAbort
          ? "Draft took too long. Select fewer, closely related memory items and try again."
          : "Draft failed: " + message;
        resultEl.textContent = message;
      } finally {
        generateButton.disabled = false;
      }
    }

    async function loadMemory() {
      statusEl.textContent = "Loading memory...";
      const response = await fetch("/api/memory-items?limit=200");
      if (handleUnauthorized(response)) return;
      const items = await readJsonResponse(response);
      memoryList.innerHTML = "";
      if (!response.ok || !Array.isArray(items)) {
        memoryList.innerHTML = "<p>Could not load memory.</p>";
        resultEl.textContent = JSON.stringify(items, null, 2);
        statusEl.textContent = "Failed";
        return;
      }
      if (items.length === 0) {
        memoryList.innerHTML = "<p>No active memory found.</p>";
        statusEl.textContent = "No memory";
        return;
      }
      for (const record of items) {
        const memory = record.memoryItem;
        const evidence = (record.evidenceSpans || []).map((span) => "[" + span.id + "] " + span.text).join("\\n");
        const div = document.createElement("div");
        div.className = "memory";
        div.innerHTML = '<label><input type="checkbox" name="memory" value="' + escapeHtml(memory.id) + '" /><span><strong>' + escapeHtml(memory.claimType) + '</strong><br />' + escapeHtml(memory.statement) + '<br /><small>' + escapeHtml(memory.reviewState || "unreviewed") + ' · evidence: ' + escapeHtml(memory.evidenceSpanIds.join(", ")) + '</small></span></label>' + traceDetailsHtml(memory, evidence);
        memoryList.append(div);
      }
      statusEl.textContent = "Memory loaded (" + items.length + ")";
    }

    async function loadOpportunities() {
      statusEl.textContent = "Loading corpus-wide opportunities...";
      const response = await fetch("/api/synthesis/opportunities?limit=50");
      if (handleUnauthorized(response)) return;
      const opportunities = await readJsonResponse(response);
      opportunityList.innerHTML = "";
      if (!response.ok || !Array.isArray(opportunities)) {
        opportunityList.innerHTML = "<p>Could not load opportunities.</p>";
        statusEl.textContent = "Failed";
        return;
      }
      if (opportunities.length === 0) {
        opportunityList.innerHTML = "<p>No cluster has been discovered yet. Enrichment or the next bounded sweep may still be pending.</p>";
        statusEl.textContent = "No opportunities yet";
        return;
      }
      for (const opportunity of opportunities) {
        const cluster = opportunity.cluster;
        const dossier = opportunity.dossier || {};
        const readiness = cluster.readiness || {};
        const suggestedDrafts = opportunity.suggestedDrafts || [];
        const suggestedDraftSummary = suggestedDrafts.length === 0
          ? "none yet"
          : suggestedDrafts.map((suggestion) =>
              "v" + suggestion.version + " · " + suggestion.status + " · " +
              (suggestion.draft?.title || suggestion.initiativeBriefId) + " · " +
              (suggestion.changesSincePreviousVersion || []).join(" ")
            ).join(" | ");
        const div = document.createElement("div");
        div.className = "brief";
        const memberIds = (cluster.memberships || []).map((membership) => membership.memoryItemId);
        div.innerHTML = "<strong>" + escapeHtml(cluster.label) + "</strong>" +
          "<p>" + escapeHtml(cluster.resolution.replaceAll("_", " ")) + " · " + escapeHtml(readiness.state || "awaiting evaluation") + " · score " + escapeHtml(readiness.score == null ? "—" : Number(readiness.score).toFixed(1)) + "/100</p>" +
          "<p><b>Why now:</b> " + escapeHtml((readiness.reasons || []).join(" ")) + "</p>" +
          "<p><b>Members:</b> " + escapeHtml(memberIds.join(", ")) + "</p>" +
          "<p><b>Evidence:</b> " + escapeHtml((dossier.selectedEvidenceSpans || []).map((span) => span.id).join(", ")) + "</p>" +
          "<p><b>Contradictions:</b> " + escapeHtml((dossier.contradictions || []).map((conflict) => conflict.summary).join("; ") || "none") + "</p>" +
          "<p><b>Missing:</b> " + escapeHtml((dossier.missingInformation || []).join("; ") || "none recorded") + "</p>" +
          "<p><b>Suggested drafts:</b> " + escapeHtml(suggestedDraftSummary) + "</p>" +
          '<div class="row"><button type="button" data-action="explore">Generate/edit now</button><button type="button" class="secondary" data-action="regenerate">Regenerate suggestion</button></div>';
        div.querySelector('[data-action="explore"]').addEventListener("click", async () => {
          const wanted = new Set(memberIds);
          for (const checkbox of document.querySelectorAll("input[name=memory]")) checkbox.checked = wanted.has(checkbox.value);
          document.querySelector("#selection-only").checked = false;
          document.querySelector("#intent").value = "Regenerate the " + cluster.label + " opportunity as an evidence-backed initiative brief.";
          await generateBriefDraft();
        });
        div.querySelector('[data-action="regenerate"]').addEventListener("click", async () => {
          const intent = prompt("Regeneration intent", "initiative_brief") || "initiative_brief";
          statusEl.textContent = "Queueing suggested draft...";
          const response = await fetch("/api/synthesis/clusters/" + encodeURIComponent(cluster.id) + "/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ intent })
          });
          const result = await readJsonResponse(response);
          resultEl.textContent = JSON.stringify(result, null, 2);
          statusEl.textContent = response.ok ? "Suggested draft queued" : (result.error || "Queue failed");
        });
        opportunityList.append(div);
      }
      statusEl.textContent = "Opportunities loaded (" + opportunities.length + ")";
    }

    async function loadMemoryProposals() {
      statusEl.textContent = "Loading pending memory...";
      const response = await fetch("/api/memory-proposals?limit=50");
      if (handleUnauthorized(response)) return;
      const proposals = await readJsonResponse(response);
      pendingMemoryList.innerHTML = "";
      if (!response.ok || !Array.isArray(proposals)) {
        pendingMemoryList.innerHTML = "<p>Could not load pending memory.</p>";
        resultEl.textContent = JSON.stringify(proposals, null, 2);
        statusEl.textContent = "Failed";
        return;
      }
      if (proposals.length === 0) {
        pendingMemoryList.innerHTML = "<p>No pending memory.</p>";
        statusEl.textContent = "No pending memory";
        return;
      }
      for (const proposal of proposals) {
        pendingMemoryList.append(renderMemoryProposal(proposal));
      }
      statusEl.textContent = "Pending memory loaded (" + proposals.length + ")";
    }

    function renderMemoryProposal(proposal) {
      const div = document.createElement("div");
      div.className = "memory";
      const items = Array.isArray(proposal.payload?.items) ? proposal.payload.items : [];
      const statements = items.map((item) => "<p><strong>" + escapeHtml(item.claimType || "memory") + "</strong><br />" + escapeHtml(item.statement || "") + "</p>").join("");
      const reason = items.map((item) => item.qualifiers?.verificationRationale || item.qualifiers?.fallbackReason).find(Boolean) || "";
      div.innerHTML = statements
        + "<small>" + escapeHtml(proposal.id) + " · " + escapeHtml(proposal.reviewStatus || "pending") + "</small>"
        + (reason ? "<pre>" + escapeHtml(reason) + "</pre>" : "");
      const row = document.createElement("div");
      row.className = "row";
      row.append(
        actionButton("Approve memory", () => decideMemoryProposal(proposal.id, "approve")),
        actionButton("Reject", () => decideMemoryProposal(proposal.id, "reject"), "danger")
      );
      div.append(row);
      return div;
    }

    async function decideMemoryProposal(proposalId, decision) {
      const rationale = prompt("Rationale for " + decision) || "";
      statusEl.textContent = decision === "approve" ? "Approving memory..." : "Rejecting memory...";
      const response = await fetch("/api/proposed-events/" + encodeURIComponent(proposalId) + "/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reviewerLabel: reviewerLabel(), rationale })
      });
      if (handleUnauthorized(response)) return;
      const result = await readJsonResponse(response);
      resultEl.textContent = JSON.stringify(result, null, 2);
      statusEl.textContent = response.ok ? "Memory proposal reviewed" : "Failed";
      if (response.ok) {
        await loadMemoryProposals();
        await loadMemory();
      }
    }

    async function loadBriefs() {
      statusEl.textContent = "Loading briefs...";
      const response = await fetch("/api/initiative-briefs");
      if (handleUnauthorized(response)) return;
      const briefs = await response.json();
      renderBriefs(briefs);
      statusEl.textContent = response.ok ? "Briefs loaded" : "Failed";
    }

    function renderBriefs(briefs) {
      briefList.innerHTML = "";
      for (const brief of briefs) {
        const evidence = (brief.evidenceSpans || []).map((span) => "[" + span.id + "] lines " + span.startLine + "-" + span.endLine + ": " + span.text).join("\\n");
        const decisions = (brief.decisions || []).map((decision) => decision.decision + " by " + decision.reviewerLabel + (decision.rationale ? ": " + decision.rationale : "")).join("\\n");
        const div = document.createElement("div");
        div.className = "brief";
        div.innerHTML = "<h3>" + escapeHtml(brief.title) + " <small>(" + escapeHtml(brief.status) + ")</small></h3>"
          + "<p><strong>Problem:</strong> " + escapeHtml(brief.problem) + "</p>"
          + "<p><strong>Proposal:</strong> " + escapeHtml(brief.proposal) + "</p>"
          + "<p><strong>Success metric:</strong> " + escapeHtml(brief.successMetric) + "</p>"
          + (brief.risksAndDependencies ? "<p><strong>Risks/dependencies:</strong> " + escapeHtml(brief.risksAndDependencies) + "</p>" : "")
          + "<small>memory: " + escapeHtml((brief.memoryItemIds || []).join(", ")) + " · evidence: " + escapeHtml((brief.evidenceSpanIds || []).join(", ")) + "</small>"
          + "<pre>" + escapeHtml(evidence) + "</pre>"
          + (decisions ? "<pre>" + escapeHtml(decisions) + "</pre>" : "");
        const row = document.createElement("div");
        row.className = "row";
        row.append(
          actionButton("Edit draft", () => editBrief(brief)),
          actionButton("Approve", () => decideBrief(brief.id, "approve")),
          actionButton("Reject", () => decideBrief(brief.id, "reject"), "danger")
        );
        div.append(row);
        briefList.append(div);
      }
    }

    function editBrief(brief) {
      if (brief.status !== "draft") {
        statusEl.textContent = "Only draft briefs can be edited";
        return;
      }
      editingBriefId = brief.id;
      document.querySelector("#title").value = brief.title || "";
      document.querySelector("#problem").value = brief.problem || "";
      document.querySelector("#proposal").value = brief.proposal || "";
      document.querySelector("#successMetric").value = brief.successMetric || "";
      document.querySelector("#risksAndDependencies").value = brief.risksAndDependencies || "";
      draftEvidenceEl.textContent = "Editing " + brief.id + ". Existing memory and evidence bindings are preserved.";
      showBriefForm();
      briefForm.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function decideBrief(briefId, decision) {
      const rationale = prompt("Rationale for " + decision) || "";
      statusEl.textContent = "Recording decision...";
      const response = await fetch("/api/initiative-briefs/" + encodeURIComponent(briefId) + "/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reviewerLabel: reviewerLabel(), rationale })
      });
      if (handleUnauthorized(response)) return;
      const brief = await response.json();
      resultEl.textContent = JSON.stringify(brief, null, 2);
      statusEl.textContent = response.ok ? "Decision recorded" : "Failed";
      if (response.ok) loadBriefs();
    }

    function actionButton(label, handler, className = "secondary") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = className;
      button.addEventListener("click", handler);
      return button;
    }

    function reviewerLabel() {
      const existing = localStorage.getItem("distillery_reviewer_label");
      if (existing) return existing;
      const entered = prompt("Your name/email for the audit trail") || "Shared password user";
      localStorage.setItem("distillery_reviewer_label", entered);
      return entered;
    }

    async function checkSession() {
      const response = await fetch("/api/session");
      if (response.ok) {
        openApp();
      }
    }

    function openApp() {
      showApp();
      loadMemoryProposals();
      loadMemory();
      loadOpportunities();
      loadBriefs();
    }

    function showApp() {
      loginStatusEl.textContent = "";
      loginCard.classList.add("hidden");
      appCard.classList.remove("hidden");
    }

    function showLogin(message) {
      appCard.classList.add("hidden");
      loginCard.classList.remove("hidden");
      loginStatusEl.textContent = message || "";
    }

    function showBriefForm() {
      briefForm.classList.remove("hidden");
    }

    function handleUnauthorized(response) {
      if (response.status !== 401) return false;
      showLogin("Session expired");
      statusEl.textContent = "";
      return true;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    }

    async function readJsonResponse(response) {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { error: text.slice(0, 500) };
      }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }

    function traceDetailsHtml(memory, evidenceText) {
      const entities = JSON.stringify(memory.entities || [], null, 2);
      const relations = JSON.stringify(memory.relations || [], null, 2);
      const schemas = JSON.stringify(memory.schemas || [], null, 2);
      const evidence = typeof evidenceText === "string" ? evidenceText : "";
      return '<details><summary>Trace details</summary>'
        + '<small>Entities</small><pre>' + escapeHtml(entities) + '</pre>'
        + '<small>Relations</small><pre>' + escapeHtml(relations) + '</pre>'
        + '<small>Schema candidates</small><pre>' + escapeHtml(schemas) + '</pre>'
        + (evidence ? '<small>Evidence</small><pre>' + escapeHtml(evidence) + '</pre>' : '')
        + '</details>';
    }

    ${loopDrawerScript()}
  </script>
</body>
</html>`;
}

function loopDrawerStyles(): string {
  return `
    .loop-button[data-busy="true"]::after { content: ""; display: inline-block; width: 7px; height: 7px; margin-left: 8px; border-radius: 999px; background: #fbbf24; vertical-align: middle; }
    .loop-backdrop { position: fixed; inset: 0; background: rgba(2, 6, 23, .55); opacity: 0; pointer-events: none; transition: opacity .16s ease; z-index: 20; }
    .loop-backdrop.open { opacity: 1; pointer-events: auto; }
    .loop-drawer { position: fixed; top: 0; right: 0; width: min(520px, 100vw); height: 100vh; background: #0f172a; border-left: 1px solid #334155; box-shadow: -28px 0 80px rgba(0,0,0,.42); transform: translateX(100%); transition: transform .18s ease; z-index: 21; display: flex; flex-direction: column; }
    .loop-drawer.open { transform: translateX(0); }
    .loop-header { padding: 18px; border-bottom: 1px solid #263244; display: grid; gap: 10px; }
    .loop-header h2 { margin: 0; font-size: 20px; }
    .loop-header p { margin: 0; color: #cbd5e1; }
    .loop-header-actions { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .loop-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 18px 0; }
    .loop-tabs button { background: #1e293b; color: #cbd5e1; padding: 10px 12px; }
    .loop-tabs button.active { background: #38bdf8; color: #082f49; }
    .loop-content { padding: 18px; overflow: auto; display: grid; gap: 18px; }
    .loop-stage-grid { display: grid; gap: 8px; }
    .loop-stage { display: grid; grid-template-columns: 26px 1fr; gap: 10px; align-items: start; padding: 10px; border: 1px solid #263244; background: #111827; border-radius: 8px; }
    .loop-dot { width: 14px; height: 14px; border-radius: 999px; margin-top: 3px; background: #475569; box-shadow: 0 0 0 3px rgba(71,85,105,.22); }
    .loop-stage.completed .loop-dot, .loop-item.success { border-color: #22c55e; }
    .loop-stage.completed .loop-dot { background: #22c55e; }
    .loop-stage.running .loop-dot, .loop-stage.pending .loop-dot, .loop-stage.waiting .loop-dot { background: #fbbf24; }
    .loop-stage.failed .loop-dot { background: #fb7185; }
    .loop-stage strong, .loop-item strong { display: block; }
    .loop-stage small, .loop-item small { color: #94a3b8; }
    .loop-timeline { display: grid; gap: 10px; }
    .loop-item { border: 1px solid #263244; background: #111827; border-radius: 8px; padding: 12px; }
    .loop-item.error { border-color: #fb7185; }
    .loop-item.warning { border-color: #fbbf24; }
    .loop-item.info { border-color: #334155; }
    .loop-item details { margin-top: 10px; }
    .loop-item dl { display: grid; grid-template-columns: minmax(110px, 150px) 1fr; gap: 6px 10px; margin: 10px 0 0; }
    .loop-item dt { color: #94a3b8; }
    .loop-item dd { margin: 0; word-break: break-word; }
    .loop-empty { border: 1px dashed #334155; border-radius: 8px; padding: 14px; color: #cbd5e1; }
    @media (max-width: 560px) {
      .loop-drawer { width: 100vw; }
      .loop-item dl { grid-template-columns: 1fr; }
    }
  `;
}

function loopDrawerMarkup(): string {
  return `
  <div id="loop-backdrop" class="loop-backdrop"></div>
  <aside id="loop-drawer" class="loop-drawer" aria-label="Loop status" aria-hidden="true">
    <div class="loop-header">
      <div class="loop-header-actions">
        <h2>Loop status</h2>
        <div class="row" style="margin-top:0">
          <button id="loop-refresh" type="button" class="secondary">Refresh</button>
          <button id="loop-close" type="button" class="secondary">Close</button>
        </div>
      </div>
      <p id="loop-summary">Open the drawer to inspect loop activity.</p>
      <small id="loop-updated"></small>
    </div>
    <div class="loop-tabs" role="tablist">
      <button id="loop-tab-current" type="button" class="active">Current item</button>
      <button id="loop-tab-activity" type="button">Activity</button>
    </div>
    <div id="loop-content" class="loop-content"></div>
  </aside>`;
}

function loopDrawerScript(): string {
  return `
    function initLoopDrawer() {
      const openButton = document.querySelector("#loop-open");
      const drawer = document.querySelector("#loop-drawer");
      const backdrop = document.querySelector("#loop-backdrop");
      const closeButton = document.querySelector("#loop-close");
      const refreshButton = document.querySelector("#loop-refresh");
      const currentTab = document.querySelector("#loop-tab-current");
      const activityTab = document.querySelector("#loop-tab-activity");
      const content = document.querySelector("#loop-content");
      const summary = document.querySelector("#loop-summary");
      const updated = document.querySelector("#loop-updated");
      let activeIngestionId = localStorage.getItem("distillery_active_loop_ingestion_id") || "";
      let activeTab = activeIngestionId ? "current" : "activity";
      let timer = null;
      let latestStatus = null;
      const expandedTechnicalIds = new Set();

      if (!openButton || !drawer || !backdrop || !content) {
        return {
          setActiveIngestion() {},
          refresh() {}
        };
      }

      openButton.addEventListener("click", () => openDrawer(activeIngestionId ? "current" : "activity"));
      closeButton.addEventListener("click", closeDrawer);
      backdrop.addEventListener("click", closeDrawer);
      refreshButton.addEventListener("click", () => refreshLoopStatus());
      currentTab.addEventListener("click", () => {
        activeTab = "current";
        renderLatest();
        refreshLoopStatus();
      });
      activityTab.addEventListener("click", () => {
        activeTab = "activity";
        renderLatest();
        refreshLoopStatus();
      });
      content.addEventListener("toggle", (event) => {
        const details = event.target;
        if (!(details instanceof HTMLDetailsElement)) return;
        const item = details.closest("[data-loop-item-id]");
        const id = item ? item.getAttribute("data-loop-item-id") : "";
        if (!id) return;
        if (details.open) {
          expandedTechnicalIds.add(id);
        } else {
          expandedTechnicalIds.delete(id);
        }
      }, true);

      if (activeIngestionId) scheduleRefresh();

      function setActiveIngestion(ingestionId, shouldOpen) {
        activeIngestionId = ingestionId || "";
        if (activeIngestionId) {
          localStorage.setItem("distillery_active_loop_ingestion_id", activeIngestionId);
          activeTab = "current";
          setBusy(true);
        }
        if (shouldOpen) openDrawer("current");
        refreshLoopStatus();
        scheduleRefresh();
      }

      function openDrawer(tab) {
        activeTab = tab || activeTab;
        drawer.classList.add("open");
        backdrop.classList.add("open");
        drawer.setAttribute("aria-hidden", "false");
        renderLatest();
        refreshLoopStatus();
        scheduleRefresh();
      }

      function closeDrawer() {
        drawer.classList.remove("open");
        backdrop.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true");
        scheduleRefresh();
      }

      async function refreshLoopStatus() {
        const params = new URLSearchParams();
        params.set("limit", "25");
        if (activeTab === "current" && activeIngestionId) params.set("ingestionId", activeIngestionId);
        const response = await fetch("/api/loop-status?" + params.toString());
        if (typeof handleUnauthorized === "function" && handleUnauthorized(response)) return latestStatus;
        const status = await response.json();
        latestStatus = status;
        renderLatest();
        setBusy(Boolean(activeIngestionId && !status.isTerminal));
        scheduleRefresh();
        return status;
      }

      function renderLatest() {
        currentTab.classList.toggle("active", activeTab === "current");
        activityTab.classList.toggle("active", activeTab === "activity");

        if (!latestStatus) {
          summary.textContent = activeIngestionId ? "Loading loop status..." : "Open Activity to inspect recent loop events.";
          updated.textContent = "";
          content.innerHTML = '<div class="loop-empty">No loop status loaded yet.</div>';
          return;
        }

        summary.textContent = latestStatus.summary || "Loop status";
        updated.textContent = latestStatus.lastUpdatedAt ? "Updated " + formatLoopTime(latestStatus.lastUpdatedAt) : "";

        if (activeTab === "current") {
          if (!activeIngestionId) {
            content.innerHTML = '<div class="loop-empty">No active capture in this browser session yet. Submit a note, then open this drawer again.</div>' + renderTimeline(latestStatus.activity || []);
            return;
          }
          content.innerHTML = renderSectionProgress(latestStatus.sectionProgress) + renderStages(latestStatus.stages || []) + renderTimeline(latestStatus.timeline || []);
          return;
        }

        content.innerHTML = renderTimeline(latestStatus.activity || []);
      }

      function renderStages(stages) {
        if (!stages.length) return "";
        return '<section><h3>Stages</h3><div class="loop-stage-grid">' + stages.map((stage) =>
          '<div class="loop-stage ' + escapeHtml(stage.status) + '"><span class="loop-dot"></span><div><strong>' + escapeHtml(stage.label) + '</strong><small>' + escapeHtml(stage.status.replace("_", " ")) + (stage.occurredAt ? " · " + escapeHtml(formatLoopTime(stage.occurredAt)) : "") + '</small><p>' + escapeHtml(stage.description || "") + '</p>' + (stage.detail ? '<small>' + escapeHtml(stage.detail) + '</small>' : '') + '</div></div>'
        ).join("") + '</div></section>';
      }

      function renderSectionProgress(progress) {
        if (!progress) return "";
        const current = progress.currentSectionOrdinal
          ? '<p>Current: section ' + escapeHtml(String(progress.currentSectionOrdinal)) + ' of ' + escapeHtml(String(progress.plannedSections)) + (progress.currentSectionTitle ? ': ' + escapeHtml(progress.currentSectionTitle) : '') + '</p>'
          : '';
        return '<section><h3>Document sections</h3><div class="loop-empty"><strong>' + (progress.usedSectioning ? 'Automatic sectioning used' : 'Single extraction used') + '</strong><p>' +
          escapeHtml(String(progress.completedSections)) + ' completed · ' + escapeHtml(String(progress.processingSections)) + ' processing · ' + escapeHtml(String(progress.pendingSections)) + ' pending · ' + escapeHtml(String(progress.failedSections)) + ' failed</p>' + current + '<small>Phase: ' + escapeHtml(progress.phase) + '</small></div></section>';
      }

      function renderTimeline(items) {
        if (!items.length) return '<section><h3>Timeline</h3><div class="loop-empty">No loop activity yet.</div></section>';
        return '<section><h3>Timeline</h3><div class="loop-timeline">' + items.map((item) =>
          '<article class="loop-item ' + escapeHtml(item.severity || "info") + '" data-loop-item-id="' + escapeHtml(item.id) + '"><strong>' + escapeHtml(item.label) + '</strong><small>' + escapeHtml(item.kind) + ' · ' + escapeHtml(item.status) + ' · ' + escapeHtml(formatLoopTime(item.occurredAt)) + '</small><p>' + escapeHtml(item.summary) + '</p>' + renderTechnical(item.id, item.technical || []) + '</article>'
        ).join("") + '</div></section>';
      }

      function renderTechnical(itemId, technical) {
        if (!technical.length) return "";
        return '<details' + (expandedTechnicalIds.has(itemId) ? ' open' : '') + '><summary>Technical details</summary><dl>' + technical.map((ref) =>
          '<dt>' + escapeHtml(ref.label) + '</dt><dd>' + escapeHtml(ref.value) + '</dd>'
        ).join("") + '</dl></details>';
      }

      function formatLoopTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }

      function setBusy(isBusy) {
        openButton.dataset.busy = isBusy ? "true" : "false";
      }

      function scheduleRefresh() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        const shouldPoll = drawer.classList.contains("open") || Boolean(activeIngestionId && latestStatus && !latestStatus.isTerminal);
        if (shouldPoll) timer = setInterval(refreshLoopStatus, 2000);
      }

      return {
        setActiveIngestion,
        refresh: refreshLoopStatus
      };
    }
  `;
}
