-- Distillery v0 Memory Generation schema.
-- Apply from local/CI with DATABASE_DIRECT_URL, not from the Cloudflare Worker.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists app_sessions (
  id text primary key,
  tenant_id text not null references tenants(id),
  created_at timestamptz not null default now()
);

create table if not exists ingestions (
  id text primary key,
  tenant_id text not null references tenants(id),
  app_session_id text not null,
  submitted_by_label text,
  input_type text not null check (input_type = 'text'),
  idempotency_key text not null,
  status text not null check (
    status in (
      'received',
      'evidence_stored',
      'generating',
      'validating',
      'memory_stored',
      'ready',
      'failed'
    )
  ),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table if not exists source_items (
  id text primary key,
  tenant_id text not null references tenants(id),
  source_type text not null check (source_type = 'text_braindump'),
  content_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists source_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  source_item_id text not null references source_items(id),
  ingestion_id text not null references ingestions(id),
  version integer not null default 1,
  content text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_item_id, version)
);

create table if not exists evidence_spans (
  id text primary key,
  tenant_id text not null references tenants(id),
  source_version_id text not null references source_versions(id),
  start_line integer not null,
  end_line integer not null,
  start_char integer not null,
  end_char integer not null,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists extraction_runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  ingestion_id text not null references ingestions(id),
  provider text not null,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  raw_response jsonb not null,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists memory_items (
  id text primary key,
  tenant_id text not null references tenants(id),
  ingestion_id text not null references ingestions(id),
  source_version_id text not null references source_versions(id),
  extraction_run_id text not null references extraction_runs(id),
  memory_type text not null,
  statement text not null,
  epistemic_status text not null,
  qualifiers jsonb not null default '{}'::jsonb,
  stable_domain_tags jsonb not null default '[]'::jsonb,
  memory_generation_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists memory_item_evidence (
  memory_item_id text not null references memory_items(id) on delete cascade,
  evidence_span_id text not null references evidence_spans(id),
  tenant_id text not null references tenants(id),
  created_at timestamptz not null default now(),
  primary key (memory_item_id, evidence_span_id)
);

create table if not exists outbox_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  event_type text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id text primary key default ('audit_' || gen_random_uuid()::text),
  tenant_id text not null references tenants(id),
  actor_label text,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists workflow_runs (
  id text primary key default ('wfr_' || gen_random_uuid()::text),
  tenant_id text not null references tenants(id),
  workflow_type text not null,
  entity_id text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists evidence_spans_source_version_idx on evidence_spans(source_version_id);
create index if not exists memory_items_ingestion_idx on memory_items(ingestion_id);
create index if not exists outbox_events_unpublished_idx on outbox_events(created_at) where published_at is null;

create or replace function distillery_get_ingestion_result(p_ingestion_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'ingestionId', i.id,
    'status', i.status,
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
    ), '[]'::jsonb),
    'memoryItems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mi.id,
        'ingestionId', mi.ingestion_id,
        'sourceVersionId', mi.source_version_id,
        'type', mi.memory_type,
        'statement', mi.statement,
        'evidenceSpanIds', coalesce((
          select jsonb_agg(mie.evidence_span_id order by mie.evidence_span_id)
          from memory_item_evidence mie
          where mie.memory_item_id = mi.id
        ), '[]'::jsonb),
        'epistemicStatus', mi.epistemic_status,
        'qualifiers', mi.qualifiers,
        'stableDomainTags', mi.stable_domain_tags
      ) order by mi.created_at, mi.id)
      from memory_items mi
      where mi.ingestion_id = i.id
    ), '[]'::jsonb),
    'errorMessage', i.error_message
  )
  into result
  from ingestions i
  left join source_versions sv on sv.ingestion_id = i.id
  where i.id = p_ingestion_id;

  if result is null then
    raise exception 'ingestion not found: %', p_ingestion_id;
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

  insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
  values (
    p_tenant_id,
    p_submitted_by_label,
    'ingestion.evidence_stored',
    'ingestion',
    p_ingestion_id,
    jsonb_build_object('sourceVersionId', p_source_version_id)
  );

  return distillery_get_ingestion_result(p_ingestion_id);
end;
$$;

create or replace function distillery_get_ingestion_context(p_ingestion_id text)
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
  from ingestions i
  join source_versions sv on sv.ingestion_id = i.id
  where i.id = p_ingestion_id;

  if result is null then
    raise exception 'ingestion context not found: %', p_ingestion_id;
  end if;

  return result;
end;
$$;

create or replace function distillery_update_ingestion_status(
  p_ingestion_id text,
  p_status text
)
returns void
language plpgsql
security definer
as $$
begin
  update ingestions
  set status = p_status,
      updated_at = now()
  where id = p_ingestion_id;

  if not found then
    raise exception 'ingestion not found: %', p_ingestion_id;
  end if;
end;
$$;

create or replace function distillery_record_extraction_run(
  p_id text,
  p_ingestion_id text,
  p_tenant_id text,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_schema_version text,
  p_raw_response jsonb,
  p_status text
)
returns void
language plpgsql
security definer
as $$
begin
  insert into extraction_runs(
    id,
    tenant_id,
    ingestion_id,
    provider,
    model,
    prompt_version,
    schema_version,
    raw_response,
    status
  )
  values (
    p_id,
    p_tenant_id,
    p_ingestion_id,
    p_provider,
    p_model,
    p_prompt_version,
    p_schema_version,
    p_raw_response,
    p_status
  );
end;
$$;

create or replace function distillery_commit_generated_memory(
  p_ingestion_id text,
  p_tenant_id text,
  p_source_version_id text,
  p_extraction_run_id text,
  p_memory_generation_version text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  item jsonb;
  support_id text;
  memory_item_ids jsonb := '[]'::jsonb;
  event_id text := 'evt_' || gen_random_uuid()::text;
begin
  for item in select * from jsonb_array_elements(p_items)
  loop
    insert into memory_items(
      id,
      tenant_id,
      ingestion_id,
      source_version_id,
      extraction_run_id,
      memory_type,
      statement,
      epistemic_status,
      qualifiers,
      stable_domain_tags,
      memory_generation_version
    )
    values (
      item->>'id',
      p_tenant_id,
      p_ingestion_id,
      p_source_version_id,
      p_extraction_run_id,
      item->>'type',
      item->>'statement',
      item->>'epistemicStatus',
      coalesce(item->'qualifiers', '{}'::jsonb),
      coalesce(item->'stableDomainTags', '[]'::jsonb),
      p_memory_generation_version
    );

    for support_id in select jsonb_array_elements_text(item->'evidenceSpanIds')
    loop
      insert into memory_item_evidence(memory_item_id, evidence_span_id, tenant_id)
      values (item->>'id', support_id, p_tenant_id);
    end loop;

    memory_item_ids := memory_item_ids || jsonb_build_array(item->>'id');
  end loop;

  update ingestions
  set status = 'ready',
      updated_at = now()
  where id = p_ingestion_id;

  insert into outbox_events(id, tenant_id, event_type, payload)
  values (
    event_id,
    p_tenant_id,
    'memory.ready',
    jsonb_build_object(
      'eventId', event_id,
      'tenantId', p_tenant_id,
      'ingestionId', p_ingestion_id,
      'sourceVersionId', p_source_version_id,
      'memoryItemIds', memory_item_ids,
      'memoryGenerationVersion', p_memory_generation_version,
      'createdAt', now()
    )
  );

  insert into audit_events(tenant_id, action, entity_type, entity_id, payload)
  values (
    p_tenant_id,
    'ingestion.memory_ready',
    'ingestion',
    p_ingestion_id,
    jsonb_build_object('memoryItemIds', memory_item_ids)
  );

  return distillery_get_ingestion_result(p_ingestion_id);
end;
$$;

create or replace function distillery_fail_ingestion(
  p_ingestion_id text,
  p_error_message text
)
returns void
language plpgsql
security definer
as $$
begin
  update ingestions
  set status = 'failed',
      error_message = p_error_message,
      updated_at = now()
  where id = p_ingestion_id;

  if not found then
    raise exception 'ingestion not found: %', p_ingestion_id;
  end if;
end;
$$;
