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
            sectionProgress: {
              usedSectioning: true,
              plannedSections: 7,
              pendingSections: 3,
              processingSections: 1,
              completedSections: 3,
              failedSections: 0,
              currentSectionOrdinal: 4,
              currentSectionTitle: "MemIAVL",
              phase: "extracting",
              terminalState: "processing",
            },
          }), { status: 200 });
        },
      }),
    );

    const status = await persistence.getLoopStatus({
      tenantId: "stable",
      ingestionId: "ing_1",
      limit: 10,
    });

    expect(calls[0]?.url).toBe("https://example.supabase.co/rest/v1/rpc/distillery_get_loop_status_v3");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: "stable",
      p_ingestion_id: "ing_1",
      p_limit: 10,
    });
    expect(status.mode).toBe("current");
    expect(status.stages[0]?.status).toBe("running");
    expect(status.sectionProgress?.plannedSections).toBe(7);
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

describe("hybrid retrieval migration", () => {
  it("adds retrieval RPCs, schema projection, and embedding target backfill support", () => {
    const migration = readFileSync(
      resolve(testDir, "../migrations/0011_hybrid_retrieval_rpcs.sql"),
      "utf8",
    );

    expect(migration).toContain("distillery_retrieval_vector_candidates");
    expect(migration).toContain("distillery_retrieval_sparse_candidates");
    expect(migration).toContain("distillery_retrieval_graph_snapshot");
    expect(migration).toContain("distillery_hydrate_retrieval_claims");
    expect(migration).toContain("distillery_list_missing_memory_embedding_targets");
    expect(migration).toContain("create or replace function distillery_rebuild_graph_projection");
    expect(migration).toContain("'schema'");
    expect(migration).toContain("'matches_schema'");
  });
});

describe("corpus-wide synthesis migration", () => {
  const migration = readFileSync(
    resolve(testDir, "../migrations/0013_corpus_wide_brief_synthesis.sql"),
    "utf8",
  );

  it("adds versioned clusters, readiness, suggested drafts, dirty work, and a durable sweep cursor", () => {
    expect(migration).toContain("create table if not exists synthesis_clusters");
    expect(migration).toContain("create table if not exists synthesis_cluster_versions");
    expect(migration).toContain("create table if not exists synthesis_cluster_memberships");
    expect(migration).toContain("create table if not exists synthesis_readiness_evaluations");
    expect(migration).toContain("create table if not exists suggested_brief_versions");
    expect(migration).toContain("create table if not exists synthesis_dirty_neighborhoods");
    expect(migration).toContain("create table if not exists synthesis_global_scan_cursors");
  });

  it("bounds global sweep dispatch and persists its cursor", () => {
    expect(migration).toContain("v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10)");
    expect(migration).toContain("for update");
    expect(migration).toContain("set last_memory_item_id = v_cursor.last_memory_item_id, cycle = v_cursor.cycle");
  });

  it("fixes the memory_item_id ambiguity with qualified variables", () => {
    expect(migration).toContain("v_memory_item_id text");
    expect(migration).toContain("where mi.id = v_memory_item_id and mi.tenant_id = v_proposal.tenant_id");
    expect(migration).not.toContain("where mi.id = memory_item_id");
  });

  it("validates evidence bindings and makes one draft version per cluster version and intent", () => {
    expect(migration).toContain("mie.memory_item_id = any(v_memory_item_ids)");
    expect(migration).toContain("unique (tenant_id, cluster_id, cluster_version, generation_intent)");
    expect(migration).toContain("on conflict (tenant_id, cluster_id, cluster_version, generation_intent) where origin = 'generated' do nothing");
    expect(migration).toContain("on conflict (ledger_event_id) do nothing");
  });
});

describe("synthesis surfaces", () => {
  const worker = readFileSync(resolve(testDir, "../../../apps/web/src/index.ts"), "utf8");

  it("keeps initiative suggestions off capture and exposes them on synthesis", () => {
    const captureShell = worker.slice(worker.indexOf("function renderAppShell"), worker.indexOf("function renderGraphShell"));
    const synthesisShell = worker.slice(worker.indexOf("function renderSynthesisShell"));
    expect(captureShell).not.toContain("Ranked brief opportunities");
    expect(synthesisShell).toContain("Ranked brief opportunities");
    expect(synthesisShell).toContain("/api/synthesis/opportunities");
  });

  it("makes corpus expansion the UI default while retaining selection-only mode", () => {
    expect(worker).toContain('id="selection-only"');
    expect(worker).toContain('expandRelatedMemory: !document.querySelector("#selection-only").checked');
  });
});

describe("Ask retrieval wiring", () => {
  it("does not call the legacy DB lexical fallback from the Worker Ask path", () => {
    const worker = readFileSync(
      resolve(testDir, "../../../apps/web/src/index.ts"),
      "utf8",
    );

    const askHandler = worker.slice(
      worker.indexOf("async function handleRecallQuery"),
      worker.indexOf("async function handleListActiveMemory"),
    );
    expect(askHandler).toContain("retrieveMemoryContext");
    expect(askHandler).not.toContain("recallMemory(");
    expect(askHandler).not.toContain("distillery_recall_memory_lexical");
  });
});

describe("Worker authentication logging safety", () => {
  it("does not accept the shared password in a request header that platform logs can retain", () => {
    const worker = readFileSync(resolve(testDir, "../../../apps/web/src/index.ts"), "utf8");
    expect(worker).not.toContain("x-distillery-password");
    expect(worker).toContain("distillery_session");
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

  it("calls hybrid retrieval RPCs with tenant scope", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const persistence = new SupabaseLoopPersistence(
      new SupabaseRpcClient({
        supabaseUrl: "https://example.supabase.co",
        secretKey: "secret",
        fetchImpl: async (input, init) => {
          const body = JSON.parse(String(init?.body));
          calls.push({ url: String(input), body });
          if (String(input).endsWith("/distillery_retrieval_graph_snapshot")) {
            return Response.json({ nodes: [], edges: [] });
          }
          if (String(input).endsWith("/distillery_hydrate_retrieval_claims")) {
            return Response.json({ claims: [], conflicts: [] });
          }
          if (String(input).endsWith("/distillery_retrieval_vector_candidates")) {
            return Response.json([{
              source: "vector",
              targetType: "entity",
              targetId: "relayer",
              nodeId: "entity:relayer",
              claimId: null,
              score: 0.77,
              label: "relayer",
            }]);
          }
          return Response.json([]);
        },
      }),
    );

    const vectorCandidates = await persistence.getRetrievalVectorCandidates({
      tenantId: "stable",
      queryEmbedding: [0.1, 0.2, 0.3],
      targetTypes: ["claim"],
      limit: 5,
      embeddingModel: "google/gemini-embedding-001",
    });
    await persistence.getRetrievalSparseCandidates({
      tenantId: "stable",
      queryText: "RAVEN-42",
      limit: 7,
    });
    await persistence.getRetrievalGraphSnapshot({
      tenantId: "stable",
      seedNodeIds: ["claim:mem_1"],
      maxNodes: 10,
      maxEdges: 20,
    });
    await persistence.hydrateRetrievalClaims({
      tenantId: "stable",
      rankedClaims: [{
        claimId: "mem_1",
        rank: 1,
        graphScore: 0.5,
        vectorScore: 0.7,
        lexicalScore: 0.1,
      }],
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://example.supabase.co/rest/v1/rpc/distillery_retrieval_vector_candidates",
      "https://example.supabase.co/rest/v1/rpc/distillery_retrieval_sparse_candidates",
      "https://example.supabase.co/rest/v1/rpc/distillery_retrieval_graph_snapshot",
      "https://example.supabase.co/rest/v1/rpc/distillery_hydrate_retrieval_claims",
    ]);
    expect(calls[0]?.body).toMatchObject({
      p_tenant_id: "stable",
      p_target_types: ["claim"],
      p_limit: 5,
      p_embedding_model: "google/gemini-embedding-001",
    });
    expect(vectorCandidates).toEqual([{
      source: "vector",
      targetType: "entity",
      targetId: "relayer",
      nodeId: "entity:relayer",
      claimId: undefined,
      score: 0.77,
      label: "relayer",
    }]);
    expect(calls[1]?.body).toEqual({
      p_tenant_id: "stable",
      p_query: "RAVEN-42",
      p_limit: 7,
    });
    expect(calls[2]?.body).toEqual({
      p_tenant_id: "stable",
      p_seed_node_ids: ["claim:mem_1"],
      p_max_nodes: 10,
      p_max_edges: 20,
    });
    expect(calls[3]?.body).toEqual({
      p_tenant_id: "stable",
      p_ranked_claims: [{
        claimId: "mem_1",
        rank: 1,
        graphScore: 0.5,
        vectorScore: 0.7,
        lexicalScore: 0.1,
      }],
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
