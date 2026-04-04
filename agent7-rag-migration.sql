-- ============================================================
-- Agent7 — RAG Knowledge Chunks Migration
-- הרץ ב-Supabase SQL Editor
-- ============================================================

create extension if not exists vector;

-- ─── טבלת קטעי ידע עם embeddings ─────────────────────────────

create table role_knowledge_chunks (
  id          uuid primary key default uuid_generate_v4(),
  role_id     uuid references job_roles(id) on delete cascade,
  manager_id  uuid not null,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(1024),
  created_at  timestamptz default now()
);

create index on role_knowledge_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- ─── RLS ─────────────────────────────────────────────────────

alter table role_knowledge_chunks enable row level security;

create policy "manager_own_chunks" on role_knowledge_chunks
  for all using (manager_id = auth.uid());

create policy "employee_read_chunks" on role_knowledge_chunks
  for select using (
    role_id in (
      select e.role_id from employees e
      join employee_users eu on eu.employee_id = e.id
      where eu.auth_user_id = auth.uid() and e.role_id is not null
    )
  );

-- ─── RPC: חיפוש סמנטי (נקרא מה-worker עם service key) ────────

create or replace function match_knowledge_chunks(
  query_embedding vector(1024),
  match_role_id   uuid,
  match_manager_id uuid,
  match_count     int default 5
)
returns table(content text, similarity float)
language sql stable
as $$
  select content,
         1 - (embedding <=> query_embedding) as similarity
  from role_knowledge_chunks
  where role_id = match_role_id
    and manager_id = match_manager_id
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
