-- PostgREST's anon/authenticated roles need base table privileges in addition to RLS policies.
-- Without these GRANTs Postgres denies access before RLS is evaluated ("permission denied").
grant select, insert, update, delete on
  public.review_sets,
  public.review_files,
  public.review_file_pages,
  public.review_columns,
  public.review_cells,
  public.review_cell_citations
to anon, authenticated;
