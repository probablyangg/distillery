import { describe, expect, it } from "vitest";
import { SupabaseLoopPersistence, SupabaseRpcClient } from "./index";

describe("SupabaseLoopPersistence.getLoopStatus", () => {
  it("calls the loop status RPC and parses the UI-safe response", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const persistence = new SupabaseLoopPersistence(
      new SupabaseRpcClient({
        supabaseUrl: "https://example.supabase.co",
        secretKey: "secret",
        fetchImpl: async (input, init) => {
          calls.push({
            url: String(input),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(JSON.stringify({
            mode: "current",
            subject: {
              ingestionId: "ing_1",
              subjectType: "source",
              subjectId: "srcv_1",
            },
            summary: "Policy work is running.",
            isTerminal: false,
            lastUpdatedAt: new Date(0).toISOString(),
            stages: [{
              key: "policy_running",
              label: "Policy running",
              status: "running",
              description: "The named policy builds context and runs.",
              occurredAt: new Date(0).toISOString(),
              detail: "extract_memory",
            }],
            timeline: [{
              id: "work_1",
              kind: "work",
              label: "Work queued",
              status: "running",
              occurredAt: new Date(0).toISOString(),
              summary: "Policy work item: extract_memory.",
              severity: "info",
              technical: [{ label: "work_item_id", value: "work_1" }],
            }],
            activity: [],
          }), { status: 200 });
        },
      }),
    );

    const status = await persistence.getLoopStatus({
      tenantId: "stable",
      ingestionId: "ing_1",
      limit: 10,
    });

    expect(calls[0]?.url).toBe("https://example.supabase.co/rest/v1/rpc/distillery_get_loop_status");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: "stable",
      p_ingestion_id: "ing_1",
      p_limit: 10,
    });
    expect(status.mode).toBe("current");
    expect(status.stages[0]?.status).toBe("running");
  });
});
