-- Distillery v0 MemGraphRAG-aligned memory schema layer.
-- This is a breaking v0 API migration: memory items return claimType, not type.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'memory_items' and column_name = 'memory_type'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'memory_items' and column_name = 'claim_type'
  ) then
    alter table memory_items rename column memory_type to claim_type;
  elsif not exists (
    select 1 from information_schema.columns
    where table_name = 'memory_items' and column_name = 'claim_type'
  ) then
    alter table memory_items add column claim_type text;
  end if;
end $$;

alter table memory_items
  alter column claim_type set not null;

create table if not exists memory_entities (
  id text primary key,
  memory_item_id text not null references memory_items(id) on delete cascade,
  tenant_id text not null references tenants(id),
  name text not null,
  entity_type text not null,
  canonical_name text,
  created_at timestamptz not null default now()
);

create table if not exists memory_relations (
  id text primary key,
  memory_item_id text not null references memory_items(id) on delete cascade,
  tenant_id text not null references tenants(id),
  subject text not null,
  predicate text not null,
  object text not null,
  evidence_span_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists memory_schemas (
  id text primary key,
  memory_item_id text not null references memory_items(id) on delete cascade,
  tenant_id text not null references tenants(id),
  subject_type text not null,
  predicate text not null,
  object_type text not null,
  status text not null default 'candidate' check (status in ('candidate', 'stable', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists memory_entities_memory_item_idx on memory_entities(memory_item_id);
create index if not exists memory_relations_memory_item_idx on memory_relations(memory_item_id);
create index if not exists memory_schemas_memory_item_idx on memory_schemas(memory_item_id);

create or replace function distillery_memory_semantics_json(p_memory_item_id text)
returns jsonb
language sql
security definer
as $$
  select jsonb_build_object(
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', me.name,
        'entityType', me.entity_type,
        'canonicalName', me.canonical_name
      ) order by me.created_at, me.id)
      from memory_entities me
      where me.memory_item_id = p_memory_item_id
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject', mr.subject,
        'predicate', mr.predicate,
        'object', mr.object,
        'evidenceSpanIds', mr.evidence_span_ids
      ) order by mr.created_at, mr.id)
      from memory_relations mr
      where mr.memory_item_id = p_memory_item_id
    ), '[]'::jsonb),
    'schemas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subjectType', ms.subject_type,
        'predicate', ms.predicate,
        'objectType', ms.object_type,
        'status', ms.status
      ) order by ms.created_at, ms.id)
      from memory_schemas ms
      where ms.memory_item_id = p_memory_item_id
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_memory_item_json(p_memory_item_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', mi.id,
    'ingestionId', mi.ingestion_id,
    'sourceVersionId', mi.source_version_id,
    'claimType', mi.claim_type,
    'statement', mi.statement,
    'evidenceSpanIds', coalesce((
      select jsonb_agg(mie.evidence_span_id order by mie.evidence_span_id)
      from memory_item_evidence mie
      where mie.memory_item_id = mi.id
    ), '[]'::jsonb),
    'epistemicStatus', mi.epistemic_status,
    'qualifiers', mi.qualifiers,
    'stableDomainTags', mi.stable_domain_tags,
    'entities', distillery_memory_semantics_json(mi.id)->'entities',
    'relations', distillery_memory_semantics_json(mi.id)->'relations',
    'schemas', distillery_memory_semantics_json(mi.id)->'schemas',
    'reviewState', case
      when exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type = 'remove'
      ) then 'removed'
      when exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type = 'edit'
      ) then 'superseded'
      when exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type = 'confirm'
      ) then 'confirmed'
      else 'unreviewed'
    end,
    'supersedesMemoryItemId', mi.supersedes_memory_item_id
  )
  into result
  from memory_items mi
  where mi.id = p_memory_item_id;

  if result is null then
    raise exception 'memory item not found: %', p_memory_item_id;
  end if;

  return result;
end;
$$;

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
      select jsonb_agg(distillery_memory_item_json(mi.id) order by mi.created_at, mi.id)
      from memory_items mi
      where mi.ingestion_id = i.id
        and not exists (
          select 1 from memory_item_events mievt
          where mievt.memory_item_id = mi.id
            and mievt.event_type in ('remove', 'edit')
        )
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
  relation_support_id text;
  entity jsonb;
  relation jsonb;
  schema_item jsonb;
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
      claim_type,
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
      item->>'claimType',
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

    for entity in select * from jsonb_array_elements(coalesce(item->'entities', '[]'::jsonb))
    loop
      insert into memory_entities(id, memory_item_id, tenant_id, name, entity_type, canonical_name)
      values (
        'ment_' || gen_random_uuid()::text,
        item->>'id',
        p_tenant_id,
        entity->>'name',
        entity->>'entityType',
        nullif(entity->>'canonicalName', '')
      );
    end loop;

    for relation in select * from jsonb_array_elements(coalesce(item->'relations', '[]'::jsonb))
    loop
      for relation_support_id in select jsonb_array_elements_text(relation->'evidenceSpanIds')
      loop
        if not exists (
          select 1
          from memory_item_evidence mie
          where mie.memory_item_id = item->>'id'
            and mie.evidence_span_id = relation_support_id
        ) then
          raise exception 'relation evidence must belong to parent memory item: %', relation_support_id;
        end if;
      end loop;

      insert into memory_relations(id, memory_item_id, tenant_id, subject, predicate, object, evidence_span_ids)
      values (
        'mrel_' || gen_random_uuid()::text,
        item->>'id',
        p_tenant_id,
        relation->>'subject',
        relation->>'predicate',
        relation->>'object',
        relation->'evidenceSpanIds'
      );
    end loop;

    for schema_item in select * from jsonb_array_elements(coalesce(item->'schemas', '[]'::jsonb))
    loop
      insert into memory_schemas(id, memory_item_id, tenant_id, subject_type, predicate, object_type, status)
      values (
        'msch_' || gen_random_uuid()::text,
        item->>'id',
        p_tenant_id,
        schema_item->>'subjectType',
        schema_item->>'predicate',
        schema_item->>'objectType',
        coalesce(nullif(schema_item->>'status', ''), 'candidate')
      );
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

create or replace function distillery_apply_memory_item_action(
  p_memory_item_id text,
  p_action text,
  p_reviewer_label text,
  p_rationale text,
  p_replacement_memory_item_id text,
  p_replacement jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  original memory_items%rowtype;
  event_id text := 'mevt_' || gen_random_uuid()::text;
  support_id text;
  relation_support_id text;
  entity jsonb;
  relation jsonb;
  schema_item jsonb;
begin
  if p_action not in ('confirm', 'edit', 'remove') then
    raise exception 'unsupported memory item action: %', p_action;
  end if;

  select * into original
  from memory_items
  where id = p_memory_item_id;

  if original.id is null then
    raise exception 'memory item not found: %', p_memory_item_id;
  end if;

  if p_action = 'edit' then
    if p_replacement_memory_item_id is null or p_replacement is null then
      raise exception 'edit requires replacement memory item id and replacement payload';
    end if;

    for support_id in select jsonb_array_elements_text(p_replacement->'evidenceSpanIds')
    loop
      if not exists (
        select 1
        from evidence_spans es
        where es.id = support_id
          and es.source_version_id = original.source_version_id
      ) then
        raise exception 'replacement references unknown evidence span: %', support_id;
      end if;
    end loop;

    insert into memory_items(
      id,
      tenant_id,
      ingestion_id,
      source_version_id,
      extraction_run_id,
      claim_type,
      statement,
      epistemic_status,
      qualifiers,
      stable_domain_tags,
      memory_generation_version,
      supersedes_memory_item_id
    )
    values (
      p_replacement_memory_item_id,
      original.tenant_id,
      original.ingestion_id,
      original.source_version_id,
      original.extraction_run_id,
      p_replacement->>'claimType',
      p_replacement->>'statement',
      p_replacement->>'epistemicStatus',
      coalesce(p_replacement->'qualifiers', '{}'::jsonb),
      coalesce(p_replacement->'stableDomainTags', '[]'::jsonb),
      original.memory_generation_version,
      original.id
    );

    for support_id in select jsonb_array_elements_text(p_replacement->'evidenceSpanIds')
    loop
      insert into memory_item_evidence(memory_item_id, evidence_span_id, tenant_id)
      values (p_replacement_memory_item_id, support_id, original.tenant_id);
    end loop;

    for entity in select * from jsonb_array_elements(coalesce(p_replacement->'entities', '[]'::jsonb))
    loop
      insert into memory_entities(id, memory_item_id, tenant_id, name, entity_type, canonical_name)
      values (
        'ment_' || gen_random_uuid()::text,
        p_replacement_memory_item_id,
        original.tenant_id,
        entity->>'name',
        entity->>'entityType',
        nullif(entity->>'canonicalName', '')
      );
    end loop;

    for relation in select * from jsonb_array_elements(coalesce(p_replacement->'relations', '[]'::jsonb))
    loop
      for relation_support_id in select jsonb_array_elements_text(relation->'evidenceSpanIds')
      loop
        if not exists (
          select 1
          from memory_item_evidence mie
          where mie.memory_item_id = p_replacement_memory_item_id
            and mie.evidence_span_id = relation_support_id
        ) then
          raise exception 'replacement relation evidence must belong to replacement memory item: %', relation_support_id;
        end if;
      end loop;

      insert into memory_relations(id, memory_item_id, tenant_id, subject, predicate, object, evidence_span_ids)
      values (
        'mrel_' || gen_random_uuid()::text,
        p_replacement_memory_item_id,
        original.tenant_id,
        relation->>'subject',
        relation->>'predicate',
        relation->>'object',
        relation->'evidenceSpanIds'
      );
    end loop;

    for schema_item in select * from jsonb_array_elements(coalesce(p_replacement->'schemas', '[]'::jsonb))
    loop
      insert into memory_schemas(id, memory_item_id, tenant_id, subject_type, predicate, object_type, status)
      values (
        'msch_' || gen_random_uuid()::text,
        p_replacement_memory_item_id,
        original.tenant_id,
        schema_item->>'subjectType',
        schema_item->>'predicate',
        schema_item->>'objectType',
        coalesce(nullif(schema_item->>'status', ''), 'candidate')
      );
    end loop;
  end if;

  insert into memory_item_events(
    id,
    tenant_id,
    memory_item_id,
    event_type,
    reviewer_label,
    rationale,
    replacement_memory_item_id,
    payload
  )
  values (
    event_id,
    original.tenant_id,
    original.id,
    p_action,
    p_reviewer_label,
    p_rationale,
    case when p_action = 'edit' then p_replacement_memory_item_id else null end,
    coalesce(p_replacement, '{}'::jsonb)
  );

  insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
  values (
    original.tenant_id,
    p_reviewer_label,
    'memory_item.' || p_action,
    'memory_item',
    original.id,
    jsonb_build_object(
      'eventId', event_id,
      'replacementMemoryItemId', case when p_action = 'edit' then p_replacement_memory_item_id else null end,
      'rationale', p_rationale
    )
  );

  return distillery_get_ingestion_result(original.ingestion_id);
end;
$$;

create or replace function distillery_get_memory_item_history(p_memory_item_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  original memory_items%rowtype;
  history jsonb;
begin
  select * into original
  from memory_items
  where id = p_memory_item_id;

  if original.id is null then
    raise exception 'memory item not found: %', p_memory_item_id;
  end if;

  select jsonb_build_object(
    'memoryItem', distillery_memory_item_json(original.id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mievt.id,
        'memoryItemId', mievt.memory_item_id,
        'eventType', mievt.event_type,
        'reviewerLabel', mievt.reviewer_label,
        'rationale', mievt.rationale,
        'replacementMemoryItemId', mievt.replacement_memory_item_id,
        'createdAt', mievt.created_at
      ) order by mievt.created_at, mievt.id)
      from memory_item_events mievt
      where mievt.memory_item_id = original.id
    ), '[]'::jsonb),
    'replacements', coalesce((
      select jsonb_agg(distillery_memory_item_json(replacement.id) order by replacement.created_at, replacement.id)
      from memory_items replacement
      where replacement.supersedes_memory_item_id = original.id
    ), '[]'::jsonb)
  )
  into history;

  return history;
end;
$$;

create or replace function distillery_recall_memory_lexical(
  p_tenant_id text,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  if trim(coalesce(p_query, '')) = '' then
    return '[]'::jsonb;
  end if;

  with tokens as (
    select distinct token
    from unnest(regexp_split_to_array(lower(p_query), '[^a-z0-9]+')) as token
    where length(token) >= 3
      and token not in (
        'what', 'when', 'where', 'which', 'who', 'why', 'how',
        'the', 'and', 'for', 'with', 'from', 'about', 'know',
        'does', 'did', 'has', 'have', 'had', 'are', 'was', 'were',
        'this', 'that', 'these', 'those', 'into', 'onto'
      )
  ),
  active_memory as (
    select mi.*
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
  ),
  ranked as (
    select
      mi.id,
      count(distinct tokens.token)::double precision
        + count(distinct tokens.token) filter (where lower(mi.statement) like '%' || tokens.token || '%')::double precision
        + count(distinct tokens.token) filter (where lower(coalesce(es.text, '')) like '%' || tokens.token || '%')::double precision
        as rank
    from active_memory mi
    cross join tokens
    left join memory_item_evidence mie on mie.memory_item_id = mi.id
    left join evidence_spans es on es.id = mie.evidence_span_id
    where lower(mi.statement) like '%' || tokens.token || '%'
       or lower(coalesce(es.text, '')) like '%' || tokens.token || '%'
    group by mi.id, mi.statement
    order by rank desc, mi.id
    limit least(greatest(p_limit, 1), 20)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', ranked.rank,
    'memoryItem', distillery_memory_item_json(mi.id),
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
      from memory_item_evidence mie
      join evidence_spans es on es.id = mie.evidence_span_id
      where mie.memory_item_id = mi.id
    ), '[]'::jsonb)
  ) order by ranked.rank desc, ranked.id), '[]'::jsonb)
  into result
  from ranked
  join memory_items mi on mi.id = ranked.id;

  return result;
end;
$$;

notify pgrst, 'reload schema';
