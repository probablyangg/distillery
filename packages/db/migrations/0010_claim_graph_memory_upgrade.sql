-- Pilot claim graph memory upgrade.
-- Canonical source/evidence/loop tables remain authoritative; graph rows are
-- rebuildable projections and reviewer state around claim connections/conflicts.

create extension if not exists pgcrypto;
create extension if not exists vector;

alter table pending_work
  drop constraint if exists pending_work_policy_check;

alter table pending_work
  add constraint pending_work_policy_check check (policy in (
    'extract_memory',
    'connect_memory',
    'discover_candidate',
    'check_freshness',
    'detect_contradiction',
    'synthesize_brief',
    'rank_candidate',
    'draft_artifact',
    'gate_output',
    'revise_artifact'
  ));

alter table ledger_events
  drop constraint if exists ledger_events_event_type_check;

alter table ledger_events
  add constraint ledger_events_event_type_check check (event_type in (
    'source_committed',
    'memory_committed',
    'memory_connected',
    'memory_confirmed',
    'memory_edited',
    'memory_removed',
    'candidate_created',
    'candidate_approved',
    'candidate_rejected',
    'artifact_drafted',
    'artifact_approved',
    'artifact_rejected',
    'artifact_delivered',
    'decision_committed',
    'freshness_warning_committed',
    'contradiction_recorded',
    'policy_run_recorded'
  ));

alter table proposed_events
  drop constraint if exists proposed_events_proposed_event_type_check,
  drop constraint if exists proposed_events_target_event_type_check;

alter table proposed_events
  add constraint proposed_events_proposed_event_type_check check (proposed_event_type in (
    'memory_proposed',
    'memory_connection_proposed',
    'candidate_proposed',
    'artifact_draft_proposed',
    'freshness_warning_proposed',
    'contradiction_proposed',
    'decision_record_proposed'
  )),
  add constraint proposed_events_target_event_type_check check (target_event_type in (
    'source_committed',
    'memory_committed',
    'memory_connected',
    'memory_confirmed',
    'memory_edited',
    'memory_removed',
    'candidate_created',
    'candidate_approved',
    'candidate_rejected',
    'artifact_drafted',
    'artifact_approved',
    'artifact_rejected',
    'artifact_delivered',
    'decision_committed',
    'freshness_warning_committed',
    'contradiction_recorded',
    'policy_run_recorded'
  ));

create table if not exists observations (
  id text primary key,
  tenant_id text not null references tenants(id),
  evidence_span_id text not null references evidence_spans(id),
  extraction_run_id text,
  observation_type text not null,
  raw_statement text not null,
  subject_mention text,
  predicate_mention text,
  object_value jsonb,
  modality text,
  negated boolean not null default false,
  qualifiers jsonb not null default '{}'::jsonb,
  valid_time_start timestamptz,
  valid_time_end timestamptz,
  extraction_confidence numeric,
  review_state text not null default 'unreviewed',
  created_at timestamptz not null default now()
);

create table if not exists claims (
  id text primary key,
  tenant_id text not null references tenants(id),
  claim_type text not null,
  statement text not null,
  subject_entity_id text,
  predicate_id text,
  object_json jsonb,
  epistemic_status text not null,
  qualifiers jsonb not null default '{}'::jsonb,
  stable_domain_tags jsonb not null default '[]'::jsonb,
  valid_time_start timestamptz,
  valid_time_end timestamptz,
  recorded_at timestamptz not null default now(),
  review_state text not null default 'unreviewed',
  supersedes_claim_id text,
  source_version_id text,
  ingestion_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claim_evidence (
  claim_id text not null,
  evidence_span_id text not null references evidence_spans(id),
  tenant_id text not null references tenants(id),
  role text not null check (role in ('supports', 'contradicts', 'qualifies', 'motivates')),
  observation_id text,
  created_at timestamptz not null default now(),
  primary key (claim_id, evidence_span_id, role)
);

create table if not exists entities (
  id text primary key,
  tenant_id text not null references tenants(id),
  canonical_name text not null,
  entity_type text not null,
  description text,
  promotion_state text not null default 'auto_promoted',
  promotion_rationale text,
  supporting_observation_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, canonical_name, entity_type)
);

create table if not exists entity_aliases (
  id text primary key,
  tenant_id text not null references tenants(id),
  entity_id text not null references entities(id),
  alias text not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, entity_id, alias)
);

create table if not exists predicates (
  id text primary key,
  tenant_id text not null references tenants(id),
  canonical_name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (tenant_id, canonical_name)
);

create table if not exists schema_patterns (
  id text primary key,
  tenant_id text not null references tenants(id),
  subject_type text not null,
  predicate_id text,
  predicate_name text not null,
  object_type text not null,
  status text not null default 'candidate' check (status in ('candidate', 'stable', 'rejected')),
  support_count integer not null default 0,
  promotion_rationale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, subject_type, predicate_name, object_type)
);

create table if not exists claim_connections (
  id text primary key,
  tenant_id text not null references tenants(id),
  from_claim_id text not null,
  to_claim_id text not null,
  connection_type text not null check (connection_type in (
    'same_initiative_signal',
    'supports',
    'depends_on',
    'blocks',
    'duplicates',
    'refines',
    'motivates',
    'related_context'
  )),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  confidence numeric not null,
  score_components jsonb not null default '{}'::jsonb,
  evidence_span_ids jsonb not null default '[]'::jsonb,
  rationale text,
  created_by_policy_run_id text,
  reviewer_label text,
  review_rationale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, from_claim_id, to_claim_id, connection_type)
);

create table if not exists conflict_groups (
  id text primary key,
  tenant_id text not null references tenants(id),
  conflict_type text not null check (conflict_type in (
    'mutual',
    'temporal',
    'granularity',
    'scope',
    'decision',
    'ownership',
    'dependency',
    'metric_definition'
  )),
  severity text not null check (severity in ('blocking', 'warning')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  summary text not null,
  created_by_policy_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conflict_members (
  conflict_group_id text not null references conflict_groups(id) on delete cascade,
  claim_id text not null,
  role text not null,
  evidence_span_ids jsonb not null default '[]'::jsonb,
  primary key (conflict_group_id, claim_id)
);

create table if not exists conflict_resolutions (
  id text primary key,
  tenant_id text not null references tenants(id),
  conflict_group_id text not null references conflict_groups(id),
  resolution_type text not null,
  winning_claim_id text,
  rationale text not null,
  reviewer_label text not null,
  created_at timestamptz not null default now()
);

create table if not exists graph_nodes (
  id text primary key,
  tenant_id text not null references tenants(id),
  node_type text not null check (node_type in ('claim', 'entity', 'schema', 'evidence', 'conflict')),
  ref_id text not null,
  label text not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists graph_edges (
  id text primary key,
  tenant_id text not null references tenants(id),
  from_node_id text not null,
  to_node_id text not null,
  edge_type text not null,
  weight numeric not null default 1,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, from_node_id, to_node_id, edge_type)
);

create table if not exists memory_embeddings (
  id text primary key,
  tenant_id text not null references tenants(id),
  target_type text not null check (target_type in ('claim', 'evidence_span', 'entity', 'schema_pattern')),
  target_id text not null,
  embedding_model text not null,
  embedding vector(1536) not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, target_type, target_id, embedding_model, content_hash)
);

create table if not exists graph_claim_preferences (
  tenant_id text not null references tenants(id),
  claim_id text not null,
  pinned boolean not null default false,
  exclude_from_synthesis boolean not null default false,
  reviewer_label text,
  rationale text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, claim_id)
);

create index if not exists claim_connections_tenant_status_idx on claim_connections(tenant_id, status, created_at desc);
create index if not exists claim_connections_from_idx on claim_connections(tenant_id, from_claim_id);
create index if not exists claim_connections_to_idx on claim_connections(tenant_id, to_claim_id);
create index if not exists conflict_groups_tenant_status_idx on conflict_groups(tenant_id, status, severity, created_at desc);
create index if not exists graph_edges_from_idx on graph_edges(tenant_id, from_node_id);
create index if not exists graph_edges_to_idx on graph_edges(tenant_id, to_node_id);

create or replace function distillery_promote_memory_item_to_claim_graph()
returns trigger
language plpgsql
security definer
as $$
declare
  support_id text;
  entity_row jsonb;
  relation_row jsonb;
  schema_row jsonb;
  observation_id text;
  promoted_entity_id text;
  predicate_row_id text;
  schema_row_id text;
begin
  insert into claims(
    id,
    tenant_id,
    claim_type,
    statement,
    epistemic_status,
    qualifiers,
    stable_domain_tags,
    review_state,
    supersedes_claim_id,
    source_version_id,
    ingestion_id,
    created_at,
    updated_at
  )
  values (
    new.id,
    new.tenant_id,
    new.claim_type,
    new.statement,
    new.epistemic_status,
    new.qualifiers,
    new.stable_domain_tags,
    'unreviewed',
    new.supersedes_memory_item_id,
    new.source_version_id,
    new.ingestion_id,
    new.created_at,
    new.created_at
  )
  on conflict (id) do update
  set statement = excluded.statement,
      updated_at = now();

  for support_id in
    select evidence_span_id from memory_item_evidence where memory_item_id = new.id
  loop
    observation_id := 'obs_' || gen_random_uuid()::text;
    insert into observations(
      id,
      tenant_id,
      evidence_span_id,
      extraction_run_id,
      observation_type,
      raw_statement,
      qualifiers
    )
    values (
      observation_id,
      new.tenant_id,
      support_id,
      new.extraction_run_id,
      new.claim_type,
      new.statement,
      new.qualifiers
    )
    on conflict (id) do nothing;

    insert into claim_evidence(claim_id, evidence_span_id, tenant_id, role, observation_id)
    values (new.id, support_id, new.tenant_id, 'supports', observation_id)
    on conflict (claim_id, evidence_span_id, role) do nothing;
  end loop;

  for entity_row in
    select jsonb_build_object(
      'name', me.name,
      'entityType', me.entity_type,
      'canonicalName', coalesce(me.canonical_name, me.name)
    )
    from memory_entities me
    where me.memory_item_id = new.id
  loop
    promoted_entity_id := 'entity_' || encode(digest(
      new.tenant_id || ':' || lower(entity_row->>'canonicalName') || ':' || lower(entity_row->>'entityType'),
      'sha256'
    ), 'hex');

    insert into entities(id, tenant_id, canonical_name, entity_type, promotion_rationale)
    values (
      promoted_entity_id,
      new.tenant_id,
      entity_row->>'canonicalName',
      entity_row->>'entityType',
      'Auto-promoted from generated memory entity metadata.'
    )
    on conflict (id) do update
    set canonical_name = excluded.canonical_name,
        entity_type = excluded.entity_type,
        updated_at = now()
    returning id into promoted_entity_id;

    insert into entity_aliases(id, tenant_id, entity_id, alias, source)
    values (
      'alias_' || gen_random_uuid()::text,
      new.tenant_id,
      promoted_entity_id,
      entity_row->>'name',
      'memory_generation'
    )
    on conflict (tenant_id, entity_id, alias) do nothing;
  end loop;

  for relation_row in
    select jsonb_build_object('predicate', mr.predicate)
    from memory_relations mr
    where mr.memory_item_id = new.id
  loop
    predicate_row_id := 'pred_' || encode(digest(new.tenant_id || ':' || lower(relation_row->>'predicate'), 'sha256'), 'hex');
    insert into predicates(id, tenant_id, canonical_name)
    values (predicate_row_id, new.tenant_id, relation_row->>'predicate')
    on conflict (id) do update
    set canonical_name = excluded.canonical_name;
  end loop;

  for schema_row in
    select jsonb_build_object(
      'subjectType', ms.subject_type,
      'predicate', ms.predicate,
      'objectType', ms.object_type,
      'status', ms.status
    )
    from memory_schemas ms
    where ms.memory_item_id = new.id
  loop
    schema_row_id := 'schema_' || encode(digest(
      new.tenant_id || ':' || lower(schema_row->>'subjectType') || ':' ||
      lower(schema_row->>'predicate') || ':' || lower(schema_row->>'objectType'),
      'sha256'
    ), 'hex');
    insert into schema_patterns(
      id,
      tenant_id,
      subject_type,
      predicate_name,
      object_type,
      status,
      support_count,
      promotion_rationale
    )
    values (
      schema_row_id,
      new.tenant_id,
      schema_row->>'subjectType',
      schema_row->>'predicate',
      schema_row->>'objectType',
      coalesce(schema_row->>'status', 'candidate'),
      1,
      'Auto-promoted from generated memory schema metadata.'
    )
    on conflict (id) do update
    set support_count = schema_patterns.support_count + 1,
        predicate_name = excluded.predicate_name,
        updated_at = now();
  end loop;

  return new;
end;
$$;

drop trigger if exists distillery_promote_memory_item_to_claim_graph_trigger on memory_items;
create trigger distillery_promote_memory_item_to_claim_graph_trigger
after insert on memory_items
for each row
execute function distillery_promote_memory_item_to_claim_graph();

create or replace function distillery_sync_memory_item_evidence_to_claim_graph()
returns trigger
language plpgsql
security definer
as $$
declare
  memory_row memory_items%rowtype;
  observation_id text;
begin
  select * into memory_row from memory_items where id = new.memory_item_id;
  if memory_row.id is null then
    return new;
  end if;

  insert into claims(
    id,
    tenant_id,
    claim_type,
    statement,
    epistemic_status,
    qualifiers,
    stable_domain_tags,
    review_state,
    supersedes_claim_id,
    source_version_id,
    ingestion_id,
    created_at,
    updated_at
  )
  values (
    memory_row.id,
    memory_row.tenant_id,
    memory_row.claim_type,
    memory_row.statement,
    memory_row.epistemic_status,
    memory_row.qualifiers,
    memory_row.stable_domain_tags,
    'unreviewed',
    memory_row.supersedes_memory_item_id,
    memory_row.source_version_id,
    memory_row.ingestion_id,
    memory_row.created_at,
    memory_row.created_at
  )
  on conflict (id) do update
  set statement = excluded.statement,
      updated_at = now();

  observation_id := 'obs_' || gen_random_uuid()::text;
  insert into observations(
    id,
    tenant_id,
    evidence_span_id,
    extraction_run_id,
    observation_type,
    raw_statement,
    qualifiers
  )
  values (
    observation_id,
    memory_row.tenant_id,
    new.evidence_span_id,
    memory_row.extraction_run_id,
    memory_row.claim_type,
    memory_row.statement,
    memory_row.qualifiers
  )
  on conflict (id) do nothing;

  insert into claim_evidence(claim_id, evidence_span_id, tenant_id, role, observation_id)
  values (new.memory_item_id, new.evidence_span_id, new.tenant_id, 'supports', observation_id)
  on conflict (claim_id, evidence_span_id, role) do nothing;

  return new;
end;
$$;

drop trigger if exists distillery_sync_memory_item_evidence_to_claim_graph_trigger on memory_item_evidence;
create trigger distillery_sync_memory_item_evidence_to_claim_graph_trigger
after insert on memory_item_evidence
for each row
execute function distillery_sync_memory_item_evidence_to_claim_graph();

create or replace function distillery_sync_memory_entity_to_claim_graph()
returns trigger
language plpgsql
security definer
as $$
declare
  promoted_entity_id text;
  canonical text;
begin
  canonical := coalesce(new.canonical_name, new.name);
  promoted_entity_id := 'entity_' || encode(digest(
    new.tenant_id || ':' || lower(canonical) || ':' || lower(new.entity_type),
    'sha256'
  ), 'hex');

  insert into entities(id, tenant_id, canonical_name, entity_type, promotion_rationale)
  values (
    promoted_entity_id,
    new.tenant_id,
    canonical,
    new.entity_type,
    'Auto-promoted from generated memory entity metadata.'
  )
  on conflict (id) do update
  set canonical_name = excluded.canonical_name,
      entity_type = excluded.entity_type,
      updated_at = now()
  returning id into promoted_entity_id;

  insert into entity_aliases(id, tenant_id, entity_id, alias, source)
  values ('alias_' || gen_random_uuid()::text, new.tenant_id, promoted_entity_id, new.name, 'memory_generation')
  on conflict (tenant_id, entity_id, alias) do nothing;

  return new;
end;
$$;

drop trigger if exists distillery_sync_memory_entity_to_claim_graph_trigger on memory_entities;
create trigger distillery_sync_memory_entity_to_claim_graph_trigger
after insert on memory_entities
for each row
execute function distillery_sync_memory_entity_to_claim_graph();

create or replace function distillery_sync_memory_relation_to_claim_graph()
returns trigger
language plpgsql
security definer
as $$
declare
  predicate_row_id text;
begin
  predicate_row_id := 'pred_' || encode(digest(new.tenant_id || ':' || lower(new.predicate), 'sha256'), 'hex');
  insert into predicates(id, tenant_id, canonical_name)
  values (predicate_row_id, new.tenant_id, new.predicate)
  on conflict (id) do update
  set canonical_name = excluded.canonical_name;

  return new;
end;
$$;

drop trigger if exists distillery_sync_memory_relation_to_claim_graph_trigger on memory_relations;
create trigger distillery_sync_memory_relation_to_claim_graph_trigger
after insert on memory_relations
for each row
execute function distillery_sync_memory_relation_to_claim_graph();

create or replace function distillery_sync_memory_schema_to_claim_graph()
returns trigger
language plpgsql
security definer
as $$
declare
  schema_row_id text;
begin
  schema_row_id := 'schema_' || encode(digest(
    new.tenant_id || ':' || lower(new.subject_type) || ':' ||
    lower(new.predicate) || ':' || lower(new.object_type),
    'sha256'
  ), 'hex');

  insert into schema_patterns(
    id,
    tenant_id,
    subject_type,
    predicate_name,
    object_type,
    status,
    support_count,
    promotion_rationale
  )
  values (
    schema_row_id,
    new.tenant_id,
    new.subject_type,
    new.predicate,
    new.object_type,
    new.status,
    1,
    'Auto-promoted from generated memory schema metadata.'
  )
  on conflict (id) do update
  set support_count = schema_patterns.support_count + 1,
      predicate_name = excluded.predicate_name,
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists distillery_sync_memory_schema_to_claim_graph_trigger on memory_schemas;
create trigger distillery_sync_memory_schema_to_claim_graph_trigger
after insert on memory_schemas
for each row
execute function distillery_sync_memory_schema_to_claim_graph();

create or replace function distillery_ingest_graph_ledger_event()
returns trigger
language plpgsql
security definer
as $$
declare
  connection jsonb;
  conflict jsonb;
  member jsonb;
  conflict_id text;
begin
  if new.event_type = 'memory_connected' then
    for connection in select * from jsonb_array_elements(coalesce(new.payload->'connections', '[]'::jsonb))
    loop
      insert into claim_connections(
        id,
        tenant_id,
        from_claim_id,
        to_claim_id,
        connection_type,
        status,
        confidence,
        score_components,
        evidence_span_ids,
        rationale,
        created_by_policy_run_id
      )
      values (
        connection->>'id',
        new.tenant_id,
        connection->>'fromClaimId',
        connection->>'toClaimId',
        connection->>'connectionType',
        coalesce(connection->>'status', 'proposed'),
        coalesce((connection->>'confidence')::numeric, 0),
        coalesce(connection->'scoreComponents', '{}'::jsonb),
        coalesce(connection->'evidenceSpanIds', '[]'::jsonb),
        connection->>'rationale',
        new.actor_label
      )
      on conflict (tenant_id, from_claim_id, to_claim_id, connection_type) do update
      set confidence = greatest(claim_connections.confidence, excluded.confidence),
          score_components = excluded.score_components,
          evidence_span_ids = excluded.evidence_span_ids,
          rationale = excluded.rationale,
          updated_at = now();
    end loop;
  end if;

  if new.event_type = 'contradiction_recorded' then
    for conflict in select * from jsonb_array_elements(coalesce(new.payload->'conflicts', '[]'::jsonb))
    loop
      conflict_id := conflict->>'id';
      insert into conflict_groups(
        id,
        tenant_id,
        conflict_type,
        severity,
        status,
        summary,
        created_by_policy_run_id
      )
      values (
        conflict_id,
        new.tenant_id,
        conflict->>'conflictType',
        conflict->>'severity',
        'open',
        conflict->>'summary',
        new.actor_label
      )
      on conflict (id) do nothing;

      for member in select * from jsonb_array_elements(coalesce(conflict->'members', '[]'::jsonb))
      loop
        insert into conflict_members(conflict_group_id, claim_id, role, evidence_span_ids)
        values (
          conflict_id,
          member->>'claimId',
          coalesce(member->>'role', 'conflicts'),
          coalesce(member->'evidenceSpanIds', '[]'::jsonb)
        )
        on conflict (conflict_group_id, claim_id) do nothing;
      end loop;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists distillery_ingest_graph_ledger_event_trigger on ledger_events;
create trigger distillery_ingest_graph_ledger_event_trigger
after insert on ledger_events
for each row
execute function distillery_ingest_graph_ledger_event();

create or replace function distillery_claim_connection_json(p_connection claim_connections)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_connection.id,
    'tenantId', p_connection.tenant_id,
    'fromClaimId', p_connection.from_claim_id,
    'toClaimId', p_connection.to_claim_id,
    'connectionType', p_connection.connection_type,
    'status', p_connection.status,
    'confidence', p_connection.confidence,
    'scoreComponents', p_connection.score_components,
    'evidenceSpanIds', p_connection.evidence_span_ids,
    'rationale', p_connection.rationale,
    'createdByPolicyRunId', p_connection.created_by_policy_run_id,
    'reviewerLabel', p_connection.reviewer_label,
    'reviewRationale', p_connection.review_rationale,
    'createdAt', p_connection.created_at,
    'updatedAt', p_connection.updated_at
  );
$$;

create or replace function distillery_conflict_group_json(p_conflict conflict_groups)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_conflict.id,
    'tenantId', p_conflict.tenant_id,
    'conflictType', p_conflict.conflict_type,
    'severity', p_conflict.severity,
    'status', p_conflict.status,
    'summary', p_conflict.summary,
    'createdByPolicyRunId', p_conflict.created_by_policy_run_id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'conflictGroupId', cm.conflict_group_id,
        'claimId', cm.claim_id,
        'role', cm.role,
        'evidenceSpanIds', cm.evidence_span_ids
      ) order by cm.role, cm.claim_id)
      from conflict_members cm
      where cm.conflict_group_id = p_conflict.id
    ), '[]'::jsonb),
    'createdAt', p_conflict.created_at,
    'updatedAt', p_conflict.updated_at
  );
$$;

create or replace function distillery_graph_claim_json(p_memory_item_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'claim', distillery_memory_item_json(p_memory_item_id),
    'evidenceSpans', distillery_memory_with_evidence_json(p_memory_item_id)->'evidenceSpans',
    'rank', 0,
    'graphScore', 0,
    'lexicalScore', 0,
    'vectorScore', 0,
    'connectionIds', coalesce((
      select jsonb_agg(cc.id order by cc.confidence desc, cc.id)
      from claim_connections cc
      where (cc.from_claim_id = p_memory_item_id or cc.to_claim_id = p_memory_item_id)
        and cc.status <> 'rejected'
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_rebuild_graph_projection(p_tenant_id text default 'stable')
returns jsonb
language plpgsql
security definer
as $$
declare
  claim_row memory_items%rowtype;
  evidence_id text;
  entity_row memory_entities%rowtype;
  connection_row claim_connections%rowtype;
begin
  delete from graph_edges where tenant_id = p_tenant_id;
  delete from graph_nodes where tenant_id = p_tenant_id;

  for claim_row in select * from memory_items where tenant_id = p_tenant_id
  loop
    insert into graph_nodes(id, tenant_id, node_type, ref_id, label, properties)
    values (
      'claim:' || claim_row.id,
      p_tenant_id,
      'claim',
      claim_row.id,
      left(claim_row.statement, 120),
      jsonb_build_object('claimType', claim_row.claim_type, 'reviewState', 'unreviewed')
    )
    on conflict (id) do update set label = excluded.label, properties = excluded.properties, updated_at = now();

    for evidence_id in select evidence_span_id from memory_item_evidence where memory_item_id = claim_row.id
    loop
      insert into graph_nodes(id, tenant_id, node_type, ref_id, label, properties)
      values ('evidence:' || evidence_id, p_tenant_id, 'evidence', evidence_id, evidence_id, '{}'::jsonb)
      on conflict (id) do nothing;

      insert into graph_edges(id, tenant_id, from_node_id, to_node_id, edge_type, weight)
      values (
        'edge:' || claim_row.id || ':evidence:' || evidence_id,
        p_tenant_id,
        'claim:' || claim_row.id,
        'evidence:' || evidence_id,
        'supported_by',
        1
      )
      on conflict (tenant_id, from_node_id, to_node_id, edge_type) do nothing;
    end loop;
  end loop;

  for entity_row in select * from memory_entities where tenant_id = p_tenant_id
  loop
    insert into graph_nodes(id, tenant_id, node_type, ref_id, label, properties)
    values (
      'entity:' || lower(regexp_replace(coalesce(entity_row.canonical_name, entity_row.name), '[^a-zA-Z0-9]+', '_', 'g')),
      p_tenant_id,
      'entity',
      coalesce(entity_row.canonical_name, entity_row.name),
      coalesce(entity_row.canonical_name, entity_row.name),
      jsonb_build_object('entityType', entity_row.entity_type)
    )
    on conflict (id) do update set label = excluded.label, updated_at = now();

    insert into graph_edges(id, tenant_id, from_node_id, to_node_id, edge_type, weight)
    values (
      'edge:' || entity_row.memory_item_id || ':entity:' || entity_row.id,
      p_tenant_id,
      'claim:' || entity_row.memory_item_id,
      'entity:' || lower(regexp_replace(coalesce(entity_row.canonical_name, entity_row.name), '[^a-zA-Z0-9]+', '_', 'g')),
      'mentions',
      0.8
    )
    on conflict (tenant_id, from_node_id, to_node_id, edge_type) do nothing;
  end loop;

  for connection_row in select * from claim_connections where tenant_id = p_tenant_id and status <> 'rejected'
  loop
    insert into graph_edges(id, tenant_id, from_node_id, to_node_id, edge_type, weight, properties)
    values (
      'edge:connection:' || connection_row.id,
      p_tenant_id,
      'claim:' || connection_row.from_claim_id,
      'claim:' || connection_row.to_claim_id,
      connection_row.connection_type,
      greatest(0.1, connection_row.confidence),
      jsonb_build_object('connectionId', connection_row.id, 'status', connection_row.status)
    )
    on conflict (tenant_id, from_node_id, to_node_id, edge_type) do update
    set weight = excluded.weight,
        properties = excluded.properties,
        updated_at = now();
  end loop;

  return jsonb_build_object(
    'tenantId', p_tenant_id,
    'nodeCount', (select count(*) from graph_nodes where tenant_id = p_tenant_id),
    'edgeCount', (select count(*) from graph_edges where tenant_id = p_tenant_id)
  );
end;
$$;

create or replace function distillery_graph_recall_context(
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
  p_limit := least(greatest(coalesce(p_limit, 8), 1), 20);

  with lexical as (
    select
      mi.id,
      (
        case when mi.statement ilike '%' || p_query || '%' then 2 else 0 end +
        coalesce((
          select count(*)::numeric
          from regexp_split_to_table(lower(p_query), '\s+') token
          where length(token) > 2 and lower(mi.statement) like '%' || token || '%'
        ), 0)
      ) as score
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
  ),
  seeds as (
    select id, score
    from lexical
    where score > 0
    order by score desc, id
    limit p_limit
  ),
  neighbors as (
    select
      case when cc.from_claim_id = seeds.id then cc.to_claim_id else cc.from_claim_id end as id,
      seeds.score * cc.confidence as score
    from seeds
    join claim_connections cc
      on (cc.from_claim_id = seeds.id or cc.to_claim_id = seeds.id)
     and cc.tenant_id = p_tenant_id
     and cc.status <> 'rejected'
  ),
  ranked as (
    select id, max(score) as score
    from (
      select * from seeds
      union all
      select * from neighbors
    ) combined
    group by id
    order by max(score) desc, id
    limit p_limit
  ),
  ranked_numbered as (
    select
      id,
      score,
      row_number() over (order by score desc, id) as rank
    from ranked
  )
  select jsonb_build_object(
    'question', p_query,
    'claims', coalesce(jsonb_agg(
      jsonb_set(
        jsonb_set(distillery_graph_claim_json(ranked_numbered.id), '{rank}', to_jsonb(ranked_numbered.rank)),
        '{lexicalScore}',
        to_jsonb(ranked_numbered.score)
      )
      order by ranked_numbered.score desc, ranked_numbered.id
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(distillery_conflict_group_json(cg) order by cg.severity, cg.created_at desc)
      from conflict_groups cg
      where cg.tenant_id = p_tenant_id
        and cg.status = 'open'
        and exists (
          select 1
          from conflict_members cm
          join ranked_numbered r on r.id = cm.claim_id
          where cm.conflict_group_id = cg.id
        )
    ), '[]'::jsonb),
    'metadata', jsonb_build_object('strategy', 'lexical+connection-neighborhood', 'limit', p_limit)
  )
  into result
  from ranked_numbered;

  return coalesce(result, jsonb_build_object(
    'question', p_query,
    'claims', '[]'::jsonb,
    'conflicts', '[]'::jsonb,
    'metadata', jsonb_build_object('strategy', 'lexical+connection-neighborhood', 'limit', p_limit)
  ));
end;
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

  with recursive expanded(id, depth, score) as (
    select unnest(coalesce(p_seed_memory_item_ids, array[]::text[])), 0, 10::numeric
    union
    select
      case when cc.from_claim_id = expanded.id then cc.to_claim_id else cc.from_claim_id end,
      expanded.depth + 1,
      expanded.score * cc.confidence
    from expanded
    join claim_connections cc
      on (cc.from_claim_id = expanded.id or cc.to_claim_id = expanded.id)
     and cc.tenant_id = p_tenant_id
     and cc.status <> 'rejected'
    where expanded.depth < 2
  ),
  ranked as (
    select mi.id, max(coalesce(expanded.score, 0)) as score, mi.created_at
    from memory_items mi
    left join expanded on expanded.id = mi.id
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1
        from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
      and not exists (
        select 1
        from graph_claim_preferences pref
        where pref.tenant_id = p_tenant_id
          and pref.claim_id = mi.id
          and pref.exclude_from_synthesis
      )
    group by mi.id, mi.created_at
    order by
      case when mi.id = any(coalesce(p_seed_memory_item_ids, array[]::text[])) then 0 else 1 end,
      max(coalesce(expanded.score, 0)) desc,
      mi.created_at desc,
      mi.id
    limit p_limit
  )
  select coalesce(jsonb_agg(distillery_memory_with_evidence_json(id) order by score desc, created_at desc, id), '[]'::jsonb)
  into result
  from ranked;

  return result;
end;
$$;

create or replace function distillery_list_graph_clusters(
  p_tenant_id text,
  p_limit integer default 50
)
returns jsonb
language sql
stable
as $$
  with entity_clusters as (
    select
      'entity:' || lower(regexp_replace(coalesce(me.canonical_name, me.name), '[^a-zA-Z0-9]+', '_', 'g')) as id,
      coalesce(me.canonical_name, me.name) as label,
      count(distinct me.memory_item_id) as claim_count,
      max(mi.created_at) as latest_claim_at,
      0 as cluster_sort
    from memory_entities me
    join memory_items mi on mi.id = me.memory_item_id
    where me.tenant_id = p_tenant_id
    group by 1, 2
  ),
  singleton_claim_clusters as (
    select
      'claim:' || mi.id as id,
      left(mi.statement, 96) as label,
      1 as claim_count,
      mi.created_at as latest_claim_at,
      1 as cluster_sort
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1
        from memory_entities me
        where me.tenant_id = mi.tenant_id
          and me.memory_item_id = mi.id
      )
  ),
  graph_clusters as (
    select * from entity_clusters
    union all
    select * from singleton_claim_clusters
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'label', label,
    'claimCount', claim_count,
    'connectionCount', (
      select count(*)
      from claim_connections cc
      where cc.tenant_id = p_tenant_id
        and (
          cc.from_claim_id in (
            select me.memory_item_id
            from memory_entities me
            where me.tenant_id = p_tenant_id
              and 'entity:' || lower(regexp_replace(coalesce(me.canonical_name, me.name), '[^a-zA-Z0-9]+', '_', 'g')) = graph_clusters.id
            union all
            select replace(graph_clusters.id, 'claim:', '')
            where graph_clusters.id like 'claim:%'
          )
          or cc.to_claim_id in (
            select me.memory_item_id
            from memory_entities me
            where me.tenant_id = p_tenant_id
              and 'entity:' || lower(regexp_replace(coalesce(me.canonical_name, me.name), '[^a-zA-Z0-9]+', '_', 'g')) = graph_clusters.id
            union all
            select replace(graph_clusters.id, 'claim:', '')
            where graph_clusters.id like 'claim:%'
          )
        )
    ),
    'openConflictCount', (
      select count(distinct cg.id)
      from conflict_groups cg
      join conflict_members cm on cm.conflict_group_id = cg.id
      where cg.tenant_id = p_tenant_id
        and cg.status = 'open'
        and cm.claim_id in (
          select me.memory_item_id
          from memory_entities me
          where me.tenant_id = p_tenant_id
            and 'entity:' || lower(regexp_replace(coalesce(me.canonical_name, me.name), '[^a-zA-Z0-9]+', '_', 'g')) = graph_clusters.id
          union all
          select replace(graph_clusters.id, 'claim:', '')
          where graph_clusters.id like 'claim:%'
        )
    )
  ) order by cluster_sort, claim_count desc, latest_claim_at desc, label), '[]'::jsonb)
  from (
    select *
    from graph_clusters
    order by cluster_sort, claim_count desc, latest_claim_at desc, label
    limit p_limit
  ) graph_clusters;
$$;

create or replace function distillery_get_graph_cluster(
  p_tenant_id text,
  p_cluster_id text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  perform distillery_rebuild_graph_projection(p_tenant_id);

  with cluster_claims as (
    select distinct me.memory_item_id as id
    from memory_entities me
    where me.tenant_id = p_tenant_id
      and 'entity:' || lower(regexp_replace(coalesce(me.canonical_name, me.name), '[^a-zA-Z0-9]+', '_', 'g')) = p_cluster_id
    union
    select mi.id
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and p_cluster_id = 'claim:' || mi.id
  )
  select jsonb_build_object(
    'id', p_cluster_id,
    'label', coalesce((select label from graph_nodes where tenant_id = p_tenant_id and id = p_cluster_id), p_cluster_id),
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', gn.id,
        'tenantId', gn.tenant_id,
        'nodeType', gn.node_type,
        'refId', gn.ref_id,
        'label', gn.label,
        'properties', gn.properties
      ) order by gn.node_type, gn.label)
      from graph_nodes gn
      where gn.tenant_id = p_tenant_id
        and (
          gn.id = p_cluster_id
          or gn.ref_id in (select id from cluster_claims)
          or gn.id in (
            select ge.to_node_id from graph_edges ge where ge.tenant_id = p_tenant_id and ge.from_node_id in (select 'claim:' || id from cluster_claims)
          )
        )
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ge.id,
        'tenantId', ge.tenant_id,
        'fromNodeId', ge.from_node_id,
        'toNodeId', ge.to_node_id,
        'edgeType', ge.edge_type,
        'weight', ge.weight,
        'properties', ge.properties
      ) order by ge.edge_type, ge.id)
      from graph_edges ge
      where ge.tenant_id = p_tenant_id
        and (ge.from_node_id in (select 'claim:' || id from cluster_claims) or ge.to_node_id in (select 'claim:' || id from cluster_claims))
    ), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(distillery_graph_claim_json(id) order by id) from cluster_claims), '[]'::jsonb),
    'connections', coalesce((
      select jsonb_agg(distillery_claim_connection_json(cc) order by cc.confidence desc, cc.id)
      from claim_connections cc
      where cc.tenant_id = p_tenant_id
        and (cc.from_claim_id in (select id from cluster_claims) or cc.to_claim_id in (select id from cluster_claims))
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(distillery_conflict_group_json(cg) order by cg.severity, cg.created_at desc)
      from conflict_groups cg
      where cg.tenant_id = p_tenant_id
        and exists (
          select 1 from conflict_members cm
          where cm.conflict_group_id = cg.id
            and cm.claim_id in (select id from cluster_claims)
        )
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

create or replace function distillery_get_graph_claim(p_tenant_id text, p_claim_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'claim', distillery_graph_claim_json(mi.id),
    'connections', coalesce((
      select jsonb_agg(distillery_claim_connection_json(cc) order by cc.confidence desc, cc.id)
      from claim_connections cc
      where cc.tenant_id = p_tenant_id
        and (cc.from_claim_id = mi.id or cc.to_claim_id = mi.id)
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(distillery_conflict_group_json(cg) order by cg.severity, cg.created_at desc)
      from conflict_groups cg
      join conflict_members cm on cm.conflict_group_id = cg.id
      where cg.tenant_id = p_tenant_id and cm.claim_id = mi.id
    ), '[]'::jsonb)
  )
  from memory_items mi
  where mi.tenant_id = p_tenant_id and mi.id = p_claim_id;
$$;

create or replace function distillery_review_claim_connection(
  p_tenant_id text,
  p_connection_id text,
  p_status text,
  p_reviewer_label text,
  p_rationale text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row claim_connections%rowtype;
begin
  if p_status not in ('accepted', 'rejected') then
    raise exception 'unsupported connection review status: %', p_status;
  end if;

  update claim_connections
  set status = p_status,
      reviewer_label = p_reviewer_label,
      review_rationale = p_rationale,
      updated_at = now()
  where tenant_id = p_tenant_id and id = p_connection_id
  returning * into row;

  if row.id is null then
    raise exception 'claim connection not found: %', p_connection_id;
  end if;

  perform distillery_rebuild_graph_projection(p_tenant_id);
  return distillery_claim_connection_json(row);
end;
$$;

create or replace function distillery_resolve_conflict(
  p_tenant_id text,
  p_conflict_group_id text,
  p_resolution_id text,
  p_resolution_type text,
  p_winning_claim_id text,
  p_reviewer_label text,
  p_rationale text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  conflict_row conflict_groups%rowtype;
begin
  insert into conflict_resolutions(
    id,
    tenant_id,
    conflict_group_id,
    resolution_type,
    winning_claim_id,
    rationale,
    reviewer_label
  )
  values (
    p_resolution_id,
    p_tenant_id,
    p_conflict_group_id,
    p_resolution_type,
    p_winning_claim_id,
    p_rationale,
    p_reviewer_label
  )
  on conflict (id) do nothing;

  update conflict_groups
  set status = 'resolved',
      updated_at = now()
  where tenant_id = p_tenant_id and id = p_conflict_group_id
  returning * into conflict_row;

  if conflict_row.id is null then
    raise exception 'conflict group not found: %', p_conflict_group_id;
  end if;

  return distillery_conflict_group_json(conflict_row);
end;
$$;

create or replace function distillery_set_graph_claim_preference(
  p_tenant_id text,
  p_claim_id text,
  p_pinned boolean default null,
  p_exclude_from_synthesis boolean default null,
  p_reviewer_label text default null,
  p_rationale text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row graph_claim_preferences%rowtype;
begin
  insert into graph_claim_preferences(
    tenant_id,
    claim_id,
    pinned,
    exclude_from_synthesis,
    reviewer_label,
    rationale
  )
  values (
    p_tenant_id,
    p_claim_id,
    coalesce(p_pinned, false),
    coalesce(p_exclude_from_synthesis, false),
    p_reviewer_label,
    p_rationale
  )
  on conflict (tenant_id, claim_id) do update
  set pinned = coalesce(p_pinned, graph_claim_preferences.pinned),
      exclude_from_synthesis = coalesce(p_exclude_from_synthesis, graph_claim_preferences.exclude_from_synthesis),
      reviewer_label = coalesce(p_reviewer_label, graph_claim_preferences.reviewer_label),
      rationale = coalesce(p_rationale, graph_claim_preferences.rationale),
      updated_at = now()
  returning * into row;

  return jsonb_build_object(
    'tenantId', row.tenant_id,
    'claimId', row.claim_id,
    'pinned', row.pinned,
    'excludeFromSynthesis', row.exclude_from_synthesis,
    'reviewerLabel', row.reviewer_label,
    'rationale', row.rationale,
    'updatedAt', row.updated_at
  );
end;
$$;

create or replace function distillery_upsert_memory_embeddings(
  p_tenant_id text,
  p_embeddings jsonb
)
returns void
language plpgsql
security definer
as $$
declare
  item jsonb;
begin
  for item in select * from jsonb_array_elements(coalesce(p_embeddings, '[]'::jsonb))
  loop
    insert into memory_embeddings(
      id,
      tenant_id,
      target_type,
      target_id,
      embedding_model,
      embedding,
      content_hash
    )
    values (
      item->>'id',
      p_tenant_id,
      item->>'targetType',
      item->>'targetId',
      item->>'embeddingModel',
      (
        select array_agg(value::real order by ord)::vector
        from jsonb_array_elements_text(item->'embedding') with ordinality as embedding_values(value, ord)
      ),
      item->>'contentHash'
    )
    on conflict (tenant_id, target_type, target_id, embedding_model, content_hash) do nothing;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
