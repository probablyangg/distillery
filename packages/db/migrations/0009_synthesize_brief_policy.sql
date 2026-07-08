-- Add synthesize_brief as a first-class Loop System policy worker and make
-- artifact_drafted proposals create traceable initiative-brief drafts.

alter table pending_work
  drop constraint if exists pending_work_policy_check;

alter table pending_work
  add constraint pending_work_policy_check check (policy in (
    'extract_memory',
    'discover_candidate',
    'check_freshness',
    'detect_contradiction',
    'synthesize_brief',
    'rank_candidate',
    'draft_artifact',
    'gate_output',
    'revise_artifact'
  ));

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
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', me.name,
        'entityType', me.entity_type,
        'canonicalName', me.canonical_name
      ) order by me.created_at, me.id)
      from memory_entities me
      where me.memory_item_id = mi.id
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject', mr.subject,
        'predicate', mr.predicate,
        'object', mr.object,
        'evidenceSpanIds', mr.evidence_span_ids
      ) order by mr.created_at, mr.id)
      from memory_relations mr
      where mr.memory_item_id = mi.id
    ), '[]'::jsonb),
    'schemas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subjectType', ms.subject_type,
        'predicate', ms.predicate,
        'objectType', ms.object_type,
        'status', ms.status
      ) order by ms.created_at, ms.id)
      from memory_schemas ms
      where ms.memory_item_id = mi.id
    ), '[]'::jsonb),
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

create or replace function distillery_memory_with_evidence_json(p_memory_item_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'memoryItem', distillery_memory_item_json(p_memory_item_id),
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
      from memory_item_evidence mie
      join evidence_spans es on es.id = mie.evidence_span_id
      where mie.memory_item_id = p_memory_item_id
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_get_memory_synthesis_context(
  p_tenant_id text,
  p_seed_memory_item_ids text[],
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  p_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(jsonb_agg(distillery_memory_with_evidence_json(id) order by seed_rank, created_at desc, id), '[]'::jsonb)
  into result
  from (
    select
      mi.id,
      mi.created_at,
      case when mi.id = any(coalesce(p_seed_memory_item_ids, array[]::text[])) then 0 else 1 end as seed_rank
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1
        from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
    order by seed_rank, mi.created_at desc, mi.id
    limit p_limit
  ) candidates;

  return result;
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
  brief_id text;
  memory_item_ids text[];
  evidence_span_ids text[];
  memory_item_id text;
  evidence_span_id text;
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

  if proposal.target_event_type = 'artifact_drafted' then
    brief_id := coalesce(proposal.payload->>'briefId', proposal.subject_id);

    select array_agg(value)
    into memory_item_ids
    from jsonb_array_elements_text(coalesce(
      proposal.payload->'memoryItemIds',
      proposal.payload->'selectedMemoryItemIds',
      '[]'::jsonb
    )) as value;

    select array_agg(value)
    into evidence_span_ids
    from jsonb_array_elements_text(coalesce(
      proposal.payload->'evidenceSpanIds',
      proposal.payload->'selectedEvidenceSpanIds',
      '[]'::jsonb
    )) as value;

    if brief_id is null or brief_id = '' then
      raise exception 'artifact_drafted proposal requires briefId';
    end if;

    if array_length(memory_item_ids, 1) is null then
      raise exception 'artifact_drafted proposal requires memoryItemIds';
    end if;

    if array_length(evidence_span_ids, 1) is null then
      raise exception 'artifact_drafted proposal requires evidenceSpanIds';
    end if;

    foreach memory_item_id in array memory_item_ids
    loop
      if not exists (
        select 1
        from memory_items mi
        where mi.id = memory_item_id
          and mi.tenant_id = proposal.tenant_id
      ) then
        raise exception 'artifact draft memory item not found for tenant: %', memory_item_id;
      end if;

      if exists (
        select 1
        from memory_item_events mievt
        where mievt.memory_item_id = memory_item_id
          and mievt.event_type in ('remove', 'edit')
      ) then
        raise exception 'inactive memory item cannot support artifact draft: %', memory_item_id;
      end if;
    end loop;

    foreach evidence_span_id in array evidence_span_ids
    loop
      if not exists (
        select 1
        from evidence_spans es
        where es.id = evidence_span_id
      ) then
        raise exception 'artifact draft evidence span not found: %', evidence_span_id;
      end if;
    end loop;

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
      brief_id,
      proposal.tenant_id,
      proposal.payload->>'title',
      proposal.payload->>'problem',
      proposal.payload->>'proposal',
      proposal.payload->>'successMetric',
      nullif(proposal.payload->>'risksAndDependencies', ''),
      'draft',
      'synthesize_brief'
    )
    on conflict (id) do nothing;

    foreach memory_item_id in array memory_item_ids
    loop
      insert into initiative_brief_memory(brief_id, memory_item_id, tenant_id)
      values (brief_id, memory_item_id, proposal.tenant_id)
      on conflict (brief_id, memory_item_id) do nothing;
    end loop;

    foreach evidence_span_id in array evidence_span_ids
    loop
      insert into initiative_brief_evidence(brief_id, evidence_span_id, tenant_id)
      values (brief_id, evidence_span_id, proposal.tenant_id)
      on conflict (brief_id, evidence_span_id) do nothing;
    end loop;
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

notify pgrst, 'reload schema';
