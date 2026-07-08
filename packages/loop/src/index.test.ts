import { describe, expect, it } from "vitest";
import type { Policy } from "./index";
import {
  InMemoryLoopPersistence,
  createPolicies,
  executeWorkItem,
  routeCommittedEvents,
  type PolicyOutput,
} from "./index";
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

    expect(work.map((item) => item.policy).sort()).toEqual(["check_freshness", "discover_candidate"]);
    expect([...store.pendingWorkItems.values()]).toHaveLength(2);
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
