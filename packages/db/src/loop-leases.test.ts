import { describe, expect, it } from "vitest";
import { SupabaseMemoryGenerationRepository, SupabaseRpcClient } from "./index";

describe("loop lease RPC bindings", () => {
  it("sends approved seed ingestion through the atomic non-actionable source RPC", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        ingestionId: "ing_seed",
        status: "evidence_stored",
        sourceVersionId: "srcv_seed",
      }), { status: 200 });
    };
    const repository = new SupabaseMemoryGenerationRepository(new SupabaseRpcClient({
      supabaseUrl: "https://example.supabase.co",
      secretKey: "test-secret",
      fetchImpl,
    }));

    await repository.createTextIngestionWithEvidence({
      tenantId: "stable",
      ingestionId: "ing_seed",
      sourceItemId: "src_seed",
      sourceVersionId: "srcv_seed",
      idempotencyKey: "seed:stable-mg-001",
      appSessionId: "app_session_seed_stable",
      submittedByLabel: "Distillery seed data",
      content: "Approved fixture text.",
      contentHash: "hash",
      evidenceSpans: [{
        id: "ev_seed",
        sourceVersionId: "srcv_seed",
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 22,
        text: "Approved fixture text.",
      }],
      routeSource: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/rpc/distillery_create_text_ingestion_with_evidence_v2");
    expect(calls[0]?.body).toMatchObject({
      p_idempotency_key: "seed:stable-mg-001",
      p_submitted_by_label: "Distillery seed data",
      p_route_source: false,
    });
  });
});
