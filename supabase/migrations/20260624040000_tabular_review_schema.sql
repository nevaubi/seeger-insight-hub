-- Tabular Review (document-grid) feature, Phase A schema.
-- Rows = uploaded files, columns = typed fields, cells = cited extractions.
-- Additive; isolated from the curated MDL corpus. RLS enabled with permissive anon policies
-- to match the app's current keyless client model (tracked separately for hardening).

create table if not exists public.review_sets (
  id uuid primary key default gen_random_uuid(),
  case_id uuid,
  name text not null default 'Untitled review',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.review_files (
  id uuid primary key default gen_random_uuid(),
  review_set_id uuid not null references public.review_sets(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  mime_type text,
  byte_size bigint,
  page_count integer,
  char_count integer,
  status text not null default 'uploaded',   -- uploaded | transcribing | ready | error
  error text,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists review_files_set_idx on public.review_files(review_set_id);

create table if not exists public.review_file_pages (
  id uuid primary key default gen_random_uuid(),
  review_file_id uuid not null references public.review_files(id) on delete cascade,
  page_number integer not null,
  text text,
  source text,                                -- 'gemini_vision' | 'native_text' | 'plain'
  created_at timestamptz default now(),
  unique (review_file_id, page_number)
);
create index if not exists review_file_pages_file_idx on public.review_file_pages(review_file_id);

create table if not exists public.review_columns (
  id uuid primary key default gen_random_uuid(),
  review_set_id uuid not null references public.review_sets(id) on delete cascade,
  ordinal integer not null default 0,
  name text not null,
  prompt text,
  data_type text not null default 'text',     -- text|number|date|boolean|enum|list|currency
  enum_options jsonb,
  created_at timestamptz default now()
);
create index if not exists review_columns_set_idx on public.review_columns(review_set_id);

create table if not exists public.review_cells (
  id uuid primary key default gen_random_uuid(),
  review_set_id uuid not null references public.review_sets(id) on delete cascade,
  review_file_id uuid not null references public.review_files(id) on delete cascade,
  review_column_id uuid not null references public.review_columns(id) on delete cascade,
  value_text text,
  value_json jsonb,
  state text not null default 'pending',      -- pending|running|done|not_found|needs_review|error
  confidence real,
  model text,
  error text,
  run_at timestamptz,
  unique (review_column_id, review_file_id)
);
create index if not exists review_cells_set_idx on public.review_cells(review_set_id);

create table if not exists public.review_cell_citations (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid not null references public.review_cells(id) on delete cascade,
  page_number integer,
  quote text,
  verified boolean default false,
  created_at timestamptz default now()
);
create index if not exists review_cell_citations_cell_idx on public.review_cell_citations(cell_id);

-- RLS: enabled with permissive policies for anon+authenticated (keyless client model).
do $$
declare t text;
begin
  foreach t in array array[
    'review_sets','review_files','review_file_pages','review_columns','review_cells','review_cell_citations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy %I on public.%I for all to anon, authenticated using (true) with check (true)$p$,
                   t || '_all', t);
  end loop;
end$$;

-- Private storage bucket for uploaded review files.
insert into storage.buckets (id, name, public)
values ('review-files', 'review-files', false)
on conflict (id) do nothing;

-- Storage policies scoped to the review-files bucket (keyless client uploads/reads/deletes).
create policy "review_files_read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'review-files');
create policy "review_files_insert" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'review-files');
create policy "review_files_update" on storage.objects for update to anon, authenticated
  using (bucket_id = 'review-files') with check (bucket_id = 'review-files');
create policy "review_files_delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'review-files');
