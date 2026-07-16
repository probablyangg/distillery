-- Private-pilot Slack source connector and read-only leadership brief projection.
-- This migration is additive. PostgreSQL remains canonical and Queue messages
-- continue to contain only workItemId.

alter table ingestions drop constraint if exists ingestions_input_type_check;
alter table ingestions add constraint ingestions_input_type_check check (input_type in ('text', 'slack'));

alter table source_items drop constraint if exists source_items_source_type_check;
alter table source_items add constraint source_items_source_type_check check (
  source_type in ('text_braindump', 'slack_message', 'slack_file_pdf', 'slack_file_docx')
);
alter table source_items
  add column if not exists provider text,
  add column if not exists external_id text,
  add column if not exists canonical_url text,
  add column if not exists author_id text,
  add column if not exists author_label text,
  add column if not exists occurred_at timestamptz,
  add column if not exists mime_type text,
  add column if not exists original_filename text,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;
create unique index if not exists source_items_external_identity_idx
  on source_items(tenant_id, provider, external_id)
  where provider is not null and external_id is not null;

alter table source_versions
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;
alter table evidence_spans
  add column if not exists locator jsonb not null default '{}'::jsonb;

alter table initiative_briefs
  add column if not exists origin text not null default 'manual',
  add column if not exists generation_reason text;
alter table initiative_briefs drop constraint if exists initiative_briefs_origin_check;
alter table initiative_briefs add constraint initiative_briefs_origin_check check (
  origin in ('manual', 'distillery_generated')
);

update initiative_briefs ib
set origin = 'distillery_generated',
    generation_reason = coalesce(ib.generation_reason, 'Distillery generated this brief after an evidence cluster passed synthesis readiness checks.')
where exists (
  select 1 from suggested_brief_versions sbv where sbv.initiative_brief_id = ib.id
);

create or replace function distillery_mark_generated_initiative_brief()
returns trigger
language plpgsql
as $$
declare
  reason text;
begin
  select nullif(sre.reasons->>0, '')
  into reason
  from synthesis_readiness_evaluations sre
  where sre.tenant_id = new.tenant_id
    and sre.cluster_id = new.cluster_id
    and sre.cluster_version = new.cluster_version
    and sre.generation_intent = new.generation_intent
  order by sre.evaluated_at desc
  limit 1;

  update initiative_briefs
  set origin = 'distillery_generated',
      generation_reason = coalesce(
        generation_reason,
        reason,
        'Distillery generated this brief after an evidence cluster passed synthesis readiness checks.'
      ),
      updated_at = greatest(updated_at, now())
  where id = new.initiative_brief_id;
  return new;
end;
$$;

drop trigger if exists suggested_brief_marks_generated on suggested_brief_versions;
create trigger suggested_brief_marks_generated
after insert or update of initiative_brief_id on suggested_brief_versions
for each row execute function distillery_mark_generated_initiative_brief();

alter table pending_work drop constraint if exists pending_work_policy_check;
alter table pending_work add constraint pending_work_policy_check check (policy in (
  'ingest_slack_source', 'sync_slack_reaction',
  'extract_memory', 'extract_memory_section', 'consolidate_memory', 'connect_memory',
  'discover_candidate', 'check_freshness', 'detect_contradiction', 'update_embeddings',
  'update_graph', 'recompute_cluster', 'evaluate_synthesis_readiness', 'synthesize_brief',
  'rank_candidate', 'draft_artifact', 'gate_output', 'revise_artifact'
));

alter table ledger_events drop constraint if exists ledger_events_event_type_check;
alter table ledger_events add constraint ledger_events_event_type_check check (event_type in (
  'slack_save_requested', 'slack_reaction_retry_requested',
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
  subject_type in ('connector_save', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table pending_work drop constraint if exists pending_work_subject_type_check;
alter table pending_work add constraint pending_work_subject_type_check check (
  subject_type in ('connector_save', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table proposed_events drop constraint if exists proposed_events_subject_type_check;
alter table proposed_events add constraint proposed_events_subject_type_check check (
  subject_type in ('connector_save', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);

create table if not exists connector_saves (
  id text primary key,
  tenant_id text not null references tenants(id),
  provider text not null check (provider = 'slack'),
  workspace_id text not null,
  channel_id text not null,
  message_timestamp text not null,
  thread_timestamp text,
  invoking_user_id text not null,
  response_url text,
  external_source_id text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  work_item_id text references pending_work(id),
  message_source_id text references source_items(id),
  attachment_source_ids jsonb not null default '[]'::jsonb,
  reaction_status text not null default 'pending' check (reaction_status in ('pending', 'added', 'failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  reaction_retry_count integer not null default 0 check (reaction_retry_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, provider, workspace_id, channel_id, message_timestamp),
  unique (tenant_id, provider, external_source_id)
);

create table if not exists slack_interaction_receipts (
  request_hash text primary key,
  tenant_id text not null references tenants(id),
  connector_save_id text not null references connector_saves(id),
  created_at timestamptz not null default now()
);

create index if not exists connector_saves_status_updated_idx
  on connector_saves(tenant_id, status, updated_at);
create index if not exists connector_saves_reaction_status_idx
  on connector_saves(tenant_id, reaction_status, updated_at);

create or replace function distillery_connector_save_json(p_save connector_saves)
returns jsonb
language sql
stable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_save.id,
    'tenantId', p_save.tenant_id,
    'provider', p_save.provider,
    'workspaceId', p_save.workspace_id,
    'channelId', p_save.channel_id,
    'messageTimestamp', p_save.message_timestamp,
    'threadTimestamp', p_save.thread_timestamp,
    'invokingUserId', p_save.invoking_user_id,
    'responseUrl', p_save.response_url,
    'externalSourceId', p_save.external_source_id,
    'status', p_save.status,
    'workItemId', p_save.work_item_id,
    'messageSourceId', p_save.message_source_id,
    'attachmentSourceIds', p_save.attachment_source_ids,
    'reactionStatus', p_save.reaction_status,
    'retryCount', p_save.retry_count,
    'reactionRetryCount', p_save.reaction_retry_count,
    'lastError', p_save.last_error,
    'createdAt', p_save.created_at,
    'updatedAt', p_save.updated_at,
    'completedAt', p_save.completed_at
  ));
$$;

create or replace function distillery_create_or_get_slack_save(
  p_tenant_id text,
  p_request_hash text,
  p_workspace_id text,
  p_channel_id text,
  p_message_timestamp text,
  p_thread_timestamp text,
  p_invoking_user_id text,
  p_response_url text,
  p_external_source_id text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
  prior_receipt slack_interaction_receipts%rowtype;
  event_id text;
  event_type text;
  policy_name text;
  work_id text;
  existing_work pending_work%rowtype;
begin
  if p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid Slack request hash'; end if;
  if p_external_source_id <> 'slack:' || p_workspace_id || ':' || p_channel_id || ':' || p_message_timestamp then
    raise exception 'invalid canonical Slack external source identity';
  end if;
  insert into tenants(id, name) values (p_tenant_id, 'Stable') on conflict (id) do nothing;

  select * into prior_receipt from slack_interaction_receipts where request_hash = p_request_hash;
  if prior_receipt.request_hash is not null then
    select * into save_row from connector_saves where id = prior_receipt.connector_save_id;
    return jsonb_build_object(
      'save', distillery_connector_save_json(save_row),
      'workItemId', null,
      'created', false,
      'replayed', true
    );
  end if;

  insert into connector_saves(
    id, tenant_id, provider, workspace_id, channel_id, message_timestamp,
    thread_timestamp, invoking_user_id, response_url, external_source_id
  ) values (
    'csave_' || gen_random_uuid()::text, p_tenant_id, 'slack', p_workspace_id,
    p_channel_id, p_message_timestamp, nullif(p_thread_timestamp, ''), p_invoking_user_id,
    nullif(p_response_url, ''), p_external_source_id
  )
  on conflict (tenant_id, provider, external_source_id)
  do update set
    invoking_user_id = excluded.invoking_user_id,
    response_url = coalesce(excluded.response_url, connector_saves.response_url),
    thread_timestamp = coalesce(connector_saves.thread_timestamp, excluded.thread_timestamp),
    updated_at = now()
  returning * into save_row;

  insert into slack_interaction_receipts(request_hash, tenant_id, connector_save_id)
  values (p_request_hash, p_tenant_id, save_row.id)
  on conflict (request_hash) do nothing;

  if save_row.status in ('pending', 'processing') then
    select * into existing_work
    from pending_work
    where tenant_id = p_tenant_id
      and policy = 'ingest_slack_source'
      and subject_type = 'connector_save'
      and subject_id = save_row.id
      and status in ('pending', 'running')
    order by created_at desc
    limit 1;
  end if;

  if existing_work.id is not null then
    return jsonb_build_object(
      'save', distillery_connector_save_json(save_row),
      'workItemId', existing_work.id,
      'created', false,
      'replayed', false
    );
  end if;

  event_id := 'evt_' || gen_random_uuid()::text;
  work_id := 'work_' || gen_random_uuid()::text;
  if save_row.status = 'completed' then
    event_type := 'slack_reaction_retry_requested';
    policy_name := 'sync_slack_reaction';
  else
    event_type := 'slack_save_requested';
    policy_name := 'ingest_slack_source';
  end if;

  insert into ledger_events(
    id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
    input_version, idempotency_key, payload
  ) values (
    event_id, p_tenant_id, event_type, 'connector_save', save_row.id, 'connector',
    'Slack message shortcut', p_request_hash, 'slack-interaction:' || p_request_hash,
    jsonb_build_object(
      'connectorSaveId', save_row.id,
      'workspaceId', p_workspace_id,
      'channelId', p_channel_id,
      'messageTimestamp', p_message_timestamp
    )
  );
  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, p_tenant_id, event_id)
  on conflict (ledger_event_id) do nothing;
  insert into pending_work(
    id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version
  ) values (
    work_id, p_tenant_id, policy_name, 'connector_save', save_row.id, event_id, p_request_hash
  );

  update connector_saves
  set status = case when policy_name = 'ingest_slack_source' then 'pending' else status end,
      work_item_id = work_id,
      updated_at = now()
  where id = save_row.id
  returning * into save_row;

  return jsonb_build_object(
    'save', distillery_connector_save_json(save_row),
    'workItemId', work_id,
    'created', true,
    'replayed', false
  );
end;
$$;

create or replace function distillery_get_slack_connector_save(p_save_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
begin
  select * into save_row from connector_saves where id = p_save_id;
  if save_row.id is null then raise exception 'connector save not found'; end if;
  return distillery_connector_save_json(save_row);
end;
$$;

create or replace function distillery_mark_slack_connector_processing(p_save_id text)
returns void
language plpgsql
security definer
as $$
begin
  update connector_saves
  set status = case when status = 'completed' then status else 'processing' end,
      updated_at = now()
  where id = p_save_id;
  if not found then raise exception 'connector save not found'; end if;
end;
$$;

create or replace function distillery_commit_slack_connector_sources(
  p_save_id text,
  p_sources jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
  source jsonb;
  span jsonb;
  source_item_row source_items%rowtype;
  source_version_row source_versions%rowtype;
  source_version_id text;
  ingestion_id text;
  next_version integer;
  v_message_source_id text;
  v_attachment_source_ids jsonb := '[]'::jsonb;
  source_event_id text;
  source_count integer;
begin
  select * into save_row from connector_saves where id = p_save_id for update;
  if save_row.id is null then raise exception 'connector save not found'; end if;
  if save_row.status = 'completed' then return distillery_connector_save_json(save_row); end if;
  if jsonb_typeof(p_sources) <> 'array' then raise exception 'connector sources must be an array'; end if;
  source_count := jsonb_array_length(p_sources);
  if source_count < 1 or source_count > 6 then raise exception 'connector save requires one to six sources'; end if;
  if (
    select count(*) from jsonb_array_elements(p_sources) item where item->>'sourceType' = 'slack_message'
  ) <> 1 then raise exception 'connector save requires exactly one Slack message source'; end if;
  if not exists (
    select 1 from jsonb_array_elements(p_sources) item
    where item->>'sourceType' = 'slack_message' and item->>'externalId' = save_row.external_source_id
  ) then raise exception 'Slack message source identity does not match connector save'; end if;

  for source in select * from jsonb_array_elements(p_sources)
  loop
    if source->>'sourceType' not in ('slack_message', 'slack_file_pdf', 'slack_file_docx') then
      raise exception 'unsupported connector source type';
    end if;
    if length(coalesce(source->>'content', '')) > 200000 then raise exception 'connector source content exceeds limit'; end if;
    if coalesce(source->>'externalId', '') = '' or coalesce(source->>'contentHash', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'connector source identity or hash is invalid';
    end if;
    if source->>'sourceType' <> 'slack_message'
      and source->>'externalId' not like 'slack_file:' || save_row.workspace_id || ':%'
    then raise exception 'Slack file source identity does not match connector workspace'; end if;

    select * into source_item_row
    from source_items
    where tenant_id = save_row.tenant_id
      and provider = 'slack'
      and external_id = source->>'externalId'
    for update;

    if source_item_row.id is null then
      insert into source_items(
        id, tenant_id, source_type, content_hash, provider, external_id, canonical_url,
        author_id, author_label, occurred_at, mime_type, original_filename, source_metadata
      ) values (
        source->>'sourceItemId', save_row.tenant_id, source->>'sourceType', source->>'contentHash',
        'slack', source->>'externalId', source->>'canonicalUrl', nullif(source->>'authorId', ''),
        nullif(source->>'authorLabel', ''), (source->>'occurredAt')::timestamptz,
        source->>'mimeType', nullif(source->>'originalFilename', ''), coalesce(source->'sourceMetadata', '{}'::jsonb)
      )
      on conflict (tenant_id, provider, external_id)
        where provider is not null and external_id is not null
      do update set external_id = excluded.external_id
      returning * into source_item_row;
    end if;

    select * into source_version_row
    from source_versions
    where source_item_id = source_item_row.id
      and content_hash = source->>'contentHash'
    order by version desc
    limit 1;

    if source_version_row.id is null then
      ingestion_id := source->>'ingestionId';
      insert into ingestions(
        id, tenant_id, app_session_id, submitted_by_label, input_type,
        idempotency_key, status
      ) values (
        ingestion_id, save_row.tenant_id, save_row.id, coalesce(source->>'authorLabel', 'Slack user'),
        'slack', 'slack-source:' || save_row.id || ':' || (source->>'externalId') || ':' || (source->>'contentHash'),
        'evidence_stored'
      ) on conflict (tenant_id, idempotency_key) do update set updated_at = now()
      returning id into ingestion_id;

      select coalesce(max(version), 0) + 1 into next_version
      from source_versions where source_item_id = source_item_row.id;
      source_version_id := source->>'sourceVersionId';
      insert into source_versions(
        id, tenant_id, source_item_id, ingestion_id, version, content, content_hash, source_metadata
      ) values (
        source_version_id, save_row.tenant_id, source_item_row.id, ingestion_id, next_version,
        source->>'content', source->>'contentHash', coalesce(source->'sourceMetadata', '{}'::jsonb)
      ) returning * into source_version_row;

      for span in select * from jsonb_array_elements(coalesce(source->'evidenceSpans', '[]'::jsonb))
      loop
        if span->>'sourceVersionId' <> source_version_id then raise exception 'evidence span source mismatch'; end if;
        if (span->>'startChar')::integer < 0
          or (span->>'endChar')::integer < (span->>'startChar')::integer
          or substring(source->>'content' from (span->>'startChar')::integer + 1 for (span->>'endChar')::integer - (span->>'startChar')::integer) <> span->>'text'
        then raise exception 'evidence span offsets do not match source content'; end if;
        insert into evidence_spans(
          id, tenant_id, source_version_id, start_line, end_line, start_char, end_char, text, locator
        ) values (
          span->>'id', save_row.tenant_id, source_version_id,
          (span->>'startLine')::integer, (span->>'endLine')::integer,
          (span->>'startChar')::integer, (span->>'endChar')::integer,
          span->>'text', coalesce(span->'locator', '{}'::jsonb)
        );
      end loop;

      if jsonb_array_length(coalesce(source->'evidenceSpans', '[]'::jsonb)) > 0 then
        source_event_id := 'evt_' || gen_random_uuid()::text;
        insert into ledger_events(
          id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
          input_version, idempotency_key, payload
        ) values (
          source_event_id, save_row.tenant_id, 'source_committed', 'source', source_version_id,
          'connector', 'Slack connector', source->>'contentHash',
          'source-committed:' || source_version_id,
          jsonb_build_object(
            'connectorSaveId', save_row.id,
            'ingestionId', ingestion_id,
            'sourceVersionId', source_version_id,
            'sourceType', source->>'sourceType',
            'provider', 'slack'
          )
        );
        insert into event_outbox(id, tenant_id, ledger_event_id)
        values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, source_event_id);
      end if;
    end if;

    update source_items
    set content_hash = source->>'contentHash',
        canonical_url = source->>'canonicalUrl',
        author_id = coalesce(nullif(source->>'authorId', ''), author_id),
        author_label = coalesce(nullif(source->>'authorLabel', ''), author_label),
        occurred_at = coalesce((source->>'occurredAt')::timestamptz, occurred_at),
        mime_type = source->>'mimeType',
        original_filename = coalesce(nullif(source->>'originalFilename', ''), original_filename),
        source_metadata = coalesce(source->'sourceMetadata', source_metadata)
    where id = source_item_row.id;

    if source->>'sourceType' = 'slack_message' then
      v_message_source_id := source_item_row.id;
    else
      v_attachment_source_ids := v_attachment_source_ids || jsonb_build_array(source_item_row.id);
    end if;
  end loop;

  update connector_saves
  set status = 'completed',
      message_source_id = v_message_source_id,
      attachment_source_ids = v_attachment_source_ids,
      reaction_status = 'pending',
      last_error = null,
      completed_at = now(),
      updated_at = now()
  where id = save_row.id
  returning * into save_row;
  return distillery_connector_save_json(save_row);
end;
$$;

create or replace function distillery_record_slack_connector_failure(
  p_save_id text,
  p_error_code text,
  p_user_message text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
  next_retry integer;
  event_id text;
  work_id text;
begin
  select * into save_row from connector_saves where id = p_save_id for update;
  if save_row.id is null then raise exception 'connector save not found'; end if;
  if save_row.status = 'completed' then
    return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', null);
  end if;
  next_retry := save_row.retry_count + 1;
  if p_retryable and next_retry < 5 then
    event_id := 'evt_' || gen_random_uuid()::text;
    work_id := 'work_' || gen_random_uuid()::text;
    insert into ledger_events(
      id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
      input_version, idempotency_key, payload
    ) values (
      event_id, save_row.tenant_id, 'slack_save_requested', 'connector_save', save_row.id,
      'system', 'Slack connector retry', 'retry:' || next_retry,
      'slack-save-retry:' || save_row.id || ':' || next_retry,
      jsonb_build_object('connectorSaveId', save_row.id, 'retryCount', next_retry, 'errorCode', p_error_code)
    );
    insert into event_outbox(id, tenant_id, ledger_event_id)
    values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, event_id);
    insert into pending_work(
      id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version
    ) values (
      work_id, save_row.tenant_id, 'ingest_slack_source', 'connector_save', save_row.id,
      event_id, 'retry:' || next_retry
    );
  end if;
  update connector_saves
  set status = case when p_retryable and next_retry < 5 then 'pending' else 'failed' end,
      retry_count = next_retry,
      work_item_id = work_id,
      last_error = left(p_error_code || ': ' || p_user_message, 1000),
      updated_at = now()
  where id = save_row.id
  returning * into save_row;
  return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', work_id);
end;
$$;

create or replace function distillery_mark_slack_reaction_added(p_save_id text)
returns void
language plpgsql
security definer
as $$
begin
  update connector_saves
  set reaction_status = 'added', last_error = null, updated_at = now()
  where id = p_save_id and status = 'completed';
  if not found then raise exception 'completed connector save not found'; end if;
end;
$$;

create or replace function distillery_record_slack_reaction_failure(
  p_save_id text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
  next_retry integer;
  event_id text;
  work_id text;
begin
  select * into save_row from connector_saves where id = p_save_id for update;
  if save_row.id is null or save_row.status <> 'completed' then raise exception 'completed connector save not found'; end if;
  next_retry := save_row.reaction_retry_count + 1;
  if next_retry < 5 then
    event_id := 'evt_' || gen_random_uuid()::text;
    work_id := 'work_' || gen_random_uuid()::text;
    insert into ledger_events(
      id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
      input_version, idempotency_key, payload
    ) values (
      event_id, save_row.tenant_id, 'slack_reaction_retry_requested', 'connector_save', save_row.id,
      'system', 'Slack reaction retry', 'reaction-retry:' || next_retry,
      'slack-reaction-retry:' || save_row.id || ':' || next_retry,
      jsonb_build_object('connectorSaveId', save_row.id, 'retryCount', next_retry, 'errorCode', p_error_code)
    );
    insert into event_outbox(id, tenant_id, ledger_event_id)
    values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, event_id);
    insert into pending_work(
      id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version
    ) values (
      work_id, save_row.tenant_id, 'sync_slack_reaction', 'connector_save', save_row.id,
      event_id, 'reaction-retry:' || next_retry
    );
  end if;
  update connector_saves
  set reaction_status = 'failed',
      reaction_retry_count = next_retry,
      work_item_id = coalesce(work_id, work_item_id),
      last_error = left('reaction: ' || p_error_code, 1000),
      updated_at = now()
  where id = save_row.id
  returning * into save_row;
  return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', work_id);
end;
$$;

create or replace function distillery_list_pending_connector_work(
  p_tenant_id text default 'stable',
  p_limit integer default 25
)
returns jsonb
language sql
security definer
as $$
  select coalesce(jsonb_agg(distillery_pending_work_to_json(selected.work_row) order by selected.created_at), '[]'::jsonb)
  from (
    select pw as work_row, pw.created_at
    from pending_work pw
    where pw.tenant_id = p_tenant_id
      and pw.policy in ('ingest_slack_source', 'sync_slack_reaction')
      and pw.status = 'pending'
    order by pw.created_at
    limit least(greatest(p_limit, 1), 100)
  ) selected;
$$;

create or replace function distillery_first_sentence(p_text text)
returns text
language sql
immutable
as $$
  select case
    when trim(p_text) ~ '[.!?]' then substring(trim(p_text) from '^[^.!?]*[.!?]')
    else left(trim(p_text), 320) || '.'
  end;
$$;

create or replace function distillery_two_sentence_summary(p_problem text, p_proposal text)
returns text
language sql
immutable
as $$
  select trim(distillery_first_sentence(p_problem) || ' ' || distillery_first_sentence(p_proposal));
$$;

create or replace function distillery_leadership_brief_json(p_brief initiative_briefs)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_brief.id,
    'title', p_brief.title,
    'summary', distillery_two_sentence_summary(p_brief.problem, p_brief.proposal),
    'whyGenerated', coalesce(p_brief.generation_reason, 'Distillery generated this brief from evidence-backed memory.'),
    'status', p_brief.status,
    'supportingSourceCount', (
      select count(distinct sv.source_item_id)
      from initiative_brief_evidence ibe
      join evidence_spans es on es.id = ibe.evidence_span_id
      join source_versions sv on sv.id = es.source_version_id
      where ibe.brief_id = p_brief.id
    ),
    'createdAt', p_brief.created_at,
    'updatedAt', p_brief.updated_at,
    'executiveSummary', distillery_two_sentence_summary(p_brief.problem, p_brief.proposal),
    'whatIsHappening', p_brief.problem,
    'decisionsAndCommitments', p_brief.proposal,
    'risks', coalesce((
      select jsonb_agg(mi.statement order by mi.created_at, mi.id)
      from initiative_brief_memory ibm
      join memory_items mi on mi.id = ibm.memory_item_id
      where ibm.brief_id = p_brief.id and mi.claim_type = 'risk'
    ), case when coalesce(p_brief.risks_and_dependencies, '') = '' then '[]'::jsonb else jsonb_build_array(p_brief.risks_and_dependencies) end),
    'dependencies', coalesce((
      select jsonb_agg(mi.statement order by mi.created_at, mi.id)
      from initiative_brief_memory ibm
      join memory_items mi on mi.id = ibm.memory_item_id
      where ibm.brief_id = p_brief.id and mi.claim_type = 'dependency'
    ), '[]'::jsonb),
    'openQuestions', coalesce((
      select sre.missing_information
      from suggested_brief_versions sbv
      join synthesis_readiness_evaluations sre
        on sre.tenant_id = sbv.tenant_id
       and sre.cluster_id = sbv.cluster_id
       and sre.cluster_version = sbv.cluster_version
       and sre.generation_intent = sbv.generation_intent
      where sbv.initiative_brief_id = p_brief.id
      order by sbv.version desc, sre.evaluated_at desc
      limit 1
    ), '[]'::jsonb),
    'conflictingEvidence', coalesce((
      select case
        when jsonb_array_length(sbv.contradictions) > 0 then (
          select jsonb_agg(coalesce(item->>'summary', item::text)) from jsonb_array_elements(sbv.contradictions) item
        )
        else coalesce(sbv.structured_draft->'contradictionsOrUncertainties', '[]'::jsonb)
      end
      from suggested_brief_versions sbv
      where sbv.initiative_brief_id = p_brief.id
      order by sbv.version desc
      limit 1
    ), '[]'::jsonb),
    'citations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'evidenceSpanId', es.id,
        'sourceVersionId', es.source_version_id,
        'sourceType', si.source_type,
        'authorOrTitle', coalesce(si.original_filename, si.author_label, si.source_metadata->>'authorLabel', 'Slack source'),
        'occurredAt', coalesce(si.occurred_at, sv.created_at),
        'exactText', es.text,
        'locator', coalesce(es.locator, '{}'::jsonb),
        'originalUrl', si.canonical_url
      ) order by coalesce(si.occurred_at, sv.created_at), es.start_char, es.id)
      from initiative_brief_evidence ibe
      join evidence_spans es on es.id = ibe.evidence_span_id
      join source_versions sv on sv.id = es.source_version_id
      join source_items si on si.id = sv.source_item_id
      where ibe.brief_id = p_brief.id
    ), '[]'::jsonb),
    'memoryItemIds', coalesce((
      select jsonb_agg(ibm.memory_item_id order by ibm.created_at, ibm.memory_item_id)
      from initiative_brief_memory ibm where ibm.brief_id = p_brief.id
    ), '[]'::jsonb),
    'evidenceSpanIds', coalesce((
      select jsonb_agg(ibe.evidence_span_id order by ibe.created_at, ibe.evidence_span_id)
      from initiative_brief_evidence ibe where ibe.brief_id = p_brief.id
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_list_leadership_briefs(
  p_tenant_id text default 'stable',
  p_limit integer default 50
)
returns jsonb
language sql
security definer
as $$
  select coalesce(jsonb_agg(distillery_leadership_brief_json(selected.brief_row) order by selected.updated_at desc, selected.id), '[]'::jsonb)
  from (
    select ib as brief_row, ib.updated_at, ib.id
    from initiative_briefs ib
    where ib.tenant_id = p_tenant_id
      and ib.origin = 'distillery_generated'
      and ib.status in ('draft', 'approved')
    order by ib.updated_at desc, ib.id
    limit least(greatest(p_limit, 1), 100)
  ) selected;
$$;

create or replace function distillery_get_leadership_brief(
  p_tenant_id text,
  p_brief_id text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  brief_row initiative_briefs%rowtype;
begin
  select * into brief_row
  from initiative_briefs
  where id = p_brief_id
    and tenant_id = p_tenant_id
    and origin = 'distillery_generated'
    and status in ('draft', 'approved');
  if brief_row.id is null then raise exception 'leadership brief not found'; end if;
  return distillery_leadership_brief_json(brief_row);
end;
$$;

notify pgrst, 'reload schema';
