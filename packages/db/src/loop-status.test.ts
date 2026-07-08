import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SupabaseLoopPersistence, SupabaseRpcClient } from "./index";

const testDir = dirname(fileURLToPath(import.meta.url));

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

describe("SupabaseLoopPersistence.getMemorySynthesisContext", () => {
  it("calls the synthesis context RPC and parses active memory with evidence", async () => {
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
          return Response.json([{
            memoryItem: {
              id: "mem_1",
              ingestionId: "ing_1",
              sourceVersionId: "srcv_1",
              claimType: "dependency",
              statement: "Docs block launch.",
              evidenceSpanIds: ["ev_1"],
              epistemicStatus: "reported",
              qualifiers: {},
              stableDomainTags: ["docs"],
              entities: [{ name: "Launch", entityType: "initiative" }],
              relations: [{
                subject: "Docs",
                predicate: "blocks",
                object: "Launch",
                evidenceSpanIds: ["ev_1"],
              }],
              schemas: [{
                subjectType: "artifact",
                predicate: "blocks",
                objectType: "initiative",
                status: "candidate",
              }],
              reviewState: "confirmed",
              supersedesMemoryItemId: null,
            },
            evidenceSpans: [{
              id: "ev_1",
              sourceVersionId: "srcv_1",
              startLine: 1,
              endLine: 1,
              startChar: 0,
              endChar: 18,
              text: "Docs block launch.",
            }],
          }]);
        },
      }),
    );

    const context = await persistence.getMemorySynthesisContext({
      tenantId: "stable",
      seedMemoryItemIds: ["mem_1"],
      limit: 100,
    });

    expect(calls[0]?.url).toBe("https://example.supabase.co/rest/v1/rpc/distillery_get_memory_synthesis_context");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: "stable",
      p_seed_memory_item_ids: ["mem_1"],
      p_limit: 100,
    });
    expect(context[0]?.memoryItem.entities[0]?.name).toBe("Launch");
  });
});

describe("synthesize_brief migration", () => {
  it("allows synthesize_brief in pending_work and commits artifact drafts to initiative briefs", () => {
    const migration = readFileSync(
      resolve(testDir, "../migrations/0009_synthesize_brief_policy.sql"),
      "utf8",
    );

    expect(migration).toContain("'synthesize_brief'");
    expect(migration).toContain("distillery_get_memory_synthesis_context");
    expect(migration).toContain("proposal.target_event_type = 'artifact_drafted'");
    expect(migration).toContain("insert into initiative_briefs");
  });
});
