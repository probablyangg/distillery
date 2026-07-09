import { describe, expect, it } from "vitest";
import type { Policy } from "./index";
import {
  InMemoryLoopPersistence,
  createPolicies,
  executeWorkItem,
  routeCommittedEvents,
  type PolicyOutput,
} from "./index";
import type { InitiativeBriefDraftModel } from "@distillery/model-gateway";
import { StaticMemoryGenerationModel } from "@distillery/memory-generation";

const evidenceSpan = {
  id: "ev_1",
  sourceVersionId: "srcv_1",
  startLine: 1,
  endLine: 1,
  startChar: 0,
  endChar: 53,
  text: "Dev docs need to be updated before the API launch.",
};

const secondEvidenceSpan = {
  id: "ev_2",
  sourceVersionId: "srcv_2",
  startLine: 1,
  endLine: 1,
  startChar: 0,
  endChar: 60,
  text: "API launch risk is unresolved until docs ownership is clear.",
};

describe("loop system", () => {
  it("capture commits source_committed and outbox row", async () => {
    const store = new InMemoryLoopPersistence();

    const event = await store.commitLedgerEventWithOutbox({
      id: "levt_1",
      tenantId: "stable",
      eventType: "source_committed",
      subjectType: "source",
      subjectId: "srcv_1",
      actorType: "human",
      actorLabel: "Angela",
      inputVersion: "srcv_1",
      idempotencyKey: "source_committed:idem_1",
      payload: { ingestionId: "ing_1", sourceVersionId: "srcv_1" },
    });

    expect(event.eventType).toBe("source_committed");
    expect([...store.eventOutboxRows.values()]).toHaveLength(1);
    expect([...store.eventOutboxRows.values()][0]?.ledgerEventId).toBe("levt_1");
  });

  it("router maps source_committed to exactly one extract_memory item and replay does not duplicate", async () => {
    const store = seededStore();
    await commitSource(store);

    const first = await routeCommittedEvents({ persistence: store });
    const second = await routeCommittedEvents({ persistence: store });

    expect(first).toHaveLength(1);
    expect(first[0]?.policy).toBe("extract_memory");
    expect(second).toHaveLength(0);
    expect([...store.pendingWorkItems.values()]).toHaveLength(1);
  });

  it("memory_committed routes configured follow-up work idempotently", async () => {
    const store = seededStore();
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "mem_1",
      actorType: "policy",
      inputVersion: "mem_1:v1",
      idempotencyKey: "memory:1",
      payload: { memoryItemIds: ["mem_1"] },
    });

    const work = await routeCommittedEvents({ persistence: store });

    expect(work.map((item) => item.policy).sort()).toEqual([
      "check_freshness",
      "connect_memory",
      "detect_contradiction",
      "discover_candidate",
      "synthesize_brief",
    ]);
    expect([...store.pendingWorkItems.values()]).toHaveLength(5);
  });

  it("connect_memory persists grounded connection proposals and rejects claim-type-only lookalikes", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([
      ...connectedMemoryContext(),
      memoryRecord({
        id: "mem_lookalike",
        claimType: "risk",
        statement: "Rewards risk is still unresolved for a separate growth experiment.",
        evidenceSpanIds: ["ev_3"],
        entities: [{ name: "Rewards", entityType: "program" }],
        sourceVersionId: "srcv_3",
      }),
    ]);
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "batch_1",
      actorType: "policy",
      inputVersion: "batch:v1",
      idempotencyKey: "memory:connect",
      payload: { memoryItemIds: ["mem_1"] },
    });
    const work = await routeCommittedEvents({ persistence: store });
    const connectWork = work.find((item) => item.policy === "connect_memory");
    if (!connectWork) throw new Error("expected connect_memory work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: connectWork.id,
      newId: deterministicId(),
    });

    expect([...store.claimConnections.values()]).toEqual([
      expect.objectContaining({
        fromClaimId: "mem_1",
        toClaimId: "mem_2",
      }),
    ]);
    expect([...store.claimConnections.values()].some((connection) =>
      connection.fromClaimId === "mem_lookalike" || connection.toClaimId === "mem_lookalike"
    )).toBe(false);
  });

  it("detect_contradiction records blocking conflicts with evidence", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([
      memoryRecord({
        id: "mem_owner_yes",
        claimType: "ownership_statement",
        statement: "API launch ownership is clear and owned by Docs.",
        evidenceSpanIds: ["ev_1"],
        entities: [{ name: "API launch", entityType: "initiative" }],
      }),
      memoryRecord({
        id: "mem_owner_no",
        claimType: "ownership_statement",
        statement: "API launch ownership is unclear and not owned.",
        evidenceSpanIds: ["ev_2"],
        entities: [{ name: "API launch", entityType: "initiative" }],
      }),
    ]);
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "batch_1",
      actorType: "policy",
      inputVersion: "batch:v1",
      idempotencyKey: "memory:conflict",
      payload: { memoryItemIds: ["mem_owner_yes"] },
    });
    const work = await routeCommittedEvents({ persistence: store });
    const contradictionWork = work.find((item) => item.policy === "detect_contradiction");
    if (!contradictionWork) throw new Error("expected detect_contradiction work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: contradictionWork.id,
      newId: deterministicId(),
    });

    const conflict = [...store.conflictGroups.values()][0];
    expect(conflict).toMatchObject({
      conflictType: "ownership",
      severity: "blocking",
      status: "open",
    });
    expect(conflict?.members.flatMap((member) => member.evidenceSpanIds).sort()).toEqual(["ev_1", "ev_2"]);
  });

  it("synthesize_brief reads seed memory IDs from the causing ledger payload", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext(connectedMemoryContext());
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "source_version_not_memory",
      actorType: "policy",
      inputVersion: "batch:v1",
      idempotencyKey: "memory:payload-seed",
      payload: { items: [{ id: "mem_1" }] },
    });
    const work = await routeCommittedEvents({ persistence: store });
    const synthesizeWork = work.find((item) => item.policy === "synthesize_brief");
    if (!synthesizeWork) throw new Error("expected synthesize_brief work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: modelWithValidBriefDraft(),
        newId: deterministicId(),
      }),
      workItemId: synthesizeWork.id,
      newId: deterministicId(),
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.memoryItemIds).toEqual(["mem_1", "mem_2"]);
    expect(proposal?.payload).toMatchObject({
      selectedMemoryItemIds: ["mem_1", "mem_2"],
    });
  });

  it("synthesize_brief skips isolated memory without proposing a draft", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([connectedMemoryContext()[0]!]);
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "batch_1",
      actorType: "policy",
      inputVersion: "batch:v1",
      idempotencyKey: "memory:isolated",
      payload: { memoryItemIds: ["mem_1"] },
    });
    const work = await routeCommittedEvents({ persistence: store });
    const synthesizeWork = work.find((item) => item.policy === "synthesize_brief");
    if (!synthesizeWork) throw new Error("expected synthesize_brief work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: modelWithValidBriefDraft(),
      }),
      workItemId: synthesizeWork.id,
    });

    expect([...store.proposedEvents.values()]).toHaveLength(0);
    expect(store.pendingWorkItems.get(synthesizeWork.id)?.status).toBe("completed");
    expect([...store.policyRuns.values()][0]?.fallbackReason).toContain("At least 2 active memory items");
  });

  it("synthesize_brief proposes and auto-commits a traceable artifact draft", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext(connectedMemoryContext());
    await store.commitLedgerEventWithOutbox({
      id: "levt_memory",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "batch_1",
      actorType: "policy",
      inputVersion: "batch:v1",
      idempotencyKey: "memory:connected",
      payload: { memoryItemIds: ["mem_1"] },
    });
    const work = await routeCommittedEvents({ persistence: store });
    const synthesizeWork = work.find((item) => item.policy === "synthesize_brief");
    if (!synthesizeWork) throw new Error("expected synthesize_brief work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: modelWithValidBriefDraft(),
        newId: deterministicId(),
      }),
      workItemId: synthesizeWork.id,
      newId: deterministicId(),
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.proposedEventType).toBe("artifact_draft_proposed");
    expect(proposal?.targetEventType).toBe("artifact_drafted");
    expect(proposal?.requiresHumanApproval).toBe(false);
    expect(proposal?.committedLedgerEventId).toBeTruthy();
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "artifact_drafted")).toBe(true);
    expect([...store.initiativeBriefs.values()][0]?.memoryItemIds).toEqual(["mem_1", "mem_2"]);
    expect([...store.initiativeBriefs.values()][0]?.evidenceSpanIds).toEqual(["ev_1", "ev_2"]);
  });

  it("artifact_drafted proposal creates an initiative brief idempotently", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext(connectedMemoryContext());
    const proposal = await store.createProposedEvent({
      id: "pevt_artifact",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "artifact_draft_proposed",
      targetEventType: "artifact_drafted",
      subjectType: "artifact",
      subjectId: "brief_1",
      payload: {
        briefId: "brief_1",
        title: "Docs launch readiness",
        problem: "API launch needs docs clarity.",
        proposal: "Treat docs ownership as a launch gate.",
        successMetric: "Docs owner and readiness date are agreed.",
        risksAndDependencies: "Depends on product and docs owners.",
        memoryItemIds: ["mem_1", "mem_2"],
        evidenceSpanIds: ["ev_1", "ev_2"],
      },
      evidenceSpanIds: ["ev_1", "ev_2"],
      memoryItemIds: ["mem_1", "mem_2"],
      decisionIds: [],
      requiresHumanApproval: false,
      reviewerLabel: null,
      reviewRationale: null,
    });
    await store.markProposedEventValid(proposal.id);

    const first = await store.commitValidatedProposedEvent(proposal.id);
    const second = await store.commitValidatedProposedEvent(proposal.id);

    expect(second.id).toBe(first.id);
    expect([...store.initiativeBriefs.values()]).toHaveLength(1);
  });

  it("duplicated Cloudflare Queue wakeup cannot duplicate execution", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);
    const policies = createPolicies({
      persistence: store,
      memoryModel: modelWithValidMemory(),
      newId: deterministicId(),
    });

    await executeWorkItem({ persistence: store, policies, workItemId: workItem.id, newId: deterministicId() });
    await executeWorkItem({ persistence: store, policies, workItemId: workItem.id, newId: deterministicId() });

    expect([...store.policyRuns.values()]).toHaveLength(1);
    expect([...store.proposedEvents.values()]).toHaveLength(1);
    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("completed");
  });

  it("worker claims work from Postgres before running policy", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.pendingWorkItems.get(workItem.id)?.attempts).toBe(1);
    expect(store.pendingWorkItems.get(workItem.id)?.startedAt).toBeTruthy();
  });

  it("policy output creates proposed_events before auto-commit domain writes", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.proposedEventType).toBe("memory_proposed");
    expect(proposal?.targetEventType).toBe("memory_committed");
    expect(store.committedMemory).toHaveLength(1);
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "memory_committed")).toBe(true);
  });

  it("extract_memory drops generic entity tokens before commit", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: new StaticMemoryGenerationModel({
          items: [{
            temporaryId: "m1",
            claimType: "user_signal",
            statement: "Users are unable to find the correct node installation tutorial.",
            evidenceSpanIds: ["ev_1"],
            epistemicStatus: "observed",
            qualifiers: {},
            stableDomainTags: ["docs"],
            entities: [
              { name: "The", entityType: "concept" },
              { name: "In", entityType: "concept" },
              { name: "No", entityType: "concept" },
              { name: "Four", entityType: "concept" },
              { name: "API", entityType: "system" },
              { name: "node installation tutorial", entityType: "artifact" },
              { name: "Node installation tutorial", canonicalName: "node installation tutorial", entityType: "artifact" },
            ],
            relations: [],
            schemas: [],
          }],
        }),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.committedMemory[0]?.entities).toEqual([
      { name: "API", entityType: "system" },
      { name: "node installation tutorial", entityType: "artifact" },
    ]);
  });

  it("extract_memory stores embeddings for claims, evidence, entities, and schemas when configured", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: new StaticMemoryGenerationModel({
          items: [{
            temporaryId: "m1",
            claimType: "dependency",
            statement: "Dev docs need to be updated before the API launch.",
            evidenceSpanIds: ["ev_1"],
            epistemicStatus: "reported",
            qualifiers: {},
            stableDomainTags: ["docs"],
            entities: [{ name: "API launch", entityType: "initiative" }],
            relations: [],
            schemas: [{
              subjectType: "artifact",
              predicate: "blocks",
              objectType: "initiative",
              status: "candidate",
            }],
          }],
        }),
        embeddingModel: {
          async embed(request) {
            return {
              model: "google/gemini-embedding-001",
              vectors: request.input.map(() => [0.1, 0.2, 0.3]),
            };
          },
        },
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.memoryEmbeddings.map((embedding) => embedding.targetType).sort()).toEqual([
      "claim",
      "entity",
      "evidence_span",
      "schema_pattern",
    ]);
    expect([...store.proposedEvents.values()][0]?.payload.embeddingMetadata).toMatchObject({
      embeddingCount: 4,
      models: ["google/gemini-embedding-001"],
    });
  });

  it("extract_memory still commits memory when embedding generation fails", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        embeddingModel: {
          async embed() {
            throw new Error("embedding provider timed out");
          },
        },
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("completed");
    expect(store.committedMemory).toHaveLength(1);
    expect(store.memoryEmbeddings).toHaveLength(0);
    expect([...store.proposedEvents.values()][0]?.payload.embeddingMetadata).toMatchObject({
      embeddingStatus: "failed",
      embeddingError: "embedding provider timed out",
    });
  });

  it("extract_memory commits a conservative fallback memory when model generation fails", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: {
          async generateMemory() {
            throw new Error("memory model timed out");
          },
        },
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("completed");
    expect(store.committedMemory).toHaveLength(1);
    expect(store.committedMemory[0]).toMatchObject({
      claimType: "user_signal",
      statement: "Dev docs need to be updated before the API launch.",
      evidenceSpanIds: ["ev_1"],
      epistemicStatus: "reported",
      qualifiers: {
        extractionFallback: true,
        fallbackReason: "memory model timed out",
      },
    });
  });

  it("invalid proposal cannot commit", async () => {
    const store = seededStore();
    const event = await store.createProposedEvent({
      id: "pevt_invalid",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "memory_proposed",
      targetEventType: "memory_committed",
      subjectType: "memory",
      subjectId: "srcv_1",
      payload: {},
      evidenceSpanIds: [],
      memoryItemIds: [],
      decisionIds: [],
      requiresHumanApproval: false,
      reviewerLabel: null,
      reviewRationale: null,
    });

    await expect(store.commitValidatedProposedEvent(event.id)).rejects.toThrow(/not valid/);
  });

  it("invalid extract_memory output fails closed and does not write domain rows", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: new StaticMemoryGenerationModel({
          items: [{
            temporaryId: "bad",
            claimType: "fact",
            statement: "Invented evidence should fail.",
            evidenceSpanIds: ["ev_missing"],
            epistemicStatus: "reported",
            qualifiers: {},
            stableDomainTags: [],
            entities: [],
            relations: [],
            schemas: [],
          }],
        }),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("failed");
    expect(store.committedMemory).toHaveLength(0);
  });

  it("valid auto-commit writes domain state, ledger_events, and event_outbox", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(store.committedMemory).toHaveLength(1);
    const memoryEvent = [...store.ledgerEvents.values()].find((event) => event.eventType === "memory_committed");
    expect(memoryEvent).toBeTruthy();
    expect([...store.eventOutboxRows.values()].some((row) => row.ledgerEventId === memoryEvent?.id)).toBe(true);
  });

  it("human-required proposal waits in review state", async () => {
    const store = seededStore();
    const workItem = await enqueueManualWork(store, "draft_artifact", "candidate", "cand_1");

    await executeWorkItem({
      persistence: store,
      policies: {
        ...createPolicies({ persistence: store, memoryModel: modelWithValidMemory() }),
        draft_artifact: proposalPolicy("draft_artifact", {
          targetEventType: "artifact_delivered",
          proposedEventType: "artifact_draft_proposed",
          subjectType: "artifact",
          subjectId: "art_1",
          requiresHumanApproval: true,
          payload: { memoryItemIds: ["mem_1"], evidenceSpanIds: ["ev_1"], decisionIds: ["dec_1"] },
          memoryItemIds: ["mem_1"],
          evidenceSpanIds: ["ev_1"],
          decisionIds: ["dec_1"],
        }),
      },
      workItemId: workItem.id,
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.validationStatus).toBe("valid");
    expect(proposal?.reviewStatus).toBe("pending");
    expect(proposal?.committedLedgerEventId).toBeNull();
  });

  it("approved proposal commits exactly one ledger event", async () => {
    const store = seededStore();
    const proposal = await store.createProposedEvent({
      id: "pevt_approved",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "candidate_proposed",
      targetEventType: "candidate_approved",
      subjectType: "candidate",
      subjectId: "cand_1",
      payload: { candidateId: "cand_1" },
      evidenceSpanIds: [],
      memoryItemIds: ["mem_1"],
      decisionIds: [],
      requiresHumanApproval: true,
      reviewerLabel: null,
      reviewRationale: null,
    });
    await store.markProposedEventValid(proposal.id);
    await store.approveProposedEvent(proposal.id, { reviewerLabel: "Angela", rationale: "Looks right." });

    const first = await store.commitValidatedProposedEvent(proposal.id);
    const second = await store.commitValidatedProposedEvent(proposal.id);

    expect(second.id).toBe(first.id);
    expect([...store.ledgerEvents.values()].filter((event) => event.idempotencyKey === "proposal:pevt_approved")).toHaveLength(1);
  });

  it("rejected proposal does not commit a target event", async () => {
    const store = seededStore();
    const proposal = await store.createProposedEvent({
      id: "pevt_rejected",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "candidate_proposed",
      targetEventType: "candidate_approved",
      subjectType: "candidate",
      subjectId: "cand_1",
      payload: { candidateId: "cand_1" },
      evidenceSpanIds: [],
      memoryItemIds: ["mem_1"],
      decisionIds: [],
      requiresHumanApproval: true,
      reviewerLabel: null,
      reviewRationale: null,
    });
    await store.markProposedEventValid(proposal.id);
    await store.rejectProposedEvent(proposal.id, { reviewerLabel: "Angela", rationale: "No owner." });

    await expect(store.commitValidatedProposedEvent(proposal.id)).rejects.toThrow(/requires approval/);
    expect([...store.ledgerEvents.values()].filter((event) => event.eventType === "candidate_approved")).toHaveLength(0);
  });

  it("artifact delivery requires human approval and trace references", async () => {
    const store = seededStore();
    const workItem = await enqueueManualWork(store, "gate_output", "artifact", "art_1");

    await executeWorkItem({
      persistence: store,
      policies: {
        ...createPolicies({ persistence: store, memoryModel: modelWithValidMemory() }),
        gate_output: proposalPolicy("gate_output", {
          targetEventType: "artifact_delivered",
          proposedEventType: "decision_record_proposed",
          subjectType: "artifact",
          subjectId: "art_1",
          requiresHumanApproval: false,
          payload: { artifactId: "art_1" },
        }),
      },
      workItemId: workItem.id,
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.validationStatus).toBe("invalid");
    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("failed");

    const approved = await store.createProposedEvent({
      id: "pevt_delivery",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "decision_record_proposed",
      targetEventType: "artifact_delivered",
      subjectType: "artifact",
      subjectId: "art_1",
      payload: { artifactId: "art_1", memoryItemIds: ["mem_1"], evidenceSpanIds: ["ev_1"], decisionIds: ["dec_1"] },
      evidenceSpanIds: ["ev_1"],
      memoryItemIds: ["mem_1"],
      decisionIds: ["dec_1"],
      requiresHumanApproval: true,
      reviewerLabel: null,
      reviewRationale: null,
    });
    await store.markProposedEventValid(approved.id);
    await store.approveProposedEvent(approved.id, { reviewerLabel: "Angela" });
    const event = await store.commitValidatedProposedEvent(approved.id);

    expect(event.eventType).toBe("artifact_delivered");
    expect(event.payload.memoryItemIds).toEqual(["mem_1"]);
    expect(event.payload.evidenceSpanIds).toEqual(["ev_1"]);
    expect(event.payload.decisionIds).toEqual(["dec_1"]);
  });
});

function seededStore(): InMemoryLoopPersistence {
  const store = new InMemoryLoopPersistence();
  store.seedIngestionContext({
    ingestionId: "ing_1",
    tenantId: "stable",
    sourceVersionId: "srcv_1",
    evidenceSpans: [evidenceSpan],
  });
  return store;
}

async function commitSource(store: InMemoryLoopPersistence) {
  return store.commitLedgerEventWithOutbox({
    id: "levt_source",
    tenantId: "stable",
    eventType: "source_committed",
    subjectType: "source",
    subjectId: "srcv_1",
    actorType: "human",
    inputVersion: "srcv_1",
    idempotencyKey: "source_committed:ing_1",
    payload: { ingestionId: "ing_1", sourceVersionId: "srcv_1" },
  });
}

async function routeSourceToWork(store: InMemoryLoopPersistence) {
  await commitSource(store);
  const work = await routeCommittedEvents({ persistence: store });
  const workItem = work[0];
  if (!workItem) throw new Error("expected routed work");
  return workItem;
}

async function enqueueManualWork(
  store: InMemoryLoopPersistence,
  policy: "draft_artifact" | "gate_output",
  subjectType: "candidate" | "artifact",
  subjectId: string,
) {
  await store.commitLedgerEventWithOutbox({
    id: `levt_${policy}`,
    tenantId: "stable",
    eventType: subjectType === "candidate" ? "candidate_approved" : "artifact_drafted",
    subjectType,
    subjectId,
    actorType: "human",
    inputVersion: `${subjectId}:v1`,
    idempotencyKey: `${policy}:source`,
    payload: {},
  });
  const result = await store.enqueuePendingWork({
    tenantId: "stable",
    policy,
    subjectType,
    subjectId,
    causedByEventId: `levt_${policy}`,
    inputVersion: `${subjectId}:v1`,
  });
  return result.workItem;
}

function modelWithValidMemory(): StaticMemoryGenerationModel {
  return new StaticMemoryGenerationModel({
    items: [{
      temporaryId: "m1",
      claimType: "dependency",
      statement: "Dev docs need to be updated before the API launch.",
      evidenceSpanIds: ["ev_1"],
      epistemicStatus: "reported",
      qualifiers: {},
      stableDomainTags: ["docs"],
      entities: [{ name: "Dev docs", entityType: "artifact" }],
      relations: [{
        subject: "Dev docs",
        predicate: "blocks",
        object: "API launch",
        evidenceSpanIds: ["ev_1"],
      }],
      schemas: [],
    }],
  });
}

function modelWithValidBriefDraft(): InitiativeBriefDraftModel {
  return {
    async generateInitiativeBriefDraft() {
      return {
        model: "test-brief-model",
        raw: { ok: true },
        parsed: {
          title: "Docs launch readiness",
          problem: "API launch needs docs clarity.",
          proposal: "Treat docs ownership and unresolved launch risk as a reviewable initiative.",
          successMetric: "Docs owner and launch readiness criteria are agreed before API launch.",
          risksAndDependencies: "Depends on product and docs owners.",
          memoryItemIds: ["mem_1", "mem_2"],
          evidenceSpanIds: ["ev_1", "ev_2"],
        },
      };
    },
  };
}

function connectedMemoryContext() {
  return [
    {
      memoryItem: {
        id: "mem_1",
        ingestionId: "ing_1",
        sourceVersionId: "srcv_1",
        claimType: "dependency" as const,
        statement: "Dev docs need to be updated before the API launch.",
        evidenceSpanIds: ["ev_1"],
        epistemicStatus: "reported" as const,
        qualifiers: {},
        stableDomainTags: ["docs"],
        entities: [{ name: "API launch", entityType: "initiative" }],
        relations: [{
          subject: "Dev docs",
          predicate: "blocks",
          object: "API launch",
          evidenceSpanIds: ["ev_1"],
        }],
        schemas: [{
          subjectType: "artifact",
          predicate: "blocks",
          objectType: "initiative",
          status: "candidate" as const,
        }],
        reviewState: "confirmed" as const,
      },
      evidenceSpans: [evidenceSpan],
    },
    {
      memoryItem: {
        id: "mem_2",
        ingestionId: "ing_2",
        sourceVersionId: "srcv_2",
        claimType: "risk" as const,
        statement: "API launch risk is unresolved until docs ownership is clear.",
        evidenceSpanIds: ["ev_2"],
        epistemicStatus: "reported" as const,
        qualifiers: {},
        stableDomainTags: ["docs"],
        entities: [{ name: "API launch", entityType: "initiative" }],
        relations: [{
          subject: "Dev docs",
          predicate: "blocks",
          object: "API launch",
          evidenceSpanIds: ["ev_2"],
        }],
        schemas: [{
          subjectType: "artifact",
          predicate: "blocks",
          objectType: "initiative",
          status: "candidate" as const,
        }],
        reviewState: "unreviewed" as const,
      },
      evidenceSpans: [secondEvidenceSpan],
    },
  ];
}

function memoryRecord(input: {
  id: string;
  claimType: "dependency" | "risk" | "ownership_statement" | "reported_decision";
  statement: string;
  evidenceSpanIds: string[];
  entities: Array<{ name: string; entityType: string }>;
  sourceVersionId?: string;
}) {
  const spans = input.evidenceSpanIds.map((id) => {
    if (id === "ev_1") return evidenceSpan;
    if (id === "ev_2") return secondEvidenceSpan;
    return {
      id,
      sourceVersionId: input.sourceVersionId ?? "srcv_3",
      startLine: 1,
      endLine: 1,
      startChar: 0,
      endChar: input.statement.length,
      text: input.statement,
    };
  });
  return {
    memoryItem: {
      id: input.id,
      ingestionId: `ing_${input.id}`,
      sourceVersionId: input.sourceVersionId ?? "srcv_1",
      claimType: input.claimType,
      statement: input.statement,
      evidenceSpanIds: input.evidenceSpanIds,
      epistemicStatus: "reported" as const,
      qualifiers: {},
      stableDomainTags: [],
      entities: input.entities,
      relations: [],
      schemas: [],
      reviewState: "unreviewed" as const,
    },
    evidenceSpans: spans,
  };
}

function proposalPolicy(
  name: "draft_artifact" | "gate_output",
  draft: PolicyOutput["proposedEvents"][number],
): Policy<unknown, PolicyOutput> {
  return {
    name,
    version: `${name}-test`,
    async buildInput() {
      return {
        input: {},
        inputHash: "hash",
        inputSummary: {},
      };
    },
    async run() {
      return { proposedEvents: [draft] };
    },
    async validate() {
      return { ok: true, issues: [] };
    },
  };
}

function deterministicId() {
  let id = 0;
  return (prefix: string) => `${prefix}_${++id}`;
}
