-- Production-grade automatic sectioning for long or dense Remember sources.
-- Source versions and evidence spans remain immutable. These tables contain
-- orchestration checkpoints and validated interpretations only.

alter table pending_work drop constraint if exists pending_work_policy_check;
alter table pending_work add constraint pending_work_policy_check check (policy in (
  'extract_memory', 'extract_memory_section', 'consolidate_memory', 'connect_memory',
  'discover_candidate', 'check_freshness', 'detect_contradiction', 'update_embeddings',
  'update_graph', 'recompute_cluster', 'evaluate_synthesis_readiness', 'synthesize_brief',
  'rank_candidate', 'draft_artifact', 'gate_output', 'revise_artifact'
));

alter table ledger_events drop constraint if exists ledger_events_event_type_check;
alter table ledger_events add constraint ledger_events_event_type_check check (event_type in (
  'source_committed', 'memory_section_ready', 'memory_section_completed', 'memory_committed',
  'memory_connected', 'connections_updated', 'contradictions_updated', 'embeddings_updated',
  'graph_updated', 'memory_review_changed', 'synthesis_neighborhood_dirty', 'cluster_changed',
  'cluster_readiness_changed', 'synthesis_ready', 'memory_confirmed', 'memory_edited',
  'memory_removed', 'candidate_created', 'candidate_approved', 'candidate_rejected',
  'artifact_drafted', 'artifact_approved', 'artifact_rejected', 'artifact_delivered',
  'decision_committed', 'freshness_warning_committed', 'contradiction_recorded',
  'policy_run_recorded'
));

alter table ledger_events drop constraint if exists ledger_events_subject_type_check;
alter table ledger_events add constraint ledger_events_subject_type_check check (
  subject_type in ('source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table pending_work drop constraint if exists pending_work_subject_type_check;
alter table pending_work add constraint pending_work_subject_type_check check (
  subject_type in ('source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);

alter table proposed_events
  drop constraint if exists proposed_events_subject_type_check,
  drop constraint if exists proposed_events_proposed_event_type_check,
  drop constraint if exists proposed_events_target_event_type_check;
alter table proposed_events
  add constraint proposed_events_subject_type_check check (
    subject_type in ('source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
  ),
  add constraint proposed_events_proposed_event_type_check check (proposed_event_type in (
    'memory_proposed', 'section_update_proposed', 'memory_connection_proposed', 'candidate_proposed',
    'artifact_draft_proposed', 'freshness_warning_proposed', 'contradiction_proposed',
    'decision_record_proposed', 'enrichment_update_proposed', 'cluster_projection_proposed',
    'readiness_evaluation_proposed'
  )),
  add constraint proposed_events_target_event_type_check check (target_event_type in (
    'source_committed', 'memory_section_ready', 'memory_section_completed', 'memory_committed',
    'memory_connected', 'connections_updated', 'contradictions_updated', 'embeddings_updated',
    'graph_updated', 'memory_review_changed', 'synthesis_neighborhood_dirty', 'cluster_changed',
    'cluster_readiness_changed', 'synthesis_ready', 'memory_confirmed', 'memory_edited',
    'memory_removed', 'candidate_created', 'candidate_approved', 'candidate_rejected',
    'artifact_drafted', 'artifact_approved', 'artifact_rejected', 'artifact_delivered',
    'decision_committed', 'freshness_warning_committed', 'contradiction_recorded',
    'policy_run_recorded'
  ));

create table if not exists memory_section_plans (
  id text primary key,
  tenant_id text not null references tenants(id),
  ingestion_id text not null references ingestions(id),
  source_version_id text not null references source_versions(id),
  used_sectioning boolean not null,
  strategy text not null check (strategy in ('single', 'model', 'deterministic_fallback')),
  status text not null default 'planned' check (status in ('planned', 'extracting', 'consolidating', 'completed', 'failed')),
  trigger_chars integer not null check (trigger_chars > 0),
  trigger_spans integer not null check (trigger_spans > 0),
  target_chars integer not null check (target_chars > 0),
  max_chars integer not null check (max_chars > 0),
  max_sections integer not null check (max_sections between 1 and 50),
  planner_model text,
  fallback_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ingestion_id),
  unique (source_version_id)
);

create table if not exists memory_sections (
  id text primary key,
  plan_id text not null references memory_section_plans(id) on delete cascade,
  tenant_id text not null references tenants(id),
  ingestion_id text not null references ingestions(id),
  source_version_id text not null references source_versions(id),
  ordinal integer not null check (ordinal > 0),
  title text not null,
  start_evidence_span_id text not null references evidence_spans(id),
  end_evidence_span_id text not null references evidence_spans(id),
  start_span_index integer not null check (start_span_index >= 0),
  end_span_index integer not null check (end_span_index >= start_span_index),
  char_count integer not null check (char_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'superseded')),
  work_item_id text references pending_work(id),
  extraction_run_id text references extraction_runs(id),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  auto_items jsonb not null default '[]'::jsonb check (jsonb_typeof(auto_items) = 'array'),
  review_items jsonb not null default '[]'::jsonb check (jsonb_typeof(review_items) = 'array'),
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, ordinal)
);

create index if not exists memory_sections_plan_status_idx on memory_sections(plan_id, status, ordinal);
create index if not exists memory_sections_ingestion_status_idx on memory_sections(ingestion_id, status, ordinal);

create or replace function distillery_memory_section_to_json(p_row memory_sections)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id, 'planId', p_row.plan_id, 'ingestionId', p_row.ingestion_id,
    'tenantId', p_row.tenant_id, 'sourceVersionId', p_row.source_version_id,
    'ordinal', p_row.ordinal, 'title', p_row.title,
    'startEvidenceSpanId', p_row.start_evidence_span_id,
    'endEvidenceSpanId', p_row.end_evidence_span_id,
    'startSpanIndex', p_row.start_span_index, 'endSpanIndex', p_row.end_span_index,
    'charCount', p_row.char_count, 'status', p_row.status,
    'extractionRunId', p_row.extraction_run_id, 'candidateCount', p_row.candidate_count,
    'autoItems', p_row.auto_items, 'reviewItems', p_row.review_items,
    'errorMessage', p_row.error_message, 'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at
  );
$$;

create or replace function distillery_get_memory_section_plan(p_source_version_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  p memory_section_plans%rowtype;
  result jsonb;
begin
  select * into p from memory_section_plans where source_version_id = p_source_version_id;
  if p.id is null then return null; end if;
  select jsonb_build_object(
    'id', p.id, 'ingestionId', p.ingestion_id, 'tenantId', p.tenant_id,
    'sourceVersionId', p.source_version_id, 'usedSectioning', p.used_sectioning,
    'strategy', p.strategy, 'status', p.status, 'triggerChars', p.trigger_chars,
    'triggerSpans', p.trigger_spans, 'targetChars', p.target_chars, 'maxChars', p.max_chars,
    'maxSections', p.max_sections, 'plannerModel', p.planner_model,
    'fallbackReason', p.fallback_reason, 'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'sections', coalesce((select jsonb_agg(distillery_memory_section_to_json(s) order by s.ordinal)
      from memory_sections s where s.plan_id = p.id), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function distillery_create_memory_section_plan(p_plan jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  section jsonb;
  plan_id text := p_plan->>'id';
  source_id text := p_plan->>'sourceVersionId';
  v_ingestion_id text := p_plan->>'ingestionId';
  v_tenant_id text := p_plan->>'tenantId';
begin
  if not exists (select 1 from source_versions sv where sv.id = source_id and sv.ingestion_id = v_ingestion_id) then
    raise exception 'source version does not belong to ingestion';
  end if;
  insert into memory_section_plans(
    id, tenant_id, ingestion_id, source_version_id, used_sectioning, strategy, status,
    trigger_chars, trigger_spans, target_chars, max_chars, max_sections, planner_model, fallback_reason
  ) values (
    plan_id, v_tenant_id, v_ingestion_id, source_id, (p_plan->>'usedSectioning')::boolean,
    p_plan->>'strategy', 'planned', (p_plan->>'triggerChars')::integer,
    (p_plan->>'triggerSpans')::integer, (p_plan->>'targetChars')::integer,
    (p_plan->>'maxChars')::integer, (p_plan->>'maxSections')::integer,
    nullif(p_plan->>'plannerModel', ''), nullif(p_plan->>'fallbackReason', '')
  ) on conflict (source_version_id) do nothing;

  if exists (select 1 from memory_section_plans where id = plan_id) then
    for section in select value from jsonb_array_elements(p_plan->'sections') loop
      if not exists (select 1 from evidence_spans where id = section->>'startEvidenceSpanId' and source_version_id = source_id)
        or not exists (select 1 from evidence_spans where id = section->>'endEvidenceSpanId' and source_version_id = source_id) then
        raise exception 'section references evidence outside source version';
      end if;
      insert into memory_sections(
        id, plan_id, tenant_id, ingestion_id, source_version_id, ordinal, title,
        start_evidence_span_id, end_evidence_span_id, start_span_index, end_span_index, char_count
      ) values (
        section->>'id', plan_id, v_tenant_id, v_ingestion_id, source_id,
        (section->>'ordinal')::integer, section->>'title', section->>'startEvidenceSpanId',
        section->>'endEvidenceSpanId', (section->>'startSpanIndex')::integer,
        (section->>'endSpanIndex')::integer, (section->>'charCount')::integer
      ) on conflict (id) do nothing;
    end loop;
  end if;

  update ingestions set status = 'generating', updated_at = now() where id = v_ingestion_id;
  return distillery_get_memory_section_plan(source_id);
end;
$$;

create or replace function distillery_get_memory_section_context(p_section_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  s memory_sections%rowtype;
  p memory_section_plans%rowtype;
  result jsonb;
begin
  select * into s from memory_sections where id = p_section_id;
  if s.id is null then raise exception 'memory section not found: %', p_section_id; end if;
  select * into p from memory_section_plans where id = s.plan_id;
  select jsonb_build_object(
    'section', distillery_memory_section_to_json(s),
    'plan', distillery_get_memory_section_plan(s.source_version_id),
    'evidenceSpans', coalesce((
      with ordered as (
        select es.*, row_number() over (order by es.start_line, es.start_char, es.id) - 1 as span_index
        from evidence_spans es where es.source_version_id = s.source_version_id
      )
      select jsonb_agg(jsonb_build_object(
        'id', id, 'sourceVersionId', source_version_id, 'startLine', start_line,
        'endLine', end_line, 'startChar', start_char, 'endChar', end_char, 'text', text
      ) order by span_index)
      from ordered where span_index between s.start_span_index and s.end_span_index
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function distillery_start_memory_section(
  p_section_id text, p_work_item_id text, p_lease_token text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  s memory_sections%rowtype;
begin
  if not exists (
    select 1 from pending_work where id = p_work_item_id and subject_id = p_section_id
      and status = 'running' and lease_token = p_lease_token and lease_expires_at > now()
  ) then raise exception 'active section work lease is required'; end if;
  update memory_sections set status = 'processing', work_item_id = p_work_item_id,
    error_message = null, started_at = coalesce(started_at, now()), updated_at = now()
  where id = p_section_id and status in ('pending', 'processing', 'failed') returning * into s;
  if s.id is null then select * into s from memory_sections where id = p_section_id; end if;
  update memory_section_plans set status = 'extracting', updated_at = now()
    where id = s.plan_id and status = 'planned';
  return distillery_memory_section_to_json(s);
end;
$$;

create or replace function distillery_complete_memory_section(
  p_section_id text, p_work_item_id text, p_lease_token text, p_extraction_run_id text,
  p_candidate_count integer, p_auto_items jsonb, p_review_items jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  s memory_sections%rowtype;
begin
  if not exists (
    select 1 from pending_work where id = p_work_item_id and subject_id = p_section_id
      and status = 'running' and lease_token = p_lease_token and lease_expires_at > now()
  ) then raise exception 'active section work lease is required'; end if;
  update memory_sections set status = 'completed', extraction_run_id = p_extraction_run_id,
    candidate_count = p_candidate_count, auto_items = coalesce(p_auto_items, '[]'::jsonb),
    review_items = coalesce(p_review_items, '[]'::jsonb), error_message = null,
    completed_at = now(), updated_at = now()
  where id = p_section_id and status <> 'superseded' returning * into s;
  update memory_section_plans set updated_at = now() where id = s.plan_id;
  return distillery_memory_section_to_json(s);
end;
$$;

create or replace function distillery_fail_pending_work(p_id text, p_error text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
declare
  work pending_work%rowtype;
  v_ingestion_id text;
begin
  update pending_work set status = 'failed', last_error = left(p_error, 1000), completed_at = now(),
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = p_id and status = 'running' and (p_lease_token is null or lease_token = p_lease_token)
  returning * into work;
  if work.id is null then return; end if;

  if work.policy = 'extract_memory_section' then
    update memory_sections as ms set status = 'failed', error_message = left(p_error, 1000), updated_at = now()
      where ms.id = work.subject_id returning ms.ingestion_id into v_ingestion_id;
  elsif work.policy in ('extract_memory', 'consolidate_memory') then
    select i.id into v_ingestion_id from ingestions i join source_versions sv on sv.ingestion_id = i.id
      where sv.id = work.subject_id limit 1;
  end if;
  if v_ingestion_id is not null then
    update memory_section_plans set status = 'failed', updated_at = now() where memory_section_plans.ingestion_id = v_ingestion_id;
    update ingestions set status = 'failed', error_message = left(p_error, 1000), updated_at = now() where id = v_ingestion_id;
  end if;
end;
$$;

create or replace function distillery_mark_memory_section_plan_consolidating(p_source_version_id text)
returns void
language sql
security definer
as $$
  update memory_section_plans set status = 'consolidating', updated_at = now()
  where source_version_id = p_source_version_id
    and status <> 'completed'
    and not exists (select 1 from memory_sections s where s.plan_id = memory_section_plans.id and s.status <> 'completed');
$$;

create or replace function distillery_retry_memory_section_ingestion(p_ingestion_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  source_id text;
  work_ids jsonb;
begin
  select source_version_id into source_id from memory_section_plans where ingestion_id = p_ingestion_id;
  if source_id is null then
    select sv.id into source_id from source_versions sv where sv.ingestion_id = p_ingestion_id order by sv.version desc limit 1;
  end if;
  update memory_sections set status = 'pending', error_message = null, work_item_id = null,
    started_at = null, completed_at = null, updated_at = now()
  where ingestion_id = p_ingestion_id and status = 'failed';
  update pending_work pw set status = 'pending', attempts = 0, last_error = null, locked_at = null,
    lease_token = null, lease_expires_at = null, started_at = null, completed_at = null, updated_at = now()
  where pw.status = 'failed' and (
    (pw.policy = 'extract_memory' and pw.subject_id = source_id)
    or (pw.policy = 'extract_memory_section' and exists (select 1 from memory_sections s where s.id = pw.subject_id and s.ingestion_id = p_ingestion_id))
    or (pw.policy = 'consolidate_memory' and pw.subject_id = source_id)
  );
  update memory_section_plans set status = case when exists (
      select 1 from memory_sections where ingestion_id = p_ingestion_id and status = 'completed'
    ) then 'extracting' else 'planned' end, updated_at = now()
  where ingestion_id = p_ingestion_id;
  select coalesce(jsonb_agg(id order by created_at), '[]'::jsonb) into work_ids
  from pending_work pw where pw.status = 'pending' and (
    (pw.policy = 'extract_memory' and pw.subject_id = source_id)
    or (pw.policy = 'extract_memory_section' and exists (select 1 from memory_sections s where s.id = pw.subject_id and s.ingestion_id = p_ingestion_id))
    or (pw.policy = 'consolidate_memory' and pw.subject_id = source_id)
  );
  if jsonb_array_length(work_ids) > 0 then
    update ingestions set status = 'generating', error_message = null, updated_at = now() where id = p_ingestion_id;
  end if;
  return work_ids;
end;
$$;

-- Stable proposal IDs make retries and queue redelivery idempotent.
create or replace function distillery_create_proposed_event(p_proposed_event jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  row proposed_events%rowtype;
begin
  insert into proposed_events(
    id, tenant_id, work_item_id, policy_run_id, proposed_event_type, target_event_type,
    subject_type, subject_id, payload, evidence_span_ids, memory_item_ids, decision_ids,
    requires_human_approval, review_status, reviewer_label, review_rationale
  ) values (
    p_proposed_event->>'id', p_proposed_event->>'tenantId', nullif(p_proposed_event->>'workItemId', ''),
    nullif(p_proposed_event->>'policyRunId', ''), p_proposed_event->>'proposedEventType',
    p_proposed_event->>'targetEventType', p_proposed_event->>'subjectType',
    p_proposed_event->>'subjectId', p_proposed_event->'payload',
    coalesce(p_proposed_event->'evidenceSpanIds', '[]'::jsonb),
    coalesce(p_proposed_event->'memoryItemIds', '[]'::jsonb),
    coalesce(p_proposed_event->'decisionIds', '[]'::jsonb),
    (p_proposed_event->>'requiresHumanApproval')::boolean,
    case when (p_proposed_event->>'requiresHumanApproval')::boolean then 'pending' else 'not_required' end,
    p_proposed_event->>'reviewerLabel', p_proposed_event->>'reviewRationale'
  ) on conflict (id) do nothing;
  select * into row from proposed_events where id = p_proposed_event->>'id';
  return distillery_proposed_event_to_json(row);
end;
$$;

-- A section retry reuses its extraction-run identity instead of duplicating audit rows.
create or replace function distillery_record_extraction_run(
  p_id text, p_ingestion_id text, p_tenant_id text, p_provider text, p_model text,
  p_prompt_version text, p_schema_version text, p_raw_response jsonb, p_status text
)
returns void
language plpgsql
security definer
as $$
begin
  insert into extraction_runs(id, tenant_id, ingestion_id, provider, model, prompt_version, schema_version, raw_response, status)
  values (p_id, p_tenant_id, p_ingestion_id, p_provider, p_model, p_prompt_version, p_schema_version, p_raw_response, p_status)
  on conflict (id) do update set provider = excluded.provider, model = excluded.model,
    prompt_version = excluded.prompt_version, schema_version = excluded.schema_version,
    raw_response = excluded.raw_response, status = excluded.status;
end;
$$;

create or replace function distillery_mark_section_plan_completed()
returns trigger
language plpgsql
as $$
begin
  if new.event_type = 'memory_committed' and new.payload ? 'ingestionId' then
    update memory_section_plans set status = 'completed', updated_at = now()
    where ingestion_id = new.payload->>'ingestionId';
  end if;
  return new;
end;
$$;
drop trigger if exists mark_section_plan_completed on ledger_events;
create trigger mark_section_plan_completed after insert on ledger_events
for each row execute function distillery_mark_section_plan_completed();

create or replace function distillery_get_loop_status_v3(
  p_tenant_id text default 'stable', p_ingestion_id text default null, p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb := distillery_get_loop_status_v2(p_tenant_id, p_ingestion_id, p_limit);
  p memory_section_plans%rowtype;
  planned integer := 0; pending_count integer := 0; processing_count integer := 0;
  completed_count integer := 0; failed_count integer := 0;
  current_section memory_sections%rowtype;
  phase text; terminal_state text; section_timeline jsonb := '[]'::jsonb;
begin
  if p_ingestion_id is null then return jsonb_set(result, '{sectionProgress}', 'null'::jsonb); end if;
  select * into p from memory_section_plans where ingestion_id = p_ingestion_id;
  if p.id is null then return jsonb_set(result, '{sectionProgress}', 'null'::jsonb); end if;

  select count(*), count(*) filter (where status = 'pending'), count(*) filter (where status = 'processing'),
    count(*) filter (where status = 'completed'), count(*) filter (where status = 'failed')
  into planned, pending_count, processing_count, completed_count, failed_count
  from memory_sections where plan_id = p.id and status <> 'superseded';
  select * into current_section from memory_sections where plan_id = p.id and status in ('processing', 'pending')
    order by case status when 'processing' then 0 else 1 end, ordinal limit 1;

  phase := case
    when p.status = 'completed' then 'completed'
    when p.status = 'failed' or failed_count > 0 then 'failed'
    when p.status = 'consolidating' or (planned > 0 and completed_count = planned) then 'consolidating'
    when processing_count > 0 then 'verifying'
    when p.status in ('planned', 'extracting') then 'extracting'
    else 'planning' end;
  terminal_state := case when phase = 'completed' then 'succeeded' when phase = 'failed' then 'failed' else 'processing' end;

  select coalesce(jsonb_agg(distillery_loop_timeline_item(
    s.id || ':section', 'system', 'Memory section ' || s.ordinal, s.status, s.updated_at,
    case s.status
      when 'completed' then 'Extracted and verified section ' || s.ordinal || ' of ' || planned || ': ' || s.title || '.'
      when 'processing' then 'Extracting memory from section ' || s.ordinal || ' of ' || planned || ': ' || s.title || '.'
      when 'failed' then 'Section ' || s.ordinal || ' failed: ' || coalesce(s.error_message, 'sanitized error')
      else 'Section ' || s.ordinal || ' is waiting: ' || s.title || '.' end,
    case s.status when 'completed' then 'success' when 'failed' then 'error' when 'processing' then 'info' else 'warning' end,
    jsonb_build_array(distillery_loop_ref('section_id', s.id), distillery_loop_ref('candidate_count', s.candidate_count::text))
  ) order by s.updated_at desc), '[]'::jsonb) into section_timeline
  from (select * from memory_sections where plan_id = p.id order by updated_at desc limit 12) s;
  section_timeline := jsonb_build_array(distillery_loop_timeline_item(
    p.id || ':plan', 'system', 'Document section plan', p.strategy, p.created_at,
    case p.strategy
      when 'model' then 'A semantic model organized the document into ' || planned || ' complete sections.'
      when 'deterministic_fallback' then 'The safe deterministic fallback organized the document into ' || planned || ' complete sections.'
      else 'The document stayed on the single-extraction path.' end,
    case when p.strategy = 'deterministic_fallback' then 'warning' else 'success' end,
    jsonb_build_array(distillery_loop_ref('section_plan_id', p.id), distillery_loop_ref('section_count', planned::text))
  )) || section_timeline;

  result := jsonb_set(result, '{sectionProgress}', jsonb_strip_nulls(jsonb_build_object(
    'usedSectioning', p.used_sectioning, 'plannedSections', planned, 'pendingSections', pending_count,
    'processingSections', processing_count, 'completedSections', completed_count, 'failedSections', failed_count,
    'currentSectionOrdinal', current_section.ordinal, 'currentSectionTitle', current_section.title,
    'phase', phase, 'terminalState', terminal_state
  )));
  result := jsonb_set(result, '{timeline}', section_timeline || coalesce(result->'timeline', '[]'::jsonb));
  result := jsonb_set(result, '{isTerminal}', to_jsonb(terminal_state <> 'processing'));
  result := jsonb_set(result, '{summary}', to_jsonb((case
    when phase = 'completed' then 'Memory stored from all ' || planned || ' sections.'
    when phase = 'failed' then 'Section processing failed. Retry resumes unfinished sections.'
    when phase = 'consolidating' then 'Verified ' || completed_count || ' of ' || planned || ' sections. Consolidating memory.'
    when p.used_sectioning and completed_count = 0 and processing_count = 0 then 'Document organized into ' || planned || ' sections.'
    when p.used_sectioning then 'Verified ' || completed_count || ' of ' || planned || ' sections.'
    else 'Processing the document in one extraction.' end)::text));
  result := jsonb_set(result, '{lastUpdatedAt}', to_jsonb(p.updated_at));
  return result;
end;
$$;

notify pgrst, 'reload schema';
