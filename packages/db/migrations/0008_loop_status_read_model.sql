-- Read-only UI projection for the loop status drawer. This deliberately keeps
-- raw payloads out of the response and returns only status, IDs, timestamps,
-- validation issues, and failure/error summaries.

create or replace function distillery_loop_timeline_item(
  p_id text,
  p_kind text,
  p_label text,
  p_status text,
  p_occurred_at timestamptz,
  p_summary text,
  p_severity text,
  p_technical jsonb
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_id,
    'kind', p_kind,
    'label', p_label,
    'status', p_status,
    'occurredAt', coalesce(p_occurred_at, now()),
    'summary', p_summary,
    'severity', p_severity,
    'technical', coalesce(p_technical, '[]'::jsonb)
  );
$$;

create or replace function distillery_loop_ref(p_label text, p_value text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('label', p_label, 'value', p_value);
$$;

create or replace function distillery_loop_stage(
  p_key text,
  p_label text,
  p_status text,
  p_description text,
  p_occurred_at timestamptz,
  p_detail text
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'key', p_key,
    'label', p_label,
    'status', p_status,
    'description', p_description,
    'occurredAt', p_occurred_at,
    'detail', p_detail
  );
$$;

create or replace function distillery_get_loop_status(
  p_tenant_id text default 'stable',
  p_ingestion_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
as $$
declare
  source_event ledger_events%rowtype;
  source_outbox event_outbox%rowtype;
  first_work pending_work%rowtype;
  first_policy_run policy_runs%rowtype;
  first_proposal proposed_events%rowtype;
  committed_event ledger_events%rowtype;
  source_version_id text;
  timeline jsonb := '[]'::jsonb;
  activity jsonb := '[]'::jsonb;
  stages jsonb;
  last_updated_at timestamptz := now();
  is_terminal boolean := true;
  summary text := 'Recent loop activity';
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  if p_ingestion_id is not null then
    select sv.id into source_version_id
    from source_versions sv
    where sv.ingestion_id = p_ingestion_id
    order by sv.created_at desc
    limit 1;

    select * into source_event
    from ledger_events le
    where le.tenant_id = p_tenant_id
      and le.event_type = 'source_committed'
      and (
        le.payload->>'ingestionId' = p_ingestion_id
        or le.subject_id = source_version_id
      )
    order by le.created_at desc
    limit 1;

    if source_event.id is not null then
      timeline := timeline || distillery_loop_timeline_item(
        source_event.id,
        'ledger_event',
        'Source committed',
        source_event.event_type,
        source_event.created_at,
        'Immutable source and evidence were committed to the ledger.',
        'success',
        jsonb_build_array(
          distillery_loop_ref('ledger_event_id', source_event.id),
          distillery_loop_ref('subject_id', source_event.subject_id),
          distillery_loop_ref('idempotency_key', source_event.idempotency_key)
        )
      );

      select * into source_outbox
      from event_outbox eo
      where eo.ledger_event_id = source_event.id
      order by eo.created_at desc
      limit 1;

      if source_outbox.id is not null then
        timeline := timeline || distillery_loop_timeline_item(
          source_outbox.id,
          'outbox',
          'Router wakeup',
          source_outbox.status,
          coalesce(source_outbox.processed_at, source_outbox.locked_at, source_outbox.created_at),
          case source_outbox.status
            when 'processed' then 'The router processed this ledger event.'
            when 'failed' then 'The router failed while processing this ledger event.'
            when 'processing' then 'The router is processing this ledger event.'
            else 'This ledger event is waiting for the router.'
          end,
          case source_outbox.status when 'failed' then 'error' when 'processed' then 'success' else 'info' end,
          jsonb_build_array(
            distillery_loop_ref('event_outbox_id', source_outbox.id),
            distillery_loop_ref('attempts', source_outbox.attempts::text),
            distillery_loop_ref('last_error', coalesce(source_outbox.last_error, 'none'))
          )
        );
      end if;
    end if;

    select * into first_work
    from pending_work pw
    where pw.tenant_id = p_tenant_id
      and (
        pw.caused_by_event_id = source_event.id
        or pw.subject_id = source_version_id
      )
    order by pw.created_at desc
    limit 1;

    if first_work.id is not null then
      timeline := timeline || distillery_loop_timeline_item(
        first_work.id,
        'work',
        'Work queued',
        first_work.status,
        coalesce(first_work.started_at, first_work.created_at),
        'Policy work item: ' || first_work.policy || '.',
        case first_work.status when 'failed' then 'error' when 'completed' then 'success' when 'running' then 'info' else 'warning' end,
        jsonb_build_array(
          distillery_loop_ref('work_item_id', first_work.id),
          distillery_loop_ref('policy', first_work.policy),
          distillery_loop_ref('attempts', first_work.attempts::text),
          distillery_loop_ref('last_error', coalesce(first_work.last_error, 'none'))
        )
      );

      select * into first_policy_run
      from policy_runs pr
      where pr.work_item_id = first_work.id
      order by pr.created_at desc
      limit 1;

      if first_policy_run.id is not null then
        timeline := timeline || distillery_loop_timeline_item(
          first_policy_run.id,
          'policy_run',
          'Policy run',
          first_policy_run.status,
          first_policy_run.started_at,
          'Policy ' || first_policy_run.policy_name || ' ran with model ' || coalesce(first_policy_run.model, 'n/a') || '.',
          case first_policy_run.status when 'failed' then 'error' when 'completed' then 'success' else 'info' end,
          jsonb_build_array(
            distillery_loop_ref('policy_run_id', first_policy_run.id),
            distillery_loop_ref('policy_version', first_policy_run.policy_version),
            distillery_loop_ref('validation_ok', coalesce(first_policy_run.validation_ok::text, 'unknown')),
            distillery_loop_ref('failure_reason', coalesce(first_policy_run.failure_reason, 'none'))
          )
        );
      end if;

      select * into first_proposal
      from proposed_events pe
      where pe.work_item_id = first_work.id
      order by pe.created_at desc
      limit 1;

      if first_proposal.id is not null then
        timeline := timeline || distillery_loop_timeline_item(
          first_proposal.id,
          'proposed_event',
          'Proposed event',
          first_proposal.validation_status || '/' || first_proposal.review_status,
          first_proposal.created_at,
          'Policy proposed ' || first_proposal.proposed_event_type || ' targeting ' || first_proposal.target_event_type || '.',
          case
            when first_proposal.validation_status = 'invalid' then 'error'
            when first_proposal.review_status = 'pending' then 'warning'
            when first_proposal.committed_ledger_event_id is not null then 'success'
            else 'info'
          end,
          jsonb_build_array(
            distillery_loop_ref('proposed_event_id', first_proposal.id),
            distillery_loop_ref('target_event_type', first_proposal.target_event_type),
            distillery_loop_ref('requires_human_approval', first_proposal.requires_human_approval::text),
            distillery_loop_ref('validation_issues', first_proposal.validation_issues::text)
          )
        );

        if first_proposal.committed_ledger_event_id is not null then
          select * into committed_event
          from ledger_events le
          where le.id = first_proposal.committed_ledger_event_id;
        end if;
      end if;
    end if;

    if committed_event.id is not null then
      timeline := timeline || distillery_loop_timeline_item(
        committed_event.id,
        'ledger_event',
        'Ledger committed',
        committed_event.event_type,
        committed_event.created_at,
        'Validated proposal was committed to the canonical ledger.',
        'success',
        jsonb_build_array(
          distillery_loop_ref('ledger_event_id', committed_event.id),
          distillery_loop_ref('event_type', committed_event.event_type)
        )
      );
    end if;

    last_updated_at := coalesce(
      committed_event.created_at,
      first_proposal.updated_at,
      first_policy_run.completed_at,
      first_policy_run.started_at,
      first_work.updated_at,
      source_outbox.updated_at,
      source_event.created_at,
      now()
    );

    is_terminal := (
      first_work.id is not null
      and first_work.status in ('completed', 'failed', 'cancelled')
      and coalesce(first_proposal.review_status, 'not_required') <> 'pending'
    );

    summary := case
      when source_event.id is null then 'No loop event found for this capture yet.'
      when first_work.id is null then 'Source is committed and waiting for routed work.'
      when first_work.status = 'failed' then 'Loop work failed: ' || coalesce(first_work.last_error, 'unknown error')
      when first_proposal.review_status = 'pending' then 'Proposal is valid and waiting for human review.'
      when committed_event.id is not null then 'Loop committed ' || committed_event.event_type || '.'
      when first_work.status = 'running' then 'Policy work is running.'
      else 'Loop is processing.'
    end;

    stages := jsonb_build_array(
      distillery_loop_stage('source_committed', 'Source committed', case when source_event.id is null then 'pending' else 'completed' end, 'Evidence enters the immutable ledger.', source_event.created_at, source_event.id),
      distillery_loop_stage('routed', 'Routed', case when source_outbox.status = 'processed' then 'completed' when source_outbox.status = 'failed' then 'failed' when source_outbox.id is null then 'not_started' else 'running' end, 'Ledger event is routed into work.', coalesce(source_outbox.processed_at, source_outbox.locked_at), source_outbox.status),
      distillery_loop_stage('work_queued', 'Work queued', case when first_work.id is null then 'not_started' when first_work.status = 'pending' then 'pending' when first_work.status = 'failed' then 'failed' else 'completed' end, 'Canonical pending work exists in Postgres.', first_work.created_at, first_work.policy),
      distillery_loop_stage('policy_running', 'Policy running', case when first_policy_run.id is null then 'not_started' when first_policy_run.status = 'running' then 'running' when first_policy_run.status = 'failed' then 'failed' else 'completed' end, 'The named policy builds context and runs.', first_policy_run.started_at, first_policy_run.policy_name),
      distillery_loop_stage('proposed_event', 'Proposed event', case when first_proposal.id is null then 'not_started' when first_proposal.validation_status = 'invalid' then 'failed' else 'completed' end, 'Policy output is staged before commit.', first_proposal.created_at, first_proposal.proposed_event_type),
      distillery_loop_stage('validated', 'Validated', case when first_proposal.validation_status = 'valid' then 'completed' when first_proposal.validation_status = 'invalid' then 'failed' when first_proposal.id is null then 'not_started' else 'running' end, 'Runtime validation gates the proposal.', first_proposal.updated_at, first_proposal.validation_status),
      distillery_loop_stage('ledger_committed', 'Ledger committed', case when committed_event.id is null then 'not_started' else 'completed' end, 'Validated output reaches the canonical ledger.', committed_event.created_at, committed_event.event_type),
      distillery_loop_stage('human_review', 'Human review', case when first_proposal.requires_human_approval and first_proposal.review_status = 'pending' then 'waiting' when first_proposal.requires_human_approval and first_proposal.review_status in ('approved', 'rejected') then 'completed' when first_proposal.requires_human_approval then 'pending' else 'not_started' end, 'Authority decisions wait for a reviewer.', first_proposal.updated_at, first_proposal.review_status)
    );
  else
    stages := jsonb_build_array(
      distillery_loop_stage('source_committed', 'Source committed', 'not_started', 'Evidence enters the immutable ledger.', null, null),
      distillery_loop_stage('routed', 'Routed', 'not_started', 'Ledger event is routed into work.', null, null),
      distillery_loop_stage('work_queued', 'Work queued', 'not_started', 'Canonical pending work exists in Postgres.', null, null),
      distillery_loop_stage('policy_running', 'Policy running', 'not_started', 'The named policy builds context and runs.', null, null),
      distillery_loop_stage('proposed_event', 'Proposed event', 'not_started', 'Policy output is staged before commit.', null, null),
      distillery_loop_stage('validated', 'Validated', 'not_started', 'Runtime validation gates the proposal.', null, null),
      distillery_loop_stage('ledger_committed', 'Ledger committed', 'not_started', 'Validated output reaches the canonical ledger.', null, null),
      distillery_loop_stage('human_review', 'Human review', 'not_started', 'Authority decisions wait for a reviewer.', null, null)
    );
  end if;

  with recent as (
    select distillery_loop_timeline_item(
      le.id,
      'ledger_event',
      'Ledger event',
      le.event_type,
      le.created_at,
      le.event_type || ' on ' || le.subject_type || ' ' || le.subject_id,
      'success',
      jsonb_build_array(
        distillery_loop_ref('ledger_event_id', le.id),
        distillery_loop_ref('subject_id', le.subject_id)
      )
    ) as item,
    le.created_at as occurred_at
    from ledger_events le
    where le.tenant_id = p_tenant_id
    union all
    select distillery_loop_timeline_item(
      pw.id,
      'work',
      'Pending work',
      pw.status,
      coalesce(pw.started_at, pw.created_at),
      pw.policy || ' for ' || pw.subject_type || ' ' || pw.subject_id,
      case pw.status when 'failed' then 'error' when 'completed' then 'success' when 'running' then 'info' else 'warning' end,
      jsonb_build_array(
        distillery_loop_ref('work_item_id', pw.id),
        distillery_loop_ref('last_error', coalesce(pw.last_error, 'none'))
      )
    ),
    coalesce(pw.started_at, pw.created_at)
    from pending_work pw
    where pw.tenant_id = p_tenant_id
    union all
    select distillery_loop_timeline_item(
      pe.id,
      'proposed_event',
      'Proposed event',
      pe.validation_status || '/' || pe.review_status,
      pe.created_at,
      pe.proposed_event_type || ' -> ' || pe.target_event_type,
      case
        when pe.validation_status = 'invalid' then 'error'
        when pe.review_status = 'pending' then 'warning'
        when pe.committed_ledger_event_id is not null then 'success'
        else 'info'
      end,
      jsonb_build_array(
        distillery_loop_ref('proposed_event_id', pe.id),
        distillery_loop_ref('target_event_type', pe.target_event_type),
        distillery_loop_ref('review_status', pe.review_status)
      )
    ),
    pe.created_at
    from proposed_events pe
    where pe.tenant_id = p_tenant_id
    union all
    select distillery_loop_timeline_item(
      pr.id,
      'policy_run',
      'Policy run',
      pr.status,
      pr.started_at,
      pr.policy_name || ' run' || case when pr.model is not null then ' on ' || pr.model else '' end,
      case pr.status when 'failed' then 'error' when 'completed' then 'success' else 'info' end,
      jsonb_build_array(
        distillery_loop_ref('policy_run_id', pr.id),
        distillery_loop_ref('work_item_id', pr.work_item_id),
        distillery_loop_ref('failure_reason', coalesce(pr.failure_reason, 'none'))
      )
    ),
    pr.started_at
    from policy_runs pr
    where pr.tenant_id = p_tenant_id
  ),
  limited as (
    select item, occurred_at
    from recent
    order by occurred_at desc
    limit p_limit
  )
  select coalesce(jsonb_agg(item order by occurred_at desc), '[]'::jsonb)
  into activity
  from limited;

  return jsonb_build_object(
    'mode', case when p_ingestion_id is null then 'activity' else 'current' end,
    'subject', case when p_ingestion_id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'ingestionId', p_ingestion_id,
      'subjectType', 'source',
      'subjectId', source_version_id
    )) end,
    'summary', summary,
    'isTerminal', is_terminal,
    'lastUpdatedAt', last_updated_at,
    'stages', stages,
    'timeline', timeline,
    'activity', activity
  );
end;
$$;

notify pgrst, 'reload schema';
