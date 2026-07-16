-- Show Slack processing immediately, then replace it with the saved reaction
-- only after every source in the connector save has completed extraction.

-- external_source_id is validated as the exact workspace/channel/message tuple,
-- so this second equivalent constraint is redundant and can race with the
-- conflict target used by concurrent Slack registrations.
alter table connector_saves drop constraint if exists connector_saves_tenant_id_provider_workspace_id_channel_id__key;

alter table ledger_events drop constraint if exists ledger_events_event_type_check;
alter table ledger_events add constraint ledger_events_event_type_check check (event_type in (
  'slack_save_requested', 'slack_extraction_completed', 'slack_reaction_retry_requested',
  'source_committed', 'memory_section_ready', 'memory_section_completed', 'memory_committed',
  'memory_connected', 'connections_updated', 'contradictions_updated', 'embeddings_updated',
  'graph_updated', 'memory_review_changed', 'synthesis_neighborhood_dirty', 'cluster_changed',
  'cluster_readiness_changed', 'synthesis_ready', 'memory_confirmed', 'memory_edited',
  'memory_removed', 'candidate_created', 'candidate_approved', 'candidate_rejected',
  'artifact_drafted', 'artifact_approved', 'artifact_rejected', 'artifact_delivered',
  'decision_committed', 'freshness_warning_committed', 'contradiction_recorded',
  'policy_run_recorded'
));

create or replace function distillery_is_slack_connector_extraction_complete(p_save_id text)
returns boolean
language plpgsql
security definer
stable
as $$
declare
  save_row connector_saves%rowtype;
  expected_source_count integer;
  resolved_source_count integer;
begin
  select * into save_row from connector_saves where id = p_save_id;
  if save_row.id is null or save_row.status <> 'completed' then return false; end if;

  expected_source_count := 1 + jsonb_array_length(save_row.attachment_source_ids);

  with expected_sources as (
    select save_row.message_source_id as source_item_id
    union all
    select value from jsonb_array_elements_text(save_row.attachment_source_ids)
  ), current_versions as (
    select latest.id as source_version_id
    from expected_sources expected
    join source_items item on item.id = expected.source_item_id
    join lateral (
      select version.id
      from source_versions version
      where version.source_item_id = item.id
        and version.content_hash = item.content_hash
      order by version.version desc
      limit 1
    ) latest on true
  )
  select count(*) into resolved_source_count from current_versions;

  if resolved_source_count <> expected_source_count then return false; end if;

  return not exists (
    with expected_sources as (
      select save_row.message_source_id as source_item_id
      union all
      select value from jsonb_array_elements_text(save_row.attachment_source_ids)
    ), current_versions as (
      select latest.id as source_version_id
      from expected_sources expected
      join source_items item on item.id = expected.source_item_id
      join lateral (
        select version.id
        from source_versions version
        where version.source_item_id = item.id
          and version.content_hash = item.content_hash
        order by version.version desc
        limit 1
      ) latest on true
    )
    select 1
    from current_versions current
    where exists (
      select 1 from evidence_spans span where span.source_version_id = current.source_version_id
    ) and not exists (
      select 1
      from memory_section_plans plan
      where plan.source_version_id = current.source_version_id
        and (
          (not plan.used_sectioning and exists (
            select 1 from pending_work work
            where work.policy = 'extract_memory'
              and work.subject_id = current.source_version_id
              and work.status = 'completed'
          ))
          or
          (plan.used_sectioning and exists (
            select 1 from pending_work work
            where work.policy = 'consolidate_memory'
              and work.subject_id = current.source_version_id
              and work.status = 'completed'
          ))
        )
    )
  );
end;
$$;

create or replace function distillery_ensure_slack_reaction_sync_for_work(p_completed_work_id text)
returns void
language plpgsql
security definer
as $$
declare
  completed_work pending_work%rowtype;
  source_version_id text;
  save_row connector_saves%rowtype;
  event_id text;
  work_id text;
begin
  select * into completed_work
  from pending_work
  where id = p_completed_work_id and status = 'completed';

  if completed_work.id is null or completed_work.policy not in (
    'ingest_slack_source', 'extract_memory', 'extract_memory_section', 'consolidate_memory'
  ) then return; end if;

  if completed_work.policy in ('extract_memory', 'consolidate_memory') then
    source_version_id := completed_work.subject_id;
  elsif completed_work.policy = 'extract_memory_section' then
    select section.source_version_id into source_version_id
    from memory_sections section where section.id = completed_work.subject_id;
  end if;

  for save_row in
    select save.*
    from connector_saves save
    where save.status = 'completed'
      and save.reaction_status <> 'added'
      and (
        (completed_work.policy = 'ingest_slack_source' and save.id = completed_work.subject_id)
        or
        (source_version_id is not null and exists (
          select 1
          from source_versions version
          where version.id = source_version_id
            and (
              save.message_source_id = version.source_item_id
              or save.attachment_source_ids ? version.source_item_id
            )
        ))
      )
  loop
    if not distillery_is_slack_connector_extraction_complete(save_row.id) then continue; end if;
    if exists (
      select 1 from pending_work work
      where work.policy = 'sync_slack_reaction'
        and work.subject_id = save_row.id
        and work.status in ('pending', 'running')
    ) then continue; end if;

    event_id := 'evt_' || gen_random_uuid()::text;
    insert into ledger_events(
      id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
      input_version, idempotency_key, payload
    ) values (
      event_id, save_row.tenant_id, 'slack_extraction_completed', 'connector_save', save_row.id,
      'system', 'Slack extraction completion', 'extraction-complete:' || p_completed_work_id,
      'slack-extraction-complete:' || save_row.id,
      jsonb_build_object(
        'connectorSaveId', save_row.id,
        'completedWorkItemId', p_completed_work_id
      )
    ) on conflict (tenant_id, idempotency_key) do nothing
    returning id into event_id;

    if event_id is null then continue; end if;

    insert into event_outbox(id, tenant_id, ledger_event_id)
    values ('eout_' || gen_random_uuid()::text, save_row.tenant_id, event_id)
    on conflict (ledger_event_id) do nothing;

    work_id := 'work_' || gen_random_uuid()::text;
    insert into pending_work(
      id, tenant_id, policy, subject_type, subject_id, caused_by_event_id, input_version
    ) values (
      work_id, save_row.tenant_id, 'sync_slack_reaction', 'connector_save', save_row.id,
      event_id, 'extraction-complete:' || p_completed_work_id
    );
  end loop;
end;
$$;

create or replace function distillery_complete_pending_work(p_id text, p_lease_token text)
returns void
language plpgsql
security definer
as $$
declare
  completed_work pending_work%rowtype;
begin
  update pending_work
  set status = 'completed',
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_id
    and status = 'running'
    and (p_lease_token is null or lease_token = p_lease_token)
  returning * into completed_work;

  if completed_work.id is not null then
    perform distillery_ensure_slack_reaction_sync_for_work(completed_work.id);
  end if;
end;
$$;

create or replace function distillery_list_slack_reaction_work_for_completed_work(p_work_item_id text)
returns jsonb
language sql
security definer
stable
as $$
  select coalesce(jsonb_agg(distillery_pending_work_to_json(work) order by work.created_at), '[]'::jsonb)
  from pending_work work
  join ledger_events event on event.id = work.caused_by_event_id
  where event.event_type = 'slack_extraction_completed'
    and event.payload->>'completedWorkItemId' = p_work_item_id
    and work.policy = 'sync_slack_reaction'
    and work.status = 'pending';
$$;
