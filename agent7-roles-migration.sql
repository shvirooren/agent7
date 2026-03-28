-- ============================================================
-- Agent7 — Role Agents Migration
-- הרץ ב-Supabase SQL Editor
-- מוסיף טבלאות לסוכני AI לפי תפקיד מבלי לשנות טבלאות קיימות
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── טבלאות חדשות ────────────────────────────────────────────

-- תפקידי משרה (user_id = auth.uid של המנהל, עקבי עם שאר הטבלאות ב-agent7)
create table job_roles (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null,   -- ה-auth.uid של המנהל (כמו employees.user_id)
  title       text not null,
  description text default '',
  responsibilities text default '',
  created_at  timestamptz default now()
);

-- סוכני AI — אחד לכל תפקיד (נוצר אוטומטית דרך trigger)
create table role_agents (
  id                  uuid primary key default uuid_generate_v4(),
  role_id             uuid references job_roles(id) on delete cascade unique,
  user_id             uuid not null,   -- ה-auth.uid של המנהל
  total_conversations int default 0,
  last_updated        timestamptz default now(),
  created_at          timestamptz default now()
);

-- זיכרון מצטבר (שייך לתפקיד, לא לעובד)
create table role_agent_memory (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references role_agents(id) on delete cascade,
  category    text default 'insight',  -- workflow | faq | process | contact | insight
  content     text not null,
  importance  int default 1 check (importance between 1 and 5),
  created_at  timestamptz default now()
);

-- שיחות עובדים עם הסוכן
create table role_conversations (
  id           uuid primary key default uuid_generate_v4(),
  employee_id  uuid references employees(id) on delete cascade,
  agent_id     uuid references role_agents(id) on delete cascade,
  started_at   timestamptz default now(),
  ended_at     timestamptz
);

-- הודעות
create table role_messages (
  id               uuid primary key default uuid_generate_v4(),
  conversation_id  uuid references role_conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  created_at       timestamptz default now()
);

-- ─── עמודה חדשה בטבלת employees הקיימת ──────────────────────

alter table employees add column if not exists role_id uuid references job_roles(id) on delete set null;

-- ─── Trigger: יצירת סוכן אוטומטית כשמוסיפים תפקיד ───────────

create or replace function create_agent_for_role()
returns trigger as $$
begin
  insert into role_agents (role_id, user_id) values (new.id, new.user_id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_role_created
  after insert on job_roles
  for each row execute function create_agent_for_role();

-- ─── RLS ─────────────────────────────────────────────────────

alter table job_roles          enable row level security;
alter table role_agents        enable row level security;
alter table role_agent_memory  enable row level security;
alter table role_conversations enable row level security;
alter table role_messages      enable row level security;

-- מנהל: גישה מלאה לנתונים שלו
create policy "manager_own_roles"     on job_roles         for all using (user_id = auth.uid());
create policy "manager_own_agents"    on role_agents       for all using (user_id = auth.uid());
create policy "manager_own_memory"    on role_agent_memory for all using (
  agent_id in (select id from role_agents where user_id = auth.uid())
);
create policy "manager_read_convs"    on role_conversations for select using (
  agent_id in (select id from role_agents where user_id = auth.uid())
);
create policy "manager_read_messages" on role_messages for select using (
  conversation_id in (
    select rc.id from role_conversations rc
    join role_agents ra on ra.id = rc.agent_id
    where ra.user_id = auth.uid()
  )
);

-- עובד: קריאה של התפקיד והסוכן שלו
create policy "employee_read_role" on job_roles for select using (
  id in (
    select e.role_id from employees e
    join employee_users eu on eu.employee_id = e.id
    where eu.auth_user_id = auth.uid() and e.role_id is not null
  )
);
create policy "employee_read_agent" on role_agents for select using (
  role_id in (
    select e.role_id from employees e
    join employee_users eu on eu.employee_id = e.id
    where eu.auth_user_id = auth.uid() and e.role_id is not null
  )
);
create policy "employee_read_memory" on role_agent_memory for select using (
  agent_id in (
    select ra.id from role_agents ra
    join employees e on e.role_id = ra.role_id
    join employee_users eu on eu.employee_id = e.id
    where eu.auth_user_id = auth.uid()
  )
);
create policy "employee_own_conversations" on role_conversations for all using (
  employee_id in (
    select employee_id from employee_users where auth_user_id = auth.uid()
  )
);
create policy "employee_own_messages" on role_messages for all using (
  conversation_id in (
    select rc.id from role_conversations rc
    join employee_users eu on eu.employee_id = rc.employee_id
    where eu.auth_user_id = auth.uid()
  )
);
