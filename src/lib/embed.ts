import { pipeline } from '@huggingface/transformers';

let _extractor: any = null;
let _loading: Promise<any> | null = null;

export function modelReady() {
  return _extractor !== null;
}

async function getExtractor() {
  if (_extractor) return _extractor;
  if (!_loading) _loading = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  _extractor = await _loading;
  return _extractor;
}

// Returns a pgvector text literal like "[0.01,-0.02,...]" (384 dims).
export async function embedQuery(text: string): Promise<string> {
  const extractor = await getExtractor();
  const out = await extractor(`query: ${text}`, { pooling: 'cls', normalize: true });
  const v = Array.from(out.data as Float32Array);
  return '[' + v.map((x) => Number(x).toFixed(6)).join(',') + ']';
}
