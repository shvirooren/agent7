-- ============================================================
-- Agent7 — Storage & Knowledge Files Migration
-- הרץ ב-Supabase SQL Editor לאחר agent7-rag-migration.sql
-- ============================================================

-- 1. הוסף source_filename לטבלת ה-chunks
alter table role_knowledge_chunks
  add column if not exists source_filename text default null;

-- 2. טבלת רישום קבצים
create table if not exists role_knowledge_files (
  id           uuid primary key default uuid_generate_v4(),
  role_id      uuid not null references job_roles(id) on delete cascade,
  manager_id   uuid not null,
  filename     text not null,
  file_size    bigint not null default 0,
  storage_path text not null,
  chunk_count  int  default 0,
  indexed_at   timestamptz,
  created_at   timestamptz default now(),
  unique (role_id, manager_id, filename)
);

alter table role_knowledge_files enable row level security;

create policy "manager_own_files" on role_knowledge_files
  for all using (manager_id = auth.uid());

-- 3. החלפת ה-RPC — מוסיף similarity_threshold + source_filename
drop function if exists match_knowledge_chunks(vector, uuid, uuid, integer);

create or replace function match_knowledge_chunks(
  query_embedding      vector(1024),
  match_role_id        uuid,
  match_manager_id     uuid,
  match_count          int   default 6,
  similarity_threshold float default 0.25
)
returns table(content text, source_filename text, similarity float)
language sql stable
as $$
  select content, source_filename,
         1 - (embedding <=> query_embedding) as similarity
  from role_knowledge_chunks
  where role_id    = match_role_id
    and manager_id = match_manager_id
    and embedding  is not null
    and (1 - (embedding <=> query_embedding)) > similarity_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- לאחר הרצת ה-migration:
-- צור bucket בשם "role-knowledge" ב-Supabase Storage (פרטי)
-- ============================================================
