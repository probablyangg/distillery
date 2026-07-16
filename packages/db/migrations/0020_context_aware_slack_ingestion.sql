-- Context-aware Slack ingestion. This migration is additive: every Slack
-- message remains an immutable source version, while a normalized bundle
-- records its role in one bounded conversation snapshot.

alter table source_items drop constraint if exists source_items_source_type_check;
alter table source_items add constraint source_items_source_type_check check (
  source_type in ('text_braindump', 'slack_message', 'slack_channel_profile', 'slack_file_pdf', 'slack_file_docx')
);

alter table pending_work drop constraint if exists pending_work_policy_check;
alter table pending_work add constraint pending_work_policy_check check (policy in (
  'ingest_slack_source', 'extract_slack_context', 'sync_slack_reaction',
  'extract_memory', 'extract_memory_section', 'consolidate_memory', 'connect_memory',
  'discover_candidate', 'check_freshness', 'detect_contradiction', 'update_embeddings',
  'update_graph', 'recompute_cluster', 'evaluate_synthesis_readiness', 'synthesize_brief',
  'rank_candidate', 'draft_artifact', 'gate_output', 'revise_artifact'
));

alter table ledger_events drop constraint if exists ledger_events_event_type_check;
alter table ledger_events add constraint ledger_events_event_type_check check (event_type in (
  'slack_save_requested', 'slack_context_committed', 'slack_extraction_completed', 'slack_reaction_retry_requested',
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
  subject_type in ('connector_save', 'context_bundle', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table pending_work drop constraint if exists pending_work_subject_type_check;
alter table pending_work add constraint pending_work_subject_type_check check (
  subject_type in ('connector_save', 'context_bundle', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table proposed_events drop constraint if exists proposed_events_subject_type_check;
alter table proposed_events add constraint proposed_events_subject_type_check check (
  subject_type in ('connector_save', 'context_bundle', 'source', 'section', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);

create unique index if not exists source_versions_item_hash_idx
  on source_versions(source_item_id, content_hash);

create unique index if not exists connector_saves_message_identity_idx
  on connector_saves(tenant_id, provider, workspace_id, channel_id, message_timestamp);

create table if not exists slack_context_bundles (
  id text primary key,
  connector_save_id text not null references connector_saves(id),
  previous_bundle_id text references slack_context_bundles(id),
  version integer not null check (version >= 1),
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  channel_id text not null,
  selected_message_timestamp text not null,
  thread_timestamp text,
  channel_profile jsonb not null,
  selection_strategy text not null check (selection_strategy in ('thread', 'nearby', 'selected_only')),
  selection_version text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null,
  externally_shared boolean not null default false,
  truncation jsonb not null default '{}'::jsonb,
  classification jsonb not null default '{}'::jsonb,
  skipped_attachments jsonb not null default '[]'::jsonb,
  selected_ingestion_id text not null references ingestions(id),
  selected_source_version_id text not null references source_versions(id),
  created_at timestamptz not null default now(),
  unique (connector_save_id, version),
  unique (connector_save_id, content_hash)
);

create table if not exists slack_context_bundle_items (
  id text primary key,
  bundle_id text not null references slack_context_bundles(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  role text not null check (role in (
    'selected_message', 'thread_root', 'thread_reply', 'nearby_context',
    'channel_profile', 'supported_attachment', 'linked_artifact'
  )),
  source_item_id text not null references source_items(id),
  source_version_id text not null references source_versions(id),
  selection_reason text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (bundle_id, ordinal),
  unique (bundle_id, source_version_id, role)
);

create unique index if not exists slack_context_bundle_one_primary_idx
  on slack_context_bundle_items(bundle_id) where is_primary;
create index if not exists slack_context_bundle_thread_idx
  on slack_context_bundles(tenant_id, workspace_id, channel_id, coalesce(thread_timestamp, selected_message_timestamp), version desc);

alter table connector_saves
  add column if not exists current_context_bundle_id text references slack_context_bundles(id),
  add column if not exists context_version integer not null default 0 check (context_version >= 0),
  add column if not exists externally_shared boolean not null default false;

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
    'currentContextBundleId', p_save.current_context_bundle_id,
    'contextVersion', p_save.context_version,
    'reactionStatus', p_save.reaction_status,
    'retryCount', p_save.retry_count,
    'reactionRetryCount', p_save.reaction_retry_count,
    'lastError', p_save.last_error,
    'createdAt', p_save.created_at,
    'updatedAt', p_save.updated_at,
    'completedAt', p_save.completed_at
  ));
$$;

create or replace function distillery_slack_context_bundle_json(p_bundle slack_context_bundles)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_bundle.id,
    'connectorSaveId', p_bundle.connector_save_id,
    'previousBundleId', p_bundle.previous_bundle_id,
    'version', p_bundle.version,
    'tenantId', p_bundle.tenant_id,
    'workspaceId', p_bundle.workspace_id,
    'channelId', p_bundle.channel_id,
    'selectedMessageTimestamp', p_bundle.selected_message_timestamp,
    'threadTimestamp', p_bundle.thread_timestamp,
    'channelProfile', p_bundle.channel_profile,
    'selectionStrategy', p_bundle.selection_strategy,
    'selectionVersion', p_bundle.selection_version,
    'contentHash', p_bundle.content_hash,
    'capturedAt', p_bundle.captured_at,
    'externallyShared', p_bundle.externally_shared,
    'truncation', p_bundle.truncation,
    'classification', p_bundle.classification,
    'skippedAttachments', p_bundle.skipped_attachments,
    'selectedIngestionId', p_bundle.selected_ingestion_id,
    'selectedSourceVersionId', p_bundle.selected_source_version_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'ordinal', item.ordinal,
        'role', item.role,
        'sourceItemId', item.source_item_id,
        'sourceVersionId', item.source_version_id,
        'externalId', source_item.external_id,
        'selectionReason', item.selection_reason,
        'primary', item.is_primary,
        'authorId', coalesce(source_version.source_metadata->>'authorId', source_item.author_id),
        'authorLabel', coalesce(source_version.source_metadata->>'authorLabel', source_item.author_label),
        'occurredAt', coalesce(source_version.source_metadata->>'occurredAt', source_item.occurred_at::text, source_version.created_at::text),
        'permalink', coalesce(
          source_version.source_metadata->>'permalink',
          source_version.source_metadata->>'messagePermalink',
          source_item.canonical_url
        ),
        'content', source_version.content,
        'sourceMetadata', source_version.source_metadata,
        'evidenceSpans', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', span.id,
            'sourceVersionId', span.source_version_id,
            'startLine', span.start_line,
            'endLine', span.end_line,
            'startChar', span.start_char,
            'endChar', span.end_char,
            'text', span.text,
            'locator', span.locator
          ) order by span.start_char, span.id)
          from evidence_spans span where span.source_version_id = item.source_version_id
        ), '[]'::jsonb)
      ) order by item.ordinal)
      from slack_context_bundle_items item
      join source_items source_item on source_item.id = item.source_item_id
      join source_versions source_version on source_version.id = item.source_version_id
      where item.bundle_id = p_bundle.id
    ), '[]'::jsonb),
    'createdAt', p_bundle.created_at
  );
$$;

create or replace function distillery_get_slack_context_bundle(p_bundle_id text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  bundle_row slack_context_bundles%rowtype;
begin
  select * into bundle_row from slack_context_bundles where id = p_bundle_id;
  if bundle_row.id is null then raise exception 'Slack context bundle not found'; end if;
  return distillery_slack_context_bundle_json(bundle_row);
end;
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
  existing_work pending_work%rowtype;
  event_id text;
  work_id text;
begin
  if p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid Slack request hash'; end if;
  if p_external_source_id <> 'slack_message:' || p_workspace_id || ':' || p_channel_id || ':' || p_message_timestamp then
    raise exception 'invalid canonical Slack message identity';
  end if;
  insert into tenants(id, name) values (p_tenant_id, 'Stable') on conflict (id) do nothing;

  select * into prior_receipt from slack_interaction_receipts where request_hash = p_request_hash;
  if prior_receipt.request_hash is not null then
    select * into save_row from connector_saves where id = prior_receipt.connector_save_id;
    return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', null, 'created', false, 'replayed', true);
  end if;

  select * into save_row
  from connector_saves
  where tenant_id = p_tenant_id and provider = 'slack'
    and workspace_id = p_workspace_id and channel_id = p_channel_id and message_timestamp = p_message_timestamp
  for update;

  if save_row.id is null then
    insert into connector_saves(
      id, tenant_id, provider, workspace_id, channel_id, message_timestamp,
      thread_timestamp, invoking_user_id, response_url, external_source_id
    ) values (
      'csave_' || gen_random_uuid()::text, p_tenant_id, 'slack', p_workspace_id,
      p_channel_id, p_message_timestamp, nullif(p_thread_timestamp, ''), p_invoking_user_id,
      nullif(p_response_url, ''), p_external_source_id
    )
    on conflict do nothing
    returning * into save_row;
    if save_row.id is null then
      select * into save_row
      from connector_saves
      where tenant_id = p_tenant_id and provider = 'slack'
        and workspace_id = p_workspace_id and channel_id = p_channel_id and message_timestamp = p_message_timestamp
      for update;
    end if;
  end if;

  update connector_saves
  set external_source_id = p_external_source_id,
      invoking_user_id = p_invoking_user_id,
      response_url = coalesce(nullif(p_response_url, ''), response_url),
      thread_timestamp = coalesce(thread_timestamp, nullif(p_thread_timestamp, '')),
      updated_at = now()
  where id = save_row.id
  returning * into save_row;

  insert into slack_interaction_receipts(request_hash, tenant_id, connector_save_id)
  values (p_request_hash, p_tenant_id, save_row.id)
  on conflict (request_hash) do nothing;

  select * into existing_work
  from pending_work
  where tenant_id = p_tenant_id and policy = 'ingest_slack_source'
    and subject_type = 'connector_save' and subject_id = save_row.id
    and status in ('pending', 'running')
  order by created_at desc limit 1;
  if existing_work.id is not null then
    return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', existing_work.id, 'created', false, 'replayed', false);
  end if;

  event_id := 'evt_' || gen_random_uuid()::text;
  work_id := 'work_' || gen_random_uuid()::text;
  insert into ledger_events(
    id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
    input_version, idempotency_key, payload
  ) values (
    event_id, p_tenant_id, 'slack_save_requested', 'connector_save', save_row.id,
    'connector', 'Slack message shortcut', p_request_hash, 'slack-interaction:' || p_request_hash,
    jsonb_build_object('connectorSaveId', save_row.id, 'workspaceId', p_workspace_id, 'channelId', p_channel_id, 'messageTimestamp', p_message_timestamp)
  );
  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, p_tenant_id, event_id)
  on conflict (ledger_event_id) do nothing;
  insert into pending_work(id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version)
  values (work_id, p_tenant_id, 'ingest_slack_source', 'connector_save', save_row.id, event_id, p_request_hash);

  update connector_saves
  set status = 'pending', work_item_id = work_id, reaction_status = 'pending', last_error = null, updated_at = now()
  where id = save_row.id returning * into save_row;
  return jsonb_build_object('save', distillery_connector_save_json(save_row), 'workItemId', work_id, 'created', true, 'replayed', false);
end;
$$;

create or replace function distillery_mark_slack_connector_processing(p_save_id text)
returns void
language plpgsql
security definer
as $$
begin
  update connector_saves set status = 'processing', updated_at = now() where id = p_save_id;
  if not found then raise exception 'connector save not found'; end if;
end;
$$;

create or replace function distillery_commit_slack_context_bundle(p_context jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  save_row connector_saves%rowtype;
  bundle_row slack_context_bundles%rowtype;
  source jsonb;
  item jsonb;
  span jsonb;
  source_item_row source_items%rowtype;
  source_version_row source_versions%rowtype;
  ingestion_id text;
  requested_version_id text;
  actual_version_id text;
  next_version integer;
  next_bundle_version integer;
  version_map jsonb := '{}'::jsonb;
  item_map jsonb := '{}'::jsonb;
  selected_requested_version_id text;
  selected_actual_version_id text;
  selected_source_item_id text;
  selected_ingestion_id text;
  event_id text;
  committed_attachment_source_ids jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_context) <> 'object' then raise exception 'Slack context must be an object'; end if;
  select * into save_row from connector_saves where id = p_context->>'saveId' for update;
  if save_row.id is null then raise exception 'connector save not found'; end if;
  if coalesce(p_context->>'contentHash', '') !~ '^[a-f0-9]{64}$' then raise exception 'invalid Slack context hash'; end if;
  if p_context->>'selectedMessageTimestamp' <> save_row.message_timestamp then raise exception 'selected message does not match connector save'; end if;
  if jsonb_typeof(p_context->'sources') <> 'array' or jsonb_array_length(p_context->'sources') < 2 or jsonb_array_length(p_context->'sources') > 60 then
    raise exception 'Slack context requires two to sixty sources';
  end if;
  if jsonb_typeof(p_context->'items') <> 'array' or jsonb_array_length(p_context->'items') < 2 or jsonb_array_length(p_context->'items') > 70 then
    raise exception 'Slack context requires two to seventy items';
  end if;
  if (select count(*) from jsonb_array_elements(p_context->'items') value where (value->>'primary')::boolean) <> 1 then
    raise exception 'Slack context requires exactly one primary item';
  end if;
  select value->>'requestedSourceVersionId' into selected_requested_version_id
  from jsonb_array_elements(p_context->'items') value
  where (value->>'primary')::boolean and value->>'role' = 'selected_message';
  if selected_requested_version_id is null then raise exception 'Slack context primary must be selected_message'; end if;

  select * into bundle_row
  from slack_context_bundles
  where connector_save_id = save_row.id and content_hash = p_context->>'contentHash';
  if bundle_row.id is not null then
    update connector_saves
    set status = 'completed', current_context_bundle_id = bundle_row.id,
        context_version = bundle_row.version, reaction_status = 'pending', last_error = null,
        completed_at = now(), updated_at = now()
    where id = save_row.id;
    return jsonb_build_object('bundle', distillery_slack_context_bundle_json(bundle_row), 'created', false, 'changed', false);
  end if;

  for source in select * from jsonb_array_elements(p_context->'sources')
  loop
    if source->>'sourceType' not in ('slack_message', 'slack_channel_profile', 'slack_file_pdf', 'slack_file_docx') then
      raise exception 'unsupported Slack context source type';
    end if;
    if length(coalesce(source->>'content', '')) > 200000 then raise exception 'Slack source content exceeds limit'; end if;
    if coalesce(source->>'externalId', '') = '' or coalesce(source->>'contentHash', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'Slack source identity or hash is invalid';
    end if;
    requested_version_id := source->>'sourceVersionId';

    insert into source_items(
      id, tenant_id, source_type, content_hash, provider, external_id, canonical_url,
      author_id, author_label, occurred_at, mime_type, original_filename, source_metadata
    ) values (
      source->>'sourceItemId', save_row.tenant_id, source->>'sourceType', source->>'contentHash',
      'slack', source->>'externalId', source->>'canonicalUrl', nullif(source->>'authorId', ''),
      nullif(source->>'authorLabel', ''), (source->>'occurredAt')::timestamptz,
      source->>'mimeType', nullif(source->>'originalFilename', ''), coalesce(source->'sourceMetadata', '{}'::jsonb)
    )
    on conflict (tenant_id, provider, external_id) where provider is not null and external_id is not null
    do update set external_id = excluded.external_id
    returning * into source_item_row;

    select * into source_version_row
    from source_versions
    where source_item_id = source_item_row.id and content_hash = source->>'contentHash'
    order by version desc limit 1;

    if source_version_row.id is null then
      ingestion_id := source->>'ingestionId';
      insert into ingestions(
        id, tenant_id, app_session_id, submitted_by_label, input_type, idempotency_key, status
      ) values (
        ingestion_id, save_row.tenant_id, save_row.id, coalesce(source->>'authorLabel', 'Slack source'),
        'slack', 'slack-source:' || (source->>'externalId') || ':' || (source->>'contentHash'), 'evidence_stored'
      ) on conflict (tenant_id, idempotency_key) do update set updated_at = ingestions.updated_at
      returning id into ingestion_id;

      select coalesce(max(version), 0) + 1 into next_version from source_versions where source_item_id = source_item_row.id;
      insert into source_versions(
        id, tenant_id, source_item_id, ingestion_id, version, content, content_hash, source_metadata
      ) values (
        requested_version_id, save_row.tenant_id, source_item_row.id, ingestion_id, next_version,
        source->>'content', source->>'contentHash', coalesce(source->'sourceMetadata', '{}'::jsonb)
      )
      on conflict (source_item_id, content_hash) do nothing
      returning * into source_version_row;

      if source_version_row.id is null then
        select * into source_version_row from source_versions
        where source_item_id = source_item_row.id and content_hash = source->>'contentHash';
      else
        for span in select * from jsonb_array_elements(coalesce(source->'evidenceSpans', '[]'::jsonb))
        loop
          if span->>'sourceVersionId' <> requested_version_id then raise exception 'evidence span source mismatch'; end if;
          if (span->>'startChar')::integer < 0
            or (span->>'endChar')::integer < (span->>'startChar')::integer
            or substring(source->>'content' from (span->>'startChar')::integer + 1 for (span->>'endChar')::integer - (span->>'startChar')::integer) <> span->>'text'
          then raise exception 'evidence span offsets do not match source content'; end if;
          insert into evidence_spans(
            id, tenant_id, source_version_id, start_line, end_line, start_char, end_char, text, locator
          ) values (
            span->>'id', save_row.tenant_id, source_version_row.id,
            (span->>'startLine')::integer, (span->>'endLine')::integer,
            (span->>'startChar')::integer, (span->>'endChar')::integer,
            span->>'text', coalesce(span->'locator', '{}'::jsonb)
          );
        end loop;
      end if;
    end if;

    actual_version_id := source_version_row.id;
    version_map := version_map || jsonb_build_object(requested_version_id, actual_version_id);
    item_map := item_map || jsonb_build_object(requested_version_id, source_item_row.id);
    update source_items
    set content_hash = source->>'contentHash', canonical_url = source->>'canonicalUrl',
        author_id = coalesce(nullif(source->>'authorId', ''), author_id),
        author_label = coalesce(nullif(source->>'authorLabel', ''), author_label),
        occurred_at = coalesce((source->>'occurredAt')::timestamptz, occurred_at),
        mime_type = source->>'mimeType',
        original_filename = coalesce(nullif(source->>'originalFilename', ''), original_filename),
        source_metadata = coalesce(source->'sourceMetadata', source_metadata)
    where id = source_item_row.id;
  end loop;

  selected_actual_version_id := version_map->>selected_requested_version_id;
  selected_source_item_id := item_map->>selected_requested_version_id;
  select source_version.ingestion_id into selected_ingestion_id
  from source_versions source_version
  where source_version.id = selected_actual_version_id;
  if selected_actual_version_id is null or selected_ingestion_id is null then raise exception 'selected Slack source was not committed'; end if;

  select coalesce(max(version), 0) + 1 into next_bundle_version
  from slack_context_bundles where connector_save_id = save_row.id;
  insert into slack_context_bundles(
    id, connector_save_id, previous_bundle_id, version, tenant_id, workspace_id, channel_id,
    selected_message_timestamp, thread_timestamp, channel_profile, selection_strategy,
    selection_version, content_hash, captured_at, externally_shared, truncation,
    classification, skipped_attachments, selected_ingestion_id, selected_source_version_id
  ) values (
    p_context->>'id', save_row.id, save_row.current_context_bundle_id, next_bundle_version,
    save_row.tenant_id, save_row.workspace_id, save_row.channel_id, save_row.message_timestamp,
    nullif(p_context->>'threadTimestamp', ''), p_context->'channelProfile', p_context->>'selectionStrategy',
    p_context->>'selectionVersion', p_context->>'contentHash', (p_context->>'capturedAt')::timestamptz,
    (p_context->>'externallyShared')::boolean, p_context->'truncation', p_context->'classification',
    coalesce(p_context->'skippedAttachments', '[]'::jsonb), selected_ingestion_id, selected_actual_version_id
  ) returning * into bundle_row;

  for item in select * from jsonb_array_elements(p_context->'items')
  loop
    actual_version_id := version_map->>(item->>'requestedSourceVersionId');
    if actual_version_id is null then raise exception 'Slack context item references unknown source version'; end if;
    insert into slack_context_bundle_items(
      id, bundle_id, ordinal, role, source_item_id, source_version_id, selection_reason, is_primary
    ) values (
      item->>'id', bundle_row.id, (item->>'ordinal')::integer, item->>'role',
      item_map->>(item->>'requestedSourceVersionId'), actual_version_id,
      nullif(item->>'selectionReason', ''), (item->>'primary')::boolean
    );
    if item->>'role' = 'supported_attachment' then
      committed_attachment_source_ids := committed_attachment_source_ids || jsonb_build_array(item_map->>(item->>'requestedSourceVersionId'));
    end if;
  end loop;

  event_id := 'evt_' || gen_random_uuid()::text;
  insert into ledger_events(
    id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
    input_version, idempotency_key, payload
  ) values (
    event_id, save_row.tenant_id, 'slack_context_committed', 'context_bundle', bundle_row.id,
    'connector', 'Slack context assembler', bundle_row.content_hash,
    'slack-context:' || save_row.id || ':' || bundle_row.content_hash,
    jsonb_build_object(
      'connectorSaveId', save_row.id,
      'contextBundleId', bundle_row.id,
      'contextVersion', bundle_row.version,
      'selectedSourceVersionId', selected_actual_version_id,
      'classification', bundle_row.classification->>'category'
    )
  );
  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, event_id)
  on conflict (ledger_event_id) do nothing;

  update connector_saves
  set status = 'completed', message_source_id = selected_source_item_id,
      attachment_source_ids = committed_attachment_source_ids, current_context_bundle_id = bundle_row.id,
      context_version = bundle_row.version, externally_shared = bundle_row.externally_shared,
      reaction_status = 'pending', last_error = null, completed_at = now(), updated_at = now()
  where id = save_row.id;

  return jsonb_build_object('bundle', distillery_slack_context_bundle_json(bundle_row), 'created', true, 'changed', true);
end;
$$;

create or replace function distillery_is_slack_connector_extraction_complete(p_save_id text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from connector_saves save
    join pending_work work
      on work.tenant_id = save.tenant_id
     and work.policy = 'extract_slack_context'
     and work.subject_type = 'context_bundle'
     and work.subject_id = save.current_context_bundle_id
     and work.status = 'completed'
    where save.id = p_save_id and save.status = 'completed'
  );
$$;

create or replace function distillery_ensure_slack_reaction_sync_for_work(p_completed_work_id text)
returns void
language plpgsql
security definer
as $$
declare
  completed_work pending_work%rowtype;
  save_row connector_saves%rowtype;
  event_id text;
  work_id text;
begin
  select * into completed_work from pending_work where id = p_completed_work_id and status = 'completed';
  if completed_work.id is null or completed_work.policy not in ('ingest_slack_source', 'extract_slack_context') then return; end if;

  for save_row in
    select save.* from connector_saves save
    where save.status = 'completed' and save.reaction_status <> 'added'
      and (
        (completed_work.policy = 'ingest_slack_source' and completed_work.subject_id = save.id)
        or
        (completed_work.policy = 'extract_slack_context' and completed_work.subject_id = save.current_context_bundle_id)
      )
  loop
    if not distillery_is_slack_connector_extraction_complete(save_row.id) then continue; end if;
    if exists (
      select 1 from pending_work work
      where work.policy = 'sync_slack_reaction' and work.subject_id = save_row.id
        and work.status in ('pending', 'running')
    ) then continue; end if;

    event_id := 'evt_' || gen_random_uuid()::text;
    insert into ledger_events(
      id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
      input_version, idempotency_key, payload
    ) values (
      event_id, save_row.tenant_id, 'slack_extraction_completed', 'connector_save', save_row.id,
      'system', 'Slack context extraction completion', 'context-complete:' || save_row.current_context_bundle_id,
      'slack-extraction-complete:' || save_row.id || ':' || save_row.current_context_bundle_id,
      jsonb_build_object(
        'connectorSaveId', save_row.id,
        'contextBundleId', save_row.current_context_bundle_id,
        'contextVersion', save_row.context_version,
        'completedWorkItemId', p_completed_work_id
      )
    ) on conflict (tenant_id, idempotency_key) do nothing returning id into event_id;
    if event_id is null then continue; end if;
    insert into event_outbox(id, tenant_id, ledger_event_id)
    values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, event_id)
    on conflict (ledger_event_id) do nothing;
    work_id := 'work_' || gen_random_uuid()::text;
    insert into pending_work(id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version)
    values (
      work_id, save_row.tenant_id, 'sync_slack_reaction', 'connector_save', save_row.id,
      event_id, 'context-complete:' || save_row.current_context_bundle_id
    );
  end loop;
end;
$$;

notify pgrst, 'reload schema';
