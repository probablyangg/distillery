import { describe, expect, it } from "vitest";
import type { Policy } from "./index";
import {
  InMemoryLoopPersistence,
  createPolicies,
  executeWorkItem,
  maintainLoop,
  routeCommittedEvents,
  type PolicyOutput,
} from "./index";
import type {
  InitiativeBriefDraftModel,
  MemoryCandidateVerifierModel,
  MemoryConnectionScorerModel,
} from "@distillery/model-gateway";
import { StaticMemoryGenerationModel } from "@distillery/memory-generation";
import { discoverCorpusSynthesisClusters } from "@distillery/memory-synthesis";
import type { PendingWorkItem, PolicyRun } from "@distillery/contracts";

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

  it("routes a committed Slack context bundle once and extracts distinct causes against their exact evidence", async () => {
    const store = new InMemoryLoopPersistence();
    store.slackContextBundles.set("sctx_1", slackContextBundle());
    await store.commitLedgerEventWithOutbox({
      id: "levt_slack_context",
      tenantId: "stable",
      eventType: "slack_context_committed",
      subjectType: "context_bundle",
      subjectId: "sctx_1",
      actorType: "connector",
      actorLabel: "Slack context assembler",
      inputVersion: "a".repeat(64),
      idempotencyKey: "slack-context:csave_1:context-hash",
      payload: { connectorSaveId: "csave_1", contextBundleId: "sctx_1", contextVersion: 1 },
    });

    const firstRoute = await routeCommittedEvents({ persistence: store });
    const replayRoute = await routeCommittedEvents({ persistence: store });
    expect(firstRoute).toHaveLength(1);
    expect(firstRoute[0]).toMatchObject({ policy: "extract_slack_context", subjectType: "context_bundle", subjectId: "sctx_1" });
    expect(replayRoute).toHaveLength(0);

    let receivedSlackContext: unknown;
    await executeWorkItem({
      persistence: store,
      workItemId: firstRoute[0]!.id,
      policies: createPolicies({
        persistence: store,
        memoryModel: {
          async generateMemory(request) {
            receivedSlackContext = request.slackContext;
            return {
              model: "context-extractor",
              raw: { ok: true },
              parsed: { items: [
                {
                  temporaryId: "release_cause", claimType: "fact" as const,
                  statement: "Checkout failures started immediately after release 2.7.0.",
                  evidenceSpanIds: ["ev_selected"], epistemicStatus: "reported" as const,
                  qualifiers: { temporalOrder: "reported_after_release" }, stableDomainTags: ["checkout"],
                  entities: [], relations: [], schemas: [],
                },
                {
                  temporaryId: "provider_cause", claimType: "fact" as const,
                  statement: "Morpho timeouts were also observed during the checkout incident.",
                  evidenceSpanIds: ["ev_reply"], epistemicStatus: "reported" as const,
                  qualifiers: { observedDuring: "incident" }, stableDomainTags: ["checkout", "morpho"],
                  entities: [], relations: [], schemas: [],
                },
              ] },
            };
          },
        },
        newId: deterministicId(),
      }),
      newId: deterministicId(),
    });

    expect(receivedSlackContext).toMatchObject({
      selectedMessageTimestamp: "1752624000.000001",
      classification: { category: "incident", identities: { products: ["StablePay"], releaseVersions: ["2.7.0"] } },
      items: [
        { role: "channel_profile", evidenceSpanIds: [] },
        { role: "selected_message", evidenceSpanIds: ["ev_selected"] },
        { role: "thread_reply", evidenceSpanIds: ["ev_reply"] },
      ],
    });
    expect(store.committedMemory.map((item) => item.statement)).toEqual([
      "Checkout failures started immediately after release 2.7.0.",
      "Morpho timeouts were also observed during the checkout incident.",
    ]);
    expect(store.committedMemory.map((item) => item.evidenceSpanIds)).toEqual([["ev_selected"], ["ev_reply"]]);
  });

  it("re-sends an existing pending work id when the first queue wakeup fails", async () => {
    const store = seededStore();
    await commitSource(store);
    let sends = 0;
    const queue = {
      async send() {
        sends += 1;
        if (sends === 1) throw new Error("queue unavailable");
      },
    };

    const first = await routeCommittedEvents({ persistence: store, queue });
    const second = await routeCommittedEvents({ persistence: store, queue });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(store.pendingWorkItems.size).toBe(1);
    expect([...store.eventOutboxRows.values()][0]?.status).toBe("processed");
  });

  it("routes more than ten pending outbox events in one bounded default batch", async () => {
    const store = new InMemoryLoopPersistence();
    for (let index = 0; index < 11; index += 1) {
      await commitSourceNumber(store, index);
    }

    const routed = await routeCommittedEvents({ persistence: store });

    expect(routed).toHaveLength(11);
    expect([...store.eventOutboxRows.values()].every((row) => row.status === "processed")).toBe(true);
    expect(store.pendingWorkItems.size).toBe(11);
  });

  it("processed seed sources do not block a later real capture", async () => {
    const store = new InMemoryLoopPersistence();
    for (let index = 0; index < 10; index += 1) {
      const event = await commitSourceNumber(store, index, "Distillery seed data");
      const outbox = [...store.eventOutboxRows.values()].find((row) => row.ledgerEventId === event.id);
      if (!outbox) throw new Error("expected seed outbox");
      outbox.status = "processed";
      outbox.processedAt = new Date(0).toISOString();
      outbox.resolutionReason = "non_actionable_seed_source";
    }
    const realEvent = await commitSourceNumber(store, 10, "Angela");

    const routed = await routeCommittedEvents({ persistence: store });

    expect(routed).toHaveLength(1);
    expect(routed[0]?.causedByEventId).toBe(realEvent.id);
    expect([...store.pendingWorkItems.values()].filter((item) => item.policy === "extract_memory")).toHaveLength(1);
  });

  it("scheduled maintenance drains bounded batches on future invocations", async () => {
    const store = new InMemoryLoopPersistence();
    const messages: string[] = [];
    const queue = { async send(message: { workItemId: string }) { messages.push(message.workItemId); } };
    for (let index = 0; index < 30; index += 1) {
      await commitSourceNumber(store, index);
    }

    const first = await maintainLoop({ persistence: store, queue, tenantId: "stable", maxRows: 12 });
    const second = await maintainLoop({ persistence: store, queue, tenantId: "stable", maxRows: 12 });
    const third = await maintainLoop({ persistence: store, queue, tenantId: "stable", maxRows: 12 });

    expect(first.routedWorkItems).toHaveLength(12);
    expect(second.routedWorkItems).toHaveLength(12);
    expect(third.routedWorkItems).toHaveLength(6);
    expect(messages).toHaveLength(30);
    expect([...store.eventOutboxRows.values()].every((row) => row.status === "processed")).toBe(true);
  });

  it("scheduled maintenance re-sends canonical pending connector work after a lost initial queue wakeup", async () => {
    const store = new InMemoryLoopPersistence();
    const event = await store.commitLedgerEventWithOutbox({
      id: "levt_slack_save",
      tenantId: "stable",
      eventType: "slack_save_requested",
      subjectType: "connector_save",
      subjectId: "csave_1",
      actorType: "connector",
      inputVersion: "request_hash",
      idempotencyKey: "slack-interaction:request_hash",
      payload: { connectorSaveId: "csave_1" },
    });
    const { workItem } = await store.enqueuePendingWork({
      tenantId: "stable",
      policy: "ingest_slack_source",
      subjectType: "connector_save",
      subjectId: "csave_1",
      causedByEventId: event.id,
      inputVersion: "request_hash",
    });
    const messages: string[] = [];

    await maintainLoop({
      persistence: store,
      queue: { async send(message) { messages.push(message.workItemId); } },
      tenantId: "stable",
      maxRows: 4,
    });

    expect(messages).toContain(workItem.id);
    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("pending");
  });

  it("executes Slack connector work through the real policy registry without proposed domain events", async () => {
    const store = new InMemoryLoopPersistence();
    const event = await store.commitLedgerEventWithOutbox({
      id: "levt_slack_policy",
      tenantId: "stable",
      eventType: "slack_save_requested",
      subjectType: "connector_save",
      subjectId: "csave_policy",
      actorType: "connector",
      inputVersion: "request_hash",
      idempotencyKey: "slack-interaction:policy-request",
      payload: { connectorSaveId: "csave_policy" },
    });
    const { workItem } = await store.enqueuePendingWork({
      tenantId: "stable",
      policy: "ingest_slack_source",
      subjectType: "connector_save",
      subjectId: "csave_policy",
      causedByEventId: event.id,
      inputVersion: "request_hash",
    });
    const calls: string[] = [];
    const result = await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        connectorPolicyRunner: {
          async ingestSlackSource(saveId) { calls.push(`ingest:${saveId}`); return { sourceCount: 2 }; },
          async syncSlackReaction(saveId) { calls.push(`reaction:${saveId}`); },
        },
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    expect(calls).toEqual(["ingest:csave_policy"]);
    expect(result?.proposedEvents).toEqual([]);
    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("completed");
    expect([...store.policyRuns.values()][0]).toMatchObject({
      policyName: "ingest_slack_source",
      status: "completed",
      provider: "slack",
    });
  });

  it("recovers stale running work, closes its policy run, and requeues the work id", async () => {
    const store = new InMemoryLoopPersistence();
    const messages: string[] = [];
    const queue = { async send(message: { workItemId: string }) { messages.push(message.workItemId); } };
    const work = await enqueueExtractWork(store, "stale");
    const claimed = await store.claimPendingWork(work.id, 120);
    if (!claimed?.leaseToken) throw new Error("expected leased work");
    await store.createPolicyRun(policyRunFor(claimed, "polrun_stale"));
    const stored = store.pendingWorkItems.get(work.id);
    if (!stored) throw new Error("expected stored work");
    stored.leaseExpiresAt = "2026-07-15T12:00:00.000Z";

    const result = await maintainLoop({
      persistence: store,
      queue,
      tenantId: "stable",
      now: "2026-07-15T12:01:00.000Z",
    });

    expect(result.recoveredWorkCount).toBe(1);
    expect(messages).toEqual([work.id]);
    expect(store.pendingWorkItems.get(work.id)).toMatchObject({ status: "pending", recoveryCount: 1 });
    expect(store.policyRuns.get("polrun_stale")).toMatchObject({
      status: "failed",
      failureKind: "lease_expired",
    });
  });

  it("retries a recovered-work wakeup when the first queue send is lost", async () => {
    const store = new InMemoryLoopPersistence();
    const work = await enqueueExtractWork(store, "lost-recovery-wakeup");
    const claimed = await store.claimPendingWork(work.id, 120);
    if (!claimed?.leaseToken) throw new Error("expected leased work");
    const stored = store.pendingWorkItems.get(work.id);
    if (!stored) throw new Error("expected stored work");
    stored.leaseExpiresAt = "2026-07-15T12:00:00.000Z";

    await expect(maintainLoop({
      persistence: store,
      queue: { async send() { throw new Error("queue unavailable"); } },
      tenantId: "stable",
      now: "2026-07-15T12:01:00.000Z",
    })).rejects.toThrow("queue unavailable");
    expect(store.pendingWorkItems.get(work.id)?.status).toBe("pending");

    const messages: string[] = [];
    await maintainLoop({
      persistence: store,
      queue: { async send(message) { messages.push(message.workItemId); } },
      tenantId: "stable",
      now: "2026-07-15T12:02:00.000Z",
    });

    expect(messages).toEqual([work.id]);
  });

  it("recovers an abandoned processing outbox claim without touching active claims", async () => {
    const store = new InMemoryLoopPersistence();
    await commitSourceNumber(store, 1);
    const claimed = await store.claimEventOutboxRow(120);
    if (!claimed) throw new Error("expected claimed outbox row");
    const stored = store.eventOutboxRows.get(claimed.id);
    if (!stored) throw new Error("expected stored outbox row");
    stored.leaseExpiresAt = "2026-07-15T12:00:00.000Z";

    const result = await store.recoverExpiredLoopClaims({
      tenantId: "stable",
      now: "2026-07-15T12:01:00.000Z",
    });

    expect(result.recoveredOutboxCount).toBe(1);
    expect(store.eventOutboxRows.get(claimed.id)).toMatchObject({
      status: "pending",
      recoveryCount: 1,
      leaseToken: null,
    });
  });

  it("moves a repeatedly abandoned work item to terminal failure at its attempt limit", async () => {
    const store = new InMemoryLoopPersistence();
    const work = await enqueueExtractWork(store, "terminal");
    const claimed = await store.claimPendingWork(work.id, 120);
    if (!claimed?.leaseToken) throw new Error("expected leased work");
    const stored = store.pendingWorkItems.get(work.id);
    if (!stored) throw new Error("expected stored work");
    stored.attempts = 3;
    stored.leaseExpiresAt = "2026-07-15T12:00:00.000Z";

    const result = await store.recoverExpiredLoopClaims({
      tenantId: "stable",
      now: "2026-07-15T12:01:00.000Z",
      maxWorkAttempts: 3,
    });

    expect(result.terminalWorkCount).toBe(1);
    expect(result.recoveredWorkItems).toHaveLength(0);
    expect(store.pendingWorkItems.get(work.id)).toMatchObject({ status: "failed", recoveryCount: 1 });
  });

  it("duplicate queue delivery can claim and execute a work item only once", async () => {
    const store = seededStore();
    const work = await routeSourceToWork(store);
    let modelCalls = 0;
    const policies = createPolicies({
      persistence: store,
      memoryModel: {
        async generateMemory() {
          modelCalls += 1;
          return modelWithValidMemory().generateMemory();
        },
      },
      newId: deterministicId(),
    });

    const first = await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });
    const duplicate = await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(modelCalls).toBe(1);
    expect(store.committedMemory).toHaveLength(1);
  });

  it("keeps short input on one extraction without calling the section planner", async () => {
    const store = seededStore();
    const work = await routeSourceToWork(store);
    let plannerCalls = 0;
    await executeWorkItem({
      persistence: store,
      workItemId: work.id,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        memorySectionPlannerModel: { async planMemorySections() { plannerCalls += 1; throw new Error("unexpected"); } },
        newId: deterministicId(),
      }),
      newId: deterministicId(),
    });
    expect(plannerCalls).toBe(0);
    expect(store.committedMemory).toHaveLength(1);
    expect(store.memorySectionPlansBySourceVersionId.get("srcv_1")?.usedSectioning).toBe(false);
  });

  it("extracts every long-document section and consolidates more than 30 candidates idempotently", async () => {
    const store = new InMemoryLoopPersistence();
    const evidenceSpans = longEvidenceSpans(21, 350);
    store.seedIngestionContext({ ingestionId: "ing_long", tenantId: "stable", sourceVersionId: "srcv_long", evidenceSpans });
    await store.commitLedgerEventWithOutbox({
      id: "levt_long", tenantId: "stable", eventType: "source_committed", subjectType: "source",
      subjectId: "srcv_long", actorType: "human", inputVersion: "srcv_long",
      idempotencyKey: "source_committed:ing_long", payload: { ingestionId: "ing_long", sourceVersionId: "srcv_long" },
    });
    const [parentWork] = await routeCommittedEvents({ persistence: store });
    if (!parentWork) throw new Error("expected parent extraction work");
    let extractionCalls = 0;
    const policies = createPolicies({
      persistence: store,
      memorySectionPlannerModel: {
        async planMemorySections() {
          return {
            model: "semantic-planner",
            raw: { ok: true },
            parsed: { sections: [
              { temporaryId: "overview", title: "Overview", startEvidenceSpanId: "long_1", endEvidenceSpanId: "long_7" },
              { temporaryId: "memiavl", title: "MemIAVL", startEvidenceSpanId: "long_8", endEvidenceSpanId: "long_14" },
              { temporaryId: "deferred", title: "Deferred work", startEvidenceSpanId: "long_15", endEvidenceSpanId: "long_21" },
            ] },
          };
        },
      },
      memoryModel: {
        async generateMemory(request) {
          extractionCalls += 1;
          const evidenceSpanId = request.evidenceSpans[0]!.id;
          return {
            model: "section-extractor",
            raw: { section: evidenceSpanId },
            parsed: { items: Array.from({ length: 11 }, (_, index) => ({
              temporaryId: `${evidenceSpanId}_${index}`,
              claimType: "fact" as const,
              statement: `Fact ${index + 1} supported by ${evidenceSpanId}.`,
              evidenceSpanIds: [evidenceSpanId],
              epistemicStatus: "reported" as const,
              qualifiers: {}, stableDomainTags: [], entities: [], relations: [], schemas: [],
            })) },
          };
        },
      },
      newId: deterministicId(),
    });

    await executeWorkItem({ persistence: store, policies, workItemId: parentWork.id, newId: deterministicId() });
    const sectionWork = (await routeCommittedEvents({ persistence: store })).filter((work) => work.policy === "extract_memory_section");
    expect(sectionWork).toHaveLength(3);
    for (const work of sectionWork) await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });
    const consolidationWork = (await routeCommittedEvents({ persistence: store })).filter((work) => work.policy === "consolidate_memory");
    expect(consolidationWork).toHaveLength(3);
    for (const work of consolidationWork) await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });

    expect(extractionCalls).toBe(3);
    expect(store.committedMemory).toHaveLength(33);
    expect(store.committedMemory.every((item) => item.evidenceSpanIds[0]?.startsWith("long_"))).toBe(true);
    expect([...store.proposedEvents.values()].filter((event) => event.proposedEventType === "memory_proposed")).toHaveLength(2);
    expect(store.memorySectionPlansBySourceVersionId.get("srcv_long")?.status).toBe("completed");
    expect(await executeWorkItem({ persistence: store, policies, workItemId: sectionWork[0]!.id, newId: deterministicId() })).toBeNull();
    expect(store.committedMemory).toHaveLength(33);
  });

  it("prevents false success and resumes only the failed section", async () => {
    const store = new InMemoryLoopPersistence();
    const evidenceSpans = longEvidenceSpans(21, 350);
    store.seedIngestionContext({ ingestionId: "ing_resume", tenantId: "stable", sourceVersionId: "srcv_resume", evidenceSpans });
    await store.commitLedgerEventWithOutbox({
      id: "levt_resume", tenantId: "stable", eventType: "source_committed", subjectType: "source",
      subjectId: "srcv_resume", actorType: "human", inputVersion: "srcv_resume",
      idempotencyKey: "source_committed:ing_resume", payload: { ingestionId: "ing_resume", sourceVersionId: "srcv_resume" },
    });
    const [parentWork] = await routeCommittedEvents({ persistence: store });
    if (!parentWork) throw new Error("expected parent extraction work");
    let extractionCalls = 0;
    const policies = createPolicies({
      persistence: store,
      memorySectionPlannerModel: {
        async planMemorySections() {
          return { model: "planner", raw: {}, parsed: { sections: [
            { temporaryId: "one", title: "One", startEvidenceSpanId: "long_1", endEvidenceSpanId: "long_7" },
            { temporaryId: "two", title: "Two", startEvidenceSpanId: "long_8", endEvidenceSpanId: "long_14" },
            { temporaryId: "three", title: "Three", startEvidenceSpanId: "long_15", endEvidenceSpanId: "long_21" },
          ] } };
        },
      },
      memoryModel: {
        async generateMemory(request) {
          extractionCalls += 1;
          const evidenceSpanId = request.evidenceSpans[0]!.id;
          return { model: "extractor", raw: {}, parsed: { items: [{
            temporaryId: `candidate_${evidenceSpanId}`, claimType: "fact" as const,
            statement: `Distinct fact supported by ${evidenceSpanId}.`, evidenceSpanIds: [evidenceSpanId],
            epistemicStatus: "reported" as const, qualifiers: {}, stableDomainTags: [], entities: [], relations: [], schemas: [],
          }] } };
        },
      },
      newId: deterministicId(),
    });
    await executeWorkItem({ persistence: store, policies, workItemId: parentWork.id, newId: deterministicId() });
    const sectionWork = (await routeCommittedEvents({ persistence: store })).filter((work) => work.policy === "extract_memory_section");
    const failingSectionId = sectionWork[1]!.subjectId;
    const completeSection = store.completeMemorySection.bind(store);
    let failOnce = true;
    store.completeMemorySection = async (input) => {
      if (input.sectionId === failingSectionId && failOnce) {
        failOnce = false;
        throw new Error("provider timeout?token=topsecret Bearer topsecretvalue");
      }
      return completeSection(input);
    };
    for (const work of sectionWork) await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });
    const prematureFinalizers = (await routeCommittedEvents({ persistence: store })).filter((work) => work.policy === "consolidate_memory");
    for (const work of prematureFinalizers) await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });

    expect(store.committedMemory).toHaveLength(0);
    expect(store.memorySectionPlansBySourceVersionId.get("srcv_resume")?.status).toBe("failed");
    expect([...store.memorySections.values()].map((section) => section.status)).toEqual(["completed", "failed", "completed"]);
    expect(store.memorySections.get(failingSectionId)?.errorMessage).toContain("[redacted]");
    expect(store.memorySections.get(failingSectionId)?.errorMessage).not.toContain("topsecret");

    const retryIds = await store.retryMemorySectionIngestion("ing_resume");
    expect(retryIds).toEqual([sectionWork[1]!.id]);
    await executeWorkItem({ persistence: store, policies, workItemId: retryIds[0]!, newId: deterministicId() });
    const finalizers = (await routeCommittedEvents({ persistence: store })).filter((work) => work.policy === "consolidate_memory");
    for (const work of finalizers) await executeWorkItem({ persistence: store, policies, workItemId: work.id, newId: deterministicId() });

    expect(extractionCalls).toBe(4);
    expect(store.committedMemory).toHaveLength(3);
    expect(store.extractionRuns.filter((run) => typeof run === "object" && run !== null && "id" in run && String(run.id).startsWith("extr_msec"))).toHaveLength(3);
    expect(store.memorySectionPlansBySourceVersionId.get("srcv_resume")?.status).toBe("completed");
  });

  it("allows only one concurrent claim for the same canonical section work", async () => {
    const store = new InMemoryLoopPersistence();
    const work = await enqueueExtractWork(store, "concurrent");
    const [first, second] = await Promise.all([
      store.claimPendingWork(work.id, 900),
      store.claimPendingWork(work.id, 900),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter((claim) => claim === null)).toHaveLength(1);
  });

  it("lets a new capture prefer its own outbox row without changing later FIFO routing", async () => {
    const store = new InMemoryLoopPersistence();
    await store.commitLedgerEventWithOutbox({
      id: "levt_old", tenantId: "stable", eventType: "source_committed", subjectType: "source",
      subjectId: "srcv_old", actorType: "human", inputVersion: "srcv_old", idempotencyKey: "old", payload: {},
    });
    await store.commitLedgerEventWithOutbox({
      id: "levt_new", tenantId: "stable", eventType: "source_committed", subjectType: "source",
      subjectId: "srcv_new", actorType: "human", inputVersion: "srcv_new", idempotencyKey: "new", payload: {},
    });
    const rows = [...store.eventOutboxRows.values()];
    rows[0]!.createdAt = "2026-07-15T10:00:00.000Z";
    rows[1]!.createdAt = "2026-07-15T11:00:00.000Z";

    const preferred = await store.claimEventOutboxRow(120, "srcv_new");
    expect(preferred?.ledgerEventId).toBe("levt_new");
    const fifo = await store.claimEventOutboxRow(120);
    expect(fifo?.ledgerEventId).toBe("levt_old");
  });

  it("does not recover a slow worker while its lease is still valid", async () => {
    const store = new InMemoryLoopPersistence();
    const work = await enqueueExtractWork(store, "slow");
    const claimed = await store.claimPendingWork(work.id, 900);
    if (!claimed?.leaseToken) throw new Error("expected leased work");
    await store.createPolicyRun(policyRunFor(claimed, "polrun_slow"));
    const stored = store.pendingWorkItems.get(work.id);
    if (!stored) throw new Error("expected stored work");
    stored.leaseExpiresAt = "2026-07-15T12:15:00.000Z";

    const result = await store.recoverExpiredLoopClaims({
      tenantId: "stable",
      now: "2026-07-15T12:14:59.000Z",
    });

    expect(result.recoveredWorkCount).toBe(0);
    expect(store.pendingWorkItems.get(work.id)?.status).toBe("running");
    expect(store.policyRuns.get("polrun_slow")?.status).toBe("running");
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
      "recompute_cluster",
      "update_embeddings",
      "update_graph",
    ]);
    expect([...store.pendingWorkItems.values()]).toHaveLength(7);
  });

  it("connection and contradiction changes invalidate then rebuild the graph facet", async () => {
    const store = seededStore();
    store.synthesisEnrichment.set("mem_1", {
      memoryItemId: "mem_1",
      inputVersion: "before",
      completedFacets: ["connections", "contradictions", "embeddings", "graph"],
      failedFacets: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    });
    await store.commitLedgerEventWithOutbox({
      id: "levt_connections_changed",
      tenantId: "stable",
      eventType: "connections_updated",
      subjectType: "memory",
      subjectId: "mem_1",
      actorType: "policy",
      inputVersion: "connections:v2",
      idempotencyKey: "connections:v2",
      payload: { memoryItemIds: ["mem_1"], connections: [] },
    });

    const work = await routeCommittedEvents({ persistence: store });

    expect(work.map((item) => item.policy).sort()).toEqual(["recompute_cluster", "update_graph"]);
    const proposal = await store.createProposedEvent({
      id: "pevt_connections_changed",
      tenantId: "stable",
      workItemId: null,
      policyRunId: null,
      proposedEventType: "enrichment_update_proposed",
      targetEventType: "connections_updated",
      subjectType: "memory",
      subjectId: "mem_1",
      payload: { memoryItemIds: ["mem_1"], connections: [] },
      evidenceSpanIds: [],
      memoryItemIds: ["mem_1"],
      decisionIds: [],
      requiresHumanApproval: false,
      reviewerLabel: null,
      reviewRationale: null,
    });
    await store.markProposedEventValid(proposal.id);
    await store.commitValidatedProposedEvent(proposal.id);

    expect(store.synthesisEnrichment.get("mem_1")?.completedFacets).not.toContain("graph");
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

  it("connect_memory uses LLM scorer tiers and persists tier metadata in score components", async () => {
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
      idempotencyKey: "memory:connect:llm",
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
        memoryConnectionScorerModel: new StaticConnectionScorer(),
        newId: deterministicId(),
      }),
      workItemId: connectWork.id,
      newId: deterministicId(),
    });

    const connection = [...store.claimConnections.values()][0];
    expect(connection).toMatchObject({
      fromClaimId: "mem_1",
      toClaimId: "mem_2",
      connectionType: "depends_on",
      confidence: 0.88,
    });
    expect(connection?.scoreComponents).toMatchObject({
      tier: "direct",
      connectionReason: "explicit_dependency",
      llmModel: "static-connection-scorer",
      reviewRequired: false,
    });
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

  it("memory changes recompute clusters instead of running synthesis early", async () => {
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
    const recomputeWork = work.find((item) => item.policy === "recompute_cluster");
    if (!recomputeWork) throw new Error("expected recompute_cluster work");

    const result = await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        newId: deterministicId(),
      }),
      workItemId: recomputeWork.id,
      newId: deterministicId(),
    });

    expect(work.some((item) => item.policy === "synthesize_brief")).toBe(false);
    expect(result?.proposedEvents.some((proposal) => proposal.targetEventType === "cluster_changed")).toBe(true);
  });

  it("isolated memory completes cluster recomputation without pretending a brief was generated", async () => {
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
    const recomputeWork = work.find((item) => item.policy === "recompute_cluster");
    if (!recomputeWork) throw new Error("expected recompute_cluster work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: modelWithValidBriefDraft(),
      }),
      workItemId: recomputeWork.id,
    });

    expect([...store.proposedEvents.values()]).toHaveLength(0);
    expect(store.pendingWorkItems.get(recomputeWork.id)?.status).toBe("completed");
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "artifact_drafted")).toBe(false);
  });

  it("accepts a no-op readiness result when the cluster state is unchanged", async () => {
    const store = seededStore();
    const policy = createPolicies({
      persistence: store,
      memoryModel: modelWithValidMemory(),
    }).evaluate_synthesis_readiness;

    const validation = await policy.validate({
      proposedEvents: [],
      provider: "deterministic",
      model: "corpus-synthesis-v1",
      fallbackReason: "Readiness state is unchanged for this cluster version.",
    });

    expect(validation).toEqual({ ok: true, issues: [] });
  });

  it("synthesis_ready generates and persists one traceable suggested draft", async () => {
    const store = seededStore();
    const memory = connectedMemoryContext();
    store.seedMemorySynthesisContext(memory);
    const cluster = discoverCorpusSynthesisClusters({ tenantId: "stable", memory })
      .find((candidate) => candidate.meaningKey === "entity:api launch");
    if (!cluster) throw new Error("expected corpus cluster");
    store.synthesisClusters.set(cluster.id, cluster);
    await store.commitLedgerEventWithOutbox({
      id: "levt_ready",
      tenantId: "stable",
      eventType: "synthesis_ready",
      subjectType: "cluster",
      subjectId: cluster.id,
      actorType: "policy",
      inputVersion: cluster.version,
      idempotencyKey: `ready:${cluster.id}:${cluster.version}`,
      payload: { clusterId: cluster.id, clusterVersion: cluster.version, generationIntent: "initiative_brief" },
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
    expect(store.suggestedBriefKeys.size).toBe(1);
  });

  it("invalid suggested-brief model output commits no domain state", async () => {
    const store = seededStore();
    const synthesizeWork = await routeSynthesisReadyWork(store, "invalid");
    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: {
          async generateInitiativeBriefDraft() {
            const valid = await modelWithValidBriefDraft().generateInitiativeBriefDraft({ memoryItems: [], evidenceSpans: [] });
            return { ...valid, parsed: { ...valid.parsed, evidenceSpanIds: ["ev_not_in_dossier"] } };
          },
        },
      }),
      workItemId: synthesizeWork.id,
    });

    expect(store.pendingWorkItems.get(synthesizeWork.id)?.status).toBe("completed");
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "artifact_drafted")).toBe(false);
    expect([...store.ledgerEvents.values()].some((event) =>
      event.eventType === "cluster_readiness_changed" && event.payload.evaluation &&
      (event.payload.evaluation as { state?: string }).state === "failed"
    )).toBe(true);
    expect(store.initiativeBriefs.size).toBe(0);
  });

  it("records a model timeout as an explicit failed work item", async () => {
    const store = seededStore();
    const synthesizeWork = await routeSynthesisReadyWork(store, "timeout");
    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        initiativeBriefDraftModel: {
          async generateInitiativeBriefDraft() {
            throw new Error("initiative brief generation timed out");
          },
        },
      }),
      workItemId: synthesizeWork.id,
    });

    expect(store.pendingWorkItems.get(synthesizeWork.id)?.status).toBe("completed");
    expect([...store.synthesisReadiness.values()]).toEqual([
      expect.objectContaining({ state: "failed", reasons: [expect.stringContaining("timed out")] }),
    ]);
    expect(store.initiativeBriefs.size).toBe(0);
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

  it("bounded global sweeps resume from a durable cursor", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([
      ...connectedMemoryContext(),
      memoryRecord({
        id: "mem_3",
        claimType: "dependency",
        statement: "A third launch dependency needs review.",
        evidenceSpanIds: ["ev_3"],
        entities: [{ name: "API launch", entityType: "initiative" }],
        sourceVersionId: "srcv_3",
      }),
    ]);

    expect(await store.scheduleSynthesisScanEvents({ tenantId: "stable", limit: 2 })).toBe(2);
    expect(await store.scheduleSynthesisScanEvents({ tenantId: "stable", limit: 2 })).toBe(1);
    const sweepEvents = [...store.ledgerEvents.values()].filter((event) => event.eventType === "synthesis_neighborhood_dirty");
    expect(sweepEvents.map((event) => event.subjectId).sort()).toEqual(["mem_1", "mem_2", "mem_3"]);
  });

  it("global sweeps do not re-emit unchanged cluster versions", async () => {
    const store = seededStore();
    const memory = connectedMemoryContext();
    store.seedMemorySynthesisContext(memory);
    for (const cluster of discoverCorpusSynthesisClusters({ tenantId: "stable", memory })) {
      store.synthesisClusters.set(cluster.id, cluster);
    }
    await store.scheduleSynthesisScanEvents({ tenantId: "stable", limit: 1 });
    const work = await routeCommittedEvents({ persistence: store });
    const recomputeWork = work.find((item) => item.policy === "recompute_cluster");
    if (!recomputeWork) throw new Error("expected recompute_cluster work");

    const result = await executeWorkItem({
      persistence: store,
      policies: createPolicies({ persistence: store, memoryModel: modelWithValidMemory() }),
      workItemId: recomputeWork.id,
    });

    expect(result?.proposedEvents).toHaveLength(0);
    expect(store.pendingWorkItems.get(recomputeWork.id)?.status).toBe("completed");
  });

  it("one cluster version and intent creates one suggested draft across persistence retries", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext(connectedMemoryContext());
    for (const [index, briefId] of ["brief_a", "brief_b"].entries()) {
      const proposal = await store.createProposedEvent({
        id: `pevt_suggested_${index}`,
        tenantId: "stable",
        workItemId: null,
        policyRunId: null,
        proposedEventType: "artifact_draft_proposed",
        targetEventType: "artifact_drafted",
        subjectType: "artifact",
        subjectId: briefId,
        payload: {
          briefId,
          clusterId: "cluster_1",
          clusterVersion: "v1",
          generationIntent: "initiative_brief",
          title: "Docs launch readiness",
          problem: "API launch needs docs clarity.",
          proposal: "Treat docs ownership as a launch gate.",
          successMetric: "Docs owner and readiness date are agreed.",
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
      await store.commitValidatedProposedEvent(proposal.id);
    }
    expect(store.suggestedBriefKeys.size).toBe(1);
    expect(store.initiativeBriefs.size).toBe(1);
    expect([...store.ledgerEvents.values()].filter((event) => event.eventType === "artifact_drafted")).toHaveLength(1);
    expect([...store.eventOutboxRows.values()].filter((row) =>
      store.ledgerEvents.get(row.ledgerEventId)?.eventType === "artifact_drafted"
    )).toHaveLength(1);
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

  it("finalizes policy run metadata before completing pending work", async () => {
    const store = new OrderedLoopPersistence();
    store.seedIngestionContext({
      ingestionId: "ing_1",
      tenantId: "stable",
      sourceVersionId: "srcv_1",
      evidenceSpans: [evidenceSpan],
    });
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

    expect(store.calls.indexOf("completePolicyRun")).toBeLessThan(store.calls.indexOf("completePendingWork"));
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

  it("update_embeddings stores claims, evidence, entities, and schemas independently", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([connectedMemoryContext()[0]!]);
    await store.commitLedgerEventWithOutbox({
      id: "levt_embed",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "mem_1",
      actorType: "policy",
      inputVersion: "mem_1:v1",
      idempotencyKey: "memory:embed",
      payload: { memoryItemIds: ["mem_1"] },
    });
    const workItem = (await routeCommittedEvents({ persistence: store })).find((item) => item.policy === "update_embeddings");
    if (!workItem) throw new Error("expected update_embeddings work");

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
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
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "embeddings_updated")).toBe(true);
    expect(store.synthesisEnrichment.get("mem_1")?.completedFacets).toContain("embeddings");
  });

  it("embedding failure is retryable without rolling back committed memory", async () => {
    const store = seededStore();
    store.seedMemorySynthesisContext([connectedMemoryContext()[0]!]);
    store.committedMemory.push({
      id: "mem_1",
      claimType: "dependency",
      statement: "Dev docs need to be updated before the API launch.",
      evidenceSpanIds: ["ev_1"],
      epistemicStatus: "reported",
      qualifiers: {},
      stableDomainTags: ["docs"],
      entities: [],
      relations: [],
      schemas: [],
    });
    await store.commitLedgerEventWithOutbox({
      id: "levt_embed_fail",
      tenantId: "stable",
      eventType: "memory_committed",
      subjectType: "memory",
      subjectId: "mem_1",
      actorType: "policy",
      inputVersion: "mem_1:v1",
      idempotencyKey: "memory:embed:fail",
      payload: { memoryItemIds: ["mem_1"] },
    });
    const workItem = (await routeCommittedEvents({ persistence: store })).find((item) => item.policy === "update_embeddings");
    if (!workItem) throw new Error("expected update_embeddings work");

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

    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("failed");
    expect(store.committedMemory).toHaveLength(1);
    expect(store.memoryEmbeddings).toHaveLength(0);
    expect([...store.ledgerEvents.values()].some((event) => event.eventType === "embeddings_updated")).toBe(false);
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

  it("extract_memory verifier routes verified, needs-review, duplicate, unsupported, and corrected candidates", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: new StaticMemoryGenerationModel({
          items: [
            memoryCandidate("verified", "Docs ownership blocks launch readiness."),
            memoryCandidate("review", "Docs ownership may block launch readiness."),
            memoryCandidate("unsupported", "Payments launch is approved."),
            memoryCandidate("duplicate", "Docs ownership blocks launch readiness again."),
            memoryCandidate("correct", "Docs ownership is a launch risk."),
          ],
        }),
        memoryVerifierModel: new StaticMemoryVerifier({
          verified: { decision: "verified", rationale: "Directly supported." },
          review: { decision: "needs_review", rationale: "Plausible but hedged." },
          unsupported: { decision: "unsupported", rationale: "Approval is not in evidence." },
          duplicate: { decision: "duplicate", rationale: "Covered by verified." },
          correct: {
            decision: "corrected",
            rationale: "This is a dependency, not a risk.",
            correctedItem: {
              ...memoryCandidate("corrected", "API launch readiness depends on docs ownership."),
              claimType: "dependency",
            },
          },
        }),
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    const proposals = [...store.proposedEvents.values()].filter((event) => event.proposedEventType === "memory_proposed");
    expect(proposals).toHaveLength(2);
    expect(proposals.find((event) => !event.requiresHumanApproval)?.payload.items).toHaveLength(2);
    expect(proposals.find((event) => event.requiresHumanApproval)?.payload.items).toHaveLength(1);
    expect(store.committedMemory).toHaveLength(2);
    expect(store.committedMemory.map((item) => item.qualifiers.verificationStatus)).toEqual(["verified", "corrected"]);
    expect(JSON.stringify(store.extractionRuns[0])).toContain("Approval is not in evidence.");
    expect(JSON.stringify(store.extractionRuns[0])).toContain("Covered by verified.");
  });

  it("extract_memory verifier outage routes valid candidates to review instead of active memory", async () => {
    const store = seededStore();
    const workItem = await routeSourceToWork(store);

    await executeWorkItem({
      persistence: store,
      policies: createPolicies({
        persistence: store,
        memoryModel: modelWithValidMemory(),
        memoryVerifierModel: {
          async verifyMemoryCandidates() {
            throw new Error("verifier timed out");
          },
        },
        newId: deterministicId(),
      }),
      workItemId: workItem.id,
      newId: deterministicId(),
    });

    const proposal = [...store.proposedEvents.values()][0];
    expect(proposal?.requiresHumanApproval).toBe(true);
    expect(proposal?.reviewStatus).toBe("pending");
    expect(store.committedMemory).toHaveLength(0);
    expect(store.pendingWorkItems.get(workItem.id)?.status).toBe("completed");
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

function longEvidenceSpans(count: number, charsPerSpan: number) {
  let offset = 0;
  return Array.from({ length: count }, (_, index) => {
    const text = `Section ${index + 1} ${"x".repeat(charsPerSpan - 12)}`;
    const span = {
      id: `long_${index + 1}`, sourceVersionId: "srcv_long", startLine: index + 1, endLine: index + 1,
      startChar: offset, endChar: offset + text.length, text,
    };
    offset += text.length + 1;
    return span;
  });
}

class OrderedLoopPersistence extends InMemoryLoopPersistence {
  readonly calls: string[] = [];

  override async completePolicyRun(
    id: string,
    input: Parameters<InMemoryLoopPersistence["completePolicyRun"]>[1],
  ): Promise<void> {
    this.calls.push("completePolicyRun");
    await super.completePolicyRun(id, input);
  }

  override async completePendingWork(id: string): Promise<void> {
    this.calls.push("completePendingWork");
    await super.completePendingWork(id);
  }
}

async function commitSourceNumber(
  store: InMemoryLoopPersistence,
  index: number,
  actorLabel = "Angela",
) {
  return store.commitLedgerEventWithOutbox({
    id: `levt_source_${index}`,
    tenantId: "stable",
    eventType: "source_committed",
    subjectType: "source",
    subjectId: `srcv_${index}`,
    actorType: "human",
    actorLabel,
    inputVersion: `srcv_${index}`,
    idempotencyKey: `source_committed:ing_${index}`,
    payload: { ingestionId: `ing_${index}`, sourceVersionId: `srcv_${index}` },
  });
}

async function enqueueExtractWork(store: InMemoryLoopPersistence, suffix: string) {
  const event = await store.commitLedgerEventWithOutbox({
    id: `levt_${suffix}`,
    tenantId: "stable",
    eventType: "source_committed",
    subjectType: "source",
    subjectId: `srcv_${suffix}`,
    actorType: "human",
    actorLabel: "Angela",
    inputVersion: `srcv_${suffix}`,
    idempotencyKey: `source_committed:${suffix}`,
    payload: { ingestionId: `ing_${suffix}`, sourceVersionId: `srcv_${suffix}` },
  });
  const outbox = [...store.eventOutboxRows.values()].find((row) => row.ledgerEventId === event.id);
  if (!outbox) throw new Error("expected outbox");
  outbox.status = "processed";
  outbox.processedAt = new Date(0).toISOString();
  const result = await store.enqueuePendingWork({
    tenantId: "stable",
    policy: "extract_memory",
    subjectType: "source",
    subjectId: `srcv_${suffix}`,
    causedByEventId: event.id,
    inputVersion: `srcv_${suffix}`,
  });
  return result.workItem;
}

function policyRunFor(work: PendingWorkItem, id: string): Omit<PolicyRun, "createdAt"> & { createdAt: string } {
  return {
    id,
    tenantId: work.tenantId,
    workItemId: work.id,
    causedByEventId: work.causedByEventId,
    policyName: work.policy,
    policyVersion: "test-v1",
    status: "running",
    inputVersion: work.inputVersion,
    inputHash: `hash_${id}`,
    inputSummary: {},
    fallbackUsed: false,
    validationIssues: [],
    retryCount: Math.max(0, work.attempts - 1),
    leaseToken: work.leaseToken,
    leaseExpiresAt: work.leaseExpiresAt,
    startedAt: "2026-07-15T12:00:00.000Z",
    createdAt: "2026-07-15T12:00:00.000Z",
  };
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

async function routeSynthesisReadyWork(store: InMemoryLoopPersistence, suffix: string) {
  const memory = connectedMemoryContext();
  store.seedMemorySynthesisContext(memory);
  const cluster = discoverCorpusSynthesisClusters({ tenantId: "stable", memory })
    .find((candidate) => candidate.meaningKey === "entity:api launch");
  if (!cluster) throw new Error("expected corpus cluster");
  store.synthesisClusters.set(cluster.id, cluster);
  await store.commitLedgerEventWithOutbox({
    id: `levt_ready_${suffix}`,
    tenantId: "stable",
    eventType: "synthesis_ready",
    subjectType: "cluster",
    subjectId: cluster.id,
    actorType: "policy",
    inputVersion: cluster.version,
    idempotencyKey: `ready:${cluster.id}:${cluster.version}:${suffix}`,
    payload: { clusterId: cluster.id, clusterVersion: cluster.version, generationIntent: `initiative_brief_${suffix}` },
  });
  const work = await routeCommittedEvents({ persistence: store });
  const synthesizeWork = work.find((item) => item.policy === "synthesize_brief");
  if (!synthesizeWork) throw new Error("expected synthesize_brief work");
  return synthesizeWork;
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

function slackContextBundle() {
  const selectedText = "StablePay checkout failures started immediately after release 2.7.0.";
  const replyText = "Morpho timeouts were also observed during the checkout incident.";
  return {
    id: "sctx_1",
    connectorSaveId: "csave_1",
    previousBundleId: null,
    version: 1,
    tenantId: "stable",
    workspaceId: "T12345678",
    channelId: "C12345678",
    selectedMessageTimestamp: "1752624000.000001",
    threadTimestamp: "1752624000.000001",
    channelProfile: {
      workspaceId: "T12345678", channelId: "C12345678", channelName: "incident-room",
      topic: "StablePay incidents", purpose: "Coordinate recovery", isPublic: true, isPrivate: false,
      externallyShared: false, slackConnect: false, externalTeamIds: [], capturedAt: "2026-07-16T12:00:00.000Z",
    },
    selectionStrategy: "thread" as const,
    selectionVersion: "slack-context-v1",
    contentHash: "a".repeat(64),
    capturedAt: "2026-07-16T12:00:00.000Z",
    externallyShared: false,
    truncation: {
      truncated: false, messageLimitApplied: false, characterLimitApplied: false,
      originalMessageCount: 2, retainedMessageCount: 2,
      originalCharacterCount: selectedText.length + replyText.length,
      retainedCharacterCount: selectedText.length + replyText.length,
      omittedMessageTimestamps: [],
    },
    classification: {
      category: "incident" as const,
      rationale: "The thread describes a checkout incident and possible causes.",
      identities: {
        products: ["StablePay"], featureComponents: ["Checkout"], externalServices: ["Morpho"],
        issueTicketIds: [], releaseVersions: ["2.7.0"], environments: ["production"], namedOrganizations: [],
      },
    },
    skippedAttachments: [],
    selectedIngestionId: "ing_selected",
    selectedSourceVersionId: "srcv_selected",
    items: [
      {
        id: "sctxi_profile", ordinal: 0, role: "channel_profile" as const,
        sourceItemId: "src_profile", sourceVersionId: "srcv_profile",
        externalId: "slack_channel:T12345678:C12345678", selectionReason: "Channel metadata", primary: false,
        authorId: null, authorLabel: "Slack channel profile", occurredAt: "2026-07-16T12:00:00.000Z",
        permalink: "https://example.slack.com/archives/C12345678", content: "StablePay incident room",
        sourceMetadata: {}, evidenceSpans: [],
      },
      {
        id: "sctxi_selected", ordinal: 1, role: "selected_message" as const,
        sourceItemId: "src_selected", sourceVersionId: "srcv_selected",
        externalId: "slack_message:T12345678:C12345678:1752624000.000001", selectionReason: "Invoked message", primary: true,
        authorId: "U12345678", authorLabel: "Ada", occurredAt: "2026-07-16T12:00:00.000Z",
        permalink: "https://example.slack.com/archives/C12345678/p1752624000000001", content: selectedText,
        sourceMetadata: { messageTimestamp: "1752624000.000001" },
        evidenceSpans: [{
          id: "ev_selected", sourceVersionId: "srcv_selected", startLine: 1, endLine: 1,
          startChar: 0, endChar: selectedText.length, text: selectedText,
          locator: { provider: "slack", messageTimestamp: "1752624000.000001" },
        }],
      },
      {
        id: "sctxi_reply", ordinal: 2, role: "thread_reply" as const,
        sourceItemId: "src_reply", sourceVersionId: "srcv_reply",
        externalId: "slack_message:T12345678:C12345678:1752624000.000002", selectionReason: "Thread reply", primary: false,
        authorId: "U87654321", authorLabel: "Grace", occurredAt: "2026-07-16T12:01:00.000Z",
        permalink: "https://example.slack.com/archives/C12345678/p1752624000000002", content: replyText,
        sourceMetadata: { messageTimestamp: "1752624000.000002" },
        evidenceSpans: [{
          id: "ev_reply", sourceVersionId: "srcv_reply", startLine: 1, endLine: 1,
          startChar: 0, endChar: replyText.length, text: replyText,
          locator: { provider: "slack", messageTimestamp: "1752624000.000002" },
        }],
      },
    ],
    createdAt: "2026-07-16T12:00:00.000Z",
  };
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
          scope: "Developer documentation readiness for the API launch.",
          successMetric: "Docs owner and launch readiness criteria are agreed before API launch.",
          risksAndDependencies: "Depends on product and docs owners.",
          contradictionsOrUncertainties: [],
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

function memoryCandidate(temporaryId: string, statement: string) {
  return {
    temporaryId,
    claimType: "dependency" as const,
    statement,
    evidenceSpanIds: ["ev_1"],
    epistemicStatus: "reported" as const,
    qualifiers: {},
    stableDomainTags: ["docs"],
    entities: [{ name: "API launch", entityType: "initiative" }],
    relations: [],
    schemas: [],
  };
}

class StaticMemoryVerifier implements MemoryCandidateVerifierModel {
  constructor(private readonly decisions: Record<string, {
    decision: "verified" | "needs_review" | "corrected" | "duplicate" | "unsupported";
    rationale: string;
    correctedItem?: ReturnType<typeof memoryCandidate>;
  }>) {}

  async verifyMemoryCandidates() {
    return {
      model: "static-verifier",
      raw: this.decisions,
      decisions: Object.entries(this.decisions).map(([temporaryId, decision]) => ({
        temporaryId,
        ...decision,
      })),
    };
  }
}

class StaticConnectionScorer implements MemoryConnectionScorerModel {
  async scoreMemoryConnections() {
    return {
      model: "static-connection-scorer",
      raw: { ok: true },
      decisions: [{
        candidateId: "ccand:mem_1:mem_2",
        tier: "direct" as const,
        connectionType: "depends_on",
        connectionReason: "explicit_dependency",
        confidence: 0.88,
        rationale: "Docs dependency directly affects launch risk.",
        evidenceSpanIds: ["ev_1", "ev_2"],
        reviewRequired: false,
      }],
    };
  }
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
