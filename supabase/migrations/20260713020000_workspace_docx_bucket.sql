-- Word-mode document storage (SuperDoc canvas). Private bucket; permissive policies
-- mirroring the review-files pattern (demo posture).
-- Applied to production via MCP on 2026-07-13 (migration name: workspace_docx_bucket).
insert into storage.buckets (id, name, public)
values ('workspace-docx', 'workspace-docx', false)
on conflict (id) do nothing;

drop policy if exists workspace_docx_read on storage.objects;
create policy workspace_docx_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'workspace-docx');

drop policy if exists workspace_docx_insert on storage.objects;
create policy workspace_docx_insert on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'workspace-docx');

drop policy if exists workspace_docx_update on storage.objects;
create policy workspace_docx_update on storage.objects
  for update to anon, authenticated using (bucket_id = 'workspace-docx') with check (bucket_id = 'workspace-docx');

drop policy if exists workspace_docx_delete on storage.objects;
create policy workspace_docx_delete on storage.objects
  for delete to anon, authenticated using (bucket_id = 'workspace-docx');
