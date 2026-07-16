-- Commit deterministic, auto-approved policy output in one database round trip.
-- This preserves the proposed-event validation ledger while keeping Worker
-- invocations below Cloudflare's external subrequest limit.

create or replace function distillery_commit_auto_proposed_events(p_proposed_events jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  proposed_event jsonb;
  created_event jsonb;
  stored_event proposed_events%rowtype;
  committed_events jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_proposed_events, '[]'::jsonb)) <> 'array' then
    raise exception 'p_proposed_events must be a JSON array';
  end if;

  for proposed_event in
    select value from jsonb_array_elements(coalesce(p_proposed_events, '[]'::jsonb))
  loop
    if coalesce((proposed_event->>'requiresHumanApproval')::boolean, false) then
      raise exception 'auto-commit batch cannot include approval-required event: %', proposed_event->>'id';
    end if;

    created_event := distillery_create_proposed_event(proposed_event);
    perform distillery_mark_proposed_event_valid(created_event->>'id');
    perform distillery_commit_validated_proposed_event(created_event->>'id');

    select * into stored_event
    from proposed_events
    where id = created_event->>'id';

    committed_events := committed_events || jsonb_build_array(distillery_proposed_event_to_json(stored_event));
  end loop;

  return committed_events;
end;
$$;
