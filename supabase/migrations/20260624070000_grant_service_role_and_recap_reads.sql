-- service_role is the privileged backend role used by edge functions; in a standard Supabase
-- project it has full access to the public schema. This project was missing those grants, which
-- broke every function that reads/writes as service_role (recap-sync resolving matters/cases,
-- tabular-* etc.). Restore it, and set default privileges so future tables inherit it.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- The keyless client (anon) reads the new docket objects directly; grant them like the rest of
-- the app's read surface.
grant select on public.recap_sync_state to anon, authenticated;
grant select on public.v_recap_docket to anon, authenticated;
