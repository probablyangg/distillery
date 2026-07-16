-- Keep a new capture responsive even when older derived/enrichment outbox rows
-- are backlogged. Only the first claim may prefer the caller's subject; all
-- remaining claims retain FIFO order and the existing lease fencing.

create or replace function distillery_claim_event_outbox_row_v2(
  p_lease_seconds integer,
  p_preferred_subject_id text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  claimed event_outbox%rowtype;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'outbox lease must be between 30 and 3600 seconds';
  end if;

  select eo.* into claimed
  from event_outbox eo
  join ledger_events le on le.id = eo.ledger_event_id
  where eo.status = 'pending'
  order by case when p_preferred_subject_id is not null and le.subject_id = p_preferred_subject_id then 0 else 1 end,
    eo.created_at
  for update of eo skip locked
  limit 1;

  if claimed.id is null then return null; end if;

  update event_outbox
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      lease_token = gen_random_uuid()::text,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = claimed.id
  returning * into claimed;

  return distillery_event_outbox_to_json(claimed);
end;
$$;

notify pgrst, 'reload schema';
