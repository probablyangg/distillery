-- Global synthesis sweeps are safety-net scans. Once a cluster version already
-- has a readiness result, repeated projections of that same version are
-- redundant. Clear rollout backlog created before unchanged sweeps became no-ops.

update event_outbox eo
set status = 'processed',
    processed_at = now(),
    resolution_reason = 'redundant_global_synthesis_projection',
    locked_at = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
from ledger_events cluster_event
join pending_work recompute_work
  on recompute_work.id = cluster_event.caused_by_work_item_id
join ledger_events cause_event
  on cause_event.id = recompute_work.caused_by_event_id
where eo.ledger_event_id = cluster_event.id
  and eo.status in ('pending', 'processing')
  and cluster_event.event_type = 'cluster_changed'
  and cause_event.event_type = 'synthesis_neighborhood_dirty'
  and exists (
    select 1
    from synthesis_readiness_evaluations readiness
    where readiness.tenant_id = cluster_event.tenant_id
      and readiness.cluster_id = cluster_event.subject_id
      and readiness.cluster_version = cluster_event.payload->>'clusterVersion'
  );

update event_outbox eo
set status = 'processed',
    processed_at = now(),
    resolution_reason = 'superseded_global_synthesis_sweep',
    locked_at = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
from ledger_events sweep_event
where eo.ledger_event_id = sweep_event.id
  and eo.status in ('pending', 'processing')
  and sweep_event.event_type = 'synthesis_neighborhood_dirty'
  and sweep_event.actor_label = 'global_synthesis_sweep';
