-- Drafting workspace: user-authored documents (Markdown), scoped to a matter's master case.
-- Mirrors the app's existing access model (anon key, RLS off, explicit grants).
create table if not exists public.workspace_documents (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases(id) on delete cascade,
  title       text not null default 'Untitled document',
  content     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists workspace_documents_case_updated_idx
  on public.workspace_documents (case_id, updated_at desc);

-- keep updated_at fresh on every write (search_path pinned; now() lives in pg_catalog)
create or replace function public.touch_workspace_documents()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_workspace_documents on public.workspace_documents;
create trigger trg_touch_workspace_documents
  before update on public.workspace_documents
  for each row execute function public.touch_workspace_documents();

grant select, insert, update, delete on public.workspace_documents to anon, authenticated;
