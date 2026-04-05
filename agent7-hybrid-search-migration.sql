-- ============================================================
-- Agent7 — Hybrid Search Migration (Vector + Full-Text)
-- הרץ ב-Supabase SQL Editor
-- ============================================================

-- 1. הוסף עמודת tsvector לחיפוש מילולי (simple = עובד עם עברית ואנגלית)
alter table role_knowledge_chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('simple', content)) stored;

-- 2. אינדקס GIN לחיפוש מהיר
create index if not exists idx_rkc_tsv
  on role_knowledge_chunks using gin(content_tsv);

-- 3. פונקציית חיפוש היברידי — RRF (Reciprocal Rank Fusion)
--    משלבת דירוג וקטורי + דירוג מילולי
create or replace function match_knowledge_chunks_hybrid(
  query_embedding      vector(1024),
  query_text           text,
  match_role_id        uuid,
  match_manager_id     uuid,
  match_count          int   default 12,
  similarity_threshold float default 0.15
)
returns table(content text, source_filename text, similarity float)
language plpgsql stable
as $$
declare
  ts_query tsquery;
begin
  begin
    ts_query := plainto_tsquery('simple', query_text);
  exception when others then
    ts_query := null;
  end;

  return query
  with vector_results as (
    select
      rkc.id,
      rkc.content,
      rkc.source_filename,
      row_number() over (order by rkc.embedding <=> query_embedding) as vec_rank
    from role_knowledge_chunks rkc
    where rkc.role_id    = match_role_id
      and rkc.manager_id = match_manager_id
      and rkc.embedding  is not null
      and (1 - (rkc.embedding <=> query_embedding)) > similarity_threshold
    order by rkc.embedding <=> query_embedding
    limit match_count * 3
  ),
  text_results as (
    select
      rkc.id,
      rkc.content,
      rkc.source_filename,
      row_number() over (order by ts_rank(rkc.content_tsv, ts_query) desc) as text_rank
    from role_knowledge_chunks rkc
    where rkc.role_id    = match_role_id
      and rkc.manager_id = match_manager_id
      and ts_query       is not null
      and rkc.content_tsv @@ ts_query
    limit match_count * 3
  ),
  combined as (
    select
      coalesce(v.id, t.id)                       as id,
      coalesce(v.content, t.content)             as content,
      coalesce(v.source_filename, t.source_filename) as source_filename,
      coalesce(1.0 / (60 + v.vec_rank),  0.0)
      + coalesce(1.0 / (60 + t.text_rank), 0.0) as rrf_score
    from vector_results v
    full outer join text_results t on v.id = t.id
  )
  select content, source_filename, rrf_score
  from combined
  order by rrf_score desc
  limit match_count;
end;
$$;
