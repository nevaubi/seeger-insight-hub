-- Intelligent retrieval RPCs for legal-synthesis.
--
-- expand_neighbors: sibling/neighbor expansion. Given a set of "center" chunk ids, return
-- the chunks adjacent to them (same document, chunk_index within +/- window), excluding the
-- centers. Purely positional — no embedding needed. Same column shape as hybrid_search
-- (score/vec_hit/lex_hit constant) plus chunk_index, so the edge function reuses one mapper.
--
-- order_chunks: full-order + amendment-chain (temporal) retrieval. Pull every chunk for an
-- order number STEM, so "22" returns PTO 22 and its amendment PTO 22A, ordered by date then
-- position. Anchored regex (<stem> + optional single suffix letter) so "2" never matches "22".

CREATE OR REPLACE FUNCTION public.expand_neighbors(
  p_case_id uuid,
  p_chunk_ids uuid[],
  p_window integer DEFAULT 1
)
RETURNS TABLE(
  id uuid, document_id uuid, order_id uuid, content text, score real,
  vec_hit boolean, lex_hit boolean, doc_label text, doc_source text,
  order_type text, order_number text, order_date date, tags text[],
  section_label text, affects text, has_deadline boolean,
  page_start integer, page_end integer, pdf_url text, chunk_index integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with centers as (
    select distinct ch.document_id, ch.chunk_index
    from chunks ch
    where ch.id = any(p_chunk_ids) and ch.case_id = p_case_id
  )
  select distinct on (c.id)
    c.id, c.document_id, c.court_order_id, c.content,
    0::real, false, false,
    c.doc_label, c.doc_source, c.order_type, c.order_number, c.order_date,
    c.tags, c.section_label, c.affects, c.has_deadline,
    c.page_start, c.page_end, co.pdf_url, c.chunk_index
  from chunks c
  join centers ce on ce.document_id = c.document_id
  left join court_orders co on co.id = c.court_order_id
  where c.case_id = p_case_id
    and c.chunk_index between ce.chunk_index - greatest(0, p_window)
                         and ce.chunk_index + greatest(0, p_window)
    and not (c.id = any(p_chunk_ids))
  order by c.id, c.document_id, c.chunk_index;
$function$;

CREATE OR REPLACE FUNCTION public.order_chunks(
  p_case_id uuid,
  p_order_type text DEFAULT NULL,
  p_number_stem text DEFAULT NULL,
  p_limit integer DEFAULT 60
)
RETURNS TABLE(
  id uuid, document_id uuid, order_id uuid, content text, score real,
  vec_hit boolean, lex_hit boolean, doc_label text, doc_source text,
  order_type text, order_number text, order_date date, tags text[],
  section_label text, affects text, has_deadline boolean,
  page_start integer, page_end integer, pdf_url text, chunk_index integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select
    c.id, c.document_id, c.court_order_id, c.content,
    0::real, false, false,
    c.doc_label, c.doc_source, c.order_type, c.order_number, c.order_date,
    c.tags, c.section_label, c.affects, c.has_deadline,
    c.page_start, c.page_end, co.pdf_url, c.chunk_index
  from chunks c
  left join court_orders co on co.id = c.court_order_id
  where c.case_id = p_case_id
    and (p_order_type is null or c.order_type = p_order_type)
    and (
      p_number_stem is null
      or c.order_number ~ ('^' || regexp_replace(p_number_stem, '[^0-9A-Za-z]', '', 'g') || '[A-Za-z]?$')
    )
  order by c.order_date nulls last, c.order_number nulls last, c.chunk_index
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$function$;
