-- A appliquer manuellement au projet Supabase concerne. Ne modifie aucune base lors du build.
create extension if not exists pgcrypto;

create table if not exists public.ai_cv_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_text text not null check (char_length(source_text) between 40 and 30000),
  target_role text not null default '' check (char_length(target_role) <= 160),
  offer_text text not null default '' check (char_length(offer_text) <= 20000),
  analysis jsonb not null default '{}'::jsonb,
  improved_text text not null default '' check (char_length(improved_text) <= 40000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_cv_analyses_user_updated_idx
  on public.ai_cv_analyses (user_id, updated_at desc);

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('interview', 'pitch', 'simulation')),
  title text not null check (char_length(title) between 1 and 120),
  context_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_updated_idx
  on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  phase text not null default 'coaching' check (phase in ('coaching', 'simulation', 'debrief')),
  content text not null check (char_length(content) between 1 and 12000),
  created_at timestamptz not null default now()
);

create index if not exists ai_messages_conversation_created_idx
  on public.ai_conversation_messages (conversation_id, created_at);
create index if not exists ai_messages_user_idx
  on public.ai_conversation_messages (user_id);

alter table public.ai_cv_analyses enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_conversation_messages enable row level security;

drop policy if exists "Users manage own CV analyses" on public.ai_cv_analyses;
create policy "Users manage own CV analyses" on public.ai_cv_analyses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own AI conversations" on public.ai_conversations;
create policy "Users manage own AI conversations" on public.ai_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own AI messages" on public.ai_conversation_messages;
create policy "Users manage own AI messages" on public.ai_conversation_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
