-- Distillery v0 Memory Generation correction/history support.
-- Edits/removals/confirmations are append-only events. Original source evidence and
-- original memory rows remain reconstructable.

alter table memory_items
  add column if not exists supersedes_memory_item_id text references memory_items(id);

create table if not exists memory_item_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  memory_item_id text not null references memory_items(id),
  event_type text not null check (event_type in ('confirm', 'edit', 'remove')),
  reviewer_label text,
  rationale text,
  replacement_memory_item_id text references memory_items(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists memory_item_events_memory_item_idx
  on memory_item_events(memory_item_id, created_at);

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
        'reviewState', case
          when exists (
            select 1 from memory_item_events mievt
            where mievt.memory_item_id = mi.id
              and mievt.event_type = 'confirm'
          ) then 'confirmed'
          else 'unreviewed'
        end,
        'supersedesMemoryItemId', mi.supersedes_memory_item_id
      ) order by mi.created_at, mi.id)
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
    'memoryItem', jsonb_build_object(
      'id', original.id,
      'ingestionId', original.ingestion_id,
      'sourceVersionId', original.source_version_id,
      'claimType', original.claim_type,
      'statement', original.statement,
      'evidenceSpanIds', coalesce((
        select jsonb_agg(mie.evidence_span_id order by mie.evidence_span_id)
        from memory_item_evidence mie
        where mie.memory_item_id = original.id
      ), '[]'::jsonb),
      'epistemicStatus', original.epistemic_status,
      'qualifiers', original.qualifiers,
      'stableDomainTags', original.stable_domain_tags,
      'reviewState', case
        when exists (
          select 1 from memory_item_events mievt
          where mievt.memory_item_id = original.id
            and mievt.event_type = 'remove'
        ) then 'removed'
        when exists (
          select 1 from memory_item_events mievt
          where mievt.memory_item_id = original.id
            and mievt.event_type = 'edit'
        ) then 'superseded'
        when exists (
          select 1 from memory_item_events mievt
          where mievt.memory_item_id = original.id
            and mievt.event_type = 'confirm'
        ) then 'confirmed'
        else 'unreviewed'
      end,
      'supersedesMemoryItemId', original.supersedes_memory_item_id
    ),
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
      select jsonb_agg(jsonb_build_object(
        'id', replacement.id,
        'ingestionId', replacement.ingestion_id,
        'sourceVersionId', replacement.source_version_id,
        'claimType', replacement.claim_type,
        'statement', replacement.statement,
        'evidenceSpanIds', coalesce((
          select jsonb_agg(mie.evidence_span_id order by mie.evidence_span_id)
          from memory_item_evidence mie
          where mie.memory_item_id = replacement.id
        ), '[]'::jsonb),
        'epistemicStatus', replacement.epistemic_status,
        'qualifiers', replacement.qualifiers,
        'stableDomainTags', replacement.stable_domain_tags,
        'reviewState', case
          when exists (
            select 1 from memory_item_events mievt
            where mievt.memory_item_id = replacement.id
              and mievt.event_type = 'confirm'
          ) then 'confirmed'
          else 'unreviewed'
        end,
        'supersedesMemoryItemId', replacement.supersedes_memory_item_id
      ) order by replacement.created_at, replacement.id)
      from memory_items replacement
      where replacement.supersedes_memory_item_id = original.id
    ), '[]'::jsonb)
  )
  into history;

  return history;
end;
$$;

notify pgrst, 'reload schema';

