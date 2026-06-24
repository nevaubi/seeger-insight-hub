-- Phase 2: live RECAP docket sync from CourtListener into the existing curated tables.
-- Additive only: a sync-state table, an idempotent upsert RPC (ON CONFLICT on the existing
-- cl_* unique indexes), and a read view for the docket UI. No existing data is mutated except
-- by upsert-on-conflict keyed to CourtListener ids.

create table if not exists public.recap_sync_state (
  matter_id uuid primary key references public.matters(id) on delete cascade,
  case_id uuid,
  cl_docket_id bigint,
  last_synced_at timestamptz,
  last_entry_count integer default 0,
  last_new_count integer default 0,
  last_updated_count integer default 0,
  last_error text,
  updated_at timestamptz default now()
);

-- Transactional upsert of a batch of CourtListener docket-entries (and their recap_documents)
-- for one case. Returns counts. Keyed on the existing cl_docket_entry_id / cl_recap_document_id
-- unique indexes so re-syncing is idempotent and never duplicates or deletes curated rows.
create or replace function public.recap_upsert_entries(p_case_id uuid, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e jsonb;
  d jsonb;
  v_entry_id uuid;
  v_existed boolean;
  v_new int := 0;
  v_updated int := 0;
  v_docs int := 0;
begin
  for e in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as value
  loop
    select exists(select 1 from public.docket_entries where cl_docket_entry_id = (e->>'id')::bigint)
      into v_existed;

    insert into public.docket_entries as de (
      cl_docket_entry_id, case_id, entry_number, recap_sequence_number, pacer_sequence_number,
      date_filed, time_filed, description_raw, source, cl_date_modified, updated_at
    ) values (
      (e->>'id')::bigint, p_case_id,
      nullif(e->>'entry_number','')::int,
      nullif(e->>'recap_sequence_number',''),
      nullif(e->>'pacer_sequence_number','')::bigint,
      nullif(e->>'date_filed','')::date,
      nullif(e->>'time_filed','')::time,
      nullif(e->>'description',''),
      'courtlistener',
      nullif(e->>'date_modified','')::timestamptz,
      now()
    )
    on conflict (cl_docket_entry_id) do update set
      entry_number          = excluded.entry_number,
      recap_sequence_number = excluded.recap_sequence_number,
      pacer_sequence_number = excluded.pacer_sequence_number,
      date_filed            = excluded.date_filed,
      time_filed            = excluded.time_filed,
      description_raw        = excluded.description_raw,
      cl_date_modified       = excluded.cl_date_modified,
      updated_at            = now()
    returning de.id into v_entry_id;

    if v_existed then v_updated := v_updated + 1; else v_new := v_new + 1; end if;

    for d in select value from jsonb_array_elements(coalesce(e->'recap_documents', '[]'::jsonb)) as value
    loop
      insert into public.documents as doc (
        cl_recap_document_id, case_id, docket_entry_id, document_number, attachment_number,
        document_type_code, short_description, page_count, file_size, sha1, pacer_doc_id,
        is_available_remote, is_sealed, filepath_local, filepath_ia, source_url, source,
        cl_date_modified, updated_at
      ) values (
        (d->>'id')::bigint, p_case_id, v_entry_id,
        nullif(d->>'document_number',''),
        nullif(d->>'attachment_number','')::int,
        nullif(d->>'document_type','')::int,
        nullif(d->>'description',''),
        nullif(d->>'page_count','')::int,
        nullif(d->>'file_size','')::bigint,
        nullif(d->>'sha1',''),
        nullif(d->>'pacer_doc_id',''),
        case when d ? 'is_available' and d->>'is_available' <> '' then (d->>'is_available')::boolean else null end,
        case when d ? 'is_sealed' and d->>'is_sealed' <> '' then (d->>'is_sealed')::boolean else null end,
        nullif(d->>'filepath_local',''),
        nullif(d->>'filepath_ia',''),
        case when nullif(d->>'absolute_url','') is not null then 'https://www.courtlistener.com' || (d->>'absolute_url') else null end,
        'courtlistener',
        nullif(d->>'date_modified','')::timestamptz,
        now()
      )
      on conflict (cl_recap_document_id) do update set
        docket_entry_id     = excluded.docket_entry_id,
        document_number     = excluded.document_number,
        attachment_number   = excluded.attachment_number,
        document_type_code  = excluded.document_type_code,
        short_description   = excluded.short_description,
        page_count          = excluded.page_count,
        file_size           = excluded.file_size,
        sha1                = excluded.sha1,
        pacer_doc_id        = excluded.pacer_doc_id,
        is_available_remote = excluded.is_available_remote,
        is_sealed           = excluded.is_sealed,
        filepath_local      = excluded.filepath_local,
        filepath_ia         = excluded.filepath_ia,
        source_url          = excluded.source_url,
        cl_date_modified     = excluded.cl_date_modified,
        updated_at          = now();
      v_docs := v_docs + 1;
    end loop;
  end loop;

  return jsonb_build_object('new', v_new, 'updated', v_updated, 'documents', v_docs);
end$$;

-- Read view for the docket UI: every entry for a case with a document count and the CL docket id
-- (the frontend builds the CourtListener entry URL from cl_docket_id + entry_number).
create or replace view public.v_recap_docket as
select
  de.id,
  de.case_id,
  de.entry_number,
  de.date_filed,
  de.description_raw as description,
  de.document_type,
  de.cl_docket_entry_id,
  de.cl_date_modified,
  c.cl_docket_id,
  (select count(*) from public.documents d where d.docket_entry_id = de.id) as doc_count
from public.docket_entries de
join public.cases c on c.id = de.case_id;
