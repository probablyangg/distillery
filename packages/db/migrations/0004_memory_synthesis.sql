-- Distillery v0 Memory Synthesis schema.
-- v0 synthesis is deliberately human-authored: selected active memory items
-- become a traceable initiative brief, then a human records approve/reject.

create table if not exists initiative_briefs (
  id text primary key,
  tenant_id text not null references tenants(id),
  title text not null,
  problem text not null,
  proposal text not null,
  success_metric text not null,
  risks_and_dependencies text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_by_label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists initiative_brief_memory (
  brief_id text not null references initiative_briefs(id) on delete cascade,
  memory_item_id text not null references memory_items(id),
  tenant_id text not null references tenants(id),
  created_at timestamptz not null default now(),
  primary key (brief_id, memory_item_id)
);

create table if not exists initiative_brief_evidence (
  brief_id text not null references initiative_briefs(id) on delete cascade,
  evidence_span_id text not null references evidence_spans(id),
  tenant_id text not null references tenants(id),
  created_at timestamptz not null default now(),
  primary key (brief_id, evidence_span_id)
);

create table if not exists initiative_brief_decisions (
  id text primary key,
  tenant_id text not null references tenants(id),
  brief_id text not null references initiative_briefs(id) on delete cascade,
  decision text not null check (decision in ('approve', 'reject')),
  reviewer_label text not null,
  rationale text,
  created_at timestamptz not null default now()
);

create index if not exists initiative_briefs_tenant_status_idx
  on initiative_briefs(tenant_id, status, updated_at desc);

create index if not exists initiative_brief_memory_memory_item_idx
  on initiative_brief_memory(memory_item_id);

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

create or replace function distillery_list_active_memory(
  p_tenant_id text,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
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
  ) order by mi.created_at desc, mi.id), '[]'::jsonb)
  into result
  from (
    select *
    from memory_items candidate
    where candidate.tenant_id = p_tenant_id
      and not exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = candidate.id
          and mievt.event_type in ('remove', 'edit')
      )
    order by candidate.created_at desc, candidate.id
    limit least(greatest(p_limit, 1), 200)
  ) mi;

  return result;
end;
$$;

create or replace function distillery_get_initiative_brief(p_brief_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', ib.id,
    'title', ib.title,
    'status', ib.status,
    'problem', ib.problem,
    'proposal', ib.proposal,
    'successMetric', ib.success_metric,
    'risksAndDependencies', ib.risks_and_dependencies,
    'memoryItemIds', coalesce((
      select jsonb_agg(ibm.memory_item_id order by ibm.created_at, ibm.memory_item_id)
      from initiative_brief_memory ibm
      where ibm.brief_id = ib.id
    ), '[]'::jsonb),
    'evidenceSpanIds', coalesce((
      select jsonb_agg(ibe.evidence_span_id order by ibe.created_at, ibe.evidence_span_id)
      from initiative_brief_evidence ibe
      where ibe.brief_id = ib.id
    ), '[]'::jsonb),
    'memoryItems', coalesce((
      select jsonb_agg(distillery_memory_item_json(ibm.memory_item_id) order by ibm.created_at, ibm.memory_item_id)
      from initiative_brief_memory ibm
      where ibm.brief_id = ib.id
    ), '[]'::jsonb),
    'evidenceSpans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', es.id,
        'sourceVersionId', es.source_version_id,
        'startLine', es.start_line,
        'endLine', es.end_line,
        'startChar', es.start_char,
        'endChar', es.end_char,
        'text', es.text
      ) order by es.source_version_id, es.start_line, es.start_char)
      from initiative_brief_evidence ibe
      join evidence_spans es on es.id = ibe.evidence_span_id
      where ibe.brief_id = ib.id
    ), '[]'::jsonb),
    'createdByLabel', ib.created_by_label,
    'createdAt', ib.created_at,
    'updatedAt', ib.updated_at,
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ibd.id,
        'briefId', ibd.brief_id,
        'decision', ibd.decision,
        'reviewerLabel', ibd.reviewer_label,
        'rationale', ibd.rationale,
        'createdAt', ibd.created_at
      ) order by ibd.created_at, ibd.id)
      from initiative_brief_decisions ibd
      where ibd.brief_id = ib.id
    ), '[]'::jsonb)
  )
  into result
  from initiative_briefs ib
  where ib.id = p_brief_id;

  if result is null then
    raise exception 'initiative brief not found: %', p_brief_id;
  end if;

  return result;
end;
$$;

create or replace function distillery_list_initiative_briefs(
  p_tenant_id text,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select coalesce(jsonb_agg(distillery_get_initiative_brief(brief_id) order by updated_at desc, brief_id), '[]'::jsonb)
  into result
  from (
    select id as brief_id, updated_at
    from initiative_briefs
    where tenant_id = p_tenant_id
    order by updated_at desc, id
    limit least(greatest(p_limit, 1), 100)
  ) briefs;

  return result;
end;
$$;

create or replace function distillery_create_initiative_brief(
  p_tenant_id text,
  p_brief_id text,
  p_title text,
  p_problem text,
  p_proposal text,
  p_success_metric text,
  p_risks_and_dependencies text,
  p_memory_item_ids text[],
  p_created_by_label text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  selected_memory_item_id text;
  support_id text;
  distinct_memory_count integer;
begin
  if array_length(p_memory_item_ids, 1) is null then
    raise exception 'initiative brief requires at least one memory item';
  end if;

  select count(distinct id)
  into distinct_memory_count
  from unnest(p_memory_item_ids) as id;

  if distinct_memory_count <> array_length(p_memory_item_ids, 1) then
    raise exception 'initiative brief memory item ids must be unique';
  end if;

  insert into initiative_briefs(
    id,
    tenant_id,
    title,
    problem,
    proposal,
    success_metric,
    risks_and_dependencies,
    status,
    created_by_label
  )
  values (
    p_brief_id,
    p_tenant_id,
    p_title,
    p_problem,
    p_proposal,
    p_success_metric,
    nullif(p_risks_and_dependencies, ''),
    'draft',
    p_created_by_label
  );

  foreach selected_memory_item_id in array p_memory_item_ids
  loop
    if not exists (
      select 1
      from memory_items mi
      where mi.id = selected_memory_item_id
        and mi.tenant_id = p_tenant_id
    ) then
      raise exception 'memory item not found for tenant: %', selected_memory_item_id;
    end if;

    if exists (
      select 1 from memory_item_events mievt
      where mievt.memory_item_id = selected_memory_item_id
        and mievt.event_type in ('remove', 'edit')
    ) then
      raise exception 'inactive memory item cannot support new brief: %', selected_memory_item_id;
    end if;

    insert into initiative_brief_memory(brief_id, memory_item_id, tenant_id)
    values (p_brief_id, selected_memory_item_id, p_tenant_id);

    for support_id in
      select mie.evidence_span_id
      from memory_item_evidence mie
      where mie.memory_item_id = selected_memory_item_id
    loop
      insert into initiative_brief_evidence(brief_id, evidence_span_id, tenant_id)
      values (p_brief_id, support_id, p_tenant_id)
      on conflict (brief_id, evidence_span_id) do nothing;
    end loop;
  end loop;

  if not exists (
    select 1
    from initiative_brief_evidence ibe
    where ibe.brief_id = p_brief_id
  ) then
    raise exception 'initiative brief requires evidence-backed memory';
  end if;

  insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
  values (
    p_tenant_id,
    p_created_by_label,
    'initiative_brief.created',
    'initiative_brief',
    p_brief_id,
    jsonb_build_object('memoryItemIds', p_memory_item_ids)
  );

  return distillery_get_initiative_brief(p_brief_id);
end;
$$;

create or replace function distillery_record_initiative_brief_decision(
  p_brief_id text,
  p_decision_id text,
  p_decision text,
  p_reviewer_label text,
  p_rationale text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  brief initiative_briefs%rowtype;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'unsupported initiative brief decision: %', p_decision;
  end if;

  select * into brief
  from initiative_briefs
  where id = p_brief_id;

  if brief.id is null then
    raise exception 'initiative brief not found: %', p_brief_id;
  end if;

  if p_decision = 'approve' and exists (
    select 1
    from initiative_brief_memory ibm
    join memory_item_events mievt on mievt.memory_item_id = ibm.memory_item_id
    where ibm.brief_id = brief.id
      and mievt.event_type in ('remove', 'edit')
  ) then
    raise exception 'initiative brief cannot be approved because supporting memory is inactive: %', p_brief_id;
  end if;

  insert into initiative_brief_decisions(
    id,
    tenant_id,
    brief_id,
    decision,
    reviewer_label,
    rationale
  )
  values (
    p_decision_id,
    brief.tenant_id,
    brief.id,
    p_decision,
    p_reviewer_label,
    nullif(p_rationale, '')
  );

  update initiative_briefs
  set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      updated_at = now()
  where id = brief.id;

  insert into audit_events(tenant_id, actor_label, action, entity_type, entity_id, payload)
  values (
    brief.tenant_id,
    p_reviewer_label,
    'initiative_brief.' || p_decision,
    'initiative_brief',
    brief.id,
    jsonb_build_object('decisionId', p_decision_id, 'rationale', p_rationale)
  );

  return distillery_get_initiative_brief(brief.id);
end;
$$;

notify pgrst, 'reload schema';
