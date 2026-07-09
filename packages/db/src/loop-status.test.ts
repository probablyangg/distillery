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

describe("claim graph migration", () => {
  it("adds graph schema, connect_memory policy, and graph RPCs", () => {
    const migration = readFileSync(
      resolve(testDir, "../migrations/0010_claim_graph_memory_upgrade.sql"),
      "utf8",
    );

    expect(migration).toContain("create table if not exists observations");
    expect(migration).toContain("create table if not exists claims");
    expect(migration).toContain("create table if not exists claim_connections");
    expect(migration).toContain("create table if not exists conflict_groups");
    expect(migration).toContain("create table if not exists graph_nodes");
    expect(migration).toContain("create table if not exists memory_embeddings");
    expect(migration).toContain("distillery_upsert_memory_embeddings");
    expect(migration).toContain("'connect_memory'");
    expect(migration).toContain("'memory_connected'");
    expect(migration).toContain("distillery_graph_recall_context");
    expect(migration).toContain("distillery_get_graph_cluster");
  });
});

describe("SupabaseLoopPersistence graph RPCs", () => {
  it("calls graph recall and cluster RPCs with tenant scope", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const persistence = new SupabaseLoopPersistence(
      new SupabaseRpcClient({
        supabaseUrl: "https://example.supabase.co",
        secretKey: "secret",
        fetchImpl: async (input, init) => {
          const body = JSON.parse(String(init?.body));
          calls.push({ url: String(input), body });
          if (String(input).endsWith("/distillery_graph_recall_context")) {
            return Response.json({
              question: "What blocks launch?",
              claims: [],
              conflicts: [],
              metadata: { strategy: "test" },
            });
          }
          return Response.json([]);
        },
      }),
    );

    await persistence.getGraphRecallContext({
      tenantId: "stable",
      question: "What blocks launch?",
      limit: 8,
    });
    await persistence.listGraphClusters({ tenantId: "stable", limit: 10 });

    expect(calls[0]?.body).toEqual({
      p_tenant_id: "stable",
      p_query: "What blocks launch?",
      p_limit: 8,
    });
    expect(calls[1]?.body).toEqual({
      p_tenant_id: "stable",
      p_limit: 10,
    });
  });

  it("calls embedding upsert RPC with derived embedding rows", async () => {
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
          return new Response(null, { status: 204 });
        },
      }),
    );

    await persistence.upsertMemoryEmbeddings({
      tenantId: "stable",
      embeddings: [{
        id: "emb_1",
        targetType: "claim",
        targetId: "mem_1",
        embeddingModel: "google/gemini-embedding-001",
        embedding: [0.1, 0.2, 0.3],
        contentHash: "hash",
      }],
    });

    expect(calls[0]?.url).toBe("https://example.supabase.co/rest/v1/rpc/distillery_upsert_memory_embeddings");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: "stable",
      p_embeddings: [{
        id: "emb_1",
        targetType: "claim",
        targetId: "mem_1",
        embeddingModel: "google/gemini-embedding-001",
        embedding: [0.1, 0.2, 0.3],
        contentHash: "hash",
      }],
    });
  });
});
