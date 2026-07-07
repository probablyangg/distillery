-- Backfill conservative semantic metadata for memory rows created before the
-- MemGraphRAG-aligned schema layer. This metadata is interpretation support for
-- trace/debug views; evidence spans remain authoritative.

insert into memory_entities(id, memory_item_id, tenant_id, name, entity_type, canonical_name)
select
  'ment_backfill_' || mi.id,
  mi.id,
  mi.tenant_id,
  case
    when mi.statement ilike '%stablechain%' then 'StableChain'
    when mi.statement ilike '%stable pay%' then 'Stable Pay'
    when mi.statement ilike '%stable%' then 'Stable'
    else mi.claim_type
  end,
  case
    when mi.statement ilike '%stablechain%' then 'network'
    when mi.statement ilike '%stable pay%' then 'product'
    when mi.statement ilike '%stable%' then 'company'
    else 'concept'
  end,
  case
    when mi.statement ilike '%stablechain%' then 'StableChain'
    when mi.statement ilike '%stable pay%' then 'Stable Pay'
    when mi.statement ilike '%stable%' then 'Stable'
    else mi.claim_type
  end
from memory_items mi
where not exists (
  select 1 from memory_entities me
  where me.memory_item_id = mi.id
);

insert into memory_relations(id, memory_item_id, tenant_id, subject, predicate, object, evidence_span_ids)
select
  'mrel_backfill_' || mi.id,
  mi.id,
  mi.tenant_id,
  coalesce((
    select me.name
    from memory_entities me
    where me.memory_item_id = mi.id
    order by me.created_at, me.id
    limit 1
  ), mi.claim_type),
  case mi.claim_type
    when 'fact' then 'states'
    when 'user_signal' then 'signals'
    when 'reported_decision' then 'reports_decision'
    when 'metric' then 'measures'
    when 'risk' then 'risks'
    when 'dependency' then 'depends_on'
    when 'constraint' then 'constrains'
    when 'strategic_statement' then 'prioritizes'
    when 'ownership_statement' then 'owns'
    when 'scope_statement' then 'scopes'
    else 'relates_to'
  end,
  left(mi.statement, 300),
  coalesce((
    select jsonb_agg(mie.evidence_span_id order by mie.evidence_span_id)
    from memory_item_evidence mie
    where mie.memory_item_id = mi.id
  ), '[]'::jsonb)
from memory_items mi
where not exists (
  select 1 from memory_relations mr
  where mr.memory_item_id = mi.id
);

insert into memory_schemas(id, memory_item_id, tenant_id, subject_type, predicate, object_type, status)
select
  'msch_backfill_' || mi.id,
  mi.id,
  mi.tenant_id,
  coalesce((
    select me.entity_type
    from memory_entities me
    where me.memory_item_id = mi.id
    order by me.created_at, me.id
    limit 1
  ), 'concept'),
  case mi.claim_type
    when 'fact' then 'states'
    when 'user_signal' then 'signals'
    when 'reported_decision' then 'reports_decision'
    when 'metric' then 'measures'
    when 'risk' then 'risks'
    when 'dependency' then 'depends_on'
    when 'constraint' then 'constrains'
    when 'strategic_statement' then 'prioritizes'
    when 'ownership_statement' then 'owns'
    when 'scope_statement' then 'scopes'
    else 'relates_to'
  end,
  'evidence_backed_claim',
  'candidate'
from memory_items mi
where not exists (
  select 1 from memory_schemas ms
  where ms.memory_item_id = mi.id
);

notify pgrst, 'reload schema';
