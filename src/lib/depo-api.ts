import {
  SUPABASE_ANON_KEY,
  DEPO_INGEST_ENDPOINT,
  DEPO_ANALYZE_ENDPOINT,
  DEPO_ASK_ENDPOINT,
  type DepoAskResponse,
} from '@/lib/supabase';

const headers = {
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  apikey: SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const message = json?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return json as T;
}

export interface IngestInput {
  caseId: string;
  file: File;
  witnessName?: string;
  witnessRole?: string;
  partyAlignment?: string | null;
}

export interface IngestResult {
  ok: boolean;
  deposition_id: string;
  stats?: unknown;
  metadata?: unknown;
  error?: string;
}

export async function ingestDeposition(input: IngestInput): Promise<IngestResult> {
  const pdf_base64 = await fileToBase64(input.file);
  return postJson<IngestResult>(DEPO_INGEST_ENDPOINT, {
    case_id: input.caseId,
    filename: input.file.name,
    pdf_base64,
    witness_name: input.witnessName || null,
    witness_role: input.witnessRole || null,
    party_alignment: input.partyAlignment || null,
  });
}

export interface AnalyzeResult {
  ok: boolean;
  counts?: Record<string, number>;
  dropped?: number;
  error?: string;
}

export async function analyzeDeposition(depositionId: string): Promise<AnalyzeResult> {
  return postJson<AnalyzeResult>(DEPO_ANALYZE_ENDPOINT, { deposition_id: depositionId });
}

export async function askDeposition(
  depositionId: string,
  question: string,
): Promise<DepoAskResponse> {
  return postJson<DepoAskResponse>(DEPO_ASK_ENDPOINT, {
    deposition_id: depositionId,
    question,
  });
}
