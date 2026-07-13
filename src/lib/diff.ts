// Word-level diff (LCS) for the version-compare view. Tokenizes on whitespace boundaries
// (keeping the whitespace attached so joins reproduce the text exactly). Versions of the
// same document share most content, so the common prefix/suffix is trimmed first and the
// O(n·m) LCS runs only on the changed middle — with a hard token cap beyond which the
// middle degrades to one del/add block rather than allocating a huge table.

export type DiffPart = { kind: 'same' | 'add' | 'del'; text: string };

const LCS_MAX_TOKENS = 1800; // 1800² × 4B ≈ 13 MB table, transient

function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function pushPart(parts: DiffPart[], kind: DiffPart['kind'], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

export function diffWords(oldText: string, newText: string): DiffPart[] {
  if (oldText === newText) return oldText ? [{ kind: 'same', text: oldText }] : [];
  const a = tokenize(oldText);
  const b = tokenize(newText);

  // trim common prefix
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  // trim common suffix
  let sufA = a.length;
  let sufB = b.length;
  while (sufA > pre && sufB > pre && a[sufA - 1] === b[sufB - 1]) {
    sufA--;
    sufB--;
  }

  const midA = a.slice(pre, sufA);
  const midB = b.slice(pre, sufB);
  const parts: DiffPart[] = [];
  pushPart(parts, 'same', a.slice(0, pre).join(''));

  if (midA.length === 0 || midB.length === 0 || midA.length > LCS_MAX_TOKENS || midB.length > LCS_MAX_TOKENS) {
    // degenerate or too large for a table: whole-block replacement
    pushPart(parts, 'del', midA.join(''));
    pushPart(parts, 'add', midB.join(''));
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        pushPart(parts, 'same', midA[i]);
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        pushPart(parts, 'del', midA[i]);
        i++;
      } else {
        pushPart(parts, 'add', midB[j]);
        j++;
      }
    }
    while (i < n) pushPart(parts, 'del', midA[i++]);
    while (j < m) pushPart(parts, 'add', midB[j++]);
  }

  pushPart(parts, 'same', a.slice(sufA).join(''));
  return parts;
}

export function diffStats(parts: DiffPart[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const p of parts) {
    const words = p.text.trim() ? p.text.trim().split(/\s+/).length : 0;
    if (p.kind === 'add') added += words;
    else if (p.kind === 'del') deleted += words;
  }
  return { added, deleted };
}
