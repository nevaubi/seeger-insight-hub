-- Drafting workspace upgrade: document format flag, version snapshots, suggestion audit trail.
-- Applied to production via MCP on 2026-07-13 (migration name: drafting_word_mode_versions_suggestions).
-- Additive only; mirrors the permissive RLS posture of practice_profiles/review_sets (demo).

alter table public.workspace_documents
  add column if not exists format text not null default 'md',
  add column if not exists storage_path text;

comment on column public.workspace_documents.format is 'md = markdown memo mode; docx = Word binary in storage (storage_path)';

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.workspace_documents(id) on delete cascade,
  case_id uuid,
  label text,
  content text not null default '',
  author text,
  word_count integer,
  created_at timestamptz not null default now()
);
create index if not exists document_versions_doc_idx
  on public.document_versions(document_id, created_at desc);

alter table public.document_versions enable row level security;
drop policy if exists document_versions_all on public.document_versions;
create policy document_versions_all on public.document_versions
  for all to anon, authenticated using (true) with check (true);

create table if not exists public.document_suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.workspace_documents(id) on delete cascade,
  case_id uuid,
  run_id uuid not null,
  op text not null,
  anchor text,
  occurrence integer,
  start_pos integer,
  end_pos integer,
  new_text text,
  rationale text,
  cite jsonb,
  tier text,
  confidence text,
  status text not null default 'pending',
  fail_reason text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists document_suggestions_doc_idx
  on public.document_suggestions(document_id, created_at desc);
create index if not exists document_suggestions_run_idx
  on public.document_suggestions(run_id);

alter table public.document_suggestions enable row level security;
drop policy if exists document_suggestions_all on public.document_suggestions;
create policy document_suggestions_all on public.document_suggestions
  for all to anon, authenticated using (true) with check (true);
