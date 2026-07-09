-- Graph-grounded hybrid retrieval RPCs.
-- These functions return retrieval inputs and hydrated context only. They do not
-- generate final answers and must not be used as a lexical answer fallback.

create or replace function distillery_retrieval_vector_candidates(
  p_tenant_id text,
  p_query_embedding jsonb,
  p_target_types text[] default array['claim', 'evidence_span', 'entity', 'schema_pattern'],
  p_limit integer default 64,
  p_embedding_model text default null
)
returns jsonb
language sql
stable
security definer
as $$
  with query_vector as (
    select (
      select array_agg(value::real order by ord)::vector
      from jsonb_array_elements_text(p_query_embedding) with ordinality as embedding_values(value, ord)
    ) as embedding
  ),
  candidates as (
    select
      'vector'::text as source,
      me.target_type,
      me.target_id,
      case
        when me.target_type = 'claim' then 'claim:' || me.target_id
        when me.target_type = 'evidence_span' then 'evidence:' || me.target_id
        when me.target_type = 'entity' then coalesce(gn.id, 'entity:' || me.target_id)
        when me.target_type = 'schema_pattern' then coalesce(gn.id, 'schema:' || lower(regexp_replace(me.target_id, '[^a-zA-Z0-9]+', '_', 'g')))
        else me.target_type || ':' || me.target_id
      end as node_id,
      case when me.target_type = 'claim' then me.target_id else null end as claim_id,
      greatest(0, 1 - (me.embedding <=> query_vector.embedding))::double precision as score,
      coalesce(gn.label, me.target_id) as label
    from memory_embeddings me
    cross join query_vector
    left join graph_nodes gn
      on gn.tenant_id = me.tenant_id
     and (
       (me.target_type = 'claim' and gn.id = 'claim:' || me.target_id)
       or (me.target_type = 'evidence_span' and gn.id = 'evidence:' || me.target_id)
       or (me.target_type = 'entity' and gn.node_type = 'entity' and (gn.ref_id = me.target_id or gn.id = 'entity:' || me.target_id))
       or (me.target_type = 'schema_pattern' and gn.node_type = 'schema' and (gn.ref_id = me.target_id or gn.id = 'schema:' || lower(regexp_replace(me.target_id, '[^a-zA-Z0-9]+', '_', 'g'))))
     )
    where me.tenant_id = p_tenant_id
      and me.target_type = any(coalesce(p_target_types, array['claim', 'evidence_span', 'entity', 'schema_pattern']))
      and (p_embedding_model is null or me.embedding_model = p_embedding_model)
    order by me.embedding <=> query_vector.embedding, me.target_type, me.target_id
    limit least(greatest(coalesce(p_limit, 64), 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', source,
    'targetType', target_type,
    'targetId', target_id,
    'nodeId', node_id,
    'claimId', claim_id,
    'score', score,
    'label', label
  ) order by score desc, target_type, target_id), '[]'::jsonb)
  from candidates;
$$;

create or replace function distillery_retrieval_sparse_candidates(
  p_tenant_id text,
  p_query text,
  p_limit integer default 32
)
returns jsonb
language sql
stable
security definer
as $$
  with tokens as (
    select distinct token
    from unnest(regexp_split_to_array(lower(coalesce(p_query, '')), '[^a-z0-9]+')) as token
    where length(token) >= 3
      and token not in (
        'what', 'when', 'where', 'which', 'who', 'why', 'how',
        'the', 'and', 'for', 'with', 'from', 'about', 'know',
        'does', 'did', 'has', 'have', 'had', 'are', 'was', 'were',
        'this', 'that', 'these', 'those', 'into', 'onto'
      )
  ),
  active_memory as (
    select mi.*
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1
        from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
  ),
  claim_matches as (
    select
      mi.id as claim_id,
      count(distinct tokens.token)::double precision
        + count(distinct tokens.token) filter (where lower(mi.statement) like '%' || tokens.token || '%')::double precision
        + count(distinct tokens.token) filter (where lower(coalesce(es.text, '')) like '%' || tokens.token || '%')::double precision
        as score,
      left(mi.statement, 120) as label
    from active_memory mi
    cross join tokens
    left join memory_item_evidence mie on mie.memory_item_id = mi.id
    left join evidence_spans es on es.id = mie.evidence_span_id
    where lower(mi.statement) like '%' || tokens.token || '%'
       or lower(coalesce(es.text, '')) like '%' || tokens.token || '%'
    group by mi.id, mi.statement
  ),
  entity_matches as (
    select
      mi.id as claim_id,
      2::double precision as score,
      coalesce(me.canonical_name, me.name) as label
    from active_memory mi
    join memory_entities me on me.memory_item_id = mi.id and me.tenant_id = mi.tenant_id
    where lower(coalesce(me.canonical_name, me.name)) in (select token from tokens)
       or lower(coalesce(me.canonical_name, me.name)) like '%' || lower(coalesce(p_query, '')) || '%'
       or lower(coalesce(p_query, '')) like '%' || lower(coalesce(me.canonical_name, me.name)) || '%'
  ),
  schema_matches as (
    select
      mi.id as claim_id,
      1.5::double precision as score,
      ms.subject_type || ' ' || ms.predicate || ' ' || ms.object_type as label
    from active_memory mi
    join memory_schemas ms on ms.memory_item_id = mi.id and ms.tenant_id = mi.tenant_id
    where lower(ms.predicate) in (select token from tokens)
       or lower(coalesce(p_query, '')) like '%' || lower(ms.predicate) || '%'
  ),
  ranked as (
    select claim_id, max(score) as score, max(label) as label
    from (
      select * from claim_matches
      union all
      select * from entity_matches
      union all
      select * from schema_matches
    ) combined
    group by claim_id
    order by max(score) desc, claim_id
    limit least(greatest(coalesce(p_limit, 32), 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', 'sparse',
    'targetType', 'claim',
    'targetId', claim_id,
    'nodeId', 'claim:' || claim_id,
    'claimId', claim_id,
    'score', score,
    'label', label
  ) order by score desc, claim_id), '[]'::jsonb)
  from ranked;
$$;

create or replace function distillery_retrieval_graph_snapshot(
  p_tenant_id text,
  p_seed_node_ids text[],
  p_max_nodes integer default 1000,
  p_max_edges integer default 4000
)
returns jsonb
language sql
stable
security definer
as $$
  with seed_nodes as (
    select unnest(coalesce(p_seed_node_ids, array[]::text[])) as id
  ),
  first_hop as (
    select ge.from_node_id as id
    from graph_edges ge
    join seed_nodes sn on sn.id = ge.to_node_id
    where ge.tenant_id = p_tenant_id
    union
    select ge.to_node_id as id
    from graph_edges ge
    join seed_nodes sn on sn.id = ge.from_node_id
    where ge.tenant_id = p_tenant_id
  ),
  second_hop as (
    select ge.from_node_id as id
    from graph_edges ge
    join first_hop fh on fh.id = ge.to_node_id
    where ge.tenant_id = p_tenant_id
    union
    select ge.to_node_id as id
    from graph_edges ge
    join first_hop fh on fh.id = ge.from_node_id
    where ge.tenant_id = p_tenant_id
  ),
  selected_node_ids as (
    select id from seed_nodes
    union
    select id from first_hop
    union
    select id from second_hop
    limit least(greatest(coalesce(p_max_nodes, 1000), 1), 5000)
  ),
  selected_nodes as (
    select gn.*
    from graph_nodes gn
    join selected_node_ids sni on sni.id = gn.id
    where gn.tenant_id = p_tenant_id
  ),
  selected_edges as (
    select ge.*
    from graph_edges ge
    where ge.tenant_id = p_tenant_id
      and ge.from_node_id in (select id from selected_nodes)
      and ge.to_node_id in (select id from selected_nodes)
    order by ge.weight desc, ge.id
    limit least(greatest(coalesce(p_max_edges, 4000), 1), 20000)
  )
  select jsonb_build_object(
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'tenantId', tenant_id,
        'nodeType', node_type,
        'refId', ref_id,
        'label', label,
        'properties', properties
      ) order by id)
      from selected_nodes
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'tenantId', tenant_id,
        'fromNodeId', from_node_id,
        'toNodeId', to_node_id,
        'edgeType', edge_type,
        'weight', weight::double precision,
        'properties', properties
      ) order by id)
      from selected_edges
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_hydrate_retrieval_claims(
  p_tenant_id text,
  p_ranked_claims jsonb
)
returns jsonb
language sql
stable
security definer
as $$
  with ranked_claims as (
    select *
    from jsonb_to_recordset(coalesce(p_ranked_claims, '[]'::jsonb)) as ranked(
      "claimId" text,
      rank integer,
      "graphScore" double precision,
      "vectorScore" double precision,
      "lexicalScore" double precision
    )
  ),
  active_ranked as (
    select rc.*
    from ranked_claims rc
    join memory_items mi on mi.id = rc."claimId" and mi.tenant_id = p_tenant_id
    where not exists (
      select 1
      from memory_item_events mievt
      where mievt.memory_item_id = mi.id
        and mievt.event_type in ('remove', 'edit')
    )
  )
  select jsonb_build_object(
    'claims', coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                distillery_graph_claim_json(ar."claimId"),
                '{rank}',
                to_jsonb(ar.rank)
              ),
              '{graphScore}',
              to_jsonb(ar."graphScore")
            ),
            '{vectorScore}',
            to_jsonb(ar."vectorScore")
          ),
          '{lexicalScore}',
          to_jsonb(ar."lexicalScore")
        )
        order by ar.rank, ar."claimId"
      )
      from active_ranked ar
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(distillery_conflict_group_json(cg) order by cg.severity, cg.created_at desc)
      from conflict_groups cg
      where cg.tenant_id = p_tenant_id
        and cg.status = 'open'
        and exists (
          select 1
          from conflict_members cm
          join active_ranked ar on ar."claimId" = cm.claim_id
          where cm.conflict_group_id = cg.id
        )
    ), '[]'::jsonb)
  );
$$;

create or replace function distillery_list_missing_memory_embedding_targets(
  p_tenant_id text,
  p_embedding_model text,
  p_limit integer default 128
)
returns jsonb
language sql
stable
security definer
as $$
  with targets as (
    select
      'claim'::text as target_type,
      mi.id as target_id,
      mi.statement as content
    from memory_items mi
    where mi.tenant_id = p_tenant_id
      and not exists (
        select 1
        from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
    union all
    select
      'evidence_span'::text,
      es.id,
      es.text
    from evidence_spans es
    join source_versions sv on sv.id = es.source_version_id
    join source_items si on si.id = sv.source_item_id
    where si.tenant_id = p_tenant_id
    union all
    select distinct
      'entity'::text,
      gn.ref_id,
      gn.label
    from graph_nodes gn
    where gn.tenant_id = p_tenant_id
      and gn.node_type = 'entity'
    union all
    select
      'schema_pattern'::text,
      sp.subject_type || ':' || sp.predicate_name || ':' || sp.object_type,
      sp.subject_type || ' ' || sp.predicate_name || ' ' || sp.object_type
    from schema_patterns sp
    where sp.tenant_id = p_tenant_id
  ),
  missing as (
    select targets.*
    from targets
    where trim(coalesce(targets.content, '')) <> ''
      and not exists (
        select 1
        from memory_embeddings me
        where me.tenant_id = p_tenant_id
          and me.target_type = targets.target_type
          and me.target_id = targets.target_id
          and me.embedding_model = p_embedding_model
      )
    order by target_type, target_id
    limit least(greatest(coalesce(p_limit, 128), 1), 512)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'targetType', target_type,
    'targetId', target_id,
    'content', content
  ) order by target_type, target_id), '[]'::jsonb)
  from missing;
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
  schema_row memory_schemas%rowtype;
  connection_row claim_connections%rowtype;
  entity_node_id text;
  schema_ref text;
  schema_node_id text;
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
    entity_node_id := 'entity:' || lower(regexp_replace(coalesce(entity_row.canonical_name, entity_row.name), '[^a-zA-Z0-9]+', '_', 'g'));
    insert into graph_nodes(id, tenant_id, node_type, ref_id, label, properties)
    values (
      entity_node_id,
      p_tenant_id,
      'entity',
      coalesce(entity_row.canonical_name, entity_row.name),
      coalesce(entity_row.canonical_name, entity_row.name),
      jsonb_build_object('entityType', entity_row.entity_type)
    )
    on conflict (id) do update set label = excluded.label, ref_id = excluded.ref_id, updated_at = now();

    insert into graph_edges(id, tenant_id, from_node_id, to_node_id, edge_type, weight)
    values (
      'edge:' || entity_row.memory_item_id || ':entity:' || entity_row.id,
      p_tenant_id,
      'claim:' || entity_row.memory_item_id,
      entity_node_id,
      'mentions',
      0.8
    )
    on conflict (tenant_id, from_node_id, to_node_id, edge_type) do nothing;
  end loop;

  for schema_row in select * from memory_schemas where tenant_id = p_tenant_id
  loop
    schema_ref := schema_row.subject_type || ':' || schema_row.predicate || ':' || schema_row.object_type;
    schema_node_id := 'schema:' || lower(regexp_replace(schema_ref, '[^a-zA-Z0-9]+', '_', 'g'));
    insert into graph_nodes(id, tenant_id, node_type, ref_id, label, properties)
    values (
      schema_node_id,
      p_tenant_id,
      'schema',
      schema_ref,
      schema_row.subject_type || ' ' || schema_row.predicate || ' ' || schema_row.object_type,
      jsonb_build_object('status', schema_row.status)
    )
    on conflict (id) do update set label = excluded.label, ref_id = excluded.ref_id, properties = excluded.properties, updated_at = now();

    insert into graph_edges(id, tenant_id, from_node_id, to_node_id, edge_type, weight)
    values (
      'edge:' || schema_row.memory_item_id || ':schema:' || schema_row.id,
      p_tenant_id,
      'claim:' || schema_row.memory_item_id,
      schema_node_id,
      'matches_schema',
      0.65
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

notify pgrst, 'reload schema';
