-- Durable loop leases, stale-claim recovery, and non-actionable seed routing.

alter table event_outbox
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists recovery_count integer not null default 0,
  add column if not exists last_recovered_at timestamptz,
  add column if not exists resolution_reason text;

alter table pending_work
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists recovery_count integer not null default 0,
  add column if not exists last_recovered_at timestamptz;

alter table policy_runs
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists failure_kind text;

update event_outbox
set lease_token = coalesce(lease_token, gen_random_uuid()::text),
    lease_expires_at = coalesce(lease_expires_at, locked_at + interval '2 minutes')
where status = 'processing' and locked_at is not null;

update pending_work
set lease_token = coalesce(lease_token, gen_random_uuid()::text),
    lease_expires_at = coalesce(lease_expires_at, locked_at + interval '15 minutes')
where status = 'running' and locked_at is not null;

update policy_runs pr
set lease_token = pw.lease_token,
    lease_expires_at = pw.lease_expires_at
from pending_work pw
where pr.work_item_id = pw.id
  and pr.status = 'running'
  and pw.status = 'running';

create index if not exists event_outbox_processing_lease_idx
  on event_outbox(lease_expires_at)
  where status = 'processing';

create index if not exists pending_work_running_lease_idx
  on pending_work(lease_expires_at)
  where status = 'running';

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
    'leaseToken', p_row.lease_token,
    'leaseExpiresAt', p_row.lease_expires_at,
    'recoveryCount', p_row.recovery_count,
    'lastRecoveredAt', p_row.last_recovered_at,
    'resolutionReason', p_row.resolution_reason,
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
    'leaseToken', p_row.lease_token,
    'leaseExpiresAt', p_row.lease_expires_at,
    'recoveryCount', p_row.recovery_count,
    'lastRecoveredAt', p_row.last_recovered_at,
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
    'failureKind', p_row.failure_kind,
    'retryCount', p_row.retry_count,
    'leaseToken', p_row.lease_token,
    'leaseExpiresAt', p_row.lease_expires_at,
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

create or replace function distillery_create_text_ingestion_with_evidence_v2(
  p_tenant_id text,
  p_ingestion_id text,
  p_source_item_id text,
  p_source_version_id text,
  p_idempotency_key text,
  p_app_session_id text,
  p_submitted_by_label text,
  p_content text,
  p_content_hash text,
  p_evidence_spans jsonb,
  p_route_source boolean default true
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
  resolved_ingestion_id text;
begin
  if not p_route_source and not (
    p_submitted_by_label = 'Distillery seed data'
    and p_idempotency_key like 'seed:%'
  ) then
    raise exception 'non-actionable source routing is restricted to approved seed ingestion';
  end if;

  result := distillery_create_text_ingestion_with_evidence(
    p_tenant_id,
    p_ingestion_id,
    p_source_item_id,
    p_source_version_id,
    p_idempotency_key,
    p_app_session_id,
    p_submitted_by_label,
    p_content,
    p_content_hash,
    p_evidence_spans
  );

  if not p_route_source then
    resolved_ingestion_id := result->>'ingestionId';

    update event_outbox eo
    set status = 'processed',
        processed_at = coalesce(eo.processed_at, now()),
        resolution_reason = 'non_actionable_seed_source',
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    from ledger_events le
    where eo.ledger_event_id = le.id
      and le.event_type = 'source_committed'
      and le.payload->>'ingestionId' = resolved_ingestion_id
      and eo.status = 'pending';

    insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
    select p_tenant_id,
           p_submitted_by_label,
           'ingestion.source_routing_suppressed',
           'ingestion',
           resolved_ingestion_id,
           jsonb_build_object('reason', 'approved seed memory is committed directly')
    where not exists (
      select 1 from audit_events
      where tenant_id = p_tenant_id
        and action = 'ingestion.source_routing_suppressed'
        and entity_type = 'ingestion'
        and entity_id = resolved_ingestion_id
    );
  end if;

  return result;
end;
$$;

create or replace function distillery_claim_event_outbox_row(p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  row event_outbox%rowtype;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'outbox lease must be between 30 and 3600 seconds';
  end if;

  select * into row
  from event_outbox
  where status = 'pending'
  order by created_at
  for update skip locked
  limit 1;

  if row.id is null then return null; end if;

  update event_outbox
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      lease_token = gen_random_uuid()::text,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = row.id
  returning * into row;

  return distillery_event_outbox_to_json(row);
end;
$$;

create or replace function distillery_claim_event_outbox_row()
returns jsonb
language sql
security definer
as $$
  select distillery_claim_event_outbox_row(120);
$$;

create or replace function distillery_mark_event_outbox_processed(p_id text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
begin
  update event_outbox
  set status = 'processed',
      processed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and status = 'processing'
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create or replace function distillery_mark_event_outbox_failed(p_id text, p_error text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
begin
  update event_outbox
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      last_error = p_error,
      locked_at = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and status = 'processing'
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create or replace function distillery_claim_pending_work(p_work_item_id text, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  row pending_work%rowtype;
begin
  if p_lease_seconds < 120 or p_lease_seconds > 3600 then
    raise exception 'work lease must be between 120 and 3600 seconds';
  end if;

  select * into row
  from pending_work
  where status = 'pending'
    and (p_work_item_id is null or id = p_work_item_id)
  order by created_at
  for update skip locked
  limit 1;

  if row.id is null then return null; end if;

  update pending_work
  set status = 'running',
      attempts = attempts + 1,
      started_at = now(),
      locked_at = now(),
      lease_token = gen_random_uuid()::text,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = row.id
  returning * into row;

  return distillery_pending_work_to_json(row);
end;
$$;

create or replace function distillery_claim_pending_work(p_work_item_id text default null)
returns jsonb
language sql
security definer
as $$
  select distillery_claim_pending_work(p_work_item_id, 900);
$$;

create or replace function distillery_renew_pending_work_lease(
  p_id text,
  p_lease_token text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row pending_work%rowtype;
begin
  if p_lease_seconds < 120 or p_lease_seconds > 3600 then
    raise exception 'work lease must be between 120 and 3600 seconds';
  end if;

  update pending_work
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = p_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into row;

  if row.id is null then return null; end if;

  update policy_runs
  set lease_expires_at = row.lease_expires_at
  where work_item_id = row.id
    and status = 'running'
    and lease_token = p_lease_token;

  return distillery_pending_work_to_json(row);
end;
$$;

create or replace function distillery_complete_pending_work(p_id text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
begin
  update pending_work
  set status = 'completed',
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and status = 'running'
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create or replace function distillery_fail_pending_work(p_id text, p_error text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
begin
  update pending_work
  set status = 'failed',
      last_error = p_error,
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and status = 'running'
    and (p_lease_token is null or lease_token = p_lease_token);
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
    id, tenant_id, work_item_id, caused_by_event_id, policy_name, policy_version,
    status, input_version, input_hash, input_summary, provider, model,
    fallback_used, fallback_reason, prompt_version, schema_version,
    output_schema_version, validation_ok, validation_issues, failure_reason,
    failure_kind, retry_count, lease_token, lease_expires_at, raw_response_hash,
    raw_response_ref, prompt_tokens, completion_tokens, total_tokens,
    estimated_cost_usd, started_at, completed_at, latency_ms, created_at
  ) values (
    p_policy_run->>'id', p_policy_run->>'tenantId', p_policy_run->>'workItemId',
    nullif(p_policy_run->>'causedByEventId', ''), p_policy_run->>'policyName',
    p_policy_run->>'policyVersion', p_policy_run->>'status',
    p_policy_run->>'inputVersion', p_policy_run->>'inputHash',
    coalesce(p_policy_run->'inputSummary', '{}'::jsonb), p_policy_run->>'provider',
    p_policy_run->>'model', coalesce((p_policy_run->>'fallbackUsed')::boolean, false),
    p_policy_run->>'fallbackReason', p_policy_run->>'promptVersion',
    p_policy_run->>'schemaVersion', p_policy_run->>'outputSchemaVersion',
    nullif(p_policy_run->>'validationOk', '')::boolean,
    coalesce(p_policy_run->'validationIssues', '[]'::jsonb),
    p_policy_run->>'failureReason', p_policy_run->>'failureKind',
    coalesce((p_policy_run->>'retryCount')::integer, 0),
    p_policy_run->>'leaseToken', nullif(p_policy_run->>'leaseExpiresAt', '')::timestamptz,
    p_policy_run->>'rawResponseHash', p_policy_run->>'rawResponseRef',
    nullif(p_policy_run->>'promptTokens', '')::integer,
    nullif(p_policy_run->>'completionTokens', '')::integer,
    nullif(p_policy_run->>'totalTokens', '')::integer,
    nullif(p_policy_run->>'estimatedCostUsd', '')::numeric,
    (p_policy_run->>'startedAt')::timestamptz,
    nullif(p_policy_run->>'completedAt', '')::timestamptz,
    nullif(p_policy_run->>'latencyMs', '')::integer,
    coalesce((p_policy_run->>'createdAt')::timestamptz, now())
  ) returning * into row;

  return distillery_policy_run_to_json(row);
end;
$$;

create or replace function distillery_complete_policy_run(p_id text, p_patch jsonb, p_lease_token text)
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
      latency_ms = coalesce(nullif(p_patch->>'latencyMs', '')::integer, latency_ms),
      lease_expires_at = null
  where id = p_id
    and status = 'running'
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create or replace function distillery_fail_policy_run(
  p_id text,
  p_error text,
  p_issues jsonb,
  p_lease_token text
)
returns void
language plpgsql
security definer
as $$
begin
  update policy_runs
  set status = 'failed',
      failure_reason = p_error,
      failure_kind = coalesce(failure_kind, 'execution_failed'),
      validation_ok = false,
      validation_issues = coalesce(p_issues, '[]'::jsonb),
      completed_at = now(),
      latency_ms = greatest(0, floor(extract(epoch from (now() - started_at)) * 1000)::integer),
      lease_expires_at = null
  where id = p_id
    and status = 'running'
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create or replace function distillery_list_recovered_pending_work(
  p_tenant_id text default 'stable',
  p_limit integer default 25
)
returns jsonb
language sql
security definer
stable
as $$
  select coalesce(jsonb_agg(distillery_pending_work_to_json(selected.work_row) order by selected.updated_at), '[]'::jsonb)
  from (
    select pw as work_row, pw.updated_at
    from pending_work pw
    where pw.tenant_id = p_tenant_id
      and pw.status = 'pending'
      and pw.recovery_count > 0
    order by pw.updated_at
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  ) selected;
$$;

create or replace function distillery_recover_expired_loop_claims(
  p_tenant_id text default 'stable',
  p_now timestamptz default null,
  p_max_outbox_attempts integer default 5,
  p_max_work_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
as $$
declare
  effective_now timestamptz := coalesce(p_now, now());
  suppressed_seed_outbox_count integer := 0;
  cancelled_seed_work_count integer := 0;
  recovered_outbox_count integer := 0;
  terminal_outbox_count integer := 0;
  recovered_work_count integer := 0;
  terminal_work_count integer := 0;
  recovered_work_items jsonb := '[]'::jsonb;
begin
  if p_max_outbox_attempts < 1 or p_max_work_attempts < 1 then
    raise exception 'maximum attempts must be positive';
  end if;

  with suppressed as (
    update event_outbox eo
    set status = 'processed',
        processed_at = coalesce(eo.processed_at, effective_now),
        resolution_reason = 'non_actionable_seed_source',
        lease_token = null,
        lease_expires_at = null,
        updated_at = effective_now
    from ledger_events le
    where eo.ledger_event_id = le.id
      and eo.tenant_id = p_tenant_id
      and le.event_type = 'source_committed'
      and le.actor_label = 'Distillery seed data'
      and (
        eo.status = 'pending'
        or (eo.status = 'processing' and eo.lease_expires_at <= effective_now)
      )
      and exists (
        select 1
        from source_versions sv
        join extraction_runs er on er.ingestion_id = sv.ingestion_id and er.provider = 'seed'
        join memory_items mi on mi.ingestion_id = sv.ingestion_id
        where sv.id = le.subject_id
      )
    returning eo.id
  )
  select count(*) into suppressed_seed_outbox_count from suppressed;

  with seed_work as (
    select pw.id, pw.lease_token
    from pending_work pw
    join ledger_events le on le.id = pw.caused_by_event_id
    where pw.tenant_id = p_tenant_id
      and pw.policy = 'extract_memory'
      and le.actor_label = 'Distillery seed data'
      and (
        pw.status = 'pending'
        or (pw.status = 'running' and pw.lease_expires_at <= effective_now)
      )
      and exists (
        select 1
        from source_versions sv
        join extraction_runs er on er.ingestion_id = sv.ingestion_id and er.provider = 'seed'
        join memory_items mi on mi.ingestion_id = sv.ingestion_id
        where sv.id = pw.subject_id
      )
  ), closed_runs as (
    update policy_runs pr
    set status = 'cancelled',
        failure_kind = 'seed_source_suppressed',
        failure_reason = concat_ws(E'\n', nullif(pr.failure_reason, ''), 'Approved seed memory already exists; extraction is non-actionable.'),
        completed_at = effective_now,
        lease_expires_at = null
    from seed_work sw
    where pr.work_item_id = sw.id and pr.status = 'running'
    returning pr.id
  ), cancelled as (
    update pending_work pw
    set status = 'cancelled',
        last_error = concat_ws(E'\n', nullif(pw.last_error, ''), 'Approved seed memory already exists; extraction is non-actionable.'),
        cancelled_at = effective_now,
        lease_token = null,
        lease_expires_at = null,
        updated_at = effective_now
    from seed_work sw
    where pw.id = sw.id
    returning pw.id
  )
  select count(*) into cancelled_seed_work_count from cancelled;

  with expired as (
    select id
    from event_outbox
    where tenant_id = p_tenant_id
      and status = 'processing'
      and lease_expires_at <= effective_now
    for update skip locked
  ), recovered as (
    update event_outbox eo
    set status = case when eo.attempts >= p_max_outbox_attempts then 'failed' else 'pending' end,
        recovery_count = eo.recovery_count + 1,
        last_recovered_at = effective_now,
        last_error = concat_ws(E'\n', nullif(eo.last_error, ''), 'Router lease expired; claim recovered.'),
        locked_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = effective_now
    from expired e
    where eo.id = e.id
    returning eo.status
  )
  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'failed')
  into recovered_outbox_count, terminal_outbox_count
  from recovered;

  with expired as (
    select id, lease_token, attempts
    from pending_work
    where tenant_id = p_tenant_id
      and status = 'running'
      and lease_expires_at <= effective_now
    for update skip locked
  ), closed_runs as (
    update policy_runs pr
    set status = 'failed',
        failure_kind = 'lease_expired',
        failure_reason = concat_ws(E'\n', nullif(pr.failure_reason, ''), 'Worker lease expired; run abandoned and recovered.'),
        validation_ok = false,
        completed_at = effective_now,
        latency_ms = greatest(0, floor(extract(epoch from (effective_now - pr.started_at)) * 1000)::integer),
        lease_expires_at = null
    from expired e
    where pr.work_item_id = e.id
      and pr.status = 'running'
      and (e.lease_token is null or pr.lease_token = e.lease_token)
    returning pr.id
  ), recovered as (
    update pending_work pw
    set status = case when pw.attempts >= p_max_work_attempts then 'failed' else 'pending' end,
        recovery_count = pw.recovery_count + 1,
        last_recovered_at = effective_now,
        last_error = concat_ws(E'\n', nullif(pw.last_error, ''), 'Worker lease expired; claim recovered.'),
        locked_at = null,
        lease_token = null,
        lease_expires_at = null,
        completed_at = case when pw.attempts >= p_max_work_attempts then effective_now else null end,
        updated_at = effective_now
    from expired e
    where pw.id = e.id
    returning pw.*
  )
  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'failed'),
         coalesce(jsonb_agg(distillery_pending_work_to_json(recovered)) filter (where status = 'pending'), '[]'::jsonb)
  into recovered_work_count, terminal_work_count, recovered_work_items
  from recovered;

  return jsonb_build_object(
    'recoveredWorkItems', recovered_work_items,
    'recoveredOutboxCount', recovered_outbox_count,
    'terminalOutboxCount', terminal_outbox_count,
    'recoveredWorkCount', recovered_work_count,
    'terminalWorkCount', terminal_work_count,
    'suppressedSeedOutboxCount', suppressed_seed_outbox_count,
    'cancelledSeedWorkCount', cancelled_seed_work_count
  );
end;
$$;

create or replace function distillery_get_loop_status_v2(
  p_tenant_id text default 'stable',
  p_ingestion_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
  work pending_work%rowtype;
  outbox event_outbox%rowtype;
  recovery_item jsonb;
begin
  result := distillery_get_loop_status(p_tenant_id, p_ingestion_id, p_limit);

  if p_ingestion_id is not null then
    select eo.* into outbox
    from event_outbox eo
    join ledger_events le on le.id = eo.ledger_event_id
    where eo.tenant_id = p_tenant_id
      and le.event_type = 'source_committed'
      and le.payload->>'ingestionId' = p_ingestion_id
    order by eo.created_at desc
    limit 1;

    select pw.* into work
    from pending_work pw
    join source_versions sv on sv.id = pw.subject_id
    where pw.tenant_id = p_tenant_id and sv.ingestion_id = p_ingestion_id
    order by pw.created_at desc
    limit 1;

    if work.id is null and outbox.id is not null then
      if outbox.status = 'processing' and outbox.lease_expires_at > now() then
        result := jsonb_set(result, '{summary}', to_jsonb('The router is active under a valid lease.'::text));
      elsif outbox.recovery_count > 0 and outbox.status = 'pending' then
        result := jsonb_set(result, '{summary}', to_jsonb('An abandoned router claim was recovered and is waiting for retry.'::text));
      elsif outbox.status = 'failed' then
        result := jsonb_set(result, '{summary}', to_jsonb(('Router reached terminal failure after ' || outbox.attempts || ' attempt(s): ' || coalesce(outbox.last_error, 'unknown error'))::text));
        result := jsonb_set(result, '{isTerminal}', 'true'::jsonb);
      end if;
    end if;

    if work.id is not null then
      if work.status = 'running' and work.lease_expires_at > now() then
        result := jsonb_set(result, '{summary}', to_jsonb('Policy work is active under a valid lease.'::text));
      elsif work.recovery_count > 0 and work.status in ('pending', 'running') then
        result := jsonb_set(result, '{summary}', to_jsonb('Abandoned work was recovered and is being retried.'::text));
      elsif work.status = 'failed' then
        result := jsonb_set(result, '{summary}', to_jsonb(('Loop work reached terminal failure after ' || work.attempts || ' attempt(s): ' || coalesce(work.last_error, 'unknown error'))::text));
      end if;

      if work.recovery_count > 0 then
        recovery_item := distillery_loop_timeline_item(
          work.id || ':recovery',
          'system',
          'Abandoned work recovered',
          case when work.status = 'failed' then 'terminal_failure' else 'retrying' end,
          coalesce(work.last_recovered_at, work.updated_at),
          'An expired worker lease was closed before this work was retried.',
          case when work.status = 'failed' then 'error' else 'warning' end,
          jsonb_build_array(
            distillery_loop_ref('work_item_id', work.id),
            distillery_loop_ref('recovery_count', work.recovery_count::text),
            distillery_loop_ref('lease_expires_at', coalesce(work.lease_expires_at::text, 'none'))
          )
        );
        result := jsonb_set(result, '{timeline}', coalesce(result->'timeline', '[]'::jsonb) || recovery_item);
      end if;
    end if;
  end if;

  return result;
end;
$$;

notify pgrst, 'reload schema';
