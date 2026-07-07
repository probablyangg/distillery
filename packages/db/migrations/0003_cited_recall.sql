-- Distillery v0 cited recall support.
-- This migration starts with deterministic lexical retrieval. Embeddings/hybrid
-- retrieval can be added without changing the authoritative memory ledger.

create index if not exists memory_items_statement_fts_idx
  on memory_items
  using gin (to_tsvector('english', statement));

create index if not exists evidence_spans_text_fts_idx
  on evidence_spans
  using gin (to_tsvector('english', text));

create table if not exists claim_embeddings (
  memory_item_id text primary key references memory_items(id) on delete cascade,
  tenant_id text not null references tenants(id),
  embedding_model text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create table if not exists evidence_span_embeddings (
  evidence_span_id text primary key references evidence_spans(id) on delete cascade,
  tenant_id text not null references tenants(id),
  embedding_model text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create or replace function distillery_recall_memory_lexical(
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
  if trim(coalesce(p_query, '')) = '' then
    return '[]'::jsonb;
  end if;

  with tokens as (
    select distinct token
    from unnest(regexp_split_to_array(lower(p_query), '[^a-z0-9]+')) as token
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
        select 1 from memory_item_events mievt
        where mievt.memory_item_id = mi.id
          and mievt.event_type in ('remove', 'edit')
      )
  ),
  ranked as (
    select
      mi.id,
      count(distinct tokens.token)::double precision
        + count(distinct tokens.token) filter (where lower(mi.statement) like '%' || tokens.token || '%')::double precision
        + count(distinct tokens.token) filter (where lower(coalesce(es.text, '')) like '%' || tokens.token || '%')::double precision
        as rank
    from active_memory mi
    cross join tokens
    left join memory_item_evidence mie on mie.memory_item_id = mi.id
    left join evidence_spans es on es.id = mie.evidence_span_id
    where lower(mi.statement) like '%' || tokens.token || '%'
       or lower(coalesce(es.text, '')) like '%' || tokens.token || '%'
    group by mi.id, mi.statement
    order by rank desc, mi.id
    limit least(greatest(p_limit, 1), 20)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', ranked.rank,
    'memoryItem', jsonb_build_object(
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
      'reviewState', case
        when exists (
          select 1 from memory_item_events mievt
          where mievt.memory_item_id = mi.id
            and mievt.event_type = 'confirm'
        ) then 'confirmed'
        else 'unreviewed'
      end,
      'supersedesMemoryItemId', mi.supersedes_memory_item_id
    ),
    'evidenceSpans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', es.id,
        'sourceVersionId', es.source_version_id,
        'startLine', es.start_line,
        'endLine', es.end_line,
        'startChar', es.start_char,
        'endChar', es.end_char,
        'text', es.text
      ) order by es.start_line, es.start_char)
      from memory_item_evidence mie
      join evidence_spans es on es.id = mie.evidence_span_id
      where mie.memory_item_id = mi.id
    ), '[]'::jsonb)
  ) order by ranked.rank desc, ranked.id), '[]'::jsonb)
  into result
  from ranked
  join memory_items mi on mi.id = ranked.id;

  return result;
end;
$$;

notify pgrst, 'reload schema';
