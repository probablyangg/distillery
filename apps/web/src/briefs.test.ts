import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

describe("authenticated read-only brief surface", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves an accessible responsive shell that inserts source text with textContent", async () => {
    const response = await worker.fetch(new Request("https://distillery.example/briefs"), env(), context());
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(page).toContain('href="#main-content"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain("@media (max-width:760px)");
    expect(page).toContain('href="/briefs" aria-current="page"');
    expect(page).toContain('element("blockquote", "", citation.exactText)');
    expect(page).toContain("node.textContent = text");
    expect(page).toContain("function safeSlackUrl(value)");
    expect(page).toContain('url.protocol === "https:"');
    expect(page).toContain('host.endsWith(".slack.com")');
    expect(page).not.toContain("innerHTML");
  });

  it("keeps both brief APIs behind the existing shared-password session", async () => {
    const list = await worker.fetch(new Request("https://distillery.example/api/briefs"), env(), context());
    const detail = await worker.fetch(new Request("https://distillery.example/api/briefs/brief_1"), env(), context());
    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it("keeps the Slack endpoint fail-closed when its required reaction name is misconfigured", async () => {
    const configured = {
      ...env(),
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "test-signing-secret",
      SLACK_ALLOWED_TEAM_ID: "T12345678",
      SLACK_ALLOWED_CHANNEL_IDS: "C12345678",
      SLACK_ALLOWED_USER_IDS: "U12345678",
      SLACK_SAVED_REACTION: "not-factory",
      MEMORY_GENERATION_QUEUE: { send: vi.fn() } as unknown as Queue<{ workItemId: string }>,
    };
    const response = await worker.fetch(new Request("https://distillery.example/api/slack/interactions", {
      method: "POST",
    }), configured, context());
    expect(response.status).toBe(503);
  });

  it("returns only the PostgreSQL generated-brief projection after login", async () => {
    const rpcCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      rpcCalls.push(String(input));
      return new Response(JSON.stringify([leadershipBrief()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const login = await worker.fetch(new Request("https://distillery.example/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pilot-password" }),
    }), env(), context());
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("expected session cookie");

    const response = await worker.fetch(new Request("https://distillery.example/api/briefs", {
      headers: { cookie },
    }), env(), context());
    const body = await response.json() as unknown[];
    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(rpcCalls[0]).toContain("/rpc/distillery_list_leadership_briefs");
  });

  it("maps an unavailable generated brief to 404 without exposing another brief type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message: "leadership brief not found" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )));
    const login = await worker.fetch(new Request("https://distillery.example/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pilot-password" }),
    }), env(), context());
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("expected session cookie");
    const response = await worker.fetch(new Request("https://distillery.example/api/briefs/manual_brief", {
      headers: { cookie },
    }), env(), context());
    expect(response.status).toBe(404);
  });
});

function env(): Env {
  return {
    DISTILLERY_APP_PASSWORD: "pilot-password",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-secret",
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_BASE_URL: "https://openrouter.example/v1",
    OPENROUTER_MODEL: "test-model",
  };
}

function context(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function leadershipBrief() {
  return {
    id: "brief_1",
    title: "Pilot decision",
    summary: "A pilot decision was recorded. Leadership can inspect its evidence.",
    whyGenerated: "The connected evidence passed readiness checks.",
    status: "draft",
    supportingSourceCount: 1,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    executiveSummary: "A pilot decision was recorded.",
    whatIsHappening: "The pilot is ready.",
    decisionsAndCommitments: "Launch the pilot.",
    risks: [],
    dependencies: [],
    openQuestions: [],
    conflictingEvidence: [],
    citations: [{
      evidenceSpanId: "span_1",
      sourceVersionId: "srcv_1",
      sourceType: "slack_message",
      authorOrTitle: "Ada Lovelace",
      occurredAt: "2026-07-15T12:00:00.000Z",
      exactText: "<img src=x onerror=alert(1)>",
      locator: {
        provider: "slack",
        messageTimestamp: "1752624000.000001",
        permalink: "https://example.slack.com/archives/C12345678/p1752624000000001",
      },
      originalUrl: "https://example.slack.com/archives/C12345678/p1752624000000001",
    }],
    memoryItemIds: ["mem_1"],
    evidenceSpanIds: ["span_1"],
  };
}
