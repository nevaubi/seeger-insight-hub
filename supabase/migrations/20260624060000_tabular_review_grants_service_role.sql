-- The edge functions act as service_role, which needs base table privileges on the new tables
-- (it bypasses RLS but not GRANTs). This was the real cause of both the "review_file not found"
-- read and the "permission denied" insert into review_file_pages.
grant select, insert, update, delete on
  public.review_sets,
  public.review_files,
  public.review_file_pages,
  public.review_columns,
  public.review_cells,
  public.review_cell_citations
to service_role;
