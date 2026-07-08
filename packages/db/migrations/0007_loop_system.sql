-- Canonical evidence-to-decision loop ledger. Queue messages are wakeups only;
-- PostgreSQL owns committed events, outbox state, pending work, policy runs,
-- and proposed events.

create extension if not exists pgcrypto;

create table if not exists ledger_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  event_type text not null,
  subject_type text not null,
  subject_id text not null,
  actor_type text not null,
  actor_label text,
  caused_by_event_id text references ledger_events(id),
  caused_by_work_item_id text,
  input_version text,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (actor_type in ('human', 'policy', 'router', 'system', 'connector')),
  check (subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system')),
  check (event_type in (
    'source_committed',
    'memory_committed',
    'memory_confirmed',
    'memory_edited',
    'memory_removed',
    'candidate_created',
    'candidate_approved',
    'candidate_rejected',
    'artifact_drafted',
    'artifact_approved',
    'artifact_rejected',
    'artifact_delivered',
    'decision_committed',
    'freshness_warning_committed',
    'contradiction_recorded',
    'policy_run_recorded'
  ))
);

create index if not exists ledger_events_tenant_created_idx on ledger_events(tenant_id, created_at desc);
create index if not exists ledger_events_tenant_type_created_idx on ledger_events(tenant_id, event_type, created_at desc);
create index if not exists ledger_events_subject_created_idx on ledger_events(tenant_id, subject_type, subject_id, created_at desc);

create table if not exists event_outbox (
  id text primary key,
  tenant_id text not null references tenants(id),
  ledger_event_id text not null references ledger_events(id),
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_event_id),
  check (status in ('pending', 'processing', 'processed', 'failed'))
);

create index if not exists event_outbox_status_created_idx on event_outbox(status, created_at);
create index if not exists event_outbox_tenant_status_created_idx on event_outbox(tenant_id, status, created_at);

create table if not exists pending_work (
  id text primary key,
  tenant_id text not null references tenants(id),
  policy text not null,
  subject_type text not null,
  subject_id text not null,
  caused_by_event_id text not null references ledger_events(id),
  input_version text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, policy, subject_type, subject_id, caused_by_event_id),
  unique (tenant_id, policy, subject_type, subject_id, input_version),
  check (policy in (
    'extract_memory',
    'discover_candidate',
    'check_freshness',
    'detect_contradiction',
    'rank_candidate',
    'draft_artifact',
    'gate_output',
    'revise_artifact'
  )),
  check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  check (subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system'))
);

create index if not exists pending_work_status_created_idx on pending_work(status, created_at);
create index if not exists pending_work_tenant_status_created_idx on pending_work(tenant_id, status, created_at);
create index if not exists pending_work_subject_created_idx on pending_work(tenant_id, subject_type, subject_id, created_at desc);

create table if not exists policy_runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  work_item_id text not null references pending_work(id),
  caused_by_event_id text references ledger_events(id),
  policy_name text not null,
  policy_version text not null,
  status text not null,
  input_version text not null,
  input_hash text not null,
  input_summary jsonb not null default '{}'::jsonb,
  provider text,
  model text,
  fallback_used boolean not null default false,
  fallback_reason text,
  prompt_version text,
  schema_version text,
  output_schema_version text,
  validation_ok boolean,
  validation_issues jsonb not null default '[]'::jsonb,
  failure_reason text,
  retry_count integer not null default 0,
  raw_response_hash text,
  raw_response_ref text,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  estimated_cost_usd numeric,
  started_at timestamptz not null,
  completed_at timestamptz,
  latency_ms integer,
  created_at timestamptz not null default now(),
  check (status in ('running', 'completed', 'failed', 'cancelled'))
);

create index if not exists policy_runs_work_item_created_idx on policy_runs(tenant_id, work_item_id, created_at desc);
create index if not exists policy_runs_policy_created_idx on policy_runs(tenant_id, policy_name, created_at desc);
create index if not exists policy_runs_status_created_idx on policy_runs(tenant_id, status, created_at desc);

create table if not exists proposed_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  work_item_id text references pending_work(id),
  policy_run_id text references policy_runs(id),
  proposed_event_type text not null,
  target_event_type text not null,
  subject_type text not null,
  subject_id text not null,
  payload jsonb not null,
  evidence_span_ids jsonb not null default '[]'::jsonb,
  memory_item_ids jsonb not null default '[]'::jsonb,
  decision_ids jsonb not null default '[]'::jsonb,
  requires_human_approval boolean not null,
  validation_status text not null default 'pending',
  validation_issues jsonb not null default '[]'::jsonb,
  review_status text not null default 'not_required',
  reviewer_label text,
  review_rationale text,
  committed_ledger_event_id text references ledger_events(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system')),
  check (validation_status in ('pending', 'valid', 'invalid')),
  check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  check (proposed_event_type in (
    'memory_proposed',
    'candidate_proposed',
    'artifact_draft_proposed',
    'freshness_warning_proposed',
    'contradiction_proposed',
    'decision_record_proposed'
  )),
  check (target_event_type in (
    'source_committed',
    'memory_committed',
    'memory_confirmed',
    'memory_edited',
    'memory_removed',
    'candidate_created',
    'candidate_approved',
    'candidate_rejected',
    'artifact_drafted',
    'artifact_approved',
    'artifact_rejected',
    'artifact_delivered',
    'decision_committed',
    'freshness_warning_committed',
    'contradiction_recorded',
    'policy_run_recorded'
  ))
);

create index if not exists proposed_events_validation_created_idx on proposed_events(tenant_id, validation_status, created_at);
create index if not exists proposed_events_review_created_idx on proposed_events(tenant_id, review_status, created_at);
create index if not exists proposed_events_subject_created_idx on proposed_events(tenant_id, subject_type, subject_id, created_at desc);

create or replace function distillery_ledger_event_to_json(p_event ledger_events)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_event.id,
    'tenantId', p_event.tenant_id,
    'eventType', p_event.event_type,
    'subjectType', p_event.subject_type,
    'subjectId', p_event.subject_id,
    'actorType', p_event.actor_type,
    'actorLabel', p_event.actor_label,
    'causedByEventId', p_event.caused_by_event_id,
    'causedByWorkItemId', p_event.caused_by_work_item_id,
    'inputVersion', p_event.input_version,
    'idempotencyKey', p_event.idempotency_key,
    'payload', p_event.payload,
    'createdAt', p_event.created_at
  );
$$;

create or replace function distillery_event_outbox_to_json(p_row event_outbox)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'tenantId', p_row.tenant_id,
    'ledgerEventId', p_row.ledger_event_id,
    'status', p_row.status,
    'attempts', p_row.attempts,
    'lastError', p_row.last_error,
    'lockedAt', p_row.locked_at,
    'processedAt', p_row.processed_at,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at
  );
$$;

create or replace function distillery_pending_work_to_json(p_row pending_work)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'tenantId', p_row.tenant_id,
    'policy', p_row.policy,
    'subjectType', p_row.subject_type,
    'subjectId', p_row.subject_id,
    'causedByEventId', p_row.caused_by_event_id,
    'inputVersion', p_row.input_version,
    'status', p_row.status,
    'attempts', p_row.attempts,
    'lastError', p_row.last_error,
    'lockedAt', p_row.locked_at,
    'startedAt', p_row.started_at,
    'completedAt', p_row.completed_at,
    'cancelledAt', p_row.cancelled_at,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at
  );
$$;

create or replace function distillery_policy_run_to_json(p_row policy_runs)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'tenantId', p_row.tenant_id,
    'workItemId', p_row.work_item_id,
    'causedByEventId', p_row.caused_by_event_id,
    'policyName', p_row.policy_name,
    'policyVersion', p_row.policy_version,
    'status', p_row.status,
    'inputVersion', p_row.input_version,
    'inputHash', p_row.input_hash,
    'inputSummary', p_row.input_summary,
    'provider', p_row.provider,
    'model', p_row.model,
    'fallbackUsed', p_row.fallback_used,
    'fallbackReason', p_row.fallback_reason,
    'promptVersion', p_row.prompt_version,
    'schemaVersion', p_row.schema_version,
    'outputSchemaVersion', p_row.output_schema_version,
    'validationOk', p_row.validation_ok,
    'validationIssues', p_row.validation_issues,
    'failureReason', p_row.failure_reason,
    'retryCount', p_row.retry_count,
    'rawResponseHash', p_row.raw_response_hash,
    'rawResponseRef', p_row.raw_response_ref,
    'promptTokens', p_row.prompt_tokens,
    'completionTokens', p_row.completion_tokens,
    'totalTokens', p_row.total_tokens,
    'estimatedCostUsd', p_row.estimated_cost_usd,
    'startedAt', p_row.started_at,
    'completedAt', p_row.completed_at,
    'latencyMs', p_row.latency_ms,
    'createdAt', p_row.created_at
  );
$$;

create or replace function distillery_proposed_event_to_json(p_row proposed_events)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'tenantId', p_row.tenant_id,
    'workItemId', p_row.work_item_id,
    'policyRunId', p_row.policy_run_id,
    'proposedEventType', p_row.proposed_event_type,
    'targetEventType', p_row.target_event_type,
    'subjectType', p_row.subject_type,
    'subjectId', p_row.subject_id,
    'payload', p_row.payload,
    'evidenceSpanIds', p_row.evidence_span_ids,
    'memoryItemIds', p_row.memory_item_ids,
    'decisionIds', p_row.decision_ids,
    'requiresHumanApproval', p_row.requires_human_approval,
    'validationStatus', p_row.validation_status,
    'validationIssues', p_row.validation_issues,
    'reviewStatus', p_row.review_status,
    'reviewerLabel', p_row.reviewer_label,
    'reviewRationale', p_row.review_rationale,
    'committedLedgerEventId', p_row.committed_ledger_event_id,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at
  );
$$;

create or replace function distillery_commit_ledger_event_with_outbox(p_event jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  row ledger_events%rowtype;
begin
  insert into ledger_events(
    id,
    tenant_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_label,
    caused_by_event_id,
    caused_by_work_item_id,
    input_version,
    idempotency_key,
    payload,
    created_at
  )
  values (
    p_event->>'id',
    p_event->>'tenantId',
    p_event->>'eventType',
    p_event->>'subjectType',
    p_event->>'subjectId',
    p_event->>'actorType',
    p_event->>'actorLabel',
    nullif(p_event->>'causedByEventId', ''),
    nullif(p_event->>'causedByWorkItemId', ''),
    nullif(p_event->>'inputVersion', ''),
    p_event->>'idempotencyKey',
    coalesce(p_event->'payload', '{}'::jsonb),
    coalesce((p_event->>'createdAt')::timestamptz, now())
  )
  on conflict (tenant_id, idempotency_key) do update
  set idempotency_key = excluded.idempotency_key
  returning * into row;

  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, row.tenant_id, row.id)
  on conflict (ledger_event_id) do nothing;

  return distillery_ledger_event_to_json(row);
end;
$$;

create or replace function distillery_get_ledger_event(p_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  row ledger_events%rowtype;
begin
  select * into row from ledger_events where id = p_id;
  if row.id is null then
    return null;
  end if;
  return distillery_ledger_event_to_json(row);
end;
$$;

create or replace function distillery_claim_event_outbox_row()
returns jsonb
language plpgsql
security definer
as $$
declare
  row event_outbox%rowtype;
begin
  select * into row
  from event_outbox
  where status = 'pending'
  order by created_at
  for update skip locked
  limit 1;

  if row.id is null then
    return null;
  end if;

  update event_outbox
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      updated_at = now()
  where id = row.id
  returning * into row;

  return distillery_event_outbox_to_json(row);
end;
$$;

create or replace function distillery_mark_event_outbox_processed(p_id text)
returns void
language plpgsql
security definer
as $$
begin
  update event_outbox
  set status = 'processed',
      processed_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_mark_event_outbox_failed(p_id text, p_error text)
returns void
language plpgsql
security definer
as $$
begin
  update event_outbox
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      last_error = p_error,
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_enqueue_pending_work(
  p_tenant_id text,
  p_policy text,
  p_subject_type text,
  p_subject_id text,
  p_caused_by_event_id text,
  p_input_version text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row pending_work%rowtype;
  inserted boolean := false;
begin
  insert into pending_work(
    id,
    tenant_id,
    policy,
    subject_type,
    subject_id,
    caused_by_event_id,
    input_version
  )
  values (
    'work_' || gen_random_uuid()::text,
    p_tenant_id,
    p_policy,
    p_subject_type,
    p_subject_id,
    p_caused_by_event_id,
    p_input_version
  )
  on conflict do nothing
  returning * into row;

  if row.id is not null then
    inserted := true;
  else
    select * into row
    from pending_work
    where tenant_id = p_tenant_id
      and policy = p_policy
      and subject_type = p_subject_type
      and subject_id = p_subject_id
      and (
        caused_by_event_id = p_caused_by_event_id
        or input_version = p_input_version
      )
    limit 1;
  end if;

  return jsonb_build_object('workItem', distillery_pending_work_to_json(row), 'inserted', inserted);
end;
$$;

create or replace function distillery_claim_pending_work(p_work_item_id text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  row pending_work%rowtype;
begin
  select * into row
  from pending_work
  where status = 'pending'
    and (p_work_item_id is null or id = p_work_item_id)
  order by created_at
  for update skip locked
  limit 1;

  if row.id is null then
    return null;
  end if;

  update pending_work
  set status = 'running',
      attempts = attempts + 1,
      started_at = now(),
      locked_at = now(),
      updated_at = now()
  where id = row.id
  returning * into row;

  return distillery_pending_work_to_json(row);
end;
$$;

create or replace function distillery_complete_pending_work(p_id text)
returns void
language plpgsql
security definer
as $$
begin
  update pending_work
  set status = 'completed',
      completed_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_fail_pending_work(p_id text, p_error text)
returns void
language plpgsql
security definer
as $$
begin
  update pending_work
  set status = 'failed',
      last_error = p_error,
      completed_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_cancel_pending_work(p_id text, p_reason text)
returns void
language plpgsql
security definer
as $$
begin
  update pending_work
  set status = 'cancelled',
      last_error = p_reason,
      cancelled_at = now(),
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_create_policy_run(p_policy_run jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  row policy_runs%rowtype;
begin
  insert into policy_runs(
    id,
    tenant_id,
    work_item_id,
    caused_by_event_id,
    policy_name,
    policy_version,
    status,
    input_version,
    input_hash,
    input_summary,
    provider,
    model,
    fallback_used,
    fallback_reason,
    prompt_version,
    schema_version,
    output_schema_version,
    validation_ok,
    validation_issues,
    failure_reason,
    retry_count,
    raw_response_hash,
    raw_response_ref,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    estimated_cost_usd,
    started_at,
    completed_at,
    latency_ms,
    created_at
  )
  values (
    p_policy_run->>'id',
    p_policy_run->>'tenantId',
    p_policy_run->>'workItemId',
    nullif(p_policy_run->>'causedByEventId', ''),
    p_policy_run->>'policyName',
    p_policy_run->>'policyVersion',
    p_policy_run->>'status',
    p_policy_run->>'inputVersion',
    p_policy_run->>'inputHash',
    coalesce(p_policy_run->'inputSummary', '{}'::jsonb),
    p_policy_run->>'provider',
    p_policy_run->>'model',
    coalesce((p_policy_run->>'fallbackUsed')::boolean, false),
    p_policy_run->>'fallbackReason',
    p_policy_run->>'promptVersion',
    p_policy_run->>'schemaVersion',
    p_policy_run->>'outputSchemaVersion',
    nullif(p_policy_run->>'validationOk', '')::boolean,
    coalesce(p_policy_run->'validationIssues', '[]'::jsonb),
    p_policy_run->>'failureReason',
    coalesce((p_policy_run->>'retryCount')::integer, 0),
    p_policy_run->>'rawResponseHash',
    p_policy_run->>'rawResponseRef',
    nullif(p_policy_run->>'promptTokens', '')::integer,
    nullif(p_policy_run->>'completionTokens', '')::integer,
    nullif(p_policy_run->>'totalTokens', '')::integer,
    nullif(p_policy_run->>'estimatedCostUsd', '')::numeric,
    (p_policy_run->>'startedAt')::timestamptz,
    nullif(p_policy_run->>'completedAt', '')::timestamptz,
    nullif(p_policy_run->>'latencyMs', '')::integer,
    coalesce((p_policy_run->>'createdAt')::timestamptz, now())
  )
  returning * into row;

  return distillery_policy_run_to_json(row);
end;
$$;

create or replace function distillery_complete_policy_run(p_id text, p_patch jsonb)
returns void
language plpgsql
security definer
as $$
begin
  update policy_runs
  set status = 'completed',
      provider = coalesce(p_patch->>'provider', provider),
      model = coalesce(p_patch->>'model', model),
      fallback_used = coalesce((p_patch->>'fallbackUsed')::boolean, fallback_used),
      fallback_reason = coalesce(p_patch->>'fallbackReason', fallback_reason),
      prompt_version = coalesce(p_patch->>'promptVersion', prompt_version),
      schema_version = coalesce(p_patch->>'schemaVersion', schema_version),
      output_schema_version = coalesce(p_patch->>'outputSchemaVersion', output_schema_version),
      validation_ok = coalesce((p_patch->>'validationOk')::boolean, validation_ok),
      validation_issues = coalesce(p_patch->'validationIssues', validation_issues),
      raw_response_hash = coalesce(p_patch->>'rawResponseHash', raw_response_hash),
      raw_response_ref = coalesce(p_patch->>'rawResponseRef', raw_response_ref),
      prompt_tokens = coalesce(nullif(p_patch->>'promptTokens', '')::integer, prompt_tokens),
      completion_tokens = coalesce(nullif(p_patch->>'completionTokens', '')::integer, completion_tokens),
      total_tokens = coalesce(nullif(p_patch->>'totalTokens', '')::integer, total_tokens),
      estimated_cost_usd = coalesce(nullif(p_patch->>'estimatedCostUsd', '')::numeric, estimated_cost_usd),
      completed_at = coalesce((p_patch->>'completedAt')::timestamptz, now()),
      latency_ms = coalesce(nullif(p_patch->>'latencyMs', '')::integer, latency_ms)
  where id = p_id;
end;
$$;

create or replace function distillery_fail_policy_run(p_id text, p_error text, p_issues jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
as $$
begin
  update policy_runs
  set status = 'failed',
      failure_reason = p_error,
      validation_ok = false,
      validation_issues = p_issues,
      completed_at = now(),
      latency_ms = greatest(0, floor(extract(epoch from (now() - started_at)) * 1000)::integer)
  where id = p_id;
end;
$$;

create or replace function distillery_create_proposed_event(p_proposed_event jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  row proposed_events%rowtype;
begin
  insert into proposed_events(
    id,
    tenant_id,
    work_item_id,
    policy_run_id,
    proposed_event_type,
    target_event_type,
    subject_type,
    subject_id,
    payload,
    evidence_span_ids,
    memory_item_ids,
    decision_ids,
    requires_human_approval,
    review_status,
    reviewer_label,
    review_rationale
  )
  values (
    p_proposed_event->>'id',
    p_proposed_event->>'tenantId',
    nullif(p_proposed_event->>'workItemId', ''),
    nullif(p_proposed_event->>'policyRunId', ''),
    p_proposed_event->>'proposedEventType',
    p_proposed_event->>'targetEventType',
    p_proposed_event->>'subjectType',
    p_proposed_event->>'subjectId',
    p_proposed_event->'payload',
    coalesce(p_proposed_event->'evidenceSpanIds', '[]'::jsonb),
    coalesce(p_proposed_event->'memoryItemIds', '[]'::jsonb),
    coalesce(p_proposed_event->'decisionIds', '[]'::jsonb),
    (p_proposed_event->>'requiresHumanApproval')::boolean,
    case when (p_proposed_event->>'requiresHumanApproval')::boolean then 'pending' else 'not_required' end,
    p_proposed_event->>'reviewerLabel',
    p_proposed_event->>'reviewRationale'
  )
  returning * into row;

  return distillery_proposed_event_to_json(row);
end;
$$;

create or replace function distillery_mark_proposed_event_valid(p_id text)
returns void
language plpgsql
security definer
as $$
begin
  update proposed_events
  set validation_status = 'valid',
      validation_issues = '[]'::jsonb,
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_mark_proposed_event_invalid(p_id text, p_issues jsonb)
returns void
language plpgsql
security definer
as $$
begin
  update proposed_events
  set validation_status = 'invalid',
      validation_issues = p_issues,
      updated_at = now()
  where id = p_id;
end;
$$;

create or replace function distillery_approve_proposed_event(p_id text, p_reviewer_label text, p_rationale text)
returns jsonb
language plpgsql
security definer
as $$
declare
  row proposed_events%rowtype;
begin
  update proposed_events
  set review_status = 'approved',
      reviewer_label = p_reviewer_label,
      review_rationale = p_rationale,
      updated_at = now()
  where id = p_id
  returning * into row;

  return distillery_proposed_event_to_json(row);
end;
$$;

create or replace function distillery_reject_proposed_event(p_id text, p_reviewer_label text, p_rationale text)
returns jsonb
language plpgsql
security definer
as $$
declare
  row proposed_events%rowtype;
begin
  update proposed_events
  set review_status = 'rejected',
      reviewer_label = p_reviewer_label,
      review_rationale = p_rationale,
      updated_at = now()
  where id = p_id
  returning * into row;

  return distillery_proposed_event_to_json(row);
end;
$$;

create or replace function distillery_commit_validated_proposed_event(p_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  proposal proposed_events%rowtype;
  row ledger_events%rowtype;
begin
  select * into proposal
  from proposed_events
  where id = p_id
  for update;

  if proposal.id is null then
    raise exception 'proposed event not found: %', p_id;
  end if;

  if proposal.validation_status <> 'valid' then
    raise exception 'invalid proposal cannot commit: %', p_id;
  end if;

  if proposal.requires_human_approval and proposal.review_status <> 'approved' then
    raise exception 'proposal requires human approval: %', p_id;
  end if;

  if proposal.committed_ledger_event_id is not null then
    select * into row from ledger_events where id = proposal.committed_ledger_event_id;
    return distillery_ledger_event_to_json(row);
  end if;

  if proposal.target_event_type = 'memory_committed' then
    perform distillery_commit_generated_memory(
      proposal.payload->>'ingestionId',
      proposal.tenant_id,
      proposal.payload->>'sourceVersionId',
      proposal.payload->>'extractionRunId',
      proposal.payload->>'memoryGenerationVersion',
      proposal.payload->'items'
    );
  end if;

  insert into ledger_events(
    id,
    tenant_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_label,
    caused_by_work_item_id,
    input_version,
    idempotency_key,
    payload
  )
  values (
    'levt_' || gen_random_uuid()::text,
    proposal.tenant_id,
    proposal.target_event_type,
    proposal.subject_type,
    proposal.subject_id,
    'policy',
    coalesce(proposal.policy_run_id, proposal.work_item_id),
    proposal.work_item_id,
    coalesce(proposal.policy_run_id, proposal.id),
    'proposal:' || proposal.id,
    proposal.payload
  )
  on conflict (tenant_id, idempotency_key) do update
  set idempotency_key = excluded.idempotency_key
  returning * into row;

  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, row.tenant_id, row.id)
  on conflict (ledger_event_id) do nothing;

  update proposed_events
  set committed_ledger_event_id = row.id,
      updated_at = now()
  where id = proposal.id;

  return distillery_ledger_event_to_json(row);
end;
$$;

create or replace function distillery_get_ingestion_context_by_source_version(p_source_version_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'ingestionId', i.id,
    'tenantId', i.tenant_id,
    'sourceVersionId', sv.id,
    'evidenceSpans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', es.id,
        'sourceVersionId', es.source_version_id,
        'startLine', es.start_line,
        'endLine', es.end_line,
        'startChar', es.start_char,
        'endChar', es.end_char,
        'text', es.text
      ) order by es.start_line, es.start_char)
      from evidence_spans es
      where es.source_version_id = sv.id
    ), '[]'::jsonb)
  )
  into result
  from source_versions sv
  join ingestions i on i.id = sv.ingestion_id
  where sv.id = p_source_version_id;

  if result is null then
    raise exception 'ingestion context not found for source version: %', p_source_version_id;
  end if;

  return result;
end;
$$;

create or replace function distillery_create_text_ingestion_with_evidence(
  p_tenant_id text,
  p_ingestion_id text,
  p_source_item_id text,
  p_source_version_id text,
  p_idempotency_key text,
  p_app_session_id text,
  p_submitted_by_label text,
  p_content text,
  p_content_hash text,
  p_evidence_spans jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  existing_ingestion_id text;
  span jsonb;
  source_event ledger_events%rowtype;
begin
  insert into tenants(id, name)
  values (p_tenant_id, initcap(p_tenant_id))
  on conflict (id) do nothing;

  insert into app_sessions(id, tenant_id)
  values (p_app_session_id, p_tenant_id)
  on conflict (id) do nothing;

  select id into existing_ingestion_id
  from ingestions
  where tenant_id = p_tenant_id
    and idempotency_key = p_idempotency_key;

  if existing_ingestion_id is not null then
    return distillery_get_ingestion_result(existing_ingestion_id);
  end if;

  insert into ingestions(
    id,
    tenant_id,
    app_session_id,
    submitted_by_label,
    input_type,
    idempotency_key,
    status
  )
  values (
    p_ingestion_id,
    p_tenant_id,
    p_app_session_id,
    p_submitted_by_label,
    'text',
    p_idempotency_key,
    'evidence_stored'
  );

  insert into source_items(id, tenant_id, source_type, content_hash)
  values (p_source_item_id, p_tenant_id, 'text_braindump', p_content_hash);

  insert into source_versions(
    id,
    tenant_id,
    source_item_id,
    ingestion_id,
    version,
    content,
    content_hash
  )
  values (
    p_source_version_id,
    p_tenant_id,
    p_source_item_id,
    p_ingestion_id,
    1,
    p_content,
    p_content_hash
  );

  for span in select * from jsonb_array_elements(p_evidence_spans)
  loop
    insert into evidence_spans(
      id,
      tenant_id,
      source_version_id,
      start_line,
      end_line,
      start_char,
      end_char,
      text
    )
    values (
      span->>'id',
      p_tenant_id,
      p_source_version_id,
      (span->>'startLine')::integer,
      (span->>'endLine')::integer,
      (span->>'startChar')::integer,
      (span->>'endChar')::integer,
      span->>'text'
    );
  end loop;

  insert into ledger_events(
    id,
    tenant_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_label,
    input_version,
    idempotency_key,
    payload
  )
  values (
    'levt_' || gen_random_uuid()::text,
    p_tenant_id,
    'source_committed',
    'source',
    p_source_version_id,
    'human',
    p_submitted_by_label,
    p_source_version_id,
    'source_committed:' || p_idempotency_key,
    jsonb_build_object(
      'ingestionId', p_ingestion_id,
      'sourceItemId', p_source_item_id,
      'sourceVersionId', p_source_version_id,
      'contentHash', p_content_hash
    )
  )
  returning * into source_event;

  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, p_tenant_id, source_event.id)
  on conflict (ledger_event_id) do nothing;

  insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
  values (
    p_tenant_id,
    p_submitted_by_label,
    'ingestion.evidence_stored',
    'ingestion',
    p_ingestion_id,
    jsonb_build_object('sourceVersionId', p_source_version_id, 'ledgerEventId', source_event.id)
  );

  return distillery_get_ingestion_result(p_ingestion_id);
end;
$$;

notify pgrst, 'reload schema';
