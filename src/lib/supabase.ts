import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://blhcucozljrojnvqosyi.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGN1Y296bGpyb2pudnFvc3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MTcyMDYsImV4cCI6MjA5NzQ5MzIwNn0.uwwQT_gnFtcgKD73BdURuSyFVbqXkjBec23dPBUXNO0';
export const SYNTHESIS_ENDPOINT = `${SUPABASE_URL}/functions/v1/legal-synthesis`;
export const AI_ASSIST_ENDPOINT = `${SUPABASE_URL}/functions/v1/ai-assist`;
export const RECAP_SYNC_ENDPOINT = `${SUPABASE_URL}/functions/v1/recap-sync`;

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
