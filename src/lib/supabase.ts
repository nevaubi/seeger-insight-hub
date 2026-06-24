import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://blhcucozljrojnvqosyi.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGN1Y296bGpyb2pudnFvc3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MTcyMDYsImV4cCI6MjA5NzQ5MzIwNn0.uwwQT_gnFtcgKD73BdURuSyFVbqXkjBec23dPBUXNO0';
export const SYNTHESIS_ENDPOINT = `${SUPABASE_URL}/functions/v1/legal-synthesis`;
export const AI_ASSIST_ENDPOINT = `${SUPABASE_URL}/functions/v1/ai-assist`;
export const RECAP_SYNC_ENDPOINT = `${SUPABASE_URL}/functions/v1/recap-sync`;
export const CITE_CHECK_ENDPOINT = `${SUPABASE_URL}/functions/v1/cite-check`;
export const TABULAR_INGEST_ENDPOINT = `${SUPABASE_URL}/functions/v1/tabular-ingest`;
export const TABULAR_EXTRACT_ENDPOINT = `${SUPABASE_URL}/functions/v1/tabular-extract`;
export const REVIEW_FILES_BUCKET = 'review-files';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export type OrderType = 'PTO' | 'CMO' | 'CBO' | 'JPML';

export interface Order {
  id: string;
  order_type: OrderType;
  order_number: string | null;
  canonical_title: string;
  order_date: string | null;
  summary: string | null;
  tags: string[] | null;
  pdf_url: string | null;
  source_page_url: string | null;
  recap_document_number: string | null;
  document_id: string | null;
  page_count: number | null;
}

export interface CaseRow {
  id: string;
  cl_docket_id: string | null;
  case_role: 'mdl_master' | 'member' | 'related';
  case_name: string;
  docket_number: string | null;
  cl_court_id: string | null;
  court_name: string | null;
  assigned_judge: string | null;
  assigned_judge_str: string | null;
  date_filed: string | null;
  date_terminated: string | null;
  case_status: string | null;
  on_jpml_schedule_a: boolean | null;
  jpml_transfer_date: string | null;
  parent_case_id: string | null;
}

export interface CounselRow {
  id: string;
  case_id: string;
  side: 'plaintiff' | 'defendant';
  represents: string | null;
  attorney_name: string | null;
  firm_name: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
}

export interface KeyDate {
  id: string;
  event_date: string;
  end_date: string | null;
  event_time: string | null;
  category: 'hearing' | 'cmc' | 'deadline' | 'milestone';
  title: string;
  description: string | null;
  affects: string | null;
  citation: string | null;
  source_url: string | null;
  is_conflicted: boolean | null;
  source_order_title: string | null;
  source_order_type: string | null;
}

export interface SearchHit {
  document_id: string;
  page_number: number;
  snippet: string;
  rank: number;
  doc_label: string | null;
  doc_source: 'flnd_court_site' | 'courtlistener' | null;
  order_id: string | null;
  order_title: string | null;
  order_type: string | null;
  order_date: string | null;
  pdf_url: string | null;
}

export interface RecapDocketEntry {
  id: string;
  case_id: string;
  entry_number: number | null;
  date_filed: string | null;
  description: string | null;
  document_type: string | null;
  cl_docket_entry_id: number | null;
  cl_date_modified: string | null;
  cl_docket_id: number | null;
  doc_count: number;
}

export interface RecapSyncState {
  matter_id: string;
  case_id: string | null;
  cl_docket_id: number | null;
  last_synced_at: string | null;
  last_entry_count: number | null;
  last_new_count: number | null;
  last_updated_count: number | null;
  last_error: string | null;
}

export type CiteState = 'valid' | 'not_found' | 'ambiguous' | 'invalid' | 'error';

export interface CiteCheckResult {
  citation: string | null;
  normalized: string[] | null;
  start: number | null;
  end: number | null;
  status: number | null;
  state: CiteState;
  case_name: string | null;
  url: string | null;
  year: number | null;
  citation_count: number | null;
  match_count: number;
  message: string | null;
}

export interface CiteCheckSummary {
  ok: boolean;
  truncated?: boolean;
  count: number;
  valid: number;
  not_found: number;
  ambiguous: number;
  invalid: number;
  results: CiteCheckResult[];
}

// ---- Tabular Review (document-grid) ----
export type ReviewFileStatus = 'uploaded' | 'transcribing' | 'ready' | 'error';
export type ReviewColumnType = 'text' | 'number' | 'date' | 'boolean' | 'enum' | 'list' | 'currency';
export type ReviewCellState = 'pending' | 'running' | 'done' | 'not_found' | 'needs_review' | 'error';

export interface ReviewSet {
  id: string;
  case_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewFile {
  id: string;
  review_set_id: string;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  byte_size: number | null;
  page_count: number | null;
  char_count: number | null;
  status: ReviewFileStatus;
  error: string | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewColumn {
  id: string;
  review_set_id: string;
  ordinal: number;
  name: string;
  prompt: string | null;
  data_type: ReviewColumnType;
  enum_options: string[] | null;
  created_at: string;
}

export interface ReviewCell {
  id: string;
  review_set_id: string;
  review_file_id: string;
  review_column_id: string;
  value_text: string | null;
  value_json: unknown;
  state: ReviewCellState;
  confidence: number | null;
  model: string | null;
  error: string | null;
  run_at: string | null;
}

export interface ReviewCellCitation {
  id: string;
  cell_id: string;
  page_number: number | null;
  quote: string | null;
  verified: boolean;
}

export const MAX_REVIEW_FILES = 5;

export interface WorkspaceDocument {
  id: string;
  case_id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export const TAG_LABELS: Record<string, string> = {
  threshold_proof: 'Threshold Proof',
  deficiency: 'Deficiency',
  leadership: 'Leadership',
  common_benefit: 'Common Benefit',
  special_master: 'Special Master',
  scheduling: 'Scheduling',
  status: 'Status',
  merits: 'Merits',
  discovery_esi: 'Discovery / ESI',
  deposition: 'Deposition',
  confidentiality: 'Confidentiality',
  direct_filing: 'Direct Filing',
  service: 'Service',
  tplf: 'TPLF',
  pleadings: 'Pleadings',
  admin: 'Administrative',
  transfer: 'Transfer',
  assignment: 'Assignment',
  data_admin: 'Data Admin',
  case_inventory: 'Case Inventory',
};

export const tagLabel = (t: string) => TAG_LABELS[t] ?? t.replace(/_/g, ' ');
