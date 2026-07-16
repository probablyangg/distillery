-- A distinct repeat click deliberately re-adds the processing reaction even
-- when its refreshed context hash is unchanged. Key reaction readiness by the
-- completed canonical work item so that the already-extracted bundle can
-- schedule a fresh factory-reaction synchronization without re-extraction.

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
      'system', 'Slack context extraction completion',
      'context-complete:' || save_row.current_context_bundle_id || ':' || completed_work.id,
      'slack-extraction-complete:' || save_row.id || ':' || save_row.current_context_bundle_id || ':' || completed_work.id,
      jsonb_build_object(
        'connectorSaveId', save_row.id,
        'contextBundleId', save_row.current_context_bundle_id,
        'contextVersion', save_row.context_version,
        'completedWorkItemId', completed_work.id
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
      event_id, 'context-complete:' || save_row.current_context_bundle_id || ':' || completed_work.id
    );
  end loop;
end;
$$;

notify pgrst, 'reload schema';
