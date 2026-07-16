-- Corpus-wide, versioned synthesis discovery and readiness.
-- Canonical memory/evidence remain unchanged; all cluster rows are rebuildable derived state.

alter table pending_work drop constraint if exists pending_work_policy_check;
alter table pending_work add constraint pending_work_policy_check check (policy in (
  'extract_memory', 'connect_memory', 'discover_candidate', 'check_freshness',
  'detect_contradiction', 'update_embeddings', 'update_graph', 'recompute_cluster',
  'evaluate_synthesis_readiness', 'synthesize_brief', 'rank_candidate',
  'draft_artifact', 'gate_output', 'revise_artifact'
));

alter table ledger_events drop constraint if exists ledger_events_event_type_check;
alter table ledger_events add constraint ledger_events_event_type_check check (event_type in (
  'source_committed', 'memory_committed', 'memory_connected', 'connections_updated',
  'contradictions_updated', 'embeddings_updated', 'graph_updated', 'memory_review_changed',
  'synthesis_neighborhood_dirty', 'cluster_changed', 'cluster_readiness_changed',
  'synthesis_ready', 'memory_confirmed', 'memory_edited', 'memory_removed',
  'candidate_created', 'candidate_approved', 'candidate_rejected', 'artifact_drafted',
  'artifact_approved', 'artifact_rejected', 'artifact_delivered', 'decision_committed',
  'freshness_warning_committed', 'contradiction_recorded', 'policy_run_recorded'
));

alter table ledger_events drop constraint if exists ledger_events_subject_type_check;
alter table ledger_events add constraint ledger_events_subject_type_check check (
  subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);
alter table pending_work drop constraint if exists pending_work_subject_type_check;
alter table pending_work add constraint pending_work_subject_type_check check (
  subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
);

alter table proposed_events
  drop constraint if exists proposed_events_subject_type_check,
  drop constraint if exists proposed_events_proposed_event_type_check,
  drop constraint if exists proposed_events_target_event_type_check;
alter table proposed_events
  add constraint proposed_events_subject_type_check check (
    subject_type in ('source', 'memory', 'candidate', 'artifact', 'decision', 'system', 'cluster')
  ),
  add constraint proposed_events_proposed_event_type_check check (proposed_event_type in (
    'memory_proposed', 'memory_connection_proposed', 'candidate_proposed',
    'artifact_draft_proposed', 'freshness_warning_proposed', 'contradiction_proposed',
    'decision_record_proposed', 'enrichment_update_proposed',
    'cluster_projection_proposed', 'readiness_evaluation_proposed'
  )),
  add constraint proposed_events_target_event_type_check check (target_event_type in (
    'source_committed', 'memory_committed', 'memory_connected', 'connections_updated',
    'contradictions_updated', 'embeddings_updated', 'graph_updated', 'memory_review_changed',
    'synthesis_neighborhood_dirty', 'cluster_changed', 'cluster_readiness_changed',
    'synthesis_ready', 'memory_confirmed', 'memory_edited', 'memory_removed',
    'candidate_created', 'candidate_approved', 'candidate_rejected', 'artifact_drafted',
    'artifact_approved', 'artifact_rejected', 'artifact_delivered', 'decision_committed',
    'freshness_warning_committed', 'contradiction_recorded', 'policy_run_recorded'
  ));

create table if not exists synthesis_enrichment_states (
  tenant_id text not null references tenants(id),
  memory_item_id text not null references memory_items(id),
  input_version text not null,
  completed_facets jsonb not null default '[]'::jsonb,
  failed_facets jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, memory_item_id),
  check (jsonb_typeof(completed_facets) = 'array'),
  check (jsonb_typeof(failed_facets) = 'array')
);

create table if not exists synthesis_clusters (
  id text primary key,
  tenant_id text not null references tenants(id),
  resolution text not null check (resolution in ('narrow_decision', 'initiative', 'strategic_theme')),
  meaning_key text not null,
  label text not null,
  status text not null default 'active' check (status in ('active', 'superseded')),
  current_version text not null,
  membership_hash text not null,
  core_entities jsonb not null default '[]'::jsonb,
  core_topics jsonb not null default '[]'::jsonb,
  last_meaningful_change_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, resolution, meaning_key)
);

create table if not exists synthesis_cluster_versions (
  cluster_id text not null references synthesis_clusters(id),
  version text not null,
  tenant_id text not null references tenants(id),
  membership_hash text not null,
  evidence_span_ids jsonb not null default '[]'::jsonb,
  source_version_ids jsonb not null default '[]'::jsonb,
  contradiction_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (cluster_id, version)
);

create table if not exists synthesis_cluster_memberships (
  cluster_id text not null,
  cluster_version text not null,
  tenant_id text not null references tenants(id),
  memory_item_id text not null references memory_items(id),
  membership_score numeric not null check (membership_score >= 0 and membership_score <= 1),
  membership_reasons jsonb not null default '[]'::jsonb,
  member_role text not null check (member_role in ('core', 'supporting', 'context')),
  created_at timestamptz not null default now(),
  primary key (cluster_id, cluster_version, memory_item_id),
  foreign key (cluster_id, cluster_version) references synthesis_cluster_versions(cluster_id, version)
);

create table if not exists synthesis_readiness_evaluations (
  id text primary key,
  tenant_id text not null references tenants(id),
  cluster_id text not null references synthesis_clusters(id),
  cluster_version text not null,
  generation_intent text not null,
  state text not null check (state in (
    'pending_enrichment', 'not_ready', 'ready', 'draft_generated',
    'superseded', 'failed'
  )),
  score numeric not null check (score >= 0 and score <= 100),
  breakdown jsonb not null,
  reasons jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  missing_information jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cluster_id, cluster_version, generation_intent),
  foreign key (cluster_id, cluster_version) references synthesis_cluster_versions(cluster_id, version)
);

create table if not exists suggested_briefs (
  id text primary key,
  tenant_id text not null references tenants(id),
  cluster_id text not null references synthesis_clusters(id),
  generation_intent text not null,
  status text not null default 'suggested' check (status in ('suggested', 'approved', 'rejected', 'superseded')),
  current_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cluster_id, generation_intent)
);

create table if not exists suggested_brief_versions (
  suggested_brief_id text not null references suggested_briefs(id),
  version integer not null,
  tenant_id text not null references tenants(id),
  cluster_id text not null,
  cluster_version text not null,
  generation_intent text not null,
  initiative_brief_id text not null references initiative_briefs(id),
  structured_draft jsonb not null,
  memory_item_ids jsonb not null,
  evidence_span_ids jsonb not null,
  contradictions jsonb not null default '[]'::jsonb,
  uncertainties jsonb not null default '[]'::jsonb,
  model_metadata jsonb not null default '{}'::jsonb,
  origin text not null default 'generated' check (origin in ('generated', 'human_edit')),
  created_at timestamptz not null default now(),
  primary key (suggested_brief_id, version),
  unique (suggested_brief_id, initiative_brief_id, version)
);

alter table suggested_brief_versions add column if not exists origin text not null default 'generated';
alter table suggested_brief_versions drop constraint if exists suggested_brief_versions_tenant_id_cluster_id_cluster_versi_key;
create unique index if not exists suggested_brief_generated_once_idx
  on suggested_brief_versions(tenant_id, cluster_id, cluster_version, generation_intent)
  where origin = 'generated';

create table if not exists synthesis_dirty_neighborhoods (
  tenant_id text not null references tenants(id),
  memory_item_id text not null references memory_items(id),
  reason text not null,
  input_version text not null,
  status text not null default 'pending' check (status in ('pending', 'dispatched')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, memory_item_id)
);

create table if not exists synthesis_global_scan_cursors (
  tenant_id text primary key references tenants(id),
  last_memory_item_id text,
  cycle bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists synthesis_clusters_rank_idx on synthesis_clusters(tenant_id, status, last_meaningful_change_at desc);
create index if not exists synthesis_memberships_memory_idx on synthesis_cluster_memberships(tenant_id, memory_item_id, created_at desc);
create index if not exists synthesis_readiness_rank_idx on synthesis_readiness_evaluations(tenant_id, state, score desc, evaluated_at desc);
create index if not exists synthesis_dirty_pending_idx on synthesis_dirty_neighborhoods(tenant_id, status, updated_at);

create or replace function distillery_synthesis_cluster_json(p_cluster synthesis_clusters)
returns jsonb
language sql
stable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_cluster.id,
    'tenantId', p_cluster.tenant_id,
    'resolution', p_cluster.resolution,
    'meaningKey', p_cluster.meaning_key,
    'label', p_cluster.label,
    'version', p_cluster.current_version,
    'membershipHash', p_cluster.membership_hash,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'memoryItemId', scm.memory_item_id,
        'score', scm.membership_score,
        'reasons', scm.membership_reasons,
        'role', scm.member_role
      ) order by scm.membership_score desc, scm.memory_item_id)
      from synthesis_cluster_memberships scm
      where scm.cluster_id = p_cluster.id and scm.cluster_version = p_cluster.current_version
    ), '[]'::jsonb),
    'coreEntities', p_cluster.core_entities,
    'coreTopics', p_cluster.core_topics,
    'evidenceSpanIds', coalesce(scv.evidence_span_ids, '[]'::jsonb),
    'sourceVersionIds', coalesce(scv.source_version_ids, '[]'::jsonb),
    'contradictionIds', coalesce(scv.contradiction_ids, '[]'::jsonb),
    'lastMeaningfulChangeAt', p_cluster.last_meaningful_change_at,
    'readiness', (
      select jsonb_build_object(
        'id', sre.id,
        'clusterId', sre.cluster_id,
        'clusterVersion', sre.cluster_version,
        'generationIntent', sre.generation_intent,
        'state', sre.state,
        'score', sre.score,
        'breakdown', sre.breakdown,
        'reasons', sre.reasons,
        'warnings', sre.warnings,
        'missingInformation', sre.missing_information,
        'evaluatedAt', sre.evaluated_at
      )
      from synthesis_readiness_evaluations sre
      where sre.cluster_id = p_cluster.id and sre.cluster_version = p_cluster.current_version
      order by sre.evaluated_at desc limit 1
    )
  ))
  from synthesis_cluster_versions scv
  where scv.cluster_id = p_cluster.id and scv.version = p_cluster.current_version;
$$;

drop function if exists distillery_get_corpus_synthesis_state(text, integer);
create or replace function distillery_get_corpus_synthesis_state(
  p_tenant_id text,
  p_limit integer default 500,
  p_seed_memory_item_ids text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_result jsonb;
begin
  select jsonb_build_object(
    'memory', coalesce((
      select jsonb_agg(distillery_memory_with_evidence_json(c.id) order by c.priority, c.created_at desc, c.id)
      from (
        with neighborhood_candidates as (
          select mi.id, 0 as priority
          from memory_items mi
          where mi.tenant_id = p_tenant_id and mi.id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
          union all
          select case when cc.from_claim_id = any(coalesce(p_seed_memory_item_ids, array[]::text[])) then cc.to_claim_id else cc.from_claim_id end, 1
          from claim_connections cc
          where cc.tenant_id = p_tenant_id and cc.status <> 'rejected'
            and (cc.from_claim_id = any(coalesce(p_seed_memory_item_ids, array[]::text[])) or cc.to_claim_id = any(coalesce(p_seed_memory_item_ids, array[]::text[])))
          union all
          select related.target_id, 1
          from memory_embeddings seed
          join memory_embeddings related
            on related.tenant_id = seed.tenant_id
           and related.target_type = 'claim'
           and related.embedding_model = seed.embedding_model
           and related.target_id <> seed.target_id
          where seed.tenant_id = p_tenant_id
            and seed.target_type = 'claim'
            and seed.target_id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
            and greatest(0, 1 - (seed.embedding <=> related.embedding)) >= 0.72
          union all
          select related.memory_item_id, 2
          from memory_entities seed
          join memory_entities related
            on related.tenant_id = seed.tenant_id
           and lower(coalesce(related.canonical_name, related.name)) = lower(coalesce(seed.canonical_name, seed.name))
          where seed.tenant_id = p_tenant_id and seed.memory_item_id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
          union all
          select related.memory_item_id, 2
          from memory_schemas seed
          join memory_schemas related
            on related.tenant_id = seed.tenant_id
           and lower(related.subject_type) = lower(seed.subject_type)
           and lower(related.predicate) = lower(seed.predicate)
           and lower(related.object_type) = lower(seed.object_type)
          where seed.tenant_id = p_tenant_id and seed.memory_item_id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
          union all
          select related.id, 3
          from memory_items seed
          join memory_items related on related.tenant_id = seed.tenant_id and related.id <> seed.id
          where seed.tenant_id = p_tenant_id
            and seed.id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
            and to_tsvector('english', related.statement) @@ plainto_tsquery('english', seed.statement)
          union all
          select mi.id, 4 from memory_items mi where mi.tenant_id = p_tenant_id
        )
        select mi.id, mi.created_at, min(nc.priority) as priority
        from neighborhood_candidates nc
        join memory_items mi on mi.id = nc.id and mi.tenant_id = p_tenant_id
        where not exists (
            select 1 from memory_item_events mie
            where mie.memory_item_id = mi.id and mie.event_type in ('remove', 'edit')
          )
        group by mi.id, mi.created_at
        order by priority, mi.created_at desc, mi.id
        limit v_limit
      ) c
    ), '[]'::jsonb),
    'connections', coalesce((
      select jsonb_agg(distillery_claim_connection_json(cc) order by cc.confidence desc, cc.id)
      from claim_connections cc
      where cc.tenant_id = p_tenant_id and cc.status <> 'rejected'
    ), '[]'::jsonb),
    'similarities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'fromMemoryItemId', similarity.from_memory_item_id,
        'toMemoryItemId', similarity.to_memory_item_id,
        'vectorScore', similarity.vector_score,
        'sparseScore', 0,
        'reasons', jsonb_build_array('Claim embeddings are close in the configured vector space.')
      ) order by similarity.vector_score desc, similarity.from_memory_item_id, similarity.to_memory_item_id)
      from (
        with latest_claim_embeddings as (
          select distinct on (me.target_id, me.embedding_model)
            me.target_id, me.embedding_model, me.embedding
          from memory_embeddings me
          where me.tenant_id = p_tenant_id and me.target_type = 'claim'
          order by me.target_id, me.embedding_model, me.created_at desc, me.id desc
        )
        select
          seed.target_id as from_memory_item_id,
          related.target_id as to_memory_item_id,
          greatest(0, 1 - (seed.embedding <=> related.embedding))::double precision as vector_score
        from latest_claim_embeddings seed
        join latest_claim_embeddings related
          on related.embedding_model = seed.embedding_model
         and related.target_id <> seed.target_id
        join memory_items related_memory
          on related_memory.id = related.target_id and related_memory.tenant_id = p_tenant_id
        where seed.target_id = any(coalesce(p_seed_memory_item_ids, array[]::text[]))
          and greatest(0, 1 - (seed.embedding <=> related.embedding)) >= 0.72
          and not exists (
            select 1 from memory_item_events mie
            where mie.memory_item_id = related.target_id and mie.event_type in ('remove', 'edit')
          )
          and not exists (
            select 1 from graph_claim_preferences pref
            where pref.tenant_id = p_tenant_id
              and pref.claim_id = related.target_id
              and pref.exclude_from_synthesis
          )
        order by vector_score desc, seed.target_id, related.target_id
        limit least(v_limit * 4, 2000)
      ) similarity
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(distillery_conflict_group_json(cg) order by cg.created_at desc, cg.id)
      from conflict_groups cg where cg.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'clusters', coalesce((
      select jsonb_agg(distillery_synthesis_cluster_json(sc) order by sc.last_meaningful_change_at desc, sc.id)
      from synthesis_clusters sc where sc.tenant_id = p_tenant_id and sc.status = 'active'
    ), '[]'::jsonb),
    'suggestedBriefs', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', sb.id,
        'initiativeBriefId', current_version.initiative_brief_id,
        'tenantId', sb.tenant_id,
        'clusterId', current_version.cluster_id,
        'clusterVersion', current_version.cluster_version,
        'generationIntent', current_version.generation_intent,
        'version', current_version.version,
        'status', case ib.status when 'approved' then 'approved' when 'rejected' then 'rejected' else sb.status end,
        'draft', current_version.structured_draft,
        'origin', current_version.origin,
        'previousVersion', case when previous_version.version is null then null else jsonb_build_object(
          'version', previous_version.version,
          'draft', previous_version.structured_draft
        ) end,
        'contradictions', current_version.uncertainties,
        'uncertainties', current_version.uncertainties,
        'modelMetadata', current_version.model_metadata,
        'createdAt', current_version.created_at,
        'updatedAt', sb.updated_at
      )) order by current_version.created_at desc, sb.id)
      from suggested_briefs sb
      join suggested_brief_versions current_version
        on current_version.suggested_brief_id = sb.id and current_version.version = sb.current_version
      join initiative_briefs ib on ib.id = current_version.initiative_brief_id
      left join suggested_brief_versions previous_version
        on previous_version.suggested_brief_id = sb.id and previous_version.version = current_version.version - 1
      where sb.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'enrichment', coalesce((
      select jsonb_agg(jsonb_build_object(
        'memoryItemId', ses.memory_item_id,
        'inputVersion', ses.input_version,
        'completedFacets', ses.completed_facets,
        'failedFacets', ses.failed_facets,
        'updatedAt', ses.updated_at
      ) order by ses.memory_item_id)
      from synthesis_enrichment_states ses where ses.tenant_id = p_tenant_id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function distillery_ingest_graph_ledger_event()
returns trigger
language plpgsql
security definer
as $$
declare
  v_connection jsonb;
  v_conflict jsonb;
  v_member jsonb;
  v_conflict_id text;
begin
  if new.event_type in ('memory_connected', 'connections_updated') then
    for v_connection in select * from jsonb_array_elements(coalesce(new.payload->'connections', '[]'::jsonb)) loop
      insert into claim_connections(
        id, tenant_id, from_claim_id, to_claim_id, connection_type, status,
        confidence, score_components, evidence_span_ids, rationale, created_by_policy_run_id
      ) values (
        v_connection->>'id', new.tenant_id, v_connection->>'fromClaimId',
        v_connection->>'toClaimId', v_connection->>'connectionType',
        coalesce(v_connection->>'status', 'proposed'),
        coalesce((v_connection->>'confidence')::numeric, 0),
        coalesce(v_connection->'scoreComponents', '{}'::jsonb),
        coalesce(v_connection->'evidenceSpanIds', '[]'::jsonb),
        v_connection->>'rationale', new.actor_label
      ) on conflict (tenant_id, from_claim_id, to_claim_id, connection_type) do update
      set confidence = greatest(claim_connections.confidence, excluded.confidence),
          score_components = excluded.score_components,
          evidence_span_ids = excluded.evidence_span_ids,
          rationale = excluded.rationale,
          updated_at = now();
    end loop;
  end if;

  if new.event_type in ('contradiction_recorded', 'contradictions_updated') then
    for v_conflict in select * from jsonb_array_elements(coalesce(new.payload->'conflicts', '[]'::jsonb)) loop
      v_conflict_id := v_conflict->>'id';
      insert into conflict_groups(id, tenant_id, conflict_type, severity, status, summary, created_by_policy_run_id)
      values (v_conflict_id, new.tenant_id, v_conflict->>'conflictType', v_conflict->>'severity', 'open', v_conflict->>'summary', new.actor_label)
      on conflict (id) do nothing;
      for v_member in select * from jsonb_array_elements(coalesce(v_conflict->'members', '[]'::jsonb)) loop
        insert into conflict_members(conflict_group_id, claim_id, role, evidence_span_ids)
        values (v_conflict_id, v_member->>'claimId', coalesce(v_member->>'role', 'conflicts'), coalesce(v_member->'evidenceSpanIds', '[]'::jsonb))
        on conflict (conflict_group_id, claim_id) do nothing;
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create or replace function distillery_ingest_synthesis_ledger_event()
returns trigger
language plpgsql
security definer
as $$
declare
  v_memory_item_id text;
  v_facet text;
  v_cluster jsonb;
  v_membership jsonb;
  v_evaluation jsonb;
begin
  if new.event_type in ('memory_committed', 'memory_confirmed', 'memory_edited', 'memory_removed', 'memory_review_changed') then
    for v_memory_item_id in select * from jsonb_array_elements_text(coalesce(new.payload->'memoryItemIds', jsonb_build_array(new.subject_id))) loop
      insert into synthesis_dirty_neighborhoods(tenant_id, memory_item_id, reason, input_version, status)
      select new.tenant_id, v_memory_item_id, new.event_type, coalesce(new.input_version, new.id), 'pending'
      where exists (select 1 from memory_items mi where mi.id = v_memory_item_id and mi.tenant_id = new.tenant_id)
      on conflict (tenant_id, memory_item_id) do update
      set reason = excluded.reason, input_version = excluded.input_version, status = 'pending', updated_at = now();
    end loop;
  end if;

  if new.event_type in ('connections_updated', 'contradictions_updated', 'embeddings_updated', 'graph_updated') then
    v_facet := case new.event_type
      when 'connections_updated' then 'connections'
      when 'contradictions_updated' then 'contradictions'
      when 'embeddings_updated' then 'embeddings'
      else 'graph'
    end;
    for v_memory_item_id in select * from jsonb_array_elements_text(coalesce(new.payload->'memoryItemIds', new.payload->'seedMemoryItemIds', '[]'::jsonb)) loop
      -- Connections and contradictions are graph inputs. Mark the graph facet
      -- incomplete before routing their rebuild so readiness cannot observe a
      -- completion from an older projection.
      if v_facet in ('connections', 'contradictions') then
        update synthesis_enrichment_states
        set completed_facets = completed_facets - 'graph', updated_at = now()
        where tenant_id = new.tenant_id and memory_item_id = v_memory_item_id;
      end if;
      insert into synthesis_enrichment_states(tenant_id, memory_item_id, input_version, completed_facets)
      values (new.tenant_id, v_memory_item_id, coalesce(new.input_version, new.id), jsonb_build_array(v_facet))
      on conflict (tenant_id, memory_item_id) do update
      set input_version = excluded.input_version,
          completed_facets = (
            select jsonb_agg(distinct value order by value)
            from jsonb_array_elements_text(synthesis_enrichment_states.completed_facets || excluded.completed_facets) value
          ),
          failed_facets = synthesis_enrichment_states.failed_facets - v_facet,
          updated_at = now();
    end loop;
  end if;

  if new.event_type = 'cluster_changed' and jsonb_typeof(new.payload->'cluster') = 'object' then
    v_cluster := new.payload->'cluster';
    insert into synthesis_clusters(
      id, tenant_id, resolution, meaning_key, label, status, current_version,
      membership_hash, core_entities, core_topics, last_meaningful_change_at
    ) values (
      v_cluster->>'id', new.tenant_id, v_cluster->>'resolution', v_cluster->>'meaningKey',
      v_cluster->>'label', 'active', v_cluster->>'version', v_cluster->>'membershipHash',
      coalesce(v_cluster->'coreEntities', '[]'::jsonb), coalesce(v_cluster->'coreTopics', '[]'::jsonb),
      (v_cluster->>'lastMeaningfulChangeAt')::timestamptz
    ) on conflict (id) do update
    set label = excluded.label, status = 'active', current_version = excluded.current_version,
        membership_hash = excluded.membership_hash, core_entities = excluded.core_entities,
        core_topics = excluded.core_topics,
        last_meaningful_change_at = excluded.last_meaningful_change_at, updated_at = now();

    insert into synthesis_cluster_versions(
      cluster_id, version, tenant_id, membership_hash, evidence_span_ids,
      source_version_ids, contradiction_ids
    ) values (
      v_cluster->>'id', v_cluster->>'version', new.tenant_id, v_cluster->>'membershipHash',
      coalesce(v_cluster->'evidenceSpanIds', '[]'::jsonb),
      coalesce(v_cluster->'sourceVersionIds', '[]'::jsonb),
      coalesce(v_cluster->'contradictionIds', '[]'::jsonb)
    ) on conflict (cluster_id, version) do nothing;

    for v_membership in select * from jsonb_array_elements(coalesce(v_cluster->'memberships', '[]'::jsonb)) loop
      insert into synthesis_cluster_memberships(
        cluster_id, cluster_version, tenant_id, memory_item_id,
        membership_score, membership_reasons, member_role
      ) values (
        v_cluster->>'id', v_cluster->>'version', new.tenant_id,
        v_membership->>'memoryItemId', (v_membership->>'score')::numeric,
        coalesce(v_membership->'reasons', '[]'::jsonb), v_membership->>'role'
      ) on conflict (cluster_id, cluster_version, memory_item_id) do nothing;
    end loop;
  elsif new.event_type = 'cluster_changed' and new.payload ? 'supersededClusterId' then
    update synthesis_clusters set status = 'superseded', updated_at = now()
    where id = new.payload->>'supersededClusterId' and tenant_id = new.tenant_id;
    update synthesis_readiness_evaluations set state = 'superseded', updated_at = now()
    where cluster_id = new.payload->>'supersededClusterId' and tenant_id = new.tenant_id;
  end if;

  if new.event_type in ('cluster_readiness_changed', 'synthesis_ready') then
    v_evaluation := new.payload->'evaluation';
    insert into synthesis_readiness_evaluations(
      id, tenant_id, cluster_id, cluster_version, generation_intent, state,
      score, breakdown, reasons, warnings, missing_information, evaluated_at
    ) values (
      v_evaluation->>'id', new.tenant_id, v_evaluation->>'clusterId',
      v_evaluation->>'clusterVersion', v_evaluation->>'generationIntent',
      v_evaluation->>'state', (v_evaluation->>'score')::numeric,
      v_evaluation->'breakdown', coalesce(v_evaluation->'reasons', '[]'::jsonb),
      coalesce(v_evaluation->'warnings', '[]'::jsonb),
      coalesce(v_evaluation->'missingInformation', '[]'::jsonb),
      (v_evaluation->>'evaluatedAt')::timestamptz
    ) on conflict (tenant_id, cluster_id, cluster_version, generation_intent) do update
    set state = excluded.state, score = excluded.score, breakdown = excluded.breakdown,
        reasons = excluded.reasons, warnings = excluded.warnings,
        missing_information = excluded.missing_information,
        evaluated_at = excluded.evaluated_at, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists distillery_ingest_synthesis_ledger_event_trigger on ledger_events;
create trigger distillery_ingest_synthesis_ledger_event_trigger
after insert on ledger_events for each row execute function distillery_ingest_synthesis_ledger_event();

create or replace function distillery_schedule_synthesis_scan_events(
  p_tenant_id text,
  p_limit integer default 10
)
returns integer
language plpgsql
security definer
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10);
  v_cursor synthesis_global_scan_cursors%rowtype;
  v_memory_item_id text;
  v_is_global boolean;
  v_event_id text;
  v_candidate_event_id text;
  v_count integer := 0;
begin
  insert into synthesis_global_scan_cursors(tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into v_cursor from synthesis_global_scan_cursors where tenant_id = p_tenant_id for update;

  for v_memory_item_id, v_is_global in
    select candidates.memory_item_id, bool_or(candidates.is_global)
    from (
      (
        select sdn.memory_item_id, false as is_global, 0 as priority
        from synthesis_dirty_neighborhoods sdn
        where sdn.tenant_id = p_tenant_id and sdn.status = 'pending'
        order by sdn.updated_at, sdn.memory_item_id
        limit v_limit
      )
      union all
      (
        select mi.id, true as is_global, 1 as priority
        from memory_items mi
        where mi.tenant_id = p_tenant_id
          and (v_cursor.last_memory_item_id is null or mi.id > v_cursor.last_memory_item_id)
          and not exists (
            select 1 from memory_item_events mie
            where mie.memory_item_id = mi.id and mie.event_type in ('remove', 'edit')
          )
        order by mi.id
        limit v_limit
      )
    ) candidates
    group by candidates.memory_item_id
    order by min(candidates.priority), candidates.memory_item_id
    limit v_limit
  loop
    v_candidate_event_id := 'levt_' || gen_random_uuid()::text;
    v_event_id := null;
    insert into ledger_events(
      id, tenant_id, event_type, subject_type, subject_id, actor_type,
      actor_label, input_version, idempotency_key, payload
    ) values (
      v_candidate_event_id, p_tenant_id, 'synthesis_neighborhood_dirty', 'memory',
      v_memory_item_id, 'system', 'global_synthesis_sweep',
      'sweep:' || v_cursor.cycle::text || ':' || v_memory_item_id,
      'synthesis-sweep:' || v_cursor.cycle::text || ':' || v_memory_item_id,
      jsonb_build_object('memoryItemIds', jsonb_build_array(v_memory_item_id), 'sweepCycle', v_cursor.cycle)
    ) on conflict (tenant_id, idempotency_key) do nothing returning id into v_event_id;
    if v_event_id is not null then
      insert into event_outbox(id, tenant_id, ledger_event_id)
      values ('eout_' || gen_random_uuid()::text, p_tenant_id, v_event_id)
      on conflict (ledger_event_id) do nothing;
      v_count := v_count + 1;
    end if;
    update synthesis_dirty_neighborhoods set status = 'dispatched', updated_at = now()
    where tenant_id = p_tenant_id and memory_item_id = v_memory_item_id;
    if v_is_global then
      v_cursor.last_memory_item_id := v_memory_item_id;
    end if;
  end loop;

  if v_count = 0 and exists (select 1 from memory_items mi where mi.tenant_id = p_tenant_id) then
    v_cursor.last_memory_item_id := null;
    v_cursor.cycle := v_cursor.cycle + 1;
  end if;
  update synthesis_global_scan_cursors
  set last_memory_item_id = v_cursor.last_memory_item_id, cycle = v_cursor.cycle, updated_at = now()
  where tenant_id = p_tenant_id;
  return v_count;
end;
$$;

-- Replaces the earlier function to remove the ambiguous memory_item_id variable,
-- validate evidence-to-memory bindings, and persist suggested-brief versions once.
create or replace function distillery_commit_validated_proposed_event(p_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_proposal proposed_events%rowtype;
  v_ledger_row ledger_events%rowtype;
  v_brief_id text;
  v_memory_item_ids text[];
  v_evidence_span_ids text[];
  v_memory_item_id text;
  v_evidence_span_id text;
  v_cluster_id text;
  v_cluster_version text;
  v_generation_intent text;
  v_suggested_brief_id text;
  v_suggested_version integer;
  v_existing_brief_id text;
  v_ledger_idempotency_key text;
  v_ledger_subject_id text;
begin
  select pe.* into v_proposal from proposed_events pe where pe.id = p_id for update;
  if v_proposal.id is null then raise exception 'proposed event not found: %', p_id; end if;
  if v_proposal.validation_status <> 'valid' then raise exception 'invalid proposal cannot commit: %', p_id; end if;
  if v_proposal.requires_human_approval and v_proposal.review_status <> 'approved' then
    raise exception 'proposal requires human approval: %', p_id;
  end if;
  if v_proposal.committed_ledger_event_id is not null then
    select le.* into v_ledger_row from ledger_events le where le.id = v_proposal.committed_ledger_event_id;
    return distillery_ledger_event_to_json(v_ledger_row);
  end if;

  v_ledger_idempotency_key := 'proposal:' || v_proposal.id;
  v_ledger_subject_id := v_proposal.subject_id;

  if v_proposal.target_event_type = 'memory_committed' then
    perform distillery_commit_generated_memory(
      v_proposal.payload->>'ingestionId', v_proposal.tenant_id,
      v_proposal.payload->>'sourceVersionId', v_proposal.payload->>'extractionRunId',
      v_proposal.payload->>'memoryGenerationVersion', v_proposal.payload->'items'
    );
  end if;

  if v_proposal.target_event_type = 'artifact_drafted' then
    v_brief_id := coalesce(v_proposal.payload->>'briefId', v_proposal.subject_id);
    select array_agg(j.value) into v_memory_item_ids
    from jsonb_array_elements_text(coalesce(v_proposal.payload->'memoryItemIds', v_proposal.payload->'selectedMemoryItemIds', '[]'::jsonb)) j(value);
    select array_agg(j.value) into v_evidence_span_ids
    from jsonb_array_elements_text(coalesce(v_proposal.payload->'evidenceSpanIds', v_proposal.payload->'selectedEvidenceSpanIds', '[]'::jsonb)) j(value);
    if coalesce(v_brief_id, '') = '' then raise exception 'artifact_drafted proposal requires briefId'; end if;
    if array_length(v_memory_item_ids, 1) is null then raise exception 'artifact_drafted proposal requires memoryItemIds'; end if;
    if array_length(v_evidence_span_ids, 1) is null then raise exception 'artifact_drafted proposal requires evidenceSpanIds'; end if;

    v_cluster_id := nullif(v_proposal.payload->>'clusterId', '');
    v_cluster_version := nullif(v_proposal.payload->>'clusterVersion', '');
    v_generation_intent := coalesce(nullif(v_proposal.payload->>'generationIntent', ''), 'initiative_brief');

    foreach v_memory_item_id in array v_memory_item_ids loop
      if not exists (
        select 1 from memory_items mi
        where mi.id = v_memory_item_id and mi.tenant_id = v_proposal.tenant_id
      ) then raise exception 'artifact draft memory item not found for tenant: %', v_memory_item_id; end if;
      if exists (
        select 1 from memory_item_events mie
        where mie.memory_item_id = v_memory_item_id and mie.event_type in ('remove', 'edit')
      ) then raise exception 'inactive memory item cannot support artifact draft: %', v_memory_item_id; end if;
    end loop;

    foreach v_evidence_span_id in array v_evidence_span_ids loop
      if not exists (
        select 1
        from memory_item_evidence mie
        join memory_items mi on mi.id = mie.memory_item_id
        where mie.evidence_span_id = v_evidence_span_id
          and mie.memory_item_id = any(v_memory_item_ids)
          and mi.tenant_id = v_proposal.tenant_id
      ) then raise exception 'artifact draft evidence does not support selected memory: %', v_evidence_span_id; end if;
    end loop;

    if v_cluster_id is not null and v_cluster_version is not null then
      -- Serialize generation for one cluster version and intent. The partial
      -- unique index protects the version row; this lock also prevents an
      -- otherwise orphaned initiative_briefs row during concurrent proposals.
      perform pg_advisory_xact_lock(hashtextextended(
        v_proposal.tenant_id || ':' || v_cluster_id || ':' || v_cluster_version || ':' || v_generation_intent,
        0
      ));
      select sbv.initiative_brief_id into v_existing_brief_id
      from suggested_brief_versions sbv
      where sbv.tenant_id = v_proposal.tenant_id
        and sbv.cluster_id = v_cluster_id
        and sbv.cluster_version = v_cluster_version
        and sbv.generation_intent = v_generation_intent
        and sbv.origin = 'generated'
      limit 1;
      if v_existing_brief_id is not null then
        v_brief_id := v_existing_brief_id;
      end if;
      v_ledger_idempotency_key := 'suggested-brief:' || v_cluster_id || ':' || v_cluster_version || ':' || v_generation_intent;
      v_ledger_subject_id := v_brief_id;
    end if;

    if v_existing_brief_id is null then
      insert into initiative_briefs(
        id, tenant_id, title, problem, proposal, success_metric,
        risks_and_dependencies, status, created_by_label
      ) values (
        v_brief_id, v_proposal.tenant_id, v_proposal.payload->>'title',
        v_proposal.payload->>'problem', v_proposal.payload->>'proposal',
        v_proposal.payload->>'successMetric', nullif(v_proposal.payload->>'risksAndDependencies', ''),
        'draft', 'synthesize_brief'
      ) on conflict (id) do nothing;

      foreach v_memory_item_id in array v_memory_item_ids loop
        insert into initiative_brief_memory(brief_id, memory_item_id, tenant_id)
        values (v_brief_id, v_memory_item_id, v_proposal.tenant_id)
        on conflict (brief_id, memory_item_id) do nothing;
      end loop;
      foreach v_evidence_span_id in array v_evidence_span_ids loop
        insert into initiative_brief_evidence(brief_id, evidence_span_id, tenant_id)
        values (v_brief_id, v_evidence_span_id, v_proposal.tenant_id)
        on conflict (brief_id, evidence_span_id) do nothing;
      end loop;
    end if;

    if v_cluster_id is not null and v_cluster_version is not null and v_existing_brief_id is null then
      v_suggested_brief_id := 'sbrief_' || encode(digest(v_proposal.tenant_id || ':' || v_cluster_id || ':' || v_generation_intent, 'sha256'), 'hex');
      insert into suggested_briefs(id, tenant_id, cluster_id, generation_intent)
      values (v_suggested_brief_id, v_proposal.tenant_id, v_cluster_id, v_generation_intent)
      on conflict (tenant_id, cluster_id, generation_intent) do update set updated_at = now()
      returning id, current_version into v_suggested_brief_id, v_suggested_version;
      select coalesce(max(sbv.version), 0) + 1 into v_suggested_version
      from suggested_brief_versions sbv where sbv.suggested_brief_id = v_suggested_brief_id;
      insert into suggested_brief_versions(
        suggested_brief_id, version, tenant_id, cluster_id, cluster_version,
        generation_intent, initiative_brief_id, structured_draft, memory_item_ids,
        evidence_span_ids, contradictions, uncertainties, model_metadata
      ) values (
        v_suggested_brief_id, v_suggested_version, v_proposal.tenant_id,
        v_cluster_id, v_cluster_version, v_generation_intent, v_brief_id,
        v_proposal.payload, to_jsonb(v_memory_item_ids), to_jsonb(v_evidence_span_ids),
        coalesce(v_proposal.payload#>'{clusterDossier,contradictions}', '[]'::jsonb),
        coalesce(v_proposal.payload->'contradictionsOrUncertainties', '[]'::jsonb),
        coalesce(v_proposal.payload->'modelMetadata', '{}'::jsonb)
      ) on conflict (tenant_id, cluster_id, cluster_version, generation_intent) where origin = 'generated' do nothing;
      update suggested_briefs set current_version = greatest(current_version, v_suggested_version), updated_at = now()
      where id = v_suggested_brief_id;
      update synthesis_readiness_evaluations set state = 'draft_generated', updated_at = now()
      where tenant_id = v_proposal.tenant_id and cluster_id = v_cluster_id
        and cluster_version = v_cluster_version and generation_intent = v_generation_intent;
    end if;
  end if;

  insert into ledger_events(
    id, tenant_id, event_type, subject_type, subject_id, actor_type, actor_label,
    caused_by_work_item_id, input_version, idempotency_key, payload
  ) values (
    'levt_' || gen_random_uuid()::text, v_proposal.tenant_id, v_proposal.target_event_type,
    v_proposal.subject_type, v_ledger_subject_id, 'policy',
    coalesce(v_proposal.policy_run_id, v_proposal.work_item_id), v_proposal.work_item_id,
    coalesce(v_proposal.policy_run_id, v_proposal.id), v_ledger_idempotency_key, v_proposal.payload
  ) on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_ledger_row;
  insert into event_outbox(id, tenant_id, ledger_event_id)
  values ('eout_' || gen_random_uuid()::text, v_ledger_row.tenant_id, v_ledger_row.id)
  on conflict (ledger_event_id) do nothing;
  update proposed_events set committed_ledger_event_id = v_ledger_row.id, updated_at = now()
  where proposed_events.id = v_proposal.id;
  return distillery_ledger_event_to_json(v_ledger_row);
end;
$$;

create or replace function distillery_update_initiative_brief(
  p_tenant_id text,
  p_brief_id text,
  p_title text,
  p_problem text,
  p_proposal text,
  p_success_metric text,
  p_risks_and_dependencies text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_suggested suggested_briefs%rowtype;
  v_prior suggested_brief_versions%rowtype;
  v_next_version integer;
begin
  update initiative_briefs ib
  set title = p_title,
      problem = p_problem,
      proposal = p_proposal,
      success_metric = p_success_metric,
      risks_and_dependencies = nullif(p_risks_and_dependencies, ''),
      updated_at = now()
  where ib.id = p_brief_id and ib.tenant_id = p_tenant_id and ib.status = 'draft';
  if not found then raise exception 'editable draft brief not found: %', p_brief_id; end if;

  select sb.* into v_suggested
  from suggested_briefs sb
  join suggested_brief_versions sbv on sbv.suggested_brief_id = sb.id
  where sb.tenant_id = p_tenant_id and sbv.initiative_brief_id = p_brief_id
  order by sbv.version desc limit 1;
  if v_suggested.id is not null then
    select sbv.* into v_prior from suggested_brief_versions sbv
    where sbv.suggested_brief_id = v_suggested.id
    order by sbv.version desc limit 1;
    v_next_version := v_prior.version + 1;
    insert into suggested_brief_versions(
      suggested_brief_id, version, tenant_id, cluster_id, cluster_version,
      generation_intent, initiative_brief_id, structured_draft, memory_item_ids,
      evidence_span_ids, contradictions, uncertainties, model_metadata, origin
    ) values (
      v_suggested.id, v_next_version, p_tenant_id, v_prior.cluster_id,
      v_prior.cluster_version, v_prior.generation_intent, p_brief_id,
      v_prior.structured_draft || jsonb_build_object(
        'title', p_title, 'problem', p_problem, 'proposal', p_proposal,
        'successMetric', p_success_metric,
        'risksAndDependencies', coalesce(p_risks_and_dependencies, '')
      ),
      v_prior.memory_item_ids, v_prior.evidence_span_ids, v_prior.contradictions,
      v_prior.uncertainties, v_prior.model_metadata, 'human_edit'
    );
    update suggested_briefs set current_version = v_next_version, updated_at = now()
    where id = v_suggested.id;
  end if;
  return distillery_get_initiative_brief(p_brief_id);
end;
$$;

notify pgrst, 'reload schema';
