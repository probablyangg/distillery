import {
  CaptureInputSchema,
  CreateInitiativeBriefInputSchema,
  InitiativeBriefDraftInputSchema,
  InitiativeBriefDecisionInputSchema,
  MemoryItemActionInputSchema,
  RecallQueryInputSchema,
} from "@distillery/contracts";
import { SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "@distillery/db";
import {
  OpenRouterInitiativeBriefDraftModel,
  OpenRouterMemoryGenerationModel,
  type OpenRouterModelConfig,
} from "@distillery/model-gateway";
import {
  DEFAULT_TENANT_ID,
  applyMemoryItemAction,
  runMemoryGenerationWorkflow,
  submitTextCapture,
} from "@distillery/memory-generation";
import { validateInitiativeBriefDraftTraceability } from "@distillery/memory-synthesis";

const SESSION_COOKIE_NAME = "distillery_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_DRAFT_MEMORY_ITEMS = 8;

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
  MEMORY_GENERATION_QUEUE?: Queue<{ ingestionId: string }>;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "distillery-v0" });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return html(renderAppShell());
    }

    if (request.method === "GET" && url.pathname === "/synthesis") {
      return html(renderSynthesisShell());
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

    if (request.method === "POST" && url.pathname === "/api/ingestions") {
      return handleCreateIngestion(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/api/queries") {
      return handleRecallQuery(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/memory-items") {
      return handleListActiveMemory(env);
    }

    if (request.method === "GET" && url.pathname === "/api/initiative-briefs") {
      return handleListInitiativeBriefs(env);
    }

    if (request.method === "POST" && url.pathname === "/api/initiative-brief-drafts") {
      return handleGenerateInitiativeBriefDraft(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/initiative-briefs") {
      return handleCreateInitiativeBrief(request, env);
    }

    const initiativeBriefMatch = url.pathname.match(/^\/api\/initiative-briefs\/([^/]+)$/);
    if (request.method === "GET" && initiativeBriefMatch?.[1]) {
      return handleGetInitiativeBrief(initiativeBriefMatch[1], env);
    }

    const initiativeBriefDecisionMatch = url.pathname.match(/^\/api\/initiative-briefs\/([^/]+)\/decisions$/);
    if (request.method === "POST" && initiativeBriefDecisionMatch?.[1]) {
      return handleInitiativeBriefDecision(initiativeBriefDecisionMatch[1], request, env);
    }

    const ingestionMatch = url.pathname.match(/^\/api\/ingestions\/([^/]+)$/);
    if (request.method === "GET" && ingestionMatch?.[1]) {
      return handleGetIngestion(ingestionMatch[1], env);
    }

    const memoryActionMatch = url.pathname.match(/^\/api\/memory-items\/([^/]+)\/actions$/);
    if (request.method === "POST" && memoryActionMatch?.[1]) {
      return handleMemoryItemAction(memoryActionMatch[1], request, env);
    }

    const memoryHistoryMatch = url.pathname.match(/^\/api\/memory-items\/([^/]+)\/history$/);
    if (request.method === "GET" && memoryHistoryMatch?.[1]) {
      return handleMemoryItemHistory(memoryHistoryMatch[1], env);
    }

    return json({ error: "Not found" }, 404);
  },

  async queue(batch: MessageBatch<{ ingestionId: string }>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        await processIngestion(message.body.ingestionId, env);
        message.ack();
      }),
    );
  },
};

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

  if (env.MEMORY_GENERATION_QUEUE) {
    await env.MEMORY_GENERATION_QUEUE.send({ ingestionId: receipt.ingestionId });
  } else {
    ctx.waitUntil(processIngestion(receipt.ingestionId, env));
  }

  return json(receipt, 202);
}

async function handleGetIngestion(ingestionId: string, env: Env): Promise<Response> {
  const result = await createRepository(env).getIngestionResult(ingestionId);
  return json(result);
}

async function handleRecallQuery(request: Request, env: Env): Promise<Response> {
  const query = RecallQueryInputSchema.parse(await request.json());
  const answer = await createRepository(env).recallMemory(query);
  return json(answer);
}

async function handleListActiveMemory(env: Env): Promise<Response> {
  const memory = await createRepository(env).listActiveMemory({ limit: 100 });
  return json(memory);
}

async function handleListInitiativeBriefs(env: Env): Promise<Response> {
  const briefs = await createRepository(env).listInitiativeBriefs({ limit: 50 });
  return json(briefs);
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
    const activeMemory = await repository.listActiveMemory({ limit: 200 });
    const selectedMemory = input.memoryItemIds.map((memoryItemId) =>
      activeMemory.find((record) => record.memoryItem.id === memoryItemId)
    );
    const missingMemoryItemId = input.memoryItemIds.find((_, index) => !selectedMemory[index]);

    if (missingMemoryItemId) {
      return json({ error: `Selected memory is not active or was not found: ${missingMemoryItemId}` }, 422);
    }

    const memoryWithEvidence = selectedMemory.filter((record): record is NonNullable<typeof record> => Boolean(record));
    const memoryItems = memoryWithEvidence.map((record) => record.memoryItem);
    const evidenceSpans = uniqueEvidenceSpans(memoryWithEvidence.flatMap((record) => record.evidenceSpans));
    try {
      const generated = await new OpenRouterInitiativeBriefDraftModel(openRouterConfig(env, {
        maxPrimaryTimeoutMs: 25_000,
        maxFallbackTimeoutMs: 15_000,
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
        });
      }

      const fallbackDraft = buildDeterministicInitiativeBriefDraft({
        memoryItems,
        evidenceSpans,
        ...(input.intent ? { intent: input.intent } : {}),
        fallbackReason: validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      });
      return json(fallbackDraft);
    } catch (error) {
      const fallbackDraft = buildDeterministicInitiativeBriefDraft({
        memoryItems,
        evidenceSpans,
        ...(input.intent ? { intent: input.intent } : {}),
        fallbackReason: error instanceof Error ? error.message : String(error),
      });
      return json(fallbackDraft);
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

async function handleInitiativeBriefDecision(briefId: string, request: Request, env: Env): Promise<Response> {
  const decision = InitiativeBriefDecisionInputSchema.parse(await request.json());
  const brief = await createRepository(env).recordInitiativeBriefDecision({
    briefId,
    decisionId: newId("bdec"),
    decision,
  });

  return json(brief);
}

async function handleMemoryItemAction(memoryItemId: string, request: Request, env: Env): Promise<Response> {
  const action = MemoryItemActionInputSchema.parse(await request.json());
  const result = await applyMemoryItemAction({
    memoryItemId,
    action,
    repository: createRepository(env),
  });

  return json(result);
}

async function handleMemoryItemHistory(memoryItemId: string, env: Env): Promise<Response> {
  const result = await createRepository(env).getMemoryItemHistory(memoryItemId);
  return json(result);
}

async function processIngestion(ingestionId: string, env: Env): Promise<void> {
  await runMemoryGenerationWorkflow({
    ingestionId,
    repository: createRepository(env),
    model: new OpenRouterMemoryGenerationModel(openRouterConfig(env)),
  });
}

function createRepository(env: Env): SupabaseMemoryGenerationRepository {
  return new SupabaseMemoryGenerationRepository(
    new SupabaseRpcClient({
      supabaseUrl: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
    }),
  );
}

function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
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

function openRouterConfig(
  env: Env,
  options: {
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
    model: env.OPENROUTER_MODEL,
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
  const suppliedPassword = request.headers.get("x-distillery-password");
  if (await isPasswordValid(suppliedPassword ?? undefined, env)) {
    return true;
  }

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
      <p><a href="/synthesis">Open Memory Synthesis review</a></p>
      <div class="row"><button id="logout" type="button" class="secondary">Log out</button></div>
      <form id="capture-form">
        <textarea id="text" placeholder="Paste a Stable leadership braindump..."></textarea>
        <div class="row"><button id="remember">Remember</button><button id="ask" type="button">Ask</button><span id="status"></span></div>
      </form>
      <pre id="result"></pre>
    </section>
  </main>
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
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await fetch("/api/ingestions/" + encodeURIComponent(id));
        if (handleUnauthorized(response)) return;
        const result = await response.json();
      renderResult(result);
      statusEl.textContent = result.status;
      if (["ready", "failed"].includes(result.status)) return;
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
      <p><a href="/">Back to Memory Generation</a></p>
      <div class="row"><button id="logout" type="button" class="secondary">Log out</button></div>
      <div class="row">
        <button id="load-memory" type="button">Load active memory</button>
        <button id="load-briefs" type="button" class="secondary">Load briefs</button>
        <span id="status"></span>
      </div>

      <h2>1. Select memory</h2>
      <div id="memory-list"></div>

      <h2>2. Generate a brief</h2>
      <p><textarea id="intent" placeholder="Optional: what should this brief focus on? Example: turn this into a launch-readiness brief for leadership."></textarea></p>
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
  <script>
    const loginCard = document.querySelector("#login-card");
    const appCard = document.querySelector("#app-card");
    const loginForm = document.querySelector("#login-form");
    const statusEl = document.querySelector("#status");
    const resultEl = document.querySelector("#result");
    const memoryList = document.querySelector("#memory-list");
    const briefList = document.querySelector("#brief-list");
    const logoutButton = document.querySelector("#logout");
    const loginStatusEl = document.querySelector("#login-status");
    const briefForm = document.querySelector("#brief-form");
    const draftStatusEl = document.querySelector("#draft-status");
    const draftEvidenceEl = document.querySelector("#draft-evidence");

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
    document.querySelector("#load-briefs").addEventListener("click", loadBriefs);
    document.querySelector("#generate-brief").addEventListener("click", generateBriefDraft);
    document.querySelector("#manual-brief").addEventListener("click", () => {
      showBriefForm();
      draftStatusEl.textContent = "Manual mode";
    });

    briefForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const memoryItemIds = [...document.querySelectorAll("input[name=memory]:checked")].map((input) => input.value);
      if (memoryItemIds.length === 0) {
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
      const response = await fetch("/api/initiative-briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (handleUnauthorized(response)) return;
      const brief = await response.json();
      resultEl.textContent = JSON.stringify(brief, null, 2);
      statusEl.textContent = response.ok ? "Brief created" : "Failed";
      if (response.ok) loadBriefs();
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
          body: JSON.stringify({ memoryItemIds, intent: intent || undefined })
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
        draftEvidenceEl.textContent = "Traceable to evidence: " + (draft.evidenceSpanIds || []).join(", ");
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
      const response = await fetch("/api/memory-items");
      if (handleUnauthorized(response)) return;
      const items = await response.json();
      memoryList.innerHTML = "";
      for (const record of items) {
        const memory = record.memoryItem;
        const evidence = (record.evidenceSpans || []).map((span) => "[" + span.id + "] " + span.text).join("\\n");
        const div = document.createElement("div");
        div.className = "memory";
        div.innerHTML = '<label><input type="checkbox" name="memory" value="' + escapeHtml(memory.id) + '" /><span><strong>' + escapeHtml(memory.claimType) + '</strong><br />' + escapeHtml(memory.statement) + '<br /><small>' + escapeHtml(memory.reviewState || "unreviewed") + ' · evidence: ' + escapeHtml(memory.evidenceSpanIds.join(", ")) + '</small></span></label>' + traceDetailsHtml(memory, evidence);
        memoryList.append(div);
      }
      statusEl.textContent = response.ok ? "Memory loaded" : "Failed";
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
          actionButton("Approve", () => decideBrief(brief.id, "approve")),
          actionButton("Reject", () => decideBrief(brief.id, "reject"), "danger")
        );
        div.append(row);
        briefList.append(div);
      }
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
      loadMemory();
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
  </script>
</body>
</html>`;
}
